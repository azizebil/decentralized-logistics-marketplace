const { ethers } = window;

const MNEMONIC = "test test test test test test test test test test test junk";
const STAGES = ["None", "Open", "Assigned", "Held", "Finalized", "Cancelled"];
const VAULT_STATES = ["Funded", "PickedUp", "Delivered", "Refunded", "Failed"];
const TRUST_ALPHA = 1.5;

const REGISTRY_ABI = [
  "event RequestOpened(bytes32 indexed deliveryId,address indexed seller,address pool,uint256 declaredValue,uint256 maxPrice,uint256 bidDeadline)",
  "event HashesPublished(bytes32 indexed deliveryId,bytes32 pickupHash,bytes32 dropoffHash)",
  "event BidPlaced(bytes32 indexed deliveryId,uint256 index,address indexed courier,uint256 price,uint256 promisedTime)",
  "event BidAccepted(bytes32 indexed deliveryId,uint256 index,address courier,address vault)",
  "function openRequest(uint256,uint256,uint256,uint256,address,address,address,bool,uint256,uint256) returns (bytes32)",
  "function publishHashes(bytes32,bytes32,bytes32)",
  "function cancelRequest(bytes32)",
  "function getBids(bytes32) view returns (tuple(address courier,address payout,uint256 price,uint256 promisedTime,uint256 reputationE4,uint64 submittedAt,bool withdrawn)[])",
  "function acceptBid(bytes32,uint256) returns (address)",
  "function acceptBidByAgent(bytes32,uint256) returns (address)",
  "function setAgentPolicy(address,uint256,uint256,uint256)",
  "function placeBid(bytes32,address,uint256,uint256,uint256) returns (uint256)",
  "function withdrawBid(bytes32,uint256)",
  "function getRequest(bytes32) view returns (tuple(address seller,uint256 declaredValue,uint256 maxPrice,uint256 maxDeadline,uint256 bidDeadline,address buyer,address mailbox,address pool,bytes32 pickupHash,bytes32 dropoffHash,bool preferTrusted,uint256 disputeWindow,uint8 stage,uint256 acceptedBidIndex,address vault,uint256 createdAt))"
];

const POOL_ABI = [
  "function operator() view returns (address)",
  "function admitMember(address)",
  "function depositStake() payable",
  "function freeCapacityFor(address) view returns (uint256)",
  "function requestWithdraw(uint256)",
  "function finalizeWithdraw()",
  "function members(address) view returns (bool isMember,uint256 contribution,uint256 reserved,uint256 withdrawReqAt,uint256 withdrawReqAmt)",
  "function totalStake() view returns (uint256)",
  "function activeValue() view returns (uint256)",
  "function memberCapBps() view returns (uint256)",
  "function withdrawalDelay() view returns (uint256)",
  "function factory() view returns (address)"
];

const VAULT_ABI = [
  "function fund() payable",
  "function snapshot() view returns (uint8 s,bool isFunded,bool isFinalized,bool isDisputed,uint256 balance)",
  "function raiseDispute()",
  "function resolveDispute(bool)",
  "function cancelByBuyerPrePickup()",
  "function pickup(bytes,bytes32)",
  "function confirmDelivery(bytes,bytes32)",
  "function finalizeDelivered()",
  "function refundOnPickupTimeout()",
  "function slashOnDropoffTimeout()",
  "function buyer() view returns (address)",
  "function courier() view returns (address)",
  "function courierFee() view returns (uint256)",
  "function declaredValue() view returns (uint256)",
  "function pickupDeadline() view returns (uint256)",
  "function dropoffDeadline() view returns (uint256)",
  "function deliveredAt() view returns (uint256)",
  "function disputeWindow() view returns (uint256)"
];

const $ = (id) => document.getElementById(id);

const state = {
  provider: null,
  registry: null,
  pool: null,
  requests: [],
  selectedRequest: null,
  selectedVault: null,
  selectedPool: null,
  bids: [],
  ranking: null,
  lastAgentAddress: ""
};

function log(message, detail, kind = "info") {
  const stamp = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.className = `timeline-entry ${kind === "error" ? "status-error" : ""}`;
  entry.innerHTML = `<time>${escapeHtml(stamp)}</time><strong>${escapeHtml(message)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ""}`;
  $("logOutput").prepend(entry);
}

function format(value) {
  return JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
}

function fail(error) {
  console.error(error);
  const reason = error?.shortMessage || error?.reason || error?.message || String(error);
  log("Something went wrong", reason, "error");
}

function wallet(index) {
  const base = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
  return state.provider ? base.connect(state.provider) : base;
}

function signer(role) {
  return wallet(Number($(role).value));
}

function contract(address, abi, role) {
  if (!state.provider) throw new Error("Connect to an RPC node first");
  if (!address || !ethers.isAddress(address)) throw new Error("Missing or invalid contract address");
  return new ethers.Contract(address, abi, signer(role));
}

function registry(role) {
  return contract($("registryAddress").value.trim(), REGISTRY_ABI, role);
}

function pool(role) {
  return contract($("poolAddress").value.trim(), POOL_ABI, role);
}

function vault(role) {
  return contract($("vaultAddress").value.trim(), VAULT_ABI, role);
}

function selectedId() {
  const id = $("deliveryId").value.trim();
  if (!id) throw new Error("Delivery ID is required");
  return id;
}

function future(seconds) {
  return Math.floor(Date.now() / 1000) + Number(seconds);
}

function accountOptions(select, fallback) {
  select.innerHTML = "";
  for (let i = 0; i < 10; i += 1) {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = `idx:${i}`;
    select.appendChild(option);
  }
  select.value = String(fallback);
}

function selectAccountByAddress(selectId, address) {
  if (!address || !$(selectId)) return;
  const normalized = String(address).toLowerCase();
  for (const option of $(selectId).options) {
    if (wallet(Number(option.value)).address.toLowerCase() === normalized) {
      $(selectId).value = option.value;
      return;
    }
  }
}

