#!/usr/bin/env node
// agents/seller_agent.js
//
// Live seller-agent watcher. Subscribes to BidPlaced events on a request,
// waits for the bid deadline, then ranks the bid book using SellerAgent core
// and calls acceptBidByAgent under the seller's session-key policy.
//
// If the winning bid's declared value exceeds the seller's coSignThreshold
// the agent emits a co-sign-needed A2A message and refuses to send the tx —
// the human seller must call acceptBid themselves.
//
// Optional Anthropic-API "explainer" mode (set ANTHROPIC_API_KEY) wraps the
// decision in natural-language reasoning, but the underlying choice is always
// the deterministic core's output. The LLM cannot override it.
//
// A2A intents implemented (see docs/A2A.md):
//   bid-discuss   — courier asks if a proposed bid would rank well
//   bid-confirm   — courier notifies agent an on-chain bid was placed
//   co-sign-needed — (outgoing) agent escalates to human seller
//   rank-explain  — debug: reply with full ranking of all open bids

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { SellerAgent } = require("./seller_agent_core.js");

const DEPLOYMENT   = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../deployment.json"), "utf8"));
const REGISTRY_ABI = require(path.resolve(__dirname, "../artifacts/contracts/MarketplaceRegistry.sol/MarketplaceRegistry.json")).abi;

function usage() {
  console.log(`
seller-agent — autonomous bid picker

Environment:
  RPC_URL           (default http://127.0.0.1:8545)
  AGENT_KEY         (private key OR "idx:N"; this is the session key)
  ANTHROPIC_API_KEY (optional; enables LLM commentary)

Subcommands:
  watch <deliveryId> <maxPriceEth> <preferTrusted:true|false>
                          -- listen until bid deadline, then accept best bid
                             (emits co-sign-needed if value > coSignThreshold)
  a2a-listen              -- start JSON-line A2A server on stdin/stdout
`);
}

// ── Provider / signer ────────────────────────────────────────────────────────

