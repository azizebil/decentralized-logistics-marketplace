import "./styles.css";

import {
  Activity,
  BadgeDollarSign,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  ClockAlert,
  Eraser,
  FolderOpen,
  Gauge,
  Gavel,
  HandCoins,
  KeyRound,
  Landmark,
  LayoutDashboard,
  ListOrdered,
  LoaderCircle,
  PackageCheck,
  PackageOpen,
  PackagePlus,
  Play,
  Plug,
  RadioTower,
  RefreshCw,
  Rocket,
  ScanSearch,
  Search,
  Send,
  ShieldCheck,
  ShieldX,
  Sparkles,
  TimerReset,
  TriangleAlert,
  Truck,
  Undo2,
  UserCheck,
  Users,
  Wallet,
  X,
  createIcons
} from "lucide";
import { ethers } from "ethers";

import DeliveryVaultArtifact from "@artifacts/contracts/DeliveryVault.sol/DeliveryVault.json";
import MarketplaceRegistryArtifact from "@artifacts/contracts/MarketplaceRegistry.sol/MarketplaceRegistry.json";
import StakingPoolArtifact from "@artifacts/contracts/StakingPool.sol/StakingPool.json";

const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
const DEFAULT_RPC = "http://127.0.0.1:8545";
const DAY = 24 * 60 * 60;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const ROLE_DEFS = [
  { id: "deployer", label: "Deployer", index: 0 },
  { id: "operator", label: "Pool Operator", index: 1 },
  { id: "seller", label: "Seller", index: 2 },
  { id: "buyer", label: "Buyer", index: 3 },
  { id: "mailbox", label: "Mailbox", index: 4 },
  { id: "courier1", label: "Courier A", index: 5 },
  { id: "courier2", label: "Courier B", index: 6 },
  { id: "courier3", label: "Courier C", index: 7 },
  { id: "agent", label: "Seller Agent", index: 8 },
  { id: "observer", label: "Keeper", index: 9 }
];

const STAGES = ["None", "Open", "Assigned", "Held", "Finalized", "Cancelled"];
const VAULT_STATES = ["Funded", "PickedUp", "Delivered", "Refunded", "Failed"];
const APP_ICONS = {
  Activity,
  BadgeDollarSign,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  ClockAlert,
  Eraser,
  FolderOpen,
  Gauge,
  Gavel,
  HandCoins,
  KeyRound,
  Landmark,
  LayoutDashboard,
  ListOrdered,
  LoaderCircle,
  PackageCheck,
  PackageOpen,
  PackagePlus,
  Play,
  Plug,
  RadioTower,
  RefreshCw,
  Rocket,
  ScanSearch,
  Search,
  Send,
  ShieldCheck,
  ShieldX,
  Sparkles,
  TimerReset,
  TriangleAlert,
  Truck,
  Undo2,
  UserCheck,
  Users,
  Wallet,
  X
};

const app = document.querySelector("#app");

const state = {
  activeTab: "overview",
  busy: "",
  rpc: localStorage.getItem("dlm.rpc") || DEFAULT_RPC,
  connected: false,
  chainId: null,
  provider: null,
  accounts: {},
  contracts: {},
  deployment: readJson("dlm.deployment", null),
  flow: readJson("dlm.flow", {
    deliveryId: "",
    vault: "",
    pickupCode: "",
    dropoffCode: "",
    nonceP: "",
    nonceD: "",
    winnerIndex: null
  }),
  data: {
    pool: null,
    request: null,
    bids: [],
    vault: null,
    members: [],
    recentRequests: []
  },
  logs: readJson("dlm.logs", []).slice(-40),
  decision: null
};

render();

app.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action], [data-tab], [data-copy]");
  if (!button || state.busy) return;

  if (button.dataset.tab) {
    state.activeTab = button.dataset.tab;
    render();
    return;
  }

  if (button.dataset.copy) {
    await copyToClipboard(button.dataset.copy);
    return;
  }

  const action = button.dataset.action;
  try {
    await runAction(action, button.dataset);
  } catch (error) {
    fail(error);
  }
});

app.addEventListener("submit", (event) => event.preventDefault());

