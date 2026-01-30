import { formatUnits as ethersFormatUnits, parseUnits as ethersParseUnits } from "ethers";

export const RONIN_CHAIN = {
  chainId: 2020,
  rpcUrl: "https://api.roninchain.com/rpc",
};

export const DYNW_TOKEN = {
  name: "DynoWager",
  symbol: "DYNW",
  decimals: 18,
  address: "0x17ff4EA5dD318E5FAf7f5554667d65abEC96Ff57",
};

export const DYNW_VAULT_ADDRESS = "0x16F6c4B4f1cEB84e214931534cde94E525f322CF";

export const WRON_TOKEN = {
  name: "Wrapped RON",
  symbol: "WRON",
  decimals: 18,
  address: (import.meta.env.VITE_WRON_ADDRESS as string | undefined) || "",
};

export const KATANA_ROUTER_ADDRESS =
  (import.meta.env.VITE_KATANA_ROUTER_ADDRESS as string | undefined) || "";
export const KATANA_FACTORY_ADDRESS =
  (import.meta.env.VITE_KATANA_FACTORY_ADDRESS as string | undefined) || "";
export const KATANA_PAIR_ADDRESS =
  (import.meta.env.VITE_KATANA_PAIR_ADDRESS as string | undefined) || "";

export const DEFAULT_SLIPPAGE = 0.02;
export const MAX_SLIPPAGE = 0.05;
export const SWAP_DEADLINE_SECONDS = 10 * 60;
export const MAX_SWAP_RON = Number(import.meta.env.VITE_MAX_SWAP_RON ?? 1);

export function formatUnits(value: bigint, decimals = DYNW_TOKEN.decimals) {
  return ethersFormatUnits(value, decimals);
}

export function parseUnits(value: string, decimals = DYNW_TOKEN.decimals) {
  return ethersParseUnits(value || "0", decimals);
}

export function shortAddress(address?: string | null) {
  if (!address) return "—";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
