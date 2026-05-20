#!/usr/bin/env node
// agents/seller_agent.js
//
// Live seller-agent watcher. Subscribes to BidPlaced events on a request,
// waits for the bid deadline, then ranks the bid book using SellerAgent core
// and calls acceptBidByAgent under the seller's session-key policy.
//
// Optional Anthropic-API "explainer" mode (set ANTHROPIC_API_KEY) wraps the
// decision in natural-language reasoning, but the underlying choice is always
// the deterministic core's output. The LLM cannot override it.
//
// Implements an A2A-style (Agent-to-Agent) ad-hoc message envelope so that
// other agents (e.g. a courier's autonomous bidder) can negotiate or query
// the seller's agent over a simple JSON wire protocol on stdin/stdout. The
// envelope is documented in docs/A2A.md.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { SellerAgent } = require("./seller_agent_core.js");

const DEPLOYMENT = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../deployment.json"), "utf8"));
const REGISTRY_ABI = require(path.resolve(__dirname, "../artifacts/contracts/MarketplaceRegistry.sol/MarketplaceRegistry.json")).abi;

function usage() {
  console.log(`
seller-agent — autonomous bid picker

Environment:
  RPC_URL          (default http://127.0.0.1:8545)
  AGENT_KEY        (private key OR "idx:N"; this is the session key)
  ANTHROPIC_API_KEY (optional; enables LLM commentary)

Subcommands:
  watch <deliveryId> <maxPriceEth> <preferTrusted:true|false>
                          -- listen until bid deadline, then accept best bid
  a2a-listen              -- start JSON-line A2A server on stdin
`);
}

async function getSigner() {
  const url = process.env.RPC_URL || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(url);
  const keyEnv = process.env.AGENT_KEY || "idx:6";
  if (keyEnv.startsWith("idx:")) {
    const idx = Number(keyEnv.slice(4));
    const mnemonic = "test test test test test test test test test test test junk";
    return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${idx}`).connect(provider);
  }
  return new ethers.Wallet(keyEnv, provider);
}

// --- Optional LLM commentary -------------------------------------------------

async function llmExplain(decision, bids) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const body = {
      model: "claude-sonnet-4-5",
      max_tokens: 300,
      messages: [{
        role: "user",
        content:
          "You are reviewing an autonomous courier-bid selection. " +
          "The selection was made by a deterministic formula r/(t*p). " +
          "Explain the ranking briefly (<= 4 sentences) in plain English for the seller. " +
          "Do NOT contradict the choice; this is a sanity-check explainer, not a decision-maker.\n\n" +
          "Bids:\n" + bids.map((b, i) => `  [${i}] price=${b.price} promisedTime=${b.promisedTime} repE4=${b.reputationE4}`).join("\n") +
          "\n\nWinner index: " + decision.winnerIndex
      }]
    };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.content && j.content[0] && j.content[0].text) return j.content[0].text;
    return null;
  } catch (e) {
    console.error("LLM explainer error:", e.message);
    return null;
  }
}

// --- A2A envelope ------------------------------------------------------------
// Minimal Google-A2A-style JSON message format. One line = one message.
// {
//   "v": "a2a/1",                 // protocol version
//   "id": "<uuid>",
//   "from": "agent://courier-1",
//   "to":   "agent://seller-1",
//   "intent": "query|offer|ack|deny",
//   "ctx":  { deliveryId: "0x..." },
//   "body": { ... }
// }
function a2a(intent, body, ctx = {}) {
  return JSON.stringify({
    v: "a2a/1",
    id: crypto.randomUUID(),
    from: "agent://seller-llm",
    to:   "agent://broadcast",
    intent, ctx, body
  });
}
const crypto = require("crypto");

async function a2aListen(signer, registry) {
  const sa = new SellerAgent({});
  process.stdin.setEncoding("utf8");
  let buf = "";
  process.stdin.on("data", chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        handleA2A(msg, signer, registry, sa).catch(e => console.error("A2A error:", e));
      } catch (e) {
        console.error("Bad A2A line:", e.message);
      }
    }
  });
  process.stdout.write(a2a("hello", { agent: signer.address }) + "\n");
}

async function handleA2A(msg, signer, registry, sa) {
  if (msg.v !== "a2a/1") return;
  if (msg.intent === "query" && msg.body && msg.body.method === "rank") {
    const decision = sa.rank(msg.body.bids || []);
    process.stdout.write(a2a("ack", { decision }, msg.ctx) + "\n");
    return;
  }
  if (msg.intent === "ping") {
    process.stdout.write(a2a("pong", { ts: Date.now() }, msg.ctx) + "\n");
  }
}

// --- watch -------------------------------------------------------------------

async function watch(deliveryId, maxPriceEth, preferTrusted) {
  const signer = await getSigner();
  const registry = new ethers.Contract(DEPLOYMENT.contracts.MarketplaceRegistry, REGISTRY_ABI, signer);
  const req = await registry.getRequest(deliveryId);
  if (req.seller === ethers.ZeroAddress) {
    throw new Error("Unknown delivery");
  }
  console.log("Watching", deliveryId, "as agent", signer.address);
  console.log("Bid deadline:", new Date(Number(req.bidDeadline) * 1000).toISOString());

  // Poll until bidDeadline. (We'd subscribe to events in production; polling
  // is simpler and works against the in-process Hardhat network too.)
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  while (Math.floor(Date.now() / 1000) < Number(req.bidDeadline)) {
    await sleep(5_000);
  }

  const bids = await registry.getBids(deliveryId);
  console.log(`Bidding closed; ${bids.length} bids received.`);
  if (bids.length === 0) {
    console.log("No bids to accept.");
    return;
  }

  const sa = new SellerAgent({
    preferTrusted: preferTrusted === "true",
    maxPrice: ethers.parseEther(maxPriceEth),
    maxDeadline: Number(req.maxDeadline),
    declaredValue: Number(req.declaredValue)
  });
  const decision = sa.rank(bids.map(b => ({
    price: b.price, promisedTime: b.promisedTime,
    reputationE4: b.reputationE4, withdrawn: b.withdrawn
  })));
  console.log("Decision:", decision);

  const explanation = await llmExplain(decision, bids);
  if (explanation) console.log("\nLLM commentary:\n" + explanation + "\n");

  if (decision.winnerIndex < 0) {
    console.log("No eligible bids.");
    return;
  }

  const tx = await registry.acceptBidByAgent(deliveryId, decision.winnerIndex);
  const rcpt = await tx.wait();
  const evt = rcpt.logs.map(l => { try { return registry.interface.parseLog(l); } catch { return null; } })
                       .find(e => e && e.name === "BidAccepted");
  console.log("Accepted as agent; vault =", evt.args.vault);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") return usage();
  switch (cmd) {
    case "watch":      return watch(rest[0], rest[1], rest[2]);
    case "a2a-listen": {
      const signer = await getSigner();
      const registry = new ethers.Contract(DEPLOYMENT.contracts.MarketplaceRegistry, REGISTRY_ABI, signer);
      return a2aListen(signer, registry);
    }
    default: usage();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
