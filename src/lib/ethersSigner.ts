import { BrowserProvider } from "ethers";

export async function getEthersSigner(eip1193Provider: any) {
  if (!eip1193Provider) {
    throw new Error("Wallet provider is missing.");
  }
  const browserProvider = new BrowserProvider(eip1193Provider);
  const signer = await browserProvider.getSigner();
  const address = await signer.getAddress();
  return { browserProvider, signer, address };
}
