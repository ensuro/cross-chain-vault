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
  const [deployer, admin, lp, lp2, anon, syncer, bridgeAdmin] = await ethers.getSigners();

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
  await router.setFee(_W(1));

  const link = await initCurrency(
    {
      name: "The fee token",
      symbol: "LINK",
      decimals: 18,
      initial_supply: _W(1000),
      extraArgs: [admin],
    },
    [admin],
    [_W(1000)]
  );

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

  // Fund LINK tokens for both contracts
  await link.connect(admin).transfer(vp, _W(100));
  await link.connect(admin).transfer(pr, _W(100));

  // Permission setup for both contracts

  const roles = Object.fromEntries(
    ["LP_ROLE", "CCIP_ROUTER_ROLE", "SYNC_AXS_ROLE", "BRIDGE_ADMIN_ROLE"].map((roleName) => [
      roleName,
      getAccessManagerRole(roleName),
    ])
  );

  await makeAllViewsPublic(acMgr.connect(admin), vp);
  await setupAMRole(acMgr.connect(admin), vp, roles, "LP_ROLE", ["scheduleWithdrawal", "deposit"]);
  await acMgr.connect(admin).grantRole(roles.LP_ROLE, lp, 0);

  await setupAMRole(acMgr.connect(admin), vp, roles, "CCIP_ROUTER_ROLE", ["ccipReceive"]);
  await acMgr.connect(admin).grantRole(roles.CCIP_ROUTER_ROLE, router, 0);

  await setupAMRole(acMgr.connect(admin), vp, roles, "BRIDGE_ADMIN_ROLE", ["setGasLimit", "withdrawFeeToken"]);

  await makeAllViewsPublic(acMgr.connect(admin), pr);
  await setupAMRole(acMgr.connect(admin), pr, roles, "CCIP_ROUTER_ROLE", ["ccipReceive"]);

  await setupAMRole(acMgr.connect(admin), pr, roles, "SYNC_AXS_ROLE", ["syncAssetsPerShare"]);
  await acMgr.connect(admin).grantRole(roles.SYNC_AXS_ROLE, syncer, 0);

  await setupAMRole(acMgr.connect(admin), pr, roles, "BRIDGE_ADMIN_ROLE", ["setGasLimit", "withdrawFeeToken"]);
  await acMgr.connect(admin).grantRole(roles.BRIDGE_ADMIN_ROLE, bridgeAdmin, 0);

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
    syncer,
    bridgeAdmin,
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

  it("It can change the gasLimits", async () => {
    const { vp, bridgeAdmin, anon } = await helpers.loadFixture(setUp);

    // This is just to show how the AccessManagedProxy works, even when in the code you won't
    // see the access control, it's there...
    await expect(vp.connect(anon).setGasLimit(MessageType.deposit, 1234n)).to.be.revertedWithCustomError(
      vp,
      "AccessManagedUnauthorized"
    );

    expect(await vp.getGasLimit(MessageType.deposit)).to.equal(DEFAULT_GAS_LIMIT);
    await expect(vp.connect(bridgeAdmin).setGasLimit(MessageType.deposit, 1234n))
      .to.emit(vp, "GasLimitChanged")
      .withArgs(MessageType.deposit, DEFAULT_GAS_LIMIT, 1234n);
    expect(await vp.getGasLimit(MessageType.deposit)).to.equal(1234n);
  });

  it("It can recover the fee tokens sent to the contracts", async () => {
    const { pr, bridgeAdmin, link, lp } = await helpers.loadFixture(setUp);

    expect(await link.balanceOf(pr)).to.equal(_W(100));

    await expect(pr.connect(bridgeAdmin).withdrawFeeToken(_W(10), lp))
      .to.emit(pr, "FeeTokenWithdrawal")
      .withArgs(lp, _W(10));
    expect(await link.balanceOf(pr)).to.equal(_W(90));
    expect(await link.balanceOf(lp)).to.equal(_W(10));

    await expect(pr.connect(bridgeAdmin).withdrawFeeToken(MaxUint256, lp))
      .to.emit(pr, "FeeTokenWithdrawal")
      .withArgs(lp, _W(90));
    expect(await link.balanceOf(pr)).to.equal(_W(0));
    expect(await link.balanceOf(lp)).to.equal(_W(100));
  });

  it("It can synchronize the assets per share", async () => {
    const { vp, pr, syncer, router } = await helpers.loadFixture(setUp);
    const assetsPerShare = await pr.assetsPerShare();
    expect(assetsPerShare).to.equal(_A("1.25") - 1n); // 1n rounding difference
    expect(await vp.assetsPerShare()).to.equal(0);
    expect(await vp.updateBlockId()).to.equal(0);

    const blockNumber = 1 + (await ethers.provider.getBlockNumber());
    await expect(pr.connect(syncer).syncAssetsPerShare()).to.emit(pr, "AssetsPerShareSynced").withArgs(assetsPerShare);

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
    const { vp, pr, theVault, lp, asset, router, syncer } = await helpers.loadFixture(setUp);

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

    let blockNumber = 1 + (await ethers.provider.getBlockNumber());
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

    // Earnings in the vault are reflected (after sync) in vp total assets
    await theVault.discreteEarning(_A(500));

    blockNumber = 1 + (await ethers.provider.getBlockNumber());
    await pr.connect(syncer).syncAssetsPerShare();
    await expect(router.dispatchMessage(MaxUint256))
      .to.emit(vp, "AssetsPerShareUpdated")
      .withArgs(blockNumber, captureAny.value, _A(100 / 1.25));
    expect(await theVault.convertToAssets(_A(1))).to.equal(captureAny.lastValue);
    expect(await vp.assetsPerShare()).to.equal(captureAny.lastValue);
    expect(await vp.updateBlockId()).to.equal(blockNumber);
    // Total assets increased
    expect(await vp.totalAssets()).to.closeTo(_A(137), _A("1"));
  });

  it("It can do a cross-chain withdrawal", async () => {
    const { vp, pr, theVault, lp, asset, router } = await helpers.loadFixture(setUp);

    await asset.connect(lp).approve(vp, MaxUint256);

    await vp.connect(lp).deposit(_A(100));
    await router.dispatchMessage(MaxUint256);
    await router.dispatchMessage(MaxUint256);

    expect(await vp.totalAssets()).to.closeTo(_A(100), _A("0.0001"));
    expect(await vp.totalShares()).to.equal(_A(100 / 1.25));
    expect(await vp.assetsPerShare()).to.equal(_A(1.25) - 1n);

    // The vault has losses, assets per share go down. But it will be updated after the request
    await theVault.discreteEarning(-_A(54));
    expect(await pr.assetsPerShare()).to.closeTo(_A("1.2"), 10n);

    await expect(vp.connect(lp).scheduleWithdrawal(_A(20), lp, ethers.toUtf8Bytes("")))
      .to.emit(vp, "WithdrawalRequested")
      .withArgs(captureAny.value, _A(20), lp, ethers.toUtf8Bytes(""))
      .to.emit(vp, "MessageSent")
      .withArgs(anyValue, MessageType.withdrawalRequest, _A(0), anyValue);
    const messageId = captureAny.lastValue;

    let blockNumber = 1 + (await ethers.provider.getBlockNumber());
    // Dispatch message and the withdrawal is executed (on dest-chain side)
    await expect(router.dispatchMessage(MaxUint256))
      .to.emit(pr, "WithdrawalExecuted")
      .withArgs(messageId, _A(20), _A(20), captureAny.uint)
      .to.emit(pr, "MessageSent")
      .withArgs(anyValue, MessageType.withdrawalConfirmed, _A(20), anyValue);
    expect(captureAny.lastUint).to.closeTo(_A(20 / 1.2), 10n);

    // Still hasn't received the assets nor the update in shares
    expect(await vp.totalAssets()).to.closeTo(_A(100), _A("0.0001"));

    expect(await asset.balanceOf(lp)).to.equal(_A(INITIAL - 100));
    // Dispatch message and the withdrawal is executed (on source-chain side)
    await expect(router.dispatchMessage(MaxUint256))
      .to.emit(vp, "WithdrawalExecuted")
      .withArgs(messageId, lp, _A(20), captureAny.uint);
    expect(captureAny.lastUint).to.closeTo(_A(20 / 1.2), 10n);
    expect(await asset.balanceOf(lp)).to.equal(_A(INITIAL - 80));

    // Now totalAssets reflects the 20 of withdrawal and the 4 in negative yields
    expect(await vp.totalAssets()).to.closeTo(_A(100 - 20 - 4), _A("0.0001"));
    expect(await vp.assetsPerShare()).to.closeTo(_A(1.2), 10n);
    expect(await vp.updateBlockId()).to.equal(blockNumber);

    // Now I withdraw all the remaining assets
    await expect(vp.connect(lp).scheduleWithdrawal(MaxUint256, lp, ethers.toUtf8Bytes("")))
      .to.emit(vp, "WithdrawalRequested")
      .withArgs(captureAny.value, MaxUint256, lp, ethers.toUtf8Bytes(""));

    blockNumber = 1 + (await ethers.provider.getBlockNumber());
    // Dispatch message and the withdrawal is executed (source chain side)
    await expect(router.dispatchMessage(MaxUint256))
      .to.emit(pr, "WithdrawalExecuted")
      .withArgs(anyValue, MaxUint256, captureAny.uint, anyValue);
    expect(captureAny.lastUint).to.closeTo(_A(100 - 20 - 4), 10n);
    expect(await theVault.balanceOf(pr)).to.equal(0); // All funds deinvested

    // Dispatch message and the withdrawal is executed (on source-chain side)
    await expect(router.dispatchMessage(MaxUint256))
      .to.emit(vp, "WithdrawalExecuted")
      .withArgs(anyValue, lp, captureAny.value, await vp.totalShares());
    expect(captureAny.lastUint).to.closeTo(_A(100 - 20 - 4), 10n); // Assets received
    expect(await vp.totalAssets()).to.equal(0);
    expect(await vp.totalShares()).to.equal(0);
    // LP recovers the money, except for losses
    expect(await asset.balanceOf(lp)).to.closeTo(_A(INITIAL - 4), 10n);
  });
});
