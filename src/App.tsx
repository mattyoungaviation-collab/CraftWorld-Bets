import { useEffect, useMemo, useState } from "react";
import SiteFooter from "./components/SiteFooter";
import LeaderboardRewardsPanel from "./components/LeaderboardRewardsPanel";
import RewardStagesPanel from "./components/RewardStagesPanel";
import { RONIN_CHAIN, shortAddress } from "./lib/tokens";
import { useWallet } from "./lib/wallet";
import type { RewardItem } from "./lib/rewards";
import "./App.css";

type LeaderRow = {
  position: number;
  masterpiecePoints: number;
  profile: {
    uid: string;
    displayName?: string | null;
  };
};

type Masterpiece = {
  id: string;
  name: string;
  collectedPoints: number;
  requiredPoints: number;
  leaderboard: LeaderRow[];
  profileByUserId?: {
    masterpiecePoints?: number | null;
  } | null;
  rewardStages?: {
    requiredMasterpiecePoints: number;
    rewards?: RewardItem[] | null;
    battlePassRewards?: RewardItem[] | null;
  }[] | null;
  leaderboardRewards?: {
    top: number;
    rewards?: RewardItem[] | null;
  }[] | null;
};

type Bet = {
  id: string;
  masterpieceId: number;
  position: number;
  pickedUid: string | null;
  pickedName: string | null;
  amount: number;
  createdAt: string;
};

type OddsRow = {
  uid: string;
  name: string;
  appearances: number;
  avgPlacement: number;
  winPercent: number;
  odds: number;
};

type OddsHistory = {
  startId: number;
  endId: number;
  updatedAt: string;
  masterpieces: Masterpiece[];
};

function formatOdds(odds: number) {
  if (!Number.isFinite(odds) || odds <= 0) return "—";
  return `${odds.toFixed(2)}x`;
}

function calculateSlidingOdds(appearances: number) {
  if (appearances < 3) return 1;
  const minOdds = 0.8;
  const maxOdds = 5;
  const maxAppearances = 50;
  const clampedAppearances = Math.min(Math.max(appearances, 3), maxAppearances);
  const t = (clampedAppearances - 3) / (maxAppearances - 3);
  return Math.min(Math.max(maxOdds - t * (maxOdds - minOdds), minOdds), maxOdds);
}

function buildOddsRows(masterpieces: Masterpiece[]) {
  const rows = new Map<string, { uid: string; name: string; placements: number[]; wins: number }>();
  for (const mp of masterpieces) {
    for (const entry of mp.leaderboard || []) {
      const uid = entry.profile.uid;
      const name = entry.profile.displayName || uid;
      if (!rows.has(uid)) rows.set(uid, { uid, name, placements: [], wins: 0 });
      const row = rows.get(uid)!;
      row.placements.push(entry.position);
      if (entry.position === 1) row.wins += 1;
    }
  }

  return Array.from(rows.values())
    .map((row) => {
      const appearances = row.placements.length;
      const avgPlacement =
        appearances > 0 ? row.placements.reduce((sum, val) => sum + val, 0) / appearances : 0;
      return {
        uid: row.uid,
        name: row.name,
        appearances,
        avgPlacement,
        winPercent: appearances > 0 ? (row.wins / appearances) * 100 : 0,
        odds: calculateSlidingOdds(appearances),
      };
    })
    .sort((a, b) => a.odds - b.odds);
}

