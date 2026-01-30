import { expect } from "chai";
import { ethers } from "hardhat";

describe("VaultLedger", () => {
  async function deployFixture() {
    const [deployer, operator, treasury, feeRecipient, user, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const dynw = await MockERC20.deploy("DynoWager", "DYNW");
    await dynw.waitForDeployment();

    const VaultLedger = await ethers.getContractFactory("VaultLedger");
    const vault = await VaultLedger.deploy(
      await dynw.getAddress(),
      ethers.ZeroAddress,
      treasury.address,
      feeRecipient.address,
      500,
      operator.address,
    );
    await vault.waitForDeployment();

    await dynw.mint(user.address, ethers.parseEther("100"));
    await dynw.connect(user).approve(await vault.getAddress(), ethers.parseEther("100"));

    return { deployer, operator, treasury, feeRecipient, user, other, dynw, vault };
  }

  it("allows deposit and withdraw", async () => {
    const { user, dynw, vault } = await deployFixture();
    const amount = ethers.parseEther("10");
    await expect(vault.connect(user).depositDYNW(amount))
      .to.emit(vault, "Deposit")
      .withArgs(user.address, await dynw.getAddress(), amount);

    await expect(vault.connect(user).withdrawDYNW(amount))
      .to.emit(vault, "Withdraw")
      .withArgs(user.address, await dynw.getAddress(), amount);
  });

  it("prevents withdrawing more than balance", async () => {
    const { user, vault } = await deployFixture();
    await expect(vault.connect(user).withdrawDYNW(1)).to.be.revertedWithCustomError(vault, "InsufficientBalance");
  });

  it("restricts settlement to operator", async () => {
    const { user, other, dynw, vault } = await deployFixture();
    const betId = ethers.id("bet-1");
    const amount = ethers.parseEther("5");
    await vault.connect(user).depositDYNW(amount);
    await vault.connect(user).placeBet(betId, await dynw.getAddress(), amount);

    await expect(vault.connect(other).settleBet(betId, [user.address], [amount]))
      .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
  });

  it("operator cannot withdraw to arbitrary address", async () => {
    const { operator, dynw, vault } = await deployFixture();
    const amount = ethers.parseEther("1");
    await expect(vault.connect(operator).withdrawDYNW(amount)).to.be.revertedWithCustomError(
      vault,
      "InsufficientBalance",
    );
  });

  it("settles bets and accrues treasury and fees", async () => {
    const { operator, treasury, feeRecipient, user, other, dynw, vault } = await deployFixture();
    const betId = ethers.id("bet-2");
    const stake = ethers.parseEther("4");
    const stakeOther = ethers.parseEther("6");

    await vault.connect(user).depositDYNW(stake);
    await vault.connect(other).depositDYNW(stakeOther);
    await vault.connect(user).placeBet(betId, await dynw.getAddress(), stake);
    await vault.connect(other).placeBet(betId, await dynw.getAddress(), stakeOther);

    const payoutUser = ethers.parseEther("3");
    const payoutOther = ethers.parseEther("0");

    await expect(vault.connect(operator).settleBet(betId, [user.address, other.address], [payoutUser, payoutOther]))
      .to.emit(vault, "BetSettled")
      .withArgs(betId, [user.address], [payoutUser], ethers.parseEther("6.5"), ethers.parseEther("0.5"));

    const treasuryBalance = await vault.balances(treasury.address, await dynw.getAddress());
    const feeBalance = await vault.balances(feeRecipient.address, await dynw.getAddress());
    expect(treasuryBalance).to.equal(ethers.parseEther("6.5"));
    expect(feeBalance).to.equal(ethers.parseEther("0.5"));
  });

  it("blocks reentrancy on withdraw", async () => {
    const [deployer, operator, treasury, feeRecipient, attacker] = await ethers.getSigners();
    const ReentrantToken = await ethers.getContractFactory("ReentrantToken");
    const token = await ReentrantToken.deploy();
    await token.waitForDeployment();

    const VaultLedger = await ethers.getContractFactory("VaultLedger");
    const vault = await VaultLedger.deploy(
      await token.getAddress(),
      ethers.ZeroAddress,
      treasury.address,
      feeRecipient.address,
      0,
      operator.address,
    );
    await vault.waitForDeployment();

    await token.setVault(await vault.getAddress());
    await token.mint(await token.getAddress(), ethers.parseEther("2"));
    await token.approveVault(ethers.parseEther("2"));
    await token.depositToVault(ethers.parseEther("2"));
    await token.setReenter(true, ethers.parseEther("1"));

    await expect(token.withdrawFromVault(ethers.parseEther("1"))).to.be.revertedWith(
      "ReentrancyGuard: reentrant call",
    );
  });
});
