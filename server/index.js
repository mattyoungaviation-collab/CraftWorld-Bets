import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import express from "express";
import jwt from "jsonwebtoken";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  parseUnits,
  verifyMessage,
} from "ethers";
import { makeStore, newId, settleMarket } from "./betting.js";
import { getOrCreateUser, prisma } from "./db.js";
import {
  createDefaultBlackjackState,
  normalizeBlackjackState,
  joinSeat,
  leaveSeat,
  updateSeat,
  shuffleShoe,
  startRound,
  hit,
  stand,
  doubleDown,
  splitHand,
  timeoutStand,
  resetRound,
  BLACKJACK_MIN_BET,
  ROUND_COOLDOWN_MS,
} from "./blackjack.js";
import { buildBlackjackSessionBetId, getVaultReadContract } from "./lib/vaultLedger.js";
import { computeModelOdds } from "./odds.js";

const app = express();
app.use(express.json());

process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- persistence store ----
const dataDir = process.env.BETS_DATA_DIR
  ? path.resolve(process.env.BETS_DATA_DIR)
  : path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const { store, persist } = makeStore(dataDir);
const oddsHistoryPath = path.join(dataDir, "odds_history.json");
const modelHistoryPath = path.join(dataDir, "history.json");
const blackjackTableId = "default";
const blackjackState = await loadBlackjackStateFromDb();

async function loadBlackjackStateFromDb() {
  const record = await prisma.blackjackTableState.findUnique({ where: { id: blackjackTableId } });
  if (record?.state) return normalizeBlackjackState(record.state);
  const state = createDefaultBlackjackState();
  await prisma.blackjackTableState.create({ data: { id: blackjackTableId, state } });
  return state;
}

async function persistBlackjackState() {
  await prisma.blackjackTableState.upsert({
    where: { id: blackjackTableId },
    update: { state: blackjackState },
    create: { id: blackjackTableId, state: blackjackState },
  });
}

function queueNextRoundIfNeeded() {
  const hasPlayers = blackjackState.seats.some(
    (seat) => seat.joined && seat.readyForNextRound && seat.pendingBetAmount > 0
  );
  if (!hasPlayers) return false;
  const now = Date.now();
  if (blackjackState.phase === "player" || blackjackState.phase === "dealer") return false;
  if (!blackjackState.cooldownExpiresAt || blackjackState.cooldownExpiresAt <= now) {
    blackjackState.cooldownExpiresAt = now + ROUND_COOLDOWN_MS;
    blackjackState.log = [
      `Next round starts in ${Math.floor(ROUND_COOLDOWN_MS / 1000)}s.`,
      ...(blackjackState.log || []),
    ].slice(0, 6);
    blackjackState.updatedAt = new Date().toISOString();
    return true;
  }
  return false;
}

function tryStartNextRound() {
  const now = Date.now();
  if (blackjackState.phase === "player" || blackjackState.phase === "dealer") return false;
  if (!blackjackState.cooldownExpiresAt || blackjackState.cooldownExpiresAt > now) return false;
  const result = startRound(blackjackState);
  return !result.error;
}

// ---- Craft World GraphQL ----
const GRAPHQL_URL = "https://craft-world.gg/graphql";
const VALIDATION_TTL_MS = 5 * 60 * 1000;
const validations = new Map();
const JWT_SECRET = process.env.JWT_SECRET || "";
const BET_MAX_AMOUNT = Number.isFinite(Number(process.env.BET_MAX_AMOUNT))
  ? Number(process.env.BET_MAX_AMOUNT)
  : null;
const RONIN_RPC = process.env.RONIN_RPC || "https://api.roninchain.com/rpc";
const DYNW_TOKEN_ADDRESS = process.env.DYNW_TOKEN_ADDRESS || "0x17ff4EA5dD318E5FAf7f5554667d65abEC96Ff57";
const VAULT_LEDGER_ADDRESS = process.env.VAULT_LEDGER_ADDRESS || "";
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY || "";
const DYNW_DECIMALS = 18;
const VAULT_LEDGER_ABI = [
  "function placeBet(bytes32 betId, address token, uint256 amount)",
  "function settleBet(bytes32 betId, address[] participants, uint256[] payouts)",
  "function balances(address owner, address token) view returns (uint256)",
  "function lockedBalances(address owner, address token) view returns (uint256)",
  "function betStakes(bytes32 betId, address owner) view returns (uint256)",
];
const roninProvider = new JsonRpcProvider(RONIN_RPC);
const operatorSigner =
  OPERATOR_PRIVATE_KEY && VAULT_LEDGER_ADDRESS ? new Wallet(OPERATOR_PRIVATE_KEY, roninProvider) : null;
const vaultContract =
  operatorSigner && VAULT_LEDGER_ADDRESS
    ? new Contract(VAULT_LEDGER_ADDRESS, VAULT_LEDGER_ABI, operatorSigner)
    : null;
const vaultReadContract = VAULT_LEDGER_ADDRESS ? getVaultReadContract(VAULT_LEDGER_ADDRESS, roninProvider) : null;
const authNonces = new Map();

