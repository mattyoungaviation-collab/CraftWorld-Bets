export type BlackjackPlayerState = "playing" | "stood" | "bust" | "blackjack" | "surrendered";

export type BlackjackTableState = {
  shoe: string[];
  shoeIndex: number;
  playerCards: string[];
  dealerCards: string[];
  playerState: BlackjackPlayerState;
  phase: "player" | "dealer" | "complete";
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