async function getSigner() {
  const url    = process.env.RPC_URL || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(url);
  const keyEnv = process.env.AGENT_KEY || "idx:6";
  if (keyEnv.startsWith("idx:")) {
    const idx = Number(keyEnv.slice(4));
    const mnemonic = "test test test test test test test test test test test junk";
    return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${idx}`).connect(provider);
  }
  return new ethers.Wallet(keyEnv, provider);
}

// ── On-chain policy reader ───────────────────────────────────────────────────

async function fetchPolicy(registry, sellerAddress) {
  try {
    const p = await registry.agentPolicies(sellerAddress);
    // returns (agentAddr, maxPrice, deadlineBuffer, coSignThreshold, isSet)
    return {
      agentAddr:       p[0],
      maxPrice:        p[1],
      deadlineBuffer:  p[2],
      coSignThreshold: p[3],
      isSet:           p[4]
    };
  } catch {
    return null;
  }
}

// ── LLM commentary ───────────────────────────────────────────────────────────

async function llmExplain(decision, bids) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        messages: [{
          role: "user",
          content:
            "You are reviewing an autonomous courier-bid selection for a decentralized logistics marketplace. " +
            "The selection was made by the deterministic formula score = r^α / (t × p). " +
            "Explain the ranking in ≤4 sentences in plain English for the seller. " +
            "Do NOT contradict the choice; this is a sanity-check explainer, not a decision-maker.\n\n" +
            "Bids:\n" + bids.map((b, i) =>
              `  [${i}] price=${b.price} promisedTime=${b.promisedTime} repE4=${b.reputationE4}`
            ).join("\n") +
            "\n\nWinner index: " + decision.winnerIndex
        }]
      })
    });
    const j = await r.json();
    return j.content?.[0]?.text ?? null;
  } catch (e) {
    console.error("LLM explainer error:", e.message);
    return null;
  }
}

// ── A2A envelope helpers ──────────────────────────────────────────────────────

function a2aMsg(intent, body, ctx = {}, to = "agent://broadcast") {
  return JSON.stringify({
    v:      "a2a/1",
    id:     crypto.randomUUID(),
    from:   "agent://seller-agent",
    to,
    intent,
    ctx,
    body
  });
}

function emit(intent, body, ctx, to) {
  process.stdout.write(a2aMsg(intent, body, ctx, to) + "\n");
}

// ── A2A intent handlers ───────────────────────────────────────────────────────

async function handleA2A(msg, signer, registry, sa) {
  if (msg.v !== "a2a/1") return;
  const ctx = msg.ctx || {};
  const replyTo = msg.id;

  switch (msg.intent) {

    // courier → seller agent: "would my bid rank well before I pay gas?"
    case "bid-discuss": {
      const { askedPrice, promisedEta, courier } = msg.body || {};
      if (!askedPrice || !promisedEta) {
        emit("bid-discuss", { replyTo, feasible: false, reason: "missing askedPrice or promisedEta" }, ctx);
        return;
      }
      // Score this hypothetical bid against an empty field (no competitors)
      const nowSec = Math.floor(Date.now() / 1000);
      const fakeBid = {
        price:        BigInt(askedPrice),
        promisedTime: BigInt(promisedEta),
        reputationE4: 9000n, // assume decent reputation for discussion
        withdrawn:    false
      };
      const decision = sa.rank([fakeBid]);
      const feasible = decision.winnerIndex === 0;
      const scored   = decision.scored[0];
      const normalizedScore = feasible ? scored.score : 0;

      emit("bid-discuss", {
        replyTo,
        feasible,
        wouldRank: Number(normalizedScore.toExponential(6)),
        reason: scored.reason ?? (feasible ? "within budget and deadline buffer" : scored.reason)
      }, ctx, msg.from);
      break;
    }

    // courier → seller agent: "I placed a bid on-chain, re-rank now"
    case "bid-confirm": {
      const { bidIndex, txHash } = msg.body || {};
      console.error(`[A2A] bid-confirm received: bidIndex=${bidIndex} tx=${txHash} — re-rank queued`);
      // No reply required per spec. The watch() loop will pick this up on its
      // next poll; in a production agent we'd signal the polling loop here.
      break;
    }

    // debug: any peer can request a full ranking of open bids
    case "rank-explain": {
      const deliveryId = ctx.deliveryId;
      if (!deliveryId) {
        emit("rank-explain", { replyTo, error: "ctx.deliveryId required" }, ctx, msg.from);
        return;
      }
      try {
        const bids = await registry.getBids(deliveryId);
        const decision = sa.rank(bids.map(b => ({
          price:        b.price,
          promisedTime: b.promisedTime,
          reputationE4: b.reputationE4,
          withdrawn:    b.withdrawn
        })));
        emit("rank-explain", {
          replyTo,
          winnerIndex: decision.winnerIndex,
          scored:      decision.scored
        }, ctx, msg.from);
      } catch (e) {
        emit("rank-explain", { replyTo, error: e.message }, ctx, msg.from);
      }
      break;
    }

    // legacy ping
    case "ping":
      emit("pong", { replyTo, ts: Date.now() }, ctx, msg.from);
      break;

    default:
      console.error(`[A2A] unknown intent: ${msg.intent}`);
  }
}

// ── A2A listener loop ─────────────────────────────────────────────────────────

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
  // Announce presence on startup
  emit("hello", { agent: signer.address, version: "a2a/1" });
}

// ── watch ─────────────────────────────────────────────────────────────────────

async function watch(deliveryId, maxPriceEth, preferTrusted) {
  const signer   = await getSigner();
  const registry = new ethers.Contract(DEPLOYMENT.contracts.MarketplaceRegistry, REGISTRY_ABI, signer);
  const req      = await registry.getRequest(deliveryId);

  if (req.seller === ethers.ZeroAddress) throw new Error("Unknown delivery");

  console.log("Watching", deliveryId, "as agent", signer.address);
  console.log("Seller:  ", req.seller);
  console.log("Bid deadline:", new Date(Number(req.bidDeadline) * 1000).toISOString());

  // Fetch the seller's on-chain agent policy to get coSignThreshold
  const policy = await fetchPolicy(registry, req.seller);
  if (policy?.isSet) {
    console.log(`Agent policy: maxPrice=${ethers.formatEther(policy.maxPrice)} ETH, coSignThreshold=${ethers.formatEther(policy.coSignThreshold)} ETH`);
  } else {
    console.log("No agent policy set for this seller — agent will act without coSign check.");
  }

  // Poll until bidDeadline
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  while (Math.floor(Date.now() / 1000) < Number(req.bidDeadline)) {
    process.stdout.write(".");
    await sleep(5_000);
  }
  console.log("\nBid window closed.");

  const bids = await registry.getBids(deliveryId);
  console.log(`${bids.length} bid${bids.length === 1 ? "" : "s"} received.`);
  if (bids.length === 0) { console.log("No bids to accept."); return; }

  const sa = new SellerAgent({
    preferTrusted: preferTrusted === "true",
    maxPrice:      ethers.parseEther(maxPriceEth),
    maxDeadline:   Number(req.maxDeadline),
    declaredValue: Number(req.declaredValue)
  });

  const decision = sa.rank(bids.map(b => ({
    price: b.price, promisedTime: b.promisedTime,
    reputationE4: b.reputationE4, withdrawn: b.withdrawn
  })));

  console.log("Decision:", JSON.stringify(decision, null, 2));

  const explanation = await llmExplain(decision, bids);
  if (explanation) console.log("\nLLM commentary:\n" + explanation + "\n");

  if (decision.winnerIndex < 0) {
    console.log("No eligible bids after applying hard filters.");
    return;
  }

  // ── co-sign check ──────────────────────────────────────────────────────────
  // If the winning bid's declared value exceeds the seller's coSignThreshold
  // the session key is not allowed to call acceptBidByAgent (it would revert).
  // Instead we emit co-sign-needed and ask the human seller to act.
  if (policy?.isSet && req.declaredValue > policy.coSignThreshold) {
    console.log("\n⚠  co-sign required: declaredValue exceeds coSignThreshold.");
    console.log(`   declaredValue    = ${ethers.formatEther(req.declaredValue)} ETH`);
    console.log(`   coSignThreshold  = ${ethers.formatEther(policy.coSignThreshold)} ETH`);
    console.log("   Emitting co-sign-needed A2A message. Human seller must call acceptBid.\n");

    emit("co-sign-needed", {
      bidIndex:      decision.winnerIndex,
      declaredValue: req.declaredValue.toString(),
      explain:       explanation ??
        `Bid ${decision.winnerIndex} won the ranking but the delivery value ` +
        `(${ethers.formatEther(req.declaredValue)} ETH) exceeds the agent's ` +
        `co-sign threshold (${ethers.formatEther(policy.coSignThreshold)} ETH). ` +
        `The human seller must approve this one.`
    }, { deliveryId, registry: DEPLOYMENT.contracts.MarketplaceRegistry });

    return; // do NOT send the tx
  }

  // ── agent accepts ──────────────────────────────────────────────────────────
  console.log(`Calling acceptBidByAgent(${deliveryId}, ${decision.winnerIndex})…`);
  const tx   = await registry.acceptBidByAgent(deliveryId, decision.winnerIndex);
  const rcpt = await tx.wait();
  const evt  = rcpt.logs
    .map(l => { try { return registry.interface.parseLog(l); } catch { return null; } })
    .find(e => e?.name === "BidAccepted");

  console.log("✓ Accepted; vault =", evt?.args?.vault ?? "(event not found)");
}

// ── entry point ───────────────────────────────────────────────────────────────

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") return usage();
  switch (cmd) {
    case "watch":
      return watch(rest[0], rest[1], rest[2]);
    case "a2a-listen": {
      const signer   = await getSigner();
      const registry = new ethers.Contract(DEPLOYMENT.contracts.MarketplaceRegistry, REGISTRY_ABI, signer);
      return a2aListen(signer, registry);
    }
    default:
      usage();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
