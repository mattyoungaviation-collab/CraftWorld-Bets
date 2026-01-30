import { Wallet } from "ethers";

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const privateKey = process.env.TEST_LOGIN_PRIVATE_KEY;

if (!privateKey) {
  console.error("Missing TEST_LOGIN_PRIVATE_KEY env var.");
  process.exit(1);
}

const wallet = new Wallet(privateKey);
const address = wallet.address.toLowerCase();

async function main() {
  const nonceRes = await fetch(`${baseUrl}/api/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const nonceJson = await nonceRes.json();
  if (!nonceRes.ok) {
    throw new Error(nonceJson?.error || "Failed to fetch nonce");
  }
  const message = `CraftWorld Bets sign-in\nAddress: ${address}\nNonce: ${nonceJson.nonce}`;
  const signature = await wallet.signMessage(message);

  const verifyRes = await fetch(`${baseUrl}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, message, signature }),
  });
  const verifyJson = await verifyRes.json();
  if (!verifyRes.ok) {
    throw new Error(verifyJson?.error || "Failed to verify signature");
  }

  const token = verifyJson.token;
  const authHeaders = { authorization: `Bearer ${token}` };

  const walletRes = await fetch(`${baseUrl}/api/game-wallet`, { headers: authHeaders });
  const walletJson = await walletRes.json();
  if (!walletRes.ok) {
    throw new Error(walletJson?.error || "Failed to load game wallet");
  }

  const balancesRes = await fetch(`${baseUrl}/api/game-wallet/balances`, { headers: authHeaders });
  const balancesJson = await balancesRes.json();
  if (!balancesRes.ok) {
    throw new Error(balancesJson?.error || "Failed to load balances");
  }

  console.log("Login address:", walletJson.loginAddress);
  console.log("Game wallet:", walletJson.gameWalletAddress);
  console.log("Balances:", balancesJson);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
