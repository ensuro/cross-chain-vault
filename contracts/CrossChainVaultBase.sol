// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.16;

import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {IERC165} from "@openzeppelin/contracts/interfaces/IERC165.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/contracts/interfaces/IRouterClient.sol";
import {IAny2EVMMessageReceiver} from "@chainlink/contracts-ccip/contracts/interfaces/IAny2EVMMessageReceiver.sol";

/**
 * @title CrossChainVaultBase - Base contract for the two contracts that will implement the cross-chain investment
 * @dev Two contracts will inherit this one. The contracts only communicate through CCIP with each other.
 *
 *      Everything is denominated in a single asset.
 *
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
abstract contract CrossChainVaultBase is UUPSUpgradeable, IAny2EVMMessageReceiver, IERC165 {
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata public immutable asset;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IERC20Metadata public immutable feeToken;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  IRouterClient public immutable ccipRouter;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  uint64 public immutable peerChain;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  address public immutable peerAddress;
  /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
  uint8 public immutable vaultDecimals;

  enum MessageType {
    unknown,
    deposit, // Sent from source to destination - with assets
    depositAck, // Send from destination to source (no assets)
    withdrawalRequest, // Sent from source to destination - no assets
    withdrawalConfirmed, // Sent from destination to source - with assets
    syncAssetsPerShare // Sent from destination to source - No assets
  }

  uint256 public defaultGasLimit;
  mapping(MessageType => uint256) public gasLimits;

  error OnlyRouter(address sender);
  error InvalidMessageSender(address ccipMsgSender);
  error InvalidSourceChain(uint64 sourceChainSelector);
  error InvalidTokensReceived();
  error InvalidMessageType(MessageType msgType);

  event MessageSent(bytes32 indexed messageId, MessageType msgType, uint256 assetsSent, bytes extraData);

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
    IERC20Metadata asset_,
    uint8 vaultDecimals_
  ) {
    // TODO: validations
    ccipRouter = ccipRouter_;
    asset = asset_;
    feeToken = feeToken_;
    peerChain = peerChain_;
    peerAddress = peerAddress_;
    vaultDecimals = vaultDecimals_;
    _disableInitializers();
  }

  /**
   * @dev Initializes the contract
   *
   * @param defaultGasLimit_ Default gas limit for messages, later can be customized by message type
   */
  function initialize(uint256 defaultGasLimit_) public virtual initializer {
    __CrossChainVaultBase_init(defaultGasLimit_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __CrossChainVaultBase_init(uint256 defaultGasLimit_) internal onlyInitializing {
    __UUPSUpgradeable_init();
    __CrossChainVaultBase_init_unchained(defaultGasLimit_);
  }

  // solhint-disable-next-line func-name-mixedcase
  function __CrossChainVaultBase_init_unchained(uint256 defaultGasLimit_) internal onlyInitializing {
    defaultGasLimit = defaultGasLimit_;
    // Infinite approval to the ccipRouter to pay the fees
    feeToken.approve(address(ccipRouter), type(uint256).max);
  }

  function _oneShare() internal view returns (uint256) {
    return 10 ** vaultDecimals;
  }

  // solhint-disable-next-line no-empty-blocks
  function _authorizeUpgrade(address newImpl) internal view override {
    // This method doesn't have any access control validation because these contracts are suppossed to be
    // deployed behind and AccessManagedProxy that controls the access to all the external methods
  }

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

  function getGasLimit(MessageType msgType) public view returns (uint256 theGasLimit) {
    theGasLimit = gasLimits[msgType];
    if (theGasLimit == 0) return defaultGasLimit;
  }

  function getExtraArgs(MessageType msgType) public view returns (bytes memory extraArgs) {
    return
      Client._argsToBytes(Client.GenericExtraArgsV2({gasLimit: getGasLimit(msgType), allowOutOfOrderExecution: false}));
  }

  function _sendMessage(
    MessageType msgType,
    uint256 assetToSend,
    bytes memory extraData
  ) internal returns (bytes32 messageId) {
    Client.EVMTokenAmount[] memory tokenAmounts;
    if (assetToSend != 0) {
      asset.approve(address(ccipRouter), assetToSend);
      tokenAmounts = new Client.EVMTokenAmount[](1);
      tokenAmounts[0].token = address(asset);
      tokenAmounts[0].amount = assetToSend;
    }
    Client.EVM2AnyMessage memory message = Client.EVM2AnyMessage({
      receiver: abi.encode(peerAddress),
      data: abi.encodePacked(msgType, extraData),
      tokenAmounts: tokenAmounts,
      extraArgs: getExtraArgs(msgType),
      feeToken: address(feeToken)
    });
    // address(this) must have sufficient feeToken or the send will revert.
    messageId = ccipRouter.ccipSend(peerChain, message);
    emit MessageSent(messageId, msgType, assetToSend, extraData);
  }
}
