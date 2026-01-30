import { Contract, JsonRpcProvider } from "ethers";
import { DYNW_TOKEN, KATANA_FACTORY_ADDRESS, KATANA_PAIR_ADDRESS, RONIN_CHAIN, WRON_TOKEN } from "./tokens";

const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address)"];
const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

const roninProvider = new JsonRpcProvider(RONIN_CHAIN.rpcUrl);

export function getRoninProvider() {
  return roninProvider;
}

export async function getDynwRonPairAddress(provider: JsonRpcProvider) {
  if (KATANA_PAIR_ADDRESS) return KATANA_PAIR_ADDRESS;
  if (!KATANA_FACTORY_ADDRESS || !WRON_TOKEN.address) return "";
  const factory = new Contract(KATANA_FACTORY_ADDRESS, FACTORY_ABI, provider);
  const pair = await factory.getPair(DYNW_TOKEN.address, WRON_TOKEN.address);
  return pair || "";
}

export async function getDynwRonReserves(provider: JsonRpcProvider) {
  const pairAddress = await getDynwRonPairAddress(provider);
  if (!pairAddress) {
    throw new Error("Missing Katana pair address. Set VITE_KATANA_PAIR_ADDRESS or factory + WRON address.");
  }
  const pair = new Contract(pairAddress, PAIR_ABI, provider);
  const [reserve0, reserve1] = await pair.getReserves();
  const token0 = (await pair.token0()) as string;
  const token1 = (await pair.token1()) as string;
  const token0Lower = token0.toLowerCase();
  const token1Lower = token1.toLowerCase();
  const ronLower = WRON_TOKEN.address.toLowerCase();
  const dynwLower = DYNW_TOKEN.address.toLowerCase();

  if (token0Lower === ronLower && token1Lower === dynwLower) {
    return { reserveRon: BigInt(reserve0), reserveDynw: BigInt(reserve1), pairAddress };
  }
  if (token0Lower === dynwLower && token1Lower === ronLower) {
    return { reserveRon: BigInt(reserve1), reserveDynw: BigInt(reserve0), pairAddress };
  }

  throw new Error("Katana pair tokens do not match WRON/DYNW addresses.");
}

export function quoteOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint) {
  if (amountIn <= 0n) return 0n;
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}
