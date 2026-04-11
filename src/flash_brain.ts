import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createJupiterApiClient,
  QuoteResponse,
  SwapInstructionsResponse,
  Instruction as JupInstruction,
} from '@jup-ag/api';
import { BN } from 'bn.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT,
} from '@solana/spl-token';
import {
  SOLEND_PRODUCTION_PROGRAM_ID,
  flashBorrowReserveLiquidityInstruction,
  flashRepayReserveLiquidityInstruction,
} from '@solendprotocol/solend-sdk';
import {
  SOLEND_FLASHLOAN_FEE_BPS,
  SOLEND_TURBO_POOL,
  SOLEND_TURBO_SOL_FEE_RECEIVER,
  SOLEND_TURBO_SOL_LIQUIDITY,
  SOLEND_TURBO_SOL_RESERVE,
  SOLEND_TURBO_USDC_FEE_RECEIVER,
  SOLEND_TURBO_USDC_LIQUIDITY,
  SOLEND_TURBO_USDC_RESERVE,
  BASE_MINTS_OF_INTEREST,
} from './constants.js';
import { config } from './config.js';
import { logger } from './logger.js';

// 8 official Jito tip accounts
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
].map((pk) => new PublicKey(pk));

/**
 * "jitodontfront" read-only account used as the first key in every
 * transaction instruction for Jito MEV protection. This forces the
 * transaction to be processed by Jito validators, preventing
 * front-running by conventional validators.
 */
const JITO_MEV_PROTECTION_ACCOUNT = new PublicKey(
  'HWEoBxYs7ssKuudEjzjmpfJVX7Dvi7wescFsVx2L5yoY',
);

/** Tip percentage read from config (default 25, configurable via TIP_PERCENT env var) */
const TIP_PERCENT: number = config.get('tip_percent');

/** Minimum tip in lamports read from config (configurable via MIN_TIP_LAMPORTS env var) */
const MIN_TIP_LAMPORTS: number = config.get('min_tip_lamports');

/** Transaction base fees (3 signatures × 5,000 lamports) */
const TXN_FEES_LAMPORTS = 15_000;

export interface FlashArbResult {
  transaction: VersionedTransaction;
  borrowAmount: bigint;
  flashLoanFeeLamports: bigint;
  grossProfitLamports: bigint;
  tipLamports: bigint;
  forwardQuote: QuoteResponse;
  returnQuote: QuoteResponse;
}

/**
 * Converts a Jupiter API Instruction to a Solana TransactionInstruction.
 */
