import EthereumProvider from "@walletconnect/ethereum-provider";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { RONIN_CHAIN } from "./tokens";

type WalletContextValue = {
  wallet: string | null;
  provider: any;
  chainId: number | null;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => Promise<void>;
  walletConnectEnabled: boolean;
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [wallet, setWallet] = useState<string | null>(null);
  const [provider, setProvider] = useState<any>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined;
  const walletConnectEnabled = Boolean(walletConnectProjectId);

  const connectWallet = useCallback(async () => {
    if (!walletConnectProjectId) {
      throw new Error("Missing VITE_WALLETCONNECT_PROJECT_ID. Add it to your environment to use WalletConnect.");
    }

    const wcProvider = await EthereumProvider.init({
      projectId: walletConnectProjectId,
      chains: [RONIN_CHAIN.chainId],
      optionalChains: [RONIN_CHAIN.chainId],
      showQrModal: true,
      metadata: {
        name: "CraftWorld Bets",
        description: "Betting desk for CraftWorld masterpieces.",
        url: window.location.origin,
        icons: ["https://walletconnect.com/walletconnect-logo.png"],
      },
      rpcMap: {
        [RONIN_CHAIN.chainId]: RONIN_CHAIN.rpcUrl,
      },
    });

    await wcProvider.enable();
    const accounts = wcProvider.accounts;
    const acct = accounts?.[0];
    if (acct) {
      setProvider(wcProvider);
      setWallet(acct);
    }
    const chainHex = await wcProvider.request({ method: "eth_chainId", params: [] });
    if (typeof chainHex === "string") {
      setChainId(Number.parseInt(chainHex, 16));
    }
  }, [walletConnectProjectId]);

  const disconnectWallet = useCallback(async () => {
    if (provider?.disconnect) {
      await provider.disconnect();
    }
    setWallet(null);
    setProvider(null);
    setChainId(null);
  }, [provider]);

  useEffect(() => {
    if (!provider) return;

    const handleAccountsChanged = (accounts: string[]) => {
      const next = accounts?.[0] || null;
      setWallet(next);
      if (!next) setChainId(null);
    };

    const handleChainChanged = (nextChain: string) => {
      if (typeof nextChain === "string") {
        setChainId(Number.parseInt(nextChain, 16));
      }
    };

    const handleDisconnect = () => {
      setWallet(null);
      setProvider(null);
      setChainId(null);
    };

    provider.on?.("accountsChanged", handleAccountsChanged);
    provider.on?.("chainChanged", handleChainChanged);
    provider.on?.("disconnect", handleDisconnect);

    return () => {
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
      provider.removeListener?.("disconnect", handleDisconnect);
    };
  }, [provider]);

  const value = useMemo(
    () => ({
      wallet,
      provider,
      chainId,
      connectWallet,
      disconnectWallet,
      walletConnectEnabled,
    }),
    [wallet, provider, chainId, connectWallet, disconnectWallet, walletConnectEnabled]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within a WalletProvider");
  }
  return ctx;
}
