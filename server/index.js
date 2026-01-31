import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createServer } from "http";
import express from "express";
import jwt from "jsonwebtoken";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  formatUnits,
  keccak256,
  parseUnits,
  toUtf8Bytes,
  verifyMessage,
} from "ethers";
import { Server as SocketIOServer } from "socket.io";
import { makeStore, newId, settleMarket } from "./betting.js";
import { getOrCreateUser, prisma } from "./db.js";
import { computeModelOdds } from "./odds.js";
import { CrashEngine } from "./crash/engine.js";

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: true,
    credentials: true,
  },
});
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
const MASTERPIECE_POOL_ADDRESS = process.env.MASTERPIECE_POOL_ADDRESS || "";
const CRASH_VAULT_ADDRESS = process.env.CRASH_VAULT_ADDRESS || "";
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || "";
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY || "";
const DYNW_DECIMALS = 18;
const CRASH_MIN_BET = Number(process.env.CRASH_MIN_BET ?? "10");
const CRASH_MAX_BET = Number(process.env.CRASH_MAX_BET ?? "2500");
const CRASH_HOUSE_EDGE_BPS = Number(process.env.CRASH_HOUSE_EDGE_BPS ?? "200");
const CRASH_BETTING_MS = Number(process.env.CRASH_BETTING_MS ?? "6000");
const CRASH_COOLDOWN_MS = Number(process.env.CRASH_COOLDOWN_MS ?? "4000");
const CRASH_RATE_LIMIT_MS = Number(process.env.CRASH_RATE_LIMIT_MS ?? "500");
const ERC20_READ_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const MASTERPIECE_POOL_ABI = [
  "function placeBet(bytes32 betId, uint8 position, uint256 amount)",
  "function settleMarket(bytes32 betId, uint8 position, address[] winners, uint256[] payouts, uint256 houseTake, uint256 carryoverNext)",
  "function getPool(bytes32 betId) view returns (uint256)",
];
const CRASH_VAULT_ABI = [
  "function placeBet(bytes32 roundId, uint256 amount)",
  "function cashout(bytes32 roundId, address user, uint256 payout)",
  "function settleLoss(bytes32 roundId, address user)",
  "function getStake(bytes32 roundId, address user) view returns (uint256)",
];
const roninProvider = new JsonRpcProvider(RONIN_RPC);
const dynwRead = DYNW_TOKEN_ADDRESS ? new Contract(DYNW_TOKEN_ADDRESS, ERC20_READ_ABI, roninProvider) : null;
const operatorSigner = OPERATOR_PRIVATE_KEY ? new Wallet(OPERATOR_PRIVATE_KEY, roninProvider) : null;
const masterpiecePoolContract =
  operatorSigner && MASTERPIECE_POOL_ADDRESS
    ? new Contract(MASTERPIECE_POOL_ADDRESS, MASTERPIECE_POOL_ABI, operatorSigner)
    : null;
const crashVaultContract =
  operatorSigner && CRASH_VAULT_ADDRESS ? new Contract(CRASH_VAULT_ADDRESS, CRASH_VAULT_ABI, operatorSigner) : null;
const crashVaultReadContract =
  CRASH_VAULT_ADDRESS ? new Contract(CRASH_VAULT_ADDRESS, CRASH_VAULT_ABI, roninProvider) : null;
const authNonces = new Map();
const crashBetCooldown = new Map();
const crashCashoutCooldown = new Map();

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

function serializeCrashBet(bet) {
  if (!bet) return bet;
  return {
    ...bet,
    amountWei: bet.amountWei ? bet.amountWei.toString() : null,
    payoutWei: bet.payoutWei ? bet.payoutWei.toString() : null,
  };
}

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

