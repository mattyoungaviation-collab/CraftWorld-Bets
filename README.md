# CraftWorld Bets

CraftWorld Bets includes the original leaderboard betting desk plus a new multiplayer **Crash** game that runs in realtime with a provably fair commit-reveal flow and on-chain settlement via the VaultLedger contract.

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

## Vault Ledger smart contract

`contracts/VaultLedger.sol` escrows DYNW on-chain and maintains a ledger of available + locked balances.

- `depositDYNW` / `withdrawDYNW`
- `placeBet` locks funds for a `betId`
- `settleBet` unlocks the stake and applies a net win/loss against the treasury
- Only the **operator** can call `settleBet`

### Deploying the Vault Ledger to Ronin

```bash
RONIN_RPC=... \
DEPLOYER_PRIVATE_KEY=0x... \
DYNW_TOKEN_ADDRESS=0x... \
TREASURY_ADDRESS=0x... \
OPERATOR_ADDRESS=0x... \
npm run deploy:vault-ledger
```

The script writes `vault-ledger-deployment.json` and `VaultLedger.metadata.json` for verification.

### Smoke test

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
- `VAULT_LEDGER_ADDRESS`
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
- `VITE_VAULT_LEDGER_ADDRESS`
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

The treasury ledger account must pre-fund the VaultLedger to cover Crash cashouts:

- [ ] Treasury wallet holds DYNW.
- [ ] Treasury approves the VaultLedger to transfer DYNW.
- [ ] Treasury deposits DYNW into the VaultLedger.
- [ ] Operator wallet is funded for gas.
- [ ] Run the smoke test to validate a full deposit → bet → settle → withdraw flow.
