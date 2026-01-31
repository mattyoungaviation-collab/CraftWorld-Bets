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
  parseUnits,
  verifyMessage,
} from "ethers";
import { makeStore, newId, settleMarket } from "./betting.js";
import { getOrCreateUser, prisma } from "./db.js";
import { buildBlackjackSessionBetId, getVaultReadContract } from "./lib/vaultLedger.js";
import { computeModelOdds } from "./odds.js";
import {
  createBlackjackShoe,
  dealInitialHand,
  evaluateHandOutcome,
  resolveDealerHand,
  applyPlayerAction,
  shouldAllowAction,
} from "./blackjackEngine.js";

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
const BLACKJACK_DECKS = 6;
const BLACKJACK_TABLE_MIN_WEI = 25n * 10n ** BigInt(DYNW_DECIMALS);
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

function requireLoginWallet(req, walletAddress) {
  const normalized = normalizeWallet(walletAddress);
  if (!normalized) return { error: "walletAddress required" };
  const loginAddress = normalizeWallet(req.user?.loginAddress);
  if (!loginAddress || normalized !== loginAddress) {
    return { error: "walletAddress does not match signed-in wallet" };
  }
  return { ok: true, walletAddress: normalized };
}

function coerceSerializedValue(value) {
  let current = value;
  let depth = 0;
  while (current && typeof current === "object" && depth < 5) {
    if (current.$type === "BigInt" && typeof current.value !== "undefined") {
      current = current.value;
    } else if (typeof current.value !== "undefined") {
      current = current.value;
    } else if (typeof current.toString === "function" && current.toString !== Object.prototype.toString) {
      current = current.toString();
    } else {
      break;
    }
    depth += 1;
  }
  return current;
}

function parseAmountWei(value) {
  value = coerceSerializedValue(value);
  if (typeof value === "bigint") {
    if (value <= 0n) return { error: "amountWei must be positive" };
    return { ok: true, amountWei: value };
  }
  if (typeof value === "number") {
    value = String(value);
  }
  if (typeof value !== "string") return { error: "amountWei required" };
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) return { error: "amountWei must be positive" };
    return { ok: true, amountWei: parsed };
  } catch {
    return { error: "amountWei invalid" };
  }
}

async function getOpenBlackjackSession(walletAddress) {
  return prisma.blackjackSession.findFirst({ where: { walletAddress, status: "OPEN" } });
}

function serializeBlackjackSession(session) {
  if (!session) return null;
  return {
    ...session,
    buyInAmountWei: session.buyInAmountWei,
    bankrollWei: session.bankrollWei,
  };
}

function serializeBlackjackHand(hand) {
  if (!hand) return null;
  return {
    ...hand,
    betAmountWei: hand.betAmountWei,
    payoutWei: hand.payoutWei,
  };
}

async function getPendingBlackjackHand(sessionId, tx = prisma) {
  return tx.blackjackHand.findFirst({
    where: { sessionId, outcome: "PENDING" },
    orderBy: { createdAt: "desc" },
  });
}

async function getLatestBlackjackHand(sessionId, tx = prisma) {
  return tx.blackjackHand.findFirst({
    where: { sessionId },
    orderBy: { createdAt: "desc" },
  });
}

async function fetchVaultBalance(walletAddress) {
  if (!vaultReadContract) {
    throw new Error("VAULT_LEDGER_ADDRESS is not configured");
  }
  return vaultReadContract.balances(walletAddress, DYNW_TOKEN_ADDRESS);
}

