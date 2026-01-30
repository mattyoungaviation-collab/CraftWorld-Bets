import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "./tokens";
import { getDynwRonReserves, getRoninProvider } from "./katana";

export type DynwRonPoolState = {
  priceRonPerDynw: number | null;
  reserveRon: bigint | null;
  reserveDynw: bigint | null;
  pairAddress: string | null;
  error: string | null;
};

export function useDynwRonPool() {
  const [state, setState] = useState<DynwRonPoolState>({
    priceRonPerDynw: null,
    reserveRon: null,
    reserveDynw: null,
    pairAddress: null,
    error: null,
  });

  const load = useCallback(async () => {
    try {
      const provider = getRoninProvider();
      const { reserveRon, reserveDynw, pairAddress } = await getDynwRonReserves(provider);
      const ron = Number(formatUnits(reserveRon, 18));
      const dynw = Number(formatUnits(reserveDynw, 18));
      const priceRonPerDynw = dynw > 0 ? ron / dynw : null;
      setState({
        priceRonPerDynw,
        reserveRon,
        reserveDynw,
        pairAddress,
        error: null,
      });
    } catch (e: any) {
      setState((prev) => ({
        ...prev,
        error: e?.message || String(e),
      }));
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  return { ...state, refresh: load };
}
