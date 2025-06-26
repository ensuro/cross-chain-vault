// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.16;

import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {CrossChainVaultBase} from "./CrossChainVaultBase.sol";

/**
 * @title VaultProxy - Contract to deploy in the chain that has the source of funds
 * @dev This contract will receive deposit requests from the user, sent the assets to the other chain where
 *      they will be invested in a vault
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract VaultProxy is CrossChainVaultBase {
  using SafeERC20 for IERC20Metadata;
  using Address for address;

  struct PendingWithdrawal {
    address target;
    bytes callback;
  }

  mapping(bytes32 => uint256) internal _pendingDeposits;
  mapping(bytes32 => PendingWithdrawal) internal _pendingWithdrawals;
  uint256 internal _totalPendingDeposits;
  uint256 internal _totalShares;
  uint256 internal _assetsPerShare; // Amount of assets for one unit (10**vault.decimals()) of shares
  uint64 internal _updateBlockId;

  error InsufficientDeposit(uint256 amount);
  error InsufficientWithdrawal(uint256 amount);
  error ExcessWithdrawal(uint256 amount, uint256 totalAssets);
  error DepositNotPending(bytes32 messageId);
  error WithdrawalNotPending(bytes32 messageId);
  error InvalidTarget();

  event DepositConfirmed(bytes32 indexed messageId, uint256 assets, uint256 shares);
  event AssetsPerShareUpdated(uint64 indexed peerChainBlockId, uint256 assetsPerShare, uint256 totalShares);
  event WithdrawalRequested(bytes32 indexed messageId, uint256 assets, address target, bytes callback);
  event WithdrawalExecuted(bytes32 indexed messageId, address indexed target, uint256 assets, uint256 shares);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IRouterClient ccipRouter_,
    IERC20Metadata feeToken_,
    uint64 peerChain_,
    address peerAddress_,
    IERC20Metadata asset_,
    uint8 vaultDecimals_
  ) CrossChainVaultBase(ccipRouter_, feeToken_, peerChain_, peerAddress_, asset_, vaultDecimals_) {}

  function _receiveMessage(
    MessageType msgType,
    bytes32, // targetChain messageId is not relevant
    uint256 tokenAmount,
    bytes calldata extraData
  ) internal virtual override {
    if (msgType == MessageType.depositAck) {
      _depositAck(extraData);
    } else if (msgType == MessageType.withdrawalConfirmed) {
      _withdrawalConfirmed(tokenAmount, extraData);
    } else if (msgType == MessageType.syncAssetsPerShare) {
      _syncAssetsPerShare(extraData);
    } else {
      revert InvalidMessageType(msgType);
    }
  }

  function _depositAck(bytes calldata extraData) internal {
    (bytes32 messageId, uint256 shares, uint256 assetsPerShare, uint64 updateBlockId) = abi.decode(
      extraData,
      (bytes32, uint256, uint256, uint64)
    );
    require(_pendingDeposits[messageId] != 0, DepositNotPending(messageId));
    _updateAssetsPerShare(assetsPerShare, updateBlockId);
    _totalPendingDeposits -= _pendingDeposits[messageId];
    _totalShares += shares;
    emit DepositConfirmed(messageId, _pendingDeposits[messageId], shares);
    _pendingDeposits[messageId] = 0;
  }

  function _syncAssetsPerShare(bytes calldata extraData) internal {
    (uint256 assetsPerShare, uint64 updateBlockId) = abi.decode(extraData, (uint256, uint64));
    _updateAssetsPerShare(assetsPerShare, updateBlockId);
  }

  function _updateAssetsPerShare(uint256 assetsPerShare, uint64 updateBlockId) internal {
    // Since I assume we receive the messages in order, then I update _assetsPerShare and _updateBlockId on
    // every message received, without checking if the information is more updated than the one I had
    _assetsPerShare = assetsPerShare;
    _updateBlockId = updateBlockId;
    emit AssetsPerShareUpdated(updateBlockId, assetsPerShare, _totalShares);
  }

  function _withdrawalConfirmed(uint256 amount, bytes calldata extraData) internal {
    (bytes32 messageId, uint256 shares, uint256 assetsPerShare, uint64 updateBlockId) = abi.decode(
      extraData,
      (bytes32, uint256, uint256, uint64)
    );
    PendingWithdrawal storage withdrawal = _pendingWithdrawals[messageId];
    require(withdrawal.target != address(0), WithdrawalNotPending(messageId));
    _updateAssetsPerShare(assetsPerShare, updateBlockId);
    _totalShares -= shares;
    asset.safeTransfer(withdrawal.target, amount);
    if (withdrawal.callback.length != 0) {
      withdrawal.target.functionCall(withdrawal.callback);
    }
    emit WithdrawalExecuted(messageId, withdrawal.target, amount, shares);
  }

  function deposit(uint256 amount) external {
    require(amount != 0, InsufficientDeposit(amount)); // TODO: it might be good to add a minimum
    asset.safeTransferFrom(msg.sender, address(this), amount);
    bytes32 messageId = _sendMessage(MessageType.deposit, amount, bytes(""));
    _totalPendingDeposits += amount;
    _pendingDeposits[messageId] = amount;
  }

  function scheduleWithdrawal(uint256 amount, address target, bytes calldata callback) external {
    require(amount != 0, InsufficientWithdrawal(amount)); // TODO: it might be good to add a minimum
    require(amount == type(uint256).max || amount <= totalAssets(), ExcessWithdrawal(amount, totalAssets()));
    require(target != address(0), InvalidTarget());
    bytes32 messageId = _sendMessage(MessageType.withdrawalRequest, 0, abi.encode(amount));
    _pendingWithdrawals[messageId] = PendingWithdrawal({target: target, callback: callback});
    emit WithdrawalRequested(messageId, amount, target, callback);
  }

  function totalAssets() public view returns (uint256 assets) {
    return _totalPendingDeposits + (_totalShares * _assetsPerShare) / _oneShare();
  }
}