async function fetchVaultLockedBalance(walletAddress) {
  if (!vaultReadContract) {
    throw new Error("VAULT_LEDGER_ADDRESS is not configured");
  }
  return vaultReadContract.lockedBalances(walletAddress, DYNW_TOKEN_ADDRESS);
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


app.get("/api/blackjack/session", requireAuth, async (req, res) => {
  try {
    const authCheck = requireLoginWallet(req, req.user?.loginAddress);
    if (authCheck.error) return res.status(403).json({ error: authCheck.error });
    const session = await getOpenBlackjackSession(authCheck.walletAddress);
    if (!session) return res.json({ ok: true, session: null, hand: null });
    const hand = await getPendingBlackjackHand(session.id);
    return res.json({
      ok: true,
      session: serializeBlackjackSession(session),
      hand: serializeBlackjackHand(hand),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/api/blackjack/balance", requireAuth, async (req, res) => {
  try {
    const authCheck = requireLoginWallet(req, req.user?.loginAddress);
    if (authCheck.error) return res.status(403).json({ error: authCheck.error });
    const walletAddress = authCheck.walletAddress;
    const [balance, locked] = await Promise.all([
      fetchVaultBalance(walletAddress),
      fetchVaultLockedBalance(walletAddress),
    ]);
    const available = BigInt(balance) - BigInt(locked);
    return res.json({
      ok: true,
      wallet: walletAddress,
      balance: balance.toString(),
      locked: locked.toString(),
      available: available.toString(),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/api/blackjack/buyin", requireAuth, async (req, res) => {
  try {
    const amountCheck = parseAmountWei(req.body?.amountWei);
    if (amountCheck.error) return res.status(400).json({ error: amountCheck.error });
    const seatId = Number(req.body?.seatId);
    if (!Number.isInteger(seatId) || seatId < 0 || seatId > 4) {
      return res.status(400).json({ error: "seatId must be between 0 and 4" });
    }
    const authCheck = requireLoginWallet(req, req.user?.loginAddress);
    if (authCheck.error) return res.status(403).json({ error: authCheck.error });
    const walletAddress = authCheck.walletAddress;
    const amountWei = amountCheck.amountWei;

    const [balance, locked] = await Promise.all([
      fetchVaultBalance(walletAddress),
      fetchVaultLockedBalance(walletAddress),
    ]);
    const available = BigInt(balance) - BigInt(locked);
    if (amountWei > available) {
      return res.status(400).json({ error: "Buy-in exceeds available vault balance" });
    }

    const session = await prisma.$transaction(async (tx) => {
      const existing = await tx.blackjackSession.findFirst({
        where: { walletAddress, status: "OPEN" },
      });
      if (existing) {
        throw new Error("Session already open");
      }
      const seatTaken = await tx.blackjackSession.findFirst({
        where: { seatId, status: "OPEN" },
      });
      if (seatTaken) {
        throw new Error("Seat already occupied");
      }
      return tx.blackjackSession.create({
        data: {
          walletAddress,
          seatId,
          buyInAmountWei: amountWei.toString(),
          bankrollWei: amountWei.toString(),
          status: "OPEN",
        },
      });
    });

    const betId = buildBlackjackSessionBetId(session.id);
    return res.json({
      ok: true,
      session: serializeBlackjackSession(session),
      instruction: {
        sessionId: session.id,
        seatId: session.seatId,
        amountWei: amountWei.toString(),
        betId,
      },
    });
  } catch (e) {
    const message = String(e?.message || e);
    if (message.includes("Session already open") || message.includes("Seat already occupied")) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: message });
  }
});

app.post("/api/blackjack/deal", requireAuth, async (req, res) => {
  try {
    const amountCheck = parseAmountWei(req.body?.betAmountWei ?? req.body?.amountWei);
    if (amountCheck.error) return res.status(400).json({ error: amountCheck.error });
    const authCheck = requireLoginWallet(req, req.user?.loginAddress);
    if (authCheck.error) return res.status(403).json({ error: authCheck.error });
    const walletAddress = authCheck.walletAddress;
    const session = await getOpenBlackjackSession(walletAddress);
    if (!session) return res.status(400).json({ error: "No open blackjack session" });
    const existingHand = await getPendingBlackjackHand(session.id);
    if (existingHand) return res.status(400).json({ error: "Hand already in progress" });

    const betAmountWei = amountCheck.amountWei;
    const bankrollWei = BigInt(session.bankrollWei);
    if (betAmountWei > bankrollWei) {
      return res.status(400).json({ error: "Bet exceeds bankroll" });
    }
    if (betAmountWei < BLACKJACK_TABLE_MIN_WEI) {
      return res.status(400).json({ error: "Bet below table minimum" });
    }

    const lastHand = await getLatestBlackjackHand(session.id);
    const lastShoe = Array.isArray(lastHand?.stateJson?.shoe) ? [...lastHand.stateJson.shoe] : [];
    const shoe = lastShoe.length >= 52 ? lastShoe : createBlackjackShoe(BLACKJACK_DECKS);

    const { state } = dealInitialHand(shoe, betAmountWei.toString());
    let payoutWei = 0n;
    let outcome = "PENDING";
    if (state.phase === "settled") {
      const resolved = evaluateHandOutcome(state);
      payoutWei = resolved.payoutWei;
      outcome = resolved.outcome;
      state.handResults = resolved.handResults;
    }

    const result = await prisma.$transaction(async (tx) => {
      const handRecord = await tx.blackjackHand.create({
        data: {
          sessionId: session.id,
          betAmountWei: betAmountWei.toString(),
          stateJson: state,
          outcome,
          payoutWei: payoutWei.toString(),
        },
      });
      let updatedSession = session;
      if (outcome !== "PENDING") {
        const updatedBankroll = (BigInt(session.bankrollWei) + payoutWei).toString();
        updatedSession = await tx.blackjackSession.update({
          where: { id: session.id },
          data: { bankrollWei: updatedBankroll },
        });
      }
      return { handRecord, updatedSession };
    });

    return res.json({
      ok: true,
      session: serializeBlackjackSession(result.updatedSession),
      hand: serializeBlackjackHand(result.handRecord),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/api/blackjack/action", requireAuth, async (req, res) => {
  try {
    const action = String(req.body?.action || "").toLowerCase();
    if (!["hit", "stand", "double", "split", "surrender"].includes(action)) {
      return res.status(400).json({ error: "action invalid" });
    }
    const authCheck = requireLoginWallet(req, req.user?.loginAddress);
    if (authCheck.error) return res.status(403).json({ error: authCheck.error });
    const walletAddress = authCheck.walletAddress;

    const result = await prisma.$transaction(async (tx) => {
      const session = await tx.blackjackSession.findFirst({
        where: { walletAddress, status: "OPEN" },
      });
      if (!session) throw new Error("No open blackjack session");
      const hand = await getPendingBlackjackHand(session.id, tx);
      if (!hand) throw new Error("No active hand");
      const state = hand.stateJson;
      const bankrollWei = BigInt(session.bankrollWei);
      const allow = shouldAllowAction(state, action, bankrollWei);
      if (!allow.ok) throw new Error(allow.error || "Action not allowed");

      const updatedState = applyPlayerAction(state, action);
      let payoutWei = 0n;
      let outcome = "PENDING";
      if (updatedState.phase === "dealer") {
        const resolvedState = resolveDealerHand(updatedState);
        const resolved = evaluateHandOutcome(resolvedState);
        resolvedState.handResults = resolved.handResults;
        payoutWei = resolved.payoutWei;
        outcome = resolved.outcome;
        const updatedBankroll = (BigInt(session.bankrollWei) + payoutWei).toString();
        const updatedSession = await tx.blackjackSession.update({
          where: { id: session.id },
          data: { bankrollWei: updatedBankroll },
        });
        const updatedHand = await tx.blackjackHand.update({
          where: { id: hand.id },
          data: {
            stateJson: resolvedState,
            outcome,
            payoutWei: payoutWei.toString(),
          },
        });
        return { session: updatedSession, hand: updatedHand };
      }

      const updatedHand = await tx.blackjackHand.update({
        where: { id: hand.id },
        data: { stateJson: updatedState },
      });
      return { session, hand: updatedHand };
    });

    return res.json({
      ok: true,
      session: serializeBlackjackSession(result.session),
      hand: serializeBlackjackHand(result.hand),
    });
  } catch (e) {
    const message = String(e?.message || e);
    if (message === "No active hand" || message === "No open blackjack session" || message.startsWith("Action")) {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: message });
  }
});

app.post("/api/blackjack/leave", requireAuth, async (req, res) => {
  try {
    const authCheck = requireLoginWallet(req, req.user?.loginAddress);
    if (authCheck.error) return res.status(403).json({ error: authCheck.error });
    const walletAddress = authCheck.walletAddress;
    const session = await getOpenBlackjackSession(walletAddress);
    if (!session) return res.status(400).json({ error: "No open blackjack session" });
    const pendingHand = await getPendingBlackjackHand(session.id);
    if (pendingHand) return res.status(400).json({ error: "Finish the current hand before leaving" });
    if (!vaultContract || !operatorSigner) {
      return res.status(500).json({ error: "Vault contract is not configured" });
    }

    const buyInWei = BigInt(session.buyInAmountWei);
    const bankrollWei = BigInt(session.bankrollWei);
    const netDeltaWei = bankrollWei - buyInWei;
    const betId = buildBlackjackSessionBetId(session.id);
    const payoutWei = buyInWei + netDeltaWei;
    let txHash = "";

    if (netDeltaWei > 0n) {
      await vaultContract.placeBet(betId, DYNW_TOKEN_ADDRESS, netDeltaWei);
      const tx = await vaultContract.settleBet(
        betId,
        [walletAddress, operatorSigner.address],
        [payoutWei, 0n]
      );
      await tx.wait();
      txHash = tx.hash;
    } else {
      const safePayout = payoutWei > 0n ? payoutWei : 0n;
      const tx = await vaultContract.settleBet(betId, [walletAddress], [safePayout]);
      await tx.wait();
      txHash = tx.hash;
    }

    const updatedSession = await prisma.blackjackSession.update({
      where: { id: session.id },
      data: { status: "CLOSED" },
    });

    return res.json({
      ok: true,
      session: serializeBlackjackSession(updatedSession),
      netDeltaWei: netDeltaWei.toString(),
      txHash,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
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
