// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.16;

import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockCCIPRouter} from "./MockRouter.sol";
import {Client} from "@chainlink/contracts-ccip/contracts/libraries/Client.sol";

contract AsyncMockRouter is MockCCIPRouter {
  using SafeERC20 for IERC20Metadata;

  struct PendingMessage {
    bytes message;
    uint16 gasForCallExactCheck;
    uint256 gasLimit;
    address receiver;
  }

  PendingMessage[10] _pendingMessages;
  uint256 _pendingMessagesCount;

  function _routeMessage(
    Client.Any2EVMMessage memory message,
    uint16 gasForCallExactCheck,
    uint256 gasLimit,
    address receiver
  ) internal override returns (bool success, bytes memory retData, uint256 gasUsed) {
    uint256 msgIndex = _pendingMessagesCount++;
    _pendingMessages[msgIndex].message = abi.encode(message);
    _pendingMessages[msgIndex].gasForCallExactCheck = gasForCallExactCheck;
    _pendingMessages[msgIndex].gasLimit = gasLimit;
    _pendingMessages[msgIndex].receiver = receiver;
    return (true, bytes(""), gasLimit);
  }

  function dispatchMessage(uint256 messageIndex) external {
    if (messageIndex == type(uint256).max) messageIndex = _pendingMessagesCount - 1;
    PendingMessage storage pmsg = _pendingMessages[messageIndex];
    Client.Any2EVMMessage memory ccipMsg = abi.decode(pmsg.message, (Client.Any2EVMMessage));

    for (uint256 i = 0; i < ccipMsg.destTokenAmounts.length; ++i) {
      IERC20Metadata(ccipMsg.destTokenAmounts[i].token).safeTransfer(pmsg.receiver, ccipMsg.destTokenAmounts[i].amount);
    }

    _routeMessageNow(ccipMsg, pmsg.gasForCallExactCheck, pmsg.gasLimit, pmsg.receiver);
  }
}