export default function App() {
  const { wallet, chainId, connectWallet, disconnectWallet } = useWallet();
  const [mpId, setMpId] = useState<number>(55);
  const [mp, setMp] = useState<Masterpiece | null>(null);
  const [bets, setBets] = useState<Bet[]>([]);
  const [amount, setAmount] = useState(50000);
  const [selectedPos, setSelectedPos] = useState<1 | 2 | 3>(1);
  const [selectedUid, setSelectedUid] = useState("");
  const [status, setStatus] = useState("");
  const [activeTab, setActiveTab] = useState<"betting" | "odds">("betting");
  const [oddsRows, setOddsRows] = useState<OddsRow[]>([]);
  const [oddsHistory, setOddsHistory] = useState<OddsHistory | null>(null);

  const isWrongChain = !!wallet && chainId !== null && chainId !== RONIN_CHAIN.chainId;

  async function loadMasterpiece(id: number) {
    const response = await fetch(`/api/masterpiece/${id}`);
    const json = await response.json();
    if (!response.ok) throw new Error(json?.error || "Unable to load masterpiece");
    setMp(json?.data?.masterpiece || null);
  }

  async function loadBets(id: number) {
    const response = await fetch(`/api/bets?masterpieceId=${id}`);
    const json = await response.json();
    setBets(json?.bets || []);
  }

  async function loadOdds() {
    const response = await fetch(`/api/odds/history?endId=${mpId}`);
    const json = await response.json();
    if (!response.ok || !json?.data?.masterpieces) {
      setStatus("Unable to load odds history.");
      return;
    }
    const history = json.data as OddsHistory;
    setOddsHistory(history);
    setOddsRows(buildOddsRows(history.masterpieces));
  }

  useEffect(() => {
    loadMasterpiece(mpId).catch((err) => setStatus(err.message));
    loadBets(mpId).catch(() => undefined);
  }, [mpId]);

  useEffect(() => {
    if (activeTab === "odds") {
      loadOdds().catch(() => setStatus("Unable to load odds history."));
    }
  }, [activeTab, mpId]);

  const availablePicks = useMemo(() => {
    return (mp?.leaderboard || []).slice(0, 100);
  }, [mp]);

  const playerMasterpiecePoints = mp?.profileByUserId?.masterpiecePoints ?? 0;

  useEffect(() => {
    if (availablePicks.length > 0 && !selectedUid) {
      setSelectedUid(availablePicks[0].profile.uid);
    }
  }, [availablePicks, selectedUid]);

  async function placeBet() {
    if (!wallet) {
      setStatus("Connect your wallet first.");
      return;
    }
    if (!selectedUid) {
      setStatus("Select a player.");
      return;
    }

    setStatus("Submitting bet...");
    const response = await fetch("/api/bets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: wallet,
        masterpieceId: mpId,
        position: selectedPos,
        pickedUid: selectedUid,
        amount,
      }),
    });
    const json = await response.json();
    if (!response.ok) {
      setStatus(json?.error || "Bet failed.");
      return;
    }
    setStatus("✅ Bet placed.");
    await loadBets(mpId);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>CraftWorld Bets</h1>
        <button onClick={wallet ? disconnectWallet : connectWallet}>
          {wallet ? `Disconnect ${shortAddress(wallet)}` : "Connect Wallet"}
        </button>
      </header>

      {isWrongChain && <p className="warning">Switch to Ronin Chain (2020).</p>}

      <nav className="tabs">
        <button className={activeTab === "betting" ? "active" : ""} onClick={() => setActiveTab("betting")}>Betting Desk</button>
        <button className={activeTab === "odds" ? "active" : ""} onClick={() => setActiveTab("odds")}>Sports Odds</button>
      </nav>

      {activeTab === "betting" && (
        <section className="card">
          <h2>Betting Desk</h2>
          <label>
            Masterpiece ID
            <input type="number" value={mpId} onChange={(e) => setMpId(Number(e.target.value) || 1)} />
          </label>
          <p>{mp ? `${mp.name} — ${mp.collectedPoints}/${mp.requiredPoints} points` : "Loading..."}</p>
          <label>
            Position
            <select value={selectedPos} onChange={(e) => setSelectedPos(Number(e.target.value) as 1 | 2 | 3)}>
              <option value={1}>1st</option>
              <option value={2}>2nd</option>
              <option value={3}>3rd</option>
            </select>
          </label>
          <label>
            Pick
            <select value={selectedUid} onChange={(e) => setSelectedUid(e.target.value)}>
              {availablePicks.map((row) => (
                <option key={row.profile.uid} value={row.profile.uid}>
                  {row.profile.displayName || row.profile.uid}
                </option>
              ))}
            </select>
          </label>
          <label>
            Bet Amount
            <input type="number" min={1} value={amount} onChange={(e) => setAmount(Number(e.target.value) || 1)} />
          </label>
          <button onClick={() => placeBet().catch((err) => setStatus(err.message))}>Place Bet</button>
          <p>{status}</p>

          <h3>Recent Bets</h3>
          <ul>
            {bets.slice(-10).reverse().map((bet) => (
              <li key={bet.id}>
                #{bet.masterpieceId} P{bet.position} • {bet.pickedName || bet.pickedUid} • {bet.amount}
              </li>
            ))}
          </ul>

          <h3>Leaderboard</h3>
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Player</th>
                <th>MP Points</th>
              </tr>
            </thead>
            <tbody>
              {(mp?.leaderboard || []).map((entry) => (
                <tr key={`${entry.profile.uid}-${entry.position}`}>
                  <td>#{entry.position}</td>
                  <td>{entry.profile.displayName || entry.profile.uid}</td>
                  <td>{entry.masterpiecePoints.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <RewardStagesPanel
            rewardStages={mp?.rewardStages}
            masterpiecePoints={playerMasterpiecePoints}
          />
          <LeaderboardRewardsPanel leaderboardRewards={mp?.leaderboardRewards} />
        </section>
      )}

      {activeTab === "odds" && (
        <section className="card">
          <h2>Sports Odds</h2>
          {oddsHistory && (
            <p>
              Range #{oddsHistory.startId} - #{oddsHistory.endId} (updated {new Date(oddsHistory.updatedAt).toLocaleString()})
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Appearances</th>
                <th>Avg Place</th>
                <th>Win %</th>
                <th>Odds</th>
              </tr>
            </thead>
            <tbody>
              {oddsRows.map((row) => (
                <tr key={row.uid}>
                  <td>{row.name}</td>
                  <td>{row.appearances}</td>
                  <td>{row.avgPlacement.toFixed(2)}</td>
                  <td>{row.winPercent.toFixed(1)}%</td>
                  <td>{formatOdds(row.odds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <SiteFooter />
    </div>
  );
}
