require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { SEPOLIA_RPC_URL, PRIVATE_KEY, ETHERSCAN_API_KEY } = process.env;
const keyOk = /^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY || "");
const rpcOk = SEPOLIA_RPC_URL && !SEPOLIA_RPC_URL.includes("YOUR");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    sepolia: {
      url: rpcOk ? SEPOLIA_RPC_URL : "http://127.0.0.1:8545",
      accounts: keyOk ? [PRIVATE_KEY] : [],
      chainId: 11155111,
    },
  },
  etherscan: { apiKey: ETHERSCAN_API_KEY || "" },
};