function updateAddresses() {
  $("sellerAddress").textContent = wallet(Number($("sellerAccount").value)).address;
  $("courierAddress").textContent = wallet(Number($("courierAccount").value)).address;
  $("buyerAddress").textContent = wallet(Number($("buyerAccount").value)).address;
  $("mailboxAddress").textContent = wallet(Number($("mailboxAccount").value)).address;
  const agent = wallet(Number($("agentAccount").value)).address;
  $("agentWalletAddress").textContent = agent;
  if (!$("agentAddress").value || $("agentAddress").value === state.lastAgentAddress || $("agentAddress").dataset.manual !== "true") {
    $("agentAddress").value = agent;
    $("agentAddress").dataset.manual = "false";
  }
  state.lastAgentAddress = agent;
  if (!$("sellerBuyer").value) $("sellerBuyer").value = $("buyerAddress").textContent;
  if (!$("sellerMailbox").value) $("sellerMailbox").value = $("mailboxAddress").textContent;
  renderTrustMatrix();
  renderPolicyPreview();
  renderBidGuard();
}

async function loadDeployment() {
  try {
    const response = await fetch("/deployment.json");
    if (!response.ok) return;
    const deployment = await response.json();
    $("registryAddress").value = deployment.contracts?.MarketplaceRegistry || "";
    $("poolAddress").value = deployment.contracts?.StakingPool || "";
    log("Deployment loaded", "Registry and staking pool addresses are ready.");
  } catch {
    log("Deployment not found", "Deploy contracts or paste the registry and pool addresses.");
  }
}

async function loadDemoState() {
  try {
    const response = await fetch("/frontend-demo.json");
    if (!response.ok) return;
    const demo = await response.json();
    if (!demo.deliveryId) return;
    if (!$("registryAddress").value && demo.registry) $("registryAddress").value = demo.registry;
    if (!$("poolAddress").value && demo.pool) $("poolAddress").value = demo.pool;
    $("deliveryId").value = demo.deliveryId;
    $("vaultAddress").value = demo.vault || "";
    $("pickupCode").value = demo.pickupCode || "";
    $("pickupNonce").value = demo.pickupNonce || "";
    $("dropoffCode").value = demo.dropoffCode || "";
    $("dropoffNonce").value = demo.dropoffNonce || "";
    $("fundEth").value = demo.fundedEth || $("fundEth").value;
    selectAccountByAddress("sellerAccount", demo.seller);
    selectAccountByAddress("buyerAccount", demo.buyer);
    selectAccountByAddress("mailboxAccount", demo.mailbox);
    selectAccountByAddress("courierAccount", demo.courier);
    localStorage.setItem("dlm.deliveryId", $("deliveryId").value);
    localStorage.setItem("dlm.vaultAddress", $("vaultAddress").value);
    log("Demo loaded", `Delivery ${short(demo.deliveryId)} is ready to inspect.`);
  } catch {
    log("No demo loaded", "Run demo:frontend to prefill a sample delivery.");
  }
}

async function connect() {
  state.provider = new ethers.JsonRpcProvider($("rpcUrl").value.trim());
  const network = await state.provider.getNetwork();
  $("networkStatus").textContent = `Connected to chain ${network.chainId}`;
  log("Connected", `Using local chain ${network.chainId}.`);
  updateAddresses();
  await refreshAll();
}

async function waitTx(tx, label) {
  log(`${label} started`, `Transaction ${short(tx.hash)} is waiting for confirmation.`);
  const receipt = await tx.wait();
  log(`${label} complete`, `Confirmed in block ${receipt.blockNumber}.`);
  await refreshAll(false);
  return receipt;
}

function setDelivery(id) {
  $("deliveryId").value = id;
  localStorage.setItem("dlm.deliveryId", id);
  state.bids = [];
  state.ranking = null;
  $("bidsList").innerHTML = "";
  $("rankingOutput").innerHTML = "";
}

function setVaultAddress(address) {
  if (address && address !== ethers.ZeroAddress) {
    $("vaultAddress").value = address;
    localStorage.setItem("dlm.vaultAddress", address);
  }
}

async function refreshRequests() {
  const addr = $("registryAddress").value.trim();
  if (!state.provider || !ethers.isAddress(addr)) return;
  const readRegistry = new ethers.Contract(addr, REGISTRY_ABI, state.provider);
  const events = await readRegistry.queryFilter(readRegistry.filters.RequestOpened(), 0, "latest");
  state.requests = events.map((event) => ({
    id: event.args.deliveryId,
    seller: event.args.seller,
    pool: event.args.pool,
    declaredValue: event.args.declaredValue,
    maxPrice: event.args.maxPrice,
    bidDeadline: event.args.bidDeadline
  })).reverse();

  $("requestsList").innerHTML = "";
  for (const request of state.requests.slice(0, 12)) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "item";
    el.innerHTML = `<strong>${short(request.id)}</strong>${ethers.formatEther(request.declaredValue)} ETH value, max ${ethers.formatEther(request.maxPrice)} ETH`;
    el.addEventListener("click", async () => {
      setDelivery(request.id);
      await refreshDetails();
      await loadBids();
    });
    $("requestsList").appendChild(el);
  }
}

