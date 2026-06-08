require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
const path = require("path");

const LOCAL_SOLJSON = path.resolve(__dirname, "node_modules/solc/soljson.js");

// Use locally-bundled solc-js instead of downloading from binaries.soliditylang.org
// (the egress proxy in this environment denies that host).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, _hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    return {
      compilerPath: LOCAL_SOLJSON,
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: "0.8.24+commit.e11b9ed9.Emscripten.clang"
    };
  }
  return runSuper(args);
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true
    }
  },
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    ...(process.env.SEPOLIA_RPC_URL && {
      sepolia: {
        url: process.env.SEPOLIA_RPC_URL,
        chainId: 11155111,
        accounts: [
          process.env.DEPLOYER_KEY,
          ...(process.env.OPERATOR_KEY ? [process.env.OPERATOR_KEY] : [])
        ].filter(k => k && /^(0x)?[0-9a-fA-F]{64}$/.test(k.trim()))
      }
    })
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    artifacts: "./artifacts",
    cache: "./cache"
  }
};
