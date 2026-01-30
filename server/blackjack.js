import fs from "fs";

const BLACKJACK_DECKS = 6;
const BLACKJACK_MIN_BET = 25;
const BLACKJACK_SEATS = 5;
const MAX_LOG_ENTRIES = 6;
const TURN_TIME_MS = 15000;
const ROUND_COOLDOWN_MS = 30000;
const MAX_SPLIT_HANDS = 2;

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildShoe(decks = BLACKJACK_DECKS) {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const cards = [];
  for (let d = 0; d < decks; d += 1) {
    for (const suit of suits) {
      for (const rank of ranks) {
        let value = Number(rank);
        if (Number.isNaN(value)) {
          value = rank === "A" ? 11 : 10;
        }
        cards.push({ rank, suit, value });
      }
    }
  }
  return shuffle(cards);
}

function createSeat(index) {
  return {
    id: index,
    name: "",
    walletAddress: null,
    bankroll: 0,
    bet: BLACKJACK_MIN_BET,
    pendingBetId: null,
    pendingBetAmount: 0,
    pendingBetAmountWei: null,
    pendingBetRoundId: null,
    activeBetId: null,
    activeBetRoundId: null,
    activeBetAmountWei: null,
    readyForNextRound: false,
    hands: [],
    handStatuses: [],
    handSplits: [],
    bets: [],
    activeHand: 0,
    status: "empty",
    pendingLeave: false,
    joined: false,
    lastOutcomes: [],
    lastPayout: 0,
  };
}

function createSeats() {
  return Array.from({ length: BLACKJACK_SEATS }, (_, index) => createSeat(index));
}

function getHandTotals(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    total += card.value;
    if (card.rank === "A") aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  const isSoft = cards.some((card) => card.rank === "A") && total <= 21 && cards.reduce((sum, c) => sum + c.value, 0) !== total;
  return { total, isSoft, isBust: total > 21 };
}

function isBlackjack(cards) {
  if (cards.length !== 2) return false;
  return getHandTotals(cards).total === 21;
}

function touch(state) {
  state.updatedAt = new Date().toISOString();
}

function appendLog(state, message) {
  state.log = [message, ...(state.log || [])].slice(0, MAX_LOG_ENTRIES);
}

function setTurnDeadline(state) {
  if (state.phase !== "player" || state.activeSeat === null) {
    state.turnExpiresAt = null;
    return;
  }
  state.turnExpiresAt = Date.now() + TURN_TIME_MS;
}

function clearTurnDeadline(state) {
  state.turnExpiresAt = null;
}

function setCooldown(state) {
  state.cooldownExpiresAt = Date.now() + ROUND_COOLDOWN_MS;
}

function clearCooldown(state) {
  state.cooldownExpiresAt = null;
}

function getNextPlayableHandIndex(seat, startIndex = 0) {
  if (!seat?.handStatuses) return -1;
  for (let i = startIndex; i < seat.handStatuses.length; i += 1) {
    if (seat.handStatuses[i] === "playing") return i;
  }
  return -1;
}

function findNextActiveSeat(state, startIndex = 0) {
  for (let i = startIndex; i < state.seats.length; i += 1) {
    const seat = state.seats[i];
    if (!seat?.joined) continue;
    const handIndex = getNextPlayableHandIndex(seat, 0);
    if (handIndex !== -1) {
      return { seatIndex: i, handIndex };
    }
  }
  return null;
}

function updateSeatStatus(seat) {
  if (!seat.joined) return "empty";
  if (!seat.hands.length) return "waiting";
  if (seat.handStatuses.some((status) => status === "playing")) return "playing";
  if (seat.handStatuses.every((status) => status === "blackjack")) return "blackjack";
  return "done";
}

function drawCard(state) {
  return state.shoe.shift();
}

function advanceTurn(state) {
  const currentSeatIndex = state.activeSeat ?? -1;
  const currentHandIndex = state.activeHand ?? 0;
  if (currentSeatIndex >= 0) {
    const seat = state.seats[currentSeatIndex];
    const nextHandIndex = getNextPlayableHandIndex(seat, currentHandIndex + 1);
    if (nextHandIndex !== -1) {
      state.activeSeat = currentSeatIndex;
      state.activeHand = nextHandIndex;
      seat.activeHand = nextHandIndex;
      setTurnDeadline(state);
      return;
    }
  }

  const next = findNextActiveSeat(state, currentSeatIndex + 1);
  if (next) {
    state.activeSeat = next.seatIndex;
    state.activeHand = next.handIndex;
    state.seats[next.seatIndex].activeHand = next.handIndex;
    setTurnDeadline(state);
    return;
  }

  state.phase = "dealer";
  state.activeSeat = null;
  state.activeHand = null;
  clearTurnDeadline(state);
  resolveDealerAndPayout(state);
}

