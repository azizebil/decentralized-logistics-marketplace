# Decentralized Logistics Marketplace — Final Report

**CS438 / SEC532 · Spring 2026**
Ekin Gülhan (34028) · Aziz Derin Ebil (34332) · Mert Hasan Aslan (32421)

---

## 1. Project Overview

### User Story

A seller wants a package delivered to a buyer without using a centralized courier company. They post a delivery request on-chain, specifying the declared value, maximum price, deadline, and buyer/mailbox addresses. Couriers browse open requests and place bids. An autonomous seller-side agent evaluates the bids using a scoring formula, accepts the best one within the seller's declared policy, and triggers the deployment of a per-delivery escrow vault. The buyer funds the vault. The courier picks up the package, reveals a pickup code on-chain, delivers it to the buyer's smart mailbox, and the mailbox agent confirms delivery by revealing the dropoff code. The vault releases payment to the courier and releases the courier's pool stake.

### Why EVM / Solidity

EVM gives us programmable escrow (funds locked until conditions are met), on-chain invariant enforcement (the pool's `activeValue ≤ totalStake` cannot be bypassed by any off-chain party), and composability between the three contracts. State transitions are atomic and irreversible by design.

### What Is Original

1. **Per-delivery escrow vault spawned by the registry.** Each accepted bid deploys a fresh `DeliveryVault` instance. No delivery shares state with another; a failure in one vault cannot affect others.
2. **Staking pool with capacity invariants.** Couriers lock funds into a shared pool, allowing them to cover high-value deliveries without per-delivery deposits. The invariant `activeValue ≤ totalStake` is enforced on every state transition.
3. **Sensor-gated mailbox agent.** The buyer's mailbox holds a dedicated signing key. It will not call `confirmDelivery` unless its simulated sensors pass (weight > 50 g, lid closed), and it is rate-limited to one confirmation per 60 seconds.
4. **Session-key agent policy enforced on-chain.** The seller registers a policy (`maxPrice`, `deadlineBuffer`, `coSignThreshold`) in the registry. `acceptBidByAgent` reverts if the agent tries to accept a bid that violates it — a hallucinating LLM cannot override on-chain math.

---

## 2. System Architecture

Three Solidity contracts handle all value flows:

| Contract | Role |
|---|---|
| `MarketplaceRegistry` | Holds delivery requests and bids; enforces stage machine; deploys vaults |
| `DeliveryVault` | Per-delivery escrow; preimage binding; dispute window; payout/slash/refund |
| `StakingPool` | Shared collateral; capacity invariant; withdrawal delay; pro-rata slashing |

Two off-chain agents:

| Agent | Role |
|---|---|
| `seller_agent.js` | Watches bid window; ranks bids with `r/(t·p)`; calls `acceptBidByAgent` or emits `co-sign-needed` |
| `mailbox_agent.js` | Simulates secure-element hardware; sensor check → rate-limit → `confirmDelivery` |

---

## 3. On-chain Invariants and Payment Policy

### Invariants

| Invariant | Where enforced |
|---|---|
| `activeValue ≤ totalStake` | `StakingPool.reserve()`, `requestWithdraw()` |
| `finalized = true` before any external call | `DeliveryVault` — checks-effects-interactions |
| Stage machine is one-way (Open → Assigned → Held → Finalized) | `MarketplaceRegistry` — explicit stage checks on every function |
| One vault per delivery | `registerByFactory` reverts if vault already set |
| Preimage binding: `keccak256(code ‖ deliveryId ‖ nonce)` | `DeliveryVault.pickup()`, `confirmDelivery()` |

### Agent Payment Policy

The seller calls `setAgentPolicy(agentAddress, maxPrice, deadlineBuffer, coSignThreshold)` once. `acceptBidByAgent` then enforces three hard limits that no LLM can override:

- **`maxPrice`**: bid price must be ≤ seller's budget cap.
- **`deadlineBuffer`**: bid's promised time must leave at least this many seconds before the delivery deadline.
- **`coSignThreshold`**: if `declaredValue > coSignThreshold`, the agent is not permitted to accept autonomously — the agent emits a `co-sign-needed` A2A message and the human seller must call `acceptBid` with their master key.

---

## 4. Security Model

### Attacks and Mitigations

**Malicious or buggy LLM accepts wrong bid.**
The session key can only accept bids within the policy limits; any violation reverts on-chain. High-value deliveries above `coSignThreshold` require the seller's master key co-signature.

**Pool exit before a failure lands.**
`requestWithdraw` records the request but does not transfer funds. A configurable `withdrawalDelay` must elapse before funds leave. Slashes during this period still draw from the requester's balance. A withdrawal that would violate `activeValue ≤ totalStake` for current active deliveries is rejected.

**Collusion between seller, courier, and buyer to defraud the pool.**
Per-member reservation is capped at `memberCapBps` of the member's own contribution, limiting each colluding courier's leverage. Pool admission is gated by the operator key. Slash history is exposed on-chain via `getCourierStats`.

**Reentrancy on payout or refund.**
`finalized = true` is set before any external call. All fund-moving entry points carry a `nonReentrant` modifier. The payout address is locked at bid acceptance time.

**Mailbox spoofing.**
The mailbox key has exactly one capability: `confirmDelivery`. Preimage binding means a code for one delivery cannot be replayed on another. A dispute window between `Delivered` and `Finalized` lets the buyer's primary key freeze payout. The mailbox agent is rate-limited to one confirmation per 60 seconds.

### Trust Boundaries

See `docs/SECURITY.md` for the full attack-by-attack code line mapping, and `CS438_Aslan_Ebil_Gulhan.pdf` (Phase 2 document) for the trust boundary analysis.

---

## 5. Edge Cases Demonstrated

| Scenario | How handled |
|---|---|
| Courier fails to pick up before deadline | `refundOnPickupTimeout` returns buyer's payment |
| Courier fails to deliver before deadline | `slashOnDropoffTimeout` slashes courier's pool stake, pays buyer |
| Agent tries to accept above `coSignThreshold` | `acceptBidByAgent` reverts on-chain; agent emits `co-sign-needed` |
| Courier's pool has insufficient capacity | `placeBid` reverts — registry checks `freeCapacityFor` before recording |
| Double payout attempt | `finalized = true` guard reverts second call |
| Buyer disputes after delivery | `raiseDispute` freezes payout; arbiter resolves via `resolveDispute` |

All six are covered by Hardhat tests (`test/Marketplace.test.js`).

---

## 6. How to Run

### Prerequisites

Node.js 18+, npm.

```bash
git clone <repo>
cd 438proje
npm install
```

### Compile and test

```bash
npx hardhat compile        # compiles all 3 contracts
npx hardhat test           # 14 tests, all passing
```

### Local end-to-end demo

```bash
# Terminal 1 — local chain
npm run node

# Terminal 2 — deploy + full flow
npm run deploy:local
npm run demo               # open → bid → agent-accept → fund → pickup → confirm → finalize
```

### Frontend GUI

```bash
npm run demo:frontend      # seeds frontend-demo.json with a live delivery
npm run frontend           # http://127.0.0.1:5173
```

Connect with "Dev Connect" for local Hardhat, or MetaMask for Sepolia.

### Playwright UI tests

```bash
npx playwright test        # 12 tests, automated end-to-end UI verification
```

### Testnet deployment (Sepolia)

```bash
cp .env.example .env       # fill in SEPOLIA_RPC_URL and DEPLOYER_KEY
npm run deploy:sepolia     # writes deployment.11155111.json
```

---

## 7. Deployed Testnet Addresses (Sepolia)

| Contract | Address |
|---|---|
| StakingPool | `0xD3a16FA31Df5054fA62212FCae16f81AF945bEA2` |
| MarketplaceRegistry | `0x526B503aaF9dFc75c612FD383A6AAA4C85578237` |

Verify on [Sepolia Etherscan](https://sepolia.etherscan.io/address/0xD3a16FA31Df5054fA62212FCae16f81AF945bEA2).

---

## 8. Agent Summary (informational)

**Seller agent** (`agents/seller_agent.js`):
- Ingests: on-chain bid events for a given `deliveryId`
- Decides: ranks bids with `score = r^α / (t × p)`, filtered by `maxPrice` and `maxDeadline`
- Executes: calls `acceptBidByAgent` on `MarketplaceRegistry`
- Verifies: parses `BidAccepted` event log; checks vault address returned
- Policy: if `declaredValue > coSignThreshold`, emits A2A `co-sign-needed` message instead of sending tx
- Optional: calls Anthropic API (Claude) to produce a plain-English explanation of the ranking decision

**Mailbox agent** (`agents/mailbox_agent.js`):
- Ingests: dropoff code + nonce presented by the courier at the physical mailbox
- Decides: checks sensor readings (weight, lid state) and rate limit
- Executes: calls `vault.confirmDelivery(code, nonce)` with the mailbox key
- Verifies: waits for tx confirmation; logs receipt hash
