/**
 * Modernized searcher entry-point (2026).
 *
 * Pipeline:
 *   mempool → pre-filter → simulate → post-filter → FlashBrain arb → send bundle
 *
 * Key changes from the legacy bot.ts:
 *   • Uses FlashBrain (Jupiter v6) instead of the old price/routing logic.
 *   • Every transaction carries a jitodontfront read-only prefix for MEV protection.
 *   • Dynamic Jito tip: TIP_PERCENT% of gross profit (in SOL), floored at MIN_TIP_LAMPORTS.
 *   • Bundles are guarded by simulateBundle — if any txn errors or
 *     grossProfit < flashLoanFee + tip + txnFees the bundle is silently dropped.
 */

import * as fs from 'fs';
import {
  Keypair,
  VersionedTransaction,
  RpcResponseAndContext,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { stringify } from 'csv-stringify';
import { Bundle as JitoBundle } from 'jito-ts/dist/sdk/block-engine/types.js';
import {
  SimulatedBundleResponse,
  SimulatedBundleTransactionResult,
} from 'jito-ts/dist/sdk/rpc/connection.js';

import { config } from './config.js';
import { logger } from './logger.js';
import { connection } from './clients/rpc.js';
import { searcherClient } from './clients/jito.js';
import { FlashBrain } from './flash_brain.js';
import { mempool } from './mempool.js';
import { preSimulationFilter } from './pre-simulation-filter.js';
import { simulate } from './simulation.js';
import { postSimulateFilter, BackrunnableTrade } from './post-simulation-filter.js';
import { Timings } from './types.js';
import {
  formatLamportsAsSol,
  isBotRunning,
  isSimulationModeEnabled,
  pushDashboardLog,
  recordRealizedProfit,
} from './dashboard-state.js';
import { startDashboardServer } from './server.js';

// ── Configuration ──────────────────────────────────────────────
const PAYER_KEYPAIR_PATH = config.get('payer_keypair_path');

const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(fs.readFileSync(PAYER_KEYPAIR_PATH, 'utf-8')),
  ),
);

/** Transaction base fees (≤3 sigs × 5 000 lamports) */
const TXN_FEES_LAMPORTS = 15_000;

// ── FlashBrain instance ────────────────────────────────────────
const flashBrain = new FlashBrain(connection, payer);

// ── CSV trade log ──────────────────────────────────────────────
const tradesCsv = fs.createWriteStream('trades.csv', { flags: 'a' });
const stringifier = stringify({ header: true });
stringifier.pipe(tradesCsv);

// ── Bundle tracking ────────────────────────────────────────────
const CHECK_LANDED_DELAY_MS = 30_000;

type TradeRecord = {
  bundleId: string;
  accepted: number;
  rejected: boolean;
  errorType: string | null;
  errorContent: string | null;
  landed: boolean;
  borrowAmount: string;
  expectedProfit: string;
  tipLamports: string;
  inputMint: string;
  outputMint: string;
  txnSignature: string;
  timings: Timings;
};

const bundlesInTransit = new Map<string, TradeRecord>();
let dashboardPauseNoticeShown = false;

/**
 * After CHECK_LANDED_DELAY_MS, check if our arb transaction actually landed.
 */
async function processCompletedTrade(uuid: string) {
  const trade = bundlesInTransit.get(uuid);
  if (!trade) return;

  const landed = await connection
    .getTransaction(trade.txnSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 10,
    })
    .then((tx) => tx !== null)
    .catch(() => false);

  trade.landed = landed;

  if (trade.landed) {
    const realizedProfit = BigInt(trade.expectedProfit);
    recordRealizedProfit(realizedProfit);
    pushDashboardLog(`Trade landed: +${formatLamportsAsSol(realizedProfit)} SOL.`);
  } else {
    pushDashboardLog(`Trade ${uuid} did not land.`);
  }

  stringifier.write({
    timestamp: Date.now(),
    uuid,
    landed: trade.landed,
    accepted: trade.accepted,
    rejected: trade.rejected,
    errorType: trade.errorType,
    errorContent: trade.errorContent,
    txnSignature: trade.txnSignature,
    borrowAmount: trade.borrowAmount,
    expectedProfit: trade.expectedProfit,
    tipLamports: trade.tipLamports,
    inputMint: trade.inputMint,
    outputMint: trade.outputMint,
    mempoolEnd: trade.timings.mempoolEnd,
    preSimEnd: trade.timings.preSimEnd,
    simEnd: trade.timings.simEnd,
    postSimEnd: trade.timings.postSimEnd,
    calcArbEnd: trade.timings.calcArbEnd,
    buildBundleEnd: trade.timings.buildBundleEnd,
    bundleSent: trade.timings.bundleSent,
  });

  bundlesInTransit.delete(uuid);
}

// ── Safety: simulateBundle gate ────────────────────────────────
/**
 * Simulates a Jito bundle and returns true only when ALL
 * transactions succeed and the gross profit exceeds the cost floor
 * (flashLoanFee + tip + base transaction fees).
 */
