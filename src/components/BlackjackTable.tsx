import { useCallback, useEffect, useMemo, useState } from "react";
import { parseUnits } from "../lib/tokens";
import { useVaultLedgerBalance } from "../lib/useVaultLedgerBalance";
import { getVaultContract, vaultTokenAddress } from "../lib/vaultLedger";
import type { BlackjackHand, BlackjackSession } from "../types/blackjack";

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

function cardRank(card: string) {
  return card.slice(0, -1);
}

function cardValue(rank: string) {
  if (rank === "A") return 11;
  if (["K", "Q", "J"].includes(rank)) return 10;
  const value = Number(rank);
  return Number.isNaN(value) ? 0 : value;
}

function getHandTotals(cards: string[]) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    const rank = cardRank(card);
    total += cardValue(rank);
    if (rank === "A") aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  const soft = aces > 0;
  return { total, soft };
}

function formatCards(cards: string[]) {
  if (!cards.length) return "—";
  return cards.join(" · ");
}

export default function BlackjackTable({
  active,
  authFetch,
  wallet,
  walletProvider,
  isSignedIn,
  coinSymbol,
  coinDecimals,
}: BlackjackTableProps) {
  const [session, setSession] = useState<BlackjackSession | null>(null);
  const [hand, setHand] = useState<BlackjackHand | null>(null);
  const [selectedSeatId, setSelectedSeatId] = useState<number | null>(null);
  const [buyInAmount, setBuyInAmount] = useState("");
  const [betAmount, setBetAmount] = useState("");
  const [vaultBalanceWei, setVaultBalanceWei] = useState<bigint | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [settlementMessage, setSettlementMessage] = useState("");
  const [settlementTxHash, setSettlementTxHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { vaultBalance, vaultLocked, refresh: refreshVaultBalance } = useVaultLedgerBalance(wallet, walletProvider);
  const availableVaultWei =
    vaultBalance !== null && vaultLocked !== null ? vaultBalance - vaultLocked : vaultBalance;

  const vaultWalletAddress = loginAddress || wallet;
  const { vaultBalance, vaultLocked, refresh: refreshVaultBalance } = useVaultLedgerBalance(
    vaultWalletAddress,
    walletProvider,
  );

  const availableVaultWei =
    vaultBalance !== null && vaultLocked !== null && vaultBalance > vaultLocked
      ? vaultBalance - vaultLocked
      : vaultBalance;

  const vaultWalletAddress = loginAddress || wallet;
  const {
    vaultBalance: vaultBalanceWei,
    vaultLocked: vaultLockedWei,
    refresh: refreshVaultBalance,
  } = useVaultLedgerBalance(
    vaultWalletAddress,
    walletProvider,
  );

  const availableVaultBalanceWei =
    vaultBalanceWei !== null && vaultLockedWei !== null && vaultBalanceWei > vaultLockedWei
      ? vaultBalanceWei - vaultLockedWei
      : vaultBalanceWei;

  const ledgerWalletAddress = loginAddress || wallet;
  const {
    vaultBalance: ledgerBalanceWei,
    vaultLocked: ledgerLockedWei,
    refresh: refreshVaultLedger,
  } = useVaultLedgerBalance(
    ledgerWalletAddress,
    walletProvider,
  );

  const availableLedgerBalanceWei =
    ledgerBalanceWei !== null && ledgerLockedWei !== null && ledgerBalanceWei > ledgerLockedWei
      ? ledgerBalanceWei - ledgerLockedWei
      : ledgerBalanceWei;

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
    const response = await authFetch("/api/blackjack/balance");
    const json = await response.json();
    if (!response.ok) {
      throw new Error(json?.error || "Failed to load vault balance");
    }
    setVaultBalanceWei(BigInt(json.available ?? json.balance ?? "0"));
  }, [authFetch, isSignedIn, loginAddress]);

  useEffect(() => {
    if (!active) return;
    setStatusMessage("");
    setSettlementMessage("");
    setSettlementTxHash(null);
    refreshSession().catch((e) => setStatusMessage(e?.message || "Failed to load session"));
    refreshVaultBalance().catch((e) => setStatusMessage(e?.message || "Failed to load vault balance"));
  }, [active, refreshSession, refreshVaultBalance]);

  useEffect(() => {
    if (session?.seatId !== undefined && session?.seatId !== null) {
      setSelectedSeatId(session.seatId);
    }
  }, [session]);

  const handState = hand?.stateJson;
  const playerCards = handState?.playerCards ?? [];
  const dealerCards = handState?.dealerCards ?? [];
  const playerTotals = useMemo(() => (playerCards.length ? getHandTotals(playerCards) : null), [playerCards]);
  const dealerTotals = useMemo(() => (dealerCards.length ? getHandTotals(dealerCards) : null), [dealerCards]);
  const showDealerHole = handState?.phase === "player";
  const sessionBankrollWei = session ? BigInt(session.bankrollWei) : null;

  const canAct =
    Boolean(session && hand && hand.outcome === "PENDING") &&
    handState?.phase === "player" &&
    handState?.playerState === "playing";
  const canDouble =
    canAct &&
    playerCards.length === 2 &&
    sessionBankrollWei !== null &&
    hand &&
    sessionBankrollWei >= BigInt(hand.betAmountWei) * 2n;
  const canSurrender = canAct && playerCards.length === 2;
  const canSplit = false;

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
        <div className="seat-status">{isSessionSeat ? "Your seat" : isSelected ? "Selected" : "Open"}</div>
      </button>
    );
  });

  const handleBuyIn = async () => {
    if (!wallet || !walletProvider) {
      setStatusMessage("❌ Connect your wallet to buy in.");
      return;
    }
    if (!isSignedIn) {
      setStatusMessage("❌ Sign in before buying in.");
      return;
    }
    if (selectedSeatId === null) {
      setStatusMessage("❌ Select a seat to buy in.");
      return;
    }
    const amountWei = parseUnits(buyInAmount || "0", coinDecimals);
    if (amountWei <= 0n) {
      setStatusMessage("❌ Enter a valid buy-in amount.");
      return;
    }
    try {
      setLoading(true);
      setStatusMessage("⏳ Reserving your table buy-in...");
      const response = await authFetch("/api/blackjack/buyin", {
        method: "POST",
        body: JSON.stringify({ seatId: selectedSeatId, amountWei: amountWei.toString() }),
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || "Buy-in failed");
      }
      const lock = json.lock;
      const vault = await getVaultContract(walletProvider);
      if (!vault) {
        throw new Error("Vault Ledger not configured.");
      }
      setStatusMessage("⏳ Confirm the buy-in transaction...");
      const tx = await vault.contract.placeBet(lock.betId, vaultTokenAddress(), BigInt(lock.amountWei));
      await tx.wait();
      setStatusMessage("✅ Buy-in locked. You're seated!");
      await refreshSession();
      refreshVaultLedger();
    } catch (e: any) {
      setStatusMessage(`❌ ${e?.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDeal = async () => {
    if (!session) {
      setStatusMessage("❌ Buy in before dealing.");
      return;
    }
    const amountWei = parseUnits(betAmount || "0", coinDecimals);
    if (amountWei <= 0n) {
      setStatusMessage("❌ Enter a valid bet amount.");
      return;
    }
    try {
      setLoading(true);
      setStatusMessage("⏳ Dealing a new hand...");
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
      setStatusMessage("");
    } catch (e: any) {
      setStatusMessage(`❌ ${e?.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (action: string) => {
    try {
      setLoading(true);
      setStatusMessage(`⏳ ${ACTION_LABELS[action] || action}...`);
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
      setStatusMessage("");
    } catch (e: any) {
      setStatusMessage(`❌ ${e?.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleLeave = async () => {
    if (!session) return;
    try {
      setLoading(true);
      setSettlementMessage("");
      setSettlementTxHash(null);
      setStatusMessage("⏳ Settling your session...");
      const response = await authFetch("/api/blackjack/leave", { method: "POST" });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(json?.error || "Leave failed");
      }
      const txHash = json?.settlement?.txHash;
      setSettlementTxHash(txHash || null);
      setSettlementMessage(txHash ? "✅ Settlement confirmed." : "✅ Session closed.");
      setSession(null);
      setHand(null);
      await refreshVaultBalance();
      setStatusMessage("");
    } catch (e: any) {
      setStatusMessage(`❌ ${e?.message || String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  const dealerCards = hand?.stateJson?.dealer ?? [];
  const dealerTotals = dealerCards.length ? getHandTotals(dealerCards) : null;
  const showDealerHole = hand?.stateJson?.phase === "player";

  return (
    <section className="card blackjack-card">
      <div className="blackjack-header">
        <div>
          <div className="section-title">Blackjack Table</div>
          <div className="subtle">
            Session table · Buy in once · Play off-chain · Settle on leave.
          </div>
        </div>
        <div className="blackjack-header-actions">
          {session && (
            <button className="btn btn-ghost" type="button" onClick={handleLeave} disabled={loading}>
              Leave &amp; settle
            </button>
          )}
        </div>
      </div>

      <div className="blackjack-status-grid">
        <div className="status-card">
          <div className="label">Vault balance</div>
          <div className="title">
            {availableLedgerBalanceWei !== null
              ? `${formatTokenAmount(availableLedgerBalanceWei, coinDecimals)} ${coinSymbol}`
              : "—"}
          </div>
          <div className="subtle">Available for blackjack buy-ins.</div>
        </div>
        <div className="status-card">
          <div className="label">Session bankroll</div>
          <div className="title">
            {session ? `${formatTokenAmount(BigInt(session.bankrollWei), coinDecimals)} ${coinSymbol}` : "—"}
          </div>
          <div className="subtle">Updated after each hand settles.</div>
        </div>
        <div className="status-card">
          <div className="label">Seat</div>
          <div className="title">{session ? `Seat ${session.seatId + 1}` : "Not seated"}</div>
          <div className="subtle">Select a seat and buy in to join.</div>
        </div>
        <div className="status-card">
          <div className="label">Hand status</div>
          <div className="title">{handStatus}</div>
          <div className="subtle">Dealer hits soft 17 · Blackjack pays 3:2.</div>
        </div>
        <div className="summary-card">
          <div className="label">Buy-in</div>
          <div className="title">
            {session ? `${formatTokenAmount(BigInt(session.buyInAmountWei), coinDecimals)} ${coinSymbol}` : "—"}
          </div>
          <div className="subtle">Locked on-chain at seat open.</div>
        </div>
      </div>

      {statusMessage && <div className="toast">{statusMessage}</div>}
      {settlementMessage && (
        <div className="toast">
          <div>{settlementMessage}</div>
          {settlementTxHash && (
            <a
              href={`https://explorer.roninchain.com/tx/${settlementTxHash}`}
              target="_blank"
              rel="noreferrer"
            >
              View settlement transaction
            </a>
          )}
        </div>
      )}

      <div className="blackjack-layout">
        <div className="blackjack-table-panel">
          <div className="dealer-row">
            <div className="dealer-title">Dealer</div>
            <div className="dealer-hand">
              {!dealerCards.length ? (
                <span>—</span>
              ) : showDealerHole ? (
                <span>{dealerCards[0] ? `${dealerCards[0].rank}${dealerCards[0].suit}` : "—"} · ??</span>
              ) : (
                <span>{formatCards(dealerCards)}</span>
              )}
            </div>
            <div className="dealer-total">
              {!dealerTotals
                ? "Total: —"
                : showDealerHole
                ? "Total: ?"
                : `Total: ${dealerTotals.total}${dealerTotals.soft ? " (soft)" : ""}`}
            </div>
          </div>

          <div className="player-row">
            <div className="player-title">Player</div>
            <div className="player-hands">
              {handState ? (
                <div className="player-hand active">
                  <div className="hand-header">
                    <span>Your hand</span>
                    <span className="hand-status">{handState.playerState}</span>
                  </div>
                  <div className="hand-cards">{formatCards(playerCards)}</div>
                  <div className="hand-meta">
                    <span>
                      Total: {playerTotals ? playerTotals.total : "—"}
                      {playerTotals?.soft ? " (soft)" : ""}
                    </span>
                    <span>
                      Bet: {hand ? formatTokenAmount(BigInt(hand.betAmountWei), coinDecimals) : "—"} {coinSymbol}
                    </span>
                  </div>
                </div>
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
                <button className="btn" type="button" disabled={!canSplit || loading}>
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

          {session && hand && hand.outcome !== "PENDING" && (
            <div className="control-group">
              <div className="label">Last payout</div>
              <div className="title">
                {formatTokenAmount(BigInt(hand.payoutWei), coinDecimals)} {coinSymbol}
              </div>
              <div className="subtle">Net change applied to bankroll.</div>
            </div>
          )}

          {session && (
            <div className="control-group">
              <div className="label">Session</div>
              <div className="subtle">
                Buy-in: {formatTokenAmount(BigInt(session.buyInAmountWei), coinDecimals)} {coinSymbol}
              </div>
              <div className="subtle">Seat: {session.seatId + 1}</div>
              <button className="btn btn-ghost" type="button" onClick={handleLeave} disabled={loading}>
                Leave table
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
