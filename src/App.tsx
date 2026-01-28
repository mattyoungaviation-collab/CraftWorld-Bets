import EthereumProvider from "@walletconnect/ethereum-provider";
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
  totalAmount?: number;
  serviceFeeAmount?: number;
  wagerAmount?: number;
  walletAddress?: string | null;
  escrowTx?: string | null;
  feeTx?: string | null;
  createdAt: string;
  futureBet?: boolean;
};

const COIN_SYMBOL = "$COIN";
const COIN_CONTRACT = "0x7DC167E270D5EF683CEAF4AFCDF2EFBDD667A9A7";
const ERC20_BALANCE_OF = "0x70a08231";
const ERC20_DECIMALS = "0x313ce567";
const ERC20_TRANSFER = "0xa9059cbb";
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SERVICE_FEE_BPS = 500;
const SERVICE_FEE_ADDRESS = "0xeED0491B506C78EA7fD10988B1E98A3C88e1C630";
const BET_ESCROW_ADDRESS =
  (import.meta.env.VITE_BET_ESCROW_ADDRESS as string | undefined) ||
  "0x47181FeB839dE75697064CC558eBb470E86449b9";

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

function padAmount(amount: bigint) {
  return amount.toString(16).padStart(64, "0");
}

function encodeTransfer(to: string, amount: bigint) {
  return `${ERC20_TRANSFER}${padAddress(to)}${padAmount(amount)}`;
}

