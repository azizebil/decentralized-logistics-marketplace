// agents/seller_agent_core.js
//
// Deterministic core for the Seller's Agent. Ranks courier bids using the
// formula from the architecture doc (Section 1.2):
//
//     score = r^alpha / (t * p)
//
// where:
//   r      = reputation factor in [0, 1]
//   t      = promised delivery time relative to "now" (smaller = better)
//   p      = price the courier asks
//   alpha  = 0 if the seller did NOT check "prefer trusted couriers",
//            > 0 otherwise (the agent's reputation weighting)
//
// The seller's pre-set hard limits (maxPrice, maxDeadline) are enforced as
// FILTERS before scoring, so an LLM acting on this core cannot pick a bid
// the seller would have rejected outright.
//
// The class is plain JavaScript with no on-chain dependencies, so it is
// callable from the demo script, a CLI, a server, or wrapped by an LLM.

"use strict";

class SellerAgent {
  constructor({ preferTrusted = false, maxPrice, maxDeadline, declaredValue, alpha = 1.5 }) {
    this.preferTrusted = preferTrusted;
    // Allow these to be BigInt (from ethers) or Number; we normalize per use.
    this.maxPrice      = maxPrice;
    this.maxDeadline   = maxDeadline;
    this.declaredValue = declaredValue;
    this.alpha         = preferTrusted ? alpha : 0;
  }

  // Convert any (Number | bigint | string) to Number safely for scoring math.
  static _num(x) {
    if (typeof x === "bigint") return Number(x);
    if (typeof x === "string") return Number(x);
    return x;
  }

  // Returns { winnerIndex, scored: [{ index, score, reason }] }
  rank(bids, nowSec = Math.floor(Date.now() / 1000)) {
    const scored = [];

    for (let i = 0; i < bids.length; i++) {
      const b = bids[i];
      // Some on-chain reads come back as structs with Number-ish bigints.
      const price        = SellerAgent._num(b.price);
      const promisedTime = SellerAgent._num(b.promisedTime);
      const reputationE4 = SellerAgent._num(b.reputationE4);
      const withdrawn    = b.withdrawn === true;

      // Hard filters first. An LLM cannot bypass these.
      if (withdrawn) {
        scored.push({ index: i, score: -Infinity, reason: "withdrawn" });
        continue;
      }
      if (this.maxPrice !== undefined && price > SellerAgent._num(this.maxPrice)) {
        scored.push({ index: i, score: -Infinity, reason: "price > maxPrice" });
        continue;
      }
      if (this.maxDeadline !== undefined && promisedTime > SellerAgent._num(this.maxDeadline)) {
        scored.push({ index: i, score: -Infinity, reason: "promisedTime > maxDeadline" });
        continue;
      }
      if (promisedTime <= nowSec) {
        scored.push({ index: i, score: -Infinity, reason: "promisedTime in the past" });
        continue;
      }

      // r in [0, 1]
      const r = reputationE4 / 10000;
      // t in seconds remaining; bigger time = worse, so divide by it
      const t = promisedTime - nowSec;
      // p in wei; bigger price = worse
      const p = price;

      // r^alpha / (t * p)
      const repFactor = this.preferTrusted ? Math.pow(Math.max(r, 1e-6), this.alpha) : 1;
      const score = repFactor / (t * p);

      scored.push({
        index: i,
        score,
        reason: `score = r^${this.alpha.toFixed(2)} / (t*p) = ` +
                `${repFactor.toExponential(3)} / (${t} * ${p}) = ${score.toExponential(3)}`
      });
    }

    let winnerIndex = -1;
    let best = -Infinity;
    for (const s of scored) {
      if (s.score > best) { best = s.score; winnerIndex = s.index; }
    }

    return { winnerIndex, scored };
  }
}

module.exports = { SellerAgent };
