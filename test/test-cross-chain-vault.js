const { expect } = require("chai");
const {
  amountFunction,
  _W,
  getAddress,
  makeAllViewsPublic,
  setupAMRole,
  getAccessManagerRole,
  getRole,
  captureAny,
} = require("@ensuro/utils/js/utils");
const { initCurrency } = require("@ensuro/utils/js/test-utils");
const { deploy: ozUpgradesDeploy } = require("@openzeppelin/hardhat-upgrades/dist/utils");
const hre = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue, anyUint } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const { ethers } = hre;
const { MaxUint256 } = hre.ethers;

const CURRENCY_DECIMALS = 6;
const _A = amountFunction(CURRENCY_DECIMALS);
const INITIAL = 10000;
const NAME = "Single Strategy Vault";
const SYMB = "SSV";

function predictContractAddress(deployerAddress, nonce) {
  // Convert nonce to hex (ethers v6 handles this differently)
  const nonceHex = ethers.toBeHex(nonce);

  // RLP encode the deployer address and nonce
  const rlpEncoded = ethers.encodeRlp([deployerAddress, nonceHex]);

  // Compute keccak256 hash of RLP-encoded data
  const hash = ethers.keccak256(rlpEncoded);

  // Last 20 bytes (40 chars) = contract address
  return `0x${hash.slice(-40)}`;
}

const DEFAULT_GAS_LIMIT = 999999;
const CHAIN_SELECTOR = 16015286601757825753n; // Sepolia - Hardcoded in MockCCIPRouter

const MessageType = {
  unknown: 0,
  deposit: 1, // Sent from source to destination - with assets
  depositAck: 2, // Send from destination to source (no assets)
  withdrawalRequest: 3, // Sent from source to destination - no assets
  withdrawalConfirmed: 4, // Sent from destination to source - with assets
  syncAssetsPerShare: 5, // Sent from destination to source - No assets
};

async function setUp() {
  const [deployer, admin, lp, lp2, anon, guardian] = await ethers.getSigners();

  const asset = await initCurrency(
    { name: "Test USDC", symbol: "USDC", decimals: 6, initial_supply: _A(50000), extraArgs: [admin] },
    [lp, lp2],
    [_A(INITIAL), _A(INITIAL)]
  );

  const TestERC4626 = await ethers.getContractFactory("TestERC4626");
  const theVault = await TestERC4626.deploy("Juicy yields in foreign chain", "YIELD", asset);

  await asset.connect(admin).grantRole(getRole("MINTER_ROLE"), theVault);
  await asset.connect(admin).grantRole(getRole("BURNER_ROLE"), theVault);

  // Do some deposit in theVault
  await asset.connect(lp2).approve(theVault, MaxUint256);
  await theVault.connect(lp2).deposit(_A(1000), lp2);
  // Generate yields, so shares != assets
  await theVault.discreteEarning(_A(250));

  expect(await theVault.totalAssets()).to.equal(_A(1250));
  expect(await theVault.totalSupply()).to.equal(_A(1000));

  const adminAddr = await ethers.resolveAddress(admin);

  // CCIP MockRouter
  const MockRouter = await ethers.getContractFactory("AsyncMockRouter");
  const router = await MockRouter.deploy();

  const link = await initCurrency({
    name: "The fee token",
    symbol: "LINK",
    decimals: 18,
    initial_supply: _W(1000),
    extraArgs: [admin],
  });

  const VaultProxy = await ethers.getContractFactory("VaultProxy");
  const ProxyReceiver = await ethers.getContractFactory("ProxyReceiver");

  const AccessManagedProxy = await ethers.getContractFactory("AccessManagedProxy");
  const AccessManager = await ethers.getContractFactory("AccessManager");
  const acMgr = await AccessManager.deploy(admin);

  const expectedNonce = (await deployer.getNonce()) + 3;
  const receiverAddr = predictContractAddress(getAddress(deployer), expectedNonce);

  const vp = await hre.upgrades.deployProxy(VaultProxy, [DEFAULT_GAS_LIMIT], {
    kind: "uups",
    unsafeAllow: [
      "delegatecall",
      "missing-initializer-call", // This is to fix an error because it says we are not calling
      // parent initializer
    ],
    proxyFactory: AccessManagedProxy,
    constructorArgs: [
      getAddress(router),
      getAddress(link),
      CHAIN_SELECTOR,
      receiverAddr,
      getAddress(asset),
      await theVault.decimals(),
    ],
    deployFunction: async (hre_, opts, factory, ...args) => ozUpgradesDeploy(hre_, opts, factory, ...args, acMgr),
  });

  const pr = await hre.upgrades.deployProxy(ProxyReceiver, [DEFAULT_GAS_LIMIT], {
    kind: "uups",
    unsafeAllow: [
      "delegatecall",
      "missing-initializer-call", // This is to fix an error because it says we are not calling
      // parent initializer
    ],
    proxyFactory: AccessManagedProxy,
    constructorArgs: [getAddress(router), getAddress(link), CHAIN_SELECTOR, getAddress(vp), getAddress(theVault)],
    deployFunction: async (hre_, opts, factory, ...args) => ozUpgradesDeploy(hre_, opts, factory, ...args, acMgr),
  });

  // Permission setup for both contracts

  const roles = {
    LP_ROLE: getAccessManagerRole("LP_ROLE"),
    CCIP_ROUTER_ROLE: getAccessManagerRole("CCIP_ROUTER_ROLE"),
    SYNC_AXS_ROLE: getAccessManagerRole("SYNC_AXS_ROLE"),
  };

  await makeAllViewsPublic(acMgr.connect(admin), vp);
  await setupAMRole(acMgr.connect(admin), vp, roles, "LP_ROLE", ["scheduleWithdrawal", "deposit"]);
  await acMgr.connect(admin).grantRole(roles.LP_ROLE, lp, 0);
  await acMgr.connect(admin).grantRole(roles.LP_ROLE, lp2, 0);

  await setupAMRole(acMgr.connect(admin), vp, roles, "CCIP_ROUTER_ROLE", ["ccipReceive"]);
  await acMgr.connect(admin).grantRole(roles.CCIP_ROUTER_ROLE, router, 0);

  await makeAllViewsPublic(acMgr.connect(admin), pr);

  await setupAMRole(acMgr.connect(admin), pr, roles, "CCIP_ROUTER_ROLE", ["ccipReceive"]);
  await acMgr.connect(admin).grantRole(roles.CCIP_ROUTER_ROLE, router, 0);

  await setupAMRole(acMgr.connect(admin), pr, roles, "SYNC_AXS_ROLE", ["syncAssetsPerShare"]);
  await acMgr.connect(admin).grantRole(roles.SYNC_AXS_ROLE, guardian, 0);

  return {
    asset,
    link,
    acMgr,
    deployer,
    admin,
    adminAddr,
    lp,
    lp2,
    anon,
    guardian,
    VaultProxy,
    ProxyReceiver,
    router,
    theVault,
    vp,
    pr,
  };
}