async function refreshDetails() {
  const id = $("deliveryId").value.trim();
  const regAddr = $("registryAddress").value.trim();
  if (!state.provider || !id || !ethers.isAddress(regAddr)) return;
  const readRegistry = new ethers.Contract(regAddr, REGISTRY_ABI, state.provider);
  const r = await readRegistry.getRequest(id);
  const stage = STAGES[Number(r.stage)];
  if (stage === "None") {
    state.selectedRequest = null;
    state.selectedVault = null;
    renderDetails();
    renderLifecycle();
    renderBidGuard();
    return;
  }
  setVaultAddress(r.vault);
  state.selectedRequest = {
    deliveryId: id,
    seller: r.seller,
    buyer: r.buyer,
    mailbox: r.mailbox,
    pool: r.pool,
    declaredValueWei: r.declaredValue,
    maxPriceWei: r.maxPrice,
    maxDeadlineTs: Number(r.maxDeadline),
    bidDeadlineTs: Number(r.bidDeadline),
    declaredValue: `${ethers.formatEther(r.declaredValue)} ETH`,
    maxPrice: `${ethers.formatEther(r.maxPrice)} ETH`,
    maxDeadline: dateOf(r.maxDeadline),
    bidDeadline: dateOf(r.bidDeadline),
    stage,
    preferTrusted: r.preferTrusted,
    disputeWindow: `${r.disputeWindow}s`,
    disputeWindowSec: Number(r.disputeWindow),
    acceptedBidIndex: r.acceptedBidIndex.toString(),
    vault: r.vault,
    pickupHash: r.pickupHash,
    dropoffHash: r.dropoffHash,
    hashesLocked: r.pickupHash !== ethers.ZeroHash && r.dropoffHash !== ethers.ZeroHash,
    createdAt: dateOf(r.createdAt)
  };
  renderDetails();
  renderLifecycle();
  renderPolicyPreview();
  renderBidGuard();
  await refreshVaultStatus(false);
}

async function refreshVaultStatus(writeLog = true) {
  const addr = $("vaultAddress").value.trim();
  if (!state.provider || !ethers.isAddress(addr)) {
    state.selectedVault = null;
    renderDetails();
    renderLifecycle();
    return;
  }
  const v = new ethers.Contract(addr, VAULT_ABI, state.provider);
  const [snap, buyer, courier, fee, value, pickupDeadline, dropoffDeadline, deliveredAt, disputeWindow] = await Promise.all([
    v.snapshot(),
    v.buyer(),
    v.courier(),
    v.courierFee(),
    v.declaredValue(),
    v.pickupDeadline(),
    v.dropoffDeadline(),
    v.deliveredAt(),
    v.disputeWindow()
  ]);
  const deliveredAtTs = Number(deliveredAt);
  const disputeWindowSec = Number(disputeWindow);
  state.selectedVault = {
    vault: addr,
    state: VAULT_STATES[Number(snap.s)],
    funded: snap.isFunded,
    finalized: snap.isFinalized,
    disputed: snap.isDisputed,
    balance: `${ethers.formatEther(snap.balance)} ETH`,
    balanceWei: snap.balance,
    buyer,
    courier,
    courierFee: `${ethers.formatEther(fee)} ETH`,
    courierFeeWei: fee,
    declaredValue: `${ethers.formatEther(value)} ETH`,
    pickupDeadline: dateOf(pickupDeadline),
    dropoffDeadline: dateOf(dropoffDeadline),
    pickupDeadlineTs: Number(pickupDeadline),
    dropoffDeadlineTs: Number(dropoffDeadline),
    deliveredAt: deliveredAtTs ? dateOf(deliveredAt) : "-",
    disputeWindow: `${disputeWindowSec}s`,
    disputeEndsAt: deliveredAtTs && disputeWindowSec ? dateOf(deliveredAtTs + disputeWindowSec) : "-"
  };
  if (!$("fundEth").value || $("fundEth").value === "0") $("fundEth").value = ethers.formatEther(fee);
  if (writeLog) log("Vault checked", `Status is ${deliveryProgressLabel(state.selectedVault)}; balance is ${state.selectedVault.balance}.`);
  renderDetails();
  renderLifecycle();
}

async function refreshAll(writeLog = true) {
  await refreshRequests();
  await refreshDetails();
  await refreshPoolStatus(false);
  if (writeLog) log("Data refreshed", "Requests and vault status are up to date.");
}

async function openRequest() {
  const reg = registry("sellerAccount");
  const tx = await reg.openRequest(
    ethers.parseEther($("sellerDeclared").value),
    ethers.parseEther($("sellerMaxPrice").value),
    future($("sellerMaxDeadline").value),
    future($("sellerBidDeadline").value),
    $("sellerBuyer").value.trim(),
    $("sellerMailbox").value.trim(),
    $("poolAddress").value.trim(),
    $("sellerPreferTrusted").checked,
    Number($("sellerDisputeWindow").value),
    Number($("sellerSalt").value)
  );
  const receipt = await waitTx(tx, "Open request");
  const parsed = receipt.logs.map((l) => { try { return reg.interface.parseLog(l); } catch { return null; } })
    .find((event) => event?.name === "RequestOpened");
  if (parsed) setDelivery(parsed.args.deliveryId);
}

async function publishHashes() {
  const id = selectedId();
  const pickupCode = ethers.toUtf8Bytes(`PICKUP-${ethers.hexlify(ethers.randomBytes(8))}`);
  const dropoffCode = ethers.toUtf8Bytes(`DROPOFF-${ethers.hexlify(ethers.randomBytes(8))}`);
  const nonceP = ethers.id(`p-${Date.now()}-${Math.random()}`);
  const nonceD = ethers.id(`d-${Date.now()}-${Math.random()}`);
  const pickupHash = ethers.keccak256(ethers.concat([pickupCode, id, nonceP]));
  const dropoffHash = ethers.keccak256(ethers.concat([dropoffCode, id, nonceD]));
  const codes = {
    deliveryId: id,
    pickupCode: ethers.hexlify(pickupCode),
    dropoffCode: ethers.hexlify(dropoffCode),
    nonceP,
    nonceD,
    pickupHash,
    dropoffHash
  };
  localStorage.setItem(`dlm.codes.${id}`, format(codes));
  $("pickupCode").value = codes.pickupCode;
  $("pickupNonce").value = codes.nonceP;
  $("dropoffCode").value = codes.dropoffCode;
  $("dropoffNonce").value = codes.nonceD;
  $("codeOutput").innerHTML = `
    <div class="item">
      <strong>Pickup and dropoff secrets generated</strong>
      <div class="secret-grid">
        <div><span>Pickup code</span><code>${escapeHtml(codes.pickupCode)}</code></div>
        <div><span>Pickup nonce</span><code>${escapeHtml(codes.nonceP)}</code></div>
        <div><span>Dropoff code</span><code>${escapeHtml(codes.dropoffCode)}</code></div>
        <div><span>Dropoff nonce</span><code>${escapeHtml(codes.nonceD)}</code></div>
      </div>
    </div>`;
  await waitTx(await registry("sellerAccount").publishHashes(id, pickupHash, dropoffHash), "Publish hashes");
}

