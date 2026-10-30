// `npm run dev`: installs packages if missing, compiles, runs the tests,
// then deploys to Sepolia if .env is filled in. Uses only Node built-ins at the start,
// so it works before dependencies are installed.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const run = (cmd) => {
  console.log(`\n> ${cmd}`);
  const r = spawnSync(cmd, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`\nCommand failed: ${cmd}`);
    process.exit(r.status || 1);
  }
};

if (!fs.existsSync(path.join(root, "node_modules", "hardhat"))) {
  console.log("Dependencies not found. Installing...");
  run("npm install");
} else {
  console.log("Dependencies already installed.");
}

const envPath = path.join(root, ".env");
if (!fs.existsSync(envPath)) {
  fs.copyFileSync(path.join(root, ".env.example"), envPath);
  console.log("\nCreated .env from .env.example. Fill it in to deploy to Sepolia.");
}
require("dotenv").config({ path: envPath });

run("npx hardhat compile");
run("npx hardhat test");

const addr = /^0x[0-9a-fA-F]{40}$/;
const keyOk = /^0x[0-9a-fA-F]{64}$/.test(process.env.PRIVATE_KEY || "");
const rpcOk = process.env.SEPOLIA_RPC_URL && !process.env.SEPOLIA_RPC_URL.includes("YOUR");
const groupOk = addr.test(process.env.GROUP1_ADDRESS || "");
const lps = (process.env.LP_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean);
const lpOk = lps.length > 0 && lps.every((a) => addr.test(a));

if (keyOk && rpcOk && groupOk && lpOk) {
  console.log("\n.env is configured: deploying GroupFarm to Sepolia.");
  run("npx hardhat run scripts/deploy.js --network sepolia");
} else {
  console.log("\nTests passed. To deploy to Sepolia, fill in .env:");
  if (!keyOk) console.log("  - PRIVATE_KEY (test wallet, 0x + 64 hex characters)");
  if (!rpcOk) console.log("  - SEPOLIA_RPC_URL");
  if (!groupOk) console.log("  - GROUP1_ADDRESS (your GROUP1 token address)");
  if (!lpOk) console.log("  - LP_TOKENS (pair addresses, separated by commas)");
  console.log("Then run `npm run dev` again.");
}
