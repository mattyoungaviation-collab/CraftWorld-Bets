import { useCallback, useEffect, useMemo, useState } from "react";
import { parseUnits, formatUnits, DYNW_TOKEN } from "../lib/tokens";
import { getVaultContract, vaultTokenAddress } from "../lib/vaultLedger";

const COIN_SYMBOL = DYNW_TOKEN.symbol;

type BlackjackSession = {
  id: string;
  walletAddress: string;
  seatId: number;
  buyInAmountWei: string;
  bankrollWei: string;
  status: "OPEN" | "CLOSED";
};

type BlackjackHand = {
  id: string;
  betAmountWei: string;
  stateJson: BlackjackHandState;
  outcome: string;
  payoutWei: string;
};

type BlackjackHandState = {
  shoe: Card[];
  dealerHand: Card[];
  playerHands: Card[][];
  handStatuses: string[];
  handBets: string[];
  activeHand: number;
  dealerRevealed: boolean;
  phase: "player" | "dealer" | "settled";
  handResults?: Array<{ outcome: string; payoutWei: string }>;
};

type Card = {
  rank: string;
  suit: string;
  value: number;
};

type BlackjackTableProps = {
  authFetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>;
  wallet: string | null;
  walletProvider: unknown;
  isSignedIn: boolean;
};

function formatTokenAmount(value: string | null) {
  if (!value) return "—";
  try {
    return formatUnits(BigInt(value), DYNW_TOKEN.decimals);
  } catch {
    return "—";
  }
}

function formatHand(cards: Card[], hideHole = false) {
  if (!cards?.length) return "—";
  return cards
    .map((card, index) => {
      if (hideHole && index === 1) return "??";
      return `${card.rank}${card.suit}`;
    })
    .join(" · ");
}

