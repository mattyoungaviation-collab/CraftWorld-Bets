import fs from "fs";
import path from "path";
import solc from "solc";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";

const CONTRACT_FILE = "contracts/VaultLedger.sol";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function loadSource(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function findImports(importPath) {
  const localPath = path.resolve(importPath);
  const contractPath = path.resolve(process.cwd(), importPath);
  const nodePath = path.resolve("node_modules", importPath);
  const candidates = [contractPath, nodePath, localPath];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { contents: loadSource(candidate) };
    }
  }
  return { error: `File not found: ${importPath}` };
}

function compile() {
  const input = {
    language: "Solidity",
    sources: {
      [CONTRACT_FILE]: {
        content: loadSource(CONTRACT_FILE),
      },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode", "metadata"],
        },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  if (output.errors?.length) {
    const fatal = output.errors.find((e) => e.severity === "error");
    if (fatal) {
      throw new Error(output.errors.map((e) => e.formattedMessage).join("\n"));
    }
  }
  const contract = output.contracts[CONTRACT_FILE]?.VaultLedger;
  if (!contract) {
    throw new Error("VaultLedger compilation failed");
  }
  return contract;
}

async function main() {
  const rpcUrl = requireEnv("RONIN_RPC");
  const deployerKey = requireEnv("DEPLOYER_PRIVATE_KEY");
  const dynwToken = requireEnv("DYNW_TOKEN_ADDRESS");
  const treasury = requireEnv("TREASURY_ADDRESS");
  const operator = requireEnv("OPERATOR_ADDRESS");

  const contract = compile();
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(deployerKey, provider);

  const factory = new ContractFactory(contract.abi, contract.evm.bytecode.object, wallet);
  const deployed = await factory.deploy(dynwToken, treasury, operator);
  await deployed.waitForDeployment();

  const address = await deployed.getAddress();
  const deployment = {
    address,
    chainId: (await provider.getNetwork()).chainId.toString(),
    dynwToken,
    treasury,
    operator,
    compilerVersion: solc.version(),
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync("vault-ledger-deployment.json", JSON.stringify(deployment, null, 2));
  fs.writeFileSync("VaultLedger.metadata.json", contract.metadata);

  console.log("VaultLedger deployed:", deployment);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
