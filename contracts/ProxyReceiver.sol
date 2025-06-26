// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.16;

import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {CrossChainVaultBase} from "./CrossChainVaultBase.sol";

/**
 * @title ProxyReceiver - This contract will be deployed in the chain where the investment vault is available.
 * @dev Works together with VaultProxy in the other chain, receiving cross-chain deposit and deposits them into a
 *      vault.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract ProxyReceiver is CrossChainVaultBase {
  using SafeERC20 for IERC20Metadata;
  using Address for address;

  IERC4626 public immutable vault;

  event DepositConfirmed(bytes32 indexed messageId, uint256 assets, uint256 shares);
  event WithdrawalExecuted(bytes32 indexed messageId, uint256 requestedAmount, uint256 assets, uint256 shares);

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IRouterClient ccipRouter_,
    IERC20Metadata feeToken_,
    uint64 peerChain_,
    address peerAddress_,
    IERC4626 vault_
  )
    CrossChainVaultBase(
      ccipRouter_,
      feeToken_,
      peerChain_,
      peerAddress_,
      IERC20Metadata(vault_.asset()),
      vault_.decimals()
    )
  {
    vault = vault_;
  }

  /**
   * @dev Initializes the contract
   *
   * @custom:oz-upgrades-validate-as-initializer
   *
   * @param defaultGasLimit_ Default gas limit for messages, later can be customized by message type
   */
  function initialize(uint256 defaultGasLimit_) public virtual override initializer {
    __ProxyReceiver_init(defaultGasLimit_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __ProxyReceiver_init(uint256 defaultGasLimit_) internal onlyInitializing {
    __CrossChainVaultBase_init(defaultGasLimit_);
    __ProxyReceiver_init_unchained();
  }

  // solhint-disable-next-line func-name-mixedcase
  function __ProxyReceiver_init_unchained() internal onlyInitializing {
    // Infinite approval to the vault. Avoids future approvals and it's not risky since this contract is
    // not suppossed to have assets
    asset.approve(address(vault), type(uint256).max);
  }

  function _receiveMessage(
    MessageType msgType,
    bytes32 messageId,
    uint256 tokenAmount,
    bytes calldata extraData
  ) internal virtual override {
    if (msgType == MessageType.deposit) {
      _deposit(messageId, tokenAmount);
    } else if (msgType == MessageType.withdrawalRequest) {
      _withdrawalRequest(messageId, extraData);
    } else {
      revert InvalidMessageType(msgType);
    }
  }

  function _deposit(bytes32 messageId, uint256 amount) internal {
    uint256 shares = vault.deposit(amount, address(this));
    uint256 assestPerShare = vault.convertToAssets(_oneShare());
    _sendMessage(MessageType.depositAck, 0, abi.encode(messageId, shares, assestPerShare, uint64(block.number)));
    emit DepositConfirmed(messageId, amount, shares);
  }

  function _withdrawalRequest(bytes32 messageId, bytes memory extraData) internal {
    uint256 requestedAmount = abi.decode(extraData, (uint256));
    uint256 amount = vault.maxWithdraw(address(this));
    if (requestedAmount < amount) amount = requestedAmount;

    uint256 shares = vault.withdraw(amount, address(this), address(this));
    uint256 assestPerShare = vault.convertToAssets(_oneShare());
    _sendMessage(
      MessageType.withdrawalConfirmed,
      amount,
      abi.encode(messageId, shares, assestPerShare, uint64(block.number))
    );
    emit WithdrawalExecuted(messageId, requestedAmount, amount, shares);
  }
}
