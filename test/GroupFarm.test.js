const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const e18 = (n) => ethers.parseUnits(String(n), 18);
const DURATION = 360n;            // 6-minute test campaign
const BUDGET = e18(2000);         // per pool
const TOL = 10n ** 12n;           // 1e-6 token rounding tolerance

// reward for `secs` seconds of one pool's budget, times num/den (the staker's share)
const share = (secs, num = 1n, den = 1n) => (BUDGET * BigInt(secs) * num) / (DURATION * den);
const approx = (actual, expected) => {
  const diff = actual > expected ? actual - expected : expected - actual;
  expect(diff <= TOL, `expected ~${expected} but got ${actual}`).to.equal(true);
};

describe("GroupFarm", () => {
  async function deployFixture() {
    const [deployer, alice, bob] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("SimpleToken");
    const reward = await Token.deploy("Group 1 Token", "GROUP1", e18(100_000_000));
    const lp0 = await Token.deploy("LP0", "LP0", e18(1_000_000));
    const lp1 = await Token.deploy("LP1", "LP1", e18(1_000_000));
    const wrong = await Token.deploy("Wrong", "WRONG", e18(1_000_000));

    const Farm = await ethers.getContractFactory("GroupFarm");
    const farm = await Farm.deploy(
      await reward.getAddress(),
      [await lp0.getAddress(), await lp1.getAddress()],
      DURATION,
      BUDGET
    );
    const farmAddr = await farm.getAddress();

    for (const user of [alice, bob]) {
      for (const lp of [lp0, lp1, wrong]) {
        await lp.transfer(user.address, e18(1000));
        await lp.connect(user).approve(farmAddr, ethers.MaxUint256);
      }
    }
    await reward.transfer(farmAddr, BUDGET * 2n); // full fund (2 pools)

    return { deployer, alice, bob, reward, lp0, lp1, wrong, farm, farmAddr };
  }

  // start the campaign at a known timestamp; returns T0
  async function begin(farm) {
    const T0 = (await time.latest()) + 100;
    await time.setNextBlockTimestamp(T0);
    await farm.startSession();
    return T0;
  }
  const at = (t) => time.setNextBlockTimestamp(t);

  it("1. single staker receives all rewards for their active time", async () => {
    const { farm, alice, reward } = await loadFixture(deployFixture);
    const T0 = await begin(farm);

    await at(T0 + 10);
    await farm.connect(alice).stake(0, e18(100));
    await at(T0 + 110);
    await farm.connect(alice).claim(0);

    approx(await reward.balanceOf(alice.address), share(100));
  });

  it("2. a later staker gets nothing for the time before joining", async () => {
    const { farm, alice, bob, reward } = await loadFixture(deployFixture);
    const T0 = await begin(farm);

    await at(T0 + 10);
    await farm.connect(alice).stake(0, e18(100));
    await at(T0 + 190);
    await farm.connect(bob).stake(0, e18(300));

    await at(T0 + 1000); // after the end
    await farm.connect(alice).claim(0);
    await farm.connect(bob).claim(0);

    // alice: alone for 180s, then 25% of the remaining 170s
    approx(await reward.balanceOf(alice.address), share(180) + share(170, 1n, 4n));
    // bob: only 75% of the last 170s
    approx(await reward.balanceOf(bob.address), share(170, 3n, 4n));
  });

  it("3. staking in several pools is accounted independently", async () => {
    const { farm, alice, reward } = await loadFixture(deployFixture);
    const T0 = await begin(farm);

    await at(T0 + 10);
    await farm.connect(alice).stake(0, e18(100));
    await at(T0 + 11);
    await farm.connect(alice).stake(1, e18(5));

    await at(T0 + 1000);
    await farm.connect(alice).claimAll();

    // pool 0: from +10, pool 1: from +11, each alone in its pool
    approx(await reward.balanceOf(alice.address), share(350) + share(349));
  });

  it("4. partial withdrawal reduces future rewards", async () => {
    const { farm, alice, bob, reward, lp0 } = await loadFixture(deployFixture);
    const T0 = await begin(farm);

    await at(T0 + 10);
    await farm.connect(alice).stake(0, e18(200));
    await at(T0 + 11);
    await farm.connect(bob).stake(0, e18(100));
    await at(T0 + 191);
    await farm.connect(alice).withdraw(0, e18(100)); // now both have 100

    await at(T0 + 1000);
    await farm.connect(alice).claim(0);
    await farm.connect(bob).claim(0);

    // 10..11 alice alone; 11..191 alice 2/3, bob 1/3; 191..360 each 1/2
    approx(
      await reward.balanceOf(alice.address),
      share(1) + share(180, 2n, 3n) + share(169, 1n, 2n)
    );
    approx(
      await reward.balanceOf(bob.address),
      share(180, 1n, 3n) + share(169, 1n, 2n)
    );
    expect(await lp0.balanceOf(alice.address)).to.equal(e18(900)); // 1000 - 200 + 100
  });

  it("5. a repeated claim pays nothing extra", async () => {
    const { farm, alice, reward } = await loadFixture(deployFixture);
    const T0 = await begin(farm);

    await at(T0 + 10);
    await farm.connect(alice).stake(0, e18(100));
    await at(T0 + 1000);
    await farm.connect(alice).claim(0);
    const first = await reward.balanceOf(alice.address);
    expect(first > 0n).to.equal(true);

    await at(T0 + 1001);
    await farm.connect(alice).claim(0);
    expect(await reward.balanceOf(alice.address)).to.equal(first);
  });

  it("6. empty pool time is not given to the next staker", async () => {
    const { farm, alice, reward, farmAddr } = await loadFixture(deployFixture);
    const T0 = await begin(farm);

    await at(T0 + 180); // pool was empty for the first 180s
    await farm.connect(alice).stake(0, e18(100));
    await at(T0 + 1000);
    await farm.connect(alice).claim(0);

    approx(await reward.balanceOf(alice.address), share(180)); // only the second half
    // the unassigned half stays in the contract, never paid out
    expect((await reward.balanceOf(farmAddr)) >= BUDGET + share(180)).to.equal(true);
  });

  it("7. after the end nothing accrues, but claim and withdraw still work", async () => {
    const { farm, alice, reward, lp0 } = await loadFixture(deployFixture);
    const T0 = await begin(farm);

    await at(T0 + 10);
    await farm.connect(alice).stake(0, e18(100));

    await at(T0 + 400); // campaign ended at T0 + 360
    await farm.connect(alice).claim(0);
    approx(await reward.balanceOf(alice.address), share(350));

    const after = await reward.balanceOf(alice.address);
    await at(T0 + 5000);
    expect(await farm.earned(alice.address, 0)).to.equal(0n);
    await farm.connect(alice).claim(0);
    expect(await reward.balanceOf(alice.address)).to.equal(after);

    await farm.connect(alice).withdraw(0, e18(100)); // principal is returned
    expect(await lp0.balanceOf(alice.address)).to.equal(e18(1000));
  });

  it("8. wrong token / wrong pool cannot be staked", async () => {
    const { farm, alice, wrong } = await loadFixture(deployFixture);
    await begin(farm);

    await expect(farm.connect(alice).stake(2, e18(1))).to.be.revertedWith("bad pool");
    await expect(farm.connect(alice).stake(99, e18(1))).to.be.revertedWith("bad pool");
    expect(await farm.poolCount()).to.equal(2n);

    const Farm = await ethers.getContractFactory("GroupFarm");
    const reward = await farm.rewardToken();
    const wrongAddr = await wrong.getAddress();
    // the reward token can never be registered as an LP token, and duplicates are rejected
    await expect(Farm.deploy(reward, [reward], DURATION, BUDGET)).to.be.revertedWith(
      "lp equals reward token"
    );
    await expect(Farm.deploy(reward, [wrongAddr, wrongAddr], DURATION, BUDGET)).to.be.revertedWith(
      "duplicate lp"
    );
  });

  it("9. paid + still owed never exceeds the funded budget", async () => {
    const { farm, alice, bob, reward, farmAddr } = await loadFixture(deployFixture);
    const T0 = await begin(farm);

    await at(T0 + 5);
    await farm.connect(alice).stake(0, e18(123));
    await at(T0 + 6);
    await farm.connect(bob).stake(0, e18(77));
    await at(T0 + 7);
    await farm.connect(alice).stake(1, e18(333));
    await at(T0 + 8);
    await farm.connect(bob).stake(1, e18(1));

    await at(T0 + 2000);
    const owed =
      (await farm.earnedAll(alice.address)) + (await farm.earnedAll(bob.address));
    const funded = BUDGET * 2n;
    expect(owed <= funded).to.equal(true);

    await farm.connect(alice).claimAll();
    await farm.connect(bob).claimAll();
    const paid = await farm.totalClaimed();
    expect(paid <= funded).to.equal(true);
    expect((await reward.balanceOf(farmAddr)) + paid).to.equal(funded);
  });

  it("no rewards before the campaign starts", async () => {
    const { farm, alice, reward } = await loadFixture(deployFixture);

    await farm.connect(alice).stake(0, e18(100)); // staked before start
    await time.increase(500);
    expect(await farm.earned(alice.address, 0)).to.equal(0n);

    const T0 = await begin(farm);
    await at(T0 + 1000);
    await farm.connect(alice).claim(0);
    approx(await reward.balanceOf(alice.address), BUDGET); // exactly one full pool budget
  });

  it("startSession needs the full fund and works only once", async () => {
    const { deployer, reward, lp0, lp1, farm } = await loadFixture(deployFixture);
    const Farm = await ethers.getContractFactory("GroupFarm");
    const f2 = await Farm.deploy(
      await reward.getAddress(),
      [await lp0.getAddress(), await lp1.getAddress()],
      DURATION,
      BUDGET
    );
    await expect(f2.startSession()).to.be.revertedWith("fund incomplete");
    await reward.transfer(await f2.getAddress(), BUDGET); // only half
    await expect(f2.startSession()).to.be.revertedWith("fund incomplete");
    await reward.transfer(await f2.getAddress(), BUDGET);
    await f2.startSession();
    await expect(f2.startSession()).to.be.revertedWith("already started");
    expect(await f2.started()).to.equal(true);
    expect(await f2.endTime() - (await f2.startTime())).to.equal(DURATION);
  });

  it("withdraw cannot exceed the user's own stake", async () => {
    const { farm, alice, bob } = await loadFixture(deployFixture);
    await begin(farm);
    await farm.connect(alice).stake(0, e18(100));
    await expect(farm.connect(bob).withdraw(0, e18(1))).to.be.revertedWith("amount exceeds stake");
    await expect(farm.connect(alice).withdraw(0, e18(101))).to.be.revertedWith("amount exceeds stake");
  });
});
