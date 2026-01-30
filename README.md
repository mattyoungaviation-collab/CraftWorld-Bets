# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## Server persistence

The API stores bets on disk. Set `BETS_DATA_DIR` to a persistent volume path (for example, `/var/data` on Render) so redeploys keep existing bets. If unset, the server falls back to `server/data`.

User sign-in metadata is stored in Postgres via Prisma. Configure `DATABASE_URL` and run migrations before starting the server.

## Running locally

Install dependencies, then start the dev server:

```bash
npm install
npm run dev
```

Make sure you have a `.env` file (or environment variables) configured with the values below so the vault ledger flows can function.

### Database setup

1. Create a Postgres database and set `DATABASE_URL`.
2. Run migrations:

```bash
npx prisma migrate deploy
```

### Vault ledger smoke test

With the contracts deployed and the server running, you can exercise a full deposit → bet → settle → withdraw flow:

```bash
RONIN_RPC=... \
VAULT_LEDGER_ADDRESS=0x... \
DYNW_TOKEN_ADDRESS=0x... \
OPERATOR_PRIVATE_KEY=0x... \
TEST_USER_PRIVATE_KEY=0x... \
DYNW_MINTABLE=true \
node scripts/vault-ledger-smoke.mjs
```

## Vault Ledger smart contract

The `contracts/VaultLedger.sol` contract escrows DYNW (and optional WRON) on-chain and maintains an internal ledger for
each wallet. Users deposit and withdraw directly. Bets lock internal balances, and the operator can only settle by
moving value between ledgers and the treasury/fee accounts.

**Authorization model:** Option A (operator-settlement). Users call `placeBet` directly from their wallet. The
`OPERATOR_ROLE` can call `settleBet`, but it can only move balances between internal ledgers and the treasury/fee
accounts—never withdraw user balances to arbitrary addresses.

**Bet IDs:** The frontend and backend derive bet IDs as `keccak256("cw-bet:<masterpieceId>:<position>")` so all wagers
for a single market share the same on-chain `betId`.

### Deploying the Vault Ledger to Ronin

Provide the deployment secrets via your deployment system (do not commit them), then run:

```bash
RONIN_RPC=... \
DEPLOYER_PRIVATE_KEY=0x... \
DYNW_TOKEN_ADDRESS=0x... \
WRON_ADDRESS=0x... \
TREASURY_ADDRESS=0x... \
FEE_RECIPIENT=0x... \
FEE_BPS=500 \
OPERATOR_ADDRESS=0x... \
npm run deploy:vault-ledger
```

The deployment script compiles `contracts/VaultLedger.sol`, deploys it to Ronin, and writes a
`vault-ledger-deployment.json` file containing the deployed address and configuration. It also writes
`VaultLedger.metadata.json`, which contains the Solidity compiler metadata required by some verification flows.

### Verifying the Vault Ledger on Ronin

To make the contract readable on the Ronin explorer, verify it after deployment:

1. Open `vault-ledger-deployment.json` and copy the deployed `address`.
2. Use the Ronin explorer's **Verify & Publish** flow with:
   - **Compiler version:** from `vault-ledger-deployment.json` (`compilerVersion`).
   - **Optimizer:** enabled, runs `200`.
   - **Constructor args:** `dynwToken`, `wronToken`, `treasury`, `feeRecipient`, `feeBps`, `operator` (in that order).
3. Upload the Solidity source from `contracts/VaultLedger.sol`.
4. If the explorer asks for metadata, upload `VaultLedger.metadata.json`.

Once verified, the explorer will show the full source and ABI for anyone to read.

## DYNW Integration

The DynoWager (DYNW) integration pulls balances, prices, and vault ledger state from Ronin Mainnet.

### Frontend configuration (Vite)

Set the following environment variables in your frontend `.env` file:

- `VITE_WALLETCONNECT_PROJECT_ID` – WalletConnect project ID (required for wallet connection).
- `VITE_VAULT_LEDGER_ADDRESS` – Deployed VaultLedger contract address.
- `VITE_WRON_ADDRESS` – Wrapped RON (WRON) token address (optional, only used for price discovery).
- `VITE_KATANA_FACTORY_ADDRESS` – Katana factory address (optional if you set the pair address).
- `VITE_KATANA_PAIR_ADDRESS` – Known DYNW/WRON pair address (optional if factory is set).

If the factory address is unavailable, set `VITE_KATANA_PAIR_ADDRESS` directly so the app can load pool reserves and price.

### Server configuration

Set the server environment variables for settlement and betting:

- `JWT_SECRET` – JWT signing secret for auth tokens (required).
- `DATABASE_URL` – Postgres connection string (required).
- `BET_MAX_AMOUNT` – Optional max bet size (token units).
- `RONIN_RPC` – Ronin RPC URL (defaults to `https://api.roninchain.com/rpc`).
- `OPERATOR_PRIVATE_KEY` – Private key for the operator that calls `settleBet` (required for settlement).
- `VAULT_LEDGER_ADDRESS` – Deployed VaultLedger contract address (required for settlement).
- `DYNW_TOKEN_ADDRESS` – DYNW token address (defaults to `0x17ff4EA5dD318E5FAf7f5554667d65abEC96Ff57`).
- `WRON_ADDRESS` – WRON token address (optional, if WRON support is enabled).
- `TREASURY_ADDRESS` – Treasury address used at contract deployment.
- `FEE_RECIPIENT` – Fee recipient address used at contract deployment.
- `FEE_BPS` – Fee in basis points used at contract deployment.

### Token assets

This repo includes lightweight SVG placeholders (`public/dynowager-300.svg` and `public/dynowager-banner-1280x230.svg`)
to avoid committing binary assets. Replace them with the official PNG/JPG files during deployment if needed and update
the references in `src/pages/Token.tsx`.

## Render deployment notes

1. Provision a Postgres database and set `DATABASE_URL` in Render.
   - Use the **Internal Database URL** from Render so the app can reach the database from the same private network.
2. Add a persistent disk and set `BETS_DATA_DIR` (e.g., `/var/data`).
3. Set the required environment variables from the server configuration section above.
4. Configure Render commands:
   - **Build Command:** `npm install && npm run prisma:generate && npm run build`
   - **Start Command:** `npm run migrate:deploy && npm start`
