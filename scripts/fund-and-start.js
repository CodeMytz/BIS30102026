// Sends the GROUP1 reward fund to the farm (from the deployer wallet, which must hold
// the GROUP1) and calls startSession(). Uses the latest farm in deployments/ unless
// FARM_ADDRESS is set in .env.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// public RPCs are load-balanced and can lag: retry until the check passes
async function waitFor(label, fn, tries = 15, delayMs = 4000) {
  for (let i = 1; i <= tries; i++) {
    if (await fn()) return;
    console.log(`  (${label}: node not synced yet, retry ${i}/${tries - 1}...)`);
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function farmAddressFromEnvOrFile() {
  if (process.env.FARM_ADDRESS && ethers.isAddress(process.env.FARM_ADDRESS)) {
    return process.env.FARM_ADDRESS;
  }
  const file = path.join(__dirname, "..", "deployments", `${network.name}-farm.json`);
  if (!fs.existsSync(file)) throw new Error("No farm found. Run `npm run dev` or `npm run deploy` first.");
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  return list[list.length - 1].address;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const farmAddress = farmAddressFromEnvOrFile();
  const farm = await ethers.getContractAt("GroupFarm", farmAddress);
  const group1 = await ethers.getContractAt("SimpleToken", await farm.rewardToken());

  const pools = await farm.poolCount();
  const required = (await farm.budgetPerPool()) * pools;
  console.log("Farm:           ", farmAddress);
  console.log("Pools:          ", pools.toString());
  console.log("Required fund:  ", ethers.formatUnits(required, 18), "GROUP1");

  if (await farm.started()) {
    console.log("The campaign has already started. Nothing to do.");
    return;
  }

  const have = await group1.balanceOf(farmAddress);
  if (have < required) {
    const missing = required - have;
    const mine = await group1.balanceOf(signer.address);
    if (mine < missing) {
      throw new Error(
        `Your wallet has ${ethers.formatUnits(mine, 18)} GROUP1 but ${ethers.formatUnits(missing, 18)} is needed`
      );
    }
    console.log("Sending", ethers.formatUnits(missing, 18), "GROUP1 to the farm...");
    const tx = await group1.transfer(farmAddress, missing);
    console.log("Transfer tx:", tx.hash);
    await tx.wait(network.name === "sepolia" ? 2 : 1);
  } else {
    console.log("Farm is already fully funded.");
  }

  await waitFor("farm balance", async () => (await group1.balanceOf(farmAddress)) >= required);
  console.log("Farm balance verified:", ethers.formatUnits(await group1.balanceOf(farmAddress), 18), "GROUP1");

  console.log("Calling startSession()...");
  const startTx = await farm.startSession();
  console.log("Start tx:", startTx.hash);
  const receipt = await startTx.wait(network.name === "sepolia" ? 2 : 1);
  if (!receipt || receipt.status !== 1) throw new Error("startSession failed");

  await waitFor("started flag", async () => await farm.started());
  const start = await farm.startTime();
  const end = await farm.endTime();
  console.log("\nCampaign started!");
  console.log("Start:", new Date(Number(start) * 1000).toLocaleString());
  console.log("End:  ", new Date(Number(end) * 1000).toLocaleString());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
