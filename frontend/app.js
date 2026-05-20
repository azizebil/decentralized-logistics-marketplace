const { ethers } = window;

const MNEMONIC = "test test test test test test test test test test test junk";
const STAGES = ["None", "Open", "Assigned", "Held", "Finalized", "Cancelled"];
const VAULT_STATES = ["Funded", "PickedUp", "Delivered", "Refunded", "Failed"];

const REGISTRY_ABI = [
  "event RequestOpened(bytes32 indexed deliveryId,address indexed seller,address pool,uint256 declaredValue,uint256 maxPrice,uint256 bidDeadline)",
  "event HashesPublished(bytes32 indexed deliveryId,bytes32 pickupHash,bytes32 dropoffHash)",
  "event BidPlaced(bytes32 indexed deliveryId,uint256 index,address indexed courier,uint256 price,uint256 promisedTime)",
  "event BidAccepted(bytes32 indexed deliveryId,uint256 index,address courier,address vault)",
  "function openRequest(uint256,uint256,uint256,uint256,address,address,address,bool,uint256,uint256) returns (bytes32)",
  "function publishHashes(bytes32,bytes32,bytes32)",
  "function getBids(bytes32) view returns (tuple(address courier,address payout,uint256 price,uint256 promisedTime,uint256 reputationE4,uint64 submittedAt,bool withdrawn)[])",
  "function acceptBid(bytes32,uint256) returns (address)",
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
  "function memberCapBps() view returns (uint256)"
];

const VAULT_ABI = [
  "function fund() payable",
  "function snapshot() view returns (uint8 s,bool isFunded,bool isFinalized,bool isDisputed,uint256 balance)",
  "function raiseDispute()",
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
  "function dropoffDeadline() view returns (uint256)"
];

const $ = (id) => document.getElementById(id);

const state = {
  provider: null,
  registry: null,
  pool: null,
  requests: []
};

function log(message, data) {
  const stamp = new Date().toLocaleTimeString();
  const suffix = data === undefined ? "" : `\n${format(data)}`;
  $("logOutput").textContent = `[${stamp}] ${message}${suffix}\n\n${$("logOutput").textContent}`;
}

function format(value) {
  return JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
}

