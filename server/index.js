import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import express from "express";
import jwt from "jsonwebtoken";
import { Contract, JsonRpcProvider, Wallet, parseUnits, verifyMessage } from "ethers";
import { makeStore, newId, settleMarket } from "./betting.js";
import { getOrCreateUser, prisma } from "./db.js";
import {
  buildBlackjackSessionBetId,
  getVaultReadContract,
  safeGetAvailableBalance,
} from "./lib/vaultLedger.js";
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
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS || "";
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY || "";
const DYNW_DECIMALS = 18;
const BLACKJACK_TABLE_MIN_BET_WEI = process.env.BLACKJACK_MIN_BET_WEI
  ? BigInt(process.env.BLACKJACK_MIN_BET_WEI)
  : parseUnits("25", DYNW_DECIMALS);
const BLACKJACK_DECKS = 6;
const OUTCOME_WIN = 1;
const OUTCOME_LOSE = 2;
const VAULT_LEDGER_ABI = [
  "function placeBet(bytes32 betId, address token, uint256 amount)",
  "function settleBet(bytes32 betId, address token, uint256 totalAmount, uint8 outcome, address[] participants)",
  "function getAvailableBalance(address token, address owner) view returns (uint256)",
  "function getLockedBalance(address token, address owner) view returns (uint256)",
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

function parseWeiString(value, { allowZero = false } = {}) {
  value = coerceSerializedValue(value);
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return { error: "amountWei must be a string integer" };
  }
  const amountWei = BigInt(value);
  if (!allowZero && amountWei <= 0n) return { error: "amountWei must be positive" };
  return { ok: true, amountWei };
}

function serializeBlackjackSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    walletAddress: session.walletAddress,
    seatId: session.seatId,
    buyInAmountWei: session.buyInAmountWei,
    bankrollWei: session.bankrollWei,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function serializeBlackjackHand(hand) {
  if (!hand) return null;
  return {
    id: hand.id,
    sessionId: hand.sessionId,
    betAmountWei: hand.betAmountWei,
    stateJson: hand.stateJson,
    outcome: hand.outcome,
    payoutWei: hand.payoutWei,
    createdAt: hand.createdAt,
  };
}

const BLACKJACK_SEAT_COUNT = 5;
const BLACKJACK_SHOE_MIN_REMAINING = 20;

