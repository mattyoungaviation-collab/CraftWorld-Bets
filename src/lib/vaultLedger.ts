import { BrowserProvider, Contract, id } from "ethers";
import { DYNW_TOKEN } from "./tokens";

export const VAULT_LEDGER_ADDRESS = (import.meta.env.VITE_VAULT_LEDGER_ADDRESS as string | undefined) || "";

export const VAULT_LEDGER_ABI = [
  "function depositDYNW(uint256 amount)",
  "function withdrawDYNW(uint256 amount)",
  "function placeBet(bytes32 betId, address token, uint256 amount)",
  "function balances(address owner, address token) view returns (uint256)",
  "function lockedBalances(address owner, address token) view returns (uint256)",
];

export function buildBetId(masterpieceId: number, position: number) {
  return id(`cw-bet:${masterpieceId}:${position}`);
}

export function buildBlackjackBetId(roundId: number, seatId: number, walletAddress: string) {
  return id(`cw-blackjack:${roundId}:${seatId}:${walletAddress.toLowerCase()}`);
}

export async function getVaultContract(provider: any) {
  if (!provider || !VAULT_LEDGER_ADDRESS) return null;
  const browserProvider = new BrowserProvider(provider);
  const signer = await browserProvider.getSigner();
  const contract = new Contract(VAULT_LEDGER_ADDRESS, VAULT_LEDGER_ABI, signer);
  return { contract, signer };
}

export function vaultTokenAddress() {
  return DYNW_TOKEN.address;
}