const MASTERPIECE_QUERY = `
  query Masterpiece($id: ID) {
    masterpiece(id: $id) {
      id
      name
      type
      collectedPoints
      requiredPoints
      startedAt
      resources {
        symbol
        amount
        target
        consumedPowerPerUnit
      }
      leaderboard {
        position
        masterpiecePoints
        profile {
          uid
          walletAddress
          avatarUrl
          displayName
        }
      }
    }
  }
`;

async function fetchMasterpiece(id) {
  const jwt = process.env.CRAFTWORLD_JWT;
  if (!jwt) throw new Error("Missing CRAFTWORLD_JWT env var");

  const r = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      query: MASTERPIECE_QUERY,
      variables: { id },
    }),
  });

  const json = await r.json();
  if (json.errors) throw new Error("GraphQL error");
  return json;
}

function loadOddsHistoryCache() {
  try {
    if (!fs.existsSync(oddsHistoryPath)) return null;
    const raw = fs.readFileSync(oddsHistoryPath, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("Failed to read odds history cache:", e);
    return null;
  }
}

function saveOddsHistoryCache(payload) {
  try {
    fs.writeFileSync(oddsHistoryPath, JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error("Failed to write odds history cache:", e);
  }
}

async function buildOddsHistory(endId) {
  const history = [];
  for (let id = 1; id <= endId; id += 1) {
    try {
      const json = await fetchMasterpiece(id);
      if (json?.data?.masterpiece) {
        history.push(json.data.masterpiece);
      }
    } catch (e) {
      console.error("Failed to load masterpiece", id, e);
    }
  }
  const payload = {
    startId: 1,
    endId,
    updatedAt: new Date().toISOString(),
    masterpieces: history,
  };
  saveOddsHistoryCache(payload);
  return payload;
}

function normalizeWallet(address) {
  if (!address || typeof address !== "string") return null;
  const trimmed = address.trim().toLowerCase();
  if (trimmed.startsWith("ronin:")) {
    return `0x${trimmed.slice(6)}`;
  }
  return trimmed;
}

function buildBetId(masterpieceId, position) {
  return keccak256(toUtf8Bytes(`cw-bet:${masterpieceId}:${position}`));
}

function getAuthToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.split(";").map((c) => c.trim()).find((c) => c.startsWith("cw_session="));
    if (match) return match.split("=")[1];
  }
  return null;
}

function requireAuth(req, res, next) {
  const token = getAuthToken(req);
  if (!token) return res.status(401).json({ error: "Missing auth token" });
  if (!JWT_SECRET) return res.status(500).json({ error: "JWT_SECRET is not configured" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || typeof payload !== "object") {
      return res.status(401).json({ error: "Invalid auth token" });
    }
    req.user = {
      userId: payload.sub,
      loginAddress: payload.loginAddress,
    };
    return next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid auth token" });
  }
}

function requireConfiguredEnv(required, message) {
  if (!required) {
    throw new Error(message);
  }
}

function ensureWalletRecord(address) {
  const normalized = normalizeWallet(address);
  if (!normalized) return null;
  let existing = store.wallets[normalized];
  const legacyRoninKey = normalized.startsWith("0x") ? `ronin:${normalized.slice(2)}` : null;
  const legacy = legacyRoninKey ? store.wallets[legacyRoninKey] : null;
  if (!existing && legacy) {
    store.wallets[normalized] = {
      ...legacy,
      address: normalized,
      balance: Number(legacy.balance || 0),
      ledger: Array.isArray(legacy.ledger) ? legacy.ledger : [],
      betIds: Array.isArray(legacy.betIds) ? legacy.betIds : [],
      lastSeenAt: new Date().toISOString(),
    };
    delete store.wallets[legacyRoninKey];
    existing = store.wallets[normalized];
  } else if (existing && legacy) {
    existing.balance = Number(existing.balance || 0) + Number(legacy.balance || 0);
    existing.ledger = [...(Array.isArray(existing.ledger) ? existing.ledger : []), ...(legacy.ledger || [])];
    existing.betIds = [...(Array.isArray(existing.betIds) ? existing.betIds : []), ...(legacy.betIds || [])];
    existing.lastSeenAt = new Date().toISOString();
    delete store.wallets[legacyRoninKey];
  }
  if (existing) {
    existing.lastSeenAt = new Date().toISOString();
    existing.balance = Number(existing.balance || 0);
    if (!Array.isArray(existing.ledger)) existing.ledger = [];
    return existing;
  }
  const record = {
    address: normalized,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    betIds: [],
    balance: 0,
    ledger: [],
  };
  store.wallets[normalized] = record;
  return record;
}

function addLedgerEntry(address, entry) {
  const record = ensureWalletRecord(address);
  if (!record) return null;
  record.ledger = Array.isArray(record.ledger) ? record.ledger : [];
  record.balance = Number(record.balance || 0);
  record.balance += Number(entry.amount || 0);
  record.ledger.push({
    id: newId(),
    createdAt: new Date().toISOString(),
    ...entry,
  });
  if (record.ledger.length > 100) {
    record.ledger = record.ledger.slice(-100);
  }
  return record;
}

function persistBlackjackUpdates() {
  persistBlackjackState().catch((e) => console.error("Failed to persist blackjack state:", e));
}

