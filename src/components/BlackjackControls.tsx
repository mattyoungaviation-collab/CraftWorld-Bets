import type { BlackjackSeat } from "../types/blackjack";

type BlackjackControlsProps = {
  selectedSeat: BlackjackSeat | null;
  selectedSeatNumber: number | null;
  isOwner: boolean;
  hasSession: boolean;
  hasActiveSession: boolean;
  blackjackPhase: "idle" | "player" | "dealer" | "settled";
  canAct: boolean;
  canDouble: boolean;
  canSplit: boolean;
  minBet: number;
  buyInAmount: string;
  onBuyInAmountChange: (value: string) => void;
  onBuyIn: () => void;
  seatName: string;
  onSeatNameChange: (value: string) => void;
  onBetChange: (value: number) => void;
  onDeal: () => void;
  onAction: (action: "hit" | "stand" | "double" | "split") => void;
  onLeave: () => void;
};

export default function BlackjackControls({
  selectedSeat,
  selectedSeatNumber,
  isOwner,
  hasSession,
  hasActiveSession,
  blackjackPhase,
  canAct,
  canDouble,
  canSplit,
  minBet,
  buyInAmount,
  onBuyInAmountChange,
  onBuyIn,
  seatName,
  onSeatNameChange,
  onBetChange,
  onDeal,
  onAction,
  onLeave,
}: BlackjackControlsProps) {
  const canBuyIn = Boolean(selectedSeat) && isOwner && blackjackPhase !== "player" && blackjackPhase !== "dealer";
  const canDeal = Boolean(selectedSeat) && isOwner && hasActiveSession && blackjackPhase !== "player" && blackjackPhase !== "dealer";

  return (
    <div className="blackjack-controls">
      <div className="blackjack-controls-header">
        <div>
          <div className="section-title">Table Controls</div>
          <div className="subtle">
            {selectedSeatNumber ? `Selected seat: ${selectedSeatNumber}` : "Select a seat to play."}
          </div>
        </div>
        <button className="btn btn-ghost" onClick={onLeave} disabled={!hasSession}>
          Leave &amp; settle
        </button>
      </div>

      <div className="blackjack-controls-grid">
        <div>
          <label>Player name</label>
          <div className="control-row">
            <input
              value={seatName}
              onChange={(event) => onSeatNameChange(event.target.value)}
              placeholder="Player name"
              disabled={!selectedSeat || !isOwner || blackjackPhase === "player" || blackjackPhase === "dealer"}
            />
          </div>
          <div className="subtle">Edit your seat name before the deal.</div>
        </div>
        <div>
          <label>Buy-in amount</label>
          <div className="control-row">
            <input
              type="number"
              min={minBet}
              step="1"
              value={buyInAmount}
              onChange={(event) => onBuyInAmountChange(event.target.value)}
              placeholder={`${minBet}+`}
              disabled={!canBuyIn}
            />
            <button className="btn btn-primary" onClick={onBuyIn} disabled={!canBuyIn}>
              Buy in
            </button>
          </div>
          <div className="subtle">Minimum buy-in: {minBet}+.</div>
        </div>

        <div>
          <label>Wager</label>
          <div className="control-row">
            <input
              type="number"
              min={minBet}
              step="1"
              value={selectedSeat?.bet ?? minBet}
              onChange={(event) => onBetChange(Number(event.target.value))}
              disabled={!isOwner || !hasActiveSession}
            />
            <button className="btn btn-primary" onClick={onDeal} disabled={!canDeal}>
              Deal hand
            </button>
          </div>
          <div className="subtle">Wager must be at least {minBet}.</div>
        </div>
      </div>

      <div className="blackjack-actions-row">
        <button className="btn" onClick={() => onAction("hit")} disabled={!canAct}>
          Hit
        </button>
        <button className="btn" onClick={() => onAction("stand")} disabled={!canAct}>
          Stand
        </button>
        <button className="btn" onClick={() => onAction("double")} disabled={!canDouble}>
          Double
        </button>
        <button className="btn" onClick={() => onAction("split")} disabled={!canSplit}>
          Split
        </button>
        <div className="subtle">
          {canAct ? "Your turn." : "Actions unlock when it is your turn with an active hand."}
        </div>
      </div>
    </div>
  );
}
