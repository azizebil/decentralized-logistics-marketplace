// scripts/deploy.js
// Deploys StakingPool + MarketplaceRegistry to the running network and
// writes the addresses to ./deployment.json so the CLIs and agents can find them.

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;

async function main() {
  const [deployer, operator] = await ethers.getSigners();
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
  const out = {
    network: (await ethers.provider.getNetwork()).name || "localhost",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    contracts: {
      StakingPool: poolAddr,
      MarketplaceRegistry: regAddr
    },
    operator: operator.address,
    deployer: deployer.address,
    deployedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(__dirname, "..", "deployment.json"), JSON.stringify(out, null, 2));
  console.log("Wrote deployment.json");
}

main().catch(e => { console.error(e); process.exit(1); });
