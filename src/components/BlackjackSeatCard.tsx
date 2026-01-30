import type { BlackjackSeat } from "../types/blackjack";

type SeatOdds = {
  win: number;
  push: number;
  lose: number;
  ev: number;
};

type BlackjackSeatCardProps = {
  seat: BlackjackSeat;
  seatNumber: number;
  isSelected: boolean;
  isOwner: boolean;
  hasActiveSession: boolean;
  sessionBalanceLabel: string | null;
  sessionBuyInLabel: string | null;
  sessionCommittedLabel: string | null;
  odds: SeatOdds;
  isActive: boolean;
  activeHandIndex: number;
  coinSymbol: string;
  formatHand: (hand: BlackjackSeat["hands"][number]) => string;
  getHandTotals: (hand: BlackjackSeat["hands"][number]) => { total: number; soft: boolean };
  fmt: (n: number) => string;
  onSelect: () => void;
  onJoin: () => void;
};

export default function BlackjackSeatCard({
  seat,
  seatNumber,
  isSelected,
  isOwner,
  hasActiveSession,
  sessionBalanceLabel,
  sessionBuyInLabel,
  sessionCommittedLabel,
  odds,
  isActive,
  activeHandIndex,
  coinSymbol,
  formatHand,
  getHandTotals,
  fmt,
  onSelect,
  onJoin,
}: BlackjackSeatCardProps) {
  const seatStatusLabel = seat.status === "empty" && !seat.joined ? "Open" : seat.status;

  return (
    <div
      className={`seat-card seat-card-grid ${seat.joined ? "occupied" : "open"} ${isSelected ? "selected" : ""} ${
        isActive ? "active" : ""
      }`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="seat-header">
        <div>
          <div className="seat-title">Seat {seatNumber}</div>
          <div className="subtle">{seat.joined ? seat.name || "Player" : "Open seat"}</div>
        </div>
        <div className="seat-header-actions">
          <span className="seat-status-pill">{seatStatusLabel}</span>
          {!seat.joined && (
            <button
              className="btn btn-primary"
              onClick={(event) => {
                event.stopPropagation();
                onJoin();
              }}
            >
              Join
            </button>
          )}
        </div>
      </div>

      {seat.joined && (
        <>
          <div className="seat-fields">
            <div>
              <label>Balance</label>
              <div className="static-field">
                {isOwner && sessionBalanceLabel ? `${sessionBalanceLabel} ${coinSymbol}` : `${fmt(seat.bankroll)} ${coinSymbol}`}
              </div>
            </div>
            {isOwner && sessionBuyInLabel && (
              <div>
                <label>Current buy-in</label>
                <div className="static-field">
                  {sessionBuyInLabel} {coinSymbol}
                </div>
              </div>
            )}
            {isOwner && sessionCommittedLabel && (
              <div>
                <label>Committed wager</label>
                <div className="static-field">
                  {sessionCommittedLabel} {coinSymbol}
                </div>
              </div>
            )}
            {!hasActiveSession && isOwner && <div className="subtle">Select this seat to buy in and play.</div>}
          </div>

          <div className="seat-hand">
            {seat.hands.length === 0 ? (
              <div className="seat-hand-cards">—</div>
            ) : (
              seat.hands.map((hand, handIndex) => {
                const totals = getHandTotals(hand);
                const handStatus = seat.handStatuses[handIndex] || "waiting";
                const bet = seat.bets[handIndex] ?? seat.bet;
                const isActiveHand = isActive && activeHandIndex === handIndex;
                const outcome = seat.lastOutcomes?.[handIndex];
                return (
                  <div key={`${seat.id}-${handIndex}`} className={`seat-hand-row ${isActiveHand ? "active" : ""}`}>
                    <div className="seat-hand-cards">{formatHand(hand)}</div>
                    <div className="subtle">
                      Bet: {fmt(bet)} {coinSymbol} · Total: {hand.length > 0 ? totals.total : "—"} · Status: {handStatus}
                    </div>
                    {outcome && <div className={`seat-outcome seat-outcome-${outcome}`}>{outcome.toUpperCase()}</div>}
                  </div>
                );
              })
            )}
            {seat.lastPayout && seat.lastPayout > 0 && (
              <div className="seat-payout">
                Payout: +{fmt(seat.lastPayout)} {coinSymbol}
              </div>
            )}
          </div>

          <div className="seat-odds">
            <div>
              Win: {odds.win.toFixed(1)}% · Push: {odds.push.toFixed(1)}% · Lose: {odds.lose.toFixed(1)}%
            </div>
            <div className="subtle">
              EV: {odds.ev >= 0 ? "+" : ""}
              {odds.ev.toFixed(2)}x per unit
            </div>
          </div>
        </>
      )}
    </div>
  );
}
