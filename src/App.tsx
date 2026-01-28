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

type Card = {
  rank: string;
  suit: string;
  value: number;
};

type SeatStatus = "empty" | "waiting" | "playing" | "stood" | "busted" | "blackjack" | "done";

type BlackjackSeat = {
  id: number;
  name: string;
  bankroll: number;
  bet: number;
  hand: Card[];
  status: SeatStatus;
  pendingLeave: boolean;
  joined: boolean;
  lastOutcome?: "win" | "lose" | "push" | "blackjack";
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
const BLACKJACK_DECKS = 6;
const BLACKJACK_HOUSE_EDGE = 0.6;
const BLACKJACK_MIN_BET = 25;

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

function shuffle<T>(items: T[]) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildShoe(decks = BLACKJACK_DECKS) {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const cards: Card[] = [];
  for (let d = 0; d < decks; d += 1) {
    for (const suit of suits) {
      for (const rank of ranks) {
        let value = Number(rank);
        if (Number.isNaN(value)) {
          value = rank === "A" ? 11 : 10;
        }
        cards.push({ rank, suit, value });
      }
    }
  }
  return shuffle(cards);
}

function getHandTotals(cards: Card[]) {
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
  const isSoft = cards.some((card) => card.rank === "A") && total <= 21 && cards.reduce((sum, c) => sum + c.value, 0) !== total;
  return { total, isSoft, isBust: total > 21 };
}

function isBlackjack(cards: Card[]) {
  if (cards.length !== 2) return false;
  const { total } = getHandTotals(cards);
  return total === 21;
}

function formatHand(cards: Card[]) {
  if (cards.length === 0) return "—";
  return cards.map((card) => `${card.rank}${card.suit}`).join(" · ");
}

function basicStrategyDecision(total: number, isSoft: boolean, dealerUpcard: number) {
  if (isSoft) {
    if (total >= 19) return "stand";
    if (total === 18) return dealerUpcard >= 9 || dealerUpcard === 1 ? "hit" : "stand";
    return "hit";
  }
  if (total >= 17) return "stand";
  if (total <= 11) return "hit";
  if (total === 12) return dealerUpcard >= 4 && dealerUpcard <= 6 ? "stand" : "hit";
  return dealerUpcard >= 2 && dealerUpcard <= 6 ? "stand" : "hit";
}

function drawRandomCard(deck: Card[]) {
  const index = Math.floor(Math.random() * deck.length);
  const [card] = deck.splice(index, 1);
  return card;
}

function simulateDealerHand(deck: Card[], dealerCards: Card[]) {
  const cards = [...dealerCards];
  while (true) {
    const totals = getHandTotals(cards);
    if (totals.total > 21) break;
    if (totals.total > 17) break;
    if (totals.total === 17 && !totals.isSoft) break;
    if (deck.length === 0) break;
    cards.push(drawRandomCard(deck));
  }
  return cards;
}

function simulatePlayerHand(deck: Card[], playerCards: Card[], dealerUpcard: number) {
  const cards = [...playerCards];
  while (true) {
    const totals = getHandTotals(cards);
    if (totals.total >= 21) break;
    const decision = basicStrategyDecision(totals.total, totals.isSoft, dealerUpcard);
    if (decision === "stand") break;
    if (deck.length === 0) break;
    cards.push(drawRandomCard(deck));
  }
  return cards;
}

function simulateOdds(
  baseDeck: Card[],
  playerCards: Card[],
  dealerUpcard: Card | null,
  iterations = 1200
) {
  if (!dealerUpcard || playerCards.length === 0) {
    return { win: 0, push: 0, lose: 0, ev: 0 };
  }
  let win = 0;
  let push = 0;
  let lose = 0;
  let ev = 0;
  for (let i = 0; i < iterations; i += 1) {
    const deck = [...baseDeck];
    const upcard = dealerUpcard;
    const hole = drawRandomCard(deck);
    const dealerCards = [upcard, hole];
    const playerSimCards = simulatePlayerHand(deck, playerCards, upcard.value === 11 ? 1 : upcard.value);
    const playerTotals = getHandTotals(playerSimCards);
    if (playerTotals.total > 21) {
      lose += 1;
      ev -= 1;
      continue;
    }
    const dealerFinal = simulateDealerHand(deck, dealerCards);
    const dealerTotals = getHandTotals(dealerFinal);
    const playerHasBlackjack = isBlackjack(playerSimCards);
    const dealerHasBlackjack = isBlackjack(dealerFinal);
    if (dealerHasBlackjack && playerHasBlackjack) {
      push += 1;
    } else if (playerHasBlackjack) {
      win += 1;
      ev += 1.5;
    } else if (dealerTotals.total > 21) {
      win += 1;
      ev += 1;
    } else if (playerTotals.total > dealerTotals.total) {
      win += 1;
      ev += 1;
    } else if (playerTotals.total < dealerTotals.total) {
      lose += 1;
      ev -= 1;
    } else {
      push += 1;
    }
  }
  const total = win + push + lose;
  if (!total) return { win: 0, push: 0, lose: 0, ev: 0 };
  return {
    win: (win / total) * 100,
    push: (push / total) * 100,
    lose: (lose / total) * 100,
    ev: ev / total,
  };
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
  const [blackjackSeats, setBlackjackSeats] = useState<BlackjackSeat[]>(() =>
    Array.from({ length: 5 }, (_, index) => ({
      id: index,
      name: "",
      bankroll: 1000,
      bet: BLACKJACK_MIN_BET,
      hand: [],
      status: "empty",
      pendingLeave: false,
      joined: false,
    }))
  );
  const [blackjackDealer, setBlackjackDealer] = useState<Card[]>([]);
  const [blackjackShoe, setBlackjackShoe] = useState<Card[]>(() => buildShoe());
  const [blackjackPhase, setBlackjackPhase] = useState<"idle" | "player" | "dealer" | "settled">("idle");
  const [blackjackActiveSeat, setBlackjackActiveSeat] = useState<number | null>(null);
  const [blackjackLog, setBlackjackLog] = useState<string[]>([]);
  const [coinDecimals, setCoinDecimals] = useState<number>(18);
  const [coinBalance, setCoinBalance] = useState<bigint | null>(null);
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
    if (activeTab === "odds" && oddsRows.length === 0 && !oddsLoading) {
      loadOddsHistory();
    }
  }, [activeTab, oddsLoading, oddsRows.length]);

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
            avatarUrl: row.profile.avatarUrl,
            placements: [],
            contributions: [],
            strength: 0,
          });
        }
        const player = map.get(key);
        if (player) {
          player.placements.push(row.position);
          if (!player.avatarUrl && row.profile.avatarUrl) player.avatarUrl = row.profile.avatarUrl;
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

  const dealerTotals = useMemo(() => getHandTotals(blackjackDealer), [blackjackDealer]);
  const blackjackOddsDeck = useMemo(() => {
    if (blackjackPhase === "player") {
      return [...blackjackShoe, ...blackjackDealer.slice(1)];
    }
    return blackjackShoe;
  }, [blackjackShoe, blackjackDealer, blackjackPhase]);
  const blackjackOdds = useMemo(() => {
    const upcard = blackjackDealer[0] || null;
    return blackjackSeats.map((seat) =>
      seat.joined && seat.hand.length > 0
        ? simulateOdds(blackjackOddsDeck, seat.hand, upcard)
        : { win: 0, push: 0, lose: 0, ev: 0 }
    );
  }, [blackjackSeats, blackjackDealer, blackjackOddsDeck]);

  function appendBlackjackLog(message: string) {
    setBlackjackLog((prev) => [message, ...prev].slice(0, 6));
  }

  function updateSeat(id: number, updates: Partial<BlackjackSeat>) {
    setBlackjackSeats((prev) =>
      prev.map((seat) => (seat.id === id ? { ...seat, ...updates } : seat))
    );
  }

  function joinSeat(id: number) {
    setBlackjackSeats((prev) =>
      prev.map((seat) =>
        seat.id === id
          ? {
              ...seat,
              joined: true,
              status: "waiting",
              pendingLeave: false,
              hand: [],
              lastOutcome: undefined,
            }
          : seat
      )
    );
    appendBlackjackLog(`Seat ${id + 1} joined the table.`);
  }

  function leaveSeat(id: number) {
    setBlackjackSeats((prev) =>
      prev.map((seat) => {
        if (seat.id !== id) return seat;
        if (!seat.joined) return seat;
        if (blackjackPhase === "player" || blackjackPhase === "dealer") {
          return { ...seat, pendingLeave: true };
        }
        return {
          ...seat,
          joined: false,
          status: "empty",
          hand: [],
          pendingLeave: false,
          lastOutcome: undefined,
        };
      })
    );
    appendBlackjackLog(`Seat ${id + 1} will leave after this round.`);
  }

  function shuffleShoe() {
    if (blackjackPhase !== "idle" && blackjackPhase !== "settled") return;
    setBlackjackShoe(buildShoe());
    appendBlackjackLog("Dealer shuffled a fresh shoe.");
  }

  function startBlackjackRound() {
    const activeSeats = blackjackSeats.filter((seat) => seat.joined);
    if (activeSeats.length === 0) {
      appendBlackjackLog("No players seated. Join a seat to start a round.");
      return;
    }
    let shoe = blackjackShoe;
    const requiredCards = activeSeats.length * 2 + 2;
    if (shoe.length < requiredCards) {
      shoe = buildShoe();
      appendBlackjackLog("Shoe re-shuffled for the next hand.");
    }
    const nextShoe = [...shoe];
    // We ensure the shoe has enough cards before dealing, so this is safe.
    const draw = () => nextShoe.shift()!;
    const nextDealer: Card[] = [];
    const dealtSeats: BlackjackSeat[] = blackjackSeats.map((seat): BlackjackSeat => {
      if (!seat.joined) return seat;
      const bet = Math.max(BLACKJACK_MIN_BET, Math.min(seat.bet, seat.bankroll));
      if (bet <= 0 || seat.bankroll < bet) {
        return { ...seat, status: "waiting", hand: [], lastOutcome: undefined };
      }
      const hand: Card[] = [draw(), draw()];
      const status: SeatStatus = isBlackjack(hand) ? "blackjack" : "playing";
      return {
        ...seat,
        bet,
        bankroll: seat.bankroll - bet,
        hand,
        status,
        lastOutcome: undefined,
      };
    });
    nextDealer.push(draw(), draw());
    const firstPlayingIndex = dealtSeats.findIndex((seat) => seat.joined && seat.status === "playing");
    setBlackjackSeats(dealtSeats);
    setBlackjackDealer(nextDealer);
    setBlackjackShoe(nextShoe);
    if (firstPlayingIndex === -1) {
      setBlackjackPhase("dealer");
      setBlackjackActiveSeat(null);
      resolveDealerAndPayout(dealtSeats, nextDealer);
    } else {
      setBlackjackPhase("player");
      setBlackjackActiveSeat(firstPlayingIndex);
    }
    appendBlackjackLog("Cards are dealt. Players act in seat order.");
  }

  function advanceToDealerIfDone(nextSeats: BlackjackSeat[]) {
    const nextIndex = nextSeats.findIndex((seat) => seat.joined && seat.status === "playing");
    if (nextIndex === -1) {
      setBlackjackPhase("dealer");
      setBlackjackActiveSeat(null);
      resolveDealerAndPayout(nextSeats);
    } else {
      setBlackjackActiveSeat(nextIndex);
    }
  }

  function handleHit(seatId: number) {
    if (blackjackPhase !== "player") return;
    setBlackjackSeats((prev) => {
      const seatIndex = prev.findIndex((seat) => seat.id === seatId);
      if (seatIndex === -1) return prev;
      if (blackjackActiveSeat !== seatIndex) return prev;
      const nextSeats = [...prev];
      const seat = nextSeats[seatIndex];
      if (seat.status !== "playing") return prev;
      const nextShoe = [...blackjackShoe];
      const card = nextShoe.shift();
      if (!card) return prev;
      seat.hand = [...seat.hand, card];
      const totals = getHandTotals(seat.hand);
      if (totals.total > 21) {
        seat.status = "busted";
      } else if (totals.total === 21) {
        seat.status = "stood";
      }
      setBlackjackShoe(nextShoe);
      if (seat.status !== "playing") {
        advanceToDealerIfDone(nextSeats);
      }
      return nextSeats;
    });
  }

  function handleStand(seatId: number) {
    if (blackjackPhase !== "player") return;
    setBlackjackSeats((prev) => {
      const seatIndex = prev.findIndex((seat) => seat.id === seatId);
      if (seatIndex === -1) return prev;
      if (blackjackActiveSeat !== seatIndex) return prev;
      const nextSeats = [...prev];
      nextSeats[seatIndex] = { ...nextSeats[seatIndex], status: "stood" };
      advanceToDealerIfDone(nextSeats);
      return nextSeats;
    });
  }

  function handleDouble(seatId: number) {
    if (blackjackPhase !== "player") return;
    setBlackjackSeats((prev) => {
      const seatIndex = prev.findIndex((seat) => seat.id === seatId);
      if (seatIndex === -1) return prev;
      if (blackjackActiveSeat !== seatIndex) return prev;
      const nextSeats = [...prev];
      const seat = nextSeats[seatIndex];
      if (seat.status !== "playing" || seat.hand.length !== 2) return prev;
      if (seat.bankroll < seat.bet) return prev;
      const nextShoe = [...blackjackShoe];
      const card = nextShoe.shift();
      if (!card) return prev;
      seat.hand = [...seat.hand, card];
      seat.bankroll -= seat.bet;
      seat.bet *= 2;
      const totals = getHandTotals(seat.hand);
      seat.status = totals.total > 21 ? "busted" : "stood";
      setBlackjackShoe(nextShoe);
      advanceToDealerIfDone(nextSeats);
      return nextSeats;
    });
  }

  function resolveDealerAndPayout(currentSeats: BlackjackSeat[], dealerOverride?: Card[]) {
    setBlackjackShoe((prevShoe) => {
      const nextShoe = [...prevShoe];
      const baseDealer = dealerOverride ?? blackjackDealer;
      const nextDealer = baseDealer.length > 0 ? [...baseDealer] : [];
      while (nextDealer.length < 2 && nextShoe.length > 0) {
        nextDealer.push(nextShoe.shift() as Card);
      }
      while (true) {
        const totals = getHandTotals(nextDealer);
        if (totals.total > 21) break;
        if (totals.total > 17) break;
        if (totals.total === 17 && !totals.isSoft) break;
        if (nextShoe.length === 0) break;
        nextDealer.push(nextShoe.shift() as Card);
      }
      const dealerTotalsFinal = getHandTotals(nextDealer);
      const dealerHasBlackjack = isBlackjack(nextDealer);
      const settledSeats: BlackjackSeat[] = currentSeats.map((seat): BlackjackSeat => {
        if (!seat.joined || seat.status === "waiting" || seat.status === "empty") return seat;
        const playerTotals = getHandTotals(seat.hand);
        let payout = 0;
        let outcome: BlackjackSeat["lastOutcome"] = "lose";
        if (playerTotals.total > 21) {
          payout = 0;
          outcome = "lose";
        } else if (dealerHasBlackjack && isBlackjack(seat.hand)) {
          payout = seat.bet;
          outcome = "push";
        } else if (isBlackjack(seat.hand)) {
          payout = seat.bet * 2.5;
          outcome = "blackjack";
        } else if (dealerTotalsFinal.total > 21) {
          payout = seat.bet * 2;
          outcome = "win";
        } else if (playerTotals.total > dealerTotalsFinal.total) {
          payout = seat.bet * 2;
          outcome = "win";
        } else if (playerTotals.total === dealerTotalsFinal.total) {
          payout = seat.bet;
          outcome = "push";
        }
        return {
          ...seat,
          bankroll: seat.bankroll + payout,
          status: "done",
          lastOutcome: outcome,
        };
      });
      setBlackjackDealer(nextDealer);
      setBlackjackSeats(
        settledSeats.map((seat): BlackjackSeat =>
          seat.pendingLeave
            ? {
                ...seat,
                joined: false,
                status: "empty",
                hand: [],
                pendingLeave: false,
                lastOutcome: undefined,
              }
            : seat
        )
      );
      setBlackjackPhase("settled");
      appendBlackjackLog(
        dealerTotalsFinal.total > 21 ? "Dealer busts. Payouts settled." : "Dealer stands. Payouts settled."
      );
      return nextShoe;
    });
  }

  function resetBlackjackRound() {
    setBlackjackSeats((prev) =>
      prev.map((seat) =>
        seat.joined
          ? {
              ...seat,
              hand: [],
              status: "waiting",
              bet: Math.max(BLACKJACK_MIN_BET, seat.bet),
              lastOutcome: undefined,
            }
          : seat
      )
    );
    setBlackjackDealer([]);
    setBlackjackPhase("idle");
    setBlackjackActiveSeat(null);
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
                      src={row.avatarUrl}
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
        <section className="card blackjack-card">
          <div className="blackjack-header">
            <div>
              <div className="section-title">Blackjack Table</div>
              <div className="subtle">
                6-deck shoe · Dealer hits soft 17 · Blackjack pays 3:2 · Double on any two cards · No splits.
              </div>
            </div>
            <div className="blackjack-actions">
              <button className="btn" onClick={shuffleShoe} disabled={blackjackPhase === "player" || blackjackPhase === "dealer"}>
                Shuffle Shoe
              </button>
              <button
                className="btn"
                onClick={resetBlackjackRound}
                disabled={blackjackPhase === "player" || blackjackPhase === "dealer"}
              >
                Reset Round
              </button>
              <button
                className="btn btn-primary"
                onClick={startBlackjackRound}
                disabled={blackjackPhase === "player" || blackjackPhase === "dealer"}
              >
                Deal
              </button>
            </div>
          </div>

          <div className="blackjack-meta">
            <div>
              <div className="label">House Edge</div>
              <div className="title">{BLACKJACK_HOUSE_EDGE.toFixed(1)}%</div>
              <div className="subtle">Calculated under the rules above with basic strategy.</div>
            </div>
            <div>
              <div className="label">Shoe</div>
              <div className="title">
                {blackjackShoe.length} cards · {BLACKJACK_DECKS} decks
              </div>
              <div className="subtle">Auto reshuffles when the shoe is low.</div>
            </div>
            <div>
              <div className="label">Phase</div>
              <div className="title">{blackjackPhase === "idle" ? "Waiting" : blackjackPhase}</div>
              <div className="subtle">
                {blackjackActiveSeat !== null ? `Seat ${blackjackActiveSeat + 1} to act.` : "Dealer pending."}
              </div>
            </div>
          </div>

          <div className="dealer-row">
            <div className="dealer-title">Dealer</div>
            <div className="dealer-hand">
              {blackjackDealer.length === 0 ? (
                <span>—</span>
              ) : blackjackPhase === "player" ? (
                <span>
                  {blackjackDealer[0] ? `${blackjackDealer[0].rank}${blackjackDealer[0].suit}` : "—"} · ??
                </span>
              ) : (
                <span>{formatHand(blackjackDealer)}</span>
              )}
            </div>
            <div className="dealer-total">
              {blackjackDealer.length === 0
                ? "Total: —"
                : blackjackPhase === "player"
                ? "Total: ?"
                : `Total: ${dealerTotals.total}`}
            </div>
          </div>

          <div className="blackjack-seats">
            {blackjackSeats.map((seat, index) => {
              const totals = getHandTotals(seat.hand);
              const odds = blackjackOdds[index];
              const isActive = blackjackActiveSeat === index && blackjackPhase === "player";
              const canAct = isActive && seat.status === "playing";
              return (
                <div
                  className={`seat-card ${seat.joined ? "occupied" : "open"} ${isActive ? "active" : ""}`}
                  key={seat.id}
                >
                  <div className="seat-header">
                    <div>
                      <div className="seat-title">Seat {index + 1}</div>
                      <div className="subtle">{seat.joined ? seat.name || "Player" : "Open seat"}</div>
                    </div>
                    {seat.joined ? (
                      <button className="btn btn-ghost" onClick={() => leaveSeat(seat.id)}>
                        {seat.pendingLeave ? "Leaving..." : "Leave"}
                      </button>
                    ) : (
                      <button className="btn btn-primary" onClick={() => joinSeat(seat.id)}>
                        Join
                      </button>
                    )}
                  </div>

                  {seat.joined && (
                    <>
                      <div className="seat-fields">
                        <div>
                          <label>Name</label>
                          <input
                            value={seat.name}
                            onChange={(e) => updateSeat(seat.id, { name: e.target.value })}
                            placeholder="Player name"
                            disabled={blackjackPhase === "player" || blackjackPhase === "dealer"}
                          />
                        </div>
                        <div>
                          <label>Buy-in</label>
                          <input
                            type="number"
                            min={0}
                            value={seat.bankroll}
                            onChange={(e) => updateSeat(seat.id, { bankroll: Number(e.target.value) })}
                            disabled={blackjackPhase === "player" || blackjackPhase === "dealer"}
                          />
                        </div>
                        <div>
                          <label>Bet</label>
                          <input
                            type="number"
                            min={BLACKJACK_MIN_BET}
                            value={seat.bet}
                            onChange={(e) => updateSeat(seat.id, { bet: Number(e.target.value) })}
                            disabled={blackjackPhase === "player" || blackjackPhase === "dealer"}
                          />
                        </div>
                      </div>

                      <div className="seat-hand">
                        <div className="seat-hand-cards">{formatHand(seat.hand)}</div>
                        <div className="subtle">
                          Total: {seat.hand.length > 0 ? totals.total : "—"} · Status: {seat.status}
                        </div>
                        {seat.lastOutcome && (
                          <div className={`seat-outcome seat-outcome-${seat.lastOutcome}`}>
                            {seat.lastOutcome.toUpperCase()}
                          </div>
                        )}
                      </div>

                      <div className="seat-odds">
                        <div>
                          Win: {odds.win.toFixed(1)}% · Push: {odds.push.toFixed(1)}% · Lose:{" "}
                          {odds.lose.toFixed(1)}%
                        </div>
                        <div className="subtle">EV: {odds.ev >= 0 ? "+" : ""}{odds.ev.toFixed(2)}x per unit</div>
                      </div>

                      <div className="seat-actions">
                        <button className="btn" onClick={() => handleHit(seat.id)} disabled={!canAct}>
                          Hit
                        </button>
                        <button className="btn" onClick={() => handleStand(seat.id)} disabled={!canAct}>
                          Stand
                        </button>
                        <button
                          className="btn"
                          onClick={() => handleDouble(seat.id)}
                          disabled={!canAct || seat.bankroll < seat.bet || seat.hand.length !== 2}
                        >
                          Double
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          <div className="blackjack-log">
            <div className="section-title">Live Table Log</div>
            {blackjackLog.length === 0 ? (
              <div className="subtle">Log updates will appear here as players enter, leave, and play hands.</div>
            ) : (
              <ul>
                {blackjackLog.map((entry, index) => (
                  <li key={`${entry}-${index}`}>{entry}</li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {activeTab === "betting" && (
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