function resolveDealerAndPayout(state) {
  const nextDealer = state.dealer.length > 0 ? [...state.dealer] : [];
  while (nextDealer.length < 2 && state.shoe.length > 0) {
    nextDealer.push(drawCard(state));
  }
  while (true) {
    const totals = getHandTotals(nextDealer);
    if (totals.total > 21) break;
    if (totals.total > 17) break;
    if (totals.total === 17 && !totals.isSoft) break;
    if (state.shoe.length === 0) break;
    nextDealer.push(drawCard(state));
  }
  const dealerTotalsFinal = getHandTotals(nextDealer);
  const dealerHasBlackjack = isBlackjack(nextDealer);

  state.seats = state.seats.map((seat) => {
    if (!seat.joined || seat.status === "waiting" || seat.status === "empty") {
      return seat.joined ? { ...seat, readyForNextRound: false } : seat;
    }
    let payoutTotal = 0;
    const outcomes = [];

    seat.hands.forEach((hand, index) => {
      const bet = seat.bets[index] ?? 0;
      const handTotals = getHandTotals(hand);
      let payout = 0;
      let outcome = "lose";
      if (handTotals.total > 21) {
        payout = 0;
        outcome = "lose";
      } else if (dealerHasBlackjack && isBlackjack(hand)) {
        payout = bet;
        outcome = "push";
      } else if (isBlackjack(hand) && !seat.handSplits?.[index]) {
        payout = bet * 2.5;
        outcome = "blackjack";
      } else if (dealerTotalsFinal.total > 21) {
        payout = bet * 2;
        outcome = "win";
      } else if (handTotals.total > dealerTotalsFinal.total) {
        payout = bet * 2;
        outcome = "win";
      } else if (handTotals.total === dealerTotalsFinal.total) {
        payout = bet;
        outcome = "push";
      }
      payoutTotal += payout;
      outcomes.push(outcome);
    });

    if (seat.walletAddress && seat.activeBetId) {
      state.settlementQueue.push({
        betId: seat.activeBetId,
        walletAddress: seat.walletAddress,
        payoutAmount: payoutTotal,
        seatId: seat.id,
        roundId: seat.activeBetRoundId,
      });
    }

    return {
      ...seat,
      status: "done",
      lastOutcomes: outcomes,
      lastPayout: payoutTotal,
      handStatuses: seat.handStatuses.map(() => "done"),
      readyForNextRound: false,
      activeBetId: null,
      activeBetRoundId: null,
      activeBetAmountWei: null,
    };
  });

  state.dealer = nextDealer;
  state.seats = state.seats.map((seat) =>
    seat.pendingLeave
      ? {
          ...createSeat(seat.id),
          joined: false,
        }
      : seat
  );
  state.phase = "settled";
  state.activeSeat = null;
  state.activeHand = null;
  clearTurnDeadline(state);
  setCooldown(state);
  appendLog(
    state,
    dealerTotalsFinal.total > 21
      ? "Dealer busts. Payouts settled. Next round in 30s."
      : "Dealer stands. Payouts settled. Next round in 30s."
  );
}

export function createDefaultBlackjackState() {
  return {
    seats: createSeats(),
    dealer: [],
    shoe: buildShoe(),
    phase: "idle",
    activeSeat: null,
    activeHand: null,
    log: [],
    turnExpiresAt: null,
    cooldownExpiresAt: null,
    settlementQueue: [],
    roundId: 1,
    activeRoundId: null,
    updatedAt: new Date().toISOString(),
  };
}

