import { useCallback, useEffect, useMemo, useState } from "react";
import { parseUnits } from "../lib/tokens";
import { getVaultContract, vaultTokenAddress } from "../lib/vaultLedger";
import type { BlackjackHand, BlackjackSession, BlackjackTableState } from "../types/blackjack";

const SEAT_COUNT = 5;

const ACTION_LABELS: Record<string, string> = {
  hit: "Hit",
  stand: "Stand",
  double: "Double",
  split: "Split",
  surrender: "Surrender",
};

type BlackjackTableProps = {
  active: boolean;
  authFetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  wallet: string | null;
  walletProvider: any;
  isSignedIn: boolean;
  loginAddress: string | null;
  coinSymbol: string;
  coinDecimals: number;
};

function formatTokenAmount(raw: bigint, decimals: number) {
  if (decimals <= 0) return raw.toString();
  const base = BigInt(10) ** BigInt(decimals);
  const whole = raw / base;
  const fraction = raw % base;
  const fractionStr = fraction.toString().padStart(decimals, "0").slice(0, 4);
  return `${whole.toLocaleString()}.${fractionStr}`;
}

function getHandTotals(cards: BlackjackTableState["hands"][number]["cards"]) {
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
  const soft =
    cards.some((card) => card.rank === "A") &&
    total <= 21 &&
    cards.reduce((sum, c) => sum + c.value, 0) !== total;
  return { total, soft };
}

function formatCards(cards: BlackjackTableState["hands"][number]["cards"]) {
  if (!cards.length) return "—";
  return cards.map((card) => `${card.rank}${card.suit}`).join(" · ");
}

