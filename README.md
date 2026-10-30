# group-farm

LP staking contract: stake Uniswap v2 LP tokens, earn GROUP1.
No owner, no admin functions. 2 or 3 pools, set by `LP_TOKENS`.

## Commands

    npm run dev      install (if needed) + compile + test + deploy (if .env is filled in)
    npm run fund     send the GROUP1 reward fund to the farm and start the campaign
    npm test         run the tests only

## Use

1. `npm run dev` once: it creates `.env`.
2. Fill in `.env`: PRIVATE_KEY, GROUP1_ADDRESS, LP_TOKENS (the pair addresses).
3. `npm run dev` again: tests run, then the farm deploys. Copy the farm address.
4. `npm run fund`: sends budget x pools GROUP1 from your wallet to the farm, then starts.
   (Test: 2000 per pool = 4000 GROUP1 for 2 pools, 6 minutes.)

For the final campaign, change DURATION_MINUTES / BUDGET_PER_POOL in `.env` and deploy a new farm.

## Functions (for the web app)

    startSession()                 once, only after full funding
    stake(poolId, amount)
    withdraw(poolId, amount)
    claim(poolId) / claimAll()
    earned(account, poolId) / earnedAll(account)
    staked(account, poolId) / totalStaked(poolId) / poolCount()
    started() / startTime() / endTime() / totalClaimed() / lpTokens(i) / rewardToken()

Users must `approve` the LP token to the farm before `stake`.
