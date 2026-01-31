// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract VaultLedger is AccessControl, ReentrancyGuard {
  using SafeERC20 for IERC20;

  bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

  address public immutable dynwToken;
  address public immutable treasury;

  mapping(address => mapping(address => uint256)) public balances;
  mapping(address => mapping(address => uint256)) public lockedBalances;
  mapping(bytes32 => mapping(address => uint256)) public betStakes;
  mapping(bytes32 => address) public betTokens;

  event Deposit(address indexed user, address indexed token, uint256 amount);
  event Withdraw(address indexed user, address indexed token, uint256 amount);
  event BetPlaced(address indexed user, bytes32 indexed betId, address indexed token, uint256 amount);
  event BetSettled(
    bytes32 indexed betId,
    address indexed user,
    address indexed token,
    uint256 stake,
    uint256 netAmount,
    uint8 outcome
  );
  event TreasuryCredited(bytes32 indexed betId, address indexed token, uint256 amount);
  event TreasuryDebited(bytes32 indexed betId, address indexed token, uint256 amount);

  error InvalidAmount();
  error UnsupportedToken();
  error BetTokenMismatch();
  error MissingStake();
  error InsufficientBalance();
  error ZeroAddress();
  error InvalidOutcome();
  error TreasuryInsufficient();

  constructor(
    address dynwToken_,
    address treasury_,
    address operator_
  ) {
    if (dynwToken_ == address(0) || treasury_ == address(0) || operator_ == address(0)) {
      revert ZeroAddress();
    }
    dynwToken = dynwToken_;
    treasury = treasury_;
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(OPERATOR_ROLE, operator_);
  }

  function depositDYNW(uint256 amount) external nonReentrant {
    _depositToken(dynwToken, amount);
  }

  function withdrawDYNW(uint256 amount) external nonReentrant {
    _withdrawToken(dynwToken, amount);
  }

  function placeBet(bytes32 betId, address token, uint256 amount) external nonReentrant {
    if (!_isSupportedToken(token)) revert UnsupportedToken();
    if (amount == 0) revert InvalidAmount();
    if (balances[msg.sender][token] < amount) revert InsufficientBalance();
    if (betTokens[betId] == address(0)) {
      betTokens[betId] = token;
    } else if (betTokens[betId] != token) {
      revert BetTokenMismatch();
    }

    balances[msg.sender][token] -= amount;
    lockedBalances[msg.sender][token] += amount;
    betStakes[betId][msg.sender] += amount;

    emit BetPlaced(msg.sender, betId, token, amount);
  }

  function settleBet(
    bytes32 betId,
    address token,
    uint256 netAmount,
    uint8 outcome,
    address[] calldata participants
  ) external nonReentrant onlyRole(OPERATOR_ROLE) {
    if (participants.length == 0) revert InvalidAmount();
    if (!_isSupportedToken(token)) revert UnsupportedToken();
    if (betTokens[betId] != token) revert BetTokenMismatch();
    if (outcome != 1 && outcome != 2) revert InvalidOutcome();

    for (uint256 i = 0; i < participants.length; i += 1) {
      address participant = participants[i];
      uint256 stake = betStakes[betId][participant];
      if (stake == 0) revert MissingStake();

      lockedBalances[participant][token] -= stake;
      betStakes[betId][participant] = 0;
      balances[participant][token] += stake;

      if (outcome == 1) {
        if (balances[treasury][token] < netAmount) revert TreasuryInsufficient();
        balances[treasury][token] -= netAmount;
        balances[participant][token] += netAmount;
        if (netAmount > 0) {
          emit TreasuryDebited(betId, token, netAmount);
        }
      } else {
        if (netAmount > stake) revert InvalidAmount();
        balances[participant][token] -= netAmount;
        balances[treasury][token] += netAmount;
        if (netAmount > 0) {
          emit TreasuryCredited(betId, token, netAmount);
        }
      }

      emit BetSettled(betId, participant, token, stake, netAmount, outcome);
    }
  }

  function getAvailableBalance(address token, address owner) external view returns (uint256) {
    return balances[owner][token];
  }

  function getLockedBalance(address token, address owner) external view returns (uint256) {
    return lockedBalances[owner][token];
  }

  function _depositToken(address token, uint256 amount) internal {
    if (amount == 0) revert InvalidAmount();
    if (!_isSupportedToken(token)) revert UnsupportedToken();
    IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    balances[msg.sender][token] += amount;
    emit Deposit(msg.sender, token, amount);
  }

  function _withdrawToken(address token, uint256 amount) internal {
    if (amount == 0) revert InvalidAmount();
    if (!_isSupportedToken(token)) revert UnsupportedToken();
    if (balances[msg.sender][token] < amount) revert InsufficientBalance();
    balances[msg.sender][token] -= amount;
    IERC20(token).safeTransfer(msg.sender, amount);
    emit Withdraw(msg.sender, token, amount);
  }

  function _isSupportedToken(address token) internal view returns (bool) {
    return token == dynwToken;
  }
}
