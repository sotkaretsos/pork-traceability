// Usage: BESU_RPC_URL=http://<node>:8545 DEPLOYER_KEY=0x... npx hardhat run scripts/deploy.js --network besu
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const admin = process.env.ADMIN_ADDRESS || deployer.address;
  const c = await (await ethers.getContractFactory("PorkTraceability")).deploy(admin);
  await c.waitForDeployment();
  console.log("PorkTraceability deployed at", await c.getAddress(), "admin", admin);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
