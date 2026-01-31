import { Contract } from "ethers";

export const CRASH_VAULT_ADDRESS = (import.meta.env.VITE_CRASH_VAULT_ADDRESS as string | undefined) || "";

export const CRASH_VAULT_ABI = [
  "function placeBet(bytes32 roundId, uint256 amount)",
  "function getStake(bytes32 roundId, address user) view returns (uint256)",
];

export async function getCrashVaultContract(provider: any) {
  if (!provider || !CRASH_VAULT_ADDRESS) return null;
  const browserProvider = await provider.provider;
  const signer = await browserProvider.getSigner();
  return {
    contract: new Contract(CRASH_VAULT_ADDRESS, CRASH_VAULT_ABI, signer),
    address: CRASH_VAULT_ADDRESS,
  };
}
