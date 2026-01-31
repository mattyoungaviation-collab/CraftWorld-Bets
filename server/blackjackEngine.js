const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function shuffle(cards) {
  const deck = [...cards];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function createBlackjackShoe(decks = 6) {
  const cards = [];
  for (let deck = 0; deck < decks; deck += 1) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
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

function drawCard(shoe) {
  return shoe.pop() || null;
}

function pushCard(hand, card) {
  if (card) hand.push(card);
}

export function getHandTotals(cards) {
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
  const soft = cards.some((card) => card.rank === "A") && total <= 21 && aces > 0;
  return { total, soft };
}

function isBlackjack(cards) {
  if (cards.length !== 2) return false;
  const { total } = getHandTotals(cards);
  return total === 21;
}

function cloneState(state) {
  return typeof structuredClone === "function" ? structuredClone(state) : JSON.parse(JSON.stringify(state));
}

export function dealInitialHand(shoe, betAmountWei) {
  const state = {
    shoe: [...shoe],
    dealerHand: [],
    playerHands: [[]],
    handStatuses: ["playing"],
    handBets: [betAmountWei],
    activeHand: 0,
    dealerRevealed: false,
    phase: "player",
  };

  const playerHand = state.playerHands[0];
  pushCard(playerHand, drawCard(state.shoe));
  pushCard(state.dealerHand, drawCard(state.shoe));
  pushCard(playerHand, drawCard(state.shoe));
  pushCard(state.dealerHand, drawCard(state.shoe));

  const playerBlackjack = isBlackjack(playerHand);
  const dealerBlackjack = isBlackjack(state.dealerHand);
  if (playerBlackjack || dealerBlackjack) {
    state.handStatuses[0] = playerBlackjack ? "blackjack" : "stand";
    state.dealerRevealed = true;
    state.phase = "settled";
  }

  return { state };
}

function moveToNextHand(state) {
  const nextIndex = state.handStatuses.findIndex((status, index) => status === "playing" && index > state.activeHand);
  if (nextIndex === -1) {
    state.phase = "dealer";
  } else {
    state.activeHand = nextIndex;
  }
}

export function shouldAllowAction(state, action, bankrollWei) {
  if (state.phase !== "player") {
    return { ok: false, error: "Hand is not accepting actions" };
  }
  const activeIndex = state.activeHand ?? 0;
  const hand = state.playerHands?.[activeIndex];
  if (!hand) return { ok: false, error: "Hand not found" };
  const status = state.handStatuses?.[activeIndex] || "playing";
  if (status !== "playing") {
    return { ok: false, error: "Hand is already resolved" };
  }
  const betWei = BigInt(state.handBets?.[activeIndex] || "0");

  if (action === "double") {
    if (hand.length !== 2) return { ok: false, error: "Double only allowed on first move" };
    if (betWei * 2n > bankrollWei) return { ok: false, error: "Insufficient bankroll to double" };
  }

  if (action === "split") {
    if (hand.length !== 2) return { ok: false, error: "Split only allowed on first move" };
    if (state.playerHands.length > 1) return { ok: false, error: "Only one split is allowed" };
    if (hand[0].rank !== hand[1].rank) return { ok: false, error: "Cards must match to split" };
    if (betWei * 2n > bankrollWei) return { ok: false, error: "Insufficient bankroll to split" };
  }

  if (action === "surrender") {
    if (hand.length !== 2) return { ok: false, error: "Surrender only allowed on first move" };
    if (state.playerHands.length > 1) return { ok: false, error: "Cannot surrender after splitting" };
  }

  return { ok: true };
}

export function applyPlayerAction(state, action) {
  const next = cloneState(state);
  const activeIndex = next.activeHand ?? 0;
  const hand = next.playerHands[activeIndex];

  if (action === "hit") {
    pushCard(hand, drawCard(next.shoe));
    const totals = getHandTotals(hand);
    if (totals.total > 21) {
      next.handStatuses[activeIndex] = "bust";
      moveToNextHand(next);
    }
  }

  if (action === "stand") {
    next.handStatuses[activeIndex] = "stand";
    moveToNextHand(next);
  }

  if (action === "double") {
    pushCard(hand, drawCard(next.shoe));
    const betWei = BigInt(next.handBets[activeIndex] || "0");
    next.handBets[activeIndex] = (betWei * 2n).toString();
    const totals = getHandTotals(hand);
    next.handStatuses[activeIndex] = totals.total > 21 ? "bust" : "stand";
    moveToNextHand(next);
  }

  if (action === "split") {
    const firstCard = hand[0];
    const secondCard = hand[1];
    const betWei = next.handBets[activeIndex];
    next.playerHands = [[firstCard], [secondCard]];
    next.handBets = [betWei, betWei];
    next.handStatuses = ["playing", "playing"];
    next.activeHand = 0;
    pushCard(next.playerHands[0], drawCard(next.shoe));
    pushCard(next.playerHands[1], drawCard(next.shoe));
  }

  if (action === "surrender") {
    next.handStatuses[activeIndex] = "surrender";
    next.phase = "dealer";
  }

  return next;
}

export function resolveDealerHand(state) {
  const next = cloneState(state);
  const needsDealer = next.handStatuses.some((status) => !["bust", "surrender"].includes(status));
  next.dealerRevealed = true;
  if (!needsDealer) {
    next.phase = "settled";
    return next;
  }

  while (true) {
    const totals = getHandTotals(next.dealerHand);
    if (totals.total > 21) break;
    if (totals.total > 17) break;
    if (totals.total === 17 && !totals.soft) break;
    const card = drawCard(next.shoe);
    if (!card) break;
    next.dealerHand.push(card);
  }
  next.phase = "settled";
  return next;
}

export function evaluateHandOutcome(state) {
  const dealerTotals = getHandTotals(state.dealerHand);
  const dealerBlackjack = isBlackjack(state.dealerHand);
  const handResults = [];
  let payoutTotal = 0n;

  state.playerHands.forEach((hand, index) => {
    const betWei = BigInt(state.handBets?.[index] || "0");
    const status = state.handStatuses?.[index] || "playing";
    if (status === "surrender") {
      const payout = -(betWei / 2n);
      payoutTotal += payout;
      handResults.push({
        outcome: "SURRENDER",
        payoutWei: payout.toString(),
      });
      return;
    }
    if (status === "bust") {
      payoutTotal -= betWei;
      handResults.push({
        outcome: "BUST",
        payoutWei: (-betWei).toString(),
      });
      return;
    }

    const playerTotals = getHandTotals(hand);
    const playerBlackjack = isBlackjack(hand);

    if (dealerBlackjack && playerBlackjack) {
      handResults.push({ outcome: "PUSH", payoutWei: "0" });
      return;
    }
    if (playerBlackjack) {
      const payout = (betWei * 3n) / 2n;
      payoutTotal += payout;
      handResults.push({ outcome: "BLACKJACK", payoutWei: payout.toString() });
      return;
    }
    if (dealerBlackjack) {
      payoutTotal -= betWei;
      handResults.push({ outcome: "DEALER_WIN", payoutWei: (-betWei).toString() });
      return;
    }
    if (dealerTotals.total > 21) {
      payoutTotal += betWei;
      handResults.push({ outcome: "PLAYER_WIN", payoutWei: betWei.toString() });
      return;
    }
    if (playerTotals.total > dealerTotals.total) {
      payoutTotal += betWei;
      handResults.push({ outcome: "PLAYER_WIN", payoutWei: betWei.toString() });
      return;
    }
    if (playerTotals.total < dealerTotals.total) {
      payoutTotal -= betWei;
      handResults.push({ outcome: "DEALER_WIN", payoutWei: (-betWei).toString() });
      return;
    }
    handResults.push({ outcome: "PUSH", payoutWei: "0" });
  });

  let outcome = "PUSH";
  if (handResults.length === 1) {
    const singleOutcome = handResults[0]?.outcome;
    if (["BLACKJACK", "BUST", "SURRENDER"].includes(singleOutcome)) {
      outcome = singleOutcome;
    } else if (payoutTotal > 0n) {
      outcome = "PLAYER_WIN";
    } else if (payoutTotal < 0n) {
      outcome = "DEALER_WIN";
    }
  } else if (payoutTotal > 0n) {
    outcome = "PLAYER_WIN";
  } else if (payoutTotal < 0n) {
    outcome = "DEALER_WIN";
  }

  return {
    outcome,
    payoutWei: payoutTotal,
    handResults,
  };
}
