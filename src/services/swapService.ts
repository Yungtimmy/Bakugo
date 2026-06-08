import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  routePlan: unknown[];
  priceImpactPct: string;
}

async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 5): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const isNetworkErr = e?.code === 'ENOTFOUND' || e?.code === 'ECONNRESET' || e?.code === 'ETIMEDOUT';
      if (isNetworkErr && attempt < retries) {
        const delay = attempt * 3000;
        logger.warn(`${label} failed (attempt ${attempt}/${retries}), retrying in ${delay / 1000}s... [${e.code}]`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
  throw new Error(`${label} failed after ${retries} attempts`);
}

export async function swapUsdcToSol(
  connection: Connection,
  wallet: Keypair,
  usdcAmount: bigint,
): Promise<string> {
  const tag = `[${wallet.publicKey.toBase58().slice(0, 8)}]`;
  logger.info(`${tag} Swapping ${usdcAmount} USDC lamports → SOL`);

  // 1. Get quote with retry
  const quoteRes = await withRetry(
    () => axios.get<QuoteResponse>(`${config.jupiterApiUrl}/quote`, {
      params: {
        inputMint: config.usdcMint,
        outputMint: SOL_MINT,
        amount: usdcAmount.toString(),
        slippageBps: config.slippageBps,
        onlyDirectRoutes: false,
      },
      timeout: 15000,
    }),
    `${tag} Jupiter quote`,
  );

  const quote = quoteRes.data;
  const outSol = Number(quote.outAmount) / 1e9;
  logger.info(`${tag} Quote: ${usdcAmount} USDC → ~${outSol.toFixed(6)} SOL (impact: ${quote.priceImpactPct}%)`);

  // 2. Get swap transaction with retry
  const swapRes = await withRetry(
    () => axios.post(`${config.jupiterApiUrl}/swap`, {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }, { timeout: 15000 }),
    `${tag} Jupiter swap`,
  );

  const { swapTransaction } = swapRes.data as { swapTransaction: string };

  // 3. Deserialize, sign, send
  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  logger.info(`${tag} Swap tx sent: ${sig}`);

  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature: sig, ...latestBlockhash },
    'confirmed',
  );

  logger.info(`${tag} Swap confirmed: ${sig}`);
  return sig;
}
