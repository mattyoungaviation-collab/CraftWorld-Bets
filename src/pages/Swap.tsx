import { toBeHex } from "ethers";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import SiteFooter from "../components/SiteFooter";
import { getRoninProvider, quoteOut } from "../lib/katana";
import { useDynwRonPool } from "../lib/useDynwRonPool";
import { useRoninBalances } from "../lib/useRoninBalances";
import {
  DEFAULT_SLIPPAGE,
  DYNW_TOKEN,
  MAX_SLIPPAGE,
  MAX_SWAP_RON,
  RONIN_CHAIN,
  SWAP_DEADLINE_SECONDS,
  formatUnits,
  parseUnits,
  shortAddress,
} from "../lib/tokens";
import { useWallet } from "../lib/wallet";

const ERC20_ALLOWANCE = "0xdd62ed3e";
const ERC20_APPROVE = "0x095ea7b3";
const ERC20_TRANSFER = "0xa9059cbb";
const KYBER_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

function padAddress(address: string) {
  return address.toLowerCase().replace("0x", "").padStart(64, "0");
}

function padAmount(amount: bigint) {
  return amount.toString(16).padStart(64, "0");
}

function encodeAllowance(owner: string, spender: string) {
  return `${ERC20_ALLOWANCE}${padAddress(owner)}${padAddress(spender)}`;
}

function encodeApprove(spender: string, amount: bigint) {
  return `${ERC20_APPROVE}${padAddress(spender)}${padAmount(amount)}`;
}

function encodeTransfer(to: string, amount: bigint) {
  return `${ERC20_TRANSFER}${padAddress(to)}${padAmount(amount)}`;
}

function formatNumber(value: number | null, decimals = 6) {
  if (value === null || Number.isNaN(value)) return "—";
  return value.toFixed(decimals);
}

