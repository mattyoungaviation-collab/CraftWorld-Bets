import { Contract } from "ethers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import BlackjackTable from "./components/BlackjackTable";
import SiteFooter from "./components/SiteFooter";
import { useDynwRonPool } from "./lib/useDynwRonPool";
import { useRoninBalances } from "./lib/useRoninBalances";
import { DYNW_TOKEN, RONIN_CHAIN, parseUnits, shortAddress } from "./lib/tokens";
import { useVaultLedgerBalance } from "./lib/useVaultLedgerBalance";
import {
  VAULT_LEDGER_ADDRESS,
  buildBetId,
  getVaultContract,
  vaultTokenAddress,
} from "./lib/vaultLedger";
import { useWallet } from "./lib/wallet";
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
  betId?: string | null;
  user: string;
  userId?: string | null;
  loginAddress?: string | null;
  masterpieceId: number;
  position: number;
  pickedUid: string | null;
  pickedName: string | null;
  amount: number;
  wagerAmount?: number;
  txHash?: string | null;
  createdAt: string;
  futureBet?: boolean;
};

type OddsRow = {
  uid: string;
  name: string;
  avatarUrl?: string | null;
  appearances: number;
  avgPlacement: number;
  winPercent: number;
  winCount: number;
  winProbability?: number;
  winChance: number;
  odds: number;
  tier: string;
  tierTone: "elite" | "mid" | "low" | "new";
  tierRank: number;
  contributions: Array<{
    masterpieceId: string;
    masterpieceName: string;
    position: number;
  }>;
};

type OddsHistory = {
  startId: number;
  endId: number;
  updatedAt: string;
  masterpieces: Masterpiece[];
};

type ModelOddsResponse = {
  probs: Record<string, number>;
  odds: Record<string, number>;
};


const COIN_SYMBOL = DYNW_TOKEN.symbol;

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
  const odds = maxOdds - t * (maxOdds - minOdds);
  return Math.min(Math.max(odds, minOdds), maxOdds);
}

function formatPercent(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}