async function cancelRequest() {
  await waitTx(await registry("sellerAccount").cancelRequest(selectedId()), "Cancel open request");
}

async function loadBids(writeLog = true) {
  const bids = await registry("sellerAccount").getBids(selectedId());
  state.bids = bids;
  updateRanking();
  renderBids();
  renderRanking();
  if (writeLog) log("Bids loaded", `${bids.length} bid${bids.length === 1 ? "" : "s"} found for this delivery.`);
  return bids;
}

function renderBids() {
  $("bidsList").innerHTML = "";
  const rankingByIndex = new Map((state.ranking?.scored || []).map((item) => [item.index, item]));
  state.bids.forEach((bid, index) => {
    const rank = rankingByIndex.get(index);
    const top = state.ranking?.winnerIndex === index;
    const el = document.createElement("div");
    el.className = `item bid-card${top ? " is-top" : ""}`;
    el.innerHTML = `<strong>Bid ${index}${bid.withdrawn ? " - withdrawn" : ""}${top ? " - agent pick" : ""}</strong>
      <div class="meta-grid">
        <span>Courier</span><code>${escapeHtml(short(bid.courier))}</code>
        <span>Payout</span><code>${escapeHtml(short(bid.payout))}</code>
        <span>Price</span><b>${escapeHtml(ethers.formatEther(bid.price))} ETH</b>
        <span>Promised</span><b>${escapeHtml(timeUntil(bid.promisedTime))}</b>
        <span>Reputation</span><b>${escapeHtml(`${Number(bid.reputationE4) / 100}%`)}</b>
        <span>Score</span><b>${escapeHtml(rank ? formatScore(rank.score) : "-")}</b>
      </div>`;
    el.addEventListener("click", () => {
      $("acceptBidIndex").value = String(index);
      syncFundingFromBid(index);
      renderRanking();
    });
    $("bidsList").appendChild(el);
  });
}

async function rankBidsAction() {
  if (!state.bids.length) await loadBids(false);
  updateRanking();
  renderBids();
  renderRanking();
  const winner = state.ranking?.winnerIndex ?? -1;
  if (winner >= 0) {
    $("acceptBidIndex").value = String(winner);
    syncFundingFromBid(winner);
    log("Agent ranking ready", `Bid ${winner} has the best ${state.ranking.formula} score.`);
  } else {
    log("No acceptable bid", "All loaded bids are withdrawn, late, over budget, or already expired.", "error");
  }
}

async function acceptBid() {
  const reg = registry("sellerAccount");
  const index = Number($("acceptBidIndex").value);
  const receipt = await waitTx(await reg.acceptBid(selectedId(), index), "Accept bid");
  const parsed = receipt.logs.map((l) => { try { return reg.interface.parseLog(l); } catch { return null; } })
    .find((event) => event?.name === "BidAccepted");
  if (parsed) setVaultAddress(parsed.args.vault);
  syncFundingFromBid(index);
}

async function acceptBidByAgent() {
  const reg = registry("agentAccount");
  const index = Number($("acceptBidIndex").value);
  assertAgentCanAccept(index);
  const receipt = await waitTx(await reg.acceptBidByAgent(selectedId(), index), "Agent accept bid");
  const parsed = receipt.logs.map((l) => { try { return reg.interface.parseLog(l); } catch { return null; } })
    .find((event) => event?.name === "BidAccepted");
  if (parsed) setVaultAddress(parsed.args.vault);
  syncFundingFromBid(index);
}

async function setAgent() {
  const agent = $("agentAddress").value.trim() || signer("agentAccount").address;
  $("agentAddress").value = agent;
  await waitTx(await registry("sellerAccount").setAgentPolicy(
    agent,
    ethers.parseEther($("agentMaxPrice").value),
    Number($("agentDeadlineBuffer").value),
    ethers.parseEther($("agentCosign").value)
  ), "Set agent policy");
  renderPolicyPreview();
}

async function admitCourier() {
  await waitTx(await pool("operatorAccount").admitMember(signer("courierAccount").address), "Admit courier");
}

async function stake() {
  await waitTx(await pool("courierAccount").depositStake({ value: ethers.parseEther($("stakeEth").value) }), "Stake");
  await capacity();
}

async function capacity() {
  await refreshPoolStatus(true);
}

async function placeBid() {
  renderBidGuard();
  await waitTx(await registry("courierAccount").placeBid(
    selectedId(),
    $("bidPayout").value.trim() || signer("courierAccount").address,
    ethers.parseEther($("bidPrice").value),
    future($("bidPromised").value),
    Number($("bidRep").value)
  ), "Place bid");
  await loadBids();
}

async function withdrawBid() {
  await waitTx(await registry("courierAccount").withdrawBid(selectedId(), Number($("withdrawBidIndex").value)), "Withdraw bid");
  await loadBids();
}

async function pickup() {
  await waitTx(await vault("courierAccount").pickup($("pickupCode").value.trim(), $("pickupNonce").value.trim()), "Pickup");
}

async function requestWithdraw() {
  await waitTx(await pool("courierAccount").requestWithdraw(ethers.parseEther($("withdrawStakeEth").value)), "Request stake withdrawal");
}