export default function Swap() {
  const { wallet, provider: walletProvider, chainId, connectWallet, disconnectWallet, walletConnectEnabled } = useWallet();
  const { ronBalance, dynwBalance, refresh: refreshBalances } = useRoninBalances(wallet, walletProvider);
  const { reserveRon, reserveDynw, priceRonPerDynw, error: poolError, refresh: refreshPool } = useDynwRonPool();
  const [amountIn, setAmountIn] = useState("");
  const [direction, setDirection] = useState<"RON_TO_DYNW" | "DYNW_TO_RON">("RON_TO_DYNW");
  const [slippage, setSlippage] = useState(String(DEFAULT_SLIPPAGE * 100));
  const [swapStatus, setSwapStatus] = useState("");
  const [swapError, setSwapError] = useState("");
  const [gameWalletAddress, setGameWalletAddress] = useState<string | null>(null);
  const [gameWalletBalance, setGameWalletBalance] = useState<bigint | null>(null);
  const [gameWalletRonBalance, setGameWalletRonBalance] = useState<bigint | null>(null);
  const [promptTransferAmount, setPromptTransferAmount] = useState<bigint | null>(null);
  const [transferAmount, setTransferAmount] = useState("");
  const [transferStatus, setTransferStatus] = useState("");
  const [sendToGameWallet, setSendToGameWallet] = useState(true);
  const [swapFromGameWallet, setSwapFromGameWallet] = useState(true);

  const isWrongChain = !!wallet && chainId !== null && chainId !== RONIN_CHAIN.chainId;
  const slippageValue = Number(slippage);
  const slippageTooHigh = Number.isFinite(slippageValue) && slippageValue > MAX_SLIPPAGE * 100;
  const slippageBps = Math.round(Math.min(Math.max(slippageValue || DEFAULT_SLIPPAGE * 100, 0), MAX_SLIPPAGE * 100) * 100);

  const poolReady = reserveRon !== null && reserveDynw !== null;
  const amountParsed = useMemo(() => {
    if (!amountIn) return null;
    try {
      return parseUnits(amountIn, 18);
    } catch {
      return null;
    }
  }, [amountIn]);

  const quote = useMemo(() => {
    if (!amountParsed || !poolReady) return null;
    if (direction === "RON_TO_DYNW") {
      return quoteOut(amountParsed, reserveRon as bigint, reserveDynw as bigint);
    }
    return quoteOut(amountParsed, reserveDynw as bigint, reserveRon as bigint);
  }, [amountParsed, direction, poolReady, reserveRon, reserveDynw]);

  const minReceived = useMemo(() => {
    if (!quote) return null;
    const numerator = 10_000n - BigInt(slippageBps);
    return (quote * numerator) / 10_000n;
  }, [quote, slippageBps]);

  const priceImpact = useMemo(() => {
    if (!amountParsed || !poolReady) return null;
    const reserve = direction === "RON_TO_DYNW" ? reserveRon : reserveDynw;
    if (!reserve || reserve === 0n) return null;
    const amountNum = Number(formatUnits(amountParsed, 18));
    const reserveNum = Number(formatUnits(reserve, 18));
    if (!Number.isFinite(amountNum) || !Number.isFinite(reserveNum) || reserveNum === 0) return null;
    return (amountNum / reserveNum) * 100;
  }, [amountParsed, direction, poolReady, reserveRon, reserveDynw]);

  const maxDynwAllowed = useMemo(() => {
    if (!priceRonPerDynw || priceRonPerDynw <= 0) return null;
    return MAX_SWAP_RON / priceRonPerDynw;
  }, [priceRonPerDynw]);

  const exceedsCap = useMemo(() => {
    const value = Number(amountIn);
    if (!Number.isFinite(value) || value <= 0) return false;
    if (direction === "RON_TO_DYNW") {
      return value > MAX_SWAP_RON;
    }
    if (!maxDynwAllowed) return false;
    return value > maxDynwAllowed;
  }, [amountIn, direction, maxDynwAllowed]);

  const missingConfig = false;

  useEffect(() => {
    const loadGameWallet = async () => {
      try {
        const res = await fetch("/api/game-wallet");
        const json = await res.json();
        if (res.ok && json?.address) {
          setGameWalletAddress(json.address);
        }
      } catch (e) {
        console.error(e);
      }
    };
    loadGameWallet();
  }, []);

  useEffect(() => {
    if (!gameWalletAddress) return;
    const provider = getRoninProvider();
    const loadBalance = async () => {
      try {
        const data = `0x70a08231${padAddress(gameWalletAddress)}`;
        const balanceHex = await provider.send("eth_call", [{ to: DYNW_TOKEN.address, data }, "latest"]);
        setGameWalletBalance(BigInt(balanceHex));
        const ronBalance = await provider.getBalance(gameWalletAddress);
        setGameWalletRonBalance(ronBalance);
      } catch (e) {
        console.error(e);
      }
    };
    loadBalance();
    const interval = setInterval(loadBalance, 20000);
    return () => clearInterval(interval);
  }, [gameWalletAddress]);

  async function waitForReceipt(txHash: string, timeoutMs = 180000) {
    if (!walletProvider) throw new Error("Wallet provider not ready.");
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const receipt = await walletProvider.request({
        method: "eth_getTransactionReceipt",
        params: [txHash],
      });
      if (receipt) return receipt as { status?: string };
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    throw new Error("Transaction confirmation timed out.");
  }

  async function handleWalletAction() {
    setSwapError("");
    try {
      if (wallet) {
        await disconnectWallet();
      } else {
        await connectWallet();
      }
    } catch (e: any) {
      setSwapError(e?.message || String(e));
    }
  }

  async function handleSwap() {
    setSwapError("");
    setSwapStatus("");
    if (!wallet || !walletProvider) {
      setSwapError("Connect your wallet to swap.");
      return;
    }
    if (isWrongChain) {
      setSwapError(`Switch to Ronin Mainnet (chain ${RONIN_CHAIN.chainId}).`);
      return;
    }
    if (!amountParsed || amountParsed <= 0n) {
      setSwapError("Enter a valid swap amount.");
      return;
    }
    if (slippageTooHigh) {
      setSwapError(`Slippage cannot exceed ${(MAX_SLIPPAGE * 100).toFixed(0)}%.`);
      return;
    }
    if (exceedsCap) {
      setSwapError("Amount exceeds the current max swap cap.");
      return;
    }
    if (missingConfig) {
      setSwapError("Missing Katana router or WRON address configuration.");
      return;
    }

    try {
      setSwapStatus("Refreshing pool...");
      await refreshPool();
      const deadline = Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS;

      if (direction === "DYNW_TO_RON" && swapFromGameWallet) {
        if (!gameWalletAddress) {
          setSwapError("Game wallet address is required for swaps from the game wallet.");
          return;
        }
        setSwapStatus("Requesting game wallet swap...");
        const response = await fetch("/api/game-wallet/swap", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            direction: "DYNW_TO_RON",
            amountIn: amountParsed.toString(),
            slippageTolerance: slippageBps,
            recipient: wallet,
            deadline,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error || "Game wallet swap failed.");
        }
        if (payload?.txHash) {
          setSwapStatus(`Swap submitted from game wallet: ${payload.txHash}`);
          await waitForReceipt(payload.txHash);
        } else {
          setSwapStatus("Swap submitted from game wallet.");
        }
        await refreshBalances();
        return;
      }

      const swapRecipient =
        direction === "RON_TO_DYNW" && sendToGameWallet && gameWalletAddress ? gameWalletAddress : wallet;
      const tokenIn = direction === "RON_TO_DYNW" ? KYBER_NATIVE_TOKEN : DYNW_TOKEN.address;
      const tokenOut = direction === "RON_TO_DYNW" ? DYNW_TOKEN.address : KYBER_NATIVE_TOKEN;
      setSwapStatus("Building Kyber route...");
      const buildResponse = await fetch("/api/kyber/route/build", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tokenIn,
          tokenOut,
          amountIn: amountParsed.toString(),
          sender: wallet,
          recipient: swapRecipient,
          slippageTolerance: slippageBps,
          deadline,
        }),
      });
      const buildPayload = await buildResponse.json();
      if (!buildResponse.ok) {
        throw new Error(buildPayload?.error || "Failed to build Kyber route.");
      }
      const txTo = buildPayload?.to;
      const txData = buildPayload?.data;
      const txValue = BigInt(buildPayload?.value || "0");
      const approvalSpender = buildPayload?.approvalSpender || txTo;
      if (!txTo || !txData) {
        throw new Error("Swap build response was missing transaction data.");
      }
      if (direction === "DYNW_TO_RON") {
        const allowanceHex = await walletProvider.request({
          method: "eth_call",
          params: [{ to: DYNW_TOKEN.address, data: encodeAllowance(wallet, approvalSpender) }, "latest"],
        });
        const allowance = BigInt(allowanceHex);
        if (allowance < amountParsed) {
          setSwapStatus("Approving DYNW...");
          const approveTxHash = await walletProvider.request({
            method: "eth_sendTransaction",
            params: [
              {
                from: wallet,
                to: DYNW_TOKEN.address,
                data: encodeApprove(approvalSpender, amountParsed),
                value: "0x0",
              },
            ],
          });
          await waitForReceipt(approveTxHash as string);
        }
      }

      setSwapStatus("Signing swap transaction...");
      const txHash = await walletProvider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: wallet,
            to: txTo,
            data: txData,
            value: toBeHex(txValue),
          },
        ],
      });
      await waitForReceipt(txHash as string);
      setSwapStatus("Swap confirmed on-chain.");
      await refreshBalances();
      if (direction === "RON_TO_DYNW" && (!sendToGameWallet || !gameWalletAddress)) {
        if (minReceived) {
          setPromptTransferAmount(minReceived);
          setTransferAmount(formatUnits(minReceived, DYNW_TOKEN.decimals));
        }
      }
    } catch (e: any) {
      setSwapError(e?.message || String(e));
    }
  }

  async function handleTransferToGameWallet() {
    setTransferStatus("");
    if (!wallet || !walletProvider) {
      setTransferStatus("Connect your wallet first.");
      return;
    }
    if (!gameWalletAddress) {
      setTransferStatus("Game wallet address not available.");
      return;
    }
    let amount: bigint;
    try {
      amount = parseUnits(transferAmount, DYNW_TOKEN.decimals);
    } catch {
      setTransferStatus("Enter a valid transfer amount.");
      return;
    }
    if (amount <= 0n) {
      setTransferStatus("Enter a transfer amount greater than zero.");
      return;
    }

    try {
      setTransferStatus("Signing transfer...");
      const txHash = await walletProvider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: wallet,
            to: DYNW_TOKEN.address,
            data: encodeTransfer(gameWalletAddress, amount),
            value: "0x0",
          },
        ],
      });
      await waitForReceipt(txHash as string);
      setTransferStatus("Transfer confirmed.");
      setPromptTransferAmount(null);
      await refreshBalances();
    } catch (e: any) {
      setTransferStatus(e?.message || String(e));
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <div className="eyebrow">DynoWager</div>
          <h1>Swap RON ↔ DYNW</h1>
          <div className="subtle">Swap via Katana liquidity with built-in slippage + cap protection.</div>
        </div>
        <div className="header-actions">
          <div className="price-pill">
            <div>DYNW price (RON)</div>
            <strong>{priceRonPerDynw ? `${priceRonPerDynw.toFixed(6)} RON` : "Loading..."}</strong>
          </div>
          <div className="price-pill">
            <div>RON balance</div>
            <strong>
              {wallet ? (ronBalance !== null ? formatUnits(ronBalance, 18) : "Loading...") : "Not connected"}
            </strong>
          </div>
          <div className="price-pill">
            <div>DYNW balance</div>
            <strong>
              {wallet ? (dynwBalance !== null ? formatUnits(dynwBalance, 18) : "Loading...") : "Not connected"}
            </strong>
          </div>
          <div className="price-pill">
            <div>Wallet</div>
            <strong>{wallet ? shortAddress(wallet) : "Not connected"}</strong>
          </div>
          <div className="header-links">
            <Link className="btn btn-ghost" to="/">
              Back to Bets
            </Link>
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
            {wallet ? `Disconnect: ${wallet.slice(0, 6)}...${wallet.slice(-4)}` : "Connect Wallet"}
          </button>
          {isWrongChain && (
            <div className="subtle">Wrong network detected. Switch to Ronin Mainnet (chain {RONIN_CHAIN.chainId}).</div>
          )}
        </div>
      </header>

      <section className="card">
        <div className="section-title">Swap</div>
        <div className="swap-grid">
          <div>
            <label>Direction</label>
            <div className="swap-toggle">
              <button
                className={`btn ${direction === "RON_TO_DYNW" ? "btn-primary" : ""}`}
                onClick={() => setDirection("RON_TO_DYNW")}
              >
                RON → DYNW
              </button>
              <button
                className={`btn ${direction === "DYNW_TO_RON" ? "btn-primary" : ""}`}
                onClick={() => setDirection("DYNW_TO_RON")}
              >
                DYNW → RON
              </button>
            </div>
          </div>
          <div>
            <label>Amount In</label>
            <input
              type="number"
              min="0"
              step="any"
              value={amountIn}
              onChange={(event) => setAmountIn(event.target.value)}
              placeholder={direction === "RON_TO_DYNW" ? "0.0 RON" : "0.0 DYNW"}
            />
            <div className="subtle">
              Max: {direction === "RON_TO_DYNW" ? `${MAX_SWAP_RON} RON` : maxDynwAllowed ? `${maxDynwAllowed.toFixed(4)} DYNW` : "—"}
            </div>
          </div>
          {direction === "RON_TO_DYNW" && (
            <div>
              <label>Output destination</label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={sendToGameWallet}
                  onChange={(event) => setSendToGameWallet(event.target.checked)}
                />
                Send DYNW to game wallet
              </label>
              <div className="subtle">
                {sendToGameWallet && gameWalletAddress ? `Game wallet: ${shortAddress(gameWalletAddress)}` : "Output stays in your wallet."}
              </div>
            </div>
          )}
          {direction === "DYNW_TO_RON" && (
            <div>
              <label>Source wallet</label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={swapFromGameWallet}
                  onChange={(event) => setSwapFromGameWallet(event.target.checked)}
                />
                Use game wallet DYNW balance
              </label>
              <div className="subtle">
                {swapFromGameWallet ? "Swap will be executed by the server signer for the game wallet." : "Swap from your wallet."}
              </div>
            </div>
          )}
          <div>
            <label>Slippage (%)</label>
            <input
              type="number"
              min="0"
              max={MAX_SLIPPAGE * 100}
              step="0.1"
              value={slippage}
              onChange={(event) => setSlippage(event.target.value)}
            />
            <div className="subtle">Default 2% · Max {MAX_SLIPPAGE * 100}%</div>
          </div>
          <div>
            <label>Quote Out</label>
            <div className="static-field">
              {quote ? `${formatUnits(quote, 18)} ${direction === "RON_TO_DYNW" ? "DYNW" : "RON"}` : "—"}
            </div>
            <div className="subtle">
              Min received: {minReceived ? `${formatUnits(minReceived, 18)} ${direction === "RON_TO_DYNW" ? "DYNW" : "RON"}` : "—"}
            </div>
          </div>
        </div>
        <div className="swap-meta">
          <div className="status-pill">
            <span>Price impact</span>
            <strong>{priceImpact !== null ? `${formatNumber(priceImpact, 2)}%` : "—"}</strong>
          </div>
          <div className="status-pill">
            <span>Deadline</span>
            <strong>{SWAP_DEADLINE_SECONDS / 60} min</strong>
          </div>
        </div>
        {poolError && <div className="toast toast-error">Pool error: {poolError}</div>}
        {missingConfig && (
          <div className="toast toast-error">
            Missing Katana router or WRON address configuration. Update your environment variables and restart.
          </div>
        )}
        {slippageTooHigh && <div className="toast toast-error">Slippage cannot exceed {MAX_SLIPPAGE * 100}%.</div>}
        {exceedsCap && <div className="toast toast-error">This amount exceeds the current max swap cap.</div>}
        {swapError && <div className="toast toast-error">{swapError}</div>}
        {swapStatus && <div className="toast">{swapStatus}</div>}
        <div className="actions">
          <button className="btn" onClick={() => setAmountIn("")}>Clear</button>
          <button
            className="btn btn-primary"
            onClick={handleSwap}
            disabled={!wallet || isWrongChain || missingConfig || !!poolError}
          >
            Swap
          </button>
        </div>
      </section>

      <section className="card">
        <div className="section-title">Game Wallet</div>
        <div className="subtle">Send DYNW to your assigned game wallet to place bets.</div>
        <div className="swap-grid" style={{ marginTop: 12 }}>
          <div>
            <label>Game Wallet Address</label>
            <div className="static-field">{gameWalletAddress || "Loading..."}</div>
          </div>
          <div>
            <label>Game Wallet DYNW Balance</label>
            <div className="static-field">
              {gameWalletBalance !== null ? formatUnits(gameWalletBalance, DYNW_TOKEN.decimals) : "—"}
            </div>
          </div>
          <div>
            <label>Game Wallet RON Balance</label>
            <div className="static-field">
              {gameWalletRonBalance !== null ? formatUnits(gameWalletRonBalance, 18) : "—"}
            </div>
          </div>
        </div>
        {promptTransferAmount !== null && promptTransferAmount > 0n && (
          <div className="transfer-card">
            <div className="section-title">Send DYNW to game wallet?</div>
            <div className="subtle">
              Your swap completed. Send DYNW to the game wallet for betting with one more signature.
            </div>
            <div className="swap-grid" style={{ marginTop: 12 }}>
              <div>
                <label>Transfer Amount (DYNW)</label>
                <input
                  type="number"
                  step="any"
                  value={transferAmount}
                  onChange={(event) => setTransferAmount(event.target.value)}
                />
                <div className="subtle">
                  Suggested: {formatUnits(promptTransferAmount, DYNW_TOKEN.decimals)} DYNW
                </div>
              </div>
              <div>
                <label>Destination</label>
                <div className="static-field">{gameWalletAddress || "—"}</div>
              </div>
            </div>
            {transferStatus && <div className="toast">{transferStatus}</div>}
            <div className="actions">
              <button className="btn" onClick={() => setPromptTransferAmount(null)}>
                Not now
              </button>
              <button className="btn btn-primary" onClick={handleTransferToGameWallet}>
                Send DYNW
              </button>
            </div>
          </div>
        )}
      </section>

      <SiteFooter />
    </div>
  );
}
