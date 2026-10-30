// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title GroupFarm
/// @notice Stake Uniswap v2 LP tokens and earn GROUP1 over a fixed campaign.
///
/// - Each pool (one per registered LP token) has its own budget, spread evenly over `duration`.
/// - Rewards are shared pro-rata by staked amount and time (reward-per-share accumulator,
///   no loops over users).
/// - Time with an empty pool is NOT given to later stakers.
/// - No owner and no admin functions: nobody can pull user LP or earned rewards.
/// - The reward token and the LP tokens are different tokens, so the reward fund and
///   the staked principal are always accounted separately.
contract GroupFarm is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant PRECISION = 1e18;

    IERC20 public immutable rewardToken;
    uint256 public immutable duration;       // seconds
    uint256 public immutable budgetPerPool;  // reward tokens (wei) per pool for the whole campaign

    IERC20[] public lpTokens;                // fixed list, set in constructor

    bool public started;
    uint256 public startTime;
    uint256 public endTime;
    uint256 public totalClaimed;             // total rewards paid out so far

    struct Pool {
        uint256 totalStaked;
        uint256 accRewardPerShare; // scaled by PRECISION
        uint256 lastUpdate;
    }

    struct User {
        uint256 amount;
        uint256 rewardDebt;
        uint256 pending;
    }

    Pool[] private _pools;
    mapping(uint256 => mapping(address => User)) private _users;

    event SessionStarted(uint256 startTime, uint256 endTime);
    event Staked(address indexed user, uint256 indexed poolId, uint256 amount);
    event Withdrawn(address indexed user, uint256 indexed poolId, uint256 amount);
    event Claimed(address indexed user, uint256 indexed poolId, uint256 amount);

    constructor(
        address rewardToken_,
        address[] memory lpTokens_,
        uint256 duration_,
        uint256 budgetPerPool_
    ) {
        require(rewardToken_ != address(0), "reward token is zero");
        require(lpTokens_.length > 0 && lpTokens_.length <= 8, "bad pool count");
        require(duration_ > 0, "duration is zero");
        require(budgetPerPool_ > 0, "budget is zero");

        rewardToken = IERC20(rewardToken_);
        duration = duration_;
        budgetPerPool = budgetPerPool_;

        for (uint256 i = 0; i < lpTokens_.length; i++) {
            address lp = lpTokens_[i];
            require(lp != address(0), "lp is zero");
            require(lp != rewardToken_, "lp equals reward token");
            for (uint256 j = 0; j < i; j++) {
                require(lp != lpTokens_[j], "duplicate lp");
            }
            lpTokens.push(IERC20(lp));
            _pools.push();
        }
    }

    // ------------------------------------------------------------------
    // Campaign start
    // ------------------------------------------------------------------

    /// @notice Starts the campaign. Callable once, and only when the contract already
    /// holds the full reward fund (budgetPerPool * number of pools).
    function startSession() external {
        require(!started, "already started");
        require(
            rewardToken.balanceOf(address(this)) >= budgetPerPool * lpTokens.length,
            "fund incomplete"
        );

        started = true;
        startTime = block.timestamp;
        endTime = block.timestamp + duration;
        for (uint256 i = 0; i < _pools.length; i++) {
            _pools[i].lastUpdate = startTime;
        }
        emit SessionStarted(startTime, endTime);
    }

    // ------------------------------------------------------------------
    // User actions
    // ------------------------------------------------------------------

    function stake(uint256 poolId, uint256 amount) external nonReentrant {
        _checkPool(poolId);
        require(amount > 0, "amount is zero");

        _updatePool(poolId);
        User storage u = _users[poolId][msg.sender];
        _settle(poolId, u);

        lpTokens[poolId].safeTransferFrom(msg.sender, address(this), amount);

        u.amount += amount;
        _pools[poolId].totalStaked += amount;
        u.rewardDebt = (u.amount * _pools[poolId].accRewardPerShare) / PRECISION;

        emit Staked(msg.sender, poolId, amount);
    }

    function withdraw(uint256 poolId, uint256 amount) external nonReentrant {
        _checkPool(poolId);
        User storage u = _users[poolId][msg.sender];
        require(amount > 0, "amount is zero");
        require(amount <= u.amount, "amount exceeds stake");

        _updatePool(poolId);
        _settle(poolId, u);

        u.amount -= amount;
        _pools[poolId].totalStaked -= amount;
        u.rewardDebt = (u.amount * _pools[poolId].accRewardPerShare) / PRECISION;

        lpTokens[poolId].safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, poolId, amount);
    }

    function claim(uint256 poolId) external nonReentrant {
        _checkPool(poolId);
        _claim(poolId);
    }

    /// @notice Claims from every pool (loops over the few pools, never over users).
    function claimAll() external nonReentrant {
        for (uint256 i = 0; i < _pools.length; i++) {
            _claim(i);
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function poolCount() external view returns (uint256) {
        return _pools.length;
    }

    function totalStaked(uint256 poolId) external view returns (uint256) {
        _checkPool(poolId);
        return _pools[poolId].totalStaked;
    }

    function staked(address account, uint256 poolId) external view returns (uint256) {
        _checkPool(poolId);
        return _users[poolId][account].amount;
    }

    /// @notice Rewards the account could claim right now from this pool.
    function earned(address account, uint256 poolId) public view returns (uint256) {
        _checkPool(poolId);
        Pool memory p = _pools[poolId];
        User memory u = _users[poolId][account];

        uint256 acc = p.accRewardPerShare;
        if (started && p.totalStaked > 0) {
            uint256 t = block.timestamp < endTime ? block.timestamp : endTime;
            if (t > p.lastUpdate) {
                acc += (budgetPerPool * (t - p.lastUpdate) * PRECISION) / (duration * p.totalStaked);
            }
        }
        return u.pending + (u.amount * acc) / PRECISION - u.rewardDebt;
    }

    /// @notice Sum of earned rewards across all pools.
    function earnedAll(address account) external view returns (uint256 total) {
        for (uint256 i = 0; i < _pools.length; i++) {
            total += earned(account, i);
        }
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    function _checkPool(uint256 poolId) private view {
        require(poolId < _pools.length, "bad pool");
    }

    /// Accrues rewards up to min(now, endTime). If nobody is staked, time advances
    /// but nothing is accrued, so empty time is never given to later stakers.
    function _updatePool(uint256 poolId) private {
        if (!started) return;
        Pool storage p = _pools[poolId];
        uint256 t = block.timestamp < endTime ? block.timestamp : endTime;
        if (t <= p.lastUpdate) return;

        if (p.totalStaked > 0) {
            p.accRewardPerShare +=
                (budgetPerPool * (t - p.lastUpdate) * PRECISION) / (duration * p.totalStaked);
        }
        p.lastUpdate = t;
    }

    /// Moves everything earned so far into `pending`.
    function _settle(uint256 poolId, User storage u) private {
        uint256 accumulated = (u.amount * _pools[poolId].accRewardPerShare) / PRECISION;
        u.pending += accumulated - u.rewardDebt;
        u.rewardDebt = accumulated;
    }

    function _claim(uint256 poolId) private {
        _updatePool(poolId);
        User storage u = _users[poolId][msg.sender];
        _settle(poolId, u);

        uint256 amount = u.pending;
        if (amount == 0) return;

        u.pending = 0;                 // state first, transfer after
        totalClaimed += amount;
        rewardToken.safeTransfer(msg.sender, amount);

        emit Claimed(msg.sender, poolId, amount);
    }
}
