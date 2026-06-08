import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

const jupiterAxios = axios.create({
  baseURL: config.jupiterApiUrl,
  timeout: 15000,
});

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
      const retriable = ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ENODATA'].includes(e?.code ?? '');
      if (retriable && attempt < retries) {
        const delay = attempt * 3000;
        logger.warn(`${label} failed (attempt ${attempt}/${retries}), retrying in ${delay / 1000}s... [${e.code ?? e.message}]`);
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

  // 1. Get quote
  const quote = await withRetry(
    async () => {
      const res = await jupiterAxios.get<QuoteResponse>('/quote', {
        params: {
          inputMint: config.usdcMint,
          outputMint: SOL_MINT,
          amount: usdcAmount.toString(),
          slippageBps: config.slippageBps,
          onlyDirectRoutes: false,
        },
      });
      return res.data;
    },
    `${tag} Jupiter quote`,
  );

  const outSol = Number(quote.outAmount) / 1e9;
  logger.info(`${tag} Quote: ${usdcAmount} USDC → ~${outSol.toFixed(6)} SOL (impact: ${quote.priceImpactPct}%)`);

  // 2. Get swap transaction
  const swapData = await withRetry(
    async () => {
      const res = await jupiterAxios.post<{ swapTransaction: string }>('/swap', {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      });
      return res.data;
    },
    `${tag} Jupiter swap`,
  );

  // 3. Deserialize, sign, send
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
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
