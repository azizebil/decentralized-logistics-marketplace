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
  requests: [],
  selectedRequest: null,
  selectedVault: null,
  mm: { provider: null, signer: null, address: null, chainId: null, active: false }
};

// ── Logging ───────────────────────────────────────────────────────────────────

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

// ── Signer resolution ─────────────────────────────────────────────────────────
// In MetaMask mode every action is signed by the connected wallet.
// The operator (admit/pool admin) always uses the HD-wallet slot 1, even in
// MetaMask mode, because it is a dev/admin key not held by end users.

function wallet(index) {
  const base = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
  return state.provider ? base.connect(state.provider) : base;
}

function signer(role) {
  if (state.mm.active) return state.mm.signer;
  return wallet(Number($(role).value));
}

function operatorSigner() {
  // Always the HD-wallet operator regardless of MetaMask mode
  return wallet(Number($("operatorAccount").value));
}

// ── Contract helpers ──────────────────────────────────────────────────────────

function contract(address, abi, signerObj) {
  if (!state.provider) throw new Error("Not connected — press Dev Connect or Connect Wallet.");
  if (!address || !ethers.isAddress(address)) throw new Error("Missing or invalid contract address.");
  return new ethers.Contract(address, abi, signerObj);
}

function registry(role) {
  return contract($("registryAddress").value.trim(), REGISTRY_ABI, signer(role));
}

function pool(role) {
  return contract($("poolAddress").value.trim(), POOL_ABI, signer(role));
}

function poolAsOperator() {
  return contract($("poolAddress").value.trim(), POOL_ABI, operatorSigner());
}

function vault(role) {
  return contract($("vaultAddress").value.trim(), VAULT_ABI, signer(role));
}

function selectedId() {
  const id = $("deliveryId").value.trim();
  if (!id) throw new Error("Delivery ID is required.");
  return id;
}

function future(seconds) {
  return Math.floor(Date.now() / 1000) + Number(seconds);
}

// ── Account dropdowns ─────────────────────────────────────────────────────────

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
  if (state.mm.active) {
    const addr = state.mm.address;
    $("sellerAddress").textContent  = addr;
    $("courierAddress").textContent = addr;
    $("buyerAddress").textContent   = addr;
    $("mailboxAddress").textContent = addr;
  } else {
    $("sellerAddress").textContent  = wallet(Number($("sellerAccount").value)).address;
    $("courierAddress").textContent = wallet(Number($("courierAccount").value)).address;
    $("buyerAddress").textContent   = wallet(Number($("buyerAccount").value)).address;
    $("mailboxAddress").textContent = wallet(Number($("mailboxAccount").value)).address;
    if (!$("sellerBuyer").value)   $("sellerBuyer").value   = $("buyerAddress").textContent;
    if (!$("sellerMailbox").value) $("sellerMailbox").value = $("mailboxAddress").textContent;
  }
}

// ── MetaMask ──────────────────────────────────────────────────────────────────

function networkName(chainId) {
  const id = BigInt(chainId);
  const map = { 1n: "Mainnet", 5n: "Goerli", 11155111n: "Sepolia", 31337n: "Hardhat Local" };
  return map[id] ?? `Chain ${chainId}`;
}

function updateWalletUI() {
  const { active, address, chainId } = state.mm;
  $("metamaskBtn").hidden  = active;
  $("walletBadge").hidden  = !active;
  $("devBar").style.opacity = active ? "0.45" : "1";

  if (active) {
    $("walletAddress").textContent = short(address);
    $("walletNetwork").textContent = networkName(chainId);
    $("networkStatus").textContent = `${networkName(chainId)} · ${short(address)}`;

    const onSupportedNet = BigInt(chainId) === 31337n || BigInt(chainId) === 11155111n;
    $("wrongNetBar").hidden = onSupportedNet;
  }

  // Show/hide dev-only dropdowns based on mode
  const devOnly = document.querySelectorAll(".dev-only");
  devOnly.forEach(el => { el.style.display = active ? "none" : ""; });

  updateAddresses();
}

