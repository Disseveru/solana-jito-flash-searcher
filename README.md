# Solana Jito Flash Searcher

> **2026 Edition** — A high-performance MEV backrun arbitrage bot for Solana, powered by **Jupiter v6**, **Jito-ts 4.2.1**, and **Solend Flash Loans**.

## Overview

The Flash Searcher monitors the Jito mempool for large DEX trades, detects temporary price imbalances, and atomically executes flash-loan-funded arbitrage transactions to profit from the dislocation — all within a single Solana transaction.

### How It Works

1. **Mempool Monitoring** — Subscribes to the Jito Block Engine for real-time pending transactions across Raydium, Raydium CLMM, Orca Whirlpools, and Orca AMM.
2. **Trade Detection** — Simulates incoming transactions with `simulateBundle` to determine trade direction, size, and affected token accounts.
3. **Flash Brain (Jupiter v6)** — The new `FlashBrain` module queries the Jupiter v6 aggregator for optimal multi-hop swap routes. No local RPC polling required.
4. **Atomic Execution** — Each arb transaction is assembled as a single `VersionedTransaction`:
   - **MEV Protection** — `jitodontfront` read-only account prefix prevents front-running.
   - **Flash Borrow** — Borrow SOL or USDC from Solend (30 bps fee).
   - **Arb Swap** — Execute the Jupiter-routed swap.
   - **Flash Repay** — Repay the loan + fee in the same transaction.
   - **Jito Tip** — Dynamic tip of 25% of net profit to a random Jito validator tip account.
5. **Safety Gate** — Every bundle is simulated with `simulateBundle` before broadcast. If `netProfit < flashLoanFee + tip`, the bundle is silently dropped.

## Tech Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| `jito-ts` | 4.2.1 | Block Engine SDK — mempool subscriptions, bundle sending, Geyser |
| `@jup-ag/api` | 6.x | Jupiter v6 — quote aggregation, swap instructions |
| `@solana/web3.js` | 1.98+ | Solana RPC, transactions, address lookup tables |
| `@solana/spl-token` | 0.4+ | SPL Token operations |
| `@solendprotocol/solend-sdk` | 0.6+ | Flash loan borrow / repay instructions |
| Node.js | ≥ 18 | Runtime |

## Quick Start

### Prerequisites

- **Node.js ≥ 18** and **npm** (or yarn)
- A Jito Block Engine auth keypair ([Get one here](https://jito-labs.gitbook.io/mev/searcher-resources/getting-started))
- A Solana wallet keypair with some SOL for gas
- A Jito-compatible RPC endpoint (must support `simulateBundle`)
- A Geyser gRPC endpoint + access token
- A multicore Linux machine, ideally co-located with your RPC and the Block Engine
- 16 GB RAM recommended (4 worker threads)

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/Disseveru/solana-jito-flash-searcher.git
cd solana-jito-flash-searcher

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your keypair paths, RPC URL, Block Engine URL, etc.

# 4. Run in Simulation Mode (dry-run — no bundles are broadcast)
SIMULATION_MODE=true npm start

# 5. Run in Production Mode (live bundle broadcasting)
npm start
```

### One-Line Simulation Start

```bash
SIMULATION_MODE=true npm start
```

This builds the project and starts the bot in **Simulation Mode**: the full pipeline runs (mempool → filter → simulate → FlashBrain), but bundles are logged instead of sent to the Block Engine.

### Run Legacy Pipeline

The original `bot.ts` pipeline (pre-Jupiter v6) is still available:

```bash
npm run start:legacy
```

### Run with Docker

```bash
sudo docker build . -t flash-searcher
export AUTH_KEYPAIR_PATH=/path/to/your/block/engine/keypair.json
export PAYER_KEYPAIR_PATH=/path/to/your/wallet/keypair.json
touch docker.trades.csv
sudo docker run \
    -d \
    -v $AUTH_KEYPAIR_PATH:/usr/src/app/auth.json:ro \
    -v $PAYER_KEYPAIR_PATH:/usr/src/app/payer.json:ro \
    -v $PWD/docker.trades.csv:/usr/src/app/trades.csv \
    --env-file .env \
    --restart=on-failure \
    flash-searcher
```

## Environment Variables

See [`.env.example`](.env.example) for a complete list. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `PAYER_KEYPAIR_PATH` | ✅ | Path to your Solana wallet keypair JSON |
| `AUTH_KEYPAIR_PATH` | ✅ | Path to your Jito Block Engine auth keypair JSON |
| `RPC_URL` | ✅ | Jito-compatible RPC URL (must support `simulateBundle`) |
| `BLOCK_ENGINE_URLS` | ✅ | Comma-separated Jito Block Engine URLs |
| `GEYSER_URL` | ✅ | Geyser gRPC endpoint URL |
| `GEYSER_ACCESS_TOKEN` | ✅ | Geyser access token |
| `TIP_PERCENT` | | Percentage of profit to tip Jito validators (default: 25) |
| `SIMULATION_MODE` | | Set to `true` to run without broadcasting bundles |

## Directory Structure

```
src/
├── index.ts                 # Modernized entry point (Jupiter v6 + FlashBrain)
├── flash_brain.ts           # Flash loan arb engine (Jupiter v6 quotes + Solend)
├── bot.ts                   # Legacy entry point (original pipeline)
├── build-bundle.ts          # Legacy bundle construction
├── calculate-arb.ts         # Legacy arb route calculation
├── config.ts                # Configuration (convict + dotenv)
├── constants.ts             # Solend addresses, base mints, fee constants
├── logger.ts                # Pino logger
├── lookup-table-provider.ts # Address lookup table caching
├── mempool.ts               # Jito mempool subscription
├── simulation.ts            # simulateBundle RPC wrapper
├── pre-simulation-filter.ts # Pre-sim transaction filtering
├── post-simulation-filter.ts# Post-sim trade detection
├── send-bundle.ts           # Legacy bundle sender
├── types.ts                 # Shared type definitions
├── utils.ts                 # Async generators, priority queues
├── worker-pool.ts           # Worker thread pool
├── clients/
│   ├── jito.ts              # Jito SearcherClient + GeyserClient
│   └── rpc.ts               # Rate-limited RPC connection
└── markets/
    ├── index.ts             # Market initialization + route calculation
    ├── types.ts             # DEX types, Market, Quote, SwapLeg
    ├── utils.ts             # Serialization helpers
    ├── market-graph.ts      # Mint-pair graph
    ├── amm-calc-worker.ts   # Worker thread AMM calculator
    ├── orca/                # Orca AMM pools
    ├── orca-whirlpool/      # Orca Whirlpool pools
    ├── raydium/             # Raydium AMM pools
    └── raydium-clmm/        # Raydium CLMM pools
analyze/                     # Jupyter notebook for trade analysis
```

## License

Apache-2.0 — See [LICENSE](LICENSE).
