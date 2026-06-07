import {
  Connection,
  Keypair,
  PublicKey,
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

export async function swapUsdcToSol(
  connection: Connection,
  wallet: Keypair,
  usdcAmount: bigint,
): Promise<string> {
  logger.info(`[${wallet.publicKey.toBase58().slice(0, 8)}] Swapping ${usdcAmount} USDC lamports → SOL`);

  // 1. Get quote
  const quoteRes = await axios.get<QuoteResponse>(`${config.jupiterApiUrl}/quote`, {
    params: {
      inputMint: config.usdcMint,
      outputMint: SOL_MINT,
      amount: usdcAmount.toString(),
      slippageBps: config.slippageBps,
      onlyDirectRoutes: false,
    },
  });

  const quote = quoteRes.data;
  const outSol = Number(quote.outAmount) / 1e9;
  logger.info(`Quote: ${usdcAmount} USDC → ~${outSol.toFixed(6)} SOL (impact: ${quote.priceImpactPct}%)`);

  // 2. Get swap transaction
  const swapRes = await axios.post(`${config.jupiterApiUrl}/swap`, {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto',
  });

  const { swapTransaction } = swapRes.data as { swapTransaction: string };

  // 3. Deserialize, sign, send
  const txBuf = Buffer.from(swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  logger.info(`Swap tx sent: ${sig}`);

  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction(
    { signature: sig, ...latestBlockhash },
    'confirmed',
  );

  logger.info(`Swap confirmed: ${sig}`);
  return sig;
}
