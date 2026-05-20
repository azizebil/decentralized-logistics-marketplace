# Decentralized Logistics Marketplace (DLM)

> Phase-3 implementation — CS438/SEC532, Spring 2026
> Ekin Gülhan · Aziz Derin Ebil · Mert Hasan Aslan


npx.cmd hardhat node
npx.cmd hardhat run scripts/deploy.js --network localhost
npm.cmd run frontend

Go http://127.0.0.1:5173

A trust-minimised, permissionless logistics marketplace. Sellers post delivery
requests, couriers bid against shared staking pools, and a buyer's *Magic
Mailbox* (a hardware-signing agent) releases escrowed funds only after physical
delivery is confirmed. An LLM-driven seller agent picks bids under a session
key whose limits are enforced **on-chain** — so a hallucinating model can never
finalise an out-of-policy delivery.

The full architecture and threat model is in
[`CS438_Aslan_Ebil_Gulhan.pdf`](./CS438_Aslan_Ebil_Gulhan.pdf) (Phase 2 doc).
This README is the reproducibility companion.

---

## Layout

```
contracts/
  MarketplaceRegistry.sol   open requests, bids, agent policy, vault factory
  DeliveryVault.sol         per-delivery escrow, preimage binding, dispute window
  StakingPool.sol           shared collateral, capacity invariant, slashing
test/
  Marketplace.test.js       14 tests, full lifecycle + every documented attack
scripts/
  deploy.js                 deploys one pool + the registry, prints addresses
  demo-end-to-end.js        runs the whole flow against a fresh Hardhat chain
agents/
  seller_agent_core.js      deterministic bid ranker (no LLM)
  seller_agent.js           watcher + Google A2A envelope + optional LLM commentary
  mailbox_agent.js          sensor simulator, rate-limit, secure-element key handling
clients/
  seller/ courier/ buyer/   thin CLIs that wrap the contracts
docs/
  SECURITY.md               attack-by-attack mapping to code line references
  A2A.md                    the Agent Payments envelope schema we accept
```

---

## Quick start

Node 18+ required. From the project root:

```bash
npm install
npx hardhat compile
npx hardhat test          # 14 passing
npx hardhat run scripts/demo-end-to-end.js
```

The demo spins up an in-process chain, deploys everything, runs three couriers
through a full delivery (open → bid → agent-accept → fund → pickup →
mailbox-confirm → finalize), and prints the staking pool invariant at every
step.

### Note on the Solidity compiler

`binaries.soliditylang.org` is blocked in this sandbox, so `hardhat.config.js`
overrides `TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD` to use the npm package
`solc@0.8.24` (already a dependency). On a normal developer machine you can
remove that override and Hardhat will fetch the official binary.

---

## CLI usage

Every CLI accepts the same env vars:

| var | meaning |
|---|---|
| `RPC_URL` | JSON-RPC endpoint (defaults to `http://127.0.0.1:8545`) |
| `REGISTRY` | deployed `MarketplaceRegistry` address |
| `POOL` | deployed `StakingPool` address |
| `*_KEY` | either a 0x-prefixed private key or `idx:N` to pick Hardhat's Nth default account |

So a local end-to-end can run across four terminals against
`npx hardhat node`:

```bash
# terminal 1 — the chain
npx hardhat node

# terminal 2 — deploy
RPC_URL=http://127.0.0.1:8545 npx hardhat run scripts/deploy.js --network localhost

# terminal 3 — seller posts a request
REGISTRY=0x... POOL=0x... SELLER_KEY=idx:1 \
  node clients/seller/seller_cli.js open \
    --buyer 0x... --mailbox 0x... \
    --value 1.0 --max-price 0.2 --max-deadline 3600 --bid-window 600

# terminal 4 — courier bids
REGISTRY=0x... POOL=0x... COURIER_KEY=idx:5 \
  node clients/courier/courier_cli.js bid \
    --id 0x<deliveryId> --price 0.15 --eta 2400
```

The buyer CLI funds the vault once a bid is accepted, the courier CLI reveals
the pickup code, and `agents/mailbox_agent.js` runs as a long-lived process
that watches its vault address and signs `confirmDelivery` when the (simulated)
sensors report a package.

### The seller agent

```bash
REGISTRY=0x... AGENT_KEY=idx:2 SELLER_ADDR=0x... \
  node agents/seller_agent.js watch
```

`watch` mode listens for `RequestOpened` events on the registry, waits for the
bid window to close, runs the deterministic `r/(t·p)` ranker from
`seller_agent_core.js`, and calls `acceptBidByAgent` — which reverts on-chain
if the chosen bid breaks the session-key limits. If the bid exceeds the
seller's co-sign threshold the agent instead emits an A2A `co-sign-needed`
notification and refuses to send the transaction.

Set `ANTHROPIC_API_KEY` to also get a natural-language explanation of the pick
(commentary only — the ranker output is authoritative).

### A2A endpoint

```bash
REGISTRY=0x... AGENT_KEY=idx:2 node agents/seller_agent.js a2a-listen
```

Speaks the envelope documented in [`docs/A2A.md`](docs/A2A.md). Couriers (or
their own autonomous agents) can negotiate over it before placing on-chain
bids.

---

## What's actually enforced on-chain

Everything that matters. The PDF's invariants map 1:1 to revert conditions —
see [`docs/SECURITY.md`](docs/SECURITY.md) for the attack-by-attack mapping.

* `activeValue ≤ totalStake` (StakingPool: every `reserve()` and accepted
  `requestWithdraw()`).
* Per-member reservation cap as a % of own contribution (`memberCapBps`).
* Withdrawal delay (configurable, default 7 days) blocks strategic exits.
* Pickup/dropoff codes bind to `keccak256(code || deliveryId || nonce)` — a
  code revealed on one delivery is useless for another.
* Once `finalized = true` no further payout, refund, or slash is possible.
* `nonReentrant` + checks-effects-interactions on every external-call site.
* Agent session-key limits (max price, min deadline buffer, co-sign threshold)
  are checked in `acceptBidByAgent` before the bid moves to Assigned.

## What is *not* on-chain (and can't be)

* Physical reality. The mailbox is the hardest trust boundary — we mitigate
  with sensor bundles, rate-limited signing, a dispute window, and signed
  firmware, but ultimately the buyer trusts their own hardware.
* The seller↔buyer off-chain channel for pickup/dropoff codes. If that channel
  is compromised the codes leak and the contracts can't tell.
* Collusion among a seller, courier, and buyer to defraud a pool. We reduce
  leverage (per-member cap) and create economic friction (deposit, possible
  insurance fee) — but this is the principal residual risk of pooled staking
  and is acknowledged in the threat model.

---

## Tests at a glance

```
Happy path
  ✔ full end-to-end delivery
  ✔ sequential deliveries reuse the pool correctly
Timeouts
  ✔ refunds on pickup timeout
  ✔ slashes the courier on dropoff timeout
StakingPool invariants
  ✔ rejects bids when courier lacks pool capacity
  ✔ blocks withdraw that would breach member-cap on reserved value
  ✔ enforces withdrawal delay
Agent session-key safety
  ✔ rejects agent bid above maxPrice
  ✔ rejects agent acceptance above coSignThreshold
Preimage binding
  ✔ rejects a pickup code reused across deliveries
  ✔ rejects an incorrect preimage
Dispute window
  ✔ allows buyer to dispute and arbiter to refund
  ✔ finalizes after dispute window if no dispute filed
Double-finalize guard
  ✔ rejects a second payout attempt
```

Every attack in §4 of the threat model has at least one matching test.
