// Usage: BESU_RPC_URL=http://<node>:8545 DEPLOYER_KEY=0x... npx hardhat run scripts/deploy.js --network besu
// Optional: OWNER_ADDRESS, CHILLED_LIMIT (40), FROZEN_LIMIT (-180), MIN_COOKING_TEMP (750), TOLERANCE_MINUTES (15)
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const env = process.env;
  const args = [
    env.OWNER_ADDRESS || deployer.address,
    Number(env.CHILLED_LIMIT ?? 40),
    Number(env.FROZEN_LIMIT ?? -180),
    Number(env.MIN_COOKING_TEMP ?? 750),
    Number(env.TOLERANCE_MINUTES ?? 15),
  ];
  const c = await (await ethers.getContractFactory("PorkTrace")).deploy(...args);
  await c.waitForDeployment();
  console.log("PorkTrace deployed at", await c.getAddress(), "with", args);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
