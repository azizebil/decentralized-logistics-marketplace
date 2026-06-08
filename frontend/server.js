const fs = require("fs");
const http = require("http");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const { ethers } = require("ethers");
const { SellerAgent } = require("../agents/seller_agent_core.js");

const root = path.resolve(__dirname, "..");
const publicDir = __dirname;
const port = Number(process.env.FRONTEND_PORT || process.env.PORT || 5173);

// ── Agent state ──────────────────────────────────────────────────────────────

const MAILBOX_STATE_FILE = path.resolve(__dirname, "../agents/.mailbox-state.json");
function loadMailboxState() {
  try { return JSON.parse(fs.readFileSync(MAILBOX_STATE_FILE, "utf8")); } catch { return { lastSign: 0 }; }
}
function saveMailboxState(s) { fs.writeFileSync(MAILBOX_STATE_FILE, JSON.stringify(s, null, 2)); }

function readSensors() {
  const weightGrams = Number(process.env.MAILBOX_WEIGHT_OVERRIDE ?? 250);
  const lidClosed   = process.env.MAILBOX_LID_OVERRIDE !== "open";
  return { ok: weightGrams > 50 && lidClosed, weightGrams, lidClosed };
}

function getDeployment(chainId) {
  const specific = path.join(root, `deployment.${chainId}.json`);
  const fallback  = path.join(root, "deployment.json");
  const file = fs.existsSync(specific) ? specific : fallback;
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function agentSigner(keyEnv, provider) {
  if (!keyEnv || keyEnv.startsWith("idx:")) {
    const idx = keyEnv ? Number(keyEnv.slice(4)) : 4;
    const mnemonic = "test test test test test test test test test test test junk";
    return ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${idx}`).connect(provider);
  }
  return new ethers.Wallet(keyEnv, provider);
}

async function llmExplain(decision, bids) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        messages: [{
          role: "user",
          content:
            "You are reviewing an autonomous courier-bid selection for a decentralized logistics marketplace. " +
            "The winning bid was chosen by the deterministic formula score = r^α / (t × p). " +
            "Explain the ranking in ≤4 sentences for the seller. Don't contradict the choice.\n\n" +
            "Bids:\n" + bids.map((b, i) =>
              `  [${i}] price=${b.price} promisedTime=${b.promisedTime} repE4=${b.reputationE4}`
            ).join("\n") +
            "\n\nWinner index: " + decision.winnerIndex
        }]
      })
    });
    const j = await r.json();
    return j.content?.[0]?.text ?? null;
  } catch { return null; }
}

// ── API request body reader ───────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 64_000) reject(new Error("body too large")); });
    req.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("bad JSON")); } });
    req.on("error", reject);
  });
}

// ── API handlers ─────────────────────────────────────────────────────────────

async function handleAgentRank(req, res) {
  const body = await readBody(req);
  // body: { bids, preferTrusted, maxPriceEth, maxDeadlineSec, declaredValueEth }
  const bids = body.bids ?? [];
  const sa = new SellerAgent({
    preferTrusted:  body.preferTrusted ?? false,
    maxPrice:       body.maxPriceEth    ? ethers.parseEther(String(body.maxPriceEth))    : undefined,
    maxDeadline:    body.maxDeadlineSec ? Number(body.maxDeadlineSec) : undefined,
    declaredValue:  body.declaredValueEth ? ethers.parseEther(String(body.declaredValueEth)) : undefined
  });
  const decision = sa.rank(bids);
  const explanation = await llmExplain(decision, bids);
  send(res, 200, JSON.stringify({ decision, explanation }), types[".json"]);
}

async function handleMailboxConfirm(req, res) {
  const body = await readBody(req);
  // body: { rpcUrl, vaultAddr, code, nonce, mailboxKey }
  const { rpcUrl, vaultAddr, code, nonce, mailboxKey } = body;
  if (!vaultAddr || !code || !nonce) {
    return send(res, 400, JSON.stringify({ error: "missing vaultAddr/code/nonce" }), types[".json"]);
  }

  const st = loadMailboxState();
  if (Date.now() - (st.lastSign || 0) < 60_000) {
    return send(res, 429, JSON.stringify({ error: "rate-limited: wait 60s between confirmations" }), types[".json"]);
  }

  const sensors = readSensors();
  if (!sensors.ok) {
    return send(res, 400, JSON.stringify({ error: "sensor anomaly, refusing to sign", sensors }), types[".json"]);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl || "http://127.0.0.1:8545");
  const VAULT_ABI = require(path.resolve(__dirname, "../artifacts/contracts/DeliveryVault.sol/DeliveryVault.json")).abi;
  const signer = agentSigner(mailboxKey || process.env.MAILBOX_KEY, provider);
  const vault  = new ethers.Contract(vaultAddr, VAULT_ABI, signer);

  const tx   = await vault.confirmDelivery(code, nonce);
  const rcpt = await tx.wait();
  st.lastSign = Date.now();
  saveMailboxState(st);
  send(res, 200, JSON.stringify({ txHash: rcpt.hash, sensors }), types[".json"]);
}

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function safeFile(base, urlPath) {
  const target = path.resolve(base, "." + decodeURIComponent(urlPath));
  return target.startsWith(base) ? target : null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── Agent API ──
  if (req.method === "POST" && url.pathname === "/api/agent/rank") {
    return handleAgentRank(req, res).catch(e =>
      send(res, 500, JSON.stringify({ error: e.message }), types[".json"]));
  }
  if (req.method === "POST" && url.pathname === "/api/agent/mailbox-confirm") {
    return handleMailboxConfirm(req, res).catch(e =>
      send(res, 500, JSON.stringify({ error: e.message }), types[".json"]));
  }

  let file;

  if (url.pathname === "/") {
    file = path.join(publicDir, "index.html");
  } else if (url.pathname === "/vendor/ethers.umd.min.js") {
    file = path.join(root, "node_modules", "ethers", "dist", "ethers.umd.min.js");
  } else if (url.pathname === "/deployment.json") {
    file = path.join(root, "deployment.json");
    if (!fs.existsSync(file)) {
      return send(res, 200, JSON.stringify({ contracts: {} }), types[".json"]);
    }
  } else if (/^\/deployment\.\d+\.json$/.test(url.pathname)) {
    // Chain-specific deployment files, e.g. /deployment.11155111.json
    const name = url.pathname.slice(1); // strip leading /
    file = path.join(root, name);
    if (!fs.existsSync(file)) {
      return send(res, 404, JSON.stringify({ error: "not found" }), types[".json"]);
    }
  } else if (url.pathname === "/frontend-demo.json") {
    file = path.join(root, "frontend-demo.json");
    if (!fs.existsSync(file)) {
      return send(res, 200, JSON.stringify({}), types[".json"]);
    }
  } else if (url.pathname === "/favicon.ico") {
    return send(res, 204, "");
  } else {
    file = safeFile(publicDir, url.pathname);
  }

  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, "Not found");
  }

  send(res, 200, fs.readFileSync(file), types[path.extname(file)] || "application/octet-stream");
});

server.listen(port, () => {
  console.log(`DLM frontend: http://127.0.0.1:${port}`);
});