function jupInstructionToTransactionInstruction(
  ix: JupInstruction,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((acc) => ({
      pubkey: new PublicKey(acc.pubkey),
      isSigner: acc.isSigner,
      isWritable: acc.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

/**
 * Appends all Jupiter swap-related instructions (setup, compute budget,
 * swap, cleanup) from a SwapInstructionsResponse to the instruction array.
 */
function appendJupiterSwapInstructions(
  instructions: TransactionInstruction[],
  swapIx: SwapInstructionsResponse,
): void {
  for (const ix of swapIx.setupInstructions) {
    instructions.push(jupInstructionToTransactionInstruction(ix));
  }
  for (const ix of swapIx.computeBudgetInstructions) {
    instructions.push(jupInstructionToTransactionInstruction(ix));
  }
  instructions.push(
    jupInstructionToTransactionInstruction(swapIx.swapInstruction),
  );
  if (swapIx.cleanupInstruction) {
    instructions.push(
      jupInstructionToTransactionInstruction(swapIx.cleanupInstruction),
    );
  }
}

/**
 * FlashBrain uses the Jupiter v6 API to find backrun arbitrage
 * opportunities and build VersionedTransactions that atomically
 * execute: [Flash Borrow → Forward Swap → Return Swap → Flash Repay → Jito Tip].
 *
 * The round-trip (inputMint → outputMint → inputMint) ensures the
 * Solend flash loan is repaid in the same mint that was borrowed.
 *
 * No RPC polling is required—quote data comes directly from the
 * Jupiter aggregator's local AMM map.
 */
export class FlashBrain {
  private readonly jupiterApi;
  private readonly connection: Connection;
  private readonly payer: Keypair;

  constructor(connection: Connection, payer: Keypair, jupiterApiUrl?: string) {
    this.connection = connection;
    this.payer = payer;
    this.jupiterApi = createJupiterApiClient({
      basePath: jupiterApiUrl ?? 'https://quote-api.jup.ag/v6',
    });
  }

  /**
   * Picks one of the 8 Jito tip accounts at random.
   */
  private getRandomTipAccount(): PublicKey {
    return JITO_TIP_ACCOUNTS[
      Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)
    ];
  }

  /**
   * Fetches an optimised quote from Jupiter v6 for the given pair.
   * Uses `onlyDirectRoutes: false` to allow multi-hop routes and
   * `restrictIntermediateTokens: true` to keep intermediate mints
   * liquid and avoid exotic pairs.
   */
  async fetchQuote(
    inputMint: string,
    outputMint: string,
    amountLamports: bigint,
    slippageBps = 50,
  ): Promise<QuoteResponse | null> {
    try {
      const quote = await this.jupiterApi.quoteGet({
        inputMint,
        outputMint,
        amount: Number(amountLamports),
        slippageBps,
        onlyDirectRoutes: false,
        restrictIntermediateTokens: true,
      });
      return quote;
    } catch (e) {
      logger.error(e, 'FlashBrain: failed to fetch quote');
      return null;
    }
  }

  /**
   * Fetches the deserialized swap instructions from Jupiter v6.
   *
   * @param wrapAndUnwrapSol When false, Jupiter uses the standard wSOL ATA
   *   instead of creating a temporary account. Set to false when the
   *   wSOL ATA is managed externally (e.g. by a flash loan).
   */
  private async fetchSwapInstructions(
    quote: QuoteResponse,
    wrapAndUnwrapSol = true,
  ): Promise<SwapInstructionsResponse | null> {
    try {
      return await this.jupiterApi.swapInstructionsPost({
        swapRequest: {
          quoteResponse: quote,
          userPublicKey: this.payer.publicKey.toBase58(),
          wrapAndUnwrapSol,
          dynamicComputeUnitLimit: true,
          dynamicSlippage: true,
        },
      });
    } catch (e) {
      logger.error(e, 'FlashBrain: failed to fetch swap instructions');
      return null;
    }
  }

  /**
   * Returns the flash loan fee in lamports for the given `borrowAmount`.
   */
  calculateFlashLoanFee(borrowAmount: bigint): bigint {
    return (borrowAmount * BigInt(SOLEND_FLASHLOAN_FEE_BPS)) / 10_000n;
  }

  /**
   * Builds an atomic VersionedTransaction that performs a round-trip
   * flash-loan arbitrage:
   *
   *   1. MEV-protection marker (jitodontfront read-only prefix)
   *   2. Ensure inputMint ATA exists
   *   3. Flash Borrow from Solend (inputMint)
   *   4. Forward swap via Jupiter (inputMint → outputMint)
   *   5. Return swap via Jupiter (outputMint → inputMint)
   *   6. Flash Repay to Solend (inputMint + fee)
   *   7. Close wSOL ATA (if SOL, to recover rent)
   *   8. Dynamic Jito tip (TIP_PERCENT% of gross profit)
   *
   * @param inputMint  The mint to borrow and repay (SOL or USDC).
   * @param outputMint The intermediate mint the arb swaps through.
   * @param borrowAmount The exact amount in base units to flash-borrow.
   * @param recentBlockhash A recent blockhash for the transaction.
   * @returns The fully assembled FlashArbResult or null when unprofitable.
   */
  async buildFlashArbTransaction(
    inputMint: string,
    outputMint: string,
    borrowAmount: bigint,
    recentBlockhash: string,
  ): Promise<FlashArbResult | null> {
    // ── 1. Get Jupiter quotes for the round-trip ──
    // Forward leg: inputMint → outputMint (buy the cheap token)
    const forwardQuote = await this.fetchQuote(
      inputMint,
      outputMint,
      borrowAmount,
      50,
    );
    if (!forwardQuote) return null;

    // Return leg: outputMint → inputMint (sell back at fair price)
    const forwardOutAmount = BigInt(forwardQuote.outAmount);
    const returnQuote = await this.fetchQuote(
      outputMint,
      inputMint,
      forwardOutAmount,
      50,
    );
    if (!returnQuote) return null;

    const returnAmount = BigInt(returnQuote.outAmount);
    if (returnAmount <= borrowAmount) {
      logger.debug(
        'FlashBrain: round-trip returnAmount <= borrowAmount, no arb opportunity',
      );
      return null;
    }

    // ── 2. Calculate profitability ──
    const grossProfit = returnAmount - borrowAmount;
    const flashLoanFee = this.calculateFlashLoanFee(borrowAmount);
    const tipLamports = this.calculateTip(grossProfit);
    const netProfit = grossProfit - flashLoanFee - tipLamports;

    if (netProfit <= BigInt(TXN_FEES_LAMPORTS)) {
      logger.info(
        `FlashBrain: net profit (${netProfit}) too low after fees + tip`,
      );
      return null;
    }

    // ── 3. Fetch swap instructions for both legs ──
    // wrapAndUnwrapSol = false so Jupiter uses the standard ATA for wSOL,
    // matching the account Solend flash-borrows into / repays from.
    const forwardSwapIx = await this.fetchSwapInstructions(forwardQuote, false);
    if (!forwardSwapIx) return null;

    const returnSwapIx = await this.fetchSwapInstructions(returnQuote, false);
    if (!returnSwapIx) return null;

    // ── 4. Determine Solend flash loan accounts and token accounts ──
    const isSOL =
      inputMint === BASE_MINTS_OF_INTEREST.SOL.toBase58();
    const isUSDC =
      inputMint === BASE_MINTS_OF_INTEREST.USDC.toBase58();

    // Derive the correct SPL token account (ATA) for the borrowed mint.
    // Solend flash borrow/repay require an SPL token account, not a
    // system account. For SOL this is the wSOL ATA; for USDC the USDC ATA.
    const inputMintPubkey = isSOL
      ? NATIVE_MINT
      : new PublicKey(inputMint);
    const sourceTokenAccount = getAssociatedTokenAddressSync(
      inputMintPubkey,
      this.payer.publicKey,
    );

    const solendReserve = isUSDC
      ? SOLEND_TURBO_USDC_RESERVE
      : SOLEND_TURBO_SOL_RESERVE;
    const solendLiquidity = isUSDC
      ? SOLEND_TURBO_USDC_LIQUIDITY
      : SOLEND_TURBO_SOL_LIQUIDITY;
    const solendFeeReceiver = isUSDC
      ? SOLEND_TURBO_USDC_FEE_RECEIVER
      : SOLEND_TURBO_SOL_FEE_RECEIVER;

    // ── 5. Assemble instructions ──
    const instructions: TransactionInstruction[] = [];

    // 5a. MEV-protection marker: first instruction reads jitodontfront account
    instructions.push(
      new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [
          {
            pubkey: JITO_MEV_PROTECTION_ACCOUNT,
            isSigner: false,
            isWritable: false,
          },
        ],
        data: Buffer.alloc(0),
      }),
    );

    // 5b. Ensure the inputMint ATA exists (idempotent — no-op if it already does)
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        this.payer.publicKey,
        sourceTokenAccount,
        this.payer.publicKey,
        inputMintPubkey,
      ),
    );

    // 5c. Flash Borrow (tokens arrive in sourceTokenAccount).
    // The borrow instruction index is tracked dynamically because the
    // number of preceding instructions varies (MEV marker + ATA creation).
    // Solend's flash repay references this index to verify atomicity.
    const borrowInstructionIndex = instructions.length;
    const flashBorrowIx = flashBorrowReserveLiquidityInstruction(
      new BN(borrowAmount.toString()),
      solendLiquidity,
      sourceTokenAccount,
      solendReserve,
      SOLEND_TURBO_POOL,
      SOLEND_PRODUCTION_PROGRAM_ID,
    );
    instructions.push(flashBorrowIx);

    // 5d. Forward swap: inputMint → outputMint
    appendJupiterSwapInstructions(instructions, forwardSwapIx);

    // 5e. Return swap: outputMint → inputMint
    appendJupiterSwapInstructions(instructions, returnSwapIx);

    // 5f. Flash Repay (borrowInstructionIndex is tracked dynamically)
    const flashRepayIx = flashRepayReserveLiquidityInstruction(
      new BN(borrowAmount.toString()),
      borrowInstructionIndex,
      sourceTokenAccount,
      solendLiquidity,
      solendFeeReceiver,
      sourceTokenAccount, // hostFeeReceiver
      solendReserve,
      SOLEND_TURBO_POOL,
      this.payer.publicKey,
      SOLEND_PRODUCTION_PROGRAM_ID,
    );
    instructions.push(flashRepayIx);

    // 5g. Close wSOL ATA after repay to recover rent + convert remaining wSOL → native SOL
    if (isSOL) {
      instructions.push(
        createCloseAccountInstruction(
          sourceTokenAccount,
          this.payer.publicKey,
          this.payer.publicKey,
        ),
      );
    }

    // 5h. Jito tip — TIP_PERCENT% of gross profit
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.payer.publicKey,
      toPubkey: this.getRandomTipAccount(),
      lamports: tipLamports,
    });
    instructions.push(tipIx);

    // ── 6. Resolve address lookup tables from both swaps ──
    const allLookupAddresses = new Set<string>();
    for (const addr of forwardSwapIx.addressLookupTableAddresses ?? []) {
      allLookupAddresses.add(addr);
    }
    for (const addr of returnSwapIx.addressLookupTableAddresses ?? []) {
      allLookupAddresses.add(addr);
    }

    const lookupTableAccounts: AddressLookupTableAccount[] = [];
    if (allLookupAddresses.size > 0) {
      const lookupTableResults = await Promise.all(
        Array.from(allLookupAddresses).map((addr) =>
          this.connection.getAddressLookupTable(new PublicKey(addr)),
        ),
      );
      for (const result of lookupTableResults) {
        if (result.value) {
          lookupTableAccounts.push(result.value);
        }
      }
    }

    // ── 7. Build the VersionedTransaction ──
    // Solana's maximum serialized transaction size is 1232 bytes
    const SOLANA_MAX_TX_SIZE = 1232;
    const message = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash,
      instructions,
    }).compileToV0Message(lookupTableAccounts);

    const transaction = new VersionedTransaction(message);

    try {
      const serialized = transaction.serialize();
      if (serialized.length > SOLANA_MAX_TX_SIZE) {
        logger.error(
          `FlashBrain: transaction too large (${serialized.length} bytes)`,
        );
        return null;
      }
      transaction.sign([this.payer]);
    } catch (e) {
      logger.error(e, 'FlashBrain: failed to sign transaction');
      return null;
    }

    return {
      transaction,
      borrowAmount,
      flashLoanFeeLamports: flashLoanFee,
      grossProfitLamports: grossProfit,
      tipLamports,
      forwardQuote,
      returnQuote,
    };
  }

  /**
   * Calculates the dynamic Jito tip: TIP_PERCENT% of gross profit,
   * floored at MIN_TIP_LAMPORTS.
   */
  private calculateTip(grossProfit: bigint): bigint {
    const dynamicTip =
      (grossProfit * BigInt(TIP_PERCENT)) / 100n;
    return dynamicTip > BigInt(MIN_TIP_LAMPORTS)
      ? dynamicTip
      : BigInt(MIN_TIP_LAMPORTS);
  }
}