function parseHexAmount(value?: string | null) {
  if (!value) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function padTopicAddress(address: string) {
  return `0x${padAddress(address)}`;
}

function findTransferAmount(logs: Array<{ topics?: string[]; data?: string; address?: string }>, to: string) {
  const target = padTopicAddress(to);
  for (const log of logs) {
    if (!log || !log.topics || log.topics.length < 3) continue;
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (log.address?.toLowerCase() !== COIN_CONTRACT.toLowerCase()) continue;
    if (log.topics[2]?.toLowerCase() !== target) continue;
    const amount = parseHexAmount(log.data);
    if (amount !== null) return amount;
  }
  return null;
}

function isValidAddress(address?: string | null) {
  if (!address) return false;
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export default function App() {
  const [username, setUsername] = useState(() => localStorage.getItem("cw_bets_user") || "");
  const [wallet, setWallet] = useState<string | null>(null);
  const [walletProvider, setWalletProvider] = useState<any>(null);
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
  const [coinPrice, setCoinPrice] = useState<number | null>(null);
  const [coinDecimals, setCoinDecimals] = useState<number>(18);
  const [coinBalance, setCoinBalance] = useState<bigint | null>(null);
  const [pendingBet, setPendingBet] = useState<{
    type: "live" | "future";
    pickedUid: string;
    pickedName: string;
  } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const escrowAddress = BET_ESCROW_ADDRESS || "";
  const hasEscrowAddress = Boolean(BET_ESCROW_ADDRESS);
  const escrowAddressValid = isValidAddress(escrowAddress);
  const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;
  const walletConnectEnabled = Boolean(walletConnectProjectId);

  useEffect(() => {
    localStorage.setItem("cw_bets_user", username);
  }, [username]);

  useEffect(() => {
    localStorage.setItem("cw_bets_mp_id", String(mpId));
  }, [mpId]);

  useEffect(() => {
    if (!wallet) setCoinBalance(null);
  }, [wallet]);

  useEffect(() => {
    if (!wallet) {
      setWalletBets([]);
      setAllBets([]);
      return;
    }
    const address = wallet;
    const register = async () => {
      try {
        await fetch("/api/wallets/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address }),
        });
      } catch (e) {
        console.error(e);
      }
    };
    register();
    if (showPositions) {
      refreshWalletPositions(address);
    }
  }, [wallet, showPositions]);

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
      const r = await fetch(`/api/wallets/${encodeURIComponent(address)}/bets`);
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
    loadCurrentMasterpiece(mpId);
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

  useEffect(() => {
    if (!walletProvider) return;

    const handleAccountsChanged = (accounts: string[]) => {
      const next = accounts?.[0] || null;
      setWallet(next);
      if (!next) setCoinBalance(null);
    };

    const handleDisconnect = () => {
      setWallet(null);
      setWalletProvider(null);
      setCoinBalance(null);
    };

    walletProvider.on?.("accountsChanged", handleAccountsChanged);
    walletProvider.on?.("disconnect", handleDisconnect);

    return () => {
      walletProvider.removeListener?.("accountsChanged", handleAccountsChanged);
      walletProvider.removeListener?.("disconnect", handleDisconnect);
    };
  }, [walletProvider]);

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
      const recipient = bet.walletAddress || bet.user;
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

  async function connectWallet() {
    setToast("");
    try {
      if (!walletConnectProjectId) {
        setToast("❌ Missing VITE_WALLETCONNECT_PROJECT_ID. Add it to your environment to use WalletConnect.");
        return;
      }

      const provider = await EthereumProvider.init({
        projectId: walletConnectProjectId,
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

  async function disconnectWallet() {
    setToast("");
    try {
      if (walletProvider?.disconnect) {
        await walletProvider.disconnect();
      }
    } catch (e: any) {
      setToast(`❌ ${e?.message || String(e)}`);
    } finally {
      setWallet(null);
      setWalletProvider(null);
      setCoinBalance(null);
    }
  }

  async function handleWalletAction() {
    if (wallet) {
      await disconnectWallet();
      return;
    }
    await connectWallet();
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

  async function signAndSendTransfer(to: string, rawAmount: bigint) {
    if (!walletProvider || !wallet) throw new Error("Connect your wallet to sign the transaction.");
    const data = encodeTransfer(to, rawAmount);
    const tx: Record<string, string> = {
      from: wallet,
      to: COIN_CONTRACT,
      data,
      value: "0x0",
    };

    try {
      const [gas, gasPrice] = await Promise.all([
        walletProvider.request({ method: "eth_estimateGas", params: [tx] }),
        walletProvider.request({ method: "eth_gasPrice", params: [] }),
      ]);
      if (gas) tx.gas = String(gas);
      if (gasPrice) tx.gasPrice = String(gasPrice);
    } catch {
      // Gas estimation isn't required for all wallets/providers, so fallback gracefully.
    }

    const txHash = await walletProvider.request({
      method: "eth_sendTransaction",
      params: [tx],
    });
    return txHash as string;
  }

  async function waitForReceipt(txHash: string, timeoutMs = 180000) {
    if (!walletProvider) throw new Error("Wallet provider not ready.");
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const receipt = await walletProvider.request({
        method: "eth_getTransactionReceipt",
        params: [txHash],
      });
      if (receipt) return receipt as { status?: string; logs?: Array<{ topics?: string[]; data?: string }> };
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    throw new Error("Transaction confirmation timed out.");
  }

  async function confirmTransfer(txHash: string, to: string, expectedAmount: bigint) {
    const receipt = await waitForReceipt(txHash);
    if (!receipt?.status || receipt.status === "0x0") {
      throw new Error("Transaction failed to confirm.");
    }
    const logs = receipt.logs || [];
    const matched = findTransferAmount(logs, to);
    if (matched === null) {
      throw new Error("Transfer log not found for the expected recipient.");
    }
    if (matched !== expectedAmount) {
      throw new Error("Transfer amount does not match the previewed bet.");
    }
    return receipt;
  }

  async function previewBet(payload: {
    user: string;
    masterpieceId: number;
    position: number;
    pickedUid: string;
    amount: number;
    totalAmount: number;
    serviceFeeAmount: number;
    wagerAmount: number;
    futureBet: boolean;
  }) {
    const r = await fetch("/api/bets/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || j?.ok !== true) {
      throw new Error(j?.error || "Unable to validate bet");
    }
    return j as { ok: true; pickedName: string; validationId: string };
  }

  async function finalizeBet() {
    if (!username.trim()) {
      setToast("Type a username first.");
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
    if (!wallet) {
      setToast("Connect your wallet to place a bet.");
      return;
    }
    if (!acknowledged) {
      setToast("Please acknowledge the betting terms to continue.");
      return;
    }
    if (!hasEscrowAddress) {
      setToast("Missing escrow address. Set VITE_BET_ESCROW_ADDRESS to accept bets.");
      return;
    }
    if (!escrowAddressValid) {
      setToast("Escrow address is invalid. Use a 0x wallet address for VITE_BET_ESCROW_ADDRESS.");
      return;
    }
    setPlacing(true);
    setToast("");
    let transfersConfirmed = false;
    try {
      let pendingId: string | null = null;
      const totalAmount = Math.floor(Number(amount));
      if (totalAmount <= 0) {
        throw new Error("Bet amount must be greater than zero.");
      }
      const rawTotal = BigInt(totalAmount) * BigInt(10) ** BigInt(coinDecimals);
      const rawFee = (rawTotal * BigInt(SERVICE_FEE_BPS)) / BigInt(10000);
      const rawWager = rawTotal - rawFee;
      const feeAmount = Math.floor((totalAmount * SERVICE_FEE_BPS) / 10000);
      const wagerAmount = totalAmount - feeAmount;

      const preview = await previewBet({
        user: username.trim(),
        masterpieceId: mpId,
        position: selectedPos,
        pickedUid: pendingBet.pickedUid,
        amount: wagerAmount,
        totalAmount,
        serviceFeeAmount: feeAmount,
        wagerAmount,
        futureBet: pendingBet.type === "future",
      });

      const pendingRes = await fetch("/api/bets/pending", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user: username.trim(),
          masterpieceId: mpId,
          position: selectedPos,
          pickedUid: pendingBet.pickedUid,
          amount: wagerAmount,
          totalAmount,
          serviceFeeAmount: feeAmount,
          wagerAmount,
          futureBet: pendingBet.type === "future",
          validationId: preview.validationId,
        }),
      });
      const pendingJson = await pendingRes.json();
      if (!pendingRes.ok || pendingJson?.ok !== true) {
        throw new Error(pendingJson?.error || "Unable to reserve bet before transfer.");
      }
      pendingId = pendingJson?.pendingId;

      setToast("🧾 Please sign the service fee transfer in your wallet.");
      const feeTx = await signAndSendTransfer(SERVICE_FEE_ADDRESS, rawFee);
      setToast("⏳ Waiting for fee transfer confirmation...");
      await confirmTransfer(feeTx, SERVICE_FEE_ADDRESS, rawFee);

      setToast("🧾 Please sign the wager transfer in your wallet.");
      const escrowTx = await signAndSendTransfer(escrowAddress, rawWager);
      setToast("⏳ Waiting for wager transfer confirmation...");
      await confirmTransfer(escrowTx, escrowAddress, rawWager);

      transfersConfirmed = true;
      if (!pendingId) {
        throw new Error("Pending bet was not created. No funds were moved.");
      }
      const r = await fetch("/api/bets/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pendingId,
          walletAddress: wallet,
          escrowTx,
          feeTx,
        }),
      });

      const j = await r.json();
      if (!r.ok || j?.ok !== true) {
        throw new Error(j?.error || "Failed to place bet");
      }

      setToast(
        `✅ Bet confirmed and funds received for ${username.trim()} → #${selectedPos} = ${preview.pickedName} (${fmt(
          totalAmount
        )} ${COIN_SYMBOL})`
      );
      setPendingBet(null);
      setAcknowledged(false);
      if (pendingBet.type === "future") {
        setFuturePick("");
        setFutureMode(false);
      }
      loadBets(mpId);
    } catch (e: any) {
      const message = e?.message || String(e);
      if (message && message.includes("User rejected")) {
        setToast("❌ Bet canceled. No funds were moved.");
        return;
      }
      if (message && message.includes("Transfer")) {
        setToast(`❌ Bet failed. Please try again. ${message}`);
        return;
      }
      if (message && message.includes("reserve")) {
        setToast(`❌ Bet failed before transfer. No funds were moved. ${message}`);
        return;
      }
      if (transfersConfirmed) {
        setToast(`⚠️ Transfers confirmed, but the bet was not recorded. Please retry to finalize. ${message}`);
        return;
      }
      setToast(`❌ Bet failed. Please try again. ${message}`);
    } finally {
      setPlacing(false);
    }
  }

  const feeAmount = useMemo(() => Math.floor((amount * SERVICE_FEE_BPS) / 10000), [amount]);
  const wagerAmount = useMemo(() => Math.max(amount - feeAmount, 0), [amount, feeAmount]);
  const totalInUsd = useMemo(() => (coinPrice || 0) * amount, [coinPrice, amount]);

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
            <strong>
              {wallet
                ? coinBalance !== null
                  ? formatTokenAmount(coinBalance, coinDecimals)
                  : "Loading..."
                : "Wallet not connected"}
            </strong>
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
          {!walletConnectEnabled && (
            <div className="subtle">Set VITE_WALLETCONNECT_PROJECT_ID in your .env to enable wallet connections.</div>
          )}
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
            <div className="subtle" style={{ marginTop: 6 }}>
              {fmt(wagerAmount)} {COIN_SYMBOL} wager + {fmt(feeAmount)} {COIN_SYMBOL} fee (5%)
            </div>
            {!hasEscrowAddress && (
              <div className="subtle" style={{ marginTop: 6 }}>
                Set <strong>VITE_BET_ESCROW_ADDRESS</strong> (a 0x wallet address) to route wagers to escrow.
              </div>
            )}
            {hasEscrowAddress && !escrowAddressValid && (
              <div className="subtle" style={{ marginTop: 6 }}>
                Escrow address must be a valid 0x wallet address.
              </div>
            )}
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

      <section className="card">
        <div className="section-title">Betting Terms</div>
        <ul className="terms-list">
          <li>
            All bets are final once confirmed on-chain. No refunds, chargebacks, or reversals are possible after you
            sign the transaction.
          </li>
          <li>
            A 5% service fee is deducted from each bet for server support and operations. The fee is sent to{" "}
            <strong>{SERVICE_FEE_ADDRESS}</strong> on Ronin.
          </li>
          <li>
            Winners are paid back in {COIN_SYMBOL} to the same wallet address that placed the bet, after the
            masterpiece completes and results are verified.
          </li>
          <li>
            Wagers are escrowed to <strong>{escrowAddress || "an escrow wallet"}</strong> on Ronin to fund payouts.
          </li>
          <li>
            Betting is for entertainment only and does not constitute investment advice. CraftWorld Bets is not
            responsible for losses from price volatility, failed transactions, or incorrect wallet addresses.
          </li>
        </ul>
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
            const avatar = row.profile.avatarUrl || "";
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
        <div className="section-title">Betting Board</div>
        <div className="subtle">All bets are shown in {COIN_SYMBOL} and USD (service fee included).</div>
        <div className="table" style={{ marginTop: 12 }}>
          <div className="table-header">
            <div>Time</div>
            <div>User</div>
            <div>Pick</div>
            <div>Pos</div>
            <div className="numeric">Wager</div>
          </div>
          {bets.length === 0 && <div className="empty">No bets yet.</div>}
          {bets.map((bet) => {
            const wager = bet.wagerAmount ?? bet.amount;
            const total = bet.totalAmount ?? bet.amount;
            const fee = bet.serviceFeeAmount ?? Math.max(total - wager, 0);
            return (
              <div className="table-row static" key={bet.id}>
                <div className="subtle">{new Date(bet.createdAt).toLocaleString()}</div>
                <div>{bet.user}</div>
                <div>{bet.pickedName || bet.pickedUid || "—"}</div>
                <div className="cell-center">#{bet.position}</div>
                <div className="numeric">
                  {fmt(wager)} {COIN_SYMBOL}
                  <div className="subtle">
                    Total {fmt(total)} {COIN_SYMBOL} • Fee {fmt(fee)} {COIN_SYMBOL}
                  </div>
                  <div className="subtle">{formatUsd((coinPrice || 0) * total)}</div>
                </div>
              </div>
            );
          })}
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
              <div className="numeric">Bet Cost</div>
              <div className="numeric">Size</div>
              <div className="numeric">Fees</div>
              <div className="numeric">Live Value</div>
            </div>
            {walletBets.length === 0 && <div className="empty">No bets found for this wallet.</div>}
            {walletBets.map((bet) => {
              const wager = bet.wagerAmount ?? bet.amount;
              const total = bet.totalAmount ?? bet.amount;
              const fee = bet.serviceFeeAmount ?? Math.max(total - wager, 0);
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
                    {fmt(total)} {COIN_SYMBOL}
                    <div className="subtle">{formatUsd((coinPrice || 0) * total)}</div>
                  </div>
                  <div className="numeric">
                    {fmt(wager)} {COIN_SYMBOL}
                  </div>
                  <div className="numeric">
                    {fmt(fee)} {COIN_SYMBOL}
                  </div>
                  <div className="numeric">
                    {liveValue !== null ? `${fmt(liveValue)} ${COIN_SYMBOL}` : "—"}
                    <div className="subtle">
                      {liveValue !== null ? formatUsd((coinPrice || 0) * liveValue) : "—"}
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
                    <div className="subtle">{formatUsd((coinPrice || 0) * winner.payout)}</div>
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>

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
                  <div className="label">Total Amount</div>
                  <div className="title">
                    {fmt(amount)} {COIN_SYMBOL}
                  </div>
                  <div className="subtle">{formatUsd(totalInUsd)}</div>
                </div>
                <div>
                  <div className="label">Wager Amount</div>
                  <div className="title">
                    {fmt(wagerAmount)} {COIN_SYMBOL}
                  </div>
                <div className="subtle">
                  Escrowed for payouts to {escrowAddress || "an escrow wallet"}
                </div>
                </div>
                <div>
                  <div className="label">Service Fee (5%)</div>
                  <div className="title">
                    {fmt(feeAmount)} {COIN_SYMBOL}
                  </div>
                  <div className="subtle">Sent to {SERVICE_FEE_ADDRESS}</div>
                </div>
              </div>

              <div className="terms-box">
                <p>
                  By confirming, you authorize a token transfer from your wallet for the wager and service fee. Bets are
                  final, non-refundable, and may not be canceled once the transaction is signed.
                </p>
                <p>
                  Winners are paid back to the same wallet address that submitted the bet after the masterpiece closes
                  and results are verified.
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
                I acknowledge that all bets are final and I authorize the wager + 5% service fee.
              </label>
              {!wallet && <div className="toast">Connect your wallet to sign the transaction.</div>}
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
    </div>
  );
}
