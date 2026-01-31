import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { id as keccakId } from "ethers";
import { buildCommitHash, computeCrashPoint, generateServerSeed } from "./fairness.js";
import { buildPublicState, CRASH_PHASES, createRoundState, serializeBets } from "./state.js";

function clampMultiplier(value) {
  return Math.min(50, Math.max(0.5, value));
}

function computeMultiplier(elapsedMs) {
  const t = elapsedMs / 1000;
  const raw = 0.5 * Math.exp(t / 6);
  return clampMultiplier(raw);
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export class CrashEngine extends EventEmitter {
  constructor({
    io,
    dataDir,
    bettingMs,
    cooldownMs,
    houseEdgeBps,
    logger,
    settleLoser,
  }) {
    super();
    this.io = io;
    this.dataDir = dataDir;
    this.bettingMs = bettingMs;
    this.cooldownMs = cooldownMs;
    this.houseEdgeBps = houseEdgeBps;
    this.logger = logger;
    this.settleLoser = settleLoser;
    this.roundNumber = 0;
    this.round = null;
    this.tickTimer = null;
    this.cooldownTimer = null;
    this.historyPath = path.join(dataDir, "crash_history.json");
    this.history = [];
    this.loadHistory();
  }

  loadHistory() {
    try {
      if (!fs.existsSync(this.historyPath)) return;
      const raw = fs.readFileSync(this.historyPath, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        this.history = data;
      }
    } catch (error) {
      this.logger?.error?.("Failed to load crash history", error);
    }
  }

  saveHistory() {
    try {
      ensureDir(this.historyPath);
      fs.writeFileSync(this.historyPath, JSON.stringify(this.history.slice(-50), null, 2));
    } catch (error) {
      this.logger?.error?.("Failed to save crash history", error);
    }
  }

  start() {
    this.startNewRound();
  }

  getRoundBetId() {
    return keccakId(`crash:${this.roundNumber}`);
  }

  startNewRound() {
    this.roundNumber += 1;
    const roundId = `crash-${this.roundNumber}`;
    const serverSeed = generateServerSeed();
    const commitHash = buildCommitHash(serverSeed);
    const fairness = computeCrashPoint({
      serverSeed,
      roundId,
      houseEdgeBps: this.houseEdgeBps,
    });

    this.round = createRoundState({
      roundNumber: this.roundNumber,
      roundId,
      commitHash,
      serverSeed,
      crashPoint: fairness.crashPoint,
      crashPointDisplay: fairness.crashPointDisplay,
      derivedHash: fairness.derivedHash,
      u: fairness.u,
      uString: fairness.uString,
      bettingMs: this.bettingMs,
    });

    const startsAt = this.round.createdAt;
    this.emitState();
    this.io?.emit("crash:newRound", {
      roundId: this.round.roundId,
      commitHash: this.round.commitHash,
      startsAt,
      bettingClosesAt: this.round.bettingClosesAt,
    });

    setTimeout(() => this.startRunning(), this.bettingMs);
  }

  startRunning() {
    if (!this.round || this.round.phase !== CRASH_PHASES.BETTING) return;
    this.round.phase = CRASH_PHASES.RUNNING;
    this.round.runningStartedAt = Date.now();
    this.round.currentMultiplier = 0.5;
    this.emitState();

    this.tickTimer = setInterval(() => {
      if (!this.round || this.round.phase !== CRASH_PHASES.RUNNING) return;
      const elapsed = Date.now() - (this.round.runningStartedAt || Date.now());
      const multiplier = computeMultiplier(elapsed);
      this.round.currentMultiplier = multiplier;
      this.io?.emit("crash:tick", { multiplier });
      if (multiplier >= this.round.crashPoint) {
        this.handleCrash();
      }
    }, 50);
  }

  async handleCrash() {
    if (!this.round || this.round.phase !== CRASH_PHASES.RUNNING) return;
    this.round.phase = CRASH_PHASES.CRASHED;
    this.round.crashedAt = Date.now();
    this.round.currentMultiplier = this.round.crashPoint;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    const verify = {
      roundId: this.round.roundId,
      commitHash: this.round.commitHash,
      serverSeed: this.round.serverSeed,
      derivedHash: this.round.derivedHash,
      u: this.round.uString,
      crashPoint: this.round.crashPoint,
    };

    this.io?.emit("crash:crash", {
      crashPoint: this.round.crashPointDisplay,
      serverSeed: this.round.serverSeed,
      commitHash: this.round.commitHash,
      verify,
    });

    await this.settleLosers();

    this.history.push({
      roundId: this.round.roundId,
      roundNumber: this.round.roundNumber,
      commitHash: this.round.commitHash,
      serverSeed: this.round.serverSeed,
      crashPoint: this.round.crashPoint,
      crashPointDisplay: this.round.crashPointDisplay,
      startedAt: new Date(this.round.createdAt).toISOString(),
      crashedAt: this.round.crashedAt ? new Date(this.round.crashedAt).toISOString() : null,
      bets: serializeBets(this.round.bets),
    });
    this.saveHistory();

    this.round.phase = CRASH_PHASES.COOLDOWN;
    this.round.cooldownEndsAt = Date.now() + this.cooldownMs;
    this.emitState();

    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
    }
    this.cooldownTimer = setTimeout(() => this.startNewRound(), this.cooldownMs);
  }

  async settleLosers() {
    if (!this.round) return;
    const losers = Array.from(this.round.bets.values()).filter((bet) => !bet.cashedOut);
    for (const bet of losers) {
      try {
        await this.settleLoser?.(bet, this.round);
      } catch (error) {
        this.logger?.error?.("Failed to settle crash loser", error);
      }
    }
  }

  emitState() {
    this.io?.emit("crash:state", buildPublicState(this.round));
  }

  getPublicState() {
    return buildPublicState(this.round);
  }

  canBet(address) {
    if (!this.round || this.round.phase !== CRASH_PHASES.BETTING) return false;
    return !this.round.bets.has(address);
  }

  registerBet({ address, amount, amountWei }) {
    if (!this.round) throw new Error("Round not available");
    if (this.round.phase !== CRASH_PHASES.BETTING) throw new Error("Betting is closed");
    if (this.round.bets.has(address)) throw new Error("Bet already placed this round");

    const bet = {
      address,
      amount,
      amountWei,
      placedAt: Date.now(),
      cashedOut: false,
      cashoutMultiplier: null,
      payout: null,
      payoutWei: null,
    };
    this.round.bets.set(address, bet);
    this.io?.emit("crash:bet", {
      address: bet.address,
      amount: bet.amount,
      amountWei: bet.amountWei.toString(),
      placedAt: bet.placedAt,
    });
    return bet;
  }

  registerCashout({ address, multiplier, payout, payoutWei }) {
    if (!this.round) throw new Error("Round not available");
    const bet = this.round.bets.get(address);
    if (!bet) throw new Error("No active bet");
    if (bet.cashedOut) throw new Error("Already cashed out");
    if (this.round.phase !== CRASH_PHASES.RUNNING) throw new Error("Cashout not available");

    bet.cashedOut = true;
    bet.cashoutMultiplier = multiplier;
    bet.payout = payout;
    bet.payoutWei = payoutWei;

    this.io?.emit("crash:cashout", {
      address: bet.address,
      multiplier,
      payout,
    });
    return bet;
  }

  getHistory() {
    return this.history.slice(-50);
  }

  logRoundState() {
    if (!this.round) return null;
    return {
      roundId: this.round.roundId,
      phase: this.round.phase,
      commitHash: this.round.commitHash,
      crashPoint: this.round.crashPoint,
      currentMultiplier: this.round.currentMultiplier,
      updatedAt: nowIso(),
    };
  }
}
