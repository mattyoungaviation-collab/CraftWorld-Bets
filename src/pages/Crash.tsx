import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { id } from "ethers";
import { io } from "socket.io-client";
import { cashoutCrash, placeCrashBet } from "../lib/apiCrash";
import { DYNW_TOKEN, formatUnits, parseUnits, shortAddress } from "../lib/tokens";
import { getVaultContract, vaultTokenAddress } from "../lib/vaultLedger";
import { useVaultLedgerBalance } from "../lib/useVaultLedgerBalance";
import { useWallet } from "../lib/wallet";
import "./Crash.css";

type CrashBet = {
  address: string;
  amount: number;
  amountWei: string;
  placedAt: number;
  cashedOut: boolean;
  cashoutMultiplier?: number | null;
  payout?: number | null;
  payoutWei?: string | null;
};

type CrashState = {
  phase: string;
  roundId: string | null;
  roundNumber?: number;
  commitHash?: string | null;
  serverSeed?: string | null;
  crashPoint?: number | null;
  crashPointRaw?: number | null;
  derivedHash?: string | null;
  u?: string | null;
  bettingClosesAt?: number | null;
  runningStartedAt?: number | null;
  crashedAt?: number | null;
  cooldownEndsAt?: number | null;
  currentMultiplier?: number;
  bets?: CrashBet[];
};

type CrashVerify = {
  roundId: string;
  commitHash: string;
  serverSeed: string;
  derivedHash: string;
  u: string;
  crashPoint: number;
};

const MIN_BET = 10;
const MAX_BET = 2500;

function formatMultiplier(value: number) {
  return `${value.toFixed(2)}x`;
}

