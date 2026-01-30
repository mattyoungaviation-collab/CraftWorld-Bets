import { useCallback, useEffect, useState } from "react";
import { DYNW_TOKEN, WRON_TOKEN } from "./tokens";

const ERC20_BALANCE_OF = "0x70a08231";

function padAddress(address: string) {
  return address.toLowerCase().replace("0x", "").padStart(64, "0");
}

export function useRoninBalances(wallet: string | null, walletProvider: any) {
  const [ronBalance, setRonBalance] = useState<bigint | null>(null);
  const [dynwBalance, setDynwBalance] = useState<bigint | null>(null);
  const [wronBalance, setWronBalance] = useState<bigint | null>(null);

  const refresh = useCallback(async () => {
    if (!wallet || !walletProvider) return;
    try {
      const balanceCalls = [
        walletProvider.request({ method: "eth_getBalance", params: [wallet, "latest"] }),
        walletProvider.request({
          method: "eth_call",
          params: [{ to: DYNW_TOKEN.address, data: `${ERC20_BALANCE_OF}${padAddress(wallet)}` }, "latest"],
        }),
      ];
      if (WRON_TOKEN.address) {
        balanceCalls.push(
          walletProvider.request({
            method: "eth_call",
            params: [{ to: WRON_TOKEN.address, data: `${ERC20_BALANCE_OF}${padAddress(wallet)}` }, "latest"],
          }),
        );
      }
      const [ronHex, dynwHex, wronHex] = await Promise.all(balanceCalls);
      setRonBalance(BigInt(ronHex));
      setDynwBalance(BigInt(dynwHex));
      setWronBalance(WRON_TOKEN.address && wronHex ? BigInt(wronHex) : null);
    } catch (e) {
      console.error(e);
    }
  }, [wallet, walletProvider]);

  useEffect(() => {
    if (!wallet || !walletProvider) {
      setRonBalance(null);
      setDynwBalance(null);
      setWronBalance(null);
      return;
    }
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [refresh, wallet, walletProvider]);

  return { ronBalance, dynwBalance, wronBalance, refresh };
}
