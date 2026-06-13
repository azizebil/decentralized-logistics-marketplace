# Decentralized Logistics Marketplace

CS438 / SEC532 — Spring 2026  
Ekin Gülhan · Aziz Derin Ebil · Mert Hasan Aslan

A permissionless logistics marketplace on Ethereum. Sellers post delivery requests, couriers bid backed by a staking pool, an autonomous AI agent selects the best bid, and a sensor-gated mailbox agent confirms physical delivery — all enforced by Solidity smart contracts.

---

## Deployed Contracts (Sepolia Testnet)

| Contract | Address |
|---|---|
| StakingPool | `0xD3a16FA31Df5054fA62212FCae16f81AF945bEA2` |
| MarketplaceRegistry | `0x526B503aaF9dFc75c612FD383A6AAA4C85578237` |

---

## Quick Start

```bash
git clone <repo-url>
cd 438proje
npm install
cp .env.example .env   # fill in your keys
```

### Compile & Test

```bash
npx hardhat compile
npx hardhat test test/Marketplace.test.js   # 14 tests
```

### Local Demo (Hardhat)

```bash
# Terminal 1
npm run node

# Terminal 2
npm run deploy:local
npm run demo
```

### Frontend GUI

```bash
npm run frontend   # serves http://127.0.0.1:5173
```

Open `http://127.0.0.1:5173` — click **Connect MetaMask** for Sepolia or **Dev Connect** for local Hardhat.

### Testnet Deployment

```bash
# Fill SEPOLIA_RPC_URL and DEPLOYER_KEY in .env first
npm run deploy:sepolia
```

### Playwright UI Tests

```bash
npx playwright test
```

---

## Project Structure

```
contracts/
  MarketplaceRegistry.sol   — delivery requests, bids, agent policy, vault factory
  DeliveryVault.sol         — per-delivery escrow, preimage binding, dispute window
  StakingPool.sol           — shared collateral, capacity invariant, slashing

agents/
  seller_agent_core.js      — deterministic r/(t·p) bid ranking (no LLM)
  seller_agent.js           — watcher + A2A protocol + GPT-4o-mini commentary
  mailbox_agent.js          — sensor simulator, rate-limit, confirmDelivery

frontend/
  index.html / app.js       — MetaMask + dev-mode browser UI
  server.js                 — Node.js server + /api/agent/* endpoints (OpenAI)

test/
  Marketplace.test.js       — 14 Hardhat tests
  e2e/ui-demo.spec.js       — 12 Playwright UI tests

docs/
  report.tex                — Final report (LaTeX)
  SECURITY.md               — Attack-by-attack mitigations
  A2A.md                    — Agent-to-Agent wire protocol
```

---

## Environment Variables

See `.env.example` for all required keys:
- `SEPOLIA_RPC_URL` — Alchemy/Infura endpoint
- `DEPLOYER_KEY` — pool operator wallet private key
- `MAILBOX_KEY` — mailbox agent wallet private key  
- `OPENAI_API_KEY` — GPT-4o-mini for bid ranking explanations and mailbox decisions
