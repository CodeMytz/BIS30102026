const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const group1 = process.env.GROUP1_ADDRESS;
  const lpTokens = (process.env.LP_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const minutes = Number(process.env.DURATION_MINUTES || "6");
  const budgetHuman = process.env.BUDGET_PER_POOL || "2000";

  if (!ethers.isAddress(group1)) throw new Error("GROUP1_ADDRESS in .env is not a valid address");
  if (lpTokens.length === 0 || !lpTokens.every((a) => ethers.isAddress(a))) {
    throw new Error("LP_TOKENS in .env must be a comma-separated list of valid pair addresses");
  }
  if (!(minutes > 0)) throw new Error("DURATION_MINUTES must be > 0");

  const duration = BigInt(Math.round(minutes * 60));
  const budget = ethers.parseUnits(budgetHuman, 18);

  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  if (network.name === "sepolia" && chainId !== "11155111") {
    throw new Error("Wrong chain: expected Sepolia (11155111)");
  }

  console.log("Network:        ", network.name, `(chainId ${chainId})`);
  console.log("Deployer:       ", deployer.address);
  console.log("GROUP1:         ", group1);
  console.log("LP tokens:      ", lpTokens.join(", "));
  console.log("Duration:       ", `${minutes} minutes (${duration} s)`);
  console.log("Budget per pool:", budgetHuman, "GROUP1");
  console.log("Total fund:     ", Number(budgetHuman) * lpTokens.length, "GROUP1");

  const Farm = await ethers.getContractFactory("GroupFarm");
  const farm = await Farm.deploy(group1, lpTokens, duration, budget);
  const deployTx = farm.deploymentTransaction();
  console.log("\nTx sent:", deployTx.hash);
  console.log("Waiting for confirmations...");

  const receipt = await deployTx.wait(network.name === "sepolia" ? 2 : 1);
  if (!receipt || receipt.status !== 1) throw new Error("Deployment failed");
  const address = receipt.contractAddress;

  console.log("\nGroupFarm deployed!");
  console.log("Address:", address);
  console.log("Tx hash:", deployTx.hash);

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}-farm.json`);
  const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  list.push({
    address,
    rewardToken: group1,
    lpTokens,
    durationSeconds: duration.toString(),
    budgetPerPool: budgetHuman,
    deployer: deployer.address,
    txHash: deployTx.hash,
    chainId,
    deployedAt: new Date().toISOString(),
  });
  fs.writeFileSync(file, JSON.stringify(list, null, 2));
  console.log("Saved to:", path.relative(process.cwd(), file));
  if (network.name === "sepolia") {
    console.log(`Etherscan: https://sepolia.etherscan.io/address/${address}`);
  }
  console.log("\nNext: run `npm run fund` to send the reward fund and start the campaign.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
