import { Contract } from "ethers";

export const MASTERPIECE_POOL_ADDRESS =
  (import.meta.env.VITE_MASTERPIECE_POOL_ADDRESS as string | undefined) || "";

export const MASTERPIECE_POOL_ABI = [
  "function placeBet(bytes32 betId, uint8 position, uint256 amount)",
  "function getPool(bytes32 betId) view returns (uint256)",
];

export async function getMasterpiecePoolContract(provider: any) {
  if (!provider || !MASTERPIECE_POOL_ADDRESS) return null;
  const browserProvider = await provider.provider;
  const signer = await browserProvider.getSigner();
  return {
    contract: new Contract(MASTERPIECE_POOL_ADDRESS, MASTERPIECE_POOL_ABI, signer),
    address: MASTERPIECE_POOL_ADDRESS,
  };
}