export function loadBlackjackState(filePath) {
  try {
    if (!fs.existsSync(filePath)) return createDefaultBlackjackState();
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!raw || typeof raw !== "object") return createDefaultBlackjackState();
    const seats = Array.isArray(raw.seats) && raw.seats.length > 0 ? raw.seats : createSeats();
    const shoe = Array.isArray(raw.shoe) && raw.shoe.length > 0 ? raw.shoe : buildShoe();
    const normalizedSeats = seats.map((seat, index) => ({
      ...createSeat(index),
      ...seat,
      readyForNextRound:
        typeof seat.readyForNextRound === "boolean" ? seat.readyForNextRound : Boolean(seat.joined),
      hands: Array.isArray(seat.hands) ? seat.hands : [],
      handStatuses: Array.isArray(seat.handStatuses) ? seat.handStatuses : [],
      handSplits: Array.isArray(seat.handSplits) ? seat.handSplits : [],
      bets: Array.isArray(seat.bets) ? seat.bets : [],
      lastOutcomes: Array.isArray(seat.lastOutcomes) ? seat.lastOutcomes : [],
    }));
    return {
      seats: normalizedSeats,
      dealer: Array.isArray(raw.dealer) ? raw.dealer : [],
      shoe,
      phase: raw.phase || "idle",
      activeSeat: Number.isInteger(raw.activeSeat) ? raw.activeSeat : null,
      activeHand: Number.isInteger(raw.activeHand) ? raw.activeHand : null,
      log: Array.isArray(raw.log) ? raw.log : [],
      turnExpiresAt: raw.turnExpiresAt ?? null,
      cooldownExpiresAt: raw.cooldownExpiresAt ?? null,
      settlementQueue: Array.isArray(raw.settlementQueue) ? raw.settlementQueue : [],
      roundId: Number.isInteger(raw.roundId) && raw.roundId > 0 ? raw.roundId : 1,
      activeRoundId: Number.isInteger(raw.activeRoundId) ? raw.activeRoundId : null,
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
  } catch (e) {
    console.error("Failed to load blackjack state:", e);
    return createDefaultBlackjackState();
  }
}

export function saveBlackjackState(filePath, state) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("Failed to save blackjack state:", e);
  }
}

export function joinSeat(state, seatId, name = "", walletAddress = null, bankrollOverride = null) {
  const seat = state.seats.find((s) => s.id === seatId);
  if (!seat) return { error: "Seat not found" };
  if (seat.joined) return { error: "Seat already joined" };
  seat.joined = true;
  seat.status = "waiting";
  seat.pendingLeave = false;
  seat.hands = [];
  seat.handStatuses = [];
  seat.handSplits = [];
  seat.bets = [];
  seat.activeHand = 0;
  seat.lastOutcomes = [];
  seat.lastPayout = 0;
  seat.readyForNextRound = false;
  seat.name = name || seat.name || "Player";
  seat.walletAddress = walletAddress || seat.walletAddress || null;
  if (bankrollOverride !== null && Number.isFinite(bankrollOverride)) {
    seat.bankroll = bankrollOverride;
  }
  appendLog(state, `Seat ${seatId + 1} joined the table.`);
  touch(state);
  return { ok: true };
}

export function leaveSeat(state, seatId) {
  const seat = state.seats.find((s) => s.id === seatId);
  if (!seat) return { error: "Seat not found" };
  if (!seat.joined) return { error: "Seat is not occupied" };
  if (state.phase === "player" || state.phase === "dealer") {
    seat.pendingLeave = true;
    appendLog(state, `Seat ${seatId + 1} will leave after this round.`);
  } else {
    state.seats[seatId] = createSeat(seatId);
    appendLog(state, `Seat ${seatId + 1} left the table.`);
  }
  touch(state);
  return { ok: true };
}

export function updateSeat(state, seatId, updates) {
  const seat = state.seats.find((s) => s.id === seatId);
  if (!seat) return { error: "Seat not found" };
  if (!seat.joined) return { error: "Seat is not occupied" };
  if (state.phase === "player" || state.phase === "dealer") {
    return { error: "Seats cannot be edited mid-hand" };
  }
  if (updates.name !== undefined) {
    seat.name = String(updates.name || "").slice(0, 32);
  }
  if (updates.bet !== undefined) {
    const bet = Number(updates.bet);
    if (!Number.isFinite(bet) || bet < BLACKJACK_MIN_BET) return { error: "Invalid bet" };
    seat.bet = Math.min(bet, seat.bankroll);
    seat.pendingBetId = null;
    seat.pendingBetAmount = 0;
    seat.pendingBetAmountWei = null;
    seat.pendingBetRoundId = null;
    seat.readyForNextRound = false;
  }
  if (updates.readyForNextRound !== undefined) {
    seat.readyForNextRound = Boolean(updates.readyForNextRound);
  }
  touch(state);
  return { ok: true };
}

export function shuffleShoe(state) {
  if (state.phase !== "idle" && state.phase !== "settled") {
    return { error: "Cannot shuffle during a hand" };
  }
  state.shoe = buildShoe();
  appendLog(state, "Dealer shuffled a fresh shoe.");
  touch(state);
  return { ok: true };
}

