#!/usr/bin/env node
// clients/courier/courier_cli.js
//
// Courier client. Lets a courier:
//   - join a pool and stake
//   - watch open requests and place bids
//   - reveal pickup code to a vault once assigned
//
// Codes obtained off-chain are passed in by hex.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const DEPLOYMENT   = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../deployment.json"), "utf8"));
const REGISTRY_ABI = require(path.resolve(__dirname, "../../artifacts/contracts/MarketplaceRegistry.sol/MarketplaceRegistry.json")).abi;
const POOL_ABI     = require(path.resolve(__dirname, "../../artifacts/contracts/StakingPool.sol/StakingPool.json")).abi;
const VAULT_ABI    = require(path.resolve(__dirname, "../../artifacts/contracts/DeliveryVault.sol/DeliveryVault.json")).abi;

function usage() {
  console.log(`
courier-cli — Decentralized Logistics Marketplace

Environment:
  RPC_URL     (default http://127.0.0.1:8545)
  COURIER_KEY (private key OR "idx:N")

Subcommands:
  stake <eth>                                    -- deposit stake into the pool
  capacity                                       -- show your free capacity
  bid <id> <priceEth> <promisedTimeSecFromNow> <repBps> [payoutAddr]
  withdraw-bid <id> <bidIndex>
  pickup <vaultAddr> <pickupCodeHex> <noncePHex>
  withdraw-request <eth>                         -- start stake withdrawal
  withdraw-finalize                              -- claim stake after delay
`);
}

async function getSigner() {
  const url = process.env.RPC_URL || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(url);
  const keyEnv = process.env.COURIER_KEY || "idx:5";
  if (keyEnv.startsWith("idx:")) {
    const idx = Number(keyEnv.slice(4));
    const mnemonic = "test test test test test test test test test test test junk";
    return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${idx}`).connect(provider);
  }
  return new ethers.Wallet(keyEnv, provider);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") return usage();

  const signer   = await getSigner();
  const registry = new ethers.Contract(DEPLOYMENT.contracts.MarketplaceRegistry, REGISTRY_ABI, signer);
  const pool     = new ethers.Contract(DEPLOYMENT.contracts.StakingPool,         POOL_ABI,     signer);

  switch (cmd) {
    case "stake": {
      const [eth] = rest;
      const tx = await pool.depositStake({ value: ethers.parseEther(eth) });
      await tx.wait();
      console.log(`Staked ${eth} ETH.`);
      break;
    }

    case "capacity": {
      const free = await pool.freeCapacityFor(signer.address);
      console.log("Free capacity:", ethers.formatEther(free), "ETH");
      break;
    }

    case "bid": {
      const [id, priceEth, promisedSec, repBps, payout] = rest;
      const now = Math.floor(Date.now() / 1000);
      const tx = await registry.placeBid(
        id,
        payout || signer.address,
        ethers.parseEther(priceEth),
        now + Number(promisedSec),
        Number(repBps)
      );
      const rcpt = await tx.wait();
      const evt = rcpt.logs.map(l => { try { return registry.interface.parseLog(l); } catch { return null; } })
                           .find(e => e && e.name === "BidPlaced");
      console.log("Bid placed at index", Number(evt.args.index));
      break;
    }

    case "withdraw-bid": {
      const [id, idx] = rest;
      await (await registry.withdrawBid(id, Number(idx))).wait();
      console.log("Bid withdrawn.");
      break;
    }

    case "pickup": {
      const [vaultAddr, codeHex, nonceP] = rest;
      const vault = new ethers.Contract(vaultAddr, VAULT_ABI, signer);
      const tx = await vault.pickup(codeHex, nonceP);
      await tx.wait();
      console.log("Pickup recorded.");
      break;
    }

    case "withdraw-request": {
      const [eth] = rest;
      await (await pool.requestWithdraw(ethers.parseEther(eth))).wait();
      console.log("Withdrawal requested. Wait", await pool.withdrawalDelay(), "seconds, then run withdraw-finalize.");
      break;
    }

    case "withdraw-finalize": {
      await (await pool.finalizeWithdraw()).wait();
      console.log("Withdrawal finalized.");
      break;
    }

    default:
      usage();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
