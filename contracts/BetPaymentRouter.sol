// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
  function transfer(address to, uint256 amount) external returns (bool);
  function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract BetPaymentRouter {
  uint256 public constant BPS_DENOMINATOR = 10_000;

  address public owner;
  address public feeRecipient;
  address public escrowRecipient;
  uint256 public feeBps;

  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
  event FeeRecipientUpdated(address indexed recipient);
  event EscrowRecipientUpdated(address indexed recipient);
  event FeeBpsUpdated(uint256 feeBps);
  event PaymentRouted(
    address indexed payer,
    address indexed token,
    uint256 totalAmount,
    uint256 feeAmount,
    uint256 escrowAmount,
    bytes32 indexed betId
  );

  modifier onlyOwner() {
    require(msg.sender == owner, "Not owner");
    _;
  }

  constructor(address feeRecipient_, address escrowRecipient_, uint256 feeBps_) {
    require(feeRecipient_ != address(0), "Fee recipient required");
    require(escrowRecipient_ != address(0), "Escrow recipient required");
    require(feeBps_ <= BPS_DENOMINATOR, "Invalid fee bps");
    owner = msg.sender;
    feeRecipient = feeRecipient_;
    escrowRecipient = escrowRecipient_;
    feeBps = feeBps_;
  }

  function transferOwnership(address newOwner) external onlyOwner {
    require(newOwner != address(0), "Owner required");
    emit OwnershipTransferred(owner, newOwner);
    owner = newOwner;
  }

  function setFeeRecipient(address feeRecipient_) external onlyOwner {
    require(feeRecipient_ != address(0), "Fee recipient required");
    feeRecipient = feeRecipient_;
    emit FeeRecipientUpdated(feeRecipient_);
  }

  function setEscrowRecipient(address escrowRecipient_) external onlyOwner {
    require(escrowRecipient_ != address(0), "Escrow recipient required");
    escrowRecipient = escrowRecipient_;
    emit EscrowRecipientUpdated(escrowRecipient_);
  }

  function setFeeBps(uint256 feeBps_) external onlyOwner {
    require(feeBps_ <= BPS_DENOMINATOR, "Invalid fee bps");
    feeBps = feeBps_;
    emit FeeBpsUpdated(feeBps_);
  }

  function routeTokenPayment(address token, uint256 totalAmount, bytes32 betId) external {
    require(totalAmount > 0, "Amount required");
    uint256 feeAmount = (totalAmount * feeBps) / BPS_DENOMINATOR;
    uint256 escrowAmount = totalAmount - feeAmount;

    IERC20 erc20 = IERC20(token);
    require(erc20.transferFrom(msg.sender, address(this), totalAmount), "TransferFrom failed");
    require(erc20.transfer(feeRecipient, feeAmount), "Fee transfer failed");
    require(erc20.transfer(escrowRecipient, escrowAmount), "Escrow transfer failed");

    emit PaymentRouted(msg.sender, token, totalAmount, feeAmount, escrowAmount, betId);
  }
}
