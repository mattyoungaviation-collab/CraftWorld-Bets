import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { makeStore, newId, settleMarket } from "./betting.js";
import {
  loadBlackjackState,
  saveBlackjackState,
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
  ROUND_COOLDOWN_MS,
} from "./blackjack.js";
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
const blackjackStatePath = path.join(dataDir, "blackjack.json");
const blackjackState = loadBlackjackState(blackjackStatePath);

function persistBlackjackState() {
  saveBlackjackState(blackjackStatePath, blackjackState);
}

function queueNextRoundIfNeeded() {
  const hasPlayers = blackjackState.seats.some((seat) => seat.joined);
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
const SERVICE_FEE_BPS = 500;
const VALIDATION_TTL_MS = 5 * 60 * 1000;
const validations = new Map();
const WALLET_BET_LIMIT = 1000;
const GAME_WALLET_ADDRESS =
  process.env.GAME_WALLET_ADDRESS || "0x1111111111111111111111111111111111111111";
const GAME_WALLET_PRIVATE_KEY = process.env.GAME_WALLET_PRIVATE_KEY || "";
const RONIN_RPC = process.env.RONIN_RPC || "https://api.roninchain.com/rpc";
const KYBER_BASE_URL = process.env.KYBER_BASE_URL || "https://aggregator-api.kyberswap.com/ronin/api/v1";
const KYBER_CLIENT_ID = process.env.KYBER_CLIENT_ID || "CraftWorldBets";
const KYBER_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const DYNW_TOKEN_ADDRESS = "0x17ff4EA5dD318E5FAf7f5554667d65abEC96Ff57";
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];
const roninProvider = new JsonRpcProvider(RONIN_RPC);

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

function normalizeKyberAddress(address) {
  return normalizeWallet(address) || undefined;
}

