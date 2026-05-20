#!/usr/bin/env node
// clients/seller/seller_cli.js
//
// Minimal seller client. Loads addresses from deployment.json and talks to
// MarketplaceRegistry through ethers v6. Implements the architecture-doc
// seller-interface fields:
//
//   - delivery and pickup addresses (off-chain metadata, stored as the salt)
//   - budget for the delivery (maxPrice)
//   - desired maximum time of arrival (maxDeadline)
//   - prefer-trusted-couriers binary preference (preferTrusted)
//
// Subcommands:
//   open                 -> open a new delivery request
//   publish-hashes <id>  -> lock pickup/dropoff hashes
//   bids <id>            -> list bids for a request
//   accept <id> <idx>    -> accept bid as seller (direct)
//   set-agent <agent>    -> configure agent session-key policy
//   request <id>         -> show request status
//
// Codes are stored to a local file ./codes.<id>.json so the seller and buyer
// can later replay them off-chain to courier and mailbox. In production this
// would be replaced by an encrypted DM channel.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const DEPLOYMENT = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../deployment.json"), "utf8"));
const REGISTRY_ABI = require(path.resolve(__dirname, "../../artifacts/contracts/MarketplaceRegistry.sol/MarketplaceRegistry.json")).abi;
const POOL_ABI     = require(path.resolve(__dirname, "../../artifacts/contracts/StakingPool.sol/StakingPool.json")).abi;

function usage() {
  console.log(`
seller-cli — Decentralized Logistics Marketplace

Environment:
  RPC_URL       (default http://127.0.0.1:8545)
  SELLER_KEY    (hex private key OR Hardhat default account index, e.g. "idx:2")

Subcommands:
  open <declaredValueEth> <maxPriceEth> <maxDeadlineSecFromNow> <bidDeadlineSecFromNow> \\
       <buyerAddr> <mailboxAddr> <preferTrusted:true|false> <disputeWindowSec> [salt]
  publish-hashes <deliveryId>      -- generates pickup/dropoff codes and posts hashes
  bids <deliveryId>
  accept <deliveryId> <bidIndex>
  set-agent <agentAddr> <maxPriceEth> <minDeadlineBufferSec> <coSignThresholdEth>
  request <deliveryId>
`);
}

async function getSigner() {
  const url = process.env.RPC_URL || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(url);
  const keyEnv = process.env.SELLER_KEY || "idx:2"; // hardhat[2] = seller in demo
  if (keyEnv.startsWith("idx:")) {
    // Hardhat-style default mnemonic accounts; useful for testing only.
    const idx = Number(keyEnv.slice(4));
    const mnemonic = "test test test test test test test test test test test junk";
    const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${idx}`).connect(provider);
    return wallet;
  }
  return new ethers.Wallet(keyEnv, provider);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") return usage();

  const signer = await getSigner();
  const registry = new ethers.Contract(DEPLOYMENT.contracts.MarketplaceRegistry, REGISTRY_ABI, signer);

  switch (cmd) {
    case "open": {
      const [declared, mp, maxDl, bidDl, buyer, mailbox, pref, dw, salt = "1"] = rest;
      const now = Math.floor(Date.now() / 1000);
      const tx = await registry.openRequest(
        ethers.parseEther(declared),
        ethers.parseEther(mp),
        now + Number(maxDl),
        now + Number(bidDl),
        buyer, mailbox,
        DEPLOYMENT.contracts.StakingPool,
        pref === "true",
        Number(dw),
        Number(salt)
      );
      const rcpt = await tx.wait();
      const evt = rcpt.logs.map(l => { try { return registry.interface.parseLog(l); } catch { return null; } })
                           .find(e => e && e.name === "RequestOpened");
      console.log("Opened request:", evt.args.deliveryId);
      console.log("Tx hash:", rcpt.hash);
      break;
    }

    case "publish-hashes": {
      const [id] = rest;
      const pickupCode  = ethers.toUtf8Bytes("PICKUP-"  + ethers.hexlify(ethers.randomBytes(8)));
      const dropoffCode = ethers.toUtf8Bytes("DROPOFF-" + ethers.hexlify(ethers.randomBytes(8)));
      const nonceP = ethers.id("p-" + Date.now());
      const nonceD = ethers.id("d-" + Date.now());
      const pickupHash  = ethers.keccak256(ethers.concat([pickupCode,  id, nonceP]));
      const dropoffHash = ethers.keccak256(ethers.concat([dropoffCode, id, nonceD]));

      // Persist codes for the off-chain handoff to buyer and courier.
      const codesPath = path.resolve(__dirname, `codes.${id}.json`);
      fs.writeFileSync(codesPath, JSON.stringify({
        deliveryId: id,
        pickupCode: ethers.hexlify(pickupCode),
        dropoffCode: ethers.hexlify(dropoffCode),
        nonceP, nonceD,
        pickupHash, dropoffHash
      }, null, 2));

      const tx = await registry.publishHashes(id, pickupHash, dropoffHash);
      await tx.wait();
      console.log("Hashes locked on-chain.");
      console.log("Codes written to", codesPath, "— share securely with buyer + courier.");
      break;
    }

    case "bids": {
      const [id] = rest;
      const bids = await registry.getBids(id);
      bids.forEach((b, i) => {
        console.log(`[${i}] courier=${b.courier}  payout=${b.payout}  price=${ethers.formatEther(b.price)} ETH` +
                    `  promisedAt=${new Date(Number(b.promisedTime) * 1000).toISOString()}` +
                    `  rep=${Number(b.reputationE4)/100}%  withdrawn=${b.withdrawn}`);
      });
      break;
    }

    case "accept": {
      const [id, idx] = rest;
      const tx = await registry.acceptBid(id, Number(idx));
      const rcpt = await tx.wait();
      const evt = rcpt.logs.map(l => { try { return registry.interface.parseLog(l); } catch { return null; } })
                           .find(e => e && e.name === "BidAccepted");
      console.log("Accepted bid", evt.args.index, "—> vault deployed at", evt.args.vault);
      break;
    }

    case "set-agent": {
      const [agentAddr, maxPriceEth, minBuf, coSignEth] = rest;
      const tx = await registry.setAgentPolicy(
        agentAddr,
        ethers.parseEther(maxPriceEth),
        Number(minBuf),
        ethers.parseEther(coSignEth)
      );
      await tx.wait();
      console.log("Agent policy set.");
      break;
    }

    case "request": {
      const [id] = rest;
      const r = await registry.getRequest(id);
      console.log({
        seller: r.seller,
        declaredValue: ethers.formatEther(r.declaredValue) + " ETH",
        maxPrice: ethers.formatEther(r.maxPrice) + " ETH",
        maxDeadline: new Date(Number(r.maxDeadline) * 1000).toISOString(),
        bidDeadline: new Date(Number(r.bidDeadline) * 1000).toISOString(),
        buyer: r.buyer,
        mailbox: r.mailbox,
        pool: r.pool,
        preferTrusted: r.preferTrusted,
        stage: ["None","Open","Assigned","Held","Finalized","Cancelled"][Number(r.stage)],
        vault: r.vault
      });
      break;
    }

    default:
      usage();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
