#!/usr/bin/env node
// clients/buyer/buyer_cli.js
//
// Buyer client. The buyer's primary action is funding the vault. The mailbox
// is a separate program (agents/mailbox_agent.js) that holds a separate key.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const DEPLOYMENT = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../deployment.json"), "utf8"));
const REGISTRY_ABI = require(path.resolve(__dirname, "../../artifacts/contracts/MarketplaceRegistry.sol/MarketplaceRegistry.json")).abi;
const VAULT_ABI    = require(path.resolve(__dirname, "../../artifacts/contracts/DeliveryVault.sol/DeliveryVault.json")).abi;

function usage() {
  console.log(`
buyer-cli — Decentralized Logistics Marketplace

Environment:
  RPC_URL    (default http://127.0.0.1:8545)
  BUYER_KEY  (private key OR "idx:N")

Subcommands:
  fund <vaultAddr> <eth>
  status <vaultAddr>
  dispute <vaultAddr>
  cancel <vaultAddr>          -- cancel before pickup (full refund)
`);
}

async function getSigner() {
  const url = process.env.RPC_URL || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(url);
  const keyEnv = process.env.BUYER_KEY || "idx:3";
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

  const signer = await getSigner();

  switch (cmd) {
    case "fund": {
      const [vaultAddr, eth] = rest;
      const v = new ethers.Contract(vaultAddr, VAULT_ABI, signer);
      const tx = await v.fund({ value: ethers.parseEther(eth) });
      await tx.wait();
      console.log(`Funded ${eth} ETH to ${vaultAddr}`);
      break;
    }

    case "status": {
      const [vaultAddr] = rest;
      const v = new ethers.Contract(vaultAddr, VAULT_ABI, signer);
      const snap = await v.snapshot();
      console.log({
        state: ["Funded","PickedUp","Delivered","Refunded","Failed"][Number(snap.s)],
        funded: snap.isFunded,
        finalized: snap.isFinalized,
        disputed: snap.isDisputed,
        balanceEth: ethers.formatEther(snap.balance)
      });
      break;
    }

    case "dispute": {
      const [vaultAddr] = rest;
      const v = new ethers.Contract(vaultAddr, VAULT_ABI, signer);
      await (await v.raiseDispute()).wait();
      console.log("Dispute raised.");
      break;
    }

    case "cancel": {
      const [vaultAddr] = rest;
      const v = new ethers.Contract(vaultAddr, VAULT_ABI, signer);
      await (await v.cancelByBuyerPrePickup()).wait();
      console.log("Cancelled, refund processed.");
      break;
    }

    default:
      usage();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