async function fetchKyber(pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${KYBER_BASE_URL}${pathname}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      "x-client-id": KYBER_CLIENT_ID,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.message || payload?.error || `Kyber request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

function extractRouteSummary(routePayload) {
  if (!routePayload) return null;
  return (
    routePayload?.data?.routeSummary ||
    routePayload?.data?.routes?.[0]?.routeSummary ||
    routePayload?.data?.route?.routeSummary ||
    routePayload?.routeSummary ||
    null
  );
}

function extractBuildData(buildPayload) {
  if (!buildPayload) return null;
  return buildPayload?.data || buildPayload?.result || buildPayload;
}

function normalizeKyberBuild(buildData) {
  if (!buildData) return null;
  const routerAddress = buildData.routerAddress || buildData.to;
  return {
    to: routerAddress || null,
    data: buildData.data || null,
    value: buildData.transactionValue || buildData.value || "0",
    approvalSpender: buildData.routerAddress || buildData.tokenApproveAddress || buildData.to || null,
    raw: buildData,
  };
}

async function buildKyberSwap({ tokenIn, tokenOut, amountIn, sender, recipient, slippageTolerance, deadline }) {
  const params = new URLSearchParams({
    tokenIn,
    tokenOut,
    amountIn,
    saveGas: "false",
    gasInclude: "true",
    source: "CraftWorldBets",
  });
  const routePayload = await fetchKyber(`/routes?${params.toString()}`);
  const routeSummary = extractRouteSummary(routePayload);
  if (!routeSummary) {
    throw new Error("Kyber route summary missing.");
  }
  const buildPayload = await fetchKyber("/route/build", {
    method: "POST",
    body: {
      routeSummary,
      sender: normalizeKyberAddress(sender),
      recipient: normalizeKyberAddress(recipient),
      slippageTolerance,
      deadline,
      source: "CraftWorldBets",
    },
  });
  const buildData = extractBuildData(buildPayload);
  if (!buildData?.data || !(buildData?.routerAddress || buildData?.to)) {
    throw new Error("Kyber build data missing.");
  }
  const normalizedBuild = normalizeKyberBuild(buildData);
  return { buildData: normalizedBuild, routeSummary };
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

function syncWalletBalancesFromSeats() {
  blackjackState.seats.forEach((seat) => {
    if (!seat.joined || !seat.walletAddress) return;
    const record = ensureWalletRecord(seat.walletAddress);
    if (!record) return;
    record.balance = Number(seat.bankroll || 0);
  });
}

function applyBlackjackLedgerQueue() {
  if (!Array.isArray(blackjackState.ledgerQueue) || blackjackState.ledgerQueue.length === 0) return;
  blackjackState.ledgerQueue.forEach((entry) => {
    if (!entry?.walletAddress) return;
    addLedgerEntry(entry.walletAddress, {
      type: entry.type || "adjustment",
      amount: Number(entry.amount || 0),
      seatId: entry.seatId ?? null,
      handIndex: entry.handIndex ?? null,
    });
  });
  blackjackState.ledgerQueue = [];
}

function persistBlackjackUpdates() {
  applyBlackjackLedgerQueue();
  syncWalletBalancesFromSeats();
  persist();
  persistBlackjackState();
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

function attachBetToWallet(address, betId) {
  const record = ensureWalletRecord(address);
  if (!record) return;
  if (!record.betIds.includes(betId)) {
    record.betIds.push(betId);
    if (record.betIds.length > WALLET_BET_LIMIT) {
      record.betIds = record.betIds.slice(-WALLET_BET_LIMIT);
    }
  }
}

// ---- API routes FIRST ----
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/game-wallet", (_req, res) => {
  res.json({
    ok: true,
    address: GAME_WALLET_ADDRESS,
    note: "TODO: replace with per-user game wallet assignment.",
  });
});

app.post("/api/kyber/route/build", async (req, res) => {
  try {
    const { routeSummary, slippageTolerance, recipient, sender, deadline, tokenIn, tokenOut, amountIn } =
      req.body || {};
    const slippageBps = Number.isFinite(Number(slippageTolerance)) ? Number(slippageTolerance) : 50;
    const normalizedSender = normalizeKyberAddress(sender);
    const normalizedRecipient = normalizeKyberAddress(recipient);
    if (routeSummary) {
      const payload = await fetchKyber("/route/build", {
        method: "POST",
        body: {
          routeSummary,
          slippageTolerance: slippageBps,
          recipient: normalizedRecipient,
          sender: normalizedSender,
          deadline,
        },
      });
      const build = extractBuildData(payload);
      if (!build?.data || !(build?.routerAddress || build?.to)) {
        return res.status(502).json({ error: "Kyber build response missing routerAddress/data" });
      }
      const normalized = normalizeKyberBuild(build);
      return res.json({ ok: true, ...normalized, raw: payload });
    }

    if (!tokenIn || !tokenOut || !amountIn || !sender) {
      return res.status(400).json({ error: "routeSummary or tokenIn, tokenOut, amountIn, and sender are required" });
    }

    const result = await buildKyberSwap({
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      sender,
      recipient: recipient || sender,
      slippageTolerance: slippageBps,
      deadline,
    });
    return res.json({ ok: true, ...result.buildData, routeSummary: result.routeSummary });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.post("/api/game-wallet/swap", async (req, res) => {
  try {
    const { direction, amountIn, recipient, slippageTolerance, deadline } = req.body || {};
    if (!direction || !amountIn) {
      return res.status(400).json({ error: "direction and amountIn are required" });
    }
    if (!GAME_WALLET_PRIVATE_KEY) {
      return res.status(400).json({ error: "GAME_WALLET_PRIVATE_KEY is not configured" });
    }

    const amountInValue = BigInt(amountIn);
    if (amountInValue <= 0n) {
      return res.status(400).json({ error: "Invalid swap amounts" });
    }

    const wallet = new Wallet(GAME_WALLET_PRIVATE_KEY, roninProvider);
    const swapDeadline = Number(deadline) || Math.floor(Date.now() / 1000) + 10 * 60;
    const toAddress = typeof recipient === "string" && recipient ? recipient : wallet.address;
    const slippageBps = Number.isFinite(Number(slippageTolerance)) ? Number(slippageTolerance) : 50;

    if (direction === "DYNW_TO_RON") {
      const { buildData } = await buildKyberSwap({
        tokenIn: DYNW_TOKEN_ADDRESS,
        tokenOut: KYBER_NATIVE_TOKEN,
        amountIn: amountInValue.toString(),
        sender: wallet.address,
        recipient: toAddress,
        slippageTolerance: slippageBps,
        deadline: swapDeadline,
      });
      const approvalSpender = buildData.approvalSpender || buildData.to;
      const token = new Contract(DYNW_TOKEN_ADDRESS, ERC20_ABI, wallet);
      const allowance = await token.allowance(wallet.address, approvalSpender);
      if (allowance < amountInValue) {
        const approveTx = await token.approve(approvalSpender, amountInValue);
        await approveTx.wait();
      }
      const value = buildData?.value ? BigInt(buildData.value) : 0n;
      const tx = await wallet.sendTransaction({ to: buildData.to, data: buildData.data, value });
      const receipt = await tx.wait();
      return res.json({ ok: true, txHash: tx.hash, status: receipt?.status ?? null });
    }

    if (direction === "RON_TO_DYNW") {
      const { buildData } = await buildKyberSwap({
        tokenIn: KYBER_NATIVE_TOKEN,
        tokenOut: DYNW_TOKEN_ADDRESS,
        amountIn: amountInValue.toString(),
        sender: wallet.address,
        recipient: toAddress,
        slippageTolerance: slippageBps,
        deadline: swapDeadline,
      });
      const value = buildData?.value ? BigInt(buildData.value) : 0n;
      const tx = await wallet.sendTransaction({ to: buildData.to, data: buildData.data, value });
      const receipt = await tx.wait();
      return res.json({ ok: true, txHash: tx.hash, status: receipt?.status ?? null });
    }

    return res.status(400).json({ error: "Unsupported swap direction" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/api/blackjack/state", (_req, res) => {
  res.json({ ok: true, state: blackjackState });
});

app.post("/api/blackjack/join", (req, res) => {
  const seatId = Number(req.body?.seatId);
  if (!Number.isInteger(seatId)) return res.status(400).json({ error: "seatId required" });
  const walletAddress = normalizeWallet(req.body?.walletAddress);
  const walletRecord = walletAddress ? ensureWalletRecord(walletAddress) : null;
  const bankrollOverride = walletRecord ? walletRecord.balance : null;
  const result = joinSeat(blackjackState, seatId, req.body?.name, walletAddress, bankrollOverride);
  if (result.error) return res.status(400).json({ error: result.error });
  queueNextRoundIfNeeded();
  persistBlackjackUpdates();
  return res.json({ ok: true, state: blackjackState });
});

app.post("/api/blackjack/leave", (req, res) => {
  const seatId = Number(req.body?.seatId);
  if (!Number.isInteger(seatId)) return res.status(400).json({ error: "seatId required" });
  const ownership = requireSeatOwner(seatId, req.body?.walletAddress);
  if (ownership.error) return res.status(403).json({ error: ownership.error });
  const result = leaveSeat(blackjackState, seatId);
  if (result.error) return res.status(400).json({ error: result.error });
  persistBlackjackUpdates();
  return res.json({ ok: true, state: blackjackState });
});

app.post("/api/blackjack/seat", (req, res) => {
  const seatId = Number(req.body?.seatId);
  if (!Number.isInteger(seatId)) return res.status(400).json({ error: "seatId required" });
  const ownership = requireSeatOwner(seatId, req.body?.walletAddress);
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

app.post("/api/blackjack/start", (_req, res) => {
  const result = startRound(blackjackState);
  if (result.error) return res.status(400).json({ error: result.error });
  persistBlackjackUpdates();
  return res.json({ ok: true, state: blackjackState });
});

app.post("/api/blackjack/hit", (req, res) => {
  const seatId = Number(req.body?.seatId);
  if (!Number.isInteger(seatId)) return res.status(400).json({ error: "seatId required" });
  const ownership = requireSeatOwner(seatId, req.body?.walletAddress);
  if (ownership.error) return res.status(403).json({ error: ownership.error });
  const result = hit(blackjackState, seatId);
  if (result.error) return res.status(400).json({ error: result.error });
  persistBlackjackUpdates();
  return res.json({ ok: true, state: blackjackState });
});

app.post("/api/blackjack/stand", (req, res) => {
  const seatId = Number(req.body?.seatId);
  if (!Number.isInteger(seatId)) return res.status(400).json({ error: "seatId required" });
  const ownership = requireSeatOwner(seatId, req.body?.walletAddress);
  if (ownership.error) return res.status(403).json({ error: ownership.error });
  const result = stand(blackjackState, seatId);
  if (result.error) return res.status(400).json({ error: result.error });
  persistBlackjackUpdates();
  return res.json({ ok: true, state: blackjackState });
});

app.post("/api/blackjack/double", (req, res) => {
  const seatId = Number(req.body?.seatId);
  if (!Number.isInteger(seatId)) return res.status(400).json({ error: "seatId required" });
  const ownership = requireSeatOwner(seatId, req.body?.walletAddress);
  if (ownership.error) return res.status(403).json({ error: ownership.error });
  const result = doubleDown(blackjackState, seatId);
  if (result.error) return res.status(400).json({ error: result.error });
  persistBlackjackUpdates();
  return res.json({ ok: true, state: blackjackState });
});

app.post("/api/blackjack/split", (req, res) => {
  const seatId = Number(req.body?.seatId);
  if (!Number.isInteger(seatId)) return res.status(400).json({ error: "seatId required" });
  const ownership = requireSeatOwner(seatId, req.body?.walletAddress);
  if (ownership.error) return res.status(403).json({ error: ownership.error });
  const result = splitHand(blackjackState, seatId);
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

app.post("/api/wallets/register", (req, res) => {
  try {
    const { address } = req.body || {};
    const normalized = normalizeWallet(address);
    if (!normalized) return res.status(400).json({ error: "address required" });

    const record = ensureWalletRecord(normalized);
    persist();

    return res.json({ ok: true, wallet: record });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.get("/api/wallets/:address/ledger", (req, res) => {
  try {
    const normalized = normalizeWallet(req.params.address);
    if (!normalized) return res.status(400).json({ error: "invalid address" });
    const wallet = ensureWalletRecord(normalized);
    persist();
    res.json({ ok: true, wallet });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/wallets/:address/deposit", (req, res) => {
  try {
    const normalized = normalizeWallet(req.params.address);
    if (!normalized) return res.status(400).json({ error: "invalid address" });
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amount must be positive" });
    }
    const txHash = String(req.body?.txHash || "");
    const record = ensureWalletRecord(normalized);
    const existing = record.ledger?.find((entry) => entry.txHash && entry.txHash === txHash);
    if (txHash && existing) return res.status(400).json({ error: "deposit already recorded" });
    addLedgerEntry(normalized, { type: "deposit", amount, txHash: txHash || null });
    blackjackState.seats.forEach((seat) => {
      if (seat.joined && seat.walletAddress === normalized) {
        seat.bankroll = Number(record.balance || 0);
      }
    });
    persistBlackjackUpdates();
    res.json({ ok: true, wallet: record });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/wallets/:address/withdraw", (req, res) => {
  try {
    const normalized = normalizeWallet(req.params.address);
    if (!normalized) return res.status(400).json({ error: "invalid address" });
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amount must be positive" });
    }
    const record = ensureWalletRecord(normalized);
    if (record.balance < amount) return res.status(400).json({ error: "insufficient balance" });
    const txHash = String(req.body?.txHash || "");
    const existing = record.ledger?.find((entry) => entry.txHash && entry.txHash === txHash);
    if (txHash && existing) return res.status(400).json({ error: "withdrawal already recorded" });
    addLedgerEntry(normalized, { type: "withdrawal", amount: -amount, txHash: txHash || null });
    blackjackState.seats.forEach((seat) => {
      if (seat.joined && seat.walletAddress === normalized) {
        seat.bankroll = Number(record.balance || 0);
      }
    });
    persistBlackjackUpdates();
    res.json({ ok: true, wallet: record });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/wallets/:address/bets", (req, res) => {
  try {
    const normalized = normalizeWallet(req.params.address);
    if (!normalized) return res.status(400).json({ error: "invalid address" });
    const wallet = ensureWalletRecord(normalized);
    const bets = store.bets.filter((b) => (b.walletAddress || "").toLowerCase() === normalized);
    persist();
    res.json({ ok: true, wallet, bets });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

function resolveAmounts({ amount, totalAmount, serviceFeeAmount, wagerAmount }) {
  const amt = Number(amount);
  const total = totalAmount !== undefined ? Number(totalAmount) : null;
  const fee = serviceFeeAmount !== undefined ? Number(serviceFeeAmount) : null;
  const wager = wagerAmount !== undefined ? Number(wagerAmount) : null;

  if (total !== null && (!Number.isFinite(total) || !Number.isInteger(total))) {
    return { error: "totalAmount must be an integer" };
  }
  if (fee !== null && (!Number.isFinite(fee) || !Number.isInteger(fee))) {
    return { error: "serviceFeeAmount must be an integer" };
  }
  if (wager !== null && (!Number.isFinite(wager) || !Number.isInteger(wager))) {
    return { error: "wagerAmount must be an integer" };
  }

  if (total !== null) {
    const expectedFee = Math.floor((total * SERVICE_FEE_BPS) / 10000);
    const expectedWager = total - expectedFee;
    if (expectedWager <= 0) return { error: "amount must be a positive integer" };
    if (fee !== null && fee !== expectedFee) return { error: "serviceFeeAmount mismatch" };
    if (wager !== null && wager !== expectedWager) return { error: "wagerAmount mismatch" };
    if (amt !== expectedWager) return { error: "amount must match wagerAmount" };
    return {
      wagerAmount: expectedWager,
      totalAmount: total,
      serviceFeeAmount: expectedFee,
    };
  }

  if (!Number.isInteger(amt) || amt <= 0) return { error: "amount must be a positive integer" };
  if (fee !== null && (!Number.isInteger(fee) || fee < 0)) return { error: "serviceFeeAmount must be an integer" };

  return {
    wagerAmount: amt,
    totalAmount: fee !== null ? amt + fee : amt,
    serviceFeeAmount: fee !== null ? fee : 0,
  };
}

async function validateBetPayload(body) {
  const { user, masterpieceId, position, pickedUid, futureBet } = body || {};

  if (!user || typeof user !== "string") return { error: "user required" };

  const mpId = Number(masterpieceId);
  if (!Number.isInteger(mpId)) return { error: "masterpieceId must be integer" };

  const pos = Number(position);
  if (![1, 2, 3].includes(pos)) return { error: "position must be 1, 2, or 3" };

  if (!pickedUid || typeof pickedUid !== "string") return { error: "pickedUid required" };

  const amountCheck = resolveAmounts(body);
  if (amountCheck.error) return { error: amountCheck.error };

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
    user,
    masterpieceId: mpId,
    position: pos,
    pickedUid,
    pickedName,
    futureBet: Boolean(futureBet),
    ...amountCheck,
  };
}

app.post("/api/bets/preview", async (req, res) => {
  try {
    const validated = await validateBetPayload(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });

    const validationId = newId();
    validations.set(validationId, {
      ...validated,
      expiresAt: Date.now() + VALIDATION_TTL_MS,
    });

    res.json({ ok: true, pickedName: validated.pickedName, validationId });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/bets", async (req, res) => {
  try {
    const { validationId, walletAddress, escrowTx, feeTx, totalAmount, serviceFeeAmount, wagerAmount } = req.body || {};
    let validated = null;

    if (validationId) {
      const record = validations.get(validationId);
      if (!record) return res.status(400).json({ error: "validation expired or not found" });
      if (record.expiresAt < Date.now()) {
        validations.delete(validationId);
        return res.status(400).json({ error: "validation expired" });
      }
      const payloadCheck = resolveAmounts({ amount: req.body?.amount, totalAmount, serviceFeeAmount, wagerAmount });
      if (payloadCheck.error) return res.status(400).json({ error: payloadCheck.error });
      const matches =
        record.user === req.body?.user &&
        record.masterpieceId === Number(req.body?.masterpieceId) &&
        record.position === Number(req.body?.position) &&
        record.pickedUid === req.body?.pickedUid &&
        record.wagerAmount === payloadCheck.wagerAmount &&
        record.totalAmount === payloadCheck.totalAmount &&
        record.serviceFeeAmount === payloadCheck.serviceFeeAmount;
      if (!matches) return res.status(400).json({ error: "validation payload mismatch" });
      validated = { ...record, ...payloadCheck };
      validations.delete(validationId);
    } else {
      validated = await validateBetPayload(req.body);
      if (validated.error) return res.status(400).json({ error: validated.error });
    }

    const bet = {
      id: newId(),
      user: validated.user,
      masterpieceId: validated.masterpieceId,
      position: validated.position,
      pickedUid: validated.pickedUid,
      pickedName: validated.pickedName,
      amount: validated.wagerAmount,
      wagerAmount: validated.wagerAmount,
      totalAmount: validated.totalAmount,
      serviceFeeAmount: validated.serviceFeeAmount,
      walletAddress: walletAddress || null,
      escrowTx: escrowTx || null,
      feeTx: feeTx || null,
      createdAt: new Date().toISOString(),
      futureBet: validated.futureBet,
    };

    store.bets.push(bet);
    if (bet.walletAddress) {
      attachBetToWallet(bet.walletAddress, bet.id);
    }
    persist();

    res.json({ ok: true, bet });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/bets/pending", async (req, res) => {
  try {
    const { validationId, totalAmount, serviceFeeAmount, wagerAmount } = req.body || {};
    let validated = null;

    if (validationId) {
      const record = validations.get(validationId);
      if (!record) return res.status(400).json({ error: "validation expired or not found" });
      if (record.expiresAt < Date.now()) {
        validations.delete(validationId);
        return res.status(400).json({ error: "validation expired" });
      }
      const payloadCheck = resolveAmounts({ amount: req.body?.amount, totalAmount, serviceFeeAmount, wagerAmount });
      if (payloadCheck.error) return res.status(400).json({ error: payloadCheck.error });
      const matches =
        record.user === req.body?.user &&
        record.masterpieceId === Number(req.body?.masterpieceId) &&
        record.position === Number(req.body?.position) &&
        record.pickedUid === req.body?.pickedUid &&
        record.wagerAmount === payloadCheck.wagerAmount &&
        record.totalAmount === payloadCheck.totalAmount &&
        record.serviceFeeAmount === payloadCheck.serviceFeeAmount;
      if (!matches) return res.status(400).json({ error: "validation payload mismatch" });
      validated = { ...record, ...payloadCheck };
      validations.delete(validationId);
    } else {
      validated = await validateBetPayload(req.body);
      if (validated.error) return res.status(400).json({ error: validated.error });
    }

    const pendingBet = {
      id: newId(),
      user: validated.user,
      masterpieceId: validated.masterpieceId,
      position: validated.position,
      pickedUid: validated.pickedUid,
      pickedName: validated.pickedName,
      amount: validated.wagerAmount,
      wagerAmount: validated.wagerAmount,
      totalAmount: validated.totalAmount,
      serviceFeeAmount: validated.serviceFeeAmount,
      createdAt: new Date().toISOString(),
      futureBet: validated.futureBet,
    };

    store.pendingBets.push(pendingBet);
    persist();

    res.json({ ok: true, pendingId: pendingBet.id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/bets/confirm", async (req, res) => {
  try {
    const { pendingId, walletAddress, escrowTx, feeTx } = req.body || {};
    if (!pendingId) return res.status(400).json({ error: "pendingId required" });

    const idx = store.pendingBets.findIndex((b) => b.id === pendingId);
    if (idx === -1) return res.status(400).json({ error: "pending bet not found" });

    const pendingBet = store.pendingBets[idx];
    const bet = {
      ...pendingBet,
      walletAddress: walletAddress || null,
      escrowTx: escrowTx || null,
      feeTx: feeTx || null,
    };

    store.pendingBets.splice(idx, 1);
    store.bets.push(bet);
    if (bet.walletAddress) {
      attachBetToWallet(bet.walletAddress, bet.id);
    }
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
  if (walletAddress) out = out.filter((b) => (b.walletAddress || "").toLowerCase() === walletAddress);

  res.json({ ok: true, bets: out });
});

app.post("/api/settle/:masterpieceId", async (req, res) => {
  try {
    const mpId = Number(req.params.masterpieceId);
    if (!Number.isInteger(mpId)) return res.status(400).json({ error: "invalid masterpieceId" });

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

    res.json({
      ok: true,
      masterpieceId: mpId,
      masterpieceName: mp.name,
      carryover: store.carryover,
      house: store.house,
      results,
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