function formatAmount(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export default function Crash() {
  const { wallet, provider: walletProvider, connectWallet, disconnectWallet, walletConnectEnabled } = useWallet();
  const { vaultBalance, vaultLocked, refresh: refreshVaultBalance } = useVaultLedgerBalance(wallet, walletProvider);
  const [state, setState] = useState<CrashState>({ phase: "BETTING", roundId: null });
  const [multiplier, setMultiplier] = useState(0.5);
  const [amount, setAmount] = useState(50);
  const [bets, setBets] = useState<CrashBet[]>([]);
  const [cashouts, setCashouts] = useState<CrashBet[]>([]);
  const [toast, setToast] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [verify, setVerify] = useState<CrashVerify | null>(null);

  const [authToken] = useState(() => localStorage.getItem("cw_bets_token") || "");
  const [loginAddress] = useState(() => localStorage.getItem("cw_bets_login") || "");
  const isSignedIn = Boolean(authToken && loginAddress);

  const currentMultiplier = state.phase === "CRASHED" && state.crashPoint ? state.crashPoint : multiplier;
  const normalizedMultiplier = Number.isFinite(currentMultiplier) ? currentMultiplier : 0.5;

  const userBet = useMemo(() => {
    if (!loginAddress) return null;
    return bets.find((bet) => bet.address.toLowerCase() === loginAddress.toLowerCase()) || null;
  }, [bets, loginAddress]);

  const canBet = state.phase === "BETTING" && !userBet;
  const canCashout = state.phase === "RUNNING" && userBet && !userBet.cashedOut;

  useEffect(() => {
    const nextSocket = io({ withCredentials: true });

    nextSocket.on("crash:state", (payload: CrashState) => {
      setState(payload);
      setMultiplier(payload.currentMultiplier ?? 0.5);
      const incoming = payload.bets || [];
      setBets(incoming);
      setCashouts(incoming.filter((bet) => bet.cashedOut));
      if (payload.serverSeed && payload.commitHash && payload.derivedHash && payload.u && payload.crashPointRaw) {
        setVerify({
          roundId: payload.roundId || "",
          commitHash: payload.commitHash,
          serverSeed: payload.serverSeed,
          derivedHash: payload.derivedHash,
          u: payload.u,
          crashPoint: payload.crashPointRaw,
        });
      }
    });

    nextSocket.on("crash:tick", ({ multiplier: nextMultiplier }) => {
      setMultiplier(nextMultiplier);
    });

    nextSocket.on("crash:bet", (bet: CrashBet) => {
      setBets((prev) => {
        const updated = prev.filter((entry) => entry.address !== bet.address);
        return [...updated, { ...bet, cashedOut: false }];
      });
    });

    nextSocket.on("crash:cashout", ({ address, multiplier: cashMultiplier, payout }) => {
      setBets((prev) =>
        prev.map((bet) =>
          bet.address === address
            ? { ...bet, cashedOut: true, cashoutMultiplier: cashMultiplier, payout }
            : bet
        )
      );
      if (address.toLowerCase() === loginAddress.toLowerCase()) {
        refreshVaultBalance();
      }
    });

    nextSocket.on("crash:crash", ({ verify: verifyPayload }) => {
      if (verifyPayload) {
        setVerify(verifyPayload);
      }
    });

    nextSocket.emit("crash:state:request");

    return () => {
      nextSocket.disconnect();
    };
  }, [loginAddress, refreshVaultBalance]);

  useEffect(() => {
    if (state.bets) {
      setBets(state.bets);
    }
  }, [state.bets]);

  useEffect(() => {
    setCashouts(bets.filter((bet) => bet.cashedOut));
  }, [bets]);

  const potentialPayout = useMemo(() => {
    if (!Number.isFinite(amount)) return 0;
    return amount * normalizedMultiplier;
  }, [amount, normalizedMultiplier]);

  async function handleWalletAction() {
    setToast("");
    try {
      if (wallet) {
        await disconnectWallet();
      } else {
        await connectWallet();
      }
    } catch (e: any) {
      setToast(`❌ ${e?.message || String(e)}`);
    }
  }

  async function handlePlaceBet() {
    setToast("");
    if (!isSignedIn) {
      setToast("Sign in on the main page before placing a crash bet.");
      return;
    }
    if (!walletProvider || !wallet) {
      setToast("Connect your wallet to place a bet.");
      return;
    }
    if (!state.roundNumber) {
      setToast("Round is not ready yet.");
      return;
    }
    if (amount < MIN_BET || amount > MAX_BET) {
      setToast(`Bet must be between ${MIN_BET} and ${MAX_BET} ${DYNW_TOKEN.symbol}.`);
      return;
    }

    setPending(true);
    try {
      const vault = await getVaultContract(walletProvider);
      if (!vault) throw new Error("Vault contract unavailable.");
      const betId = id(`crash:${state.roundNumber}`);
      const amountWei = parseUnits(String(amount), DYNW_TOKEN.decimals);
      setToast("⏳ Locking bet in the Vault Ledger...");
      const tx = await vault.contract.placeBet(betId, vaultTokenAddress(), amountWei);
      await tx.wait();

      setToast("⏳ Registering crash bet...");
      await placeCrashBet(amount);
      refreshVaultBalance();
      setToast("✅ Crash bet locked. Good luck!");
    } catch (e: any) {
      setToast(`❌ ${e?.message || String(e)}`);
    } finally {
      setPending(false);
    }
  }

  async function handleCashout() {
    setToast("");
    if (!isSignedIn) {
      setToast("Sign in on the main page before cashing out.");
      return;
    }
    setPending(true);
    try {
      await cashoutCrash();
      refreshVaultBalance();
      setToast("✅ Cashout submitted.");
    } catch (e: any) {
      setToast(`❌ ${e?.message || String(e)}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="crash-page">
      <header className="crash-header">
        <div>
          <div className="eyebrow">CraftWorld Bets</div>
          <h1>Crash</h1>
          <p className="subtle">Global rounds, provably fair seeds, and instant cashouts.</p>
        </div>
        <div className="header-links">
          <Link className="btn btn-ghost" to="/">
            Betting Desk
          </Link>
          <Link className="btn btn-ghost" to="/token">
            DYNW Token
          </Link>
          <button
            className="btn btn-primary"
            onClick={handleWalletAction}
            disabled={!walletConnectEnabled}
            title={
              walletConnectEnabled
                ? undefined
                : "WalletConnect requires VITE_WALLETCONNECT_PROJECT_ID in your environment."
            }
          >
            {wallet ? `Disconnect: ${wallet.slice(0, 6)}...${wallet.slice(-4)}` : "Connect Wallet"}
          </button>
        </div>
      </header>

      <div className="crash-grid">
        <section className="crash-panel">
          <div className={`crash-multiplier ${state.phase === "CRASHED" ? "crashed" : ""}`}>
            {formatMultiplier(normalizedMultiplier)}
          </div>
          <div className="crash-status">Status: {state.phase}</div>
          <div className="crash-meta">
            <div>
              <span>Round</span>
              <strong>{state.roundId || "—"}</strong>
            </div>
            <div>
              <span>Commit hash</span>
              <strong className="mono">{state.commitHash || "—"}</strong>
            </div>
          </div>
          <div className="crash-fairness">
            <h3>Provably Fair</h3>
            {verify ? (
              <div className="fairness-grid">
                <div>
                  <span>Server seed</span>
                  <strong className="mono">{verify.serverSeed}</strong>
                </div>
                <div>
                  <span>Derived hash</span>
                  <strong className="mono">{verify.derivedHash}</strong>
                </div>
                <div>
                  <span>u</span>
                  <strong className="mono">{verify.u}</strong>
                </div>
                <div>
                  <span>Crash point</span>
                  <strong>{verify.crashPoint.toFixed(4)}</strong>
                </div>
                <div className="fairness-formula">
                  P(crash ≥ x) = (1 - edge) / x, edge = 2% → crash = (1 - edge) / u
                </div>
              </div>
            ) : (
              <p className="subtle">Seed reveal appears after the round crashes.</p>
            )}
          </div>
        </section>

        <section className="crash-panel">
          <div className="crash-bet-box">
            <h3>Place Bet</h3>
            <label className="crash-label">
              Amount ({DYNW_TOKEN.symbol})
              <input
                type="number"
                min={MIN_BET}
                max={MAX_BET}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </label>
            <div className="crash-balance">
              <span>Vault available</span>
              <strong>
                {vaultBalance !== null ? formatAmount(parseFloat(formatUnits(vaultBalance))) : "—"} {DYNW_TOKEN.symbol}
              </strong>
            </div>
            <div className="crash-balance">
              <span>Locked this round</span>
              <strong>
                {vaultLocked !== null ? formatAmount(parseFloat(formatUnits(vaultLocked))) : "—"} {DYNW_TOKEN.symbol}
              </strong>
            </div>
            <div className="crash-payout">
              Potential payout: {formatAmount(potentialPayout)} {DYNW_TOKEN.symbol}
            </div>
            <div className="crash-actions">
              <button className="btn btn-primary" disabled={!canBet || pending} onClick={handlePlaceBet}>
                Place Bet
              </button>
              <button className="btn" disabled={!canCashout || pending} onClick={handleCashout}>
                Cash Out
              </button>
            </div>
            {!isSignedIn && <p className="subtle">Sign in on the betting desk to enable crash actions.</p>}
            {toast && <div className="crash-toast">{toast}</div>}
          </div>

          <div className="crash-feed">
            <div>
              <h3>Live Bets</h3>
              <ul>
                {bets.length === 0 && <li className="subtle">No bets yet.</li>}
                {bets.map((bet) => (
                  <li
                    key={`bet-${bet.address}`}
                    className={bet.address.toLowerCase() === loginAddress.toLowerCase() ? "highlight" : ""}
                  >
                    <span>{shortAddress(bet.address)}</span>
                    <strong>{formatAmount(bet.amount)} {DYNW_TOKEN.symbol}</strong>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Cashouts</h3>
              <ul>
                {cashouts.length === 0 && <li className="subtle">No cashouts yet.</li>}
                {cashouts.map((bet) => (
                  <li
                    key={`cashout-${bet.address}`}
                    className={bet.address.toLowerCase() === loginAddress.toLowerCase() ? "highlight" : ""}
                  >
                    <span>{shortAddress(bet.address)}</span>
                    <strong>{bet.cashoutMultiplier ? bet.cashoutMultiplier.toFixed(2) : "—"}x</strong>
                    <em>{bet.payout ? formatAmount(bet.payout) : "—"} {DYNW_TOKEN.symbol}</em>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
