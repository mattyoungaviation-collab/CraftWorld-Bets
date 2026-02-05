import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import express from "express";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  keccak256,
  parseUnits,
  toUtf8Bytes
} from "ethers";
import { Server as SocketIOServer } from "socket.io";
import { makeStore, newId, settleMarket } from "./betting.js";
import { prisma } from "./db.js";
import { computeModelOdds } from "./odds.js";

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
const BET_MAX_AMOUNT = Number.isFinite(Number(process.env.BET_MAX_AMOUNT))
  ? Number(process.env.BET_MAX_AMOUNT)
  : null;
const RONIN_RPC = process.env.RONIN_RPC || "https://api.roninchain.com/rpc";
const DYNW_TOKEN_ADDRESS = process.env.DYNW_TOKEN_ADDRESS || "0x17ff4EA5dD318E5FAf7f5554667d65abEC96Ff57";
const MASTERPIECE_POOL_ADDRESS = process.env.MASTERPIECE_POOL_ADDRESS || "";
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || "";
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY || "";
const DYNW_DECIMALS = 18;
const CRAFTWORLD_APP_VERSION = process.env.CRAFTWORLD_APP_VERSION || "1.6.2";
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
const roninProvider = new JsonRpcProvider(RONIN_RPC);
const dynwRead = DYNW_TOKEN_ADDRESS ? new Contract(DYNW_TOKEN_ADDRESS, ERC20_READ_ABI, roninProvider) : null;
const operatorSigner = OPERATOR_PRIVATE_KEY ? new Wallet(OPERATOR_PRIVATE_KEY, roninProvider) : null;
const masterpiecePoolContract =
  operatorSigner && MASTERPIECE_POOL_ADDRESS
    ? new Contract(MASTERPIECE_POOL_ADDRESS, MASTERPIECE_POOL_ABI, operatorSigner)
    : null;

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
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      "content-type": "application/json",
      authorization: `Bearer ${jwt}`,
      origin: "https://craft-world.gg",
      referer: "https://craft-world.gg/",
      "x-app-version": CRAFTWORLD_APP_VERSION,
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

// ---- API routes FIRST ----
app.get("/api/health", (_req, res) => res.json({ ok: true }));

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

app.post("/api/bets/preview", async (req, res) => {
  try {
    const loginAddress = normalizeWallet(req.body?.walletAddress);
    const validated = await validateBetPayload(req.body, loginAddress);
    if (validated.error) return res.status(400).json({ error: validated.error });

    res.json({ ok: true, pickedName: validated.pickedName, betId: validated.betId });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/bets", async (req, res) => {
  try {
    const { txHash } = req.body || {};
    let validated = null;
    const loginAddress = normalizeWallet(req.body?.walletAddress);
    const userId = null;
    if (!loginAddress) return res.status(400).json({ error: "invalid login address" });
    validated = await validateBetPayload(req.body, loginAddress);
    if (validated.error) return res.status(400).json({ error: validated.error });

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