export default function BlackjackTable({
  active,
  authFetch,
  wallet,
  walletProvider,
  isSignedIn,
  loginAddress,
  coinSymbol,
  coinDecimals,
}: BlackjackTableProps) {
  const [session, setSession] = useState<BlackjackSession | null>(null);
  const [hand, setHand] = useState<BlackjackHand | null>(null);
  const [selectedSeatId, setSelectedSeatId] = useState<number | null>(null);
  const [buyInAmount, setBuyInAmount] = useState("");
  const [betAmount, setBetAmount] = useState("");
  const [vaultBalanceWei, setVaultBalanceWei] = useState<bigint | null>(null);
  const [vaultStatus, setVaultStatus] = useState("");
  const [settlementStatus, setSettlementStatus] = useState("");
  const [loading, setLoading] = useState(false);

  const refreshSession = useCallback(async () => {
    if (!isSignedIn) {
      setSession(null);
      setHand(null);
      return;
    }
    const response = await authFetch("/api/blackjack/session");
    const json = await response.json();
    if (!response.ok) {
      throw new Error(json?.error || "Failed to load session");
    }
    setSession(json.session || null);
    setHand(json.hand || null);
  }, [authFetch, isSignedIn]);

  const refreshVaultBalance = useCallback(async () => {
    if (!loginAddress || !isSignedIn) {
      setVaultBalanceWei(null);
      return;
    }
    const response = await authFetch(`/api/blackjack/balance?wallet=${encodeURIComponent(loginAddress)}`);
    const json = await response.json();
    if (!response.ok) {
      throw new Error(json?.error || "Failed to load vault balance");
    }
    setVaultBalanceWei(BigInt(json.available ?? json.balance ?? "0"));
  }, [authFetch, isSignedIn, loginAddress]);

  useEffect(() => {
    if (!active) return;
    setVaultStatus("");
    setSettlementStatus("");
    refreshSession().catch((e) => setVaultStatus(e?.message || "Failed to load session"));
    refreshVaultBalance().catch((e) => setVaultStatus(e?.message || "Failed to load vault balance"));
  }, [active, refreshSession, refreshVaultBalance]);

  useEffect(() => {
    if (session?.seatId !== undefined && session?.seatId !== null) {
      setSelectedSeatId(session.seatId);
    }
  }, [session]);

  const activeHandState = useMemo(() => {
    if (!hand?.stateJson?.hands?.length) return null;
    const index = Number.isInteger(hand.stateJson.activeHandIndex) ? hand.stateJson.activeHandIndex : 0;
    return hand.stateJson.hands[index] ?? null;
  }, [hand]);

  const canAct = Boolean(session && hand && hand.outcome === "PENDING" && activeHandState?.status === "playing");
  const canSplit =
    canAct &&
    activeHandState?.cards?.length === 2 &&
    hand?.stateJson?.hands?.length === 1 &&
    activeHandState.cards[0]?.rank === activeHandState.cards[1]?.rank;
  const canDouble = canAct && activeHandState?.cards?.length === 2;
  const canSurrender = canAct && activeHandState?.cards?.length === 2 && hand?.stateJson?.hands?.length === 1;

  const seatButtons = Array.from({ length: SEAT_COUNT }, (_, index) => {
    const isSelected = selectedSeatId === index;
    const isSessionSeat = session?.seatId === index;
    const disabled = Boolean(session && !isSessionSeat);
    return (
      <button
        key={index}
        className={`blackjack-seat ${isSelected ? "selected" : ""} ${isSessionSeat ? "owned" : ""}`}
        type="button"
        onClick={() => setSelectedSeatId(index)}
        disabled={disabled}
      >
        <div className="seat-title">Seat {index + 1}</div>
        <div className="seat-status">
          {isSessionSeat ? "Your seat" : isSelected ? "Selected" : "Open"}
        </div>
      </button>
    );
  });

  const handleBuyIn = async () => {
    if (!wallet || !walletProvider) {
      setVaultStatus("❌ Connect your wallet to buy in.");
      return;
    }
    if (!isSignedIn) {
      setVaultStatus("❌ Sign in before buying in.");
      return;
    }
    if (selectedSeatId === null) {
      setVaultStatus("❌ Select a seat to buy in.");
      return;
    }
    const amountWei = parseUnits(buyInAmount || "0", coinDecimals);
    if (amountWei <= 0n) {
      setVaultStatus("❌ Enter a valid buy-in amount.");
      return;
    }
    try {
      setLoading(true);
      setVaultStatus("⏳ Reserving your table buy-in...");
      const response = await authFetch("/api/blackjack/buyin", {
        method: "POST",
        body: JSON.stringify({ seatId: selectedSeatId, amountWei: amountWei.toString() }),
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || "Buy-in failed");
      }
      setSession(json.session || null);
      const lock = json.lock;
      const vault = await getVaultContract(walletProvider);
      if (!vault) {
        throw new Error("Vault Ledger not configured.");
      }
      setVaultStatus("⏳ Confirm the buy-in transaction...");
      const tx = await vault.contract.placeBet(lock.betId, vaultTokenAddress(), BigInt(lock.amountWei));
      await tx.wait();
      setVaultStatus("✅ Buy-in locked. You're seated!");
      await refreshSession();
      await refreshVaultBalance();
    } catch (e: any) {
      setVaultStatus(`❌ ${e?.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDeal = async () => {
    if (!session) {
      setVaultStatus("❌ Buy in before dealing.");
      return;
    }
    const amountWei = parseUnits(betAmount || "0", coinDecimals);
    if (amountWei <= 0n) {
      setVaultStatus("❌ Enter a valid bet amount.");
      return;
    }
    try {
      setLoading(true);
      setVaultStatus("⏳ Dealing a new hand...");
      const response = await authFetch("/api/blackjack/deal", {
        method: "POST",
        body: JSON.stringify({ betAmountWei: amountWei.toString() }),
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || "Deal failed");
      }
      setSession(json.session || null);
      setHand(json.hand || null);
      setVaultStatus("");
    } catch (e: any) {
      setVaultStatus(`❌ ${e?.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (action: string) => {
    try {
      setLoading(true);
      setVaultStatus(`⏳ ${ACTION_LABELS[action] || action}...`);
      const response = await authFetch("/api/blackjack/action", {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || "Action failed");
      }
      setSession(json.session || null);
      setHand(json.hand || null);
      setVaultStatus("");
    } catch (e: any) {
      setVaultStatus(`❌ ${e?.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleLeave = async () => {
    if (!session) return;
    try {
      setLoading(true);
      setSettlementStatus("");
      setVaultStatus("⏳ Settling your session...");
      const response = await authFetch("/api/blackjack/leave", { method: "POST" });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || "Leave failed");
      }
      setSettlementStatus(
        json?.settlement?.txHash
          ? `✅ Settlement confirmed: ${json.settlement.txHash}`
          : "✅ Session closed."
      );
      setSession(null);
      setHand(null);
      await refreshVaultBalance();
      setVaultStatus("");
    } catch (e: any) {
      setVaultStatus(`❌ ${e?.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const dealerCards = hand?.stateJson?.dealer ?? [];
  const dealerTotals = dealerCards.length ? getHandTotals(dealerCards) : null;

  return (
    <section className="card blackjack-card">
      <div className="blackjack-header">
        <div>
          <div className="section-title">Blackjack Table</div>
          <div className="subtle">
            Session-based table · One lock tx to buy in · Off-chain gameplay · One settle tx to leave.
          </div>
        </div>
        {session && (
          <button className="btn btn-ghost" type="button" onClick={handleLeave} disabled={loading}>
            Leave &amp; settle
          </button>
        )}
      </div>

      <div className="blackjack-meta">
        <div>
          <div className="label">Vault balance</div>
          <div className="title">
            {vaultBalanceWei !== null ? `${formatTokenAmount(vaultBalanceWei, coinDecimals)} ${coinSymbol}` : "—"}
          </div>
          <div className="subtle">Available for blackjack buy-ins.</div>
        </div>
        <div>
          <div className="label">Session bankroll</div>
          <div className="title">
            {session ? `${formatTokenAmount(BigInt(session.bankrollWei), coinDecimals)} ${coinSymbol}` : "—"}
          </div>
          <div className="subtle">Updated after each hand settles.</div>
        </div>
        <div>
          <div className="label">Seat</div>
          <div className="title">{session ? `Seat ${session.seatId + 1}` : "Not seated"}</div>
          <div className="subtle">Pick a seat and buy in to join.</div>
        </div>
        <div>
          <div className="label">Hand status</div>
          <div className="title">{hand ? hand.outcome.replace(/_/g, " ") : "Waiting"}</div>
          <div className="subtle">Dealer hits soft 17 · Blackjack pays 3:2.</div>
        </div>
      </div>

      {vaultStatus && <div className="toast">{vaultStatus}</div>}
      {settlementStatus && <div className="toast">{settlementStatus}</div>}

      <div className="blackjack-layout">
        <div className="blackjack-table-panel">
          <div className="dealer-row">
            <div className="dealer-title">Dealer</div>
            <div className="dealer-hand">
              {!dealerCards.length ? (
                <span>—</span>
              ) : hand?.stateJson?.phase === "player" ? (
                <span>{dealerCards[0] ? `${dealerCards[0].rank}${dealerCards[0].suit}` : "—"} · ??</span>
              ) : (
                <span>{formatCards(dealerCards)}</span>
              )}
            </div>
            <div className="dealer-total">
              {!dealerTotals
                ? "Total: —"
                : hand?.stateJson?.phase === "player"
                ? "Total: ?"
                : `Total: ${dealerTotals.total}${dealerTotals.soft ? " (soft)" : ""}`}
            </div>
          </div>

          <div className="player-row">
            <div className="player-title">Player</div>
            <div className="player-hands">
              {hand?.stateJson?.hands?.length ? (
                hand.stateJson.hands.map((playerHand, index) => {
                  const totals = getHandTotals(playerHand.cards);
                  return (
                    <div
                      key={`${hand.id}-${index}`}
                      className={`player-hand ${index === hand.stateJson.activeHandIndex ? "active" : ""}`}
                    >
                      <div className="hand-header">
                        <span>Hand {index + 1}</span>
                        <span className="hand-status">{playerHand.status}</span>
                      </div>
                      <div className="hand-cards">{formatCards(playerHand.cards)}</div>
                      <div className="hand-meta">
                        <span>
                          Total: {totals.total}
                          {totals.soft ? " (soft)" : ""}
                        </span>
                        <span>
                          Bet: {formatTokenAmount(BigInt(playerHand.betWei), coinDecimals)} {coinSymbol}
                        </span>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="subtle">No active hand yet. Deal to begin.</div>
              )}
            </div>
          </div>
        </div>

        <div className="blackjack-seats-panel">
          <div className="section-title">Seats</div>
          <div className="blackjack-seats-grid">{seatButtons}</div>
        </div>
      </div>

      <div className="blackjack-controls">
        <div className="blackjack-controls-grid">
          {!session && (
            <div className="control-group">
              <label htmlFor="blackjack-buyin">Buy-in amount</label>
              <input
                id="blackjack-buyin"
                type="number"
                min="0"
                step="any"
                value={buyInAmount}
                onChange={(e) => setBuyInAmount(e.target.value)}
                placeholder={`0.0 ${coinSymbol}`}
              />
              <button className="btn" type="button" onClick={handleBuyIn} disabled={loading}>
                Buy in &amp; lock
              </button>
            </div>
          )}

          {session && hand?.outcome !== "PENDING" && (
            <div className="control-group">
              <div className="label">Last payout</div>
              <div className="title">
                {formatTokenAmount(BigInt(hand.payoutWei), coinDecimals)} {coinSymbol}
              </div>
              <div className="subtle">Net change applied to bankroll.</div>
            </div>
          )}

          {session && (!hand || hand.outcome !== "PENDING") && (
            <div className="control-group">
              <label htmlFor="blackjack-bet">Bet per hand</label>
              <input
                id="blackjack-bet"
                type="number"
                min="0"
                step="any"
                value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)}
                placeholder={`0.0 ${coinSymbol}`}
              />
              <button className="btn" type="button" onClick={handleDeal} disabled={loading}>
                Deal
              </button>
            </div>
          )}

          {session && hand?.outcome === "PENDING" && (
            <div className="control-group">
              <div className="label">Actions</div>
              <div className="blackjack-actions-row">
                <button className="btn" type="button" onClick={() => handleAction("hit")} disabled={!canAct || loading}>
                  Hit
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => handleAction("stand")}
                  disabled={!canAct || loading}
                >
                  Stand
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => handleAction("double")}
                  disabled={!canDouble || loading}
                >
                  Double
                </button>
                <button
                  className="btn"
                  type="button"
                  onClick={() => handleAction("split")}
                  disabled={!canSplit || loading}
                >
                  Split
                </button>
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => handleAction("surrender")}
                  disabled={!canSurrender || loading}
                >
                  Surrender
                </button>
              </div>
            </div>
          )}

          {session && (
            <div className="control-group">
              <div className="label">Session</div>
              <div className="subtle">Buy-in: {formatTokenAmount(BigInt(session.buyInAmountWei), coinDecimals)} {coinSymbol}</div>
              <div className="subtle">Seat: {session.seatId + 1}</div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
