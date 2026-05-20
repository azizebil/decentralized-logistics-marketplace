# Security: attack-by-attack mitigation map

This document mirrors §4 of the architecture PDF (`CS438_Aslan_Ebil_Gulhan.pdf`)
and shows exactly where in the source each mitigation lives. Read it alongside
the PDF: the PDF gives the *why*, this gives the *where*.

All line references are against the files in `contracts/` at the commit that
produced this snapshot. Tests cited are in `test/Marketplace.test.js`.

---

## 1. Malicious or buggy LLM locks funds in the wrong bid

**Attack.** The seller's LLM-driven agent miscomputes the ranking or is
prompt-injected through a bid description and calls `acceptBid` on a courier
the seller would not have chosen.

**Mitigations in code.**

* The agent has a *session key*, not the seller's main key. Sellers register
  a policy via `setAgentPolicy` (`MarketplaceRegistry.sol:121`) declaring:
    * `maxPrice` — upper bound on courier fee the agent may accept;
    * `minDeadlineBuffer` — required slack between the bid's promised delivery
      time and the request's `maxDeadline`, so a courier can't burn the buffer;
    * `coSignThreshold` — above this declared value the agent is forbidden
      from acting alone.
* `acceptBidByAgent` (`MarketplaceRegistry.sol:277`) checks the policy *before*
  the request moves to Assigned. Any violation reverts; the on-chain state
  never changes. The deterministic guard is independent of the LLM, so even a
  fully compromised model cannot push through an out-of-policy bid.
* Above `coSignThreshold` the agent client (`agents/seller_agent.js`) refuses
  to send the transaction and instead emits an A2A `co-sign-needed`
  notification; the seller must call `acceptBid` (the non-agent path,
  `MarketplaceRegistry.sol:262`) from their master key.

**Tests.**
* `rejects agent bid above maxPrice` — a courier bid above `maxPrice` reverts
  in `placeBid` itself (defence in depth).
* `rejects agent acceptance above coSignThreshold` — even a within-budget bid
  cannot be agent-accepted once the declared value exceeds the threshold.

---

## 2. Pool exit right before a failure

**Attack.** A pool member sees a colleague is about to fail a high-value
delivery and races to withdraw their stake before the slash hits, leaving the
remaining members to absorb the proportional loss.

**Mitigations in code.**

* `StakingPool.requestWithdraw` (`StakingPool.sol:174`) does **not** transfer
  funds; it only records the request and a release timestamp at
  `block.timestamp + withdrawalDelay`. The constructor's `withdrawalDelay`
  parameter (`StakingPool.sol` constructor, ~line 97) must be set longer than
  the maximum dropoff timeout of any active delivery the member is backing.
* While the withdraw is pending, *the funds are still in the pool*. Any
  `slash` (`StakingPool.sol:254`) that lands in that window proportionally
  draws from the requester's balance just like any other member's.
* Capacity is re-checked at withdraw acceptance time: the function requires
  that after subtracting the request, the member can still cover the share of
  `activeValue` allocated to them via the per-member cap. Members who are
  *currently* reserved against active deliveries cannot withdraw their
  reservation away.

**Tests.**
* `enforces withdrawal delay` — calling `finalizeWithdraw` before the delay
  passes reverts.
* `blocks withdraw that would breach member-cap on reserved value` — a member
  whose contribution backs an active reservation cannot withdraw it.

---

## 3. Collusion between seller, courier, and buyer to defraud a pool

**Attack.** A seller posts a fake high-value request, a colluding courier in
a victim pool "fails" the delivery, the pool is slashed, and the slashed funds
end up with the colluding buyer.

This is the principal *residual* risk of pooled staking — contract logic alone
cannot eliminate it. Mitigations shift probability, not certainty:

**Mitigations in code.**

* Per-member reservation cap (`memberCapBps` field, enforced in
  `StakingPool.reserve` at `StakingPool.sol:220`). Even if a courier deposits
  the bare minimum, the pool will not back deliveries beyond
  `(contribution × memberCapBps / 10_000)` for them. The colluding courier
  cannot leverage the *whole* pool against a single fake request.
* Admission control: `admitMember` (`StakingPool.sol:123`) is gated by
  `onlyOperator`. The pool operator can run off-chain identity/KYC checks
  before letting an address contribute, raising the cost of Sybil collusion.
