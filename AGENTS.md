# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is a Solana MEV backrun arbitrage bot ("Solana Jito Flash Searcher") with a real-time web dashboard (Express + Socket.IO on port 3000). See `README.md` for full architecture details.

### Build & Lint

- **Lint**: `npm run lint` (eslint, passes clean)
- **Build**: `npm run build` (runs lint + tsc). The `tsc` step emits all `.js` files correctly but exits with code 2 due to parse errors in `node_modules/@solana/spl-token-group` `.d.ts` files — these use TypeScript 5.x `const` type parameter syntax incompatible with the project's TS 4.9.5. All source files compile correctly; the errors are exclusively in third-party declarations.
- **Standalone build** (skip lint): `npx tsc -p tsconfig.json`

### Running the application

The full bot (`npm start` / `node build/src/index.js`) requires real Solana infrastructure credentials (Jito Block Engine, Geyser gRPC, RPC endpoint, wallet keypairs). Without these, the process crashes due to gRPC connection failures in the Jito client.

**To run just the dashboard server** (no external dependencies):

```bash
node -e "import('./build/src/server.js').then(m => m.startDashboardServer())"
```

This starts the Express + Socket.IO dashboard on port 3000 with interactive start/stop and simulation/live mode toggles.

### Key gotchas

- Keypair files (`auth.json`, `payer.json`) are required at startup. Generate dummy ones with: `node -e "const{Keypair}=require('@solana/web3.js');const fs=require('fs');fs.writeFileSync('auth.json',JSON.stringify(Array.from(Keypair.generate().secretKey)));fs.writeFileSync('payer.json',JSON.stringify(Array.from(Keypair.generate().secretKey)))"`
- If the `PRIVATE_KEY` secret is base58-encoded (88 chars), convert to JSON array format: `node -e "const bs58=require('bs58');const fs=require('fs');const arr=Array.from(bs58.decode(process.env.PRIVATE_KEY));fs.writeFileSync('payer.json',JSON.stringify(arr));fs.writeFileSync('auth.json',JSON.stringify(arr))"`
- The full bot (`npm start`) requires all Jito infrastructure: `SOLANA_RPC_URL`, `BLOCK_ENGINE_URL`, `GEYSER_URL`, `GEYSER_ACCESS_TOKEN`, and `PRIVATE_KEY` secrets. The Geyser gRPC connection failure crashes the process before the dashboard starts.
- The project has both `yarn.lock` and `package-lock.json`; use `npm install` for consistency with `package.json` scripts.
- No automated test suite exists in this repository.
