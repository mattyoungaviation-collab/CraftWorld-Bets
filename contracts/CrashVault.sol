// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract CrashVault is AccessControl, ReentrancyGuard {
  using SafeERC20 for IERC20;

  bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

  IERC20 public immutable dynwToken;
  address public immutable treasury;

  mapping(bytes32 => mapping(address => uint256)) public stakes;
  mapping(bytes32 => mapping(address => bool)) public settled;
  mapping(bytes32 => uint256) public totalStakes;

  event BetPlaced(bytes32 indexed roundId, address indexed user, uint256 amount);
  event Cashout(bytes32 indexed roundId, address indexed user, uint256 stake, uint256 payout);
  event LossSettled(bytes32 indexed roundId, address indexed user, uint256 stake);

  error InvalidAmount();
  error ZeroAddress();
  error BetMissing();
  error AlreadySettled();
  error InvalidPayout();
  error InsufficientVaultBalance();

  constructor(address dynwToken_, address treasury_, address operator_) {
    if (dynwToken_ == address(0) || treasury_ == address(0) || operator_ == address(0)) {
      revert ZeroAddress();
    }
    dynwToken = IERC20(dynwToken_);
    treasury = treasury_;
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(OPERATOR_ROLE, operator_);
  }

  function placeBet(bytes32 roundId, uint256 amount) external nonReentrant {
    if (amount == 0) revert InvalidAmount();
    dynwToken.safeTransferFrom(msg.sender, address(this), amount);
    stakes[roundId][msg.sender] += amount;
    totalStakes[roundId] += amount;
    emit BetPlaced(roundId, msg.sender, amount);
  }

  function cashout(bytes32 roundId, address user, uint256 payout) external nonReentrant onlyRole(OPERATOR_ROLE) {
    uint256 stake = stakes[roundId][user];
    if (stake == 0) revert BetMissing();
    if (settled[roundId][user]) revert AlreadySettled();
    if (payout == 0) revert InvalidPayout();
    uint256 vaultBalance = dynwToken.balanceOf(address(this));
    if (vaultBalance < payout) revert InsufficientVaultBalance();

    settled[roundId][user] = true;
    stakes[roundId][user] = 0;
    if (totalStakes[roundId] >= stake) {
      totalStakes[roundId] -= stake;
    }

    dynwToken.safeTransfer(user, payout);
    if (payout < stake) {
      dynwToken.safeTransfer(treasury, stake - payout);
    }
    emit Cashout(roundId, user, stake, payout);
  }

  function settleLoss(bytes32 roundId, address user) external nonReentrant onlyRole(OPERATOR_ROLE) {
    uint256 stake = stakes[roundId][user];
    if (stake == 0) revert BetMissing();
    if (settled[roundId][user]) revert AlreadySettled();

    settled[roundId][user] = true;
    stakes[roundId][user] = 0;
    if (totalStakes[roundId] >= stake) {
      totalStakes[roundId] -= stake;
    }

    dynwToken.safeTransfer(treasury, stake);
    emit LossSettled(roundId, user, stake);
  }

  function getStake(bytes32 roundId, address user) external view returns (uint256) {
    return stakes[roundId][user];
  }
}
