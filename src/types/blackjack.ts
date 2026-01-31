export type Card = {
  rank: string;
  suit: string;
  value: number;
};

export type BlackjackHandStatus = "playing" | "stood" | "bust" | "blackjack" | "surrendered";

export type BlackjackHandState = {
  cards: Card[];
  status: BlackjackHandStatus;
  betWei: string;
  isSplit?: boolean;
};

export type BlackjackTableState = {
  dealer: Card[];
  shoe: Card[];
  hands: BlackjackHandState[];
  activeHandIndex: number;
  phase: "player" | "dealer" | "settled";
};

export type BlackjackSession = {
  id: string;
  walletAddress: string;
  seatId: number;
  buyInAmountWei: string;
  bankrollWei: string;
  status: "OPEN" | "CLOSED";
  createdAt: string;
  updatedAt: string;
};

export type BlackjackOutcome =
  | "PENDING"
  | "PLAYER_WIN"
  | "DEALER_WIN"
  | "PUSH"
  | "BLACKJACK"
  | "BUST"
  | "SURRENDER";

export type BlackjackHand = {
  id: string;
  sessionId: string;
  betAmountWei: string;
  stateJson: BlackjackTableState;
  outcome: BlackjackOutcome;
  payoutWei: string;
  createdAt: string;
};
