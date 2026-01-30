import { useState } from "react";
import { Link } from "react-router-dom";
import SiteFooter from "../components/SiteFooter";
import { DYNW_TOKEN, DYNW_VAULT_ADDRESS, shortAddress } from "../lib/tokens";
import { useWallet } from "../lib/wallet";

export default function Token() {
  const { wallet, provider, connectWallet, disconnectWallet, walletConnectEnabled } = useWallet();
  const [status, setStatus] = useState("");

  async function handleWalletAction() {
    setStatus("");
    try {
      if (wallet) {
        await disconnectWallet();
      } else {
        await connectWallet();
      }
    } catch (e: any) {
      setStatus(e?.message || String(e));
    }
  }

  async function handleAddToken() {
    setStatus("");
    const requestProvider = provider || (window as any)?.ethereum;
    if (!requestProvider?.request) {
      setStatus("No wallet provider available for adding the token.");
      return;
    }
    try {
      await requestProvider.request({
        method: "wallet_watchAsset",
        params: {
          type: "ERC20",
          options: {
            address: DYNW_TOKEN.address,
            symbol: DYNW_TOKEN.symbol,
            decimals: DYNW_TOKEN.decimals,
            image: `${window.location.origin}/dynowager-300.svg`,
          },
        },
      });
      setStatus("Token added to wallet.");
    } catch (e: any) {
      setStatus(e?.message || String(e));
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <div className="eyebrow">DynoWager</div>
          <h1>DYNW Token</h1>
          <div className="subtle">Contract details, vault, and wallet setup.</div>
        </div>
        <div className="header-actions">
          <div className="price-pill">
            <div>Wallet</div>
            <strong>{wallet ? shortAddress(wallet) : "Not connected"}</strong>
          </div>
          <div className="header-links">
            <Link className="btn btn-ghost" to="/">
              Back to Bets
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
        </div>
      </header>

      <section className="card token-hero">
        <div>
          <img src="/dynowager-300.svg" alt="DynoWager logo" className="token-logo" />
        </div>
        <div>
          <div className="section-title">DynoWager (DYNW)</div>
          <div className="subtle">Ronin Mainnet ERC-20 token powering CraftWorld Bets.</div>
          <div className="token-meta">
            <div>
              <div className="label">Token Address</div>
              <div className="static-field">{DYNW_TOKEN.address}</div>
            </div>
            <div>
              <div className="label">Decimals</div>
              <div className="static-field">{DYNW_TOKEN.decimals}</div>
            </div>
            <div>
              <div className="label">Vault Address</div>
              <div className="static-field">{DYNW_VAULT_ADDRESS}</div>
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-primary" onClick={handleAddToken}>
              Add DYNW to wallet
            </button>
          </div>
          {status && <div className="toast">{status}</div>}
        </div>
      </section>

      <section className="card">
        <img src="/dynowager-banner-1280x230.svg" alt="DynoWager banner" className="token-banner" />
      </section>

      <SiteFooter />
    </div>
  );
}
