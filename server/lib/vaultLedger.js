import { Contract } from "ethers";

const VAULT_LEDGER_READ_ABI = [
  "function getAvailableBalance(address token, address owner) view returns (uint256)",
  "function getLockedBalance(address token, address owner) view returns (uint256)",

  // Fallback mapping getters (these are public in the Solidity contract)
  "function balances(address owner, address token) view returns (uint256)",
  "function lockedBalances(address owner, address token) view returns (uint256)",

  "function betStakes(bytes32 betId, address owner) view returns (uint256)",
];

export function getVaultReadContract(address, provider) {
  if (!address || !provider) return null;
  return new Contract(address, VAULT_LEDGER_READ_ABI, provider);
}

export async function safeGetLockedBalance(vaultReadContract, token, owner) {
  if (!vaultReadContract) throw new Error("Vault read contract not configured");
  try {
    const locked = await vaultReadContract.getLockedBalance(token, owner);
    return BigInt(locked);
  } catch {
    const locked = await vaultReadContract.lockedBalances(owner, token);
    return BigInt(locked);
  }
}

export async function safeGetAvailableBalance(vaultReadContract, token, owner) {
  if (!vaultReadContract) throw new Error("Vault read contract not configured");
  try {
    const available = await vaultReadContract.getAvailableBalance(token, owner);
    return BigInt(available);
  } catch {
    // Fallback: balances(owner, token) - lockedBalances(owner, token)
    const [balRaw, lockedRaw] = await Promise.all([
      vaultReadContract.balances(owner, token),
      vaultReadContract.lockedBalances(owner, token),
    ]);
    const bal = BigInt(balRaw);
    const locked = BigInt(lockedRaw);
    return bal > locked ? bal - locked : 0n;
  }
}
