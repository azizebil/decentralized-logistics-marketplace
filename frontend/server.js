const fs = require("fs");
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..");
const publicDir = __dirname;
const port = Number(process.env.FRONTEND_PORT || process.env.PORT || 5173);

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