async function finalizeWithdraw() {
  await waitTx(await pool("courierAccount").finalizeWithdraw(), "Finalize stake withdrawal");
}

async function fundVault() {
  await waitTx(await vault("buyerAccount").fund({ value: ethers.parseEther($("fundEth").value) }), "Fund vault");
}

async function confirmDelivery() {
  await waitTx(await vault("mailboxAccount").confirmDelivery($("dropoffCode").value.trim(), $("dropoffNonce").value.trim()), "Confirm delivery");
}

async function callVault(role, method, label) {
  await waitTx(await vault(role)[method](), label);
}

async function resolveDispute(inFavorOfCourier) {
  await waitTx(
    await vault("operatorAccount").resolveDispute(inFavorOfCourier),
    inFavorOfCourier ? "Resolve dispute for courier" : "Resolve dispute for buyer"
  );
}

function asBigInt(value) {
  if (typeof value === "bigint") return value;
  return BigInt(value.toString());
}

function safeParseEtherInput(id) {
  try {
    return ethers.parseEther($(id).value || "0");
  } catch {
    return 0n;
  }
}

function updateRanking() {
  if (!state.selectedRequest || !state.bids.length) {
    state.ranking = null;
    return;
  }
  state.ranking = rankBids(state.bids, state.selectedRequest);
  if (state.ranking.winnerIndex >= 0 && (!$("acceptBidIndex").value || $("acceptBidIndex").value === "-1")) {
    $("acceptBidIndex").value = String(state.ranking.winnerIndex);
  }
}

function rankBids(bids, request) {
  const now = Math.floor(Date.now() / 1000);
  const formula = request.preferTrusted ? `r^${TRUST_ALPHA.toFixed(1)}/(t*p)` : "1/(t*p)";
  const scored = bids.map((bid, index) => {
    const promisedTime = Number(bid.promisedTime);
    const priceWei = asBigInt(bid.price);
    if (bid.withdrawn) return { index, score: -Infinity, reason: "withdrawn" };
    if (priceWei > asBigInt(request.maxPriceWei)) return { index, score: -Infinity, reason: "over budget" };
    if (promisedTime > request.maxDeadlineTs) return { index, score: -Infinity, reason: "after max arrival" };
    if (promisedTime <= now) return { index, score: -Infinity, reason: "expired promise" };

    const reputation = Number(bid.reputationE4) / 10000;
    const repFactor = request.preferTrusted ? Math.pow(Math.max(reputation, 1e-6), TRUST_ALPHA) : 1;
    const seconds = Math.max(1, promisedTime - now);
    const priceEth = Math.max(Number(ethers.formatEther(bid.price)), 1e-12);
    const score = repFactor / (seconds * priceEth);
    return {
      index,
      score,
      reason: `${formula}; r=${reputation.toFixed(3)}, t=${seconds}s, p=${priceEth.toFixed(4)} ETH`
    };
  });

  let winnerIndex = -1;
  let best = -Infinity;
  for (const item of scored) {
    if (item.score > best) {
      best = item.score;
      winnerIndex = item.index;
    }
  }

  return {
    formula,
    winnerIndex,
    scored,
    sorted: [...scored].sort((a, b) => b.score - a.score)
  };
}

function renderRanking() {
  const out = $("rankingOutput");
  if (!out) return;
  out.innerHTML = "";
  if (!state.bids.length) return;
  if (!state.ranking) updateRanking();
  if (!state.ranking) return;

  const header = document.createElement("div");
  header.className = "rank-header";
  header.innerHTML = `<span>Agent formula</span><strong>${escapeHtml(state.ranking.formula)}</strong>`;
  out.appendChild(header);

  for (const item of state.ranking.sorted) {
    const bid = state.bids[item.index];
    const selected = Number($("acceptBidIndex").value) === item.index;
    const el = document.createElement("button");
    el.type = "button";
    el.className = `rank-card${item.index === state.ranking.winnerIndex ? " is-top" : ""}${selected ? " is-selected" : ""}${Number.isFinite(item.score) ? "" : " is-blocked"}`;
    el.innerHTML = `
      <span>Bid ${item.index}</span>
      <strong>${escapeHtml(formatScore(item.score))}</strong>
      <small>${escapeHtml(item.reason)}</small>
      <small>${escapeHtml(ethers.formatEther(bid.price))} ETH · ${escapeHtml(timeUntil(bid.promisedTime))} · ${escapeHtml(`${Number(bid.reputationE4) / 100}% rep`)}</small>`;
    el.addEventListener("click", () => {
      $("acceptBidIndex").value = String(item.index);
      syncFundingFromBid(item.index);
      renderRanking();
    });
    out.appendChild(el);
  }
}

function syncFundingFromBid(index) {
  const bid = state.bids[index];
  if (bid) $("fundEth").value = ethers.formatEther(bid.price);
}

function agentPolicySnapshot() {
  return {
    maxPriceWei: safeParseEtherInput("agentMaxPrice"),
    deadlineBufferSec: Number($("agentDeadlineBuffer").value || 0),
    cosignWei: safeParseEtherInput("agentCosign")
  };
}

function agentGateForBid(index) {
  const request = state.selectedRequest;
  const bid = state.bids[index];
  if (!request || !bid) return { ok: false, notes: ["missing bid"] };
  const policy = agentPolicySnapshot();
  const notes = [];
  if (asBigInt(bid.price) > policy.maxPriceWei) notes.push("price above agent limit");
  if (Number(bid.promisedTime) + policy.deadlineBufferSec > request.maxDeadlineTs) notes.push("deadline buffer breached");
  if (policy.cosignWei !== 0n && asBigInt(request.declaredValueWei) > policy.cosignWei) notes.push("seller co-sign required");
  return { ok: notes.length === 0, notes };
}