export function startRound(state) {
  const roundId = state.roundId || 1;
  state.activeRoundId = roundId;
  state.roundId = roundId + 1;
  const removedSeats = [];
  state.seats = state.seats.map((seat) => {
    if (seat.joined && !seat.readyForNextRound) {
      removedSeats.push(seat.id);
      return createSeat(seat.id);
    }
    return seat;
  });
  removedSeats.forEach((seatId) => {
    appendLog(state, `Seat ${seatId + 1} left after skipping the next-round prompt.`);
  });
  const activeSeats = state.seats.filter((seat) => seat.joined);
  if (activeSeats.length === 0) {
    appendLog(state, "No players seated. Join a seat to start a round.");
    touch(state);
    return { ok: true };
  }
  const requiredCards = activeSeats.length * 2 + 2;
  if (state.shoe.length < requiredCards) {
    state.shoe = buildShoe();
    appendLog(state, "Shoe re-shuffled for the next hand.");
  }
  clearCooldown(state);
  const nextDealer = [];
  const dealtSeats = state.seats.map((seat) => {
    if (!seat.joined) return seat;
    const hasPending = seat.pendingBetRoundId === state.activeRoundId && seat.pendingBetId;
    const bet = Math.max(BLACKJACK_MIN_BET, Math.min(seat.bet, seat.pendingBetAmount || seat.bet));
    if (!hasPending || bet <= 0) {
      return {
        ...seat,
        status: "waiting",
        hands: [],
        handStatuses: [],
        handSplits: [],
        bets: [],
        activeHand: 0,
        lastOutcomes: [],
        lastPayout: 0,
      };
    }
    const hand = [drawCard(state), drawCard(state)];
    const handStatus = isBlackjack(hand) ? "blackjack" : "playing";
    return {
      ...seat,
      bet,
      pendingBetId: null,
      pendingBetAmount: 0,
      pendingBetAmountWei: null,
      pendingBetRoundId: null,
      activeBetId: seat.pendingBetId,
      activeBetRoundId: seat.pendingBetRoundId,
      activeBetAmountWei: seat.pendingBetAmountWei,
      hands: [hand],
      handStatuses: [handStatus],
      handSplits: [false],
      bets: [bet],
      activeHand: 0,
      status: handStatus === "playing" ? "playing" : "blackjack",
      lastOutcomes: [],
      lastPayout: 0,
    };
  });
  nextDealer.push(drawCard(state), drawCard(state));
  state.seats = dealtSeats;
  state.dealer = nextDealer;
  const firstPlaying = findNextActiveSeat(state, 0);
  if (!firstPlaying) {
    state.phase = "dealer";
    state.activeSeat = null;
    state.activeHand = null;
    resolveDealerAndPayout(state);
  } else {
    state.phase = "player";
    state.activeSeat = firstPlaying.seatIndex;
    state.activeHand = firstPlaying.handIndex;
    state.seats[firstPlaying.seatIndex].activeHand = firstPlaying.handIndex;
    setTurnDeadline(state);
  }
  appendLog(state, "Cards are dealt. Players act in seat order.");
  touch(state);
  return { ok: true };
}

export function hit(state, seatId) {
  if (state.phase !== "player") return { error: "Hand not active" };
  const seatIndex = state.seats.findIndex((seat) => seat.id === seatId);
  if (seatIndex === -1) return { error: "Seat not found" };
  if (state.activeSeat !== seatIndex) return { error: "Seat not active" };
  const seat = state.seats[seatIndex];
  const handIndex = state.activeHand ?? 0;
  if (seat.handStatuses[handIndex] !== "playing") return { error: "Seat cannot act" };
  const card = drawCard(state);
  if (!card) return { error: "Shoe empty" };
  seat.hands[handIndex] = [...seat.hands[handIndex], card];
  const totals = getHandTotals(seat.hands[handIndex]);
  if (totals.total > 21) {
    seat.handStatuses[handIndex] = "busted";
  } else if (totals.total === 21) {
    seat.handStatuses[handIndex] = "stood";
  }
  seat.status = updateSeatStatus(seat);
  if (seat.handStatuses[handIndex] !== "playing") {
    advanceTurn(state);
  } else {
    setTurnDeadline(state);
  }
  touch(state);
  return { ok: true };
}

export function stand(state, seatId) {
  if (state.phase !== "player") return { error: "Hand not active" };
  const seatIndex = state.seats.findIndex((seat) => seat.id === seatId);
  if (seatIndex === -1) return { error: "Seat not found" };
  if (state.activeSeat !== seatIndex) return { error: "Seat not active" };
  const handIndex = state.activeHand ?? 0;
  state.seats[seatIndex].handStatuses[handIndex] = "stood";
  state.seats[seatIndex].status = updateSeatStatus(state.seats[seatIndex]);
  advanceTurn(state);
  touch(state);
  return { ok: true };
}

