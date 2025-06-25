// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.16;

import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/interfaces/IERC165.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
// import {Packing} from "@openzeppelin/contracts/utils/Packing.sol";
// import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessManagedProxy} from "./dependencies/AccessManagedProxy.sol";

import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {IAny2EVMMessageReceiver} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";

/**
 * @title CrossChainVaultBase - Base contract for the two contracts that will implement the cross-chain investment
 * @dev Two contracts will inherit this one. The contracts only communicate through CCIP with each other.
 *
 *      Operates and everything is denominated in a single asset
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract CrossChainVaultBase is UUPSUpgradeable, IAny2EVMMessageReceiver, IERC165 {
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata public immutable asset;
  IERC20Metadata public immutable feeToken;
  IRouterClient public immutable ccipRouter;
  uint64 public immutable peerChain;
  address public immutable peerAddress;

  error OnlyRouter(address sender);
  error InvalidMessageSender(address ccipMsgSender);
  error InvalidSourceChain(uint64 sourceChainSelector);
  error InvalidTokensReceived();

  enum MessageType {
    unknown,
    deposit, // Sent from source to destination - with assets
    depositAck, // Send from destination to source (no assets)
    withdrawalRequest, // Sent from source to destination - no assets
    withdrawalConfirmed, // Sent from destination to source - with assets
    syncAssetsPerShare // Sent from destination to source - No assets
  }

  /// @dev only calls from the set router are accepted.
  modifier onlyRouter() {
    if (msg.sender != address(ccipRouter)) revert OnlyRouter(msg.sender);
    _;
  }

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor(
    IRouterClient ccipRouter_,
    IERC20Metadata feeToken_,
    uint64 peerChain_,
    address peerAddress_,
    IERC20Metadata asset_
  ) {
    // TODO: validations
    ccipRouter = ccipRouter_;
    asset = asset_;
    feeToken = feeToken_;
    peerChain = peerChain_;
    peerAddress = peerAddress_;
    _disableInitializers();
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override {}

  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return interfaceId == type(IAny2EVMMessageReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
  }

  /// @inheritdoc IAny2EVMMessageReceiver
  function ccipReceive(Client.Any2EVMMessage calldata message) external virtual override onlyRouter {
    require(message.sourceChainSelector == peerChain, InvalidSourceChain(message.sourceChainSelector));
    address ccipMsgSender = abi.decode(message.sender, (address));
    require(ccipMsgSender == peerAddress, InvalidMessageSender(ccipMsgSender));
    MessageType msgType = MessageType(uint8(message.data[0]));
    uint256 tokensLength = message.destTokenAmounts.length;
    require(
      tokensLength == 0 || (tokensLength == 1 && message.destTokenAmounts[0].token == address(asset)),
      InvalidTokensReceived()
    );
    _receiveMessage(
      msgType,
      message.messageId,
      tokensLength == 0 ? 0 : message.destTokenAmounts[0].amount,
      message.data[1:]
    );
  }

  function _receiveMessage(
    MessageType msgType,
    bytes32 messageId,
    uint256 tokenAmount,
    bytes calldata data
  ) internal virtual;
}
