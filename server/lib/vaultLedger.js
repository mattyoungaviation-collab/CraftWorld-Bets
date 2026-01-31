import { Contract, keccak256, toUtf8Bytes } from "ethers";

const VAULT_LEDGER_READ_ABI = [
  "function getAvailableBalance(address token, address owner) view returns (uint256)",
  "function getLockedBalance(address token, address owner) view returns (uint256)",
  "function balances(address owner, address token) view returns (uint256)",
  "function lockedBalances(address owner, address token) view returns (uint256)",
  "function betStakes(bytes32 betId, address owner) view returns (uint256)",
  "function treasury() view returns (address)",
];

export function getVaultReadContract(address, provider) {
  if (!address || !provider) return null;
  return new Contract(address, VAULT_LEDGER_READ_ABI, provider);
}

export function buildBlackjackSessionBetId(sessionId) {
  return keccak256(toUtf8Bytes(`cw-bj:${sessionId}`));
}

export async function safeGetLockedBalance(vaultReadContract, token, owner) {
  if (!vaultReadContract) throw new Error("Vault read contract not configured");
  try {
    const locked = await vaultReadContract.getLockedBalance(token, owner);
    return BigInt(locked);
  } catch (e) {
    const locked = await vaultReadContract.lockedBalances(owner, token);
    return BigInt(locked);
  }
}

export async function safeGetAvailableBalance(vaultReadContract, token, owner) {
  if (!vaultReadContract) throw new Error("Vault read contract not configured");
  try {
    const available = await vaultReadContract.getAvailableBalance(token, owner);
    return BigInt(available);
  } catch (e) {
    const [balRaw, lockedRaw] = await Promise.all([
      vaultReadContract.balances(owner, token),
      vaultReadContract.lockedBalances(owner, token),
    ]);
    const bal = BigInt(balRaw);
    const locked = BigInt(lockedRaw);
    return bal > locked ? bal - locked : 0n;
  }
}
