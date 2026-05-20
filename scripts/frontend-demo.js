// scripts/frontend-demo.js
// Seeds the deployed localhost contracts with one visible end-to-end delivery.

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { SellerAgent } = require("../agents/seller_agent_core.js");

const ETH = ethers.parseEther;

async function parseEvent(contract, receipt, name) {
  return receipt.logs
    .map((log) => {
      try { return contract.interface.parseLog(log); } catch { return null; }
    })
    .find((event) => event && event.name === name);
}

async function main() {
  const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployment.json"), "utf8"));
  const [deployer, operator, seller, buyer, mailbox, courier1, courier2, courier3, agent] = await ethers.getSigners();

  const Pool = await ethers.getContractFactory("StakingPool");
  const Registry = await ethers.getContractFactory("MarketplaceRegistry");
  const pool = Pool.attach(deployment.contracts.StakingPool);
  const registry = Registry.attach(deployment.contracts.MarketplaceRegistry);

  console.log("Using registry:", await registry.getAddress());
  console.log("Using pool:    ", await pool.getAddress());

  console.log("\nAdmitting couriers and staking...");
  for (const courier of [courier1, courier2, courier3]) {
    try {
      await (await pool.connect(operator).admitMember(courier.address)).wait();
      console.log("Admitted", courier.address);
    } catch (error) {
      if (!String(error.message).includes("already member")) throw error;
      console.log("Already admitted", courier.address);
    }
    const member = await pool.members(courier.address);
    if (member.contribution < ETH("3")) {
      await (await pool.connect(courier).depositStake({ value: ETH("3") })).wait();
      console.log("Staked 3 ETH for", courier.address);
    }
  }

  console.log("\nOpening seller request...");
  await (await registry.connect(seller).setAgentPolicy(agent.address, ETH("0.2"), 3600, ETH("2"))).wait();
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const openReceipt = await (await registry.connect(seller).openRequest(
    ETH("1"),
    ETH("0.2"),
    now + 24 * 3600,
    now + 3600,
    buyer.address,
    mailbox.address,
    await pool.getAddress(),
    true,
    60,
    Date.now()
  )).wait();
  const openEvent = await parseEvent(registry, openReceipt, "RequestOpened");
  const deliveryId = openEvent.args.deliveryId;
  console.log("Delivery ID:", deliveryId);

  const pickupCode = ethers.toUtf8Bytes("PICKUP-DEMO-2026");
  const dropoffCode = ethers.toUtf8Bytes("DROPOFF-DEMO-2026");
  const nonceP = ethers.id("frontend-demo-pickup");
  const nonceD = ethers.id("frontend-demo-dropoff");
  const pickupHash = ethers.keccak256(ethers.concat([pickupCode, deliveryId, nonceP]));
  const dropoffHash = ethers.keccak256(ethers.concat([dropoffCode, deliveryId, nonceD]));
  await (await registry.connect(seller).publishHashes(deliveryId, pickupHash, dropoffHash)).wait();
  console.log("Hashes published.");

  console.log("\nPlacing courier bids...");
  await (await registry.connect(courier1).placeBid(deliveryId, courier1.address, ETH("0.12"), now + 6 * 3600, 7000)).wait();
  await (await registry.connect(courier2).placeBid(deliveryId, courier2.address, ETH("0.15"), now + 4 * 3600, 9400)).wait();
  await (await registry.connect(courier3).placeBid(deliveryId, courier3.address, ETH("0.18"), now + 5 * 3600, 9900)).wait();

  const bids = await registry.getBids(deliveryId);
  const decision = new SellerAgent({
    preferTrusted: true,
    maxPrice: ETH("0.2"),
    maxDeadline: BigInt(now + 24 * 3600),
    declaredValue: ETH("1")
  }).rank(bids);
  console.log("Agent winner index:", decision.winnerIndex);

  const acceptReceipt = await (await registry.connect(agent).acceptBidByAgent(deliveryId, decision.winnerIndex)).wait();
  const acceptedEvent = await parseEvent(registry, acceptReceipt, "BidAccepted");
  const vaultAddr = acceptedEvent.args.vault;
  console.log("Vault:", vaultAddr);

  const Vault = await ethers.getContractFactory("DeliveryVault");
  const vault = Vault.attach(vaultAddr);
  const winningBid = bids[decision.winnerIndex];

  console.log("\nFunding and recording pickup...");
  await (await vault.connect(buyer).fund({ value: winningBid.price })).wait();
  const winningCourier = [courier1, courier2, courier3][decision.winnerIndex];
  await (await vault.connect(winningCourier).pickup(pickupCode, nonceP)).wait();

  const out = {
    registry: await registry.getAddress(),
    pool: await pool.getAddress(),
    deliveryId,
    vault: vaultAddr,
    seller: seller.address,
    buyer: buyer.address,
    mailbox: mailbox.address,
    courier: winningCourier.address,
    winningBidIndex: decision.winnerIndex,
    fundedEth: ethers.formatEther(winningBid.price),
    pickupCode: ethers.hexlify(pickupCode),
    pickupNonce: nonceP,
    dropoffCode: ethers.hexlify(dropoffCode),
    dropoffNonce: nonceD,
    nextStep: "Open the frontend, press Connect, then use Buyer > Mailbox Dropoff > Confirm Delivery."
  };

  fs.writeFileSync(path.join(__dirname, "..", "frontend-demo.json"), JSON.stringify(out, null, 2));
  console.log("\nWrote frontend-demo.json");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
