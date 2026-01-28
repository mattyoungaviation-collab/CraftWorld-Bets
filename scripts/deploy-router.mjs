import fs from "fs";
import path from "path";
import process from "process";
import solc from "solc";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";

const {
  RONIN_RPC,
  DEPLOYER_PRIVATE_KEY,
  FEE_RECIPIENT,
  ESCROW_RECIPIENT,
  FEE_BPS,
} = process.env;

const required = {
  RONIN_RPC,
  DEPLOYER_PRIVATE_KEY,
  FEE_RECIPIENT,
  ESCROW_RECIPIENT,
  FEE_BPS,
};

const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length > 0) {
  throw new Error(`Missing required env vars: ${missing.join(", ")}`);
}

const contractPath = path.resolve("contracts", "BetPaymentRouter.sol");
const source = fs.readFileSync(contractPath, "utf8");
const input = {
  language: "Solidity",
  sources: {
    "BetPaymentRouter.sol": {
      content: source,
    },
  },
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = Array.isArray(output.errors) ? output.errors : [];
const fatalErrors = errors.filter((entry) => entry.severity === "error");

if (fatalErrors.length > 0) {
  const messages = fatalErrors.map((entry) => entry.formattedMessage).join("\n");
  throw new Error(messages);
}

const contractOutput = output.contracts?.["BetPaymentRouter.sol"]?.BetPaymentRouter;
if (!contractOutput?.abi || !contractOutput?.evm?.bytecode?.object) {
  throw new Error("Failed to compile BetPaymentRouter.sol");
}

const provider = new JsonRpcProvider(RONIN_RPC);
const wallet = new Wallet(DEPLOYER_PRIVATE_KEY, provider);
const feeBps = Number(FEE_BPS);

if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 10_000) {
  throw new Error("FEE_BPS must be a number between 0 and 10000");
}

const factory = new ContractFactory(contractOutput.abi, contractOutput.evm.bytecode.object, wallet);
const contract = await factory.deploy(FEE_RECIPIENT, ESCROW_RECIPIENT, feeBps);

await contract.waitForDeployment();

const address = await contract.getAddress();
const outputPayload = {
  address,
  feeRecipient: FEE_RECIPIENT,
  escrowRecipient: ESCROW_RECIPIENT,
  feeBps,
  deployedAt: new Date().toISOString(),
  network: RONIN_RPC,
};

fs.writeFileSync("router-deployment.json", `${JSON.stringify(outputPayload, null, 2)}\n`);

console.log(`BetPaymentRouter deployed to ${address}`);
console.log("Saved deployment metadata to router-deployment.json");