async function connectMetaMask() {
  if (!window.ethereum) {
    fail(new Error("MetaMask is not installed. Add the MetaMask browser extension and refresh."));
    return;
  }
  try {
    const mmProvider = new ethers.BrowserProvider(window.ethereum);
    await mmProvider.send("wallet_requestPermissions", [{ eth_accounts: {} }]);
    const mmSigner  = await mmProvider.getSigner();
    const network   = await mmProvider.getNetwork();
    const address   = await mmSigner.getAddress();

    state.mm.provider = mmProvider;
    state.mm.signer   = mmSigner;
    state.mm.address  = address;
    state.mm.chainId  = network.chainId;
    state.mm.active   = true;
    state.provider    = mmProvider;

    updateWalletUI();
    await loadDeployment();
    await refreshAll();

    log("Wallet connected", `${short(address)} on ${networkName(network.chainId)}`);

    window.ethereum.on("accountsChanged", onAccountsChanged);
    window.ethereum.on("chainChanged",    onChainChanged);
  } catch (e) {
    fail(e);
  }
}

function disconnectMetaMask() {
  if (window.ethereum?.removeListener) {
    window.ethereum.removeListener("accountsChanged", onAccountsChanged);
    window.ethereum.removeListener("chainChanged",    onChainChanged);
  }
  state.mm = { provider: null, signer: null, address: null, chainId: null, active: false };
  state.provider = null;
  $("networkStatus").textContent = "Disconnected";
  $("wrongNetBar").hidden = true;
  updateWalletUI();
  log("Wallet disconnected", "Back to dev mode. Press Dev Connect to reconnect to RPC.");
}

async function onAccountsChanged(accounts) {
  if (!accounts.length) { disconnectMetaMask(); return; }
  const mmSigner     = await state.mm.provider.getSigner();
  state.mm.signer    = mmSigner;
  state.mm.address   = accounts[0];
  updateWalletUI();
  await refreshAll(false);
  log("Account changed", `Now using ${short(accounts[0])}`);
}

function onChainChanged() {
  // MetaMask recommends a full reload on chain change
  window.location.reload();
}

async function addHardhatNetwork() {
  if (!window.ethereum) return;
  try {
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId:          "0x7A69",       // 31337
        chainName:        "Hardhat Local",
        nativeCurrency:   { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls:          ["http://127.0.0.1:8545"],
        blockExplorerUrls: null
      }]
    });
  } catch (e) {
    fail(e);
  }
}

// ── Dev-mode RPC connect ──────────────────────────────────────────────────────

