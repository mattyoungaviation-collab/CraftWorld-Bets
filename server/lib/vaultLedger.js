import { Contract, keccak256, toUtf8Bytes } from "ethers";

const VAULT_LEDGER_READ_ABI = [
  "function balances(address owner, address token) view returns (uint256)",
  "function lockedBalances(address owner, address token) view returns (uint256)",
  "function betStakes(bytes32 betId, address owner) view returns (uint256)",
];

export function getVaultReadContract(address, provider) {
  if (!address || !provider) return null;
  return new Contract(address, VAULT_LEDGER_READ_ABI, provider);
}

export function buildBlackjackSessionBetId(sessionId) {
  return keccak256(toUtf8Bytes(`cw-bj:${sessionId}`));
}
