// scripts/demo-end-to-end.js
//
// One-shot end-to-end demo: deploy contracts, run the seller agent to choose
// a bid out of a small bid book, fund the vault as buyer, reveal codes, and
// confirm delivery via the mailbox key. Designed for the in-process Hardhat
// network so a TA can run a single command and see the whole flow.
//
//   $ npx hardhat run scripts/demo-end-to-end.js
//
// (or against a running localhost node with `--network localhost`)

const { ethers } = require("hardhat");
const { SellerAgent } = require("../agents/seller_agent_core.js");

const ETH = ethers.parseEther;
const DAY = 24 * 60 * 60;

async function main() {
  const [
    deployer, operator, seller, buyer, mailbox,
    courier1, courier2, courier3, agent
  ] = await ethers.getSigners();

  console.log("=== Deploying ===");
  const Pool = await ethers.getContractFactory("StakingPool");
  const pool = await Pool.deploy(operator.address, DAY, 20000);
  await pool.waitForDeployment();

  const Reg = await ethers.getContractFactory("MarketplaceRegistry");
  const registry = await Reg.deploy();
  await registry.waitForDeployment();

  await (await pool.connect(operator).setFactory(await registry.getAddress())).wait();
  console.log("Pool: ", await pool.getAddress());
  console.log("Reg:  ", await registry.getAddress());

  console.log("\n=== Admit couriers and stake ===");
  for (const c of [courier1, courier2, courier3]) {
    await (await pool.connect(operator).admitMember(c.address)).wait();
    await (await pool.connect(c).depositStake({ value: ETH("3") })).wait();
  }
  console.log("Three couriers admitted with 3 ETH stake each.");

  console.log("\n=== Seller policy (agent session key) ===");
  // Agent can accept up to 0.2 ETH price, must promise >= 12h before user's deadline,
  // co-sign required above 2 ETH declared value.
  await (await registry.connect(seller).setAgentPolicy(
    agent.address, ETH("0.2"), 12 * 3600, ETH("2")
  )).wait();

  console.log("\n=== Seller opens delivery request ===");
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const declaredValue = ETH("1");
  const maxPrice      = ETH("0.15");
  const bidDeadline   = now + 2 * 3600;       // 2 h bidding window
  const maxDeadline   = now + 2 * DAY;        // buyer needs it within 2 days
  const disputeWindow = 30 * 60;              // 30 minutes

  const openTx = await registry.connect(seller).openRequest(
    declaredValue, maxPrice, maxDeadline, bidDeadline,
    buyer.address, mailbox.address, await pool.getAddress(),
    true,  // preferTrusted
    disputeWindow,
    7777   // user salt
  );
  const openRcpt = await openTx.wait();
  const openEvt = openRcpt.logs
    .map(l => { try { return registry.interface.parseLog(l); } catch { return null; } })
    .find(e => e && e.name === "RequestOpened");
  const deliveryId = openEvt.args.deliveryId;
  console.log("Delivery ID:", deliveryId);

  // Buyer and seller agree off-chain on codes; seller hashes and posts.
  const pickupCode  = ethers.toUtf8Bytes("PICKUP-" + Math.random().toString(36).slice(2));
  const dropoffCode = ethers.toUtf8Bytes("DROP-"   + Math.random().toString(36).slice(2));
  const nonceP = ethers.id("nonce-pickup");
  const nonceD = ethers.id("nonce-dropoff");
  const pickupHash  = ethers.keccak256(ethers.concat([pickupCode,  deliveryId, nonceP]));
  const dropoffHash = ethers.keccak256(ethers.concat([dropoffCode, deliveryId, nonceD]));
  await (await registry.connect(seller).publishHashes(deliveryId, pickupHash, dropoffHash)).wait();
  console.log("Hashes locked on-chain.");

  console.log("\n=== Couriers bid ===");
  // courier1: fast and cheap, low rep
  await (await registry.connect(courier1).placeBid(
    deliveryId, courier1.address, ETH("0.08"), now + 6 * 3600, 6000)).wait();
  // courier2: medium price, medium rep
  await (await registry.connect(courier2).placeBid(
    deliveryId, courier2.address, ETH("0.10"), now + 12 * 3600, 8500)).wait();
  // courier3: expensive, fast, top rep
  await (await registry.connect(courier3).placeBid(
    deliveryId, courier3.address, ETH("0.14"), now + 8 * 3600, 9500)).wait();

  const bids = await registry.getBids(deliveryId);
  console.log(`Got ${bids.length} bids.`);
  bids.forEach((b, i) => {
    console.log(`  [${i}] courier=${b.courier.slice(0,8)}…  price=${ethers.formatEther(b.price)} ETH  rep=${Number(b.reputationE4)/100}%`);
  });

  console.log("\n=== Seller Agent ranks bids ===");
  const sa = new SellerAgent({
    preferTrusted: true,
    maxPrice,
    maxDeadline,
    declaredValue
  });
  const decision = sa.rank(bids);
  console.log("Agent decision:");
  console.log("  Winner index :", decision.winnerIndex);
  console.log("  Score breakdown:");
  decision.scored.forEach(s => {
    console.log(`    [${s.index}] score=${s.score.toFixed(4)}   reason=${s.reason}`);
  });

  console.log("\n=== Agent (session key) accepts ===");
  const acceptTx = await registry.connect(agent).acceptBidByAgent(deliveryId, decision.winnerIndex);
  const acceptRcpt = await acceptTx.wait();
  const acceptedEvt = acceptRcpt.logs
    .map(l => { try { return registry.interface.parseLog(l); } catch { return null; } })
    .find(e => e && e.name === "BidAccepted");
  const vaultAddr = acceptedEvt.args.vault;
  console.log("Vault deployed:", vaultAddr);

  const Vault = await ethers.getContractFactory("DeliveryVault");
  const vault = Vault.attach(vaultAddr);

  console.log("\n=== Buyer funds the vault ===");
  const winningBid = bids[decision.winnerIndex];
  await (await vault.connect(buyer).fund({ value: winningBid.price })).wait();
  console.log(`Funded ${ethers.formatEther(winningBid.price)} ETH.`);

  console.log("\n=== Courier picks up (reveals pickup code) ===");
  const winningCourier = decision.winnerIndex === 0 ? courier1
                       : decision.winnerIndex === 1 ? courier2
                       : courier3;
  await (await vault.connect(winningCourier).pickup(pickupCode, nonceP)).wait();
  const snap1 = await vault.snapshot();
  console.log("State:", ["Funded","PickedUp","Delivered","Refunded","Failed"][snap1.s]);

  console.log("\n=== Mailbox confirms dropoff ===");
  await (await vault.connect(mailbox).confirmDelivery(dropoffCode, nonceD)).wait();
  const snap2 = await vault.snapshot();
  console.log("State:", ["Funded","PickedUp","Delivered","Refunded","Failed"][snap2.s]);
  console.log("Finalized:", snap2.isFinalized);

  if (!snap2.isFinalized) {
    console.log("\n=== Dispute window open; advancing time and finalizing ===");
    await ethers.provider.send("evm_increaseTime", [disputeWindow + 60]);
    await ethers.provider.send("evm_mine", []);
    await (await vault.finalizeDelivered()).wait();
    const snap3 = await vault.snapshot();
    console.log("Finalized:", snap3.isFinalized);
  }

  console.log("\n=== Final pool state ===");
  console.log("totalStake :", ethers.formatEther(await pool.totalStake()), "ETH");
  console.log("activeValue:", ethers.formatEther(await pool.activeValue()), "ETH");
  console.log("\nDemo complete ✓");
}

main().catch(e => { console.error(e); process.exit(1); });
