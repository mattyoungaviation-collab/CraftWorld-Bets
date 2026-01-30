import { useCallback, useEffect, useState } from "react";
import { DYNW_TOKEN } from "./tokens";

const ERC20_BALANCE_OF = "0x70a08231";

function padAddress(address: string) {
  return address.toLowerCase().replace("0x", "").padStart(64, "0");
}

export function useRoninBalances(wallet: string | null, walletProvider: any) {
  const [ronBalance, setRonBalance] = useState<bigint | null>(null);
  const [dynwBalance, setDynwBalance] = useState<bigint | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet || !walletProvider) return;
    try {
      const [ronHex, dynwHex] = await Promise.all([
        walletProvider.request({ method: "eth_getBalance", params: [wallet, "latest"] }),
        walletProvider.request({
          method: "eth_call",
          params: [{ to: DYNW_TOKEN.address, data: `${ERC20_BALANCE_OF}${padAddress(wallet)}` }, "latest"],
        }),
      ]);
      setRonBalance(BigInt(ronHex));
      setDynwBalance(BigInt(dynwHex));
    } catch (e) {
      console.error(e);
    }
  }, [wallet, walletProvider]);

  useEffect(() => {
    if (!wallet || !walletProvider) {
      setRonBalance(null);
      setDynwBalance(null);
      return;
    }
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh, wallet, walletProvider]);

  return { ronBalance, dynwBalance, refresh };
}