function normalizeAssetUrl(url?: string | null) {
  if (!url) return "";
  if (url.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${url.slice("ipfs://".length)}`;
  }
  return url;
}






export default function App() {
  const [username, setUsername] = useState(() => localStorage.getItem("cw_bets_user") || "");
  const COIN_CONTRACT = import.meta.env.VITE_COIN_CONTRACT || "";
  const { wallet, provider: walletProvider, chainId, connectWallet, disconnectWallet, walletConnectEnabled } =
    useWallet();
  const { vaultBalance, vaultLocked, refresh: refreshVaultBalance } = useVaultLedgerBalance(wallet, walletProvider);
  const [authToken, setAuthToken] = useState(() => localStorage.getItem("cw_bets_token") || "");
  const [loginAddress, setLoginAddress] = useState<string | null>(
    () => localStorage.getItem("cw_bets_login") || null
  );
  const [vaultDepositAmount, setVaultDepositAmount] = useState("");
  const [vaultWithdrawAmount, setVaultWithdrawAmount] = useState("");
  const [vaultStatus, setVaultStatus] = useState("");
  const [mpId, setMpId] = useState<number>(() => {
    const stored = localStorage.getItem("cw_bets_mp_id");
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 55;
  });
  const [mp, setMp] = useState<Masterpiece | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");
  const [selectedPos, setSelectedPos] = useState<1 | 2 | 3>(1);
  const [amount, setAmount] = useState<number>(50000);
  const [placing, setPlacing] = useState(false);
  const [toast, setToast] = useState<string>("");
  const [bets, setBets] = useState<Bet[]>([]);
  const [allBets, setAllBets] = useState<Bet[]>([]);
  const [walletBets, setWalletBets] = useState<Bet[]>([]);
  const [showPositions, setShowPositions] = useState(false);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [futureMode, setFutureMode] = useState(false);
  const [futurePick, setFuturePick] = useState("");
  const [dynwUsdPrice, setDynwUsdPrice] = useState<number | null>(null);
  const { priceRonPerDynw: dynwRonPrice, error: dynwRonPriceError } = useDynwRonPool();
  const settlementToastRef = useRef<number | null>(null);
  const settlementPendingRef = useRef<number | null>(null);
  const coinDecimals = DYNW_TOKEN.decimals;
  const { ronBalance, dynwBalance } = useRoninBalances(wallet, walletProvider);
  const coinBalance = dynwBalance;
  const [activeTab, setActiveTab] = useState<"betting" | "odds" | "blackjack">("betting");
  const [oddsRows, setOddsRows] = useState<OddsRow[]>([]);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsError, setOddsError] = useState("");
  const [oddsHistory, setOddsHistory] = useState<OddsHistory | null>(null);
  const [modelOdds, setModelOdds] = useState<ModelOddsResponse | null>(null);
  const [oddsSearch, setOddsSearch] = useState("");
  const [selectedOddsPlayer, setSelectedOddsPlayer] = useState<OddsRow | null>(null);
  const [oddsSortKey, setOddsSortKey] = useState<"winPercent" | "odds" | "appearances" | "avgPlacement" | "tier">(
    "odds"
  );
  const [oddsSortDirection, setOddsSortDirection] = useState<"asc" | "desc">("asc");
  const [pendingBet, setPendingBet] = useState<{
    type: "live" | "future";
    pickedUid: string;
    pickedName: string;
  } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const isWrongChain = !!wallet && chainId !== null && chainId !== RONIN_CHAIN.chainId;
  const isSignedIn = Boolean(authToken && loginAddress);

  const authFetch = useCallback(
    async (input: RequestInfo, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (authToken) {
        headers.set("authorization", `Bearer ${authToken}`);
      }
      if (!headers.has("content-type") && init.body) {
        headers.set("content-type", "application/json");
      }
      const response = await fetch(input, { ...init, headers });
      return response;
    },
    [authToken]
  );

  useEffect(() => {
    localStorage.setItem("cw_bets_user", username);
  }, [username]);

  useEffect(() => {
    if (authToken) {
      localStorage.setItem("cw_bets_token", authToken);
    } else {
      localStorage.removeItem("cw_bets_token");
    }
  }, [authToken]);

  useEffect(() => {
    if (loginAddress) {
      localStorage.setItem("cw_bets_login", loginAddress);
    } else {
      localStorage.removeItem("cw_bets_login");
    }
  }, [loginAddress]);

  useEffect(() => {
    localStorage.setItem("cw_bets_mp_id", String(mpId));
  }, [mpId]);

  useEffect(() => {
    if (!wallet || !loginAddress) return;
    if (wallet.toLowerCase() !== loginAddress.toLowerCase()) {
      handleSignOut();
    }
  }, [wallet, loginAddress]);


  useEffect(() => {
    const address = loginAddress || wallet;
    if (!address) {
      setWalletBets([]);
      setAllBets([]);
      return;
    }
    if (showPositions) {
      refreshWalletPositions(address);
    }
  }, [wallet, loginAddress, showPositions]);

  useEffect(() => {
    if (activeTab !== "betting") return;
    if (!mp) return;
    loadSettlementStatus(mpId, mp);
  }, [activeTab, mp, mpId]);

  function isMasterpieceClosed(masterpiece: Masterpiece) {
    const dynamite = masterpiece.resources?.find((resource) => resource.symbol === "DYNAMITE");
    return dynamite ? dynamite.amount >= dynamite.target : masterpiece.collectedPoints >= masterpiece.requiredPoints;
  }

  async function fetchMasterpiece(id: number) {
    const r = await fetch(`/api/masterpiece/${id}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error || "Unable to load masterpiece");
    const m = j?.data?.masterpiece as Masterpiece | undefined;
    if (!m) throw new Error("No masterpiece data returned");
    return m;
  }

  async function loadCurrentMasterpiece(startId: number) {
    setLoading(true);
    setErr("");
    const maxLookahead = 20;
    let latest: { id: number; mp: Masterpiece } | null = null;

    try {
      for (let offset = 0; offset < maxLookahead; offset += 1) {
        const id = startId + offset;
        const m = await fetchMasterpiece(id);
        latest = { id, mp: m };
        if (!isMasterpieceClosed(m)) {
          setMpId(id);
          setMp(m);
          return;
        }
      }
      if (latest) {
        setMpId(latest.id);
        setMp(latest.mp);
        return;
      }
      setMp(null);
      setErr("No masterpiece data returned");
    } catch (e: any) {
      if (latest) {
        setMpId(latest.id);
        setMp(latest.mp);
      } else {
        setMp(null);
        setErr(e?.message || String(e));
      }
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

  async function loadSettlementStatus(id: number, masterpiece: Masterpiece | null) {
    try {
      const r = await fetch(`/api/results/${id}`);
      const j = await r.json();
      if (!r.ok || j?.ok !== true) return;
      if (j?.result?.settledAt && settlementToastRef.current !== id) {
        setToast(`✅ Settlement finalized for masterpiece #${id}.`);
        settlementToastRef.current = id;
        settlementPendingRef.current = null;
      } else if (
        masterpiece &&
        isMasterpieceClosed(masterpiece) &&
        !j?.result &&
        settlementPendingRef.current !== id
      ) {
        setToast(`⏳ Settlement pending for masterpiece #${id}.`);
        settlementPendingRef.current = id;
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function loadAllBets() {
    try {
      const r = await fetch("/api/bets");
      const j = await r.json();
      setAllBets(j?.bets || []);
    } catch (e) {
      console.error(e);
    }
  }

  async function loadWalletBets(address: string) {
    try {
      const r = await fetch(`/api/bets?walletAddress=${encodeURIComponent(address)}`);
      const j = await r.json();
      setWalletBets(j?.bets || []);
    } catch (e) {
      console.error(e);
    }
  }

  async function refreshWalletPositions(address: string) {
    setPositionsLoading(true);
    try {
      await Promise.all([loadWalletBets(address), loadAllBets()]);
    } finally {
      setPositionsLoading(false);
    }
  }

  async function handleSignIn() {
    if (!wallet || !walletProvider) {
      setToast("Connect your wallet before signing in.");
      return;
    }
    try {
      setToast("");
      const nonceRes = await fetch("/api/auth/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: wallet }),
      });
      const nonceJson = await nonceRes.json();
      if (!nonceRes.ok || !nonceJson?.nonce) {
        throw new Error(nonceJson?.error || "Unable to request nonce");
      }
      const message = `CraftWorld Bets sign-in\nAddress: ${wallet}\nNonce: ${nonceJson.nonce}`;
      const signature = (await walletProvider.request({
        method: "personal_sign",
        params: [message, wallet],
      })) as string;
      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: wallet, message, signature }),
      });
      const verifyJson = await verifyRes.json();
      if (!verifyRes.ok || verifyJson?.ok !== true) {
        throw new Error(verifyJson?.error || "Unable to verify signature");
      }
      setAuthToken(verifyJson.token);
      setLoginAddress(verifyJson.address);
      setToast("✅ Signed in with wallet.");
    } catch (e: any) {
      setToast(`❌ Sign-in failed. ${e?.message || String(e)}`);
    }
  }

  function handleSignOut() {
    setAuthToken("");
    setLoginAddress(null);
    setVaultStatus("");
    setToast("Signed out.");
  }

  async function handleVaultDeposit() {
    if (!vaultDepositAmount || Number(vaultDepositAmount) <= 0) {
      setVaultStatus("Enter a valid deposit amount.");
      return;
    }
    if (!wallet || !walletProvider) {
      setVaultStatus("Connect your wallet before depositing.");
      return;
    }
    if (!VAULT_LEDGER_ADDRESS) {
      setVaultStatus("Vault address is not configured.");
      return;
    }
    setVaultStatus("Requesting approval...");
    setToast("");
    try {
      const vault = await getVaultContract(walletProvider);
      if (!vault) throw new Error("Vault contract unavailable");
      const { contract, signer } = vault;
      const amount = parseUnits(vaultDepositAmount, DYNW_TOKEN.decimals);
      const erc20 = new Contract(
        DYNW_TOKEN.address,
        ["function allowance(address owner, address spender) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"],
        signer,
      );
      const allowance = await erc20.allowance(wallet, VAULT_LEDGER_ADDRESS);
      if (allowance < amount) {
        await (await erc20.approve(VAULT_LEDGER_ADDRESS, amount)).wait();
        setToast("✅ Approval confirmed.");
      }
      setVaultStatus("Depositing into vault...");
      await (await contract.depositDYNW(amount)).wait();
      setVaultStatus("✅ Deposit complete.");
      setToast("✅ Deposit complete.");
      setVaultDepositAmount("");
      refreshVaultBalance();
    } catch (e: any) {
      setVaultStatus(`❌ ${e?.message || String(e)}`);
    }
  }

  async function handleVaultWithdraw() {
    if (!vaultWithdrawAmount || Number(vaultWithdrawAmount) <= 0) {
      setVaultStatus("Enter a valid withdrawal amount.");
      return;
    }
    if (!wallet || !walletProvider) {
      setVaultStatus("Connect your wallet before withdrawing.");
      return;
    }
    if (!VAULT_LEDGER_ADDRESS) {
      setVaultStatus("Vault address is not configured.");
      return;
    }
    setVaultStatus("Submitting withdrawal...");
    setToast("");
    try {
      const vault = await getVaultContract(walletProvider);
      if (!vault) throw new Error("Vault contract unavailable");
      const { contract } = vault;
      const amount = parseUnits(vaultWithdrawAmount, DYNW_TOKEN.decimals);
      await (await contract.withdrawDYNW(amount)).wait();
      setVaultStatus("✅ Withdrawal complete.");
      setToast("✅ Withdrawal complete.");
      setVaultWithdrawAmount("");
      refreshVaultBalance();
    } catch (e: any) {
      setVaultStatus(`❌ ${e?.message || String(e)}`);
    }
  }

  async function loadDynwUsdPrice() {
    try {
      const r = await fetch(
        `https://api.geckoterminal.com/api/v2/simple/networks/ronin/token_price/${COIN_CONTRACT}`
      );
      const j = await r.json();
      const price = Number(j?.data?.attributes?.token_prices?.[COIN_CONTRACT.toLowerCase()]);
      if (Number.isFinite(price)) setDynwUsdPrice(price);
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    loadCurrentMasterpiece(mpId);
    loadBets(mpId);
    loadDynwUsdPrice();
    const interval = setInterval(() => loadDynwUsdPrice(), 60000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadBets(mpId);
  }, [mpId]);

  useEffect(() => {
    if (activeTab === "odds" && oddsRows.length === 0 && !oddsLoading) {
      loadOddsHistory();
    }
  }, [activeTab, oddsLoading, oddsRows.length]);

  useEffect(() => {
    if (loginAddress) {
      setUsername(loginAddress);
      return;
    }
    if (wallet && !username) {
      setUsername(wallet);
    }
  }, [loginAddress, wallet, username]);

  const top100 = useMemo(() => (mp?.leaderboard || []).slice(0, 100), [mp]);
  const hasLiveBoard = top100.length > 0;
  const liveLeaderByPosition = useMemo(() => {
    const map = new Map<number, { uid: string; name: string | null }>();
    for (const row of top100) {
      map.set(row.position, {
        uid: row.profile.uid,
        name: row.profile.displayName ?? null,
      });
    }
    return map;
  }, [top100]);
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
      .reduce((sum, b) => sum + (b.wagerAmount ?? b.amount), 0);
  }, [bets, mpId, selectedPos]);

  const positionSnapshot = useMemo(() => {
    const source = allBets.length > 0 ? allBets : bets;
    const potByPosition = new Map<string, number>();
    const stakeByPick = new Map<string, number>();
    for (const bet of source) {
      const wager = bet.wagerAmount ?? bet.amount;
      const posKey = `${bet.masterpieceId}-${bet.position}`;
      potByPosition.set(posKey, (potByPosition.get(posKey) || 0) + wager);
      const pickKey = bet.pickedUid || bet.pickedName;
      if (pickKey) {
        const pickRef = `${posKey}-${pickKey}`;
        stakeByPick.set(pickRef, (stakeByPick.get(pickRef) || 0) + wager);
      }
    }
    return { potByPosition, stakeByPick };
  }, [allBets, bets]);

  const liveWinners = useMemo(() => {
    if (!hasLiveBoard || !bettingClosed) return [];
    const source = allBets.length > 0 ? allBets : bets;
    const winners: Array<{
      id: string;
      position: number;
      leader: string;
      recipient: string;
      wager: number;
      payout: number;
    }> = [];

    for (const bet of source) {
      if (bet.masterpieceId !== mpId) continue;
      const liveLeader = liveLeaderByPosition.get(bet.position);
      if (!liveLeader) continue;
      const matchesLeader =
        (bet.pickedUid && bet.pickedUid === liveLeader.uid) ||
        (bet.pickedName &&
          liveLeader.name &&
          bet.pickedName.trim().toLowerCase() === liveLeader.name.trim().toLowerCase());
      if (!matchesLeader) continue;

      const wager = bet.wagerAmount ?? bet.amount;
      const posKey = `${bet.masterpieceId}-${bet.position}`;
      const pickKey = bet.pickedUid || bet.pickedName;
      const pot = positionSnapshot.potByPosition.get(posKey) || 0;
      const stake = pickKey ? positionSnapshot.stakeByPick.get(`${posKey}-${pickKey}`) || 0 : 0;
      if (pot <= 0 || stake <= 0) continue;
      const payout = Math.min((wager / stake) * pot, pot);
      const recipient = bet.loginAddress || bet.user;
      winners.push({
        id: bet.id,
        position: bet.position,
        leader: liveLeader.name || liveLeader.uid,
        recipient,
        wager,
        payout,
      });
    }

    winners.sort((a, b) => a.position - b.position || b.payout - a.payout);
    return winners;
  }, [allBets, bets, bettingClosed, hasLiveBoard, liveLeaderByPosition, mpId, positionSnapshot]);

  const chanceByUid = useMemo(() => {
    const chances = new Map<string, number>();
    if (!mp?.leaderboard || mp.leaderboard.length === 0) {
      return { chances };
    }
    const totalPoints = mp.leaderboard.reduce((sum, row) => sum + Math.max(row.masterpiecePoints, 0), 0);
    if (bettingClosed) {
      const winner = mp.leaderboard.find((row) => row.position === selectedPos);
      if (winner) {
        for (const row of mp.leaderboard) {
          chances.set(row.profile.uid, row.profile.uid === winner.profile.uid ? 100 : 0);
        }
        return { chances };
      }
    }
    if (!totalPoints) {
      return { chances };
    }
    for (const row of mp.leaderboard) {
      if (row.masterpiecePoints <= 0) continue;
      const value = (row.masterpiecePoints / totalPoints) * 100;
      chances.set(row.profile.uid, value);
    }
    return { chances };
  }, [bettingClosed, mp, selectedPos]);

  function getTier(participationPercent: number) {
    if (participationPercent >= 100) {
      return { tier: "God Level", tierTone: "elite" as const };
    }
    if (participationPercent >= 90) {
      return { tier: "Ascended", tierTone: "elite" as const };
    }
    if (participationPercent >= 80) {
      return { tier: "Pro", tierTone: "elite" as const };
    }
    if (participationPercent >= 70) {
      return { tier: "Veteran", tierTone: "mid" as const };
    }
    if (participationPercent >= 60) {
      return { tier: "Hardened", tierTone: "mid" as const };
    }
    if (participationPercent >= 50) {
      return { tier: "Mid", tierTone: "mid" as const };
    }
    if (participationPercent >= 40) {
      return { tier: "Average", tierTone: "low" as const };
    }
    if (participationPercent >= 30) {
      return { tier: "Low", tierTone: "low" as const };
    }
    if (participationPercent >= 20) {
      return { tier: "Newbie", tierTone: "new" as const };
    }
    if (participationPercent >= 10) {
      return { tier: "Just Starting Out", tierTone: "new" as const };
    }
    return { tier: "Dirt Level", tierTone: "new" as const };
  }

  function buildOddsRows(history: Masterpiece[], model: ModelOddsResponse | null) {
    const sortedHistory = history
      .slice()
      .sort((a, b) => Number(a.id) - Number(b.id))
      .filter((entry) => entry?.leaderboard?.length);
    const winCounts = new Map<string, number>();
    let totalWins = 0;
    const map = new Map<
      string,
      {
        uid: string;
        name: string;
        avatarUrl?: string | null;
        placements: number[];
        contributions: OddsRow["contributions"];
        strength: number;
      }
    >();
    const totalEntries = sortedHistory.length;
    for (const [index, entry] of sortedHistory.entries()) {
      const weight = totalEntries > 1 ? 0.5 + index / (totalEntries - 1) : 1;
      const winnerRow = entry.leaderboard?.find((row) => row.position === 1);
      if (winnerRow) {
        totalWins += 1;
        winCounts.set(winnerRow.profile.uid, (winCounts.get(winnerRow.profile.uid) ?? 0) + 1);
      }
      for (const row of entry.leaderboard || []) {
        const key = row.profile.uid;
        if (!map.has(key)) {
          map.set(key, {
            uid: row.profile.uid,
            name: row.profile.displayName || row.profile.uid,
            avatarUrl: normalizeAssetUrl(row.profile.avatarUrl),
            placements: [],
            contributions: [],
            strength: 0,
          });
        }
        const player = map.get(key);
        if (player) {
          player.placements.push(row.position);
          if (!player.avatarUrl && row.profile.avatarUrl) player.avatarUrl = normalizeAssetUrl(row.profile.avatarUrl);
          if (!player.name && row.profile.displayName) player.name = row.profile.displayName;
          player.contributions.push({
            masterpieceId: entry.id,
            masterpieceName: entry.name,
            position: row.position,
          });
          const placementScore = row.position > 0 ? 1 / row.position : 0;
          player.strength += weight * placementScore;
        }
      }
    }

    if (map.size === 0) {
      return [];
    }

    const baselineStrength =
      Array.from(map.values()).reduce((sum, player) => sum + player.strength, 0) / map.size;
    const priorWeight = 3;
    const uncertaintyPenalty = 4;
    const temperature = 0.9;

    const adjustedStrengths = new Map<string, number>();
    const priorStrengths: number[] = [];

    for (const player of map.values()) {
      const priorAdjusted = player.strength + priorWeight * baselineStrength;
      priorStrengths.push(priorAdjusted);
      adjustedStrengths.set(player.uid, priorAdjusted);
    }

    const baselineAdjusted = priorStrengths.reduce((sum, value) => sum + value, 0) / priorStrengths.length;

    const finalStrengths = new Map<string, number>();
    let maxStrength = -Infinity;
    for (const player of map.values()) {
      const appearances = player.placements.length;
      const alpha = appearances / (appearances + uncertaintyPenalty);
      const priorAdjusted = adjustedStrengths.get(player.uid) ?? baselineAdjusted;
      const finalStrength = alpha * priorAdjusted + (1 - alpha) * baselineAdjusted;
      finalStrengths.set(player.uid, finalStrength);
      if (finalStrength > maxStrength) maxStrength = finalStrength;
    }

    let denominator = 0;
    const probabilities = new Map<string, number>();
    for (const player of map.values()) {
      const strength = finalStrengths.get(player.uid) ?? 0;
      const scaled = Math.exp((strength - maxStrength) / temperature);
      probabilities.set(player.uid, scaled);
      denominator += scaled;
    }

    for (const [uid, scaled] of probabilities.entries()) {
      probabilities.set(uid, denominator > 0 ? scaled / denominator : 0);
    }

    const rows: OddsRow[] = [];
    const players = Array.from(map.values());
    if (players.length === 0) return rows;
    const modelProbs = model?.probs ?? {};
    for (const player of map.values()) {
      const appearances = player.placements.length;
      const avgPlacement =
        appearances > 0
          ? player.placements.reduce((sum, pos) => sum + pos, 0) / appearances
          : 0;
      const probability = modelProbs[player.uid];
      const winChance = Number.isFinite(probability) ? probability * 100 : Number.NaN;
      const odds = calculateSlidingOdds(appearances);
      const participationPercent = totalEntries > 0 ? (appearances / totalEntries) * 100 : 0;
      const { tier, tierTone } = getTier(participationPercent);
      const winCount = winCounts.get(player.uid) ?? 0;
      const winPercent = totalWins > 0 ? (winCount / totalWins) * 100 : 0;
      rows.push({
        uid: player.uid,
        name: player.name,
        avatarUrl: player.avatarUrl,
        appearances,
        avgPlacement,
        winPercent,
        winCount,
        winProbability: Number.isFinite(probability) ? probability : undefined,
        winChance,
        odds,
        tier,
        tierTone,
        tierRank: participationPercent,
        contributions: player.contributions.slice().sort((a, b) => Number(a.masterpieceId) - Number(b.masterpieceId)),
      });
    }

    rows.sort((a, b) => {
      const aVal = Number.isFinite(a.odds) ? a.odds : Number.POSITIVE_INFINITY;
      const bVal = Number.isFinite(b.odds) ? b.odds : Number.POSITIVE_INFINITY;
      return aVal - bVal;
    });

    return rows;
  }

  const filteredOddsRows = useMemo(() => {
    const query = oddsSearch.trim().toLowerCase();
    if (!query) return oddsRows;
    return oddsRows.filter(
      (row) => row.name.toLowerCase().includes(query) || row.uid.toLowerCase().includes(query)
    );
  }, [oddsRows, oddsSearch]);

  function getOddsSortDirection(
    key: "winPercent" | "odds" | "appearances" | "avgPlacement" | "tier"
  ): "asc" | "desc" {
    if (key === "odds" || key === "avgPlacement") return "asc";
    return "desc";
  }

  function handleOddsSort(
    key: "winPercent" | "odds" | "appearances" | "avgPlacement" | "tier"
  ) {
    if (oddsSortKey === key) {
      setOddsSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setOddsSortKey(key);
      setOddsSortDirection(getOddsSortDirection(key));
    }
  }

  const sortedOddsRows = useMemo(() => {
    const sorted = filteredOddsRows.slice();
    sorted.sort((a, b) => {
      let aValue: number;
      let bValue: number;
      switch (oddsSortKey) {
        case "winPercent":
          aValue = Number.isFinite(a.winPercent) ? a.winPercent : 0;
          bValue = Number.isFinite(b.winPercent) ? b.winPercent : 0;
          break;
        case "odds":
          aValue = Number.isFinite(a.odds) ? a.odds : Number.POSITIVE_INFINITY;
          bValue = Number.isFinite(b.odds) ? b.odds : Number.POSITIVE_INFINITY;
          break;
        case "appearances":
          aValue = a.appearances;
          bValue = b.appearances;
          break;
        case "avgPlacement":
          aValue = a.avgPlacement > 0 ? a.avgPlacement : Number.POSITIVE_INFINITY;
          bValue = b.avgPlacement > 0 ? b.avgPlacement : Number.POSITIVE_INFINITY;
          break;
        case "tier":
          aValue = a.tierRank;
          bValue = b.tierRank;
          break;
        default:
          aValue = 0;
          bValue = 0;
      }
      if (aValue === bValue) {
        return a.name.localeCompare(b.name);
      }
      return oddsSortDirection === "asc" ? aValue - bValue : bValue - aValue;
    });
    return sorted;
  }, [filteredOddsRows, oddsSortDirection, oddsSortKey]);

  async function loadOddsHistory() {
    setOddsLoading(true);
    setOddsError("");
    try {
      const endId = mp?.id ? Number(mp.id) : mpId;
      const [historyRes, modelRes] = await Promise.all([
        fetch(`/api/odds/history?endId=${endId}`),
        fetch("/api/odds/model"),
      ]);
      const historyJson = await historyRes.json();
      const modelJson = await modelRes.json();
      if (!historyRes.ok) throw new Error(historyJson?.error || "Unable to load odds history");
      const history = historyJson?.data as OddsHistory | undefined;
      const model =
        modelRes.ok && modelJson?.probs && modelJson?.odds
          ? { probs: modelJson.probs as Record<string, number>, odds: modelJson.odds as Record<string, number> }
          : null;
      if (!history || !Array.isArray(history.masterpieces)) {
        throw new Error("No odds history data returned");
      }
      const rows = buildOddsRows(history.masterpieces, model);
      if (rows.length === 0) {
        setOddsError("No placement data available for the selected masterpiece range.");
      }
      setOddsRows(rows);
      setOddsHistory(history);
      setModelOdds(model);
    } catch (e: any) {
      setOddsError(e?.message || String(e));
    } finally {
      setOddsLoading(false);
    }
  }

  async function refreshOddsHistory() {
    setOddsLoading(true);
    setOddsError("");
    try {
      const endId = mp?.id ? Number(mp.id) : mpId;
      const [historyRes, modelRes] = await Promise.all([
        fetch(`/api/odds/history?endId=${endId}&refresh=true`),
        fetch("/api/odds/model"),
      ]);
      const historyJson = await historyRes.json();
      const modelJson = await modelRes.json();
      if (!historyRes.ok) throw new Error(historyJson?.error || "Unable to refresh odds history");
      const history = historyJson?.data as OddsHistory | undefined;
      const model =
        modelRes.ok && modelJson?.probs && modelJson?.odds
          ? { probs: modelJson.probs as Record<string, number>, odds: modelJson.odds as Record<string, number> }
          : null;
      if (!history || !Array.isArray(history.masterpieces)) {
        throw new Error("No odds history data returned");
      }
      const rows = buildOddsRows(history.masterpieces, model);
      if (rows.length === 0) {
        setOddsError("No placement data available for the selected masterpiece range.");
      }
      setOddsRows(rows);
      setOddsHistory(history);
      setModelOdds(model);
    } catch (e: any) {
      setOddsError(e?.message || String(e));
    } finally {
      setOddsLoading(false);
    }
  }

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

  async function placeBet(picked: LeaderRow) {
    setPendingBet({
      type: "live",
      pickedUid: picked.profile.uid,
      pickedName: picked.profile.displayName || picked.profile.uid,
    });
  }

  async function openFutureBetConfirm() {
    if (!futurePick.trim()) {
      setToast("Add a predicted player UID or name for future bets.");
      return;
    }
    setPendingBet({
      type: "future",
      pickedUid: futurePick.trim(),
      pickedName: futurePick.trim(),
    });
  }

  async function previewBet(payload: {
    user: string;
    masterpieceId: number;
    position: number;
    pickedUid: string;
    amount: number;
    wagerAmount: number;
    futureBet: boolean;
  }) {
    const r = await authFetch("/api/bets/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || j?.ok !== true) {
      throw new Error(j?.error || "Unable to validate bet");
    }
    return j as { ok: true; pickedName: string; validationId: string; betId: string };
  }

  async function finalizeBet() {
    if (!isSignedIn || !loginAddress) {
      setToast("Sign in with your wallet to place a bet.");
      return;
    }
    if (bettingClosed) {
      setToast("Betting is closed for this masterpiece.");
      return;
    }
    if (!pendingBet) {
      setToast("Pick a player before confirming.");
      return;
    }
    if (!acknowledged) {
      setToast("Please acknowledge the betting terms to continue.");
      return;
    }
    setPlacing(true);
    setToast("");
    try {
      const wagerAmount = Math.floor(Number(amount));
      if (wagerAmount <= 0) {
        throw new Error("Bet amount must be greater than zero.");
      }

      const preview = await previewBet({
        user: loginAddress,
        masterpieceId: mpId,
        position: selectedPos,
        pickedUid: pendingBet.pickedUid,
        amount: wagerAmount,
        wagerAmount,
        futureBet: pendingBet.type === "future",
      });

      if (!walletProvider || !wallet) {
        throw new Error("Connect your wallet to place the bet.");
      }
      const vault = await getVaultContract(walletProvider);
      if (!vault) {
        throw new Error("Vault contract not available.");
      }
      const amountRaw = parseUnits(String(wagerAmount), DYNW_TOKEN.decimals);
      setToast("⏳ Placing bet in the vault...");
      const betId = preview.betId || buildBetId(mpId, selectedPos);
      const placeTx = await vault.contract.placeBet(betId, vaultTokenAddress(), amountRaw);
      await placeTx.wait();

      const r = await authFetch("/api/bets", {
        method: "POST",
        body: JSON.stringify({
          user: loginAddress,
          masterpieceId: mpId,
          position: selectedPos,
          pickedUid: pendingBet.pickedUid,
          amount: wagerAmount,
          wagerAmount,
          betId,
          validationId: preview.validationId,
          txHash: placeTx.hash,
        }),
      });

      const j = await r.json();
      if (!r.ok || j?.ok !== true) {
        throw new Error(j?.error || "Failed to record bet");
      }

      setToast(
        `✅ Bet placed for ${shortAddress(loginAddress)} → #${selectedPos} = ${preview.pickedName} (${fmt(
          wagerAmount
        )} ${COIN_SYMBOL})`
      );
      setPendingBet(null);
      setAcknowledged(false);
      if (pendingBet.type === "future") {
        setFuturePick("");
        setFutureMode(false);
      }
      loadBets(mpId);
      refreshVaultBalance();
    } catch (e: any) {
      const message = e?.message || String(e);
      setToast(`❌ Bet failed. Please try again. ${message}`);
    } finally {
      setPlacing(false);
    }
  }

  const wagerAmount = useMemo(() => Math.max(amount, 0), [amount]);
  const totalInUsd = useMemo(() => (dynwUsdPrice || 0) * wagerAmount, [dynwUsdPrice, wagerAmount]);
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
            <div>{COIN_SYMBOL} price (RON)</div>
            <strong>
              {dynwRonPrice !== null
                ? `${dynwRonPrice.toFixed(6)} RON`
                : dynwRonPriceError
                ? "Unavailable"
                : "Loading..."}
            </strong>
          </div>
          <div className="price-pill">
            <div>RON balance</div>
            <strong>
              {wallet
                ? ronBalance !== null
                  ? formatTokenAmount(ronBalance, 18)
                  : "Loading..."
                : "Wallet not connected"}
            </strong>
          </div>
          <div className="price-pill">
            <div>{COIN_SYMBOL} balance</div>
            <strong>
              {wallet
                ? coinBalance !== null
                  ? formatTokenAmount(coinBalance, coinDecimals)
                  : "Loading..."
                : "Wallet not connected"}
            </strong>
          </div>
          <div className="price-pill">
            <div>Wallet</div>
            <strong>{wallet ? shortAddress(wallet) : "Not connected"}</strong>
          </div>
          <div className="header-links">
            <Link className="btn btn-ghost" to="/token">
              DYNW Token
            </Link>
          </div>
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
            {wallet
              ? `Disconnect: ${wallet.slice(0, 6)}...${wallet.slice(-4)}`
              : "Connect Wallet"}
          </button>
          {wallet && !isSignedIn && (
            <button className="btn" onClick={handleSignIn}>
              Sign in
            </button>
          )}
          {isSignedIn && (
            <button className="btn" onClick={handleSignOut}>
              Sign out
            </button>
          )}
          {isWrongChain && (
            <div className="subtle">Wrong network detected. Switch to Ronin Mainnet (chain {RONIN_CHAIN.chainId}).</div>
          )}
          {!walletConnectEnabled && (
            <div className="subtle">Set VITE_WALLETCONNECT_PROJECT_ID in your .env to enable wallet connections.</div>
          )}
        </div>
      </header>

      <section className="card vault-card">
        <div className="vault-header">
          <div>
            <div className="eyebrow">Vault Ledger</div>
            <h2>Non-custodial balance for bets</h2>
          </div>
          <div className="status-pill">{isSignedIn ? "Signed in" : "Not signed in"}</div>
        </div>
        {!VAULT_LEDGER_ADDRESS && (
          <div className="toast toast-error">Vault ledger address is not configured.</div>
        )}
        <div className="vault-grid">
          <div>
            <label>Login wallet</label>
            <div className="static-field">{loginAddress ? shortAddress(loginAddress) : "—"}</div>
          </div>
          <div>
            <label>Vault contract</label>
            <div className="static-field">{VAULT_LEDGER_ADDRESS ? shortAddress(VAULT_LEDGER_ADDRESS) : "—"}</div>
          </div>
          <div>
            <label>Vault balance ({COIN_SYMBOL})</label>
            <div className="static-field">
              {VAULT_LEDGER_ADDRESS
                ? vaultBalance !== null
                  ? formatTokenAmount(vaultBalance, DYNW_TOKEN.decimals)
                  : "Loading..."
                : "—"}
            </div>
          </div>
          <div>
            <label>Locked in bets ({COIN_SYMBOL})</label>
            <div className="static-field">
              {VAULT_LEDGER_ADDRESS
                ? vaultLocked !== null
                  ? formatTokenAmount(vaultLocked, DYNW_TOKEN.decimals)
                  : "Loading..."
                : "—"}
            </div>
          </div>
          <div className="vault-actions">
            <label>Deposit to vault</label>
            <div className="vault-inputs">
              <input
                value={vaultDepositAmount}
                onChange={(e) => setVaultDepositAmount(e.target.value)}
                placeholder={`Amount in ${COIN_SYMBOL}`}
              />
              <button
                className="btn btn-primary"
                onClick={handleVaultDeposit}
                disabled={!wallet || !VAULT_LEDGER_ADDRESS}
              >
                Approve & Deposit
              </button>
            </div>
          </div>
          <div className="vault-actions">
            <label>Withdraw from vault</label>
            <div className="vault-inputs">
              <input
                value={vaultWithdrawAmount}
                onChange={(e) => setVaultWithdrawAmount(e.target.value)}
                placeholder={`Amount in ${COIN_SYMBOL}`}
              />
              <button
                className="btn btn-primary"
                onClick={handleVaultWithdraw}
                disabled={!wallet || !VAULT_LEDGER_ADDRESS}
              >
                Withdraw
              </button>
            </div>
          </div>
        </div>
        {vaultStatus && <div className="subtle">{vaultStatus}</div>}
      </section>

      <div className="tabs">
        <button
          className={`tab ${activeTab === "betting" ? "active" : ""}`}
          onClick={() => setActiveTab("betting")}
        >
          Betting Desk
        </button>
        <button className={`tab ${activeTab === "odds" ? "active" : ""}`} onClick={() => setActiveTab("odds")}>
          Sports Odds
        </button>
        <button
          className={`tab ${activeTab === "blackjack" ? "active" : ""}`}
          onClick={() => setActiveTab("blackjack")}
        >
          BLACKJACK
        </button>
      </div>

      {activeTab === "betting" && (
        <section className="card">
          <div className="grid-4">
            <div>
              <label>Login wallet</label>
              <input
                value={isSignedIn && loginAddress ? loginAddress : username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Sign in to auto-fill"
                disabled={isSignedIn}
              />
              <div className="subtle" style={{ marginTop: 6 }}>
                Bets are attributed to your signed-in wallet address.
              </div>
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
              <div className="subtle" style={{ marginTop: 6 }}>
                {fmt(wagerAmount)} {COIN_SYMBOL} wager from your vault balance.
              </div>
            </div>
          </div>

          <div className="actions">
            <button className="btn" onClick={() => loadCurrentMasterpiece(mpId)} disabled={loading}>
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
                {fmt(potForSelected)} ({formatUsd((dynwUsdPrice || 0) * potForSelected)})
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
      )}

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

      {activeTab === "odds" && (
        <section className="card odds-card">
          <div className="section-title">Player Odds Board</div>
          <div className="subtle">
            Model odds built from recency-weighted masterpiece placements across the full history range (#1 through #
            {oddsHistory?.endId ?? mpId}). The model blends in a baseline prior for low-sample players and uses a softmax
            curve so win chances stay stable as more history arrives.
          </div>
          <div className="odds-controls">
            <div className="odds-meta">
              <div className="label">History range</div>
              <div className="title">
                {oddsHistory ? `#${oddsHistory.startId} → #${oddsHistory.endId}` : "Not loaded"}
              </div>
              <div className="subtle">
                {oddsHistory
                  ? `Cached ${new Date(oddsHistory.updatedAt).toLocaleString()}`
                  : "Load the full history to build odds."}
              </div>
              <div className="subtle">
                {modelOdds ? "Model odds loaded from history.json." : "Model odds not loaded yet."}
              </div>
            </div>
            <div className="odds-search">
              <label htmlFor="odds-search-input">Search player</label>
              <input
                id="odds-search-input"
                type="text"
                placeholder="Search by name or ID"
                value={oddsSearch}
                onChange={(e) => setOddsSearch(e.target.value)}
              />
            </div>
            <div className="odds-actions">
              <button className="btn" onClick={loadOddsHistory} disabled={oddsLoading}>
                {oddsLoading ? "Loading odds..." : "Load Odds"}
              </button>
              <button className="btn btn-primary" onClick={refreshOddsHistory} disabled={oddsLoading}>
                Rebuild History
              </button>
            </div>
          </div>

          {oddsError && (
            <div className="toast toast-error">
              <b>Error:</b> {oddsError}
            </div>
          )}

          <div className="table odds-table">
            <div className="table-header">
              <div>Player</div>
              <button
                className="sort-button numeric"
                type="button"
                onClick={() => handleOddsSort("winPercent")}
              >
                Win % (1st)
                {oddsSortKey === "winPercent" && <span className="sort-indicator">{oddsSortDirection}</span>}
              </button>
              <button className="sort-button numeric" type="button" onClick={() => handleOddsSort("odds")}>
                Odds
                {oddsSortKey === "odds" && <span className="sort-indicator">{oddsSortDirection}</span>}
              </button>
              <button
                className="sort-button numeric"
                type="button"
                onClick={() => handleOddsSort("appearances")}
              >
                Placements
                {oddsSortKey === "appearances" && <span className="sort-indicator">{oddsSortDirection}</span>}
              </button>
              <button
                className="sort-button numeric"
                type="button"
                onClick={() => handleOddsSort("avgPlacement")}
              >
                Avg Place
                {oddsSortKey === "avgPlacement" && <span className="sort-indicator">{oddsSortDirection}</span>}
              </button>
              <button
                className="sort-button cell-center"
                type="button"
                onClick={() => handleOddsSort("tier")}
              >
                Tier
                {oddsSortKey === "tier" && <span className="sort-indicator">{oddsSortDirection}</span>}
              </button>
            </div>
            {filteredOddsRows.length === 0 && !oddsLoading && (
              <div className="empty">
                {oddsRows.length === 0
                  ? "Load the history to see veteran, mid-level, low-level, and new players."
                  : "No players match that search."}
              </div>
            )}
            {sortedOddsRows.map((row) => (
              <button
                key={row.uid}
                className="table-row odds-row"
                onClick={() => setSelectedOddsPlayer(row)}
                type="button"
              >
                <div className="player">
                  {row.avatarUrl ? (
                    <img
                      src={normalizeAssetUrl(row.avatarUrl)}
                      alt=""
                      className="avatar"
                      onError={(e) => ((e.currentTarget.style.display = "none"))}
                    />
                  ) : (
                    <div className="avatar placeholder" />
                  )}
                  <div>
                    <div className="name">{row.name}</div>
                    <div className="subtle">{row.uid}</div>
                  </div>
                </div>
                <div className="numeric">{formatPercent(row.winPercent)}</div>
                <div className="numeric">
                  {formatOdds(row.odds)}
                </div>
                <div className="numeric">{row.appearances}</div>
                <div className="numeric">{row.avgPlacement ? row.avgPlacement.toFixed(2) : "—"}</div>
                <div className="cell-center">
                  <span className={`tier-pill tier-${row.tierTone}`}>{row.tier}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {activeTab === "blackjack" && (
        <BlackjackTable
          active={activeTab === "blackjack"}
          authFetch={authFetch}
          wallet={wallet}
          walletProvider={walletProvider}
          isSignedIn={isSignedIn}
          coinSymbol={COIN_SYMBOL}
          coinDecimals={coinDecimals}
        />
      )}

      {activeTab === "betting" && (
        <section className="card">
          <div className="section-title">Betting Terms</div>
          <ul className="terms-list">
            <li>
              All bets are final once confirmed on-chain. Bets are funded from your Vault Ledger balance after you sign
              the transaction.
            </li>
            <li>
              The settlement operator can only move balances between player ledgers and the on-chain treasury. It
              cannot withdraw your funds to arbitrary addresses.
            </li>
            <li>
              Winnings are credited back to your Vault Ledger balance. You can withdraw any available balance at any
              time.
            </li>
            <li>
              All outcomes are recorded on-chain and can be indexed via emitted events for later verification.
            </li>
            <li>
              Betting is for entertainment only and does not constitute investment advice. CraftWorld Bets is not
              responsible for losses from price volatility, failed transactions, or incorrect wallet addresses.
            </li>
          </ul>
        </section>
      )}

      {activeTab === "betting" && (
        <>
          {futureMode && (
            <section className="card">
              <div className="section-title">Future Masterpiece Bet</div>
              <div className="subtle">
                Pre-bet on the next masterpiece. Enter the player UID or name you expect to finish in position #
                {selectedPos}.
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
                  <button className="btn btn-primary" onClick={openFutureBetConfirm} disabled={placing}>
                    {placing ? "Placing..." : "Confirm Future Bet"}
                  </button>
                </div>
              </div>
            </section>
          )}

      <section className="card">
        <div className="section-title">Leaderboard (click to bet)</div>
        <div className="table">
          <div className="table-header">
            <div className="cell-center">Pos</div>
            <div>Player</div>
            <div className="numeric">Points</div>
            <div className="numeric">Chance of winning</div>
            <div></div>
          </div>

          {top100.map((row) => {
            const name = row.profile.displayName || row.profile.uid;
            const avatar = normalizeAssetUrl(row.profile.avatarUrl || "");
            const chance = chanceByUid.chances.get(row.profile.uid);
            return (
              <button
                key={`${row.position}-${row.profile.uid}`}
                onClick={() => placeBet(row)}
                disabled={placing || bettingClosed}
                className="table-row"
              >
                <div className="pos cell-center">#{row.position}</div>

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

                <div className="numeric">{chance !== undefined ? `${chance.toFixed(2)}%` : "—"}</div>

                <div className="action-text">{bettingClosed ? "Closed" : placing ? "Placing..." : `Bet #${selectedPos}`}</div>
              </button>
            );
          })}

          {!loading && top100.length === 0 && <div className="empty">No leaderboard rows returned.</div>}
        </div>
      </section>

      <section className="card">
        <div className="section-title">My Positions</div>
        <div className="subtle">Connect your wallet to view your saved bets across devices.</div>
        <div className="actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              if (!wallet) {
                setToast("Connect your wallet to view saved positions.");
                return;
              }
              const next = !showPositions;
              setShowPositions(next);
              if (next) {
                refreshWalletPositions(wallet);
              }
            }}
          >
            {showPositions ? "Hide My Bets" : "View My Bets"}
          </button>
          <button
            className="btn"
            onClick={() => wallet && refreshWalletPositions(wallet)}
            disabled={!wallet || positionsLoading}
          >
            {positionsLoading ? "Refreshing..." : "Refresh Positions"}
          </button>
        </div>
        {showPositions && (
          <div className="table positions-table" style={{ marginTop: 12 }}>
            <div className="table-header">
              <div>Time</div>
              <div className="cell-center">Masterpiece</div>
              <div>Pick</div>
              <div>Pos</div>
              <div className="numeric">Wager</div>
              <div className="numeric">Live Value</div>
            </div>
            {walletBets.length === 0 && <div className="empty">No bets found for this wallet.</div>}
            {walletBets.map((bet) => {
              const wager = bet.wagerAmount ?? bet.amount;
              const posKey = `${bet.masterpieceId}-${bet.position}`;
              const pickKey = bet.pickedUid || bet.pickedName;
              const pot = positionSnapshot.potByPosition.get(posKey) || 0;
              const stake =
                pickKey && positionSnapshot.stakeByPick.get(`${posKey}-${pickKey}`)
                  ? positionSnapshot.stakeByPick.get(`${posKey}-${pickKey}`) || 0
                  : 0;
              const liveLeader =
                bet.masterpieceId === mpId ? liveLeaderByPosition.get(bet.position) : null;
              const matchesLeader =
                !!liveLeader &&
                ((bet.pickedUid && bet.pickedUid === liveLeader.uid) ||
                  (bet.pickedName &&
                    liveLeader.name &&
                    bet.pickedName.trim().toLowerCase() === liveLeader.name.trim().toLowerCase()));
              const liveValue =
                pot > 0 && stake > 0
                  ? hasLiveBoard && bet.masterpieceId === mpId
                    ? matchesLeader
                      ? Math.min((wager / stake) * pot, pot)
                      : 0
                    : null
                  : null;
              return (
                <div className="table-row static" key={bet.id}>
                  <div className="subtle">{new Date(bet.createdAt).toLocaleString()}</div>
                  <div className="cell-center">#{bet.masterpieceId}</div>
                  <div>{bet.pickedName || bet.pickedUid || "—"}</div>
                  <div className="cell-center">#{bet.position}</div>
                  <div className="numeric">
                    {fmt(wager)} {COIN_SYMBOL}
                    <div className="subtle">{formatUsd((dynwUsdPrice || 0) * wager)}</div>
                  </div>
                  <div className="numeric">
                    {liveValue !== null ? `${fmt(liveValue)} ${COIN_SYMBOL}` : "—"}
                    <div className="subtle">
                      {liveValue !== null ? formatUsd((dynwUsdPrice || 0) * liveValue) : "—"}
                    </div>
                    <div className="subtle">Pot cap: {fmt(pot)} {COIN_SYMBOL}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-title">Live Winners (paid out now)</div>
        <div className="subtle">
          Winners are calculated from the current leaderboard for masterpiece #{mpId}. Each payout is proportional
          to position size within that pick's pool.
        </div>
        {!hasLiveBoard && <div className="empty">No live leaderboard data available yet.</div>}
        {hasLiveBoard && (
          <div className="table winners-table" style={{ marginTop: 12 }}>
            <div className="table-header">
              <div className="cell-center">Pos</div>
              <div>Leader</div>
              <div>Recipient</div>
              <div className="numeric">Size</div>
              <div className="numeric">Payout</div>
            </div>
            {!bettingClosed && (
              <div className="empty">Winners will appear once the masterpiece is complete.</div>
            )}
            {bettingClosed && liveWinners.length === 0 && (
              <div className="empty">No winners yet for the current live leaderboard.</div>
            )}
            {bettingClosed &&
              liveWinners.map((winner) => (
                <div className="table-row static" key={winner.id}>
                  <div className="cell-center">#{winner.position}</div>
                  <div>{winner.leader}</div>
                  <div>{winner.recipient}</div>
                  <div className="numeric">
                    {fmt(winner.wager)} {COIN_SYMBOL}
                  </div>
                  <div className="numeric">
                    {fmt(winner.payout)} {COIN_SYMBOL}
                    <div className="subtle">{formatUsd((dynwUsdPrice || 0) * winner.payout)}</div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>
        </>
      )}

      {selectedOddsPlayer && (
        <div className="modal-backdrop">
          <div className="modal odds-modal">
            <div className="modal-header">
              <div>
                <div className="eyebrow">Player History</div>
                <h2>{selectedOddsPlayer.name}</h2>
                <div className="subtle">{selectedOddsPlayer.uid}</div>
              </div>
              <button className="btn" onClick={() => setSelectedOddsPlayer(null)} type="button">
                Close
              </button>
            </div>
            <div className="modal-body">
              <div className="history-summary">
                <div>
                  <div className="label">Average Placement</div>
                  <div className="title">{selectedOddsPlayer.avgPlacement.toFixed(2)}</div>
                </div>
                <div>
                  <div className="label">Appearances</div>
                  <div className="title">{selectedOddsPlayer.appearances}</div>
                </div>
                <div>
                  <div className="label">Historical Win %</div>
                  <div className="title">{formatPercent(selectedOddsPlayer.winPercent)}</div>
                  <div className="subtle">{selectedOddsPlayer.winCount} total wins</div>
                </div>
                <div>
                  <div className="label">Odds</div>
                  <div className="title">{formatOdds(selectedOddsPlayer.odds)}</div>
                </div>
                <div>
                  <div className="label">Model Win Chance</div>
                  <div className="title">{formatPercent(selectedOddsPlayer.winChance)}</div>
                </div>
              </div>

              <div className="history-list">
                <div className="history-header">
                  <div>Masterpiece</div>
                  <div className="cell-center">ID</div>
                  <div className="cell-center">Placement</div>
                </div>
                {selectedOddsPlayer.contributions.map((entry) => (
                  <div className="history-row" key={`${selectedOddsPlayer.uid}-${entry.masterpieceId}`}>
                    <div className="history-name">{entry.masterpieceName}</div>
                    <div className="cell-center">#{entry.masterpieceId}</div>
                    <div className="cell-center">#{entry.position}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {pendingBet && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-header">
              <div>
                <div className="eyebrow">Confirm Bet</div>
                <h2>{pendingBet.type === "future" ? "Future Bet" : "Live Bet"}</h2>
              </div>
              <button
                className="btn"
                onClick={() => {
                  setPendingBet(null);
                  setAcknowledged(false);
                }}
              >
                Close
              </button>
            </div>
            <div className="modal-body">
              <div className="confirm-grid">
                <div>
                  <div className="label">Pick</div>
                  <div className="title">{pendingBet.pickedName}</div>
                  <div className="subtle">Position #{selectedPos}</div>
                </div>
                <div>
                  <div className="label">Wager Amount</div>
                  <div className="title">
                    {fmt(wagerAmount)} {COIN_SYMBOL}
                  </div>
                  <div className="subtle">{formatUsd(totalInUsd)}</div>
                </div>
                <div>
                  <div className="label">Settlement</div>
                  <div className="title">On-chain Vault Ledger</div>
                  <div className="subtle">Wagers lock in your vault balance until settlement.</div>
                </div>
              </div>

              <div className="terms-box">
                <p>
                  By confirming, you authorize the Vault Ledger to lock your wagered amount. Bets are final and cannot
                  be canceled once confirmed.
                </p>
                <p>
                  Settlement is executed by the operator on-chain, crediting winners back to their vault balances and
                  accruing losses to the treasury. You can withdraw available balances at any time.
                </p>
                <p>
                  CraftWorld Bets is not responsible for wallet errors, network congestion, failed transactions, or
                  losses due to price volatility.
                </p>
              </div>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                I acknowledge that all bets are final and I authorize the wager from my vault balance.
              </label>
              {!isSignedIn && <div className="toast">Sign in to place the bet from your vault balance.</div>}
            </div>
            <div className="modal-actions">
              <button
                className="btn"
                onClick={() => {
                  setPendingBet(null);
                  setAcknowledged(false);
                }}
                disabled={placing}
              >
                Cancel
              </button>
              <button className="btn btn-primary" onClick={finalizeBet} disabled={placing || !acknowledged || !wallet}>
                {placing ? "Placing..." : "Confirm & Sign"}
              </button>
            </div>
          </div>
        </div>
      )}
      <SiteFooter />
    </div>
  );
}