async function connect() {
  state.provider = new ethers.JsonRpcProvider($("rpcUrl").value.trim());
  const network  = await state.provider.getNetwork();
  $("networkStatus").textContent = `Dev · Chain ${network.chainId}`;
  log("Dev connected", `Local chain ${network.chainId}.`);
  updateAddresses();
  await refreshAll();
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadDeployment() {
  try {
    // Prefer a chain-specific file when connected to a non-local network
    const chainId = state.mm.active
      ? Number(state.mm.chainId)
      : (state.provider ? Number((await state.provider.getNetwork()).chainId) : 31337);

    const urls = chainId === 31337
      ? ["/deployment.json"]
      : [`/deployment.${chainId}.json`, "/deployment.json"];

    let deployment = null;
    for (const url of urls) {
      const res = await fetch(url);
      if (res.ok) { deployment = await res.json(); break; }
    }
    if (!deployment) return;

    $("registryAddress").value = deployment.contracts?.MarketplaceRegistry || "";
    $("poolAddress").value     = deployment.contracts?.StakingPool          || "";
    const net = deployment.network || `chain ${chainId}`;
    log("Deployment loaded", `Registry and staking pool addresses ready (${net}).`);
  } catch {
    log("Deployment not found", "Deploy contracts or paste addresses manually.");
  }
}

async function loadDemoState() {
  try {
    const response = await fetch("/frontend-demo.json");
    if (!response.ok) return;
    const demo = await response.json();
    if (!demo.deliveryId) return;
    // Don't overwrite a delivery ID the user already has in this session
    if ($("deliveryId").value.trim()) return;
    $("deliveryId").value   = demo.deliveryId;
    $("vaultAddress").value = demo.vault      || "";
    $("pickupCode").value   = demo.pickupCode || "";
    $("pickupNonce").value  = demo.pickupNonce|| "";
    $("dropoffCode").value  = demo.dropoffCode|| "";
    $("dropoffNonce").value = demo.dropoffNonce|| "";
    $("fundEth").value      = demo.fundedEth  || $("fundEth").value;
    localStorage.setItem("dlm.deliveryId",   $("deliveryId").value);
    localStorage.setItem("dlm.vaultAddress", $("vaultAddress").value);
    log("Demo loaded", `Delivery ${short(demo.deliveryId)} is ready to inspect.`);
  } catch {
    log("No demo loaded", "Run demo:frontend to prefill a sample delivery.");
  }
}

// ── Tx helper ─────────────────────────────────────────────────────────────────

async function waitTx(tx, label) {
  log(`${label} started`, `Transaction ${short(tx.hash)} is waiting for confirmation.`);
  const receipt = await tx.wait();
  log(`${label} complete`, `Confirmed in block ${receipt.blockNumber}.`);
  await refreshAll(false);
  return receipt;
}

// ── State helpers ─────────────────────────────────────────────────────────────

function setDelivery(id) {
  $("deliveryId").value = id;
  localStorage.setItem("dlm.deliveryId", id);
  const saved = localStorage.getItem(`dlm.codes.${id}`);
  if (saved) {
    try {
      const codes = JSON.parse(saved);
      $("pickupCode").value   = codes.pickupCode  || "";
      $("pickupNonce").value  = codes.nonceP       || "";
      $("dropoffCode").value  = codes.dropoffCode  || "";
      $("dropoffNonce").value = codes.nonceD       || "";
    } catch {}
  }
}

function setVaultAddress(address) {
  if (address && address !== ethers.ZeroAddress) {
    $("vaultAddress").value = address;
    localStorage.setItem("dlm.vaultAddress", address);
  }
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function refreshRequests() {
  const addr = $("registryAddress").value.trim();
  if (!state.provider || !ethers.isAddress(addr)) return;
  const readRegistry = new ethers.Contract(addr, REGISTRY_ABI, state.provider);

  let events = [];
  try {
    const latest = await state.provider.getBlockNumber();
    events = await readRegistry.queryFilter(readRegistry.filters.RequestOpened(), latest - 8, latest);
  } catch { /* Alchemy free tier block range limit — fall through */ }

  state.requests = events.map(e => ({
    id:           e.args.deliveryId,
    seller:       e.args.seller,
    pool:         e.args.pool,
    declaredValue:e.args.declaredValue,
    maxPrice:     e.args.maxPrice,
    bidDeadline:  e.args.bidDeadline
  })).reverse();

  // Always show the saved delivery ID at the top so the user can re-select it
  const savedId = localStorage.getItem("dlm.deliveryId");
  if (savedId && !state.requests.find(r => r.id === savedId)) {
    state.requests.unshift({ id: savedId, _pinned: true });
  }

  $("requestsList").innerHTML = "";
  for (const r of state.requests.slice(0, 12)) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "item";
    el.innerHTML = r._pinned
      ? `<strong>${short(r.id)}</strong><span style="opacity:0.6">current delivery</span>`
      : `<strong>${short(r.id)}</strong>${ethers.formatEther(r.declaredValue)} ETH value · max fee ${ethers.formatEther(r.maxPrice)} ETH`;
    el.addEventListener("click", async () => {
      setDelivery(r.id);
      await refreshDetails();
      await loadBids();
    });
    $("requestsList").appendChild(el);
  }
}

async function refreshDetails() {
  const id      = $("deliveryId").value.trim();
  const regAddr = $("registryAddress").value.trim();
  if (!state.provider || !id || !ethers.isAddress(regAddr)) return;
  const readRegistry = new ethers.Contract(regAddr, REGISTRY_ABI, state.provider);
  const r = await readRegistry.getRequest(id);
  setVaultAddress(r.vault);
  state.selectedRequest = {
    deliveryId:       id,
    seller:           r.seller,
    buyer:            r.buyer,
    mailbox:          r.mailbox,
    pool:             r.pool,
    declaredValue:    r.declaredValue,
    maxPrice:         r.maxPrice,
    maxDeadline:      r.maxDeadline,
    bidDeadline:      r.bidDeadline,
    stage:            STAGES[Number(r.stage)],
    preferTrusted:    r.preferTrusted,
    disputeWindow:    `${r.disputeWindow}s`,
    acceptedBidIndex: r.acceptedBidIndex.toString(),
    vault:            r.vault,
    pickupHash:       r.pickupHash,
    dropoffHash:      r.dropoffHash
  };
  renderDetails();
  await refreshVaultStatus(false);
}

async function refreshVaultStatus(writeLog = true) {
  const addr = $("vaultAddress").value.trim();
  if (!state.provider || !ethers.isAddress(addr)) return;
  const v = new ethers.Contract(addr, VAULT_ABI, state.provider);
  const [snap, buyer, courier, fee, value, pickupDeadline, dropoffDeadline] = await Promise.all([
    v.snapshot(), v.buyer(), v.courier(), v.courierFee(),
    v.declaredValue(), v.pickupDeadline(), v.dropoffDeadline()
  ]);
  state.selectedVault = {
    vault:          addr,
    state:          VAULT_STATES[Number(snap.s)],
    funded:         snap.isFunded,
    finalized:      snap.isFinalized,
    disputed:       snap.isDisputed,
    balance:        `${ethers.formatEther(snap.balance)} ETH`,
    buyer,
    courier,
    courierFee:     `${ethers.formatEther(fee)} ETH`,
    declaredValue:  `${ethers.formatEther(value)} ETH`,
    pickupDeadline: dateOf(pickupDeadline),
    dropoffDeadline:dateOf(dropoffDeadline)
  };
  if (writeLog) log("Vault checked", `Status is ${deliveryProgressLabel(state.selectedVault)}; balance ${state.selectedVault.balance}.`);
  renderDetails();
}

async function refreshAll(writeLog = true) {
  await refreshRequests();
  await refreshDetails();
  if (writeLog) log("Data refreshed", "Requests and vault state are up to date.");
}

// ── Seller actions ────────────────────────────────────────────────────────────

async function openRequest() {
  const reg = registry("sellerAccount");
  const tx  = await reg.openRequest(
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
  const parsed  = receipt.logs
    .map(l => { try { return reg.interface.parseLog(l); } catch { return null; } })
    .find(e => e?.name === "RequestOpened");
  if (parsed) setDelivery(parsed.args.deliveryId);
}

async function publishHashes() {
  const id = selectedId();
  // If codes already exist for this delivery, reuse them (don't regenerate)
  const existing = localStorage.getItem(`dlm.codes.${id}`);
  let codes;
  if (existing) {
    codes = JSON.parse(existing);
  } else {
    const pickupCode  = ethers.toUtf8Bytes(`PICKUP-${ethers.hexlify(ethers.randomBytes(8))}`);
    const dropoffCode = ethers.toUtf8Bytes(`DROPOFF-${ethers.hexlify(ethers.randomBytes(8))}`);
    const nonceP      = ethers.id(`p-${Date.now()}-${Math.random()}`);
    const nonceD      = ethers.id(`d-${Date.now()}-${Math.random()}`);
    const pickupHash  = ethers.keccak256(ethers.concat([pickupCode, id, nonceP]));
    const dropoffHash = ethers.keccak256(ethers.concat([dropoffCode, id, nonceD]));
    codes = { deliveryId: id, pickupCode: ethers.hexlify(pickupCode), dropoffCode: ethers.hexlify(dropoffCode), nonceP, nonceD, pickupHash, dropoffHash };
    localStorage.setItem(`dlm.codes.${id}`, format(codes));
  }
  $("pickupCode").value  = codes.pickupCode;
  $("pickupNonce").value = codes.nonceP;
  $("dropoffCode").value = codes.dropoffCode;
  $("dropoffNonce").value= codes.nonceD;
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
  await waitTx(await registry("sellerAccount").publishHashes(id, codes.pickupHash, codes.dropoffHash), "Publish hashes");
}

async function loadBids() {
  const bids = await registry("sellerAccount").getBids(selectedId());
  state.lastBids = bids; // store for AI pick
  $("bidsList").innerHTML = "";
  bids.forEach((bid, index) => {
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `<strong>Bid ${index}${bid.withdrawn ? " · withdrawn" : ""}</strong>
      Courier: ${bid.courier}<br>
      Price: ${ethers.formatEther(bid.price)} ETH · Promised: ${dateOf(bid.promisedTime)}<br>
      Reputation: ${Number(bid.reputationE4) / 100}%`;
    $("bidsList").appendChild(el);
  });
  log("Bids loaded", `${bids.length} bid${bids.length === 1 ? "" : "s"} for this delivery.`);
}

async function acceptBid() {
  const reg     = registry("sellerAccount");
  const receipt = await waitTx(await reg.acceptBid(selectedId(), Number($("acceptBidIndex").value)), "Accept bid");
  const parsed  = receipt.logs
    .map(l => { try { return reg.interface.parseLog(l); } catch { return null; } })
    .find(e => e?.name === "BidAccepted");
  if (parsed) setVaultAddress(parsed.args.vault);
}

async function aiPickBid() {
  const bidsRaw = state.lastBids;
  if (!bidsRaw || bidsRaw.length === 0) {
    log("AI Pick", "No bids loaded — click Load Bids first.");
    return;
  }
  $("aiExplanation").hidden = true;
  log("AI Pick", "Ranking bids with SellerAgent…");

  const bids = bidsRaw.map(b => ({
    price:        b.price.toString(),
    promisedTime: b.promisedTime.toString(),
    reputationE4: b.reputationE4.toString(),
    withdrawn:    b.withdrawn
  }));

  const req = state.selectedRequest;
  const body = {
    bids,
    preferTrusted:  $("sellerPreferTrusted").checked,
    maxPriceEth:    $("sellerMaxPrice").value,
    maxDeadlineSec: req ? req.maxDeadline.toString() : undefined,
    declaredValueEth: req ? ethers.formatEther(req.declaredValue) : undefined
  };

  const res = await fetch("/api/agent/rank", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok || data.error) { fail(new Error(data.error || "agent/rank failed")); return; }

  const { decision, explanation } = data;
  const winner = decision.winnerIndex;

  if (winner < 0) {
    log("AI Pick — no eligible bid", "All bids were filtered (price/deadline exceeded or withdrawn).");
    return;
  }

  $("acceptBidIndex").value = winner;

  const scored = decision.scored.map(s =>
    `  [${s.index}] ${s.score === -Infinity ? "❌ " + s.reason : "score " + Number(s.score).toExponential(3)}`
  ).join("\n");

  log("AI Pick — winner: bid #" + winner,
    `Ranking:\n${scored}` + (explanation ? `\n\nLLM reasoning:\n${explanation}` : "")
  );

  if (explanation) {
    $("aiExplanation").textContent = explanation;
    $("aiExplanation").hidden = false;
  }
}

async function aiMailboxConfirm() {
  const vaultAddr = $("vaultAddress").value.trim();
  const code      = $("dropoffCode").value.trim();
  const nonce     = $("dropoffNonce").value.trim();
  if (!vaultAddr || !code || !nonce) {
    log("AI Mailbox", "Fill in Vault address, Dropoff code and Dropoff nonce first.");
    return;
  }

  const rpcUrl = state.mm.active
    ? null
    : ($("rpcUrl").value.trim() || "http://127.0.0.1:8545");

  log("AI Mailbox Agent", "Running sensor check + calling confirmDelivery on-chain…");

  const res = await fetch("/api/agent/mailbox-confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rpcUrl, vaultAddr, code, nonce })
  });
  const data = await res.json();
  if (!res.ok || data.error) { fail(new Error(data.reason ? `${data.error}: ${data.reason}` : (data.error || "mailbox-confirm failed"))); return; }

  log("AI Mailbox — delivery confirmed ✓",
    `Tx: ${data.txHash}\nSensors: weight ${data.sensors.weightGrams}g, lid ${data.sensors.lidClosed ? "closed" : "open"}.\nAI reasoning: ${data.aiReason}`
  );
  await refreshAll();
}

async function setAgent() {
  await waitTx(await registry("sellerAccount").setAgentPolicy(
    $("agentAddress").value.trim(),
    ethers.parseEther($("agentMaxPrice").value),
    Number($("agentDeadlineBuffer").value),
    ethers.parseEther($("agentCosign").value)
  ), "Set agent policy");
}

// ── Courier actions ───────────────────────────────────────────────────────────

async function admitCourier() {
  const courierAddr = state.mm.active
    ? state.mm.address
    : wallet(Number($("courierAccount").value)).address;

  if (state.mm.active) {
    // On Sepolia: server uses DEPLOYER_KEY to call admitMember server-side
    log("Auto-admitting courier via server key…", "", "info");
    const resp = await fetch("/api/admin/admit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        courierAddress: courierAddr,
        rpcUrl:         $("rpcUrl").value.trim(),
        poolAddress:    $("poolAddress").value.trim()
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "admit failed");
    log("Courier admitted (server-signed)", `tx ${data.txHash}`, "ok");
  } else {
    await waitTx(await poolAsOperator().admitMember(courierAddr), "Admit courier");
  }
}

async function stake() {
  await waitTx(await pool("courierAccount").depositStake({ value: ethers.parseEther($("stakeEth").value) }), "Stake");
  await capacity();
}

async function capacity() {
  const p    = pool("courierAccount");
  const addr = state.mm.active ? state.mm.address : wallet(Number($("courierAccount").value)).address;
  const [free, member, total, active, cap] = await Promise.all([
    p.freeCapacityFor(addr), p.members(addr),
    p.totalStake(), p.activeValue(), p.memberCapBps()
  ]);
  $("capacityOutput").textContent = `Capacity: ${ethers.formatEther(free)} ETH free`;
  log("Courier capacity checked",
    `${member.isMember ? "Member" : "Not a pool member"} · free ${ethers.formatEther(free)} ETH · staked ${ethers.formatEther(member.contribution)} ETH · reserved ${ethers.formatEther(member.reserved)} ETH. Pool total ${ethers.formatEther(total)} ETH, active ${ethers.formatEther(active)} ETH, member cap ${Number(cap) / 100}%.`
  );
}

async function placeBid() {
  await waitTx(await registry("courierAccount").placeBid(
    selectedId(),
    $("bidPayout").value.trim() || (state.mm.active ? state.mm.address : wallet(Number($("courierAccount").value)).address),
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

// ── Buyer / mailbox actions ───────────────────────────────────────────────────

async function fundVault() {
  await waitTx(await vault("buyerAccount").fund({ value: ethers.parseEther($("fundEth").value) }), "Fund vault");
}

async function confirmDelivery() {
  await waitTx(await vault("mailboxAccount").confirmDelivery($("dropoffCode").value.trim(), $("dropoffNonce").value.trim()), "Confirm delivery");
}

async function callVault(role, method, label) {
  await waitTx(await vault(role)[method](), label);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function short(value) {
  return value ? `${value.slice(0, 8)}…${value.slice(-5)}` : "";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c]));
}

function statusClass(value) {
  return `status-${String(value || "").replace(/[\s/,]+/g, "").toLowerCase()}`;
}

function statusPill(value) {
  return `<span class="status-pill ${statusClass(value)}">${escapeHtml(value)}</span>`;
}

function deliveryProgressLabel(v) {
  if (!v) return "Not assigned yet";
  if (v.finalized) return "Paid out";
  if (v.state === "Funded" && !v.funded) return "Waiting for buyer funding";
  if (v.state === "Funded")    return "Ready for pickup";
  if (v.state === "PickedUp")  return "Package picked up";
  if (v.state === "Delivered") return "Delivered, waiting for payout";
  if (v.state === "Refunded")  return "Refunded";
  if (v.state === "Failed")    return "Failed";
  return v.state;
}

function row(label, value) {
  return `<div class="summary-row"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
}

function textRow(label, value) { return row(label, escapeHtml(value)); }

function card(title, rows) {
  return `<section class="summary-card"><h4>${escapeHtml(title)}</h4>${rows.join("")}</section>`;
}

function renderDetails() {
  const req  = state.selectedRequest;
  const vlt  = state.selectedVault;
  if (!req && !vlt) {
    $("detailsOutput").className   = "details-empty";
    $("detailsOutput").textContent = "No request selected.";
    return;
  }
  $("detailsOutput").className = "summary-stack";
  const cards = [];
  if (req) {
    const progress = vlt ? deliveryProgressLabel(vlt) : req.stage;
    cards.push(card("Selected Delivery", [
      row("Progress",       statusPill(progress)),
      textRow("Delivery",   short(req.deliveryId)),
      textRow("Value",      ethers.formatEther(req.declaredValue) + " ETH"),
      textRow("Max fee",    ethers.formatEther(req.maxPrice) + " ETH"),
      textRow("Bids close", dateOf(req.bidDeadline)),
      textRow("Due by",     dateOf(req.maxDeadline)),
      textRow("Accepted bid", req.stage === "Open" ? "Not selected yet" : `Bid ${req.acceptedBidIndex}`),
      textRow("Trusted courier", req.preferTrusted ? "Preferred" : "Not required")
    ]));
    cards.push(card("People", [
      textRow("Seller",  short(req.seller)),
      textRow("Buyer",   short(req.buyer)),
      textRow("Mailbox", short(req.mailbox)),
      textRow("Pool",    short(req.pool))
    ]));
  }
  if (vlt) {
    cards.push(card("Vault", [
      row("Escrow",          statusPill(deliveryProgressLabel(vlt))),
      textRow("Funded",      vlt.funded    ? "Yes" : "No"),
      textRow("Disputed",    vlt.disputed  ? "Yes" : "No"),
      textRow("Balance",     vlt.balance),
      textRow("Courier fee", vlt.courierFee),
      textRow("Courier",     short(vlt.courier)),
      textRow("Pickup deadline",  vlt.pickupDeadline),
      textRow("Dropoff deadline", vlt.dropoffDeadline)
    ]));
  }
  $("detailsOutput").innerHTML = cards.join("");
}

function dateOf(value) {
  return new Date(Number(value) * 1000).toLocaleString();
}

// ── Persistence ───────────────────────────────────────────────────────────────

function persistInputs() {
  for (const id of ["rpcUrl", "registryAddress", "poolAddress", "deliveryId", "vaultAddress"]) {
    const saved = localStorage.getItem(`dlm.${id}`);
    if (saved) $(id).value = saved;
    $(id).addEventListener("input", () => localStorage.setItem(`dlm.${id}`, $(id).value));
  }
}

function bind(id, fn) {
  $(id).addEventListener("click", () => fn().catch(fail));
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Hidden operator select (always HD wallet)
  const operator = document.createElement("select");
  operator.id = "operatorAccount";
  operator.hidden = true;
  for (let i = 0; i < 10; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `idx:${i}`;
    operator.appendChild(opt);
  }
  operator.value = "1";
  document.body.appendChild(operator);

  accountOptions($("sellerAccount"),  2);
  accountOptions($("courierAccount"), 5);
  accountOptions($("buyerAccount"),   3);
  accountOptions($("mailboxAccount"), 4);

  persistInputs();

  for (const id of ["sellerAccount", "courierAccount", "buyerAccount", "mailboxAccount"]) {
    $(id).addEventListener("change", updateAddresses);
  }

  // Dev connect
  bind("connectBtn",   connect);
  bind("refreshBtn",   () => refreshAll());

  // MetaMask
  bind("metamaskBtn",  connectMetaMask);
  bind("disconnectBtn",disconnectMetaMask);
  bind("addNetworkBtn",addHardhatNetwork);

  // Seller
  bind("openRequestBtn",   openRequest);
  bind("publishHashesBtn", publishHashes);
  bind("loadBidsBtn",      loadBids);
  bind("acceptBidBtn",     acceptBid);
  bind("aiPickBidBtn",     aiPickBid);
  bind("setAgentBtn",      setAgent);

  // Courier
  bind("admitCourierBtn",    admitCourier);
  bind("stakeBtn",           stake);
  bind("capacityBtn",        capacity);
  bind("placeBidBtn",        placeBid);
  bind("withdrawBidBtn",     withdrawBid);
  bind("pickupBtn",          pickup);
  bind("requestWithdrawBtn", requestWithdraw);
  bind("finalizeWithdrawBtn",finalizeWithdraw);

  // Buyer / mailbox
  bind("fundBtn",            fundVault);
  bind("vaultStatusBtn",     () => refreshVaultStatus(true));
  bind("disputeBtn",         () => callVault("buyerAccount", "raiseDispute",           "Raise dispute"));
  bind("cancelVaultBtn",     () => callVault("buyerAccount", "cancelByBuyerPrePickup", "Cancel vault"));
  bind("confirmDeliveryBtn", confirmDelivery);
  bind("aiMailboxBtn",       aiMailboxConfirm);
  bind("finalizeDeliveredBtn",() => callVault("buyerAccount", "finalizeDelivered",     "Finalize delivered"));
  bind("refundTimeoutBtn",   () => callVault("buyerAccount", "refundOnPickupTimeout",  "Refund pickup timeout"));
  bind("slashTimeoutBtn",    () => callVault("buyerAccount", "slashOnDropoffTimeout",  "Slash dropoff timeout"));

  $("clearLogBtn").addEventListener("click", () => { $("logOutput").innerHTML = ""; });

  await loadDeployment();
  await loadDemoState();
  updateAddresses();
  $("networkStatus").textContent = "Ready — Dev Connect or Connect Wallet to begin.";
}

init().catch(fail);