function fail(error) {
  console.error(error);
  const reason = error?.shortMessage || error?.reason || error?.message || String(error);
  log(`Error: ${reason}`);
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

function updateAddresses() {
  $("sellerAddress").textContent = wallet(Number($("sellerAccount").value)).address;
  $("courierAddress").textContent = wallet(Number($("courierAccount").value)).address;
  $("buyerAddress").textContent = wallet(Number($("buyerAccount").value)).address;
  $("mailboxAddress").textContent = wallet(Number($("mailboxAccount").value)).address;
  if (!$("sellerBuyer").value) $("sellerBuyer").value = $("buyerAddress").textContent;
  if (!$("sellerMailbox").value) $("sellerMailbox").value = $("mailboxAddress").textContent;
}

async function loadDeployment() {
  try {
    const response = await fetch("/deployment.json");
    if (!response.ok) return;
    const deployment = await response.json();
    $("registryAddress").value = deployment.contracts?.MarketplaceRegistry || "";
    $("poolAddress").value = deployment.contracts?.StakingPool || "";
    log("Loaded deployment.json", deployment);
  } catch {
    log("No deployment.json yet. Deploy contracts or paste addresses.");
  }
}

async function loadDemoState() {
  try {
    const response = await fetch("/frontend-demo.json");
    if (!response.ok) return;
    const demo = await response.json();
    if (!demo.deliveryId) return;
    $("deliveryId").value = demo.deliveryId;
    $("vaultAddress").value = demo.vault || "";
    $("pickupCode").value = demo.pickupCode || "";
    $("pickupNonce").value = demo.pickupNonce || "";
    $("dropoffCode").value = demo.dropoffCode || "";
    $("dropoffNonce").value = demo.dropoffNonce || "";
    $("fundEth").value = demo.fundedEth || $("fundEth").value;
    localStorage.setItem("dlm.deliveryId", $("deliveryId").value);
    localStorage.setItem("dlm.vaultAddress", $("vaultAddress").value);
    log("Loaded frontend-demo.json", demo);
  } catch {
    log("No frontend demo state found yet.");
  }
}

async function connect() {
  state.provider = new ethers.JsonRpcProvider($("rpcUrl").value.trim());
  const network = await state.provider.getNetwork();
  $("networkStatus").textContent = `Connected to chain ${network.chainId}`;
  updateAddresses();
  await refreshAll();
}

async function waitTx(tx, label) {
  log(`${label} submitted`, { hash: tx.hash });
  const receipt = await tx.wait();
  log(`${label} confirmed`, { hash: receipt.hash, block: receipt.blockNumber });
  await refreshAll(false);
  return receipt;
}

function setDelivery(id) {
  $("deliveryId").value = id;
  localStorage.setItem("dlm.deliveryId", id);
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
  setVaultAddress(r.vault);
  const out = {
    deliveryId: id,
    seller: r.seller,
    buyer: r.buyer,
    mailbox: r.mailbox,
    pool: r.pool,
    declaredValue: `${ethers.formatEther(r.declaredValue)} ETH`,
    maxPrice: `${ethers.formatEther(r.maxPrice)} ETH`,
    maxDeadline: dateOf(r.maxDeadline),
    bidDeadline: dateOf(r.bidDeadline),
    stage: STAGES[Number(r.stage)],
    preferTrusted: r.preferTrusted,
    disputeWindow: `${r.disputeWindow}s`,
    acceptedBidIndex: r.acceptedBidIndex.toString(),
    vault: r.vault,
    pickupHash: r.pickupHash,
    dropoffHash: r.dropoffHash
  };
  $("detailsOutput").textContent = format(out);
  await refreshVaultStatus(false);
}

async function refreshVaultStatus(writeLog = true) {
  const addr = $("vaultAddress").value.trim();
  if (!state.provider || !ethers.isAddress(addr)) return;
  const v = new ethers.Contract(addr, VAULT_ABI, state.provider);
  const [snap, buyer, courier, fee, value, pickupDeadline, dropoffDeadline] = await Promise.all([
    v.snapshot(),
    v.buyer(),
    v.courier(),
    v.courierFee(),
    v.declaredValue(),
    v.pickupDeadline(),
    v.dropoffDeadline()
  ]);
  const out = {
    vault: addr,
    state: VAULT_STATES[Number(snap.s)],
    funded: snap.isFunded,
    finalized: snap.isFinalized,
    disputed: snap.isDisputed,
    balance: `${ethers.formatEther(snap.balance)} ETH`,
    buyer,
    courier,
    courierFee: `${ethers.formatEther(fee)} ETH`,
    declaredValue: `${ethers.formatEther(value)} ETH`,
    pickupDeadline: dateOf(pickupDeadline),
    dropoffDeadline: dateOf(dropoffDeadline)
  };
  if (writeLog) log("Vault status", out);
  $("detailsOutput").textContent = `${$("detailsOutput").textContent}\n\nVault:\n${format(out)}`;
}

async function refreshAll(writeLog = true) {
  await refreshRequests();
  await refreshDetails();
  if (writeLog) log("Refreshed frontend data");
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
  $("codeOutput").innerHTML = `<div class="item"><strong>Codes saved in this browser</strong><pre>${format(codes)}</pre></div>`;
  await waitTx(await registry("sellerAccount").publishHashes(id, pickupHash, dropoffHash), "Publish hashes");
}

async function loadBids() {
  const bids = await registry("sellerAccount").getBids(selectedId());
  $("bidsList").innerHTML = "";
  bids.forEach((bid, index) => {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `<strong>Bid ${index}${bid.withdrawn ? " - withdrawn" : ""}</strong>
      Courier: ${bid.courier}<br>
      Price: ${ethers.formatEther(bid.price)} ETH<br>
      Promised: ${dateOf(bid.promisedTime)}<br>
      Reputation: ${Number(bid.reputationE4) / 100}%`;
    $("bidsList").appendChild(el);
  });
  log(`Loaded ${bids.length} bids`);
}

async function acceptBid() {
  const reg = registry("sellerAccount");
  const receipt = await waitTx(await reg.acceptBid(selectedId(), Number($("acceptBidIndex").value)), "Accept bid");
  const parsed = receipt.logs.map((l) => { try { return reg.interface.parseLog(l); } catch { return null; } })
    .find((event) => event?.name === "BidAccepted");
  if (parsed) setVaultAddress(parsed.args.vault);
}

async function setAgent() {
  await waitTx(await registry("sellerAccount").setAgentPolicy(
    $("agentAddress").value.trim(),
    ethers.parseEther($("agentMaxPrice").value),
    Number($("agentDeadlineBuffer").value),
    ethers.parseEther($("agentCosign").value)
  ), "Set agent policy");
}

async function admitCourier() {
  await waitTx(await pool("operatorAccount").admitMember(signer("courierAccount").address), "Admit courier");
}

async function stake() {
  await waitTx(await pool("courierAccount").depositStake({ value: ethers.parseEther($("stakeEth").value) }), "Stake");
  await capacity();
}

async function capacity() {
  const p = pool("courierAccount");
  const addr = signer("courierAccount").address;
  const [free, member, total, active, cap] = await Promise.all([
    p.freeCapacityFor(addr),
    p.members(addr),
    p.totalStake(),
    p.activeValue(),
    p.memberCapBps()
  ]);
  const text = `Capacity: ${ethers.formatEther(free)} ETH`;
  $("capacityOutput").textContent = text;
  log("Courier capacity", {
    courier: addr,
    isMember: member.isMember,
    contribution: `${ethers.formatEther(member.contribution)} ETH`,
    reserved: `${ethers.formatEther(member.reserved)} ETH`,
    free: `${ethers.formatEther(free)} ETH`,
    poolTotal: `${ethers.formatEther(total)} ETH`,
    activeValue: `${ethers.formatEther(active)} ETH`,
    memberCapBps: cap.toString()
  });
}

async function placeBid() {
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

function short(value) {
  return value ? `${value.slice(0, 10)}...${value.slice(-6)}` : "";
}

function dateOf(value) {
  return new Date(Number(value) * 1000).toLocaleString();
}

function bind(id, fn) {
  $(id).addEventListener("click", () => fn().catch(fail));
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
  const operator = document.createElement("select");
  operator.id = "operatorAccount";
  operator.hidden = true;
  accountOptions(operator, 1);
  document.body.appendChild(operator);

  persistInputs();
  for (const id of ["sellerAccount", "courierAccount", "buyerAccount", "mailboxAccount"]) {
    $(id).addEventListener("change", updateAddresses);
  }

  bind("connectBtn", connect);
  bind("refreshBtn", () => refreshAll());
  bind("openRequestBtn", openRequest);
  bind("publishHashesBtn", publishHashes);
  bind("loadBidsBtn", loadBids);
  bind("acceptBidBtn", acceptBid);
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
  bind("cancelVaultBtn", () => callVault("buyerAccount", "cancelByBuyerPrePickup", "Cancel vault"));
  bind("confirmDeliveryBtn", confirmDelivery);
  bind("finalizeDeliveredBtn", () => callVault("buyerAccount", "finalizeDelivered", "Finalize delivered"));
  bind("refundTimeoutBtn", () => callVault("buyerAccount", "refundOnPickupTimeout", "Refund pickup timeout"));
  bind("slashTimeoutBtn", () => callVault("buyerAccount", "slashOnDropoffTimeout", "Slash dropoff timeout"));
  $("clearLogBtn").addEventListener("click", () => { $("logOutput").textContent = ""; });

  await loadDeployment();
  await loadDemoState();
  updateAddresses();
  $("networkStatus").textContent = "Ready. Start Hardhat and press Connect.";
}

init().catch(fail);
