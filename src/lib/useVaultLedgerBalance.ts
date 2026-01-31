import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract } from "ethers";
import { DYNW_TOKEN } from "./tokens";
import { VAULT_LEDGER_ABI, VAULT_LEDGER_ADDRESS } from "./vaultLedger";

export function useVaultLedgerBalance(wallet: string | null, provider: any) {
  const [vaultBalance, setVaultBalance] = useState<bigint | null>(null);
  const [vaultLocked, setVaultLocked] = useState<bigint | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet || !provider || !VAULT_LEDGER_ADDRESS) return;
    try {
      const browserProvider = new BrowserProvider(provider);
      const contract = new Contract(VAULT_LEDGER_ADDRESS, VAULT_LEDGER_ABI, browserProvider);
      const [balance, locked] = await Promise.all([
        contract.getAvailableBalance(DYNW_TOKEN.address, wallet),
        contract.getLockedBalance(DYNW_TOKEN.address, wallet),
      ]);
      setVaultBalance(BigInt(balance));
      setVaultLocked(BigInt(locked));
    } catch (e) {
      try {
        const browserProvider = new BrowserProvider(provider);
        const contract = new Contract(VAULT_LEDGER_ADDRESS, VAULT_LEDGER_ABI, browserProvider);
        const [balance, locked] = await Promise.all([
          contract.balances(wallet, DYNW_TOKEN.address),
          contract.lockedBalances(wallet, DYNW_TOKEN.address),
        ]);
        setVaultBalance(BigInt(balance));
        setVaultLocked(BigInt(locked));
      } catch (err) {
        console.error(err);
      }
    }
  }, [wallet, provider]);

  useEffect(() => {
    if (!wallet || !provider) {
      setVaultBalance(null);
      setVaultLocked(null);
      return;
    }
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh, wallet, provider]);

  return { vaultBalance, vaultLocked, refresh };
}
