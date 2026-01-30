export type Card = {
  rank: string;
  suit: string;
  value: number;
};

export type SeatStatus = "empty" | "waiting" | "playing" | "stood" | "busted" | "blackjack" | "done";

export type BlackjackSeat = {
  id: number;
  name: string;
  walletAddress?: string | null;
  bankroll: number;
  bet: number;
  pendingBetId?: string | null;
  pendingBetAmount?: number;
  pendingBetRoundId?: number | null;
  activeBetId?: string | null;
  activeBetRoundId?: number | null;
  readyForNextRound?: boolean;
  hands: Card[][];
  handStatuses: SeatStatus[];
  handSplits: boolean[];
  bets: number[];
  activeHand: number;
  status: SeatStatus;
  pendingLeave: boolean;
  joined: boolean;
  lastOutcomes?: Array<"win" | "lose" | "push" | "blackjack">;
  lastPayout?: number;
};

export type BlackjackState = {
  seats: BlackjackSeat[];
  dealer: Card[];
  shoe: Card[];
  phase: "idle" | "player" | "dealer" | "settled";
  activeSeat: number | null;
  activeHand: number | null;
  turnExpiresAt: number | null;
  cooldownExpiresAt: number | null;
  log: string[];
  roundId?: number;
  activeRoundId?: number | null;
};

export type BlackjackSession = {
  id: string;
  walletAddress: string;
  seatId: number;
  status: string;
  buyInWei: bigint;
  bankrollWei: bigint;
  committedWei: bigint;
  netPnlWei: bigint;
};
