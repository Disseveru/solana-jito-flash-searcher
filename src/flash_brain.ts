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

/** Tip percentage of net profit sent to Jito validators */
const TIP_PERCENT = 25;

/** Minimum tip in lamports (floor) */
const MIN_TIP_LAMPORTS = 10_000;

/** Transaction base fees (3 signatures × 5,000 lamports) */
const TXN_FEES_LAMPORTS = 15_000;

export interface FlashArbResult {
  transaction: VersionedTransaction;
  borrowAmount: bigint;
  flashLoanFeeLamports: bigint;
  expectedProfitLamports: bigint;
  tipLamports: bigint;
  quote: QuoteResponse;
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
 * FlashBrain uses the Jupiter v6 API to find backrun arbitrage
 * opportunities and build VersionedTransactions that atomically
 * execute: [Flash Borrow → Arb Swap → Flash Repay → Jito Tip].
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
   */
  private async fetchSwapInstructions(
    quote: QuoteResponse,
  ): Promise<SwapInstructionsResponse | null> {
    try {
      return await this.jupiterApi.swapInstructionsPost({
        swapRequest: {
          quoteResponse: quote,
          userPublicKey: this.payer.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
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
   * Calculates whether a flash-loan arbitrage is profitable by
   * comparing the borrow→swap→repay profit against fees + tip.
   *
   * Returns the flash loan fee in lamports for the given `borrowAmount`.
   */
  calculateFlashLoanFee(borrowAmount: bigint): bigint {
    return (borrowAmount * BigInt(SOLEND_FLASHLOAN_FEE_BPS)) / 10_000n;
  }

  /**
   * Builds an atomic VersionedTransaction that performs:
   *   1. MEV-protection marker (jitodontfront read-only prefix)
   *   2. Flash Borrow from Solend
   *   3. Arb swap via Jupiter v6 instructions
   *   4. Flash Repay to Solend
   *   5. Dynamic Jito tip (25% of net profit)
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
    // ── 1. Get Jupiter quote (round-trip: inputMint → outputMint → inputMint)
    const quote = await this.fetchQuote(
      inputMint,
      outputMint,
      borrowAmount,
      50,
    );
    if (!quote) return null;

    const outAmount = BigInt(quote.outAmount);
    if (outAmount <= borrowAmount) {
      logger.debug(
        'FlashBrain: quote outAmount <= borrowAmount, no arb opportunity',
      );
      return null;
    }

    // ── 2. Calculate profitability
    const flashLoanFee = this.calculateFlashLoanFee(borrowAmount);
    const grossProfit = outAmount - borrowAmount;
    const tipLamports = this.calculateTip(grossProfit);
    const netProfit = grossProfit - flashLoanFee - tipLamports;

    if (netProfit <= BigInt(TXN_FEES_LAMPORTS)) {
      logger.info(
        `FlashBrain: net profit (${netProfit}) too low after fees + tip`,
      );
      return null;
    }

    // ── 3. Fetch swap instructions from Jupiter
    const swapIxResponse = await this.fetchSwapInstructions(quote);
    if (!swapIxResponse) return null;

    // ── 4. Determine Solend flash loan accounts
    const isUSDC =
      inputMint === BASE_MINTS_OF_INTEREST.USDC.toBase58();
    const solendReserve = isUSDC
      ? SOLEND_TURBO_USDC_RESERVE
      : SOLEND_TURBO_SOL_RESERVE;
    const solendLiquidity = isUSDC
      ? SOLEND_TURBO_USDC_LIQUIDITY
      : SOLEND_TURBO_SOL_LIQUIDITY;
    const solendFeeReceiver = isUSDC
      ? SOLEND_TURBO_USDC_FEE_RECEIVER
      : SOLEND_TURBO_SOL_FEE_RECEIVER;

    // The destination token account for the borrowed liquidity
    // (Jupiter will handle wrapping/unwrapping SOL)
    const sourceTokenAccount = new PublicKey(
      isUSDC
        ? this.payer.publicKey.toBase58() // ATA resolved by Jupiter setup ixns
        : this.payer.publicKey.toBase58(),
    );

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

    // 5b. Flash Borrow
    const flashBorrowIx = flashBorrowReserveLiquidityInstruction(
      new BN(borrowAmount.toString()),
      solendLiquidity,
      sourceTokenAccount,
      solendReserve,
      SOLEND_TURBO_POOL,
      SOLEND_PRODUCTION_PROGRAM_ID,
    );
    instructions.push(flashBorrowIx);

    // 5c. Setup instructions from Jupiter (ATA creation, etc.)
    for (const ix of swapIxResponse.setupInstructions) {
      instructions.push(jupInstructionToTransactionInstruction(ix));
    }

    // 5d. Compute budget instructions from Jupiter
    for (const ix of swapIxResponse.computeBudgetInstructions) {
      instructions.push(jupInstructionToTransactionInstruction(ix));
    }

    // 5e. The main swap instruction
    instructions.push(
      jupInstructionToTransactionInstruction(swapIxResponse.swapInstruction),
    );

    // 5f. Cleanup instruction (if any)
    if (swapIxResponse.cleanupInstruction) {
      instructions.push(
        jupInstructionToTransactionInstruction(
          swapIxResponse.cleanupInstruction,
        ),
      );
    }

    // 5g. Flash Repay (borrowInstructionIndex = 1 since borrow is at index 1)
    const flashRepayIx = flashRepayReserveLiquidityInstruction(
      new BN(borrowAmount.toString()),
      1, // index of the borrow instruction in this transaction
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

    // 5h. Jito tip — 25% of net profit
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.payer.publicKey,
      toPubkey: this.getRandomTipAccount(),
      lamports: tipLamports,
    });
    instructions.push(tipIx);

    // ── 6. Resolve address lookup tables from Jupiter ──
    const lookupTableAccounts: AddressLookupTableAccount[] = [];
    if (
      swapIxResponse.addressLookupTableAddresses &&
      swapIxResponse.addressLookupTableAddresses.length > 0
    ) {
      const lookupTableResults = await Promise.all(
        swapIxResponse.addressLookupTableAddresses.map((addr) =>
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
    const message = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash,
      instructions,
    }).compileToV0Message(lookupTableAccounts);

    const transaction = new VersionedTransaction(message);

    try {
      const serialized = transaction.serialize();
      if (serialized.length > 1232) {
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
      expectedProfitLamports: netProfit,
      tipLamports,
      quote,
    };
  }

  /**
   * Calculates the dynamic Jito tip: 25% of gross profit,
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
