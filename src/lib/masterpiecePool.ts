import { Contract } from "ethers";
import { getEthersSigner } from "./ethersSigner";

export const MASTERPIECE_POOL_ADDRESS =
  (import.meta.env.VITE_MASTERPIECE_POOL_ADDRESS as string | undefined) || "";

export const MASTERPIECE_POOL_ABI = [
  "function placeBet(bytes32 betId, uint8 position, uint256 amount)",
  "function getPool(bytes32 betId) view returns (uint256)",
];

export async function getMasterpiecePoolContract(provider: any) {
  if (!provider || !MASTERPIECE_POOL_ADDRESS) return null;
  const { signer } = await getEthersSigner(provider);
  return {
    contract: new Contract(MASTERPIECE_POOL_ADDRESS, MASTERPIECE_POOL_ABI, signer),
    address: MASTERPIECE_POOL_ADDRESS,
  };
}
