// scripts/deploy.js
// Deploys StakingPool + MarketplaceRegistry to the running network and
// writes the addresses to ./deployment.json so the CLIs and agents can find them.

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const operator = signers[1] ?? deployer; // fall back to deployer if no OPERATOR_KEY
  console.log("Deployer:", deployer.address);
  console.log("Operator:", operator.address);

  const StakingPool = await ethers.getContractFactory("StakingPool");
  const pool = await StakingPool.deploy(
    operator.address,
    0,        // 1-day withdrawal delay
    20000       // 200 % per-member cap (i.e. carry up to 2x your own stake)
  );
  await pool.waitForDeployment();
  const poolAddr = await pool.getAddress();
  console.log("StakingPool deployed:", poolAddr);

  const MarketplaceRegistry = await ethers.getContractFactory("MarketplaceRegistry");
  const registry = await MarketplaceRegistry.deploy();
  await registry.waitForDeployment();
  const regAddr = await registry.getAddress();
  console.log("MarketplaceRegistry deployed:", regAddr);

  // Operator authorizes the registry as the pool's factory so it can spawn vaults.
  await (await pool.connect(operator).setFactory(regAddr)).wait();
  console.log("Pool factory set to registry.");

  // Write the deployment manifest.
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const out = {
    network: network.name || "localhost",
    chainId,
    contracts: {
      StakingPool: poolAddr,
      MarketplaceRegistry: regAddr
    },
    operator: operator.address,
    deployer: deployer.address,
    deployedAt: new Date().toISOString()
  };

  // Always write deployment.json (used by frontend for local dev).
  // For testnet also write a chain-specific file so local deployment isn't overwritten.
  fs.writeFileSync(path.join(__dirname, "..", "deployment.json"), JSON.stringify(out, null, 2));
  if (chainId !== 31337) {
    const sepoliaFile = path.join(__dirname, "..", `deployment.${chainId}.json`);
    fs.writeFileSync(sepoliaFile, JSON.stringify(out, null, 2));
    console.log(`Wrote deployment.${chainId}.json`);
  }
  console.log("Wrote deployment.json");
}

main().catch(e => { console.error(e); process.exit(1); });