function assertAgentCanAccept(index) {
  const selectedAgent = signer("agentAccount").address.toLowerCase();
  const configuredAgent = $("agentAddress").value.trim().toLowerCase();
  if (configuredAgent && configuredAgent !== selectedAgent) {
    throw new Error("Selected agent key does not match the configured session key address");
  }
  const gate = agentGateForBid(index);
  if (!gate.ok) throw new Error(`Agent policy blocks this bid: ${gate.notes.join(", ")}`);
}

function renderPolicyPreview() {
  const sellerOut = $("sellerPolicyPreview");
  const agentOut = $("agentPolicyOutput");
  const preferTrusted = $("sellerPreferTrusted")?.checked;
  const formula = preferTrusted ? `r^${TRUST_ALPHA.toFixed(1)} / (time * price)` : "1 / (time * price)";
  if (sellerOut) {
    sellerOut.innerHTML = `
      ${guardChip("Scoring", true, formula)}
      ${guardChip("Trust preference", preferTrusted, preferTrusted ? "reputation weighted" : "price/time only")}`;
  }
  if (agentOut) {
    const policy = agentPolicySnapshot();
    agentOut.innerHTML = `
      ${guardChip("Session key", Boolean($("agentAddress").value), short($("agentAddress").value))}
      ${guardChip("Agent ceiling", true, `${ethers.formatEther(policy.maxPriceWei)} ETH`)}
      ${guardChip("Buffer", true, `${policy.deadlineBufferSec}s`)}
      ${guardChip("Co-sign over", true, `${ethers.formatEther(policy.cosignWei)} ETH`)}`;
  }
}

function renderBidGuard() {
  const out = $("bidGuardOutput");
  if (!out) return;
  const request = state.selectedRequest;
  if (!request || request.stage === "None") {
    out.innerHTML = guardChip("Request", null, "no delivery selected");
    return;
  }
  const priceWei = safeParseEtherInput("bidPrice");
  const promisedTime = future(Number($("bidPromised").value || 0));
  const capacity = state.selectedPool?.freeCapacityWei;
  const capacityOk = capacity === undefined ? null : asBigInt(capacity) >= asBigInt(request.declaredValueWei);
  out.innerHTML = `
    ${guardChip("Budget", priceWei <= asBigInt(request.maxPriceWei), `${ethers.formatEther(priceWei)} / ${request.maxPrice}`)}
    ${guardChip("Arrival", promisedTime <= request.maxDeadlineTs, timeUntil(promisedTime))}
    ${guardChip("Pool capacity", capacityOk, capacity === undefined ? "unknown" : `${ethers.formatEther(capacity)} ETH free`)}`;
}

async function refreshPoolStatus(writeLog = false) {
  const addr = $("poolAddress").value.trim();
  if (!state.provider || !ethers.isAddress(addr)) {
    state.selectedPool = null;
    $("poolOutput").innerHTML = "";
    renderBidGuard();
    renderTrustMatrix();
    return;
  }

  const readPool = new ethers.Contract(addr, POOL_ABI, state.provider);
  const courier = wallet(Number($("courierAccount").value)).address;
  const [free, member, total, active, cap, operator, withdrawalDelay, factory] = await Promise.all([
    readPool.freeCapacityFor(courier),
    readPool.members(courier),
    readPool.totalStake(),
    readPool.activeValue(),
    readPool.memberCapBps(),
    readPool.operator(),
    readPool.withdrawalDelay(),
    readPool.factory()
  ]);

  state.selectedPool = {
    address: addr,
    courier,
    operator,
    factory,
    freeCapacityWei: free,
    member,
    totalStakeWei: total,
    activeValueWei: active,
    memberCapBps: Number(cap),
    withdrawalDelaySec: Number(withdrawalDelay)
  };

  $("capacityOutput").textContent = `Capacity: ${ethers.formatEther(free)} ETH`;
  $("poolOutput").innerHTML = `
    <div><span>Total stake</span><strong>${escapeHtml(ethers.formatEther(total))} ETH</strong></div>
    <div><span>Active value</span><strong>${escapeHtml(ethers.formatEther(active))} ETH</strong></div>
    <div><span>Courier stake</span><strong>${escapeHtml(ethers.formatEther(member.contribution))} ETH</strong></div>
    <div><span>Reserved</span><strong>${escapeHtml(ethers.formatEther(member.reserved))} ETH</strong></div>
    <div><span>Member cap</span><strong>${escapeHtml(`${Number(cap) / 100}%`)}</strong></div>
    <div><span>Withdraw delay</span><strong>${escapeHtml(`${Number(withdrawalDelay)}s`)}</strong></div>`;

  renderBidGuard();
  renderTrustMatrix();
  renderDetails();
  if (writeLog) {
    log(
      "Courier capacity checked",
      `${member.isMember ? "Member" : "Not a pool member"}; free capacity ${ethers.formatEther(free)} ETH, staked ${ethers.formatEther(member.contribution)} ETH, reserved ${ethers.formatEther(member.reserved)} ETH. Pool total ${ethers.formatEther(total)} ETH, active ${ethers.formatEther(active)} ETH, member cap ${Number(cap) / 100}%.`
    );
  }
}

function guardChip(label, stateValue, value) {
  const tone = stateValue === true ? "ok" : stateValue === false ? "bad" : "warn";
  return `<span class="guard-chip ${tone}"><b>${escapeHtml(label)}</b>${escapeHtml(value)}</span>`;
}

function formatScore(score) {
  return Number.isFinite(score) ? score.toExponential(3) : "blocked";
}