async function isBundleSafe(
  bundle: VersionedTransaction[],
  grossProfitLamports: bigint,
  flashLoanFeeLamports: bigint,
  tipLamports: bigint,
): Promise<boolean> {
  try {
    const simResult: RpcResponseAndContext<SimulatedBundleResponse> =
      await connection.simulateBundle(bundle, {
        preExecutionAccountsConfigs: bundle.map(() => null),
        postExecutionAccountsConfigs: bundle.map(() => null),
        simulationBank: 'tip',
        replaceRecentBlockhash: true,
      });

    const txResults: SimulatedBundleTransactionResult[] =
      simResult.value.transactionResults;

    for (const txResult of txResults) {
      if (txResult.err) {
        logger.info(
          { err: txResult.err },
          'simulateBundle: txn error, dropping bundle',
        );
        pushDashboardLog('simulateBundle rejected: transaction error.');
        return false;
      }
    }

    // Enforce the cost floor: gross profit must cover all costs
    const costFloor = flashLoanFeeLamports + tipLamports + BigInt(TXN_FEES_LAMPORTS);

    if (grossProfitLamports < costFloor) {
      logger.info(
        `simulateBundle: gross profit (${grossProfitLamports}) below cost floor (${costFloor}), dropping`,
      );
      pushDashboardLog('simulateBundle rejected: profit below cost floor.');
      return false;
    }

    logger.debug(
      `simulateBundle passed – gross profit ${grossProfitLamports}, cost floor ${costFloor} lamports`,
    );
    return true;
  } catch (e) {
    logger.error(e, 'simulateBundle failed');
    pushDashboardLog('simulateBundle failed unexpectedly.');
    return false;
  }
}

// ── Main loop ──────────────────────────────────────────────────

/**
 * Subscribes to the Jito mempool, filters and simulates trades,
 * then uses FlashBrain to build profitable flash-loan arb bundles.
 */
async function run(): Promise<void> {
  const startupMode = isSimulationModeEnabled() ? 'SIMULATION' : 'PRODUCTION';
  logger.info(
    `Starting Flash Searcher (2026) — mode: ${startupMode}`,
  );
  pushDashboardLog(`Searcher started in ${startupMode} mode.`);

  // Wire bundle-result listener
  searcherClient.onBundleResult(
    (bundleResult) => {
      const bundleId = bundleResult.bundleId;
      const isAccepted = bundleResult.accepted;
      const isRejected = bundleResult.rejected;

      if (isAccepted) {
        logger.info(
          `Bundle ${bundleId} accepted in slot ${bundleResult.accepted.slot}`,
        );
        pushDashboardLog(`Bundle ${bundleId} accepted in slot ${bundleResult.accepted.slot}.`);
        const trade = bundlesInTransit.get(bundleId);
        if (trade) trade.accepted += 1;
      }

      if (isRejected) {
        logger.info(bundleResult.rejected, `Bundle ${bundleId} rejected:`);
        pushDashboardLog(`Bundle ${bundleId} rejected.`);
        const trade = bundlesInTransit.get(bundleId);
        if (trade) {
          trade.rejected = true;
          const rejectedEntry = Object.entries(bundleResult.rejected).find(
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            ([_, value]) => value !== undefined,
          );
          if (rejectedEntry) {
            const [errorType, errorContent] = rejectedEntry;
            trade.errorType = errorType;
            trade.errorContent = JSON.stringify(errorContent);
          }
        }
      }
    },
    (error) => {
      logger.error(error, 'bundle result stream error');
      pushDashboardLog('Bundle result stream error.');
    },
  );

  // Build the existing pipeline (mempool → preFilter → simulate → postFilter)
  const mempoolUpdates = mempool();
  const filteredTransactions = preSimulationFilter(mempoolUpdates);
  const simulations = simulate(filteredTransactions);
  const backrunnableTrades = postSimulateFilter(simulations);

  for await (const trade of backrunnableTrades) {
    if (!isBotRunning()) {
      if (!dashboardPauseNoticeShown) {
        dashboardPauseNoticeShown = true;
        logger.info('Bot paused from dashboard; incoming opportunities are ignored.');
        pushDashboardLog('Bot paused. Tap START BOT to resume processing.');
      }
      continue;
    }

    if (dashboardPauseNoticeShown) {
      dashboardPauseNoticeShown = false;
      logger.info('Bot resumed from dashboard controls.');
      pushDashboardLog('Bot resumed from dashboard controls.');
    }

    try {
      await handleTrade(trade);
    } catch (e) {
      logger.error(e, 'Error handling trade');
      pushDashboardLog('Error handling trade in pipeline.');
    }
  }
}

/**
 * For each backrunnable trade, use FlashBrain to find an arb,
 * guard it with simulateBundle, then send via Jito.
 */