export function doubleDown(state, seatId) {
  if (state.phase !== "player") return { error: "Hand not active" };
  const seatIndex = state.seats.findIndex((seat) => seat.id === seatId);
  if (seatIndex === -1) return { error: "Seat not found" };
  if (state.activeSeat !== seatIndex) return { error: "Seat not active" };
  const seat = state.seats[seatIndex];
  const handIndex = state.activeHand ?? 0;
  const bet = seat.bets[handIndex];
  if (seat.handStatuses[handIndex] !== "playing" || seat.hands[handIndex].length !== 2) {
    return { error: "Seat cannot double" };
  }
  const card = drawCard(state);
  if (!card) return { error: "Shoe empty" };
  seat.hands[handIndex] = [...seat.hands[handIndex], card];
  seat.bets[handIndex] = bet * 2;
  const totals = getHandTotals(seat.hands[handIndex]);
  seat.handStatuses[handIndex] = totals.total > 21 ? "busted" : "stood";
  seat.status = updateSeatStatus(seat);
  advanceTurn(state);
  touch(state);
  return { ok: true };
}

export function splitHand(state, seatId) {
  if (state.phase !== "player") return { error: "Hand not active" };
  const seatIndex = state.seats.findIndex((seat) => seat.id === seatId);
  if (seatIndex === -1) return { error: "Seat not found" };
  if (state.activeSeat !== seatIndex) return { error: "Seat not active" };
  const seat = state.seats[seatIndex];
  if (seat.hands.length >= MAX_SPLIT_HANDS) return { error: "Maximum splits reached" };
  const handIndex = state.activeHand ?? 0;
  const hand = seat.hands[handIndex];
  if (!hand || hand.length !== 2) return { error: "Hand cannot be split" };
  if (hand[0].rank !== hand[1].rank) return { error: "Cards must match to split" };
  const bet = seat.bets[handIndex];

  const [first, second] = hand;
  seat.hands = [[first], [second]];
  seat.bets = [bet, bet];
  seat.handSplits = [true, true];
  seat.handStatuses = ["playing", "playing"];
  seat.activeHand = 0;
  seat.hands[0].push(drawCard(state));
  seat.hands[1].push(drawCard(state));
  seat.handStatuses = seat.hands.map((cards) => {
    const totals = getHandTotals(cards);
    if (totals.total > 21) return "busted";
    if (totals.total >= 21) return "stood";
    return "playing";
  });
  seat.status = updateSeatStatus(seat);
  appendLog(state, `Seat ${seatId + 1} split their hand.`);
  if (seat.handStatuses[0] !== "playing") {
    advanceTurn(state);
  } else {
    setTurnDeadline(state);
  }
  touch(state);
  return { ok: true };
}

export function timeoutStand(state) {
  if (state.phase !== "player" || state.activeSeat === null) return { ok: false };
  const seat = state.seats[state.activeSeat];
  const handIndex = state.activeHand ?? 0;
  if (!seat || seat.handStatuses[handIndex] !== "playing") return { ok: false };
  seat.handStatuses[handIndex] = "stood";
  seat.status = updateSeatStatus(seat);
  appendLog(state, `Seat ${seat.id + 1} timed out. Auto-stand.`);
  advanceTurn(state);
  touch(state);
  return { ok: true };
}

export function resetRound(state) {
  state.seats = state.seats.map((seat) =>
    seat.joined
      ? {
          ...seat,
          hands: [],
          handStatuses: [],
          handSplits: [],
          bets: [],
          activeHand: 0,
          status: "waiting",
          bet: Math.max(BLACKJACK_MIN_BET, seat.bet),
          lastOutcomes: [],
          lastPayout: 0,
          readyForNextRound: true,
          pendingBetId: null,
          pendingBetAmount: 0,
          pendingBetAmountWei: null,
          pendingBetRoundId: null,
          activeBetId: null,
          activeBetRoundId: null,
          activeBetAmountWei: null,
        }
      : seat
  );
  state.dealer = [];
  state.phase = "idle";
  state.activeSeat = null;
  state.activeHand = null;
  state.activeRoundId = null;
  clearTurnDeadline(state);
  clearCooldown(state);
  appendLog(state, "Table reset for a new round.");
  touch(state);
  return { ok: true };
}

export { BLACKJACK_MIN_BET, BLACKJACK_DECKS, TURN_TIME_MS, ROUND_COOLDOWN_MS };