describe("Cross-chain vault contract tests", function () {
  it("Deploys the contracts linked to each other", async () => {
    const { vp, pr } = await helpers.loadFixture(setUp);
    expect(await vp.peerAddress()).to.equal(getAddress(pr));
    expect(await pr.peerAddress()).to.equal(getAddress(vp));
    expect(await vp.totalAssets()).to.equal(0);
  });

  it("It can synchronize the assets per share", async () => {
    const { vp, pr, guardian, router } = await helpers.loadFixture(setUp);
    const assetsPerShare = await pr.assetsPerShare();
    expect(assetsPerShare).to.equal(_A("1.25") - 1n); // 1n rounding difference
    expect(await vp.assetsPerShare()).to.equal(0);
    expect(await vp.updateBlockId()).to.equal(0);

    const blockNumber = 1 + (await ethers.provider.getBlockNumber());
    await expect(pr.connect(guardian).syncAssetsPerShare())
      .to.emit(pr, "AssetsPerShareSynced")
      .withArgs(assetsPerShare);

    // Message hasn't arrived yet
    expect(await vp.assetsPerShare()).to.equal(0);
    expect(await vp.updateBlockId()).to.equal(0);

    // Dispatch message and the message arrives
    await expect(router.dispatchMessage(MaxUint256))
      .to.emit(vp, "AssetsPerShareUpdated")
      .withArgs(blockNumber, assetsPerShare, 0n);
    expect(await vp.assetsPerShare()).to.equal(assetsPerShare);
    expect(await vp.updateBlockId()).to.equal(blockNumber);
  });

  it("It can do a cross-chain deposit", async () => {
    const { vp, pr, theVault, lp, asset, router } = await helpers.loadFixture(setUp);

    await asset.connect(lp).approve(vp, MaxUint256);

    await expect(vp.connect(lp).deposit(_A(100)))
      .to.emit(vp, "MessageSent")
      .withArgs(captureAny.value, MessageType.deposit, _A(100), ethers.toUtf8Bytes(""));
    const messageId = captureAny.lastValue;

    expect(await vp.totalAssets()).to.equal(_A(100));
    expect(await vp.totalPendingDeposits()).to.equal(_A(100));
    expect(await vp.totalShares()).to.equal(_A(0));
    expect(await theVault.balanceOf(pr)).to.equal(0);
    expect(await asset.balanceOf(router)).to.equal(_A(100)); // The funds are in the router

    const blockNumber = 1 + (await ethers.provider.getBlockNumber());
    // Dispatch message and the message arrives and the money is invested in the vault
    await expect(router.dispatchMessage(MaxUint256))
      .to.emit(pr, "DepositConfirmed")
      .withArgs(messageId, _A(100), _A(100 / 1.25))
      .to.emit(pr, "MessageSent")
      .withArgs(anyValue, MessageType.depositAck, 0, captureAny.value);
    expect(captureAny.lastValue).to.not.equal(ethers.toUtf8Bytes(""));

    // Status of vp doesn't changed yet
    expect(await vp.totalAssets()).to.equal(_A(100));
    expect(await vp.totalPendingDeposits()).to.equal(_A(100));
    expect(await vp.totalShares()).to.equal(_A(0));
    // But money now is invested
    expect(await theVault.balanceOf(pr)).to.equal(_A(100 / 1.25));
    expect(await asset.balanceOf(router)).to.equal(_A(0)); // The funds are not anymore in the router

    // Dispatch another message and the ACK arrives to VP
    await expect(router.dispatchMessage(MaxUint256))
      .to.emit(vp, "DepositConfirmed")
      .withArgs(messageId, _A(100), _A(100 / 1.25));

    // VP doesn't have pending deposits, just shares
    expect(await vp.totalAssets()).to.closeTo(_A(100), _A("0.0001"));
    expect(await vp.totalPendingDeposits()).to.equal(_A(0));
    expect(await vp.totalShares()).to.equal(_A(100 / 1.25));
    expect(await vp.assetsPerShare()).to.equal(_A(1.25) - 1n);
    expect(await vp.updateBlockId()).to.equal(blockNumber);
  });
});
