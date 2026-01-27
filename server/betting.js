// server/betting.js
import fs from "fs";
import path from "path";
import crypto from "crypto";

export function makeStore(dataDir) {
  const betsPath = path.join(dataDir, "bets.json");
  const resultsPath = path.join(dataDir, "results.json");
  const carryPath = path.join(dataDir, "carryover.json");
  const housePath = path.join(dataDir, "house.json");
  const pendingPath = path.join(dataDir, "pending.json");
  const walletsPath = path.join(dataDir, "wallets.json");

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      return fallback;
    }
  }

  function writeJson(file, obj) {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf-8");
  }

  const store = {
    bets: readJson(betsPath, []),
    pendingBets: readJson(pendingPath, []),
    results: readJson(resultsPath, {}),
    carryover: readJson(carryPath, { "1": 0, "2": 0, "3": 0 }),
    house: readJson(housePath, { total: 0, byMasterpiece: {} }),
    wallets: readJson(walletsPath, {}),
  };

  function persist() {
    writeJson(betsPath, store.bets);
    writeJson(pendingPath, store.pendingBets);
    writeJson(resultsPath, store.results);
    writeJson(carryPath, store.carryover);
    writeJson(housePath, store.house);
    writeJson(walletsPath, store.wallets);
  }

  return { store, persist };
}

export function normalizeName(s) {
  return (s || "").trim().toLowerCase();
}

export function newId() {
  return crypto.randomUUID?.() ?? crypto.randomBytes(16).toString("hex");
}

export function settleMarket({ masterpieceId, position, bets, winnerUid, winnerName }) {
  const marketBets = bets.filter(
    (b) => b.masterpieceId === masterpieceId && b.position === position && b.amount > 0
  );

  const pot = marketBets.reduce((sum, b) => sum + b.amount, 0);

  if (pot === 0) {
    return {
      masterpieceId,
      position,
      pot: 0,
      winnerUid,
      winnerName,
      status: "PAID",
      houseTake: 0,
      carryover: 0,
      payouts: {},
    };
  }

  const isWinner = (b) => {
    if (winnerUid && b.pickedUid) return b.pickedUid === winnerUid;
    if (winnerName) return normalizeName(b.pickedName) === normalizeName(winnerName);
    return false;
  };

  const winningBets = marketBets.filter(isWinner);
  const sTotal = winningBets.reduce((sum, b) => sum + b.amount, 0);

  // NO WINNERS: house keeps half, remainder carryover
  if (sTotal === 0) {
    const houseTake = Math.floor(pot * 0.5);
    const carryover = pot - houseTake;

    return {
      masterpieceId,
      position,
      pot,
      winnerUid,
      winnerName,
      status: "NO_WINNERS",
      houseTake,
      carryover,
      payouts: {},
    };
  }

  // WINNERS EXIST: pro-rata payouts (with rounding)
  const userStake = {};
  for (const b of winningBets) userStake[b.user] = (userStake[b.user] || 0) + b.amount;

  const payouts = {};
  let paidSum = 0;

  for (const [user, stake] of Object.entries(userStake)) {
    const raw = (pot * stake) / sTotal;
    const paid = Math.floor(raw);
    payouts[user] = paid;
    paidSum += paid;
  }

  // distribute remainder by largest stake
  let remainder = pot - paidSum;
  if (remainder > 0) {
    const winnersSorted = Object.entries(userStake)
      .sort((a, b) => b[1] - a[1])
      .map(([user]) => user);

    let i = 0;
    while (remainder > 0 && winnersSorted.length > 0) {
      const u = winnersSorted[i % winnersSorted.length];
      payouts[u] += 1;
      remainder -= 1;
      i += 1;
    }
  }

  return {
    masterpieceId,
    position,
    pot,
    winnerUid,
    winnerName,
    status: "PAID",
    houseTake: 0,
    carryover: 0,
    payouts,
  };
}