* `getCourierStats` (in `StakingPool`) exposes the per-courier slash history
  on-chain. Pool operators and seller agents can read this for anomaly
  detection (the same seller↔buyer pair repeatedly causing failures is a flag
  the seller agent's `seller_agent_core.js` ranker can incorporate).

**Not implemented (acknowledged as future work).** The PDF mentions an
insurance-fee mechanism (a basis-points fee on successful deliveries funding a
reserve). This would slot in cleanly as a parameter on
`MarketplaceRegistry`'s constructor and a small diversion inside
`DeliveryVault._payout` (`DeliveryVault.sol:291`). The hook point is marked
with a comment in that function.

---

## 4. Reentrancy on payout or refund

**Attack.** Paying out to a courier whose `payoutAddress` is a contract
re-enters `DeliveryVault.finalizeDelivered` before `finalized = true` is set,
draining the vault twice.

**Mitigations in code.**

* Checks-effects-interactions, strictly. In every payout/refund path
  (`_payout` at `DeliveryVault.sol:291`, `_refund` at `:307`, `_slashAndRefund`
  at `:321`) the state mutation (`finalized = true`, `state = …`,
  `pool.release(...)`) happens *before* the external `call`.
* The `nonReentrant` modifier guards every entry point that can move funds:
  `finalizeDelivered` (`:252`), `refundOnPickupTimeout` (`:265`),
  `slashOnDropoffTimeout` (`:273`), `cancelByBuyerPrePickup` (`:280`),
  `resolveDispute` (`:240`). The guard is a simple 1/2 flag set on entry, so
  even a recursive call into a *different* protected entry point reverts.
* The courier's `payoutAddress` is locked at bid acceptance time inside
  `MarketplaceRegistry._accept` (`MarketplaceRegistry.sol:300`). A courier
  cannot later change it to a malicious contract — the value forwarded to the
  vault's `initialize`/constructor is the snapshot captured at acceptance.
* All outgoing transfers use `call{value: …}("")` (no `transfer`/`send`), so
  the function does not depend on the 2300-gas stipend, but the reentrancy
  guard plus CEI is what actually protects us.

**Tests.**
* `rejects a second payout attempt` — directly attempts a second
  `finalizeDelivered` after the first succeeds; reverts on the `finalized`
  check.

---

## 5. Mailbox spoofing / compromised secure element

**Attack.** An attacker compromises the mailbox firmware or extracts the
signing key and confirms a "delivery" that never occurred, releasing payment
to a colluding courier.

This is acknowledged as the hardest trust boundary. We cannot prove the
physical world on-chain — only narrow the attack surface.

**Mitigations in code.**

* The mailbox signing key has *exactly one* on-chain capability:
  `confirmDelivery` (`DeliveryVault.sol:205`). It cannot fund, refund, slash,
  cancel, or change any other state.
* Preimage binding: `confirmDelivery` verifies
  `keccak256(code || deliveryId || nonce) == dropoffHash`. A code revealed on
  one delivery — including one captured from a compromised mailbox earlier —
  is useless for any other delivery, because the `deliveryId` and `nonce` are
  baked into the commitment.
* **Dispute window.** When the seller calls `openRequest` they specify a
  `disputeWindow` (`MarketplaceRegistry.sol:145`, forwarded to the vault).
  After `confirmDelivery` the vault enters the `Delivered` state but
  `finalizeDelivered` (`DeliveryVault.sol:252`) reverts until the window
  expires. During the window the buyer's *primary* key (not the mailbox key)
  may call `raiseDispute` (`:227`), which moves state to a disputed flag.
  Resolution by the pool operator's arbiter then chooses `_payout` or
  `_slashAndRefund` via `resolveDispute` (`:240`).
* Rate-limiting in `mailbox_agent.js` — the off-chain agent refuses to sign
  more than one confirmation per delivery and pauses on suspicious sensor
  patterns. The on-chain `notFinalized` modifier (single use of
  `confirmDelivery` per vault) backstops this even if the agent is bypassed.

**Tests.**
* `rejects a pickup code reused across deliveries` — exercises the preimage
  binding against the cross-delivery replay attack.
* `rejects an incorrect preimage` — wrong preimage cannot confirm.
* `allows buyer to dispute and arbiter to refund` — full dispute-window flow:
  mailbox confirms, buyer disputes, arbiter slashes the courier and refunds.
* `finalizes after dispute window if no dispute filed` — confirms the timing
  side: cannot finalize before the window, can after.

---

## Summary table

| §4 attack | Primary on-chain check | Test |
|---|---|---|
| LLM picks bad bid | `acceptBidByAgent` policy check | `Agent session-key safety` ×2 |
| Strategic pool exit | `withdrawalDelay` + re-checked capacity | `enforces withdrawal delay` |
| Collusion | per-member cap, gated admission | `rejects bids when courier lacks pool capacity` |
| Reentrancy | CEI + `nonReentrant` + locked payout addr | `rejects a second payout attempt` |
| Mailbox spoof | preimage binding + dispute window | `Dispute window` ×2, `Preimage binding` ×2 |

---

## Storage-layout & integer-overflow notes (CS438 quiz topics)

These came up in coursework and are worth noting explicitly:

* **Overflow.** All arithmetic in the contracts is in Solidity 0.8.24, which
  reverts on overflow/underflow by default. We do not use `unchecked` blocks
  anywhere — the small perf hit is irrelevant for this domain, and reverting
  is the safe failure mode.
* **Storage layout.** Each contract groups related state into a single
  `struct` (e.g. `Request`, `Vault` snapshot, `Member`). We do not rely on
  storage-slot packing tricks for security — the invariants are encoded as
  explicit `require` checks, not as field adjacency.
* **On-chain randomness.** We do not use `block.timestamp`/`blockhash` as a
  source of randomness anywhere. The `nonce` in pickup/dropoff hashes is
  generated *off-chain* by the seller/buyer and only its commitment touches
  the chain.
