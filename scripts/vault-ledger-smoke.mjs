import { Contract, JsonRpcProvider, Wallet, formatUnits, parseUnits } from "ethers";

const VAULT_ABI = [
  "function depositDYNW(uint256 amount)",
  "function withdrawDYNW(uint256 amount)",
  "function placeBet(bytes32 betId, address token, uint256 amount)",
  "function settleBet(bytes32 betId, address token, uint256 netAmount, uint8 outcome, address[] participants)",
  "function balances(address owner, address token) view returns (uint256)",
  "function lockedBalances(address owner, address token) view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main() {
  const rpcUrl = requireEnv("RONIN_RPC");
  const vaultAddress = requireEnv("VAULT_LEDGER_ADDRESS");
  const dynwTokenAddress = requireEnv("DYNW_TOKEN_ADDRESS");
  const operatorKey = requireEnv("OPERATOR_PRIVATE_KEY");
  const userKey = requireEnv("TEST_USER_PRIVATE_KEY");
  const shouldMint = process.env.DYNW_MINTABLE === "true";

  const provider = new JsonRpcProvider(rpcUrl);
  const operator = new Wallet(operatorKey, provider);
  const user = new Wallet(userKey, provider);

  const vault = new Contract(vaultAddress, VAULT_ABI, operator);
  const userVault = vault.connect(user);
  const token = new Contract(dynwTokenAddress, ERC20_ABI, user);

  const betId = `0x${Buffer.from(`smoke-${Date.now()}`).toString("hex").padEnd(64, "0")}`;
  const depositAmount = parseUnits("10", 18);
  const wagerAmount = parseUnits("5", 18);

  if (shouldMint) {
    const mintTx = await token.mint(user.address, depositAmount);
    await mintTx.wait();
  }

  const approveTx = await token.approve(vaultAddress, depositAmount);
  await approveTx.wait();

  const depositTx = await userVault.depositDYNW(depositAmount);
  await depositTx.wait();

  const placeTx = await userVault.placeBet(betId, dynwTokenAddress, wagerAmount);
  await placeTx.wait();

  const settleTx = await vault.settleBet(betId, dynwTokenAddress, parseUnits("2", 18), 1, [user.address]);
  await settleTx.wait();

  const withdrawTx = await userVault.withdrawDYNW(parseUnits("2", 18));
  await withdrawTx.wait();

  const available = await vault.balances(user.address, dynwTokenAddress);
  const locked = await vault.lockedBalances(user.address, dynwTokenAddress);
  const walletBalance = await token.balanceOf(user.address);

  console.log("Vault available:", formatUnits(available, 18));
  console.log("Vault locked:", formatUnits(locked, 18));
  console.log("Wallet balance:", formatUnits(walletBalance, 18));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
