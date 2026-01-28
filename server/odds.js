export function computeModelOdds(historyByMp, options = {}) {
  const { lambda = 0.35, tau = 0.9, k = 3, usePoints = true } = options;

  const mps = Object.entries(historyByMp || {})
    .map(([mpId, mp]) => ({ mpId, ...mp }))
    .sort((a, b) => new Date(a.endedAt).valueOf() - new Date(b.endedAt).valueOf());

  const playersSet = new Set();
  for (const mp of mps) {
    for (const r of mp.results || []) {
      if (r?.player) playersSet.add(r.player);
    }
  }
  const players = Array.from(playersSet);

  let baselineSum = 0;
  let baselineN = 0;
  for (const mp of mps) {
    for (const r of mp.results || []) {
      const placeScore = 1 / Math.sqrt(Math.max(1, r.position));
      baselineSum += placeScore;
      baselineN += 1;
    }
  }
  const baseline = baselineN ? baselineSum / baselineN : 0.25;

  const strength = Object.fromEntries(players.map((p) => [p, 0]));
  const totalEvents = mps.length;

  for (let idx = 0; idx < mps.length; idx += 1) {
    const mp = mps[idx];
    const age = Math.max(0, totalEvents - 1 - idx);
    const weight = Math.exp(-lambda * age);

    for (const r of mp.results || []) {
      if (!r?.player) continue;
      const placeScore = 1 / Math.sqrt(Math.max(1, r.position));
      let pointsScore = 0;
      if (usePoints && typeof r.points === "number") {
        pointsScore = Math.log(1 + Math.max(0, r.points)) / 20;
      }
      strength[r.player] += weight * (placeScore + pointsScore);
    }
  }

  for (const player of players) {
    strength[player] = strength[player] + k * baseline;
  }

  const expVals = players.map((player) => Math.exp(strength[player] / tau));
  const total = expVals.reduce((sum, val) => sum + val, 0) || 1;

  const probs = Object.fromEntries(players.map((player, idx) => [player, expVals[idx] / total]));
  const odds = Object.fromEntries(
    players.map((player) => {
      const probability = Math.max(1e-9, probs[player] || 0);
      return [player, 1 / probability];
    })
  );

  return { probs, odds, strength };
}
