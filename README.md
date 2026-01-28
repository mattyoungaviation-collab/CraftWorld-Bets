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

## Smart contract payment routing

The `contracts/BetPaymentRouter.sol` contract routes wager payments by splitting a total amount into a service fee and an escrow transfer. Configure the fee recipient, escrow recipient, and fee bps at deployment time, then call `routeTokenPayment` with the ERC-20 token address, total amount, and a bet id to emit an on-chain receipt.

### Deploying the router to Ronin

Provide the deployment secrets via your deployment system (do not commit them), then run:

```bash
RONIN_RPC=... \
DEPLOYER_PRIVATE_KEY=... \
FEE_RECIPIENT=0x... \
ESCROW_RECIPIENT=0x... \
FEE_BPS=500 \
npm run deploy:router
```

The deployment script compiles `contracts/BetPaymentRouter.sol`, deploys it to Ronin, and writes a `router-deployment.json`
file containing the deployed address and configuration.

### Verifying the router on Ronin

To make the contract readable on the Ronin explorer, verify it after deployment:

1. Open `router-deployment.json` and copy the deployed `address`.
2. Use the Ronin explorer's **Verify & Publish** flow with:
   - **Compiler version:** from `router-deployment.json` (`compilerVersion`).
   - **Optimizer:** enabled, runs `200`.
   - **Constructor args:** `feeRecipient`, `escrowRecipient`, `feeBps` (in that order).
3. Paste the source from `contracts/BetPaymentRouter.sol`.

Once verified, the explorer will show the full source and ABI for anyone to read.
