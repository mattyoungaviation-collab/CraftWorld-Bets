import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { makeStore, newId, settleMarket } from "./betting.js";

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
const dataDir = path.join(__dirname, "data");
const { store, persist } = makeStore(dataDir);

// ---- Craft World GraphQL ----
const GRAPHQL_URL = "https://craft-world.gg/graphql";
const SERVICE_FEE_BPS = 500;
const VALIDATION_TTL_MS = 5 * 60 * 1000;
const validations = new Map();

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
    persist();

    res.json({ ok: true, bet });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/bets", (req, res) => {
  const mpId = req.query.masterpieceId ? Number(req.query.masterpieceId) : null;
  const position = req.query.position ? Number(req.query.position) : null;

  let out = store.bets;

  if (Number.isInteger(mpId)) out = out.filter((b) => b.masterpieceId === mpId);
  if ([1, 2, 3].includes(position)) out = out.filter((b) => b.position === position);

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
