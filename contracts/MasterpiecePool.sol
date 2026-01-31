// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MasterpiecePool is AccessControl, ReentrancyGuard {
  using SafeERC20 for IERC20;

  bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

  IERC20 public immutable dynwToken;
  address public immutable treasury;

  mapping(bytes32 => uint256) public totalPools;
  mapping(bytes32 => mapping(address => uint256)) public stakes;
  mapping(bytes32 => bool) public settled;
  mapping(uint8 => uint256) public carryoverByPosition;

  event BetPlaced(bytes32 indexed betId, uint8 indexed position, address indexed user, uint256 amount);
  event MarketSettled(
    bytes32 indexed betId,
    uint8 indexed position,
    uint256 payoutSum,
    uint256 houseTake,
    uint256 carryoverNext
  );

  error InvalidAmount();
  error ZeroAddress();
  error InvalidPosition();
  error AlreadySettled();
  error InvalidSettlement();

  constructor(address dynwToken_, address treasury_, address operator_) {
    if (dynwToken_ == address(0) || treasury_ == address(0) || operator_ == address(0)) {
      revert ZeroAddress();
    }
    dynwToken = IERC20(dynwToken_);
    treasury = treasury_;
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(OPERATOR_ROLE, operator_);
  }

  function placeBet(bytes32 betId, uint8 position, uint256 amount) external nonReentrant {
    if (position < 1 || position > 3) revert InvalidPosition();
    if (amount == 0) revert InvalidAmount();

    dynwToken.safeTransferFrom(msg.sender, address(this), amount);
    stakes[betId][msg.sender] += amount;
    totalPools[betId] += amount;
    emit BetPlaced(betId, position, msg.sender, amount);
  }

  function settleMarket(
    bytes32 betId,
    uint8 position,
    address[] calldata winners,
    uint256[] calldata payouts,
    uint256 houseTake,
    uint256 carryoverNext
  ) external nonReentrant onlyRole(OPERATOR_ROLE) {
    if (position < 1 || position > 3) revert InvalidPosition();
    if (settled[betId]) revert AlreadySettled();
    if (winners.length != payouts.length) revert InvalidSettlement();

    uint256 payoutSum = 0;
    for (uint256 i = 0; i < payouts.length; i += 1) {
      payoutSum += payouts[i];
    }

    uint256 pool = totalPools[betId] + carryoverByPosition[position];
    if (payoutSum + houseTake + carryoverNext != pool) revert InvalidSettlement();

    settled[betId] = true;
    totalPools[betId] = 0;
    carryoverByPosition[position] = carryoverNext;

    for (uint256 i = 0; i < winners.length; i += 1) {
      uint256 payout = payouts[i];
      if (payout > 0) {
        dynwToken.safeTransfer(winners[i], payout);
      }
    }

    if (houseTake > 0) {
      dynwToken.safeTransfer(treasury, houseTake);
    }

    emit MarketSettled(betId, position, payoutSum, houseTake, carryoverNext);
  }

  function getPool(bytes32 betId) external view returns (uint256) {
    return totalPools[betId];
  }
}