async function applyBlackjackRoundResults() {
  if (blackjackState.phase !== "settled") return;
  if (!blackjackState.activeRoundId) return;
  if (blackjackState.lastSettledRoundId === blackjackState.activeRoundId) return;
  const results = Array.isArray(blackjackState.lastRoundResults) ? blackjackState.lastRoundResults : [];
  if (results.length === 0) {
    blackjackState.lastSettledRoundId = blackjackState.activeRoundId;
    persistBlackjackUpdates();
    return;
  }
  for (const result of results) {
    if (!result?.walletAddress) continue;
    const walletAddress = normalizeWallet(result.walletAddress);
    if (!walletAddress) continue;
    const session = await prisma.blackjackSession.findFirst({
      where: { walletAddress, status: "active" },
    });
    if (!session) continue;
    const totalBetWei = parseUnits(String(result.totalBet || 0), DYNW_DECIMALS);
    const payoutWei = parseUnits(String(result.payoutTotal || 0), DYNW_DECIMALS);
    const netPnlWei = payoutWei - totalBetWei;
    await prisma.blackjackSession.update({
      where: { id: session.id },
      data: {
        bankrollWei: session.bankrollWei + payoutWei,
        committedWei: session.committedWei - totalBetWei,
        netPnlWei: session.netPnlWei + netPnlWei,
      },
    });
    const seat = blackjackState.seats.find((entry) => entry.id === session.seatId);
    if (seat) {
      seat.bankroll = Number(formatUnits(session.bankrollWei + payoutWei, DYNW_DECIMALS));
    }
  }
  blackjackState.lastSettledRoundId = blackjackState.activeRoundId;
  persistBlackjackUpdates();
}

function requireSeatOwner(seatId, walletAddress) {
  const seat = blackjackState.seats.find((s) => s.id === seatId);
  if (!seat || !seat.joined) return { error: "Seat not found" };
  const normalized = normalizeWallet(walletAddress);
  if (!normalized) return { error: "walletAddress required" };
  if (!seat.walletAddress || seat.walletAddress !== normalized) {
    return { error: "Seat is owned by a different wallet" };
  }
  return { ok: true, seat };
}

function requireLoginWallet(req, walletAddress) {
  const normalized = normalizeWallet(walletAddress);
  if (!normalized) return { error: "walletAddress required" };
  const loginAddress = normalizeWallet(req.user?.loginAddress);
  if (!loginAddress || normalized !== loginAddress) {
    return { error: "walletAddress does not match signed-in wallet" };
  }
  return { ok: true, walletAddress: normalized };
}

function parseAmountWei(value) {
  if (typeof value !== "string") return { error: "amountWei required" };
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) return { error: "amountWei must be positive" };
    return { ok: true, amountWei: parsed };
  } catch {
    return { error: "amountWei invalid" };
  }
}

async function getActiveBlackjackSession(walletAddress) {
  return prisma.blackjackSession.findFirst({ where: { walletAddress, status: "active" } });
}

async function getPendingBlackjackSession(walletAddress) {
  return prisma.blackjackSession.findFirst({ where: { walletAddress, status: "pending" } });
}

function syncSeatBankroll(seat, bankrollWei) {
  seat.bankroll = Number(formatUnits(bankrollWei, DYNW_DECIMALS));
}

function serializeBlackjackSession(session) {
  if (!session) return null;
  return {
    ...session,
    buyInWei: session.buyInWei.toString(),
    bankrollWei: session.bankrollWei.toString(),
    committedWei: session.committedWei.toString(),
    netPnlWei: session.netPnlWei.toString(),
  };
}

function serializeBlackjackSettlement(settlement) {
  if (!settlement) return null;
  return {
    ...settlement,
    netPnlWei: settlement.netPnlWei.toString(),
  };
}

function findAvailableSeat(preferredSeatId = null) {
  if (Number.isInteger(preferredSeatId)) {
    const seat = blackjackState.seats.find((entry) => entry.id === preferredSeatId);
    if (seat && !seat.joined) return seat;
  }
  return blackjackState.seats.find((seat) => !seat.joined) || null;
}

async function fetchVaultBalance(walletAddress) {
  if (!vaultReadContract) {
    throw new Error("VAULT_LEDGER_ADDRESS is not configured");
  }
  return vaultReadContract.balances(walletAddress, DYNW_TOKEN_ADDRESS);
}

async function fetchVaultBetStake(betId, walletAddress) {
  if (!vaultReadContract) {
    throw new Error("VAULT_LEDGER_ADDRESS is not configured");
  }
  return vaultReadContract.betStakes(betId, walletAddress);
}

// ---- API routes FIRST ----
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/nonce", (req, res) => {
  const address = normalizeWallet(req.body?.address);
  if (!address) return res.status(400).json({ error: "address required" });
  const nonce = crypto.randomBytes(16).toString("hex");
  authNonces.set(address, { nonce, expiresAt: Date.now() + 5 * 60 * 1000 });
  res.json({ nonce });
});

