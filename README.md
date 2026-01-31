# CraftWorld Bets

CraftWorld Bets includes the original leaderboard betting desk plus a new multiplayer **Crash** game that runs in realtime with a provably fair commit-reveal flow and on-chain settlement via dedicated pool contracts.

## Crash game overview

Crash is a shared, global round:

- All players in all browsers are in the same round.
- Betting is open for ~6 seconds, then the multiplier starts at **0.50x** and rises smoothly until the round crashes.
- Players may cash out any time before the crash to lock their payout.
- Payout = `betAmount * cashoutMultiplier`; if the round crashes before cashout, payout = 0.
- The round never exceeds **50x**.

**Provably fair:**

1. The server commits to a random seed (`commitHash = keccak256(serverSeed)`) before betting closes.
2. After the crash, the server reveals `serverSeed` and the derived hash to verify the crash point.
3. Distribution embeds a 2% house edge:

```
P(crash >= x) = (1 - edge) / x,  edge = 2%
crash = (1 - edge) / u
```

## On-chain payout contracts

### MasterpiecePool (leaderboard bets)

`contracts/MasterpiecePool.sol` holds DYNW wagers for each leaderboard market and pays out winners directly to their wallets once the operator settles a result.

- `placeBet(betId, position, amount)` transfers DYNW into the pool for the given market.
- `settleMarket(...)` executes the pro‑rata payouts computed by the server (same pool math already in the app).
- `carryoverByPosition[position]` tracks carryovers between markets for the same position.

### CrashVault (Crash rounds)

`contracts/CrashVault.sol` holds Crash stakes and pays out cashouts directly to players.

- `placeBet(roundId, amount)` transfers the user stake into the vault.
- `cashout(roundId, user, payout)` (operator-only) pays `payout = stake * multiplier`.
- `settleLoss(roundId, user)` (operator-only) moves the stake to the treasury after the crash.

### Vault Ledger (legacy)

`contracts/VaultLedger.sol` escrows DYNW on-chain and maintains a ledger of available + locked balances.

- `depositDYNW` / `withdrawDYNW`
- `placeBet` locks funds for a `betId`
- `settleBet` unlocks the stake and applies a net win/loss against the treasury
- Only the **operator** can call `settleBet`

## Deploying the pool contracts to Ronin

### 1) Deploy MasterpiecePool

```bash
RONIN_RPC=... \
DEPLOYER_PRIVATE_KEY=0x... \
DYNW_TOKEN_ADDRESS=0x... \
TREASURY_ADDRESS=0x... \
OPERATOR_ADDRESS=0x... \
npx hardhat run --network ronin scripts/deploy-masterpiece-pool.ts
```

### 2) Deploy CrashVault

```bash
RONIN_RPC=... \
DEPLOYER_PRIVATE_KEY=0x... \
DYNW_TOKEN_ADDRESS=0x... \
TREASURY_ADDRESS=0x... \
OPERATOR_ADDRESS=0x... \
npx hardhat run --network ronin scripts/deploy-crash-vault.ts
```

### 3) Fund the pools

Each pool must hold enough DYNW to pay out winners:

1. Transfer DYNW to the pool contract addresses (MasterpiecePool + CrashVault).
2. Keep the treasury funded for carryover/house accounting.
3. Confirm balances with a block explorer or `cast balance`.

### 4) Verify contracts

After deployment, verify the contracts on the Ronin explorer:

```bash
npx hardhat verify --network ronin <MASTERPIECE_POOL_ADDRESS> <DYNW_TOKEN_ADDRESS> <TREASURY_ADDRESS> <OPERATOR_ADDRESS>
npx hardhat verify --network ronin <CRASH_VAULT_ADDRESS> <DYNW_TOKEN_ADDRESS> <TREASURY_ADDRESS> <OPERATOR_ADDRESS>
```

If you redeploy, update the frontend + backend env vars (see below) and re-fund the new contracts.

### Deploying the Vault Ledger to Ronin (legacy)

```bash
RONIN_RPC=... \
DEPLOYER_PRIVATE_KEY=0x... \
DYNW_TOKEN_ADDRESS=0x... \
TREASURY_ADDRESS=0x... \
OPERATOR_ADDRESS=0x... \
npm run deploy:vault-ledger
```

The script writes `vault-ledger-deployment.json` and `VaultLedger.metadata.json` for verification.

### Smoke test (legacy)

```bash
RONIN_RPC=... \
VAULT_LEDGER_ADDRESS=0x... \
DYNW_TOKEN_ADDRESS=0x... \
OPERATOR_PRIVATE_KEY=0x... \
TEST_USER_PRIVATE_KEY=0x... \
DYNW_MINTABLE=true \
node scripts/vault-ledger-smoke.mjs
```

## Environment variables

### Server (Render + local)

- `JWT_SECRET`
- `DATABASE_URL`
- `RONIN_RPC`
- `DYNW_TOKEN_ADDRESS`
- `MASTERPIECE_POOL_ADDRESS`
- `CRASH_VAULT_ADDRESS`
- `OPERATOR_PRIVATE_KEY`
- `TREASURY_ADDRESS`
- `BETS_DATA_DIR=/var/data`
- `CRASH_MIN_BET=10`
- `CRASH_MAX_BET=2500`
- `CRASH_HOUSE_EDGE_BPS=200`
- `CRASH_BETTING_MS=6000`
- `CRASH_COOLDOWN_MS=4000`

### Frontend (Vite)

- `VITE_WALLETCONNECT_PROJECT_ID`
- `VITE_MASTERPIECE_POOL_ADDRESS`
- `VITE_CRASH_VAULT_ADDRESS`
- `VITE_VAULT_LEDGER_ADDRESS` (legacy)
- `VITE_WRON_ADDRESS` (optional)
- `VITE_KATANA_FACTORY_ADDRESS` (optional)
- `VITE_KATANA_PAIR_ADDRESS` (optional)

## Local development

```bash
npm install
npm run dev:all
```

This runs:
- Vite on `http://localhost:5173`
- Express + Socket.IO on `http://localhost:3000`

> Vite proxies `/api` and `/socket.io` to the backend.

### Database setup

```bash
npx prisma migrate deploy
```

## Render deployment

1. Create a **Web Service** on Render.
2. Add a **Disk** mounted at `/var/data` and set `BETS_DATA_DIR=/var/data`.
3. Add a Render Postgres instance and set `DATABASE_URL`.
4. Ensure Node 20 (already specified in `package.json`).
5. Commands:
   - **Build Command:** `npm install && npm run build && npx prisma migrate deploy`
   - **Start Command:** `npm start`
6. Ensure websockets are enabled (Socket.IO uses the same service).

## Treasury bankroll checklist

The pools must be funded to cover payouts:

- [ ] Treasury wallet holds DYNW.
- [ ] Transfer DYNW into the MasterpiecePool and CrashVault contracts.
- [ ] Operator wallet is funded for gas.
- [ ] Verify balances and run a test round to confirm payouts.
