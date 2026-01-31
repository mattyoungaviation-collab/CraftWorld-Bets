export const CRASH_PHASES = {
  BETTING: "BETTING",
  RUNNING: "RUNNING",
  CRASHED: "CRASHED",
  COOLDOWN: "COOLDOWN",
};

export function createRoundState({
  roundNumber,
  roundId,
  commitHash,
  serverSeed,
  crashPoint,
  crashPointDisplay,
  derivedHash,
  u,
  uString,
  bettingMs,
}) {
  const now = Date.now();
  return {
    roundNumber,
    roundId,
    commitHash,
    serverSeed,
    crashPoint,
    crashPointDisplay,
    derivedHash,
    u,
    uString,
    phase: CRASH_PHASES.BETTING,
    createdAt: now,
    bettingClosesAt: now + bettingMs,
    runningStartedAt: null,
    crashedAt: null,
    cooldownEndsAt: null,
    currentMultiplier: 0.5,
    bets: new Map(),
  };
}

export function serializeBets(bets) {
  return Array.from(bets.values()).map((bet) => ({
    address: bet.address,
    amount: bet.amount,
    amountWei: bet.amountWei.toString(),
    placedAt: bet.placedAt,
    cashedOut: bet.cashedOut,
    cashoutMultiplier: bet.cashoutMultiplier ?? null,
    payout: bet.payout ?? null,
    payoutWei: bet.payoutWei ? bet.payoutWei.toString() : null,
  }));
}

export function buildPublicState(round) {
  if (!round) {
    return {
      phase: CRASH_PHASES.COOLDOWN,
      roundId: null,
    };
  }
  return {
    phase: round.phase,
    roundId: round.roundId,
    roundNumber: round.roundNumber,
    commitHash: round.commitHash,
    serverSeed: round.phase === CRASH_PHASES.CRASHED ? round.serverSeed : null,
    crashPoint: round.phase === CRASH_PHASES.CRASHED ? round.crashPointDisplay : null,
    crashPointRaw: round.phase === CRASH_PHASES.CRASHED ? round.crashPoint : null,
    derivedHash: round.phase === CRASH_PHASES.CRASHED ? round.derivedHash : null,
    u: round.phase === CRASH_PHASES.CRASHED ? round.uString : null,
    bettingClosesAt: round.bettingClosesAt,
    runningStartedAt: round.runningStartedAt,
    crashedAt: round.crashedAt,
    cooldownEndsAt: round.cooldownEndsAt,
    currentMultiplier: round.currentMultiplier,
    bets: serializeBets(round.bets),
  };
}