function rateLimit(map, address) {
  const now = Date.now();
  const last = map.get(address) || 0;
  if (now - last < CRASH_RATE_LIMIT_MS) {
    return false;
  }
  map.set(address, now);
  return true;
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

const crashEngine = new CrashEngine({
  io,
  dataDir,
  bettingMs: CRASH_BETTING_MS,
  cooldownMs: CRASH_COOLDOWN_MS,
  houseEdgeBps: CRASH_HOUSE_EDGE_BPS,
  logger: console,
  settleLoser: async (bet) => {
    if (!crashVaultContract) {
      console.warn("Crash vault not configured; skipping crash settlement");
      return;
    }
    const betId = crashEngine.getRoundBetId();
    const tx = await crashVaultContract.settleLoss(betId, bet.address);
    const receipt = await tx.wait();
    console.log("Crash loser settled:", tx.hash, receipt?.status ?? null);
  },
});

io.on("connection", (socket) => {
  socket.emit("crash:state", crashEngine.getPublicState());
  socket.on("crash:state:request", () => {
    socket.emit("crash:state", crashEngine.getPublicState());
  });
});

crashEngine.start();

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

app.get("/api/crash/state", (_req, res) => {
  res.json(crashEngine.getPublicState());
});

app.post("/api/crash/bet", requireAuth, async (req, res) => {
  try {
    const address = normalizeWallet(req.user?.loginAddress);
    if (!address) return res.status(400).json({ error: "Invalid user address" });
    if (!rateLimit(crashBetCooldown, address)) {
      return res.status(429).json({ error: "Too many requests" });
    }
    if (!crashVaultReadContract) {
      return res.status(500).json({ error: "Crash vault not configured" });
    }
    if (!crashEngine.canBet(address)) {
      return res.status(400).json({ error: "Betting is closed" });
    }

    const betId = crashEngine.getRoundBetId();
    const stakeWei = BigInt(await crashVaultReadContract.getStake(betId, address));
    if (stakeWei === 0n) {
      return res.status(400).json({ error: "No on-chain stake found for this round" });
    }

    const amount = Number(formatUnits(stakeWei, DYNW_DECIMALS));
    if (!Number.isFinite(amount) || amount < CRASH_MIN_BET || amount > CRASH_MAX_BET) {
      return res.status(400).json({ error: "Bet amount outside allowed limits" });
    }

    const bet = crashEngine.registerBet({ address, amount, amountWei: stakeWei });
    res.json({ ok: true, betId, bet: serializeCrashBet(bet) });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.post("/api/crash/cashout", requireAuth, async (req, res) => {
  try {
    const address = normalizeWallet(req.user?.loginAddress);
    if (!address) return res.status(400).json({ error: "Invalid user address" });
    if (!rateLimit(crashCashoutCooldown, address)) {
      return res.status(429).json({ error: "Too many requests" });
    }
    if (!crashVaultContract || !DYNW_TOKEN_ADDRESS || !CRASH_VAULT_ADDRESS) {
      return res.status(500).json({ error: "Crash vault not configured" });
    }

    const round = crashEngine.round;
    if (!round || round.phase !== "RUNNING") {
      return res.status(400).json({ error: "Round is not running" });
    }
    const bet = round.bets.get(address);
    if (!bet) return res.status(404).json({ error: "No active bet" });
    if (bet.cashedOut) return res.status(400).json({ error: "Already cashed out" });
    if (round.currentMultiplier >= round.crashPoint) {
      return res.status(400).json({ error: "Round already crashed" });
    }

    const multiplier = round.currentMultiplier;
    const multiplierFixed = BigInt(Math.round(multiplier * 10_000));
    const payoutWei = (bet.amountWei * multiplierFixed) / 10_000n;

    const betId = crashEngine.getRoundBetId();
    if (dynwRead) {
      const vaultBalance = BigInt(await dynwRead.balanceOf(CRASH_VAULT_ADDRESS));
      if (vaultBalance < payoutWei) {
        return res.status(400).json({ error: "Crash vault balance insufficient for payout" });
      }
    }
    const tx = await crashVaultContract.cashout(betId, address, payoutWei);
    const receipt = await tx.wait();
    console.log("Crash cashout settled:", tx.hash, receipt?.status ?? null);

    const payout = Number(formatUnits(payoutWei, DYNW_DECIMALS));
    const updated = crashEngine.registerCashout({
      address,
      multiplier,
      payout,
      payoutWei,
    });

    res.json({ ok: true, payout, multiplier, txHash: tx.hash, bet: serializeCrashBet(updated) });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
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
    if (!masterpiecePoolContract) {
      return res.status(500).json({ error: "MASTERPIECE_POOL_ADDRESS or OPERATOR_PRIVATE_KEY not configured" });
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
      if (result.pot === 0) {
        continue;
      }
      const betId = buildBetId(result.masterpieceId, result.position);
      const payouts = result.payouts || {};
      const winners = [];
      const payoutAmounts = [];
      for (const [user, payout] of Object.entries(payouts)) {
        const address = normalizeWallet(user);
        if (!address) continue;
        const amount = parseUnits(String(payout), DYNW_DECIMALS);
        if (amount <= 0n) continue;
        winners.push(address);
        payoutAmounts.push(amount);
      }
      const houseTakeWei = parseUnits(String(result.houseTake || 0), DYNW_DECIMALS);
      const carryoverNext = Number(store.carryover[String(result.position)] || 0);
      const carryoverWei = parseUnits(String(carryoverNext), DYNW_DECIMALS);
      const tx = await masterpiecePoolContract.settleMarket(
        betId,
        result.position,
        winners,
        payoutAmounts,
        houseTakeWei,
        carryoverWei,
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
httpServer.listen(port, host, () => console.log(`Server running on http://${host}:${port}`));