function shuffleInPlace(cards) {
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function buildShoe(decks = BLACKJACK_DECKS) {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const cards = [];
  for (let d = 0; d < decks; d += 1) {
    for (const suit of suits) {
      for (const rank of ranks) {
        cards.push(`${rank}${suit}`);
      }
    }
  }
  return shuffleInPlace(cards);
}

function cardRank(card) {
  return card.slice(0, -1);
}

function cardValue(rank) {
  if (rank === "A") return 11;
  if (["K", "Q", "J"].includes(rank)) return 10;
  const value = Number(rank);
  return Number.isNaN(value) ? 0 : value;
}

function getHandTotals(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    const rank = cardRank(card);
    total += cardValue(rank);
    if (rank === "A") aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  const soft = aces > 0;
  return { total, soft };
}

function isBlackjack(cards) {
  return cards.length === 2 && getHandTotals(cards).total === 21;
}

function shouldDealerHit(cards) {
  const totals = getHandTotals(cards);
  if (totals.total < 17) return true;
  if (totals.total === 17 && totals.soft) return true;
  return false;
}

function drawCard(state) {
  if (state.shoeIndex >= state.shoe.length) {
    throw new Error("Shoe is empty");
  }
  const card = state.shoe[state.shoeIndex];
  state.shoeIndex += 1;
  return card;
}

function getPlayerState(cards) {
  const totals = getHandTotals(cards);
  if (totals.total > 21) return "bust";
  if (isBlackjack(cards)) return "blackjack";
  if (totals.total === 21) return "stood";
  return "playing";
}

function resolveHand(state, betAmountWei) {
  const betWei = BigInt(betAmountWei);
  const playerBlackjack = isBlackjack(state.playerCards);
  const dealerBlackjack = isBlackjack(state.dealerCards);

  if (state.playerState === "surrendered") {
    return { outcome: "SURRENDER", payoutWei: -(betWei / 2n), state: { ...state, phase: "complete" } };
  }

  if (state.playerState === "bust") {
    return { outcome: "BUST", payoutWei: -betWei, state: { ...state, phase: "complete" } };
  }

  if (dealerBlackjack && !playerBlackjack) {
    return { outcome: "DEALER_WIN", payoutWei: -betWei, state: { ...state, phase: "complete" } };
  }

  if (playerBlackjack && !dealerBlackjack) {
    return { outcome: "BLACKJACK", payoutWei: (betWei * 3n) / 2n, state: { ...state, phase: "complete" } };
  }

  if (playerBlackjack && dealerBlackjack) {
    return { outcome: "PUSH", payoutWei: 0n, state: { ...state, phase: "complete" } };
  }

  if (state.phase === "dealer") {
    while (shouldDealerHit(state.dealerCards)) {
      state.dealerCards.push(drawCard(state));
    }
  }

  const playerTotals = getHandTotals(state.playerCards);
  const dealerTotals = getHandTotals(state.dealerCards);

  if (dealerTotals.total > 21) {
    return { outcome: "PLAYER_WIN", payoutWei: betWei, state: { ...state, phase: "complete" } };
  }
  if (playerTotals.total > dealerTotals.total) {
    return { outcome: "PLAYER_WIN", payoutWei: betWei, state: { ...state, phase: "complete" } };
  }
  if (playerTotals.total < dealerTotals.total) {
    return { outcome: "DEALER_WIN", payoutWei: -betWei, state: { ...state, phase: "complete" } };
  }
  return { outcome: "PUSH", payoutWei: 0n, state: { ...state, phase: "complete" } };
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


app.get("/api/blackjack/session", requireAuth, async (req, res) => {
  try {
    const walletAddress = normalizeWallet(req.user?.loginAddress);
    if (!walletAddress) return res.status(403).json({ error: "walletAddress required" });
    const session = await prisma.blackjackSession.findFirst({
      where: { walletAddress, status: "OPEN" },
      orderBy: { createdAt: "desc" },
    });
    if (!session) return res.json({ ok: true, session: null, hand: null });
    const hand = await prisma.blackjackHand.findFirst({
      where: { sessionId: session.id },
      orderBy: { createdAt: "desc" },
    });
    res.json({ ok: true, session: serializeBlackjackSession(session), hand: serializeBlackjackHand(hand) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/blackjack/buyin", requireAuth, async (req, res) => {
  try {
    const amountCheck = parseWeiString(req.body?.amountWei);
    if (amountCheck.error) return res.status(400).json({ error: amountCheck.error });
    const seatId = Number(req.body?.seatId);
    if (!Number.isInteger(seatId) || seatId < 0 || seatId >= BLACKJACK_SEAT_COUNT) {
      return res.status(400).json({ error: "seatId must be between 0 and 4" });
    }
    const walletAddress = normalizeWallet(req.user?.loginAddress);
    if (!walletAddress) return res.status(403).json({ error: "walletAddress required" });
    if (!vaultReadContract) {
      return res.status(500).json({ error: "VAULT_LEDGER_ADDRESS is not configured" });
    }
    const availableWei = await safeGetAvailableBalance(vaultReadContract, DYNW_TOKEN_ADDRESS, walletAddress);
    if (amountCheck.amountWei > availableWei) {
      return res.status(400).json({ error: "Buy-in exceeds vault balance" });
    }
    const session = await prisma.$transaction(async (tx) => {
      const existing = await tx.blackjackSession.findFirst({
        where: { walletAddress, status: "OPEN" },
      });
      if (existing) {
        throw new Error("Active blackjack session already open");
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
          buyInAmountWei: amountCheck.amountWei.toString(),
          bankrollWei: amountCheck.amountWei.toString(),
          status: "OPEN",
        },
      });
    });
    const betId = buildBlackjackSessionBetId(session.id);
    res.json({
      ok: true,
      session: serializeBlackjackSession(session),
      lock: { sessionId: session.id, seatId: session.seatId, amountWei: session.buyInAmountWei, betId },
    });
  } catch (e) {
    const message = String(e?.message || e);
    if (message.includes("Active blackjack session already open") || message.includes("Seat already occupied")) {
      return res.status(400).json({ error: message });
    }
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/blackjack/deal", requireAuth, async (req, res) => {
  try {
    const amountCheck = parseWeiString(req.body?.betAmountWei);
    if (amountCheck.error) return res.status(400).json({ error: amountCheck.error });
    if (amountCheck.amountWei < BLACKJACK_TABLE_MIN_BET_WEI) {
      return res.status(400).json({ error: "Wager below table minimum" });
    }
    const walletAddress = normalizeWallet(req.user?.loginAddress);
    if (!walletAddress) return res.status(403).json({ error: "walletAddress required" });
    const result = await prisma.$transaction(async (tx) => {
      const session = await tx.blackjackSession.findFirst({
        where: { walletAddress, status: "OPEN" },
        orderBy: { createdAt: "desc" },
      });
      if (!session) throw new Error("No active blackjack session");
      const bankrollWei = BigInt(session.bankrollWei);
      if (amountCheck.amountWei > bankrollWei) {
        throw new Error("Wager exceeds table bankroll");
      }
      const pendingHand = await tx.blackjackHand.findFirst({
        where: { sessionId: session.id, outcome: "PENDING" },
        orderBy: { createdAt: "desc" },
      });
      if (pendingHand) {
        throw new Error("Finish the current hand before dealing");
      }
      const lastHand = await tx.blackjackHand.findFirst({
        where: { sessionId: session.id },
        orderBy: { createdAt: "desc" },
      });
      const previousShoe = Array.isArray(lastHand?.stateJson?.shoe) ? [...lastHand.stateJson.shoe] : null;
      const previousIndex = Number.isInteger(lastHand?.stateJson?.shoeIndex) ? lastHand.stateJson.shoeIndex : 0;
      const needsShuffle =
        !previousShoe ||
        previousShoe.length - previousIndex < BLACKJACK_SHOE_MIN_REMAINING;
      const state = {
        shoe: needsShuffle ? buildShoe() : previousShoe,
        shoeIndex: needsShuffle ? 0 : previousIndex,
        playerCards: [],
        dealerCards: [],
        playerState: "playing",
        phase: "player",
      };
      state.playerCards.push(drawCard(state));
      state.dealerCards.push(drawCard(state));
      state.playerCards.push(drawCard(state));
      state.dealerCards.push(drawCard(state));
      state.playerState = getPlayerState(state.playerCards);
      if (state.playerState !== "playing" || isBlackjack(state.dealerCards)) {
        state.phase = "dealer";
      }
      let outcome = "PENDING";
      let payoutWei = 0n;
      if (state.phase !== "player") {
        const resolved = resolveHand(state, amountCheck.amountWei.toString());
        outcome = resolved.outcome;
        payoutWei = resolved.payoutWei;
        state.phase = resolved.state.phase;
        state.dealerCards = resolved.state.dealerCards;
        state.playerCards = resolved.state.playerCards;
        state.shoeIndex = resolved.state.shoeIndex;
      }
      const hand = await tx.blackjackHand.create({
        data: {
          sessionId: session.id,
          betAmountWei: amountCheck.amountWei.toString(),
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
      return { hand, session: updatedSession };
    });
    res.json({ ok: true, session: serializeBlackjackSession(result.session), hand: serializeBlackjackHand(result.hand) });
  } catch (e) {
    const message = String(e?.message || e);
    if (
      message.includes("Wager exceeds table bankroll") ||
      message.includes("Finish the current hand") ||
      message.includes("No active blackjack session")
    ) {
      return res.status(400).json({ error: message });
    }
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/blackjack/action", requireAuth, async (req, res) => {
  try {
    const action = String(req.body?.action || "").toLowerCase();
    if (!["hit", "stand", "double", "split", "surrender"].includes(action)) {
      return res.status(400).json({ error: "action invalid" });
    }
    const walletAddress = normalizeWallet(req.user?.loginAddress);
    if (!walletAddress) return res.status(403).json({ error: "walletAddress required" });
    const result = await prisma.$transaction(async (tx) => {
      const session = await tx.blackjackSession.findFirst({
        where: { walletAddress, status: "OPEN" },
        orderBy: { createdAt: "desc" },
      });
      if (!session) throw new Error("No active blackjack session");
      const hand = await tx.blackjackHand.findFirst({
        where: { sessionId: session.id, outcome: "PENDING" },
        orderBy: { createdAt: "desc" },
      });
      if (!hand || !hand.stateJson) {
        throw new Error("No active hand");
      }
      const state = {
        shoe: Array.isArray(hand.stateJson.shoe) ? [...hand.stateJson.shoe] : [],
        shoeIndex: Number.isInteger(hand.stateJson.shoeIndex) ? hand.stateJson.shoeIndex : 0,
        playerCards: Array.isArray(hand.stateJson.playerCards) ? [...hand.stateJson.playerCards] : [],
        dealerCards: Array.isArray(hand.stateJson.dealerCards) ? [...hand.stateJson.dealerCards] : [],
        playerState: hand.stateJson.playerState || "playing",
        phase: hand.stateJson.phase || "player",
      };
      if (state.phase !== "player") {
        throw new Error("Hand already resolved");
      }
      if (state.playerState !== "playing") {
        throw new Error("No playable hand");
      }

      let betAmountWei = BigInt(hand.betAmountWei);
      const bankrollWei = BigInt(session.bankrollWei);

      if (action === "split") {
        throw new Error("Split not supported yet");
      }

      if (action === "double") {
        if (state.playerCards.length !== 2) {
          throw new Error("Double not allowed");
        }
        const doubled = betAmountWei * 2n;
        if (doubled > bankrollWei) {
          throw new Error("Insufficient bankroll for double");
        }
        betAmountWei = doubled;
        state.playerCards.push(drawCard(state));
        state.playerState = getPlayerState(state.playerCards);
        if (state.playerState === "playing") {
          state.playerState = "stood";
        }
        state.phase = "dealer";
      }

      if (action === "surrender") {
        if (state.playerCards.length !== 2) {
          throw new Error("Surrender not allowed");
        }
        state.playerState = "surrendered";
        state.phase = "complete";
      }

      if (action === "hit") {
        state.playerCards.push(drawCard(state));
        state.playerState = getPlayerState(state.playerCards);
        if (state.playerState !== "playing") {
          state.phase = "dealer";
        }
      }

      if (action === "stand") {
        state.playerState = "stood";
        state.phase = "dealer";
      }

      let payoutWei = 0n;
      let outcome = "PENDING";
      if (state.phase !== "player") {
        const resolved = resolveHand(state, betAmountWei.toString());
        outcome = resolved.outcome;
        payoutWei = resolved.payoutWei;
        state.phase = resolved.state.phase;
        state.dealerCards = resolved.state.dealerCards;
        state.playerCards = resolved.state.playerCards;
        state.shoeIndex = resolved.state.shoeIndex;
      }

      const updatedHand = await tx.blackjackHand.update({
        where: { id: hand.id },
        data: {
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
      return { hand: updatedHand, session: updatedSession };
    });
    res.json({ ok: true, session: serializeBlackjackSession(result.session), hand: serializeBlackjackHand(result.hand) });
  } catch (e) {
    const message = String(e?.message || e);
    if (
      message.includes("No active blackjack session") ||
      message.includes("No active hand") ||
      message.includes("Double not allowed") ||
      message.includes("Surrender not allowed") ||
      message.includes("Split not supported") ||
      message.includes("Insufficient bankroll") ||
      message.includes("Hand already resolved") ||
      message.includes("No playable hand") ||
      message.includes("Shoe is empty")
    ) {
      return res.status(400).json({ error: message });
    }
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/blackjack/leave", requireAuth, async (req, res) => {
  try {
    const walletAddress = normalizeWallet(req.user?.loginAddress);
    if (!walletAddress) return res.status(403).json({ error: "walletAddress required" });
    const session = await prisma.blackjackSession.findFirst({
      where: { walletAddress, status: "OPEN" },
      orderBy: { createdAt: "desc" },
    });
    if (!session) return res.status(400).json({ error: "No open blackjack session" });
    const pendingHand = await prisma.blackjackHand.findFirst({
      where: { sessionId: session.id, outcome: "PENDING" },
    });
    if (pendingHand) {
      return res.status(400).json({ error: "Finish the current hand before leaving" });
    }
    const betId = buildBlackjackSessionBetId(session.id);
    const buyInWei = BigInt(session.buyInAmountWei);
    const bankrollWei = BigInt(session.bankrollWei);
    const netPnlWei = bankrollWei - buyInWei;
    let txHash = "skipped";
    if (!vaultContract || !operatorSigner) {
      console.warn("Vault not configured for blackjack settlement.");
    } else {
      const stake = await fetchVaultBetStake(betId, walletAddress);
      const stakeWei = BigInt(stake);
      if (stakeWei < buyInWei) {
        return res.status(400).json({ error: "Vault stake does not match buy-in" });
      }
      if (netPnlWei > 0n) {
        const treasuryAddress = normalizeWallet(TREASURY_ADDRESS);
        if (!vaultReadContract || !treasuryAddress) {
          return res.status(500).json({ error: "Treasury address is not configured" });
        }
        const treasuryAvailableWei = await safeGetAvailableBalance(
          vaultReadContract,
          DYNW_TOKEN_ADDRESS,
          treasuryAddress,
        );
        if (treasuryAvailableWei < netPnlWei) {
          console.warn("Treasury available insufficient", {
            treasuryAddress,
            treasuryAvailableWei: treasuryAvailableWei.toString(),
            netPnlWei: netPnlWei.toString(),
          });
          return res.status(400).json({ error: "House bankroll insufficient; treasury needs funding." });
        }
        const tx = await vaultContract.settleBet(
          betId,
          DYNW_TOKEN_ADDRESS,
          netPnlWei,
          OUTCOME_WIN,
          [walletAddress],
        );
        await tx.wait();
        txHash = tx.hash;
      } else if (netPnlWei < 0n) {
        const tx = await vaultContract.settleBet(
          betId,
          DYNW_TOKEN_ADDRESS,
          -netPnlWei,
          OUTCOME_LOSE,
          [walletAddress],
        );
        await tx.wait();
        txHash = tx.hash;
      }
    }
    const closedSession = await prisma.blackjackSession.update({
      where: { id: session.id },
      data: { status: "CLOSED" },
    });
    res.json({
      ok: true,
      session: serializeBlackjackSession(closedSession),
      settlement: {
        betId,
        txHash,
        netDeltaWei: netPnlWei.toString(),
        payoutWei: bankrollWei.toString(),
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
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
      for (const participant of participants) {
        const stake = stakes.get(participant) || 0;
        const payout = Number(result.payouts?.[participant] || 0);
        const stakeWei = parseUnits(String(stake), DYNW_DECIMALS);
        const payoutWei = parseUnits(String(payout), DYNW_DECIMALS);
        const netPnlWei = payoutWei - stakeWei;
        if (netPnlWei === 0n) {
          continue;
        }
        const [outcome, amount] =
          netPnlWei > 0n ? [OUTCOME_WIN, netPnlWei] : [OUTCOME_LOSE, -netPnlWei];
        const tx = await vaultContract.settleBet(
          betId,
          DYNW_TOKEN_ADDRESS,
          amount,
          outcome,
          [participant],
        );
        const receipt = await tx.wait();
        settlementReceipts.push({ betId, txHash: tx.hash, status: receipt?.status ?? null });
      }
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