function timeUntil(value) {
  const diff = Number(value) - Math.floor(Date.now() / 1000);
  if (!Number.isFinite(diff)) return "-";
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${diff % 60}s`;
  return `${diff}s`;
}

function short(value) {
  return value ? `${value.slice(0, 10)}...${value.slice(-6)}` : "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function statusClass(value) {
  return `status-${String(value || "").replace(/\s+/g, "").toLowerCase()}`;
}

function statusPill(value) {
  return `<span class="status-pill ${statusClass(value)}">${escapeHtml(value)}</span>`;
}

function deliveryProgressLabel(vaultState) {
  if (!vaultState) return "Not assigned yet";
  if (vaultState.disputed) return "Disputed";
  if (vaultState.finalized) return "Paid out";
  if (vaultState.state === "Funded" && !vaultState.funded) return "Waiting for buyer funding";
  if (vaultState.state === "Funded") return "Ready for pickup";
  if (vaultState.state === "PickedUp") return "Package picked up";
  if (vaultState.state === "Delivered") return "Delivered, waiting for payout";
  if (vaultState.state === "Refunded") return "Refunded";
  if (vaultState.state === "Failed") return "Failed";
  return vaultState.state;
}

function row(label, value) {
  return `<div class="summary-row"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
}

function textRow(label, value) {
  return row(label, escapeHtml(value));
}

function card(title, rows) {
  return `<section class="summary-card"><h4>${escapeHtml(title)}</h4>${rows.join("")}</section>`;
}

function renderTrustMatrix() {
  const out = $("boundaryGrid");
  if (!out) return;
  const operator = $("operatorAccount") ? wallet(Number($("operatorAccount").value)).address : "";
  const items = [
    ["Seller master", $("sellerAddress")?.textContent || wallet(Number($("sellerAccount")?.value || 0)).address, "posts requests"],
    ["Seller agent", $("agentAddress")?.value || "", "accepts within policy"],
    ["Courier", $("courierAddress")?.textContent || "", "bids, pickup, payout"],
    ["Buyer funding", $("buyerAddress")?.textContent || "", "funds vault, disputes"],
    ["Mailbox key", $("mailboxAddress")?.textContent || "", "confirms dropoff"],
    ["Pool operator", state.selectedPool?.operator || operator, "admits and arbitrates"]
  ];
  out.innerHTML = items.map(([label, address, role]) => `
    <div class="boundary-card">
      <span>${escapeHtml(label)}</span>
      <code>${escapeHtml(short(address))}</code>
      <small>${escapeHtml(role)}</small>
    </div>`).join("");
}

function renderLifecycle() {
  const out = $("lifecycleSteps");
  if (!out) return;
  const request = state.selectedRequest;
  const vaultState = state.selectedVault;
  const hasRequest = request && request.stage !== "None";
  const assigned = hasRequest && request.stage !== "Open" && request.stage !== "Cancelled";
  const failed = request?.stage === "Cancelled" || vaultState?.state === "Refunded" || vaultState?.state === "Failed";
  const delivered = vaultState?.state === "Delivered" || vaultState?.finalized;
  const steps = [
    ["Open", hasRequest, hasRequest && request.stage === "Open"],
    ["Hashes", request?.hashesLocked, hasRequest && !request?.hashesLocked],
    ["Assigned", assigned, hasRequest && request?.hashesLocked && !assigned],
    ["Funded", vaultState?.funded, assigned && !vaultState?.funded],
    ["Picked up", vaultState?.state === "PickedUp" || delivered, vaultState?.state === "Funded" && vaultState?.funded],
    ["Delivered", delivered, vaultState?.state === "PickedUp"],
    ["Finalized", vaultState?.finalized, vaultState?.state === "Delivered" && !vaultState?.finalized]
  ];

  $("flowCaption").textContent = hasRequest
    ? `${short(request.deliveryId)} · ${request.stage}${vaultState ? ` · ${deliveryProgressLabel(vaultState)}` : ""}`
    : "No delivery selected.";

  out.innerHTML = steps.map(([label, done, active]) => {
    const stateName = failed && label === "Finalized" ? "fail" : done ? "done" : active ? "active" : "pending";
    return `<div class="flow-step ${stateName}"><span>${escapeHtml(label)}</span></div>`;
  }).join("");
}

function renderDetails() {
  const request = state.selectedRequest;
  const vaultState = state.selectedVault;
  if (!request && !vaultState) {
    $("detailsOutput").className = "details-empty";
    $("detailsOutput").textContent = "No request selected.";
    return;
  }

  $("detailsOutput").className = "summary-stack";
  const cards = [];
  if (request) {
    const progress = vaultState ? deliveryProgressLabel(vaultState) : request.stage;
    cards.push(card("Selected Delivery", [
      row("Progress", statusPill(progress)),
      row("Registry stage", statusPill(request.stage)),
      textRow("Delivery", short(request.deliveryId)),
      textRow("Value", request.declaredValue),
      textRow("Max courier fee", request.maxPrice),
      textRow("Bids close", request.bidDeadline),
      textRow("Delivery due", request.maxDeadline),
      textRow("Accepted bid", request.stage === "Open" ? "Not selected yet" : `Bid ${request.acceptedBidIndex}`),
      textRow("Hash commitments", request.hashesLocked ? "Locked" : "Not published"),
      textRow("Trusted courier", request.preferTrusted ? "Preferred" : "Not required"),
      textRow("Dispute window", request.disputeWindow)
    ]));
    cards.push(card("People", [
      textRow("Seller", short(request.seller)),
      textRow("Buyer", short(request.buyer)),
      textRow("Mailbox", short(request.mailbox)),
      textRow("Pool", short(request.pool))
    ]));
  }
  if (state.ranking) {
    const winner = state.ranking.winnerIndex >= 0 ? `Bid ${state.ranking.winnerIndex}` : "None";
    const gate = state.ranking.winnerIndex >= 0 ? agentGateForBid(state.ranking.winnerIndex) : { ok: false, notes: ["no acceptable bid"] };
    cards.push(card("Agent Decision", [
      textRow("Formula", state.ranking.formula),
      row("Suggested bid", statusPill(winner)),
      textRow("Session key", gate.ok ? "Can accept" : gate.notes.join(", ")),
      textRow("Selected bid", $("acceptBidIndex").value)
    ]));
  }
  if (vaultState) {
    cards.push(card("Vault", [
      row("Escrow", statusPill(deliveryProgressLabel(vaultState))),
      textRow("Funded", vaultState.funded ? "Yes" : "No"),
      textRow("Disputed", vaultState.disputed ? "Yes" : "No"),
      textRow("Balance", vaultState.balance),
      textRow("Courier fee", vaultState.courierFee),
      textRow("Courier", short(vaultState.courier)),
      textRow("Pickup deadline", vaultState.pickupDeadline),
      textRow("Dropoff deadline", vaultState.dropoffDeadline),
      textRow("Delivered at", vaultState.deliveredAt),
      textRow("Dispute ends", vaultState.disputeEndsAt)
    ]));
  }
  if (state.selectedPool) {
    cards.push(card("Staking Pool", [
      textRow("Total stake", `${ethers.formatEther(state.selectedPool.totalStakeWei)} ETH`),
      textRow("Active value", `${ethers.formatEther(state.selectedPool.activeValueWei)} ETH`),
      textRow("Courier free cap", `${ethers.formatEther(state.selectedPool.freeCapacityWei)} ETH`),
      textRow("Member cap", `${state.selectedPool.memberCapBps / 100}%`),
      textRow("Factory", short(state.selectedPool.factory))
    ]));
  }
  $("detailsOutput").innerHTML = cards.join("");
  renderLifecycle();
  renderTrustMatrix();
}