async function runAction(action, dataset) {
  switch (action) {
    case "connect-demo":
      return connectDemo();
    case "attach-deployment":
      return attachDeploymentFromForm();
    case "deploy-demo":
      return deployDemoStack();
    case "refresh":
      return refreshAll({ quiet: false });
    case "open-request":
      return openRequestAndPublishHashes();
    case "set-policy":
      return setAgentPolicyFromForm();
    case "sample-bids":
      return placeSampleBids();
    case "place-bid":
      return placeCustomBid();
    case "rank-bids":
      return rankBids();
    case "accept-agent":
      return acceptBestBidByAgent();
    case "accept-seller":
      return acceptSelectedBidBySeller();
    case "fund-vault":
      return fundVault();
    case "pickup":
      return pickupDelivery();
    case "confirm-delivery":
      return confirmDelivery();
    case "finalize-delivered":
      return finalizeDelivered();
    case "raise-dispute":
      return raiseDispute();
    case "resolve-courier":
      return resolveDispute(true);
    case "resolve-buyer":
      return resolveDispute(false);
    case "cancel-pre-pickup":
      return cancelPrePickup();
    case "pickup-timeout":
      return refundOnPickupTimeout();
    case "dropoff-timeout":
      return slashOnDropoffTimeout();
    case "load-request":
      return loadRequestFromForm();
    case "run-happy-path":
      return runHappyPath();
    case "clear-flow":
      return clearFlow();
    case "withdraw-bid":
      return withdrawBid(Number(dataset.index));
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function render() {
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">CS438 Agentic Payments</p>
          <h1>Decentralized Logistics Marketplace</h1>
        </div>
        <div class="top-actions">
          ${statusBadge(state.connected ? `Chain ${state.chainId ?? "?"}` : "Disconnected", state.connected ? "good" : "warn")}
          ${state.busy ? `<span class="busy"><i data-lucide="loader-circle"></i>${escapeHtml(state.busy)}</span>` : ""}
          <button class="icon-button" data-action="refresh" title="Refresh state" ${disableIfBusy()}>
            <i data-lucide="refresh-cw"></i>
          </button>
        </div>
      </header>

      <main class="workspace">
        <aside class="side">
          ${renderNetworkPanel()}
          ${renderRolesPanel()}
          ${renderPoolPanel()}
        </aside>

        <section class="board">
          ${renderLifecycle()}
          ${renderTabs()}
          <div class="tab-content">
            ${renderTabContent()}
          </div>
        </section>
      </main>
    </div>
  `;

  createIcons({ icons: APP_ICONS });
}

function renderNetworkPanel() {
  const poolAddr = state.deployment?.contracts?.StakingPool || "";
  const registryAddr = state.deployment?.contracts?.MarketplaceRegistry || "";
  return `
    <section class="surface network">
      <div class="section-title">
        <i data-lucide="radio-tower"></i>
        <h2>Network</h2>
      </div>
      <label class="field">
        <span>RPC endpoint</span>
        <input id="rpcInput" value="${escapeAttr(state.rpc)}" placeholder="${DEFAULT_RPC}" />
      </label>
      <div class="button-row">
        <button data-action="connect-demo" ${disableIfBusy()}><i data-lucide="wallet"></i> Demo accounts</button>
        <button data-action="deploy-demo" class="primary" ${disableIfBusy()}><i data-lucide="rocket"></i> Deploy stack</button>
      </div>
      <div class="attach-grid">
        <label class="field compact">
          <span>Registry</span>
          <input id="registryInput" value="${escapeAttr(registryAddr)}" placeholder="0x..." />
        </label>
        <label class="field compact">
          <span>Pool</span>
          <input id="poolInput" value="${escapeAttr(poolAddr)}" placeholder="0x..." />
        </label>
      </div>
      <button class="secondary full" data-action="attach-deployment" ${disableIfBusy()}>
        <i data-lucide="plug"></i> Attach addresses
      </button>
      ${state.deployment ? `
        <div class="address-stack">
          ${addressLine("Registry", registryAddr)}
          ${addressLine("Pool", poolAddr)}
        </div>
      ` : `<p class="muted tight">Start a local Hardhat node, then deploy or attach contract addresses.</p>`}
    </section>
  `;
}

function renderRolesPanel() {
  return `
    <section class="surface">
      <div class="section-title">
        <i data-lucide="users"></i>
        <h2>Roles</h2>
      </div>
      <div class="role-list">
        ${ROLE_DEFS.map((role) => {
          const wallet = state.accounts[role.id];
          const address = wallet?.address || "";
          return `
            <div class="role-row">
              <span>${role.label}</span>
              <button class="linklike" data-copy="${address}" title="Copy ${role.label}">
                ${address ? shortAddress(address) : `idx:${role.index}`}
              </button>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderPoolPanel() {
  const pool = state.data.pool;
  const members = state.data.members || [];
  return `
    <section class="surface">
      <div class="section-title">
        <i data-lucide="shield-check"></i>
        <h2>Staking Pool</h2>
      </div>
      <div class="metric-grid">
        ${metric("Total stake", pool ? `${formatEth(pool.totalStake)} ETH` : "-")}
        ${metric("Active value", pool ? `${formatEth(pool.activeValue)} ETH` : "-")}
        ${metric("Member cap", pool ? `${Number(pool.memberCapBps) / 100}%` : "-")}
        ${metric("Withdrawal delay", pool ? secondsToDuration(Number(pool.withdrawalDelay)) : "-")}
      </div>
      <div class="mini-table">
        ${members.length ? members.map((member) => `
          <div class="mini-row">
            <span>${member.label}</span>
            <strong>${formatEth(member.contribution)} ETH</strong>
            <small>${formatEth(member.freeCapacity)} cap</small>
          </div>
        `).join("") : `<p class="muted tight">Deploy the demo stack to admit and stake couriers.</p>`}
      </div>
    </section>
  `;
}

function renderLifecycle() {
  const request = state.data.request;
  const vault = state.data.vault;
  const requestStage = request ? STAGES[Number(request.stage)] : "Draft";
  const vaultStage = vault ? VAULT_STATES[Number(vault.state)] : "No vault";

  const steps = [
    { label: "Request", active: !!state.flow.deliveryId, meta: requestStage },
    { label: "Bids", active: state.data.bids.length > 0, meta: `${state.data.bids.length} placed` },
    { label: "Agent", active: state.flow.winnerIndex !== null, meta: state.flow.winnerIndex !== null ? `winner #${state.flow.winnerIndex}` : "ranking" },
    { label: "Vault", active: !!state.flow.vault, meta: vaultStage },
    { label: "Payment", active: !!vault?.isFinalized, meta: vault?.isFinalized ? "finalized" : "pending" }
  ];

  return `
    <section class="surface lifecycle">
      <div>
        <p class="eyebrow">Live Flow</p>
        <h2>${state.flow.deliveryId ? shortHash(state.flow.deliveryId) : "No delivery loaded"}</h2>
      </div>
      <div class="steps">
        ${steps.map((step, index) => `
          <div class="step ${step.active ? "active" : ""}">
            <span>${index + 1}</span>
            <strong>${step.label}</strong>
            <small>${step.meta}</small>
          </div>
        `).join("")}
      </div>
      <button class="primary run" data-action="run-happy-path" ${disableIfBusy()}>
        <i data-lucide="play"></i> Run happy path
      </button>
    </section>
  `;
}

function renderTabs() {
  const tabs = [
    ["overview", "Overview", "layout-dashboard"],
    ["seller", "Seller", "package-plus"],
    ["courier", "Courier", "truck"],
    ["vault", "Vault", "landmark"],
    ["events", "Events", "activity"]
  ];

  return `
    <nav class="tabs" aria-label="Frontend sections">
      ${tabs.map(([id, label, icon]) => `
        <button class="${state.activeTab === id ? "active" : ""}" data-tab="${id}">
          <i data-lucide="${icon}"></i>${label}
        </button>
      `).join("")}
    </nav>
  `;
}

function renderTabContent() {
  switch (state.activeTab) {
    case "seller":
      return renderSellerTab();
    case "courier":
      return renderCourierTab();
    case "vault":
      return renderVaultTab();
    case "events":
      return renderEventsTab();
    case "overview":
    default:
      return renderOverviewTab();
  }
}

function renderOverviewTab() {
  const request = state.data.request;
  return `
    <section class="surface">
      <div class="section-title">
        <i data-lucide="scan-search"></i>
        <h2>Project Demo State</h2>
      </div>
      <div class="summary-grid">
        ${metric("Delivery ID", state.flow.deliveryId ? shortHash(state.flow.deliveryId) : "-")}
        ${metric("Request stage", request ? STAGES[Number(request.stage)] : "-")}
        ${metric("Vault", state.flow.vault ? shortAddress(state.flow.vault) : "-")}
        ${metric("Winner", state.flow.winnerIndex !== null ? `Bid #${state.flow.winnerIndex}` : "-")}
      </div>
      ${renderRequestSummary()}
      ${renderBidsTable()}
      ${renderDecision()}
    </section>
  `;
}

function renderSellerTab() {
  const seller = state.accounts.seller?.address || "";
  const buyer = state.accounts.buyer?.address || "";
  const mailbox = state.accounts.mailbox?.address || "";
  const agent = state.accounts.agent?.address || "";
  return `
    <div class="form-grid">
      <section class="surface">
        <div class="section-title">
          <i data-lucide="package-plus"></i>
          <h2>Open Delivery Request</h2>
        </div>
        <form class="stacked-form">
          <div class="input-grid">
            ${inputField("declaredValue", "Declared value (ETH)", "1.0")}
            ${inputField("maxPrice", "Max courier fee (ETH)", "0.15")}
            ${inputField("bidWindow", "Bid window (minutes)", "120")}
            ${inputField("maxDeadline", "Delivery deadline (hours)", "48")}
            ${inputField("disputeWindow", "Dispute window (minutes)", "30")}
            ${inputField("salt", "Salt", String(Date.now()).slice(-6))}
          </div>
          <div class="input-grid two">
            ${inputField("buyerAddr", "Buyer", buyer)}
            ${inputField("mailboxAddr", "Mailbox", mailbox)}
          </div>
          <div class="input-grid two">
            ${inputField("pickupCode", "Pickup code", randomCode("PICKUP"))}
            ${inputField("dropoffCode", "Dropoff code", randomCode("DROP"))}
          </div>
          <label class="toggle-row">
            <input id="preferTrusted" type="checkbox" checked />
            <span>Prefer trusted couriers</span>
          </label>
          <div class="button-row">
            <button class="primary" data-action="open-request" ${disableIfBusy()}>
              <i data-lucide="send"></i> Open and lock hashes
            </button>
            <button class="secondary" data-action="clear-flow" ${disableIfBusy()}>
              <i data-lucide="eraser"></i> Clear loaded flow
            </button>
          </div>
        </form>
      </section>

      <section class="surface">
        <div class="section-title">
          <i data-lucide="bot"></i>
          <h2>Session-Key Policy</h2>
        </div>
        <form class="stacked-form">
          <div class="input-grid">
            ${inputField("policyAgent", "Agent address", agent)}
            ${inputField("policyMaxPrice", "Agent max fee (ETH)", "0.20")}
            ${inputField("policyBuffer", "Deadline buffer (hours)", "12")}
            ${inputField("policyThreshold", "Co-sign threshold (ETH)", "2.0")}
          </div>
          <button class="primary" data-action="set-policy" ${disableIfBusy()}>
            <i data-lucide="key-round"></i> Save policy
          </button>
        </form>
        ${renderDecision()}
        <div class="button-row">
          <button data-action="rank-bids" ${disableIfBusy()}>
            <i data-lucide="list-ordered"></i> Rank bids
          </button>
          <button class="primary" data-action="accept-agent" ${disableIfBusy()}>
            <i data-lucide="bot"></i> Agent accept best
          </button>
          <button class="secondary" data-action="accept-seller" ${disableIfBusy()}>
            <i data-lucide="user-check"></i> Seller accept selected
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderCourierTab() {
  return `
    <div class="form-grid">
      <section class="surface">
        <div class="section-title">
          <i data-lucide="truck"></i>
          <h2>Courier Bids</h2>
        </div>
        <div class="button-row">
          <button class="primary" data-action="sample-bids" ${disableIfBusy()}>
            <i data-lucide="sparkles"></i> Place sample bids
          </button>
          <button data-action="rank-bids" ${disableIfBusy()}>
            <i data-lucide="list-ordered"></i> Rank current bids
          </button>
        </div>
        <form class="stacked-form">
          <div class="input-grid">
            <label class="field">
              <span>Courier</span>
              <select id="bidCourier">
                <option value="courier1">Courier A</option>
                <option value="courier2">Courier B</option>
                <option value="courier3">Courier C</option>
              </select>
            </label>
            ${inputField("bidPrice", "Fee (ETH)", "0.09")}
            ${inputField("bidEta", "Promised time (hours)", "10")}
            ${inputField("bidRep", "Reputation (%)", "82")}
          </div>
          <button class="primary" data-action="place-bid" ${disableIfBusy()}>
            <i data-lucide="badge-dollar-sign"></i> Place bid
          </button>
        </form>
      </section>

      <section class="surface">
        <div class="section-title">
          <i data-lucide="gauge"></i>
          <h2>Bid Book</h2>
        </div>
        ${renderBidsTable(true)}
      </section>
    </div>
  `;
}

function renderVaultTab() {
  const vault = state.data.vault;
  return `
    <div class="form-grid">
      <section class="surface">
        <div class="section-title">
          <i data-lucide="landmark"></i>
          <h2>Delivery Vault</h2>
        </div>
        ${renderVaultSummary()}
        <div class="button-grid">
          <button class="primary" data-action="fund-vault" ${disableIfBusy()}>
            <i data-lucide="circle-dollar-sign"></i> Buyer fund
          </button>
          <button data-action="pickup" ${disableIfBusy()}>
            <i data-lucide="package-open"></i> Courier pickup
          </button>
          <button data-action="confirm-delivery" ${disableIfBusy()}>
            <i data-lucide="package-check"></i> Mailbox confirm
          </button>
          <button data-action="finalize-delivered" ${disableIfBusy()}>
            <i data-lucide="check-circle-2"></i> Finalize window
          </button>
        </div>
        <div class="button-grid secondary-actions">
          <button class="secondary" data-action="raise-dispute" ${disableIfBusy()}>
            <i data-lucide="triangle-alert"></i> Raise dispute
          </button>
          <button class="secondary" data-action="resolve-courier" ${disableIfBusy()}>
            <i data-lucide="gavel"></i> Resolve courier
          </button>
          <button class="secondary" data-action="resolve-buyer" ${disableIfBusy()}>
            <i data-lucide="hand-coins"></i> Resolve buyer
          </button>
          <button class="secondary" data-action="cancel-pre-pickup" ${disableIfBusy()}>
            <i data-lucide="undo-2"></i> Buyer cancel
          </button>
        </div>
      </section>

      <section class="surface">
        <div class="section-title">
          <i data-lucide="timer-reset"></i>
          <h2>Timeout Recovery</h2>
        </div>
        <div class="button-grid">
          <button data-action="pickup-timeout" ${disableIfBusy()}>
            <i data-lucide="clock-alert"></i> Pickup timeout refund
          </button>
          <button data-action="dropoff-timeout" ${disableIfBusy()}>
            <i data-lucide="shield-x"></i> Dropoff timeout slash
          </button>
        </div>
        <div class="code-box">
          <div>
            <span>Pickup code</span>
            <button class="linklike" data-copy="${escapeAttr(state.flow.pickupCode)}">${escapeHtml(state.flow.pickupCode || "-")}</button>
          </div>
          <div>
            <span>Dropoff code</span>
            <button class="linklike" data-copy="${escapeAttr(state.flow.dropoffCode)}">${escapeHtml(state.flow.dropoffCode || "-")}</button>
          </div>
          <div>
            <span>Pickup nonce</span>
            <button class="linklike mono" data-copy="${escapeAttr(state.flow.nonceP)}">${state.flow.nonceP ? shortHash(state.flow.nonceP) : "-"}</button>
          </div>
          <div>
            <span>Dropoff nonce</span>
            <button class="linklike mono" data-copy="${escapeAttr(state.flow.nonceD)}">${state.flow.nonceD ? shortHash(state.flow.nonceD) : "-"}</button>
          </div>
        </div>
        ${vault?.isDisputed ? `<p class="alert-line">Dispute is active. The pool operator must resolve it.</p>` : ""}
      </section>
    </div>
  `;
}

function renderEventsTab() {
  return `
    <div class="form-grid">
      <section class="surface">
        <div class="section-title">
          <i data-lucide="search"></i>
          <h2>Load Delivery</h2>
        </div>
        <form class="stacked-form">
          ${inputField("loadDeliveryId", "Delivery ID", state.flow.deliveryId)}
          <button class="primary" data-action="load-request" ${disableIfBusy()}>
            <i data-lucide="folder-open"></i> Load request
          </button>
        </form>
        <div class="recent-list">
          ${(state.data.recentRequests || []).map((item) => `
            <button class="recent-item" data-copy="${item.id}" title="Copy delivery id">
              <span>${shortHash(item.id)}</span>
              <small>${shortAddress(item.seller)} / ${formatEth(item.declaredValue)} ETH</small>
            </button>
          `).join("") || `<p class="muted tight">No recent RequestOpened events loaded yet.</p>`}
        </div>
      </section>

      <section class="surface">
        <div class="section-title">
          <i data-lucide="activity"></i>
          <h2>Activity</h2>
        </div>
        <div class="log-list">
          ${state.logs.length ? [...state.logs].reverse().map((entry) => `
            <div class="log-row ${entry.kind || ""}">
              <span>${entry.time}</span>
              <strong>${escapeHtml(entry.title)}</strong>
              <small>${escapeHtml(entry.detail || "")}</small>
            </div>
          `).join("") : `<p class="muted tight">Actions and transaction receipts will appear here.</p>`}
        </div>
      </section>
    </div>
  `;
}

function renderRequestSummary() {
  const request = state.data.request;
  if (!request) {
    return `<p class="muted">Open a delivery request or load an existing delivery ID.</p>`;
  }

  return `
    <div class="detail-grid">
      ${detail("Seller", addressButton(request.seller))}
      ${detail("Buyer", addressButton(request.buyer))}
      ${detail("Mailbox", addressButton(request.mailbox))}
      ${detail("Pool", addressButton(request.pool))}
      ${detail("Declared value", `${formatEth(request.declaredValue)} ETH`)}
      ${detail("Max fee", `${formatEth(request.maxPrice)} ETH`)}
      ${detail("Bid deadline", formatTime(Number(request.bidDeadline)))}
      ${detail("Delivery deadline", formatTime(Number(request.maxDeadline)))}
      ${detail("Trusted preference", request.preferTrusted ? "On" : "Off")}
      ${detail("Dispute window", secondsToDuration(Number(request.disputeWindow)))}
      ${detail("Pickup hash", request.pickupHash ? shortHash(request.pickupHash) : "-")}
      ${detail("Dropoff hash", request.dropoffHash ? shortHash(request.dropoffHash) : "-")}
    </div>
  `;
}

function renderBidsTable(withActions = false) {
  const bids = state.data.bids || [];
  if (!bids.length) {
    return `<p class="muted">No bids yet.</p>`;
  }

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Courier</th>
            <th>Fee</th>
            <th>Promise</th>
            <th>Rep</th>
            <th>Status</th>
            ${withActions ? "<th></th>" : ""}
          </tr>
        </thead>
        <tbody>
          ${bids.map((bid, index) => `
            <tr class="${state.flow.winnerIndex === index ? "winner" : ""}">
              <td>${index}</td>
              <td>${shortAddress(bid.courier)}</td>
              <td>${formatEth(bid.price)} ETH</td>
              <td>${formatTime(Number(bid.promisedTime))}</td>
              <td>${Number(bid.reputationE4) / 100}%</td>
              <td>${bid.withdrawn ? statusBadge("Withdrawn", "bad") : statusBadge("Active", "good")}</td>
              ${withActions ? `<td><button class="mini-button" data-action="withdraw-bid" data-index="${index}" ${disableIfBusy()}><i data-lucide="x"></i></button></td>` : ""}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderDecision() {
  if (!state.decision) return "";

  return `
    <div class="decision">
      <div class="decision-head">
        <strong>Deterministic seller-agent ranking</strong>
        ${state.decision.winnerIndex >= 0 ? statusBadge(`Winner #${state.decision.winnerIndex}`, "good") : statusBadge("No eligible bid", "bad")}
      </div>
      <div class="rank-list">
        ${state.decision.scored.map((item) => `
          <div class="rank-row ${item.index === state.decision.winnerIndex ? "top" : ""}">
            <span>#${item.index}</span>
            <strong>${Number.isFinite(item.score) ? item.score.toExponential(3) : "filtered"}</strong>
            <small>${escapeHtml(item.reason)}</small>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderVaultSummary() {
  const vault = state.data.vault;
  if (!state.flow.vault) {
    return `<p class="muted">Accept a bid to deploy a delivery vault.</p>`;
  }
  if (!vault) {
    return `
      <div class="detail-grid">
        ${detail("Vault", addressButton(state.flow.vault))}
      </div>
    `;
  }

  return `
    <div class="summary-grid">
      ${metric("State", VAULT_STATES[Number(vault.state)])}
      ${metric("Funded", vault.isFunded ? "Yes" : "No")}
      ${metric("Finalized", vault.isFinalized ? "Yes" : "No")}
      ${metric("Balance", `${formatEth(vault.balance)} ETH`)}
    </div>
    <div class="detail-grid">
      ${detail("Vault", addressButton(state.flow.vault))}
      ${detail("Courier", addressButton(vault.courier))}
      ${detail("Courier fee", `${formatEth(vault.courierFee)} ETH`)}
      ${detail("Declared value", `${formatEth(vault.declaredValue)} ETH`)}
      ${detail("Pickup deadline", formatTime(Number(vault.pickupDeadline)))}
      ${detail("Dropoff deadline", formatTime(Number(vault.dropoffDeadline)))}
      ${detail("Dispute window", secondsToDuration(Number(vault.disputeWindow)))}
      ${detail("Delivered at", Number(vault.deliveredAt) ? formatTime(Number(vault.deliveredAt)) : "-")}
    </div>
  `;
}

async function connectDemo() {
  setBusy("Connecting");
  try {
    const rpcInput = getInput("rpcInput", state.rpc);
    state.rpc = rpcInput || DEFAULT_RPC;
    localStorage.setItem("dlm.rpc", state.rpc);

    state.provider = new ethers.JsonRpcProvider(state.rpc);
    const network = await state.provider.getNetwork();
    state.chainId = Number(network.chainId);

    state.accounts = {};
    for (const role of ROLE_DEFS) {
      state.accounts[role.id] = ethers.HDNodeWallet
        .fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${role.index}`)
        .connect(state.provider);
    }

    state.connected = true;
    attachContracts();
    log("Demo accounts ready", `Connected to ${state.rpc}`, "good");
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function attachDeploymentFromForm() {
  setBusy("Attaching");
  try {
    await ensureConnected();
    const registry = getInput("registryInput");
    const pool = getInput("poolInput");
    if (!ethers.isAddress(registry) || !ethers.isAddress(pool)) {
      throw new Error("Registry and pool must be valid addresses.");
    }

    state.deployment = {
      network: "local",
      chainId: state.chainId,
      contracts: {
        MarketplaceRegistry: registry,
        StakingPool: pool
      },
      attachedAt: new Date().toISOString()
    };
    persist();
    attachContracts();
    log("Contracts attached", `${shortAddress(registry)} / ${shortAddress(pool)}`, "good");
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function deployDemoStack() {
  setBusy("Deploying contracts");
  try {
    await ensureConnected();
    const { deployer, operator, seller, agent, courier1, courier2, courier3 } = requiredAccounts();

    const PoolFactory = new ethers.ContractFactory(
      StakingPoolArtifact.abi,
      StakingPoolArtifact.bytecode,
      deployer
    );
    const pool = await PoolFactory.deploy(operator.address, DAY, 20000);
    await pool.waitForDeployment();

    const RegistryFactory = new ethers.ContractFactory(
      MarketplaceRegistryArtifact.abi,
      MarketplaceRegistryArtifact.bytecode,
      deployer
    );
    const registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const poolAddr = await pool.getAddress();
    const registryAddr = await registry.getAddress();

    await waitTx(pool.connect(operator).setFactory(registryAddr), "Factory set");

    for (const courier of [courier1, courier2, courier3]) {
      await waitTx(pool.connect(operator).admitMember(courier.address), `Admitted ${shortAddress(courier.address)}`);
      await waitTx(pool.connect(courier).depositStake({ value: ethers.parseEther("3") }), `Staked ${shortAddress(courier.address)}`);
    }

    await waitTx(
      registry.connect(seller).setAgentPolicy(agent.address, ethers.parseEther("0.2"), 12 * 3600, ethers.parseEther("2")),
      "Agent policy set"
    );

    state.deployment = {
      network: "localhost",
      chainId: state.chainId,
      contracts: {
        StakingPool: poolAddr,
        MarketplaceRegistry: registryAddr
      },
      operator: operator.address,
      deployer: deployer.address,
      deployedAt: new Date().toISOString()
    };
    persist();
    attachContracts();
    log("Demo stack deployed", `Registry ${shortAddress(registryAddr)}`, "good");
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function openRequestAndPublishHashes() {
  setBusy("Opening request");
  try {
    await ensureContracts();
    const { seller, buyer, mailbox } = requiredAccounts();
    const registry = state.contracts.registry.connect(seller);
    const poolAddr = state.deployment.contracts.StakingPool;
    const latest = await state.provider.getBlock("latest");
    const now = latest.timestamp;

    const declaredValue = ethers.parseEther(getInput("declaredValue", "1.0"));
    const maxPrice = ethers.parseEther(getInput("maxPrice", "0.15"));
    const bidDeadline = now + Math.max(1, Number(getInput("bidWindow", "120"))) * 60;
    const maxDeadline = now + Math.max(1, Number(getInput("maxDeadline", "48"))) * 3600;
    const disputeWindow = Math.max(0, Number(getInput("disputeWindow", "30"))) * 60;
    const buyerAddr = getInput("buyerAddr", buyer.address);
    const mailboxAddr = getInput("mailboxAddr", mailbox.address);
    const salt = BigInt(getInput("salt", String(Date.now())).replace(/\D/g, "") || "1");
    const preferTrusted = document.querySelector("#preferTrusted")?.checked ?? true;

    if (bidDeadline >= maxDeadline) {
      throw new Error("Bid deadline must be earlier than the delivery deadline.");
    }

    const tx = await registry.openRequest(
      declaredValue,
      maxPrice,
      maxDeadline,
      bidDeadline,
      buyerAddr,
      mailboxAddr,
      poolAddr,
      preferTrusted,
      disputeWindow,
      salt
    );
    const receipt = await tx.wait();
    const event = parseEvent(receipt, state.contracts.registry.interface, "RequestOpened");
    const deliveryId = event?.args?.deliveryId;
    if (!deliveryId) throw new Error("Could not find RequestOpened event.");

    const pickupCode = getInput("pickupCode", randomCode("PICKUP"));
    const dropoffCode = getInput("dropoffCode", randomCode("DROP"));
    const nonceP = ethers.id(`pickup:${deliveryId}:${Date.now()}`);
    const nonceD = ethers.id(`dropoff:${deliveryId}:${Date.now()}`);
    const pickupHash = makeCodeHash(pickupCode, deliveryId, nonceP);
    const dropoffHash = makeCodeHash(dropoffCode, deliveryId, nonceD);

    await waitTx(registry.publishHashes(deliveryId, pickupHash, dropoffHash), "Hashes locked");

    state.flow = {
      deliveryId,
      vault: "",
      pickupCode,
      dropoffCode,
      nonceP,
      nonceD,
      winnerIndex: null
    };
    state.decision = null;
    persist();
    log("Delivery opened", shortHash(deliveryId), "good");
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function setAgentPolicyFromForm() {
  setBusy("Saving policy");
  try {
    await ensureContracts();
    const { seller, agent } = requiredAccounts();
    const agentAddr = getInput("policyAgent", agent.address);
    const maxPrice = ethers.parseEther(getInput("policyMaxPrice", "0.2"));
    const buffer = Math.max(0, Number(getInput("policyBuffer", "12"))) * 3600;
    const threshold = ethers.parseEther(getInput("policyThreshold", "2.0"));

    await waitTx(
      state.contracts.registry.connect(seller).setAgentPolicy(agentAddr, maxPrice, buffer, threshold),
      "Agent policy set"
    );
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function placeSampleBids() {
  setBusy("Placing bids");
  try {
    await ensureOpenRequest();
    const { courier1, courier2, courier3 } = requiredAccounts();
    const registry = state.contracts.registry;
    const latest = await state.provider.getBlock("latest");
    const now = latest.timestamp;

    const bids = [
      [courier1, "0.08", now + 6 * 3600, 6000],
      [courier2, "0.10", now + 12 * 3600, 8500],
      [courier3, "0.14", now + 8 * 3600, 9500]
    ];

    for (const [courier, price, promisedTime, rep] of bids) {
      await waitTx(
        registry.connect(courier).placeBid(
          state.flow.deliveryId,
          courier.address,
          ethers.parseEther(price),
          promisedTime,
          rep
        ),
        `Bid ${price} ETH`
      );
    }
    await refreshAll({ quiet: true });
    await rankBids({ silent: true });
  } finally {
    clearBusy();
  }
}

async function placeCustomBid() {
  setBusy("Placing bid");
  try {
    await ensureOpenRequest();
    const role = document.querySelector("#bidCourier")?.value || "courier1";
    const courier = state.accounts[role];
    if (!courier) throw new Error("Connect demo accounts first.");

    const latest = await state.provider.getBlock("latest");
    const promisedTime = latest.timestamp + Math.max(1, Number(getInput("bidEta", "10"))) * 3600;
    const reputationE4 = Math.max(0, Math.min(10000, Math.round(Number(getInput("bidRep", "82")) * 100)));
    const price = ethers.parseEther(getInput("bidPrice", "0.09"));

    await waitTx(
      state.contracts.registry.connect(courier).placeBid(
        state.flow.deliveryId,
        courier.address,
        price,
        promisedTime,
        reputationE4
      ),
      "Bid placed"
    );
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function rankBids(options = {}) {
  if (!options.silent) setBusy("Ranking bids");
  try {
    await ensureRequestLoaded();
    const latest = await state.provider.getBlock("latest");
    const now = latest.timestamp;
    const request = state.data.request;
    const scored = [];

    for (let index = 0; index < state.data.bids.length; index += 1) {
      const bid = state.data.bids[index];
      const price = BigInt(bid.price);
      const promisedTime = Number(bid.promisedTime);
      const reputation = Number(bid.reputationE4) / 10000;
      const priceEth = Number(ethers.formatEther(price));
      const hours = Math.max((promisedTime - now) / 3600, 1 / 3600);

      if (bid.withdrawn) {
        scored.push({ index, score: -Infinity, reason: "withdrawn" });
        continue;
      }
      if (price > BigInt(request.maxPrice)) {
        scored.push({ index, score: -Infinity, reason: "price above seller budget" });
        continue;
      }
      if (promisedTime > Number(request.maxDeadline)) {
        scored.push({ index, score: -Infinity, reason: "promise misses delivery deadline" });
        continue;
      }
      if (promisedTime <= now) {
        scored.push({ index, score: -Infinity, reason: "promise is in the past" });
        continue;
      }

      const alpha = request.preferTrusted ? 1.5 : 0;
      const repFactor = request.preferTrusted ? Math.pow(Math.max(reputation, 1e-6), alpha) : 1;
      const score = repFactor / (hours * priceEth);
      scored.push({
        index,
        score,
        reason: request.preferTrusted
          ? `trusted score: rep^${alpha} / (hours * price)`
          : "price/time score: 1 / (hours * price)"
      });
    }

    let winnerIndex = -1;
    let best = -Infinity;
    for (const item of scored) {
      if (item.score > best) {
        best = item.score;
        winnerIndex = item.index;
      }
    }

    state.decision = { winnerIndex, scored };
    state.flow.winnerIndex = winnerIndex >= 0 ? winnerIndex : null;
    persist();
    if (!options.silent) log("Bids ranked", winnerIndex >= 0 ? `Winner #${winnerIndex}` : "No eligible bid", winnerIndex >= 0 ? "good" : "bad");
    render();
  } finally {
    if (!options.silent) clearBusy();
  }
}

async function acceptBestBidByAgent() {
  setBusy("Agent accepting");
  try {
    await ensureRequestLoaded();
    if (!state.decision) await rankBids({ silent: true });
    const index = state.decision?.winnerIndex;
    if (index === undefined || index < 0) throw new Error("No eligible bid to accept.");

    const { agent } = requiredAccounts();
    const tx = await state.contracts.registry.connect(agent).acceptBidByAgent(state.flow.deliveryId, index);
    const receipt = await tx.wait();
    captureAcceptedVault(receipt);
    log("Agent accepted bid", `Bid #${index}`, "good");
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function acceptSelectedBidBySeller() {
  setBusy("Seller accepting");
  try {
    await ensureRequestLoaded();
    if (!state.decision) await rankBids({ silent: true });
    const index = state.decision?.winnerIndex;
    if (index === undefined || index < 0) throw new Error("No eligible bid to accept.");

    const { seller } = requiredAccounts();
    const tx = await state.contracts.registry.connect(seller).acceptBid(state.flow.deliveryId, index);
    const receipt = await tx.wait();
    captureAcceptedVault(receipt);
    log("Seller accepted bid", `Bid #${index}`, "good");
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function fundVault() {
  setBusy("Funding vault");
  try {
    await ensureVaultLoaded();
    const { buyer } = requiredAccounts();
    const vault = getVaultContract().connect(buyer);
    const fee = state.data.vault?.courierFee || await vault.courierFee();
    await waitTx(vault.fund({ value: fee }), `Funded ${formatEth(fee)} ETH`);
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function pickupDelivery() {
  setBusy("Recording pickup");
  try {
    await ensureVaultLoaded();
    const pickupCode = state.flow.pickupCode;
    const nonceP = state.flow.nonceP;
    if (!pickupCode || !nonceP) throw new Error("Pickup code and nonce are missing for this loaded flow.");

    const courier = signerForAddress(state.data.vault.courier);
    if (!courier) throw new Error("Winning courier is not one of the connected demo accounts.");

    await waitTx(
      getVaultContract().connect(courier).pickup(ethers.toUtf8Bytes(pickupCode), nonceP),
      "Pickup recorded"
    );
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function confirmDelivery() {
  setBusy("Confirming delivery");
  try {
    await ensureVaultLoaded();
    const dropoffCode = state.flow.dropoffCode;
    const nonceD = state.flow.nonceD;
    if (!dropoffCode || !nonceD) throw new Error("Dropoff code and nonce are missing for this loaded flow.");

    const { mailbox } = requiredAccounts();
    await waitTx(
      getVaultContract().connect(mailbox).confirmDelivery(ethers.toUtf8Bytes(dropoffCode), nonceD),
      "Delivery confirmed"
    );
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function finalizeDelivered() {
  setBusy("Finalizing");
  try {
    await ensureVaultLoaded();
    const { observer } = requiredAccounts();
    const vault = getVaultContract().connect(observer);
    const disputeWindow = Number(await vault.disputeWindow());
    if (disputeWindow > 0) {
      await advancePast(await vault.deliveredAt(), disputeWindow + 5);
    }
    await waitTx(vault.finalizeDelivered(), "Delivery finalized");
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function raiseDispute() {
  setBusy("Raising dispute");
  try {
    await ensureVaultLoaded();
    const { buyer } = requiredAccounts();
    await waitTx(getVaultContract().connect(buyer).raiseDispute(), "Dispute raised");
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function resolveDispute(inFavorOfCourier) {
  setBusy("Resolving dispute");
  try {
    await ensureVaultLoaded();
    const { operator } = requiredAccounts();
    await waitTx(
      getVaultContract().connect(operator).resolveDispute(inFavorOfCourier),
      inFavorOfCourier ? "Resolved for courier" : "Resolved for buyer"
    );
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function cancelPrePickup() {
  setBusy("Cancelling");
  try {
    await ensureVaultLoaded();
    const { buyer } = requiredAccounts();
    await waitTx(getVaultContract().connect(buyer).cancelByBuyerPrePickup(), "Buyer cancelled");
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function refundOnPickupTimeout() {
  setBusy("Applying pickup timeout");
  try {
    await ensureVaultLoaded();
    const { observer } = requiredAccounts();
    await advancePast(await getVaultContract().pickupDeadline(), 5);
    await waitTx(getVaultContract().connect(observer).refundOnPickupTimeout(), "Pickup timeout refunded");
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function slashOnDropoffTimeout() {
  setBusy("Applying dropoff timeout");
  try {
    await ensureVaultLoaded();
    const { observer } = requiredAccounts();
    await advancePast(await getVaultContract().dropoffDeadline(), 5);
    await waitTx(getVaultContract().connect(observer).slashOnDropoffTimeout(), "Dropoff timeout slashed");
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function withdrawBid(index) {
  setBusy("Withdrawing bid");
  try {
    await ensureOpenRequest();
    const bid = state.data.bids[index];
    const courier = signerForAddress(bid.courier);
    if (!courier) throw new Error("This bid was not made by a connected demo courier.");
    await waitTx(state.contracts.registry.connect(courier).withdrawBid(state.flow.deliveryId, index), "Bid withdrawn");
    await refreshAll({ quiet: true });
  } finally {
    clearBusy();
  }
}

async function loadRequestFromForm() {
  setBusy("Loading request");
  try {
    await ensureContracts();
    const deliveryId = getInput("loadDeliveryId");
    if (!deliveryId || !ethers.isHexString(deliveryId, 32)) {
      throw new Error("Delivery ID must be a bytes32 value.");
    }
    state.flow.deliveryId = deliveryId;
    state.flow.vault = "";
    state.flow.winnerIndex = null;
    state.decision = null;
    persist();
    await refreshAll({ quiet: true });
    log("Delivery loaded", shortHash(deliveryId), "good");
  } finally {
    clearBusy();
  }
}

async function runHappyPath() {
  setBusy("Running happy path");
  try {
    if (!state.connected) {
      await connectDemo();
    }
    if (!state.contracts.registry) {
      await deployDemoStack();
    }
    if (!state.flow.deliveryId) {
      await openRequestAndPublishHashes();
    }
    await refreshAll({ quiet: true });
    if (!state.data.bids.length) {
      await placeSampleBids();
    }
    await rankBids({ silent: true });
    await refreshAll({ quiet: true });
    if (!state.flow.vault) {
      await acceptBestBidByAgent();
    }
    await refreshAll({ quiet: true });
    if (state.data.vault && !state.data.vault.isFunded) {
      await fundVault();
    }
    await refreshAll({ quiet: true });
    if (state.data.vault && Number(state.data.vault.state) === 0) {
      await pickupDelivery();
    }
    await refreshAll({ quiet: true });
    if (state.data.vault && Number(state.data.vault.state) === 1) {
      await confirmDelivery();
    }
    await refreshAll({ quiet: true });
    if (state.data.vault && Number(state.data.vault.state) === 2 && !state.data.vault.isFinalized) {
      await finalizeDelivered();
    }
    log("Happy path complete", "Request, bid, accept, fund, pickup, confirm, finalize", "good");
  } finally {
    clearBusy();
  }
}

function clearFlow() {
  state.flow = {
    deliveryId: "",
    vault: "",
    pickupCode: "",
    dropoffCode: "",
    nonceP: "",
    nonceD: "",
    winnerIndex: null
  };
  state.data.request = null;
  state.data.bids = [];
  state.data.vault = null;
  state.decision = null;
  persist();
  log("Flow cleared", "Deployment remains attached", "good");
  render();
}

async function refreshAll({ quiet = false } = {}) {
  if (!quiet) setBusy("Refreshing");
  try {
    if (!state.connected || !state.provider) return render();

    const network = await state.provider.getNetwork();
    state.chainId = Number(network.chainId);

    if (state.deployment) attachContracts();

    if (state.contracts.pool) {
      const pool = state.contracts.pool;
      state.data.pool = {
        totalStake: await pool.totalStake(),
        activeValue: await pool.activeValue(),
        memberCapBps: await pool.memberCapBps(),
        withdrawalDelay: await pool.withdrawalDelay(),
        operator: await pool.operator(),
        factory: await pool.factory()
      };

      state.data.members = [];
      for (const role of ROLE_DEFS.filter((item) => item.id.startsWith("courier"))) {
        const wallet = state.accounts[role.id];
        if (!wallet) continue;
        const member = await pool.members(wallet.address);
        const freeCapacity = await pool.freeCapacityFor(wallet.address);
        state.data.members.push({
          label: role.label,
          address: wallet.address,
          isMember: member.isMember,
          contribution: member.contribution,
          reserved: member.reserved,
          freeCapacity
        });
      }
    }

    if (state.contracts.registry) {
      await loadRecentRequests();
      if (state.flow.deliveryId) {
        const request = await state.contracts.registry.getRequest(state.flow.deliveryId);
        state.data.request = request;
        state.data.bids = await state.contracts.registry.getBids(state.flow.deliveryId);
        if (request.vault && request.vault !== ZERO_ADDRESS) {
          state.flow.vault = request.vault;
        }
      }
    }

    if (state.flow.vault && state.provider) {
      const vault = getVaultContract();
      const snapshot = await vault.snapshot();
      state.data.vault = {
        state: snapshot.s,
        isFunded: snapshot.isFunded,
        isFinalized: snapshot.isFinalized,
        isDisputed: snapshot.isDisputed,
        balance: snapshot.balance,
        courier: await vault.courier(),
        courierFee: await vault.courierFee(),
        declaredValue: await vault.declaredValue(),
        pickupDeadline: await vault.pickupDeadline(),
        dropoffDeadline: await vault.dropoffDeadline(),
        deliveredAt: await vault.deliveredAt(),
        disputeWindow: await vault.disputeWindow()
      };
    } else {
      state.data.vault = null;
    }

    persist();
  } catch (error) {
    if (!quiet) throw error;
    log("Refresh failed", normalizeError(error), "bad");
  } finally {
    if (!quiet) clearBusy();
    render();
  }
}

async function loadRecentRequests() {
  if (!state.contracts.registry || !state.provider) return;
  const latest = await state.provider.getBlockNumber();
  const from = Math.max(0, latest - 5000);
  const events = await state.contracts.registry.queryFilter(
    state.contracts.registry.filters.RequestOpened(),
    from,
    latest
  );
  state.data.recentRequests = events.slice(-6).map((event) => ({
    id: event.args.deliveryId,
    seller: event.args.seller,
    pool: event.args.pool,
    declaredValue: event.args.declaredValue,
    maxPrice: event.args.maxPrice,
    bidDeadline: event.args.bidDeadline
  }));
}

function attachContracts() {
  if (!state.provider || !state.deployment?.contracts) return;
  const registryAddr = state.deployment.contracts.MarketplaceRegistry;
  const poolAddr = state.deployment.contracts.StakingPool;
  if (registryAddr && ethers.isAddress(registryAddr)) {
    state.contracts.registry = new ethers.Contract(registryAddr, MarketplaceRegistryArtifact.abi, state.provider);
  }
  if (poolAddr && ethers.isAddress(poolAddr)) {
    state.contracts.pool = new ethers.Contract(poolAddr, StakingPoolArtifact.abi, state.provider);
  }
}

function captureAcceptedVault(receipt) {
  const event = parseEvent(receipt, state.contracts.registry.interface, "BidAccepted");
  if (!event) throw new Error("Could not find BidAccepted event.");
  state.flow.vault = event.args.vault;
  state.flow.winnerIndex = Number(event.args.index);
  persist();
}

function getVaultContract() {
  return new ethers.Contract(state.flow.vault, DeliveryVaultArtifact.abi, state.provider);
}

function signerForAddress(address) {
  const normalized = address.toLowerCase();
  return Object.values(state.accounts).find((wallet) => wallet.address.toLowerCase() === normalized);
}

function requiredAccounts() {
  const missing = ROLE_DEFS.filter((role) => !state.accounts[role.id]).map((role) => role.label);
  if (missing.length) throw new Error(`Connect demo accounts first. Missing: ${missing.join(", ")}`);
  return state.accounts;
}

async function ensureConnected() {
  if (!state.connected || !state.provider) {
    await connectDemo();
  }
}

async function ensureContracts() {
  await ensureConnected();
  if (!state.contracts.registry || !state.contracts.pool) {
    throw new Error("Deploy or attach the registry and staking pool first.");
  }
}

async function ensureRequestLoaded() {
  await ensureContracts();
  if (!state.flow.deliveryId) throw new Error("Open or load a delivery request first.");
  if (!state.data.request) await refreshAll({ quiet: true });
}

async function ensureOpenRequest() {
  await ensureRequestLoaded();
  if (Number(state.data.request.stage) !== 1) {
    throw new Error(`Request is ${STAGES[Number(state.data.request.stage)]}, not Open.`);
  }
}

async function ensureVaultLoaded() {
  await ensureRequestLoaded();
  if (!state.flow.vault) {
    throw new Error("Accept a bid first so the vault exists.");
  }
  if (!state.data.vault) await refreshAll({ quiet: true });
}

async function waitTx(txPromise, title) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  log(title, receipt.hash ? shortHash(receipt.hash) : "confirmed", "good");
  return receipt;
}

async function advancePast(deadline, extraSeconds) {
  const latest = await state.provider.getBlock("latest");
  const target = Number(deadline) + Number(extraSeconds);
  const delta = Math.max(0, target - latest.timestamp);
  if (delta > 0) {
    await state.provider.send("evm_increaseTime", [delta]);
    await state.provider.send("evm_mine", []);
    log("Time advanced", secondsToDuration(delta), "good");
  }
}

function parseEvent(receipt, iface, eventName) {
  for (const logItem of receipt.logs) {
    try {
      const parsed = iface.parseLog(logItem);
      if (parsed?.name === eventName) return parsed;
    } catch {
      // Ignore logs from other contracts in the same receipt.
    }
  }
  return null;
}

function makeCodeHash(code, deliveryId, nonce) {
  return ethers.keccak256(ethers.concat([ethers.toUtf8Bytes(code), deliveryId, nonce]));
}

function setBusy(label) {
  state.busy = label;
  render();
}

function clearBusy() {
  state.busy = "";
  render();
}

function disableIfBusy() {
  return state.busy ? "disabled" : "";
}

function log(title, detail = "", kind = "") {
  state.logs.push({
    time: new Date().toLocaleTimeString(),
    title,
    detail,
    kind
  });
  state.logs = state.logs.slice(-40);
  persist();
}

function fail(error) {
  const detail = normalizeError(error);
  log("Action failed", detail, "bad");
  state.busy = "";
  render();
  console.error(error);
}

function normalizeError(error) {
  const raw = error?.shortMessage || error?.reason || error?.message || String(error);
  return raw.replace(/^execution reverted: /, "");
}

function persist() {
  localStorage.setItem("dlm.deployment", JSON.stringify(state.deployment));
  localStorage.setItem("dlm.flow", JSON.stringify(state.flow));
  localStorage.setItem("dlm.logs", JSON.stringify(state.logs.slice(-40)));
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function getInput(id, fallback = "") {
  const node = document.querySelector(`#${id}`);
  const value = node?.value?.trim();
  return value || fallback;
}

async function copyToClipboard(value) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  log("Copied", value.length > 20 ? shortHash(value) : value, "good");
  render();
}

function inputField(id, label, value = "", type = "text") {
  return `
    <label class="field">
      <span>${label}</span>
      <input id="${id}" type="${type}" value="${escapeAttr(value)}" />
    </label>
  `;
}

function metric(label, value) {
  return `
    <div class="metric">
      <span>${label}</span>
      <strong>${escapeHtml(String(value))}</strong>
    </div>
  `;
}

function detail(label, value) {
  return `
    <div class="detail">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function statusBadge(text, tone = "") {
  return `<span class="status ${tone}">${escapeHtml(text)}</span>`;
}

function addressLine(label, address) {
  return `
    <div class="address-line">
      <span>${label}</span>
      <button class="linklike mono" data-copy="${escapeAttr(address)}">${shortAddress(address)}</button>
    </div>
  `;
}

function addressButton(address) {
  if (!address || address === ZERO_ADDRESS) return "-";
  return `<button class="linklike mono" data-copy="${escapeAttr(address)}">${shortAddress(address)}</button>`;
}

function shortAddress(address) {
  if (!address) return "-";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function shortHash(hash) {
  if (!hash) return "-";
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function formatEth(value) {
  try {
    return trimNumber(ethers.formatEther(value));
  } catch {
    return "-";
  }
}

function trimNumber(value) {
  return value.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

function formatTime(seconds) {
  if (!seconds) return "-";
  return new Date(seconds * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function secondsToDuration(seconds) {
  if (!Number.isFinite(seconds)) return "-";
  if (seconds === 0) return "0 sec";
  const days = Math.floor(seconds / DAY);
  const hours = Math.floor((seconds % DAY) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes || seconds}s`;
}

function randomCode(prefix) {
  return `${prefix}-${ethers.hexlify(ethers.randomBytes(3)).slice(2).toUpperCase()}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