export default function BlackjackTable({ authFetch, wallet, walletProvider, isSignedIn }: BlackjackTableProps) {
  const [session, setSession] = useState<BlackjackSession | null>(null);
  const [hand, setHand] = useState<BlackjackHand | null>(null);
  const [vaultLocked, setVaultLocked] = useState<string | null>(null);
  const [vaultAvailable, setVaultAvailable] = useState<string | null>(null);
  const [buyInAmount, setBuyInAmount] = useState("");
  const [betAmount, setBetAmount] = useState("");
  const [selectedSeat, setSelectedSeat] = useState(0);
  const [status, setStatus] = useState("");
  const [settlement, setSettlement] = useState<string>("");

  const refreshSession = useCallback(async () => {
    if (!isSignedIn) {
      setSession(null);
      setHand(null);
      return;
    }
    const response = await authFetch("/api/blackjack/session");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || "Failed to load blackjack session");
    }
    setSession(payload.session || null);
    setHand(payload.hand || null);
    if (payload.session?.seatId !== undefined) {
      setSelectedSeat(payload.session.seatId);
    }
  }, [authFetch, isSignedIn]);

  const refreshBalance = useCallback(async () => {
    if (!isSignedIn) {
      setVaultLocked(null);
      setVaultAvailable(null);
      return;
    }
    const response = await authFetch("/api/blackjack/balance");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || "Failed to load vault balance");
    }
    setVaultLocked(payload.locked || null);
    setVaultAvailable(payload.available || null);
  }, [authFetch, isSignedIn]);

  useEffect(() => {
    refreshSession().catch((error) => setStatus(`❌ ${error.message}`));
    refreshBalance().catch((error) => setStatus(`❌ ${error.message}`));
  }, [refreshBalance, refreshSession]);

  const blackjackState = hand?.stateJson || null;
  const activeHandIndex = blackjackState?.activeHand ?? 0;
  const activeHand = blackjackState?.playerHands?.[activeHandIndex] || [];
  const activeStatus = blackjackState?.handStatuses?.[activeHandIndex] || "";
  const activeBetWei = BigInt(blackjackState?.handBets?.[activeHandIndex] || "0");
  const bankrollWei = BigInt(session?.bankrollWei || "0");

  const canHit = Boolean(blackjackState && blackjackState.phase === "player" && activeStatus === "playing");
  const canStand = canHit;
  const canDouble =
    canHit && activeHand.length === 2 && activeBetWei * 2n <= bankrollWei;
  const canSplit =
    canHit &&
    activeHand.length === 2 &&
    blackjackState?.playerHands?.length === 1 &&
    activeHand[0]?.rank === activeHand[1]?.rank &&
    activeBetWei * 2n <= bankrollWei;
  const canSurrender = canHit && activeHand.length === 2 && blackjackState?.playerHands?.length === 1;

  const handleBuyIn = async () => {
    if (!wallet || !isSignedIn) {
      setStatus("❌ Connect and sign in to buy in.");
      return;
    }
    try {
      setStatus("⏳ Reserving buy-in...");
      const amountWei = parseUnits(buyInAmount || "0", DYNW_TOKEN.decimals);
      if (amountWei <= 0n) {
        setStatus("❌ Enter a valid buy-in amount.");
        return;
      }
      const response = await authFetch("/api/blackjack/buyin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seatId: selectedSeat, amountWei: amountWei.toString() }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || "Buy-in failed");
      }

      const instruction = payload.instruction;
      if (!instruction?.betId) {
        throw new Error("Buy-in instruction missing betId");
      }
      const vault = await getVaultContract(walletProvider);
      if (!vault?.contract) {
        throw new Error("Vault contract unavailable");
      }
      setStatus("⏳ Confirm the buy-in signature...");
      const tx = await vault.contract.placeBet(instruction.betId, vaultTokenAddress(), BigInt(instruction.amountWei));
      await tx.wait();
      setStatus("✅ Buy-in confirmed.");
      await refreshSession();
      await refreshBalance();
    } catch (error: any) {
      setStatus(`❌ ${error?.message || error}`);
    }
  };

  const handleDeal = async () => {
    if (!session) {
      setStatus("❌ Open a session first.");
      return;
    }
    try {
      setStatus("⏳ Dealing a hand...");
      const amountWei = parseUnits(betAmount || "0", DYNW_TOKEN.decimals);
      if (amountWei <= 0n) {
        setStatus("❌ Enter a valid bet amount.");
        return;
      }
      const response = await authFetch("/api/blackjack/deal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ betAmountWei: amountWei.toString() }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || "Deal failed");
      }
      setHand(payload.hand || null);
      setSession(payload.session || null);
      setStatus("");
    } catch (error: any) {
      setStatus(`❌ ${error?.message || error}`);
    }
  };

  const handleAction = async (action: string) => {
    if (!session) return;
    try {
      setStatus("⏳ Updating hand...");
      const response = await authFetch("/api/blackjack/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || "Action failed");
      }
      setHand(payload.hand || null);
      setSession(payload.session || null);
      setStatus("");
    } catch (error: any) {
      setStatus(`❌ ${error?.message || error}`);
    }
  };

  const handleLeave = async () => {
    if (!session) return;
    try {
      setStatus("⏳ Settling session...");
      const response = await authFetch("/api/blackjack/leave", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || "Leave failed");
      }
      if (payload.txHash) {
        setSettlement(`✅ Settlement confirmed: ${payload.txHash}`);
      }
      setSession(null);
      setHand(null);
      await refreshBalance();
      setStatus("");
    } catch (error: any) {
      setStatus(`❌ ${error?.message || error}`);
    }
  };

  const dealerHand = blackjackState?.dealerHand || [];
  const playerHands = blackjackState?.playerHands || [];

  const betSummary = useMemo(() => {
    if (!hand) return "—";
    return formatTokenAmount(hand.betAmountWei);
  }, [hand]);

  return (
    <section className="card blackjack-card">
      <div className="blackjack-header">
        <div>
          <div className="section-title">Blackjack Table</div>
          <div className="section-subtitle">
            Session-based table · Dealer hits soft 17 · Blackjack pays 3:2.
          </div>
        </div>
      </div>

      <div className="blackjack-meta">
        <div className="meta-block">
          <div className="label">Vault Available</div>
          <div className="title">
            {vaultAvailable ? `${formatTokenAmount(vaultAvailable)} ${COIN_SYMBOL}` : "—"}
          </div>
          <div className="subtext">
            Locked: {vaultLocked ? `${formatTokenAmount(vaultLocked)} ${COIN_SYMBOL}` : "—"}
          </div>
        </div>
        <div className="meta-block">
          <div className="label">Session Bankroll</div>
          <div className="title">
            {session ? `${formatTokenAmount(session.bankrollWei)} ${COIN_SYMBOL}` : "—"}
          </div>
          <div className="subtext">Seat {session ? session.seatId + 1 : "—"}</div>
        </div>
        <div className="meta-block">
          <div className="label">Current Bet</div>
          <div className="title">{betSummary === "—" ? "—" : `${betSummary} ${COIN_SYMBOL}`}</div>
          <div className="subtext">Status: {hand?.outcome || "Idle"}</div>
        </div>
      </div>

      {status && <div className="toast">{status}</div>}
      {settlement && <div className="toast">{settlement}</div>}

      <div className="blackjack-layout">
        <div className="blackjack-table-panel">
          <div className="blackjack-table">
            <div className="hand-block">
              <div className="hand-title">Dealer</div>
              <div className="hand-cards">
                {formatHand(dealerHand, !blackjackState?.dealerRevealed && blackjackState?.phase === "player")}
              </div>
            </div>
            <div className="hand-block">
              <div className="hand-title">Player</div>
              {playerHands.length === 0 ? (
                <div className="hand-cards">—</div>
              ) : (
                playerHands.map((cards, index) => (
                  <div key={`hand-${index}`} className={`hand-row ${index === activeHandIndex ? "active" : ""}`}>
                    <div className="hand-label">Hand {index + 1}</div>
                    <div className="hand-cards">{formatHand(cards)}</div>
                    <div className="hand-outcome">
                      {blackjackState?.handResults?.[index]?.outcome || blackjackState?.handStatuses?.[index] || ""}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="blackjack-seats-panel">
          <div className="blackjack-seats-grid">
            {Array.from({ length: 5 }, (_, index) => {
              const isSelected = selectedSeat === index;
              const isOwned = session?.seatId === index;
              return (
                <button
                  key={`seat-${index}`}
                  type="button"
                  className={`seat-card ${isSelected ? "selected" : ""} ${isOwned ? "owned" : ""}`}
                  onClick={() => setSelectedSeat(index)}
                >
                  <div className="seat-title">Seat {index + 1}</div>
                  <div className="seat-status">{isOwned ? "Your seat" : "Open"}</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="blackjack-controls">
        {!session && (
          <div className="controls-row">
            <div className="control-field">
              <label>Buy-in ({COIN_SYMBOL})</label>
              <input
                value={buyInAmount}
                onChange={(event) => setBuyInAmount(event.target.value)}
                placeholder="0.0"
                inputMode="decimal"
              />
            </div>
            <button className="btn" onClick={handleBuyIn} disabled={!isSignedIn || !wallet}>
              Buy in
            </button>
          </div>
        )}
        {session && !hand && (
          <div className="controls-row">
            <div className="control-field">
              <label>Bet ({COIN_SYMBOL})</label>
              <input
                value={betAmount}
                onChange={(event) => setBetAmount(event.target.value)}
                placeholder="0.0"
                inputMode="decimal"
              />
            </div>
            <button className="btn" onClick={handleDeal}>
              Deal
            </button>
          </div>
        )}
        {session && hand && blackjackState?.phase === "player" && (
          <div className="controls-row actions">
            <button className="btn" onClick={() => handleAction("hit")} disabled={!canHit}>
              Hit
            </button>
            <button className="btn" onClick={() => handleAction("stand")} disabled={!canStand}>
              Stand
            </button>
            <button className="btn" onClick={() => handleAction("double")} disabled={!canDouble}>
              Double
            </button>
            <button className="btn" onClick={() => handleAction("split")} disabled={!canSplit}>
              Split
            </button>
            <button className="btn" onClick={() => handleAction("surrender")} disabled={!canSurrender}>
              Surrender
            </button>
          </div>
        )}
        {session && (
          <div className="controls-row">
            <button className="btn secondary" onClick={handleLeave}>
              Leave table
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