app.post("/api/auth/verify", async (req, res) => {
  try {
    requireConfiguredEnv(JWT_SECRET, "JWT_SECRET is not configured");
    const address = normalizeWallet(req.body?.address);
    const message = req.body?.message;
    const signature = req.body?.signature;
    if (!address || !message || !signature) {
      return res.status(400).json({ error: "address, message, and signature are required" });
    }
    const record = authNonces.get(address);
    if (!record || record.expiresAt < Date.now()) {
      return res.status(400).json({ error: "nonce expired" });
    }
    if (!message.includes(record.nonce)) {
      return res.status(400).json({ error: "nonce mismatch" });
    }
    if (!message.toLowerCase().includes(address.toLowerCase())) {
      return res.status(400).json({ error: "message missing address" });
    }
    const signer = verifyMessage(message, signature);
    if (normalizeWallet(signer) !== address) {
      return res.status(401).json({ error: "signature does not match address" });
    }
    authNonces.delete(address);
    const user = await getOrCreateUser(address);
    const token = jwt.sign({ loginAddress: user.loginAddress }, JWT_SECRET, {
      subject: user.id,
      expiresIn: "7d",
    });
    res.json({ ok: true, address, token });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


app.get("/api/blackjack/state", (_req, res) => {
  res.json({ ok: true, state: blackjackState });
});

app.get("/api/blackjack/session", requireAuth, async (req, res) => {
  try {
    const walletAddress = normalizeWallet(req.user?.loginAddress);
    if (!walletAddress) return res.status(403).json({ error: "walletAddress required" });
    const session =
      (await prisma.blackjackSession.findFirst({ where: { walletAddress, status: "active" } })) ||
      (await prisma.blackjackSession.findFirst({ where: { walletAddress, status: "pending" } }));
    if (!session) return res.json({ ok: true, session: null });
    const betId = buildBlackjackSessionBetId(session.id);
    res.json({ ok: true, session: serializeBlackjackSession(session), betId });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/blackjack/balance", requireAuth, async (req, res) => {
  try {
    const walletAddress = normalizeWallet(req.query.wallet);
    const authCheck = requireLoginWallet(req, walletAddress);
    if (authCheck.error) return res.status(403).json({ error: authCheck.error });
    const balance = await fetchVaultBalance(authCheck.walletAddress);
    res.json({ ok: true, wallet: authCheck.walletAddress, balance: balance.toString() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/blackjack/buyin", requireAuth, async (req, res) => {
  try {
    const amountCheck = parseAmountWei(req.body?.amountWei);
    if (amountCheck.error) return res.status(400).json({ error: amountCheck.error });
    const desiredAmountWei = amountCheck.amountWei;
    const authCheck = requireLoginWallet(req, req.user?.loginAddress);
    if (authCheck.error) return res.status(403).json({ error: authCheck.error });
    const walletAddress = authCheck.walletAddress;
    const vaultBalance = await fetchVaultBalance(walletAddress);
    if (desiredAmountWei > BigInt(vaultBalance)) {
      return res.status(400).json({ error: "Buy-in exceeds vault balance" });
    }
    let session = await getActiveBlackjackSession(walletAddress);
    if (!session) session = await getPendingBlackjackSession(walletAddress);

    const requestedSeatId = Number.isInteger(req.body?.seatId) ? Number(req.body.seatId) : null;
    let seat = null;
    if (session) {
      if (requestedSeatId !== null && requestedSeatId !== session.seatId) {
        return res.status(400).json({ error: "Session already assigned to another seat" });
      }
      seat = blackjackState.seats.find((entry) => entry.id === session.seatId) || null;
      if (seat && seat.joined && seat.walletAddress !== walletAddress) {
        return res.status(400).json({ error: "Seat already occupied" });
      }
    } else {
      seat = findAvailableSeat(requestedSeatId);
      if (!seat) return res.status(400).json({ error: "No available seats" });
    }

    if (!session) {
      session = await prisma.blackjackSession.create({
        data: {
          walletAddress,
          seatId: seat.id,
          status: "pending",
          buyInWei: desiredAmountWei,
          bankrollWei: 0n,
          committedWei: 0n,
          netPnlWei: 0n,
        },
      });
    } else if (desiredAmountWei < session.buyInWei) {
      return res.status(400).json({ error: "Buy-in cannot be decreased" });
    }

    const betId = buildBlackjackSessionBetId(session.id);
    const stake = await fetchVaultBetStake(betId, walletAddress);
    const stakeWei = BigInt(stake);
    const needsStake = stakeWei < desiredAmountWei;
    const missingStakeWei = needsStake ? desiredAmountWei - stakeWei : 0n;

    if (!seat.joined) {
      const result = joinSeat(blackjackState, seat.id, req.body?.name, walletAddress, null);
      if (result.error) return res.status(400).json({ error: result.error });
    }
    seat.walletAddress = walletAddress;

    if (!needsStake) {
      let bankrollDelta = desiredAmountWei - session.buyInWei;
      if (session.status !== "active") {
        bankrollDelta = desiredAmountWei;
      }
      session = await prisma.blackjackSession.update({
        where: { id: session.id },
        data: {
          status: "active",
          buyInWei: desiredAmountWei,
          bankrollWei: session.bankrollWei + bankrollDelta,
        },
      });
      syncSeatBankroll(seat, session.bankrollWei);
    }

    persistBlackjackUpdates();
    return res.json({
      ok: true,
      state: blackjackState,
      session: serializeBlackjackSession(session),
      betId,
      needsStake,
      missingStakeWei: missingStakeWei.toString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/blackjack/deal", requireAuth, async (req, res) => {
  try {
    const amountCheck = parseAmountWei(req.body?.amountWei);
    if (amountCheck.error) return res.status(400).json({ error: amountCheck.error });
    const wagerWei = amountCheck.amountWei;
    const authCheck = requireLoginWallet(req, req.user?.loginAddress);
    if (authCheck.error) return res.status(403).json({ error: authCheck.error });
    const walletAddress = authCheck.walletAddress;
    const session = await getActiveBlackjackSession(walletAddress);
    if (!session) return res.status(400).json({ error: "No active blackjack session" });
    if (wagerWei > session.bankrollWei) {
      return res.status(400).json({ error: "Wager exceeds table bankroll" });
    }
    const minBetWei = parseUnits(String(BLACKJACK_MIN_BET), DYNW_DECIMALS);
    if (wagerWei < minBetWei) {
      return res.status(400).json({ error: "Wager below table minimum" });
    }
    if (blackjackState.phase === "player" || blackjackState.phase === "dealer") {
      return res.status(400).json({ error: "Round already in progress" });
    }
    const seat = blackjackState.seats.find((entry) => entry.id === session.seatId);
    if (!seat || !seat.joined || seat.walletAddress !== walletAddress) {
      return res.status(400).json({ error: "Seat not assigned to this session" });
    }
    const wagerAmount = Number(formatUnits(wagerWei, DYNW_DECIMALS));
    seat.bet = Math.max(BLACKJACK_MIN_BET, wagerAmount);
    seat.pendingBetAmount = wagerAmount;
    seat.pendingBetAmountWei = wagerWei.toString();
    seat.pendingBetRoundId = blackjackState.roundId;
    seat.readyForNextRound = true;
    const updatedSession = await prisma.blackjackSession.update({
      where: { id: session.id },
      data: {
        bankrollWei: session.bankrollWei - wagerWei,
        committedWei: session.committedWei + wagerWei,
      },
    });
    syncSeatBankroll(seat, updatedSession.bankrollWei);
    if (tryStartNextRound()) {
      await applyBlackjackRoundResults();
    }
    persistBlackjackUpdates();
    return res.json({ ok: true, state: blackjackState, session: serializeBlackjackSession(updatedSession) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/blackjack/action", requireAuth, async (req, res) => {
  try {
    const action = String(req.body?.action || "").toLowerCase();
    if (!["hit", "stand", "double", "split"].includes(action)) {
      return res.status(400).json({ error: "action invalid" });
    }
    const authCheck = requireLoginWallet(req, req.user?.loginAddress);
    if (authCheck.error) return res.status(403).json({ error: authCheck.error });
    const walletAddress = authCheck.walletAddress;
    const session = await getActiveBlackjackSession(walletAddress);
    if (!session) return res.status(400).json({ error: "No active blackjack session" });
    const seat = blackjackState.seats.find((entry) => entry.id === session.seatId);
    if (!seat || !seat.joined || seat.walletAddress !== walletAddress) {
      return res.status(400).json({ error: "Seat not assigned to this session" });
    }
    if (action === "hit") {
      const result = hit(blackjackState, seat.id);
      if (result.error) return res.status(400).json({ error: result.error });
    } else if (action === "stand") {
      const result = stand(blackjackState, seat.id);
      if (result.error) return res.status(400).json({ error: result.error });
    } else {
      const activeHandIndex = blackjackState.activeHand ?? seat.activeHand ?? 0;
      const currentBet = seat.bets[activeHandIndex] ?? seat.bet;
      const extraBetWei = parseUnits(String(currentBet), DYNW_DECIMALS);
      if (req.body?.amountWei) {
        const amountCheck = parseAmountWei(req.body.amountWei);
        if (amountCheck.error) return res.status(400).json({ error: amountCheck.error });
        if (amountCheck.amountWei !== extraBetWei) {
          return res.status(400).json({ error: "amountWei mismatch" });
        }
      }
      if (extraBetWei > session.bankrollWei) {
        return res.status(400).json({ error: "Insufficient table bankroll" });
      }
      if (action === "double") {
        const result = doubleDown(blackjackState, seat.id);
        if (result.error) return res.status(400).json({ error: result.error });
      } else {
        const result = splitHand(blackjackState, seat.id);
        if (result.error) return res.status(400).json({ error: result.error });
      }
      const updatedSession = await prisma.blackjackSession.update({
        where: { id: session.id },
        data: {
          bankrollWei: session.bankrollWei - extraBetWei,
          committedWei: session.committedWei + extraBetWei,
        },
      });
      syncSeatBankroll(seat, updatedSession.bankrollWei);
    }
    await applyBlackjackRoundResults();
    persistBlackjackUpdates();
    return res.json({ ok: true, state: blackjackState });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/blackjack/join", requireAuth, (req, res) => {
  const seatId = Number(req.body?.seatId);
  if (!Number.isInteger(seatId)) return res.status(400).json({ error: "seatId required" });
  const walletAddress = normalizeWallet(req.user?.loginAddress);
  const result = joinSeat(blackjackState, seatId, req.body?.name, walletAddress, null);
  if (result.error) return res.status(400).json({ error: result.error });
  queueNextRoundIfNeeded();
  persistBlackjackUpdates();
  return res.json({ ok: true, state: blackjackState });
});

app.post("/api/blackjack/leave", requireAuth, async (req, res) => {
  try {
    const authCheck = requireLoginWallet(req, req.user?.loginAddress);
    if (authCheck.error) return res.status(403).json({ error: authCheck.error });
    const walletAddress = authCheck.walletAddress;
    const session = await getActiveBlackjackSession(walletAddress);
    const pendingSession = session || (await getPendingBlackjackSession(walletAddress));
    if (!pendingSession) return res.status(400).json({ error: "No blackjack session to close" });
    const seat = blackjackState.seats.find((entry) => entry.id === pendingSession.seatId);
    if (seat?.status === "playing") {
      return res.status(400).json({ error: "Finish the current hand before leaving" });
    }
    if (pendingSession.status === "pending") {
      await prisma.blackjackSession.update({
        where: { id: pendingSession.id },
        data: { status: "cancelled" },
      });
      if (seat) leaveSeat(blackjackState, seat.id);
      persistBlackjackUpdates();
      return res.json({ ok: true, state: blackjackState, session: null });
    }
    const existingSettlement = await prisma.blackjackSettlement.findUnique({
      where: { sessionId: pendingSession.id },
    });
    if (existingSettlement) {
      return res.json({ ok: true, settlement: serializeBlackjackSettlement(existingSettlement), state: blackjackState });
    }
    if (!vaultContract || !operatorSigner) {
      return res.status(500).json({ error: "VAULT_LEDGER_ADDRESS or OPERATOR_PRIVATE_KEY not configured" });
    }
    const betId = buildBlackjackSessionBetId(pendingSession.id);
    const stake = await fetchVaultBetStake(betId, walletAddress);
    if (BigInt(stake) < pendingSession.buyInWei) {
      return res.status(400).json({ error: "Buy-in stake not detected on Vault Ledger" });
    }
    const netPnlWei = pendingSession.netPnlWei;
    let payoutWei = pendingSession.buyInWei + netPnlWei;
    if (payoutWei < 0n) payoutWei = 0n;
    const settlementRecord = await prisma.blackjackSettlement.create({
      data: {
        sessionId: pendingSession.id,
        betId,
        txHash: "pending",
        netPnlWei,
        status: "pending",
      },
    });
    let txHash = "";
    try {
      if (netPnlWei > 0n) {
        await vaultContract.placeBet(betId, DYNW_TOKEN_ADDRESS, netPnlWei);
        const tx = await vaultContract.settleBet(
          betId,
          [walletAddress, operatorSigner.address],
          [payoutWei, 0n]
        );
        await tx.wait();
        txHash = tx.hash;
      } else {
        const tx = await vaultContract.settleBet(betId, [walletAddress], [payoutWei]);
        await tx.wait();
        txHash = tx.hash;
      }
      const updatedSettlement = await prisma.blackjackSettlement.update({
        where: { id: settlementRecord.id },
        data: { txHash, status: "confirmed" },
      });
      await prisma.blackjackSession.update({
        where: { id: pendingSession.id },
        data: { status: "settled", bankrollWei: 0n, committedWei: 0n },
      });
      if (seat) leaveSeat(blackjackState, seat.id);
      persistBlackjackUpdates();
      return res.json({ ok: true, settlement: serializeBlackjackSettlement(updatedSettlement), state: blackjackState });
    } catch (e) {
      await prisma.blackjackSettlement.update({
        where: { id: settlementRecord.id },
        data: { status: "failed" },
      });
      return res.status(500).json({ error: String(e) });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/blackjack/seat", requireAuth, (req, res) => {
  const seatId = Number(req.body?.seatId);
  if (!Number.isInteger(seatId)) return res.status(400).json({ error: "seatId required" });
  const ownership = requireSeatOwner(seatId, req.user?.loginAddress);
  if (ownership.error) return res.status(403).json({ error: ownership.error });
  const result = updateSeat(blackjackState, seatId, req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  persistBlackjackUpdates();
  return res.json({ ok: true, state: blackjackState });
});

app.post("/api/blackjack/shuffle", (_req, res) => {
  const result = shuffleShoe(blackjackState);
  if (result.error) return res.status(400).json({ error: result.error });
  persistBlackjackUpdates();
  return res.json({ ok: true, state: blackjackState });
});

app.post("/api/blackjack/reset", (_req, res) => {
  const result = resetRound(blackjackState);
  if (result.error) return res.status(400).json({ error: result.error });
  persistBlackjackUpdates();
  return res.json({ ok: true, state: blackjackState });
});

app.get("/api/masterpiece/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const json = await fetchMasterpiece(id);
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/odds/history", async (req, res) => {
  try {
    const endId = Number(req.query.endId);
    if (!Number.isFinite(endId) || endId <= 0) {
      return res.status(400).json({ error: "endId must be a positive number" });
    }

    const refresh = String(req.query.refresh || "").toLowerCase() === "true";
    const cached = loadOddsHistoryCache();
    if (!refresh && cached && cached.endId >= endId) {
      return res.json({ ok: true, data: cached });
    }

    const payload = await buildOddsHistory(endId);
    return res.json({ ok: true, data: payload });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/api/odds/model", (_req, res) => {
  try {
    const history = fs.existsSync(modelHistoryPath)
      ? JSON.parse(fs.readFileSync(modelHistoryPath, "utf-8"))
      : {};
    const { probs, odds, strength } = computeModelOdds(history, {
      lambda: 0.35,
      tau: 0.9,
      k: 3,
      usePoints: true,
    });
    return res.json({ ok: true, probs, odds, strength });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

function resolveAmounts({ amount }) {
  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) return { error: "amount must be a positive integer" };
  return { wagerAmount: amt };
}

async function validateBetPayload(body, loginAddress) {
  const { masterpieceId, position, pickedUid, futureBet } = body || {};
  if (!loginAddress) return { error: "loginAddress required" };

  const mpId = Number(masterpieceId);
  if (!Number.isInteger(mpId)) return { error: "masterpieceId must be integer" };

  const pos = Number(position);
  if (![1, 2, 3].includes(pos)) return { error: "position must be 1, 2, or 3" };

  if (!pickedUid || typeof pickedUid !== "string") return { error: "pickedUid required" };

  const amountCheck = resolveAmounts(body);
  if (amountCheck.error) return { error: amountCheck.error };
  if (BET_MAX_AMOUNT !== null && amountCheck.wagerAmount > BET_MAX_AMOUNT) {
    return { error: `bet exceeds max limit of ${BET_MAX_AMOUNT}` };
  }

  let pickedName = pickedUid;
  let isClosed = false;

  try {
    const mpJson = await fetchMasterpiece(mpId);
    const mp = mpJson?.data?.masterpiece;
    if (mp?.collectedPoints >= mp?.requiredPoints) isClosed = true;
    const leaderboard = mp?.leaderboard || [];

    if (!futureBet) {
      const pickedRow = leaderboard.find((r) => r?.profile?.uid === pickedUid);
      if (!pickedRow) return { error: "pickedUid not found in current leaderboard" };
      pickedName = pickedRow?.profile?.displayName || pickedUid;
    }
  } catch (e) {
    if (!futureBet) return { error: "masterpiece lookup failed" };
  }

  if (isClosed) return { error: "betting is closed for this masterpiece" };

  return {
    user: loginAddress,
    masterpieceId: mpId,
    position: pos,
    betId: buildBetId(mpId, pos),
    pickedUid,
    pickedName,
    futureBet: Boolean(futureBet),
    ...amountCheck,
  };
}

app.post("/api/bets/preview", requireAuth, async (req, res) => {
  try {
    const loginAddress = normalizeWallet(req.user?.loginAddress);
    const validated = await validateBetPayload(req.body, loginAddress);
    if (validated.error) return res.status(400).json({ error: validated.error });

    const validationId = newId();
    validations.set(validationId, {
      ...validated,
      expiresAt: Date.now() + VALIDATION_TTL_MS,
    });

    res.json({ ok: true, pickedName: validated.pickedName, validationId, betId: validated.betId });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/bets", requireAuth, async (req, res) => {
  try {
    const { validationId, txHash } = req.body || {};
    let validated = null;
    const loginAddress = normalizeWallet(req.user?.loginAddress);
    const userId = req.user?.userId || null;
    if (!loginAddress) return res.status(400).json({ error: "invalid login address" });

    if (validationId) {
      const record = validations.get(validationId);
      if (!record) return res.status(400).json({ error: "validation expired or not found" });
      if (record.expiresAt < Date.now()) {
        validations.delete(validationId);
        return res.status(400).json({ error: "validation expired" });
      }
      const payloadCheck = resolveAmounts({ amount: req.body?.amount });
      if (payloadCheck.error) return res.status(400).json({ error: payloadCheck.error });
      const matches =
        record.user === loginAddress &&
        record.masterpieceId === Number(req.body?.masterpieceId) &&
        record.position === Number(req.body?.position) &&
        record.pickedUid === req.body?.pickedUid &&
        record.wagerAmount === payloadCheck.wagerAmount &&
        record.betId === req.body?.betId;
      if (!matches) return res.status(400).json({ error: "validation payload mismatch" });
      validated = { ...record, ...payloadCheck };
      validations.delete(validationId);
    } else {
      validated = await validateBetPayload(req.body, loginAddress);
      if (validated.error) return res.status(400).json({ error: validated.error });
    }

    const bet = {
      id: newId(),
      betId: validated.betId,
      user: validated.user,
      userId,
      loginAddress,
      masterpieceId: validated.masterpieceId,
      position: validated.position,
      pickedUid: validated.pickedUid,
      pickedName: validated.pickedName,
      amount: validated.wagerAmount,
      wagerAmount: validated.wagerAmount,
      txHash: txHash || null,
      createdAt: new Date().toISOString(),
      futureBet: validated.futureBet,
    };

    store.bets.push(bet);
    persist();

    res.json({ ok: true, bet });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/bets", (req, res) => {
  const mpId = req.query.masterpieceId ? Number(req.query.masterpieceId) : null;
  const position = req.query.position ? Number(req.query.position) : null;
  const walletAddress = req.query.walletAddress ? String(req.query.walletAddress).toLowerCase() : null;

  let out = store.bets;

  if (Number.isInteger(mpId)) out = out.filter((b) => b.masterpieceId === mpId);
  if ([1, 2, 3].includes(position)) out = out.filter((b) => b.position === position);
  if (walletAddress) out = out.filter((b) => (b.loginAddress || "").toLowerCase() === walletAddress);

  res.json({ ok: true, bets: out });
});

app.get("/api/results/:masterpieceId", (req, res) => {
  const mpId = Number(req.params.masterpieceId);
  if (!Number.isInteger(mpId)) return res.status(400).json({ error: "invalid masterpieceId" });
  const result = store.results?.[mpId] || null;
  return res.json({ ok: true, result });
});

app.post("/api/settle/:masterpieceId", async (req, res) => {
  try {
    const mpId = Number(req.params.masterpieceId);
    if (!Number.isInteger(mpId)) return res.status(400).json({ error: "invalid masterpieceId" });
    if (!vaultContract) {
      return res.status(500).json({ error: "VAULT_LEDGER_ADDRESS or OPERATOR_PRIVATE_KEY not configured" });
    }

    const mpJson = await fetchMasterpiece(mpId);
    const mp = mpJson?.data?.masterpiece;
    if (!mp?.leaderboard) return res.status(400).json({ error: "no leaderboard" });

    const winners = {
      1: mp.leaderboard.find((r) => r.position === 1),
      2: mp.leaderboard.find((r) => r.position === 2),
      3: mp.leaderboard.find((r) => r.position === 3),
    };

    const results = [1, 2, 3].map((pos) => {
      const row = winners[pos];
      return settleMarket({
        masterpieceId: mpId,
        position: pos,
        bets: store.bets,
        winnerUid: row?.profile?.uid,
        winnerName: row?.profile?.displayName,
      });
    });

    // House keeps half if no-one wins; other half carryover
    for (const r of results) {
      if (r.status === "NO_WINNERS") {
        store.house.total += r.houseTake;
        store.house.byMasterpiece[mpId] = (store.house.byMasterpiece[mpId] || 0) + r.houseTake;
        store.carryover[String(r.position)] =
          (store.carryover[String(r.position)] || 0) + r.carryover;
      }
    }

    store.results[mpId] = {
      settledAt: new Date().toISOString(),
      masterpieceName: mp.name,
      winners: {
        1: winners[1]?.profile?.displayName || null,
        2: winners[2]?.profile?.displayName || null,
        3: winners[3]?.profile?.displayName || null,
      },
      results,
    };

    persist();

    const settlementReceipts = [];
    for (const result of results) {
      const betId = buildBetId(result.masterpieceId, result.position);
      const stakes = new Map();
      store.bets
        .filter((b) => b.masterpieceId === result.masterpieceId && b.position === result.position)
        .forEach((bet) => {
          const address = normalizeWallet(bet.loginAddress || bet.user);
          if (!address) return;
          const current = stakes.get(address) || 0;
          stakes.set(address, current + Number(bet.wagerAmount ?? bet.amount ?? 0));
        });
      if (stakes.size === 0) {
        continue;
      }
      const participants = Array.from(stakes.keys());
      const payouts = participants.map((address) => Number(result.payouts?.[address] || 0));
      const payoutAmounts = payouts.map((amount) => parseUnits(String(amount), DYNW_DECIMALS));

      const tx = await vaultContract.settleBet(
        betId,
        participants,
        payoutAmounts,
      );
      const receipt = await tx.wait();
      settlementReceipts.push({ betId, txHash: tx.hash, status: receipt?.status ?? null });
    }

    res.json({
      ok: true,
      masterpieceId: mpId,
      masterpieceName: mp.name,
      tokenAddress: DYNW_TOKEN_ADDRESS,
      carryover: store.carryover,
      house: store.house,
      results,
      settlements: settlementReceipts,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

setInterval(() => {
  let changed = false;
  const now = Date.now();
  if (blackjackState.phase === "player" && blackjackState.turnExpiresAt && now >= blackjackState.turnExpiresAt) {
    const result = timeoutStand(blackjackState);
    if (result.ok) changed = true;
  }
  if (blackjackState.phase === "idle" || blackjackState.phase === "settled") {
    if (queueNextRoundIfNeeded()) changed = true;
    if (tryStartNextRound()) changed = true;
  }
  if (blackjackState.phase === "settled") {
    applyBlackjackRoundResults().catch((e) => console.error("Blackjack round sync error:", e));
  }
  if (changed) {
    persistBlackjackUpdates();
  }
}, 1000);

// ---- Serve built frontend when available ----
const distDir = path.join(__dirname, "..", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));

  app.get("*", (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.json({ ok: true, message: "CraftWorld Bets API is running." });
  });
}

const port = process.env.PORT || 3000;
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => console.log(`Server running on http://${host}:${port}`));
