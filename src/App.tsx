import { useEffect, useMemo, useState } from "react";
import "./App.css";

type LeaderRow = {
  position: number;
  masterpiecePoints: number;
  profile: {
    uid: string;
    walletAddress?: string | null;
    avatarUrl?: string | null;
    displayName?: string | null;
  };
};

type Masterpiece = {
  id: string;
  name: string;
  type: string;
  collectedPoints: number;
  requiredPoints: number;
  startedAt: string;
  resources?: Array<{
    symbol: string;
    amount: number;
    target: number;
    consumedPowerPerUnit?: number;
  }>;
  leaderboard: LeaderRow[];
};

type Bet = {
  id: string;
  user: string;
  masterpieceId: number;
  position: number;
  pickedUid: string | null;
  pickedName: string | null;
  amount: number;
  createdAt: string;
  futureBet?: boolean;
};

const COIN_SYMBOL = "$COIN";
const COIN_CONTRACT = "0x7DC167E270D5EF683CEAF4AFCDF2EFBDD667A9A7";
const ERC20_BALANCE_OF = "0x70a08231";
const ERC20_DECIMALS = "0x313ce567";

function fmt(n: number) {
  return n.toLocaleString();
}

function formatUsd(n: number | null) {
  if (!n) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 });
}

function formatTokenAmount(raw: bigint, decimals: number) {
  if (decimals <= 0) return raw.toString();
  const base = BigInt(10) ** BigInt(decimals);
  const whole = raw / base;
  const fraction = raw % base;
  const fractionStr = fraction.toString().padStart(decimals, "0").slice(0, 4);
  return `${whole.toLocaleString()}.${fractionStr}`;
}

function padAddress(address: string) {
  return address.toLowerCase().replace("0x", "").padStart(64, "0");
}

async function loadWalletConnectProvider() {
  // @ts-ignore - dynamic URL import handled by Vite at runtime.
  const module = await import("https://unpkg.com/@walletconnect/ethereum-provider@2.11.2/dist/esm/index.js");
  return (module as any).default;
}

