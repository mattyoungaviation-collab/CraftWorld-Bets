// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract VaultLedger is AccessControl, ReentrancyGuard {
  using SafeERC20 for IERC20;

  bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
  uint256 public constant BPS_DENOMINATOR = 10_000;

  address public immutable dynwToken;
  address public immutable wronToken;
  address public immutable treasury;
  address public immutable feeRecipient;
  uint256 public immutable feeBps;

  mapping(address => mapping(address => uint256)) public balances;
  mapping(address => mapping(address => uint256)) public lockedBalances;
  mapping(address => uint256) public totalLedgerBalances;

  struct BetInfo {
    address token;
    uint256 totalStaked;
    bool settled;
  }

  mapping(bytes32 => BetInfo) public bets;
  mapping(bytes32 => mapping(address => uint256)) public betStakes;

  event Deposit(address indexed user, address indexed token, uint256 amount);
  event Withdraw(address indexed user, address indexed token, uint256 amount);
  event BetPlaced(address indexed user, bytes32 indexed betId, address indexed token, uint256 amount);
  event BetSettled(
    bytes32 indexed betId,
    address[] winners,
    uint256[] payouts,
    uint256 totalLostToTreasury,
    uint256 feeAmount
  );
  event LedgerAdjusted(address indexed user, address indexed token, int256 delta, string reason);
  event TreasuryAccrued(bytes32 indexed betId, address indexed token, uint256 amount);

  error InvalidAmount();
  error UnsupportedToken();
  error BetAlreadySettled();
  error BetTokenMismatch();
  error MissingStake();
  error InvalidPayouts();
  error InsufficientBalance();
  error RescueExceedsSurplus();
  error ZeroAddress();

  constructor(
    address dynwToken_,
    address wronToken_,
    address treasury_,
    address feeRecipient_,
    uint256 feeBps_,
    address operator_
  ) {
    if (dynwToken_ == address(0) || treasury_ == address(0) || feeRecipient_ == address(0)) {
      revert ZeroAddress();
    }
    if (feeBps_ > BPS_DENOMINATOR) {
      revert InvalidAmount();
    }
    dynwToken = dynwToken_;
    wronToken = wronToken_;
    treasury = treasury_;
    feeRecipient = feeRecipient_;
    feeBps = feeBps_;
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(OPERATOR_ROLE, operator_);
  }

  function depositDYNW(uint256 amount) external nonReentrant {
    _depositToken(dynwToken, amount);
  }

  function withdrawDYNW(uint256 amount) external nonReentrant {
    _withdrawToken(dynwToken, amount);
  }

  function depositWRON(uint256 amount) external nonReentrant {
    if (wronToken == address(0)) revert UnsupportedToken();
    _depositToken(wronToken, amount);
  }

  function withdrawWRON(uint256 amount) external nonReentrant {
    if (wronToken == address(0)) revert UnsupportedToken();
    _withdrawToken(wronToken, amount);
  }

  function placeBet(bytes32 betId, address token, uint256 amount) external nonReentrant {
    if (!_isSupportedToken(token)) revert UnsupportedToken();
    if (amount == 0) revert InvalidAmount();
    if (balances[msg.sender][token] < amount) revert InsufficientBalance();

    BetInfo storage bet = bets[betId];
    if (bet.settled) revert BetAlreadySettled();
    if (bet.token == address(0)) {
      bet.token = token;
    } else if (bet.token != token) {
      revert BetTokenMismatch();
    }

    balances[msg.sender][token] -= amount;
    lockedBalances[msg.sender][token] += amount;
    betStakes[betId][msg.sender] += amount;
    bet.totalStaked += amount;

    emit BetPlaced(msg.sender, betId, token, amount);
    emit LedgerAdjusted(msg.sender, token, -int256(amount), "bet_lock");
  }

  function settleBet(
    bytes32 betId,
    address[] calldata participants,
    uint256[] calldata payouts
  ) external nonReentrant onlyRole(OPERATOR_ROLE) {
    if (participants.length == 0 || participants.length != payouts.length) revert InvalidPayouts();

    BetInfo storage bet = bets[betId];
    if (bet.settled) revert BetAlreadySettled();
    if (bet.token == address(0)) revert InvalidPayouts();

    address token = bet.token;
    uint256 totalStaked = 0;
    uint256 totalPayouts = 0;
    uint256 winnerCount = 0;

    for (uint256 i = 0; i < participants.length; i += 1) {
      address participant = participants[i];
      uint256 stake = betStakes[betId][participant];
      if (stake == 0) revert MissingStake();
      totalStaked += stake;
      totalPayouts += payouts[i];
      if (payouts[i] > 0) {
        winnerCount += 1;
      }
    }

    if (totalStaked != bet.totalStaked) revert InvalidPayouts();

    uint256 feeAmount = (totalStaked * feeBps) / BPS_DENOMINATOR;
    if (totalPayouts + feeAmount > totalStaked) revert InvalidPayouts();

    uint256 totalLostToTreasury = totalStaked - feeAmount - totalPayouts;

    address[] memory winners = new address[](winnerCount);
    uint256[] memory winnerPayouts = new uint256[](winnerCount);
    uint256 winnerIndex = 0;

    for (uint256 i = 0; i < participants.length; i += 1) {
      address participant = participants[i];
      uint256 stake = betStakes[betId][participant];
      uint256 payout = payouts[i];
      lockedBalances[participant][token] -= stake;
      betStakes[betId][participant] = 0;
      if (payout > 0) {
        balances[participant][token] += payout;
        winners[winnerIndex] = participant;
        winnerPayouts[winnerIndex] = payout;
        winnerIndex += 1;
        emit LedgerAdjusted(participant, token, int256(payout), "bet_payout");
      }
    }

    if (feeAmount > 0) {
      balances[feeRecipient][token] += feeAmount;
      emit LedgerAdjusted(feeRecipient, token, int256(feeAmount), "fee_accrual");
    }
    if (totalLostToTreasury > 0) {
      balances[treasury][token] += totalLostToTreasury;
      emit TreasuryAccrued(betId, token, totalLostToTreasury);
      emit LedgerAdjusted(treasury, token, int256(totalLostToTreasury), "treasury_accrual");
    }

    bet.settled = true;
    emit BetSettled(betId, winners, winnerPayouts, totalLostToTreasury, feeAmount);
  }

  function rescueToken(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (to == address(0)) revert ZeroAddress();
    if (amount == 0) revert InvalidAmount();
    if (_isSupportedToken(token)) {
      uint256 tracked = totalLedgerBalances[token];
      uint256 onChainBalance = IERC20(token).balanceOf(address(this));
      uint256 surplus = onChainBalance > tracked ? onChainBalance - tracked : 0;
      if (amount > surplus) revert RescueExceedsSurplus();
    }
    IERC20(token).safeTransfer(to, amount);
  }

  function _depositToken(address token, uint256 amount) internal {
    if (amount == 0) revert InvalidAmount();
    if (!_isSupportedToken(token)) revert UnsupportedToken();
    IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    balances[msg.sender][token] += amount;
    totalLedgerBalances[token] += amount;
    emit Deposit(msg.sender, token, amount);
    emit LedgerAdjusted(msg.sender, token, int256(amount), "deposit");
  }

  function _withdrawToken(address token, uint256 amount) internal {
    if (amount == 0) revert InvalidAmount();
    if (!_isSupportedToken(token)) revert UnsupportedToken();
    if (balances[msg.sender][token] < amount) revert InsufficientBalance();
    balances[msg.sender][token] -= amount;
    totalLedgerBalances[token] -= amount;
    IERC20(token).safeTransfer(msg.sender, amount);
    emit Withdraw(msg.sender, token, amount);
    emit LedgerAdjusted(msg.sender, token, -int256(amount), "withdraw");
  }

  function _isSupportedToken(address token) internal view returns (bool) {
    return token == dynwToken || (wronToken != address(0) && token == wronToken);
  }
}
