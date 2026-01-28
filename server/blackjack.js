import fs from "fs";

const BLACKJACK_DECKS = 6;
const BLACKJACK_MIN_BET = 25;
const BLACKJACK_SEATS = 5;
const MAX_LOG_ENTRIES = 6;

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

function createSeats() {
  return Array.from({ length: BLACKJACK_SEATS }, (_, index) => ({
    id: index,
    name: "",
    bankroll: 1000,
    bet: BLACKJACK_MIN_BET,
    hand: [],
    status: "empty",
    pendingLeave: false,
    joined: false,
  }));
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

export function createDefaultBlackjackState() {
  return {
    seats: createSeats(),
    dealer: [],
    shoe: buildShoe(),
    phase: "idle",
    activeSeat: null,
    log: [],
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
    return {
      seats,
      dealer: Array.isArray(raw.dealer) ? raw.dealer : [],
      shoe,
      phase: raw.phase || "idle",
      activeSeat: Number.isInteger(raw.activeSeat) ? raw.activeSeat : null,
      log: Array.isArray(raw.log) ? raw.log : [],
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

export function joinSeat(state, seatId, name = "") {
  const seat = state.seats.find((s) => s.id === seatId);
  if (!seat) return { error: "Seat not found" };
  if (seat.joined) return { error: "Seat already joined" };
  seat.joined = true;
  seat.status = "waiting";
  seat.pendingLeave = false;
  seat.hand = [];
  seat.lastOutcome = undefined;
  seat.name = name || seat.name || "Player";
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
    seat.joined = false;
    seat.status = "empty";
    seat.hand = [];
    seat.pendingLeave = false;
    seat.lastOutcome = undefined;
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
  if (updates.bankroll !== undefined) {
    const bankroll = Number(updates.bankroll);
    if (!Number.isFinite(bankroll) || bankroll < 0) return { error: "Invalid bankroll" };
    seat.bankroll = bankroll;
    if (seat.bet > seat.bankroll) {
      seat.bet = Math.max(BLACKJACK_MIN_BET, seat.bankroll);
    }
  }
  if (updates.bet !== undefined) {
    const bet = Number(updates.bet);
    if (!Number.isFinite(bet) || bet < BLACKJACK_MIN_BET) return { error: "Invalid bet" };
    seat.bet = Math.min(bet, seat.bankroll);
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

function nextPlayingSeatIndex(seats) {
  return seats.findIndex((seat) => seat.joined && seat.status === "playing");
}

function resolveDealerAndPayout(state) {
  const nextDealer = state.dealer.length > 0 ? [...state.dealer] : [];
  while (nextDealer.length < 2 && state.shoe.length > 0) {
    nextDealer.push(state.shoe.shift());
  }
  while (true) {
    const totals = getHandTotals(nextDealer);
    if (totals.total > 21) break;
    if (totals.total > 17) break;
    if (totals.total === 17 && !totals.isSoft) break;
    if (state.shoe.length === 0) break;
    nextDealer.push(state.shoe.shift());
  }
  const dealerTotalsFinal = getHandTotals(nextDealer);
  const dealerHasBlackjack = isBlackjack(nextDealer);
  state.seats = state.seats.map((seat) => {
    if (!seat.joined || seat.status === "waiting" || seat.status === "empty") return seat;
    const playerTotals = getHandTotals(seat.hand);
    let payout = 0;
    let outcome = "lose";
    if (playerTotals.total > 21) {
      payout = 0;
      outcome = "lose";
    } else if (dealerHasBlackjack && isBlackjack(seat.hand)) {
      payout = seat.bet;
      outcome = "push";
    } else if (isBlackjack(seat.hand)) {
      payout = seat.bet * 2.5;
      outcome = "blackjack";
    } else if (dealerTotalsFinal.total > 21) {
      payout = seat.bet * 2;
      outcome = "win";
    } else if (playerTotals.total > dealerTotalsFinal.total) {
      payout = seat.bet * 2;
      outcome = "win";
    } else if (playerTotals.total === dealerTotalsFinal.total) {
      payout = seat.bet;
      outcome = "push";
    }
    return {
      ...seat,
      bankroll: seat.bankroll + payout,
      status: "done",
      lastOutcome: outcome,
    };
  });
  state.dealer = nextDealer;
  state.seats = state.seats.map((seat) =>
    seat.pendingLeave
      ? {
          ...seat,
          joined: false,
          status: "empty",
          hand: [],
          pendingLeave: false,
          lastOutcome: undefined,
        }
      : seat
  );
  state.phase = "settled";
  state.activeSeat = null;
  appendLog(
    state,
    dealerTotalsFinal.total > 21 ? "Dealer busts. Payouts settled." : "Dealer stands. Payouts settled."
  );
}

export function startRound(state) {
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
  const draw = () => state.shoe.shift();
  const nextDealer = [];
  const dealtSeats = state.seats.map((seat) => {
    if (!seat.joined) return seat;
    const bet = Math.max(BLACKJACK_MIN_BET, Math.min(seat.bet, seat.bankroll));
    if (bet <= 0 || seat.bankroll < bet) {
      return { ...seat, status: "waiting", hand: [], lastOutcome: undefined };
    }
    const hand = [draw(), draw()];
    const status = isBlackjack(hand) ? "blackjack" : "playing";
    return {
      ...seat,
      bet,
      bankroll: seat.bankroll - bet,
      hand,
      status,
      lastOutcome: undefined,
    };
  });
  nextDealer.push(draw(), draw());
  state.seats = dealtSeats;
  state.dealer = nextDealer;
  const firstPlayingIndex = nextPlayingSeatIndex(dealtSeats);
  if (firstPlayingIndex === -1) {
    state.phase = "dealer";
    state.activeSeat = null;
    resolveDealerAndPayout(state);
  } else {
    state.phase = "player";
    state.activeSeat = firstPlayingIndex;
  }
  appendLog(state, "Cards are dealt. Players act in seat order.");
  touch(state);
  return { ok: true };
}

function advanceToDealerIfDone(state) {
  const nextIndex = nextPlayingSeatIndex(state.seats);
  if (nextIndex === -1) {
    state.phase = "dealer";
    state.activeSeat = null;
    resolveDealerAndPayout(state);
  } else {
    state.activeSeat = nextIndex;
  }
}

export function hit(state, seatId) {
  if (state.phase !== "player") return { error: "Hand not active" };
  const seatIndex = state.seats.findIndex((seat) => seat.id === seatId);
  if (seatIndex === -1) return { error: "Seat not found" };
  if (state.activeSeat !== seatIndex) return { error: "Seat not active" };
  const seat = state.seats[seatIndex];
  if (seat.status !== "playing") return { error: "Seat cannot act" };
  const card = state.shoe.shift();
  if (!card) return { error: "Shoe empty" };
  seat.hand = [...seat.hand, card];
  const totals = getHandTotals(seat.hand);
  if (totals.total > 21) {
    seat.status = "busted";
  } else if (totals.total === 21) {
    seat.status = "stood";
  }
  if (seat.status !== "playing") {
    advanceToDealerIfDone(state);
  }
  touch(state);
  return { ok: true };
}

export function stand(state, seatId) {
  if (state.phase !== "player") return { error: "Hand not active" };
  const seatIndex = state.seats.findIndex((seat) => seat.id === seatId);
  if (seatIndex === -1) return { error: "Seat not found" };
  if (state.activeSeat !== seatIndex) return { error: "Seat not active" };
  state.seats[seatIndex] = { ...state.seats[seatIndex], status: "stood" };
  advanceToDealerIfDone(state);
  touch(state);
  return { ok: true };
}

export function doubleDown(state, seatId) {
  if (state.phase !== "player") return { error: "Hand not active" };
  const seatIndex = state.seats.findIndex((seat) => seat.id === seatId);
  if (seatIndex === -1) return { error: "Seat not found" };
  if (state.activeSeat !== seatIndex) return { error: "Seat not active" };
  const seat = state.seats[seatIndex];
  if (seat.status !== "playing" || seat.hand.length !== 2) return { error: "Seat cannot double" };
  if (seat.bankroll < seat.bet) return { error: "Insufficient bankroll" };
  const card = state.shoe.shift();
  if (!card) return { error: "Shoe empty" };
  seat.hand = [...seat.hand, card];
  seat.bankroll -= seat.bet;
  seat.bet *= 2;
  const totals = getHandTotals(seat.hand);
  seat.status = totals.total > 21 ? "busted" : "stood";
  advanceToDealerIfDone(state);
  touch(state);
  return { ok: true };
}

export function resetRound(state) {
  state.seats = state.seats.map((seat) =>
    seat.joined
      ? {
          ...seat,
          hand: [],
          status: "waiting",
          bet: Math.max(BLACKJACK_MIN_BET, seat.bet),
          lastOutcome: undefined,
        }
      : seat
  );
  state.dealer = [];
  state.phase = "idle";
  state.activeSeat = null;
  appendLog(state, "Table reset for a new round.");
  touch(state);
  return { ok: true };
}

export { BLACKJACK_MIN_BET, BLACKJACK_DECKS };