function dateOf(value) {
  const timestamp = Number(value);
  if (!timestamp) return "-";
  return new Date(timestamp * 1000).toLocaleString();
}

function bind(id, fn) {
  const el = $(id);
  if (el) el.addEventListener("click", () => fn().catch(fail));
}

function persistInputs() {
  for (const id of ["rpcUrl", "registryAddress", "poolAddress", "deliveryId", "vaultAddress"]) {
    const saved = localStorage.getItem(`dlm.${id}`);
    if (saved) $(id).value = saved;
    $(id).addEventListener("input", () => localStorage.setItem(`dlm.${id}`, $(id).value));
  }
}

async function init() {
  accountOptions($("sellerAccount"), 2);
  accountOptions($("courierAccount"), 5);
  accountOptions($("buyerAccount"), 3);
  accountOptions($("mailboxAccount"), 4);
  accountOptions($("operatorAccount"), 1);
  accountOptions($("agentAccount"), 8);

  persistInputs();
  for (const id of ["sellerAccount", "courierAccount", "buyerAccount", "mailboxAccount", "operatorAccount", "agentAccount"]) {
    $(id).addEventListener("change", updateAddresses);
  }
  $("agentAddress").addEventListener("input", () => {
    $("agentAddress").dataset.manual = "true";
    renderPolicyPreview();
    renderTrustMatrix();
  });
  for (const id of ["sellerPreferTrusted", "sellerMaxPrice", "sellerMaxDeadline", "agentMaxPrice", "agentDeadlineBuffer", "agentCosign"]) {
    $(id).addEventListener("input", () => {
      renderPolicyPreview();
      updateRanking();
      renderBids();
      renderRanking();
    });
    $(id).addEventListener("change", () => {
      renderPolicyPreview();
      updateRanking();
      renderBids();
      renderRanking();
    });
  }
  for (const id of ["bidPrice", "bidPromised", "bidRep"]) {
    $(id).addEventListener("input", renderBidGuard);
  }
  $("acceptBidIndex").addEventListener("input", () => {
    syncFundingFromBid(Number($("acceptBidIndex").value));
    renderRanking();
    renderDetails();
  });

  bind("connectBtn", connect);
  bind("refreshBtn", () => refreshAll());
  bind("openRequestBtn", openRequest);
  bind("cancelRequestBtn", cancelRequest);
  bind("publishHashesBtn", publishHashes);
  bind("loadBidsBtn", loadBids);
  bind("rankBidsBtn", rankBidsAction);
  bind("acceptBidBtn", acceptBid);
  bind("acceptAgentBtn", acceptBidByAgent);
  bind("setAgentBtn", setAgent);
  bind("admitCourierBtn", admitCourier);
  bind("stakeBtn", stake);
  bind("capacityBtn", capacity);
  bind("placeBidBtn", placeBid);
  bind("withdrawBidBtn", withdrawBid);
  bind("pickupBtn", pickup);
  bind("requestWithdrawBtn", requestWithdraw);
  bind("finalizeWithdrawBtn", finalizeWithdraw);
  bind("fundBtn", fundVault);
  bind("vaultStatusBtn", () => refreshVaultStatus(true));
  bind("disputeBtn", () => callVault("buyerAccount", "raiseDispute", "Raise dispute"));
  bind("resolveCourierBtn", () => resolveDispute(true));
  bind("resolveBuyerBtn", () => resolveDispute(false));
  bind("cancelVaultBtn", () => callVault("buyerAccount", "cancelByBuyerPrePickup", "Cancel vault"));
  bind("confirmDeliveryBtn", confirmDelivery);
  bind("finalizeDeliveredBtn", () => callVault("buyerAccount", "finalizeDelivered", "Finalize delivered"));
  bind("refundTimeoutBtn", () => callVault("buyerAccount", "refundOnPickupTimeout", "Refund pickup timeout"));
  bind("slashTimeoutBtn", () => callVault("buyerAccount", "slashOnDropoffTimeout", "Slash dropoff timeout"));
  $("clearLogBtn").addEventListener("click", () => { $("logOutput").innerHTML = ""; });

  await loadDeployment();
  await loadDemoState();
  updateAddresses();
  renderLifecycle();
  renderTrustMatrix();
  renderPolicyPreview();
  renderBidGuard();
  $("networkStatus").textContent = "Ready. Start Hardhat and press Connect.";
}

init().catch(fail);
