// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IVaultWithdraw {
  function withdrawDYNW(uint256 amount) external;
}

interface IVaultDeposit {
  function depositDYNW(uint256 amount) external;
}

interface IVaultWithdrawCall {
  function withdrawDYNW(uint256 amount) external;
}

contract ReentrantToken is ERC20 {
  address public vault;
  bool public reenter;
  uint256 public reenterAmount;

  constructor() ERC20("Reentrant", "REENT") {}

  function setVault(address vault_) external {
    vault = vault_;
  }

  function setReenter(bool enabled, uint256 amount) external {
    reenter = enabled;
    reenterAmount = amount;
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function approveVault(uint256 amount) external {
    _approve(address(this), vault, amount);
  }

  function depositToVault(uint256 amount) external {
    IVaultDeposit(vault).depositDYNW(amount);
  }

  function withdrawFromVault(uint256 amount) external {
    IVaultWithdrawCall(vault).withdrawDYNW(amount);
  }

  function _transfer(address from, address to, uint256 amount) internal override {
    if (reenter && vault != address(0) && from == vault) {
      IVaultWithdraw(vault).withdrawDYNW(reenterAmount);
    }
    super._transfer(from, to, amount);
  }
}