async function handleTrade(trade: BackrunnableTrade): Promise<void> {
  const {
    txn: victimTxn,
    market,
    baseIsTokenA,
    tradeSizeA,
    tradeSizeB,
    timings,
  } = trade;

  // Determine what to borrow (the base mint: SOL or USDC)
  const inputMint = baseIsTokenA
    ? market.tokenMintA
    : market.tokenMintB;
  const outputMint = baseIsTokenA
    ? market.tokenMintB
    : market.tokenMintA;

  const tradeSizeBase = baseIsTokenA ? tradeSizeA : tradeSizeB;

  // Use the detected trade size as the flash-loan borrow amount
  const borrowAmount = BigInt(tradeSizeBase.toString());

  if (borrowAmount === 0n) return;

  const recentBlockhash = victimTxn.message.recentBlockhash;

  const arbResult = await flashBrain.buildFlashArbTransaction(
    inputMint,
    outputMint,
    borrowAmount,
    recentBlockhash,
  );

  if (!arbResult) return;

  const {
    transaction: arbTxn,
    flashLoanFeeLamports,
    grossProfitLamports,
    tipLamports,
  } = arbResult;

  // ── Safety check: simulateBundle ──
  const bundle = [victimTxn, arbTxn];

  const safe = await isBundleSafe(
    bundle,
    grossProfitLamports,
    flashLoanFeeLamports,
    tipLamports,
  );

  if (!safe) {
    logger.info('Bundle failed safety check, skipping');
    pushDashboardLog('Bundle failed safety check.');
    return;
  }

  // Final profitability gate: gross profit must cover all costs
  const totalCosts = flashLoanFeeLamports + tipLamports + BigInt(TXN_FEES_LAMPORTS);
  if (grossProfitLamports < totalCosts) {
    logger.info(
      `Gross profit (${grossProfitLamports}) < total costs (${totalCosts}), not broadcasting`,
    );
    pushDashboardLog('Trade skipped: gross profit below total cost.');
    return;
  }

  // ── Send bundle (or log in simulation mode) ──
  const now = Date.now();
  const arbTxnSignature = bs58.encode(arbTxn.signatures[0]);

  if (isSimulationModeEnabled()) {
    logger.info(
      `[SIMULATION] Would send bundle backrunning ${bs58.encode(victimTxn.signatures[0])}` +
        ` | borrow ${borrowAmount} | gross profit ${grossProfitLamports} lamports` +
        ` | tip ${tipLamports} lamports | input ${inputMint} → ${outputMint}`,
    );
    logger.info('✅ Simulation successful — bundle validated but NOT broadcast (SIMULATION_MODE=true)');
    pushDashboardLog(
      `Dry Run: validated trade at +${formatLamportsAsSol(grossProfitLamports)} SOL (not broadcast).`,
    );
    return;
  }

  const jitoBundle = new JitoBundle(bundle, 5);

  const sendResult = await searcherClient
    .sendBundle(jitoBundle)
    .catch((error) => {
      if (
        error?.message?.includes(
          'Bundle Dropped, no connected leader up soon',
        )
      ) {
        logger.error(
          'Error sending bundle: Bundle Dropped, no connected leader up soon.',
        );
        pushDashboardLog('Bundle dropped: no connected Jito leader soon.');
      } else {
        logger.error(error, 'Error sending bundle');
        pushDashboardLog('Error sending bundle to Jito.');
      }
      return null;
    });

  if (!sendResult) return;

  // jito-ts v4 returns Result<string, SearcherClientError>
  const bundleId =
    typeof sendResult === 'string'
      ? sendResult
      : (sendResult as { ok?: string }).ok ?? '';

  if (!bundleId) {
    logger.error('Failed to extract bundleId from sendBundle result');
    pushDashboardLog('Failed to parse bundle id after sendBundle.');
    return;
  }

  logger.info(
    `Bundle ${bundleId} sent, backrunning ${bs58.encode(victimTxn.signatures[0])}` +
      ` | gross profit ${grossProfitLamports} lamports | tip ${tipLamports} lamports`,
  );
  pushDashboardLog(
    `Live mode: bundle ${bundleId} sent (+${formatLamportsAsSol(grossProfitLamports)} SOL estimated).`,
  );

  const tradeTimings: Timings = {
    mempoolEnd: timings.mempoolEnd,
    preSimEnd: timings.preSimEnd,
    simEnd: timings.simEnd,
    postSimEnd: timings.postSimEnd,
    calcArbEnd: timings.calcArbEnd,
    buildBundleEnd: Date.now(),
    bundleSent: now,
  };

  bundlesInTransit.set(bundleId, {
    bundleId,
    accepted: 0,
    rejected: false,
    errorType: null,
    errorContent: null,
    landed: false,
    borrowAmount: borrowAmount.toString(),
    expectedProfit: grossProfitLamports.toString(),
    tipLamports: tipLamports.toString(),
    inputMint,
    outputMint,
    txnSignature: arbTxnSignature,
    timings: tradeTimings,
  });

  setTimeout(() => {
    processCompletedTrade(bundleId);
  }, CHECK_LANDED_DELAY_MS);
}

// ── Boot ───────────────────────────────────────────────────────
async function boot(): Promise<void> {
  await startDashboardServer();
  await run();
}

void boot().catch((error) => {
  logger.error(error, 'Fatal error in searcher runtime');
  pushDashboardLog('Fatal runtime error. Searcher shutting down.');
  process.exit(1);
});
