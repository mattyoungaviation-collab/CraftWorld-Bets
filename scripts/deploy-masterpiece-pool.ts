import fs from "fs";
import { ethers } from "hardhat";

async function main() {
  const dynwToken = process.env.DYNW_TOKEN_ADDRESS;
  const treasury = process.env.TREASURY_ADDRESS;
  const operator = process.env.OPERATOR_ADDRESS;

  if (!dynwToken || !treasury || !operator) {
    throw new Error("Missing DYNW_TOKEN_ADDRESS, TREASURY_ADDRESS, or OPERATOR_ADDRESS");
  }

  const factory = await ethers.getContractFactory("MasterpiecePool");
  const contract = await factory.deploy(dynwToken, treasury, operator);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  const payload = {
    address,
    dynwToken,
    treasury,
    operator,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync("masterpiece-pool-deployment.json", JSON.stringify(payload, null, 2));
  console.log("MasterpiecePool deployed:", address);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