export default function App() {
  const [username, setUsername] = useState(() => localStorage.getItem("cw_bets_user") || "");
  const [wallet, setWallet] = useState<string | null>(null);
  const [walletProvider, setWalletProvider] = useState<any>(null);
  const [mpId, setMpId] = useState<number>(55);
  const [mp, setMp] = useState<Masterpiece | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");
  const [selectedPos, setSelectedPos] = useState<1 | 2 | 3>(1);
  const [amount, setAmount] = useState<number>(50000);
  const [placing, setPlacing] = useState(false);
  const [toast, setToast] = useState<string>("");
  const [bets, setBets] = useState<Bet[]>([]);
  const [futureMode, setFutureMode] = useState(false);
  const [futurePick, setFuturePick] = useState("");
  const [coinPrice, setCoinPrice] = useState<number | null>(null);
  const [coinDecimals, setCoinDecimals] = useState<number>(18);
  const [coinBalance, setCoinBalance] = useState<bigint | null>(null);

  useEffect(() => {
    localStorage.setItem("cw_bets_user", username);
  }, [username]);

  async function loadMasterpiece(id: number) {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch(`/api/masterpiece/${id}`);
      const j = await r.json();
      const m = j?.data?.masterpiece as Masterpiece | undefined;
      if (!m) throw new Error("No masterpiece data returned");
      setMp(m);
    } catch (e: any) {
      setErr(e?.message || String(e));
      setMp(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadBets(id: number) {
    try {
      const r = await fetch(`/api/bets?masterpieceId=${id}`);
      const j = await r.json();
      setBets(j?.bets || []);
    } catch (e) {
      console.error(e);
    }
  }

  async function loadCoinPrice() {
    try {
      const r = await fetch(
        `https://api.geckoterminal.com/api/v2/simple/networks/ronin/token_price/${COIN_CONTRACT}`
      );
      const j = await r.json();
      const price = Number(j?.data?.attributes?.token_prices?.[COIN_CONTRACT.toLowerCase()]);
      if (Number.isFinite(price)) setCoinPrice(price);
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    loadMasterpiece(mpId);
    loadBets(mpId);
    loadCoinPrice();
    const interval = setInterval(() => loadCoinPrice(), 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadBets(mpId);
  }, [mpId]);

  useEffect(() => {
    if (!wallet || !walletProvider) return;
    const walletAddress = wallet;
    let isActive = true;

    async function loadCoinMeta() {
      try {
        const decimalsHex = await walletProvider.request({
          method: "eth_call",
          params: [{ to: COIN_CONTRACT, data: ERC20_DECIMALS }, "latest"],
        });
        const parsed = Number.parseInt(decimalsHex, 16);
        if (Number.isFinite(parsed) && isActive) setCoinDecimals(parsed);
      } catch (e) {
        console.error(e);
      }
    }

    async function loadCoinBalance() {
      try {
        const data = `${ERC20_BALANCE_OF}${padAddress(walletAddress)}`;
        const balanceHex = await walletProvider.request({
          method: "eth_call",
          params: [{ to: COIN_CONTRACT, data }, "latest"],
        });
        const value = BigInt(balanceHex);
        if (isActive) setCoinBalance(value);
      } catch (e) {
        console.error(e);
      }
    }

    loadCoinMeta();
    loadCoinBalance();
    const interval = setInterval(loadCoinBalance, 30000);
    return () => {
      isActive = false;
      clearInterval(interval);
    };
  }, [wallet, walletProvider]);

  const top100 = useMemo(() => (mp?.leaderboard || []).slice(0, 100), [mp]);
  const hasLiveBoard = top100.length > 0;
  const dynamiteResource = useMemo(
    () => mp?.resources?.find((resource) => resource.symbol === "DYNAMITE") || null,
    [mp]
  );
  const bettingClosed =
    !!mp &&
    (dynamiteResource
      ? dynamiteResource.amount >= dynamiteResource.target
      : mp.collectedPoints >= mp.requiredPoints);

  const potForSelected = useMemo(() => {
    return bets
      .filter((b) => b.masterpieceId === mpId && b.position === selectedPos)
      .reduce((sum, b) => sum + b.amount, 0);
  }, [bets, mpId, selectedPos]);

  const oddsByUid = useMemo(() => {
    const filtered = bets.filter((b) => b.masterpieceId === mpId && b.position === selectedPos);
    const pot = filtered.reduce((sum, b) => sum + b.amount, 0);
    const stakeByUid = new Map<string, number>();
    for (const b of filtered) {
      if (!b.pickedUid) continue;
      stakeByUid.set(b.pickedUid, (stakeByUid.get(b.pickedUid) || 0) + b.amount);
    }
    const odds = new Map<string, number>();
    for (const [uid, stake] of stakeByUid) {
      if (stake > 0) odds.set(uid, pot / stake);
    }
    return { odds, pot };
  }, [bets, mpId, selectedPos]);

  async function connectWallet() {
    setToast("");
    try {
      const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;
      if (!wcProjectId) {
        setToast("❌ Missing VITE_WALLETCONNECT_PROJECT_ID. Add it to your environment to use WalletConnect.");
        return;
      }

      const EthereumProvider = await loadWalletConnectProvider();
      const provider = await EthereumProvider.init({
        projectId: wcProjectId,
        chains: [2020],
        optionalChains: [2020],
        showQrModal: true,
        metadata: {
          name: "CraftWorld Bets",
          description: "Betting desk for CraftWorld masterpieces.",
          url: window.location.origin,
          icons: ["https://walletconnect.com/walletconnect-logo.png"],
        },
        rpcMap: {
          2020: "https://api.roninchain.com/rpc",
        },
      });

      await provider.enable();
      const accounts = provider.accounts;
      const acct = accounts?.[0];
      if (acct) {
        setWalletProvider(provider);
        setWallet(acct);
        if (!username) setUsername(acct);
      }
    } catch (e: any) {
      setToast(`❌ ${e?.message || String(e)}`);
    }
  }

  async function placeBet(picked: LeaderRow) {
    if (!username.trim()) {
      setToast("Type a username first.");
      return;
    }
    if (bettingClosed) {
      setToast("Betting is closed for this masterpiece.");
      return;
    }
    setPlacing(true);
    setToast("");
    try {
      const payload = {
        user: username.trim(),
        masterpieceId: mpId,
        position: selectedPos,
        pickedUid: picked.profile.uid,
        amount: Math.floor(Number(amount)),
        futureBet: false,
      };

      const r = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const j = await r.json();
      if (!r.ok || j?.ok !== true) {
        throw new Error(j?.error || "Failed to place bet");
      }

      setToast(
        `✅ Bet placed: ${payload.user} → #${payload.position} = ${picked.profile.displayName || picked.profile.uid} (${fmt(
          payload.amount
        )} ${COIN_SYMBOL})`
      );
      loadBets(mpId);
    } catch (e: any) {
      setToast(`❌ ${e?.message || String(e)}`);
    } finally {
      setPlacing(false);
    }
  }

  async function placeFutureBet() {
    if (!username.trim()) {
      setToast("Type a username first.");
      return;
    }
    if (!futurePick.trim()) {
      setToast("Add a predicted player UID or name for future bets.");
      return;
    }
    setPlacing(true);
    setToast("");
    try {
      const payload = {
        user: username.trim(),
        masterpieceId: mpId,
        position: selectedPos,
        pickedUid: futurePick.trim(),
        amount: Math.floor(Number(amount)),
        futureBet: true,
      };

      const r = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const j = await r.json();
      if (!r.ok || j?.ok !== true) {
        throw new Error(j?.error || "Failed to place bet");
      }

      setToast(
        `✅ Future bet placed: ${payload.user} → #${payload.position} = ${payload.pickedUid} (${fmt(payload.amount)} ${COIN_SYMBOL})`
      );
      setFuturePick("");
      loadBets(mpId);
    } catch (e: any) {
      setToast(`❌ ${e?.message || String(e)}`);
    } finally {
      setPlacing(false);
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <div className="eyebrow">CraftWorld Bets</div>
          <h1>Betting Desk</h1>
          <div className="subtle">Bet on the top 3 positions as the dynamite fills up.</div>
        </div>
        <div className="header-actions">
          <div className="price-pill">
            <div>{COIN_SYMBOL} live price</div>
            <strong>{formatUsd(coinPrice)}</strong>
          </div>
          <div className="price-pill">
            <div>{COIN_SYMBOL} balance</div>
            <strong>{coinBalance !== null ? formatTokenAmount(coinBalance, coinDecimals) : "—"}</strong>
          </div>
          <button className="btn btn-primary" onClick={connectWallet}>
            {wallet ? `Connected: ${wallet.slice(0, 6)}...${wallet.slice(-4)}` : "Connect Wallet"}
          </button>
        </div>
      </header>

      <section className="card">
        <div className="grid-4">
          <div>
            <label>Username (user-created)</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. MattTheBookie"
            />
          </div>

          <div>
            <label>Masterpiece ID</label>
            <input type="number" value={mpId} onChange={(e) => setMpId(Number(e.target.value))} />
          </div>

          <div>
            <label>Bet Position</label>
            <select value={selectedPos} onChange={(e) => setSelectedPos(Number(e.target.value) as 1 | 2 | 3)}>
              <option value={1}>#1</option>
              <option value={2}>#2</option>
              <option value={3}>#3</option>
            </select>
          </div>

          <div>
            <label>Amount ({COIN_SYMBOL})</label>
            <input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
          </div>
        </div>

        <div className="actions">
          <button className="btn" onClick={() => loadMasterpiece(mpId)} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh Leaderboard"}
          </button>
          <button className="btn btn-primary" onClick={() => setFutureMode(true)}>
            Future Masterpiece Bet
          </button>
          <div className="status-pill">
            <span>Status</span>
            <strong>
              {bettingClosed
                ? "Betting Closed"
                : hasLiveBoard
                ? "Live"
                : futureMode
                ? "Future"
                : "Awaiting Leaderboard"}
            </strong>
          </div>
          <div className="status-pill">
            <span>Pot ({COIN_SYMBOL})</span>
            <strong>
              {fmt(potForSelected)} ({formatUsd((coinPrice || 0) * potForSelected)})
            </strong>
          </div>
        </div>

        {toast && <div className="toast">{toast}</div>}

        {err && (
          <div className="toast toast-error">
            <b>Error:</b> {err}
          </div>
        )}
      </section>

      <section className="card summary-card">
        <div>
          <div className="label">Masterpiece</div>
          <div className="title">{mp ? `${mp.name} (ID ${mp.id})` : "—"}</div>
          {mp && <div className="subtle">{mp.type}</div>}
        </div>
        <div className="right">
          <div className="label">Dynamite Progress</div>
          <div className="title">
            {dynamiteResource
              ? `${fmt(dynamiteResource.amount)} / ${fmt(dynamiteResource.target)}`
              : mp
              ? `${fmt(mp.collectedPoints)} / ${fmt(mp.requiredPoints)}`
              : "—"}
          </div>
          <div className="subtle">
            {dynamiteResource ? "Dynamite donated / target amount." : "Betting closes when dynamite is full."}
          </div>
        </div>
      </section>

      {futureMode && (
        <section className="card">
          <div className="section-title">Future Masterpiece Bet</div>
          <div className="subtle">
            Pre-bet on the next masterpiece. Enter the player UID or name you expect to finish in position #{selectedPos}.
          </div>
          <div className="grid-2" style={{ marginTop: 12 }}>
            <div>
              <label>Predicted player UID or name</label>
              <input value={futurePick} onChange={(e) => setFuturePick(e.target.value)} placeholder="UID or name" />
            </div>
            <div className="future-actions">
              <button className="btn" onClick={() => setFutureMode(false)}>
                Back to Live Betting
              </button>
              <button className="btn btn-primary" onClick={placeFutureBet} disabled={placing}>
                {placing ? "Placing..." : "Place Future Bet"}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <div className="section-title">Leaderboard (click to bet)</div>
        <div className="table">
          <div className="table-header">
            <div>Pos</div>
            <div>Player</div>
            <div>Points</div>
            <div>Odds</div>
            <div></div>
          </div>

          {top100.map((row) => {
            const name = row.profile.displayName || row.profile.uid;
            const avatar = row.profile.avatarUrl || "";
            const odds = oddsByUid.odds.get(row.profile.uid);
            return (
              <button
                key={`${row.position}-${row.profile.uid}`}
                onClick={() => placeBet(row)}
                disabled={placing || bettingClosed}
                className="table-row"
              >
                <div className="pos">#{row.position}</div>

                <div className="player">
                  {avatar ? (
                    <img
                      src={avatar}
                      alt=""
                      className="avatar"
                      onError={(e) => ((e.currentTarget.style.display = "none"))}
                    />
                  ) : (
                    <div className="avatar placeholder" />
                  )}
                  <div>
                    <div className="name">{name}</div>
                    <div className="subtle">{row.profile.uid}</div>
                  </div>
                </div>

                <div className="numeric">{fmt(row.masterpiecePoints)}</div>

                <div className="numeric">{odds ? `${odds.toFixed(2)}x` : "—"}</div>

                <div className="action-text">{bettingClosed ? "Closed" : placing ? "Placing..." : `Bet #${selectedPos}`}</div>
              </button>
            );
          })}

          {!loading && top100.length === 0 && <div className="empty">No leaderboard rows returned.</div>}
        </div>
      </section>

      <section className="card">
        <div className="section-title">Betting Board</div>
        <div className="subtle">All bets are shown in {COIN_SYMBOL} and USD.</div>
        <div className="table" style={{ marginTop: 12 }}>
          <div className="table-header">
            <div>Time</div>
            <div>User</div>
            <div>Pick</div>
            <div>Pos</div>
            <div>Amount</div>
          </div>
          {bets.length === 0 && <div className="empty">No bets yet.</div>}
          {bets.map((bet) => (
            <div className="table-row static" key={bet.id}>
              <div className="subtle">{new Date(bet.createdAt).toLocaleString()}</div>
              <div>{bet.user}</div>
              <div>{bet.pickedName || bet.pickedUid || "—"}</div>
              <div>#{bet.position}</div>
              <div className="numeric">
                {fmt(bet.amount)} {COIN_SYMBOL}
                <div className="subtle">{formatUsd((coinPrice || 0) * bet.amount)}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
