import { expect } from "chai";
import { ethers } from "hardhat";

describe("VaultLedger", () => {
  async function deployFixture() {
    const [deployer, operator, treasury, user, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const dynw = await MockERC20.deploy("DynoWager", "DYNW");
    await dynw.waitForDeployment();

    const VaultLedger = await ethers.getContractFactory("VaultLedger");
    const vault = await VaultLedger.deploy(
      await dynw.getAddress(),
      treasury.address,
      operator.address
    );
    await vault.waitForDeployment();

    await dynw.mint(user.address, ethers.parseEther("100"));
    await dynw.connect(user).approve(await vault.getAddress(), ethers.parseEther("100"));
    await dynw.mint(treasury.address, ethers.parseEther("100"));
    await dynw.connect(treasury).approve(await vault.getAddress(), ethers.parseEther("100"));

    return { deployer, operator, treasury, user, other, dynw, vault };
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

    await expect(
      vault.connect(other).settleBet(betId, await dynw.getAddress(), amount, 1, [user.address]),
    )
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

  it("settles a winning cashout using treasury funds", async () => {
    const { operator, treasury, user, dynw, vault } = await deployFixture();
    const betId = ethers.id("bet-2");
    const stake = ethers.parseEther("4");
    const profit = ethers.parseEther("2");

    await vault.connect(user).depositDYNW(stake);
    await vault.connect(treasury).depositDYNW(ethers.parseEther("10"));
    await vault.connect(user).placeBet(betId, await dynw.getAddress(), stake);

    await expect(
      vault.connect(operator).settleBet(betId, await dynw.getAddress(), profit, 1, [user.address]),
    )
      .to.emit(vault, "BetSettled")
      .withArgs(betId, user.address, await dynw.getAddress(), stake, profit, 1);

    const userBalance = await vault.balances(user.address, await dynw.getAddress());
    const treasuryBalance = await vault.balances(treasury.address, await dynw.getAddress());
    expect(userBalance).to.equal(ethers.parseEther("6"));
    expect(treasuryBalance).to.equal(ethers.parseEther("8"));
  });

  it("settles a losing bet to the treasury", async () => {
    const { operator, treasury, user, dynw, vault } = await deployFixture();
    const betId = ethers.id("bet-3");
    const stake = ethers.parseEther("5");

    await vault.connect(user).depositDYNW(stake);
    await vault.connect(user).placeBet(betId, await dynw.getAddress(), stake);

    await expect(
      vault.connect(operator).settleBet(betId, await dynw.getAddress(), stake, 2, [user.address]),
    )
      .to.emit(vault, "BetSettled")
      .withArgs(betId, user.address, await dynw.getAddress(), stake, stake, 2);

    const userBalance = await vault.balances(user.address, await dynw.getAddress());
    const treasuryBalance = await vault.balances(treasury.address, await dynw.getAddress());
    expect(userBalance).to.equal(0);
    expect(treasuryBalance).to.equal(stake);
  });

  it("blocks reentrancy on withdraw", async () => {
    const [deployer, operator, treasury, attacker] = await ethers.getSigners();
    const ReentrantToken = await ethers.getContractFactory("ReentrantToken");
    const token = await ReentrantToken.deploy();
    await token.waitForDeployment();

    const VaultLedger = await ethers.getContractFactory("VaultLedger");
    const vault = await VaultLedger.deploy(
      await token.getAddress(),
      treasury.address,
      operator.address
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
