require("hardhat-dependency-compiler");
require("hardhat-contract-sizer");
require("@nomicfoundation/hardhat-toolbox");

const hretry = require("@ensuro/utils/js/hardhat-retry");

hretry.installWrapper();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
    },
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false,
  },
  dependencyCompiler: {
    paths: [
      "@ensuro/utils/contracts/TestCurrency.sol",
      "@ensuro/utils/contracts/TestERC4626.sol",
      "@openzeppelin/contracts/access/manager/AccessManager.sol",
    ],
  },
};
