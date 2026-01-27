import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { makeStore, newId, settleMarket } from "./betting.js";

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- persistence store ----
const dataDir = path.join(__dirname, "data");
const { store, persist } = makeStore(dataDir);

// ---- Craft World GraphQL ----
const GRAPHQL_URL = "https://craft-world.gg/graphql";

const MASTERPIECE_QUERY = `
  query Masterpiece($id: ID) {
    masterpiece(id: $id) {
      id
      name
      type
      collectedPoints
      requiredPoints
      startedAt
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

app.post("/api/bets", async (req, res) => {
  try {
    const { user, masterpieceId, position, pickedUid, amount, futureBet } = req.body || {};

    if (!user || typeof user !== "string") return res.status(400).json({ error: "user required" });

    const mpId = Number(masterpieceId);
    if (!Number.isInteger(mpId)) return res.status(400).json({ error: "masterpieceId must be integer" });

    const pos = Number(position);
    if (![1, 2, 3].includes(pos)) return res.status(400).json({ error: "position must be 1, 2, or 3" });

    if (!pickedUid || typeof pickedUid !== "string") return res.status(400).json({ error: "pickedUid required" });

    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt <= 0) return res.status(400).json({ error: "amount must be a positive integer" });

    let pickedName = pickedUid;
    let isClosed = false;

    try {
      const mpJson = await fetchMasterpiece(mpId);
      const mp = mpJson?.data?.masterpiece;
      if (mp?.collectedPoints >= mp?.requiredPoints) isClosed = true;
      const leaderboard = mp?.leaderboard || [];

      if (!futureBet) {
        const pickedRow = leaderboard.find((r) => r?.profile?.uid === pickedUid);
        if (!pickedRow) return res.status(400).json({ error: "pickedUid not found in current leaderboard" });
        pickedName = pickedRow?.profile?.displayName || pickedUid;
      }
    } catch (e) {
      if (!futureBet) return res.status(500).json({ error: "masterpiece lookup failed" });
    }

    if (isClosed) return res.status(400).json({ error: "betting is closed for this masterpiece" });

    const bet = {
      id: newId(),
      user,
      masterpieceId: mpId,
      position: pos,
      pickedUid,
      pickedName,
      amount: amt,
      createdAt: new Date().toISOString(),
      futureBet: Boolean(futureBet),
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

// ---- Serve built frontend ONLY in production ----
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "..", "dist")));

  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "dist", "index.html"));
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
