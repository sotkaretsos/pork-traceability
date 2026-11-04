require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
const path = require("path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Use the solcjs build shipped in node_modules/solc (no download from binaries.soliditylang.org).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    const solcPath = path.join(__dirname, "node_modules", "solc", "soljson.js");
    return { compilerPath: solcPath, isSolcJs: true, version: args.solcVersion, longVersion: "0.8.24+commit.e11b9ed9" };
  }
  return runSuper();
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "london", // Besu-compatible, no PUSH0/MCOPY requirement
    },
  },
  networks: {
    hardhat: { allowUnlimitedContractSize: false },
    // Private Hyperledger Besu network (QBFT, zero gas price) — see README.
    besu: {
      url: process.env.BESU_RPC_URL || "http://127.0.0.1:8545",
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
      gasPrice: 0,
    },
  },
};
