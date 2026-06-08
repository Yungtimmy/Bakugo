import {
  Connection,
  Keypair,
  VersionedTransaction,
} from '@solana/web3.js';
import axios from 'axios';
import https from 'https';
import { Resolver } from 'dns';
import { config } from '../config';
import { logger } from '../utils/logger';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Custom DNS resolver using Google's servers — bypasses Fly.io's broken resolver
const dnsResolver = new Resolver();
dnsResolver.setServers(['8.8.8.8', '8.8.4.4']);

const httpsAgent = new https.Agent({
  lookup: (hostname, _opts, callback) => {
    dnsResolver.resolve4(hostname, (err4, v4) => {
      if (!err4 && v4?.length) {
        logger.debug(`DNS ${hostname} → ${v4[0]} (IPv4)`);
        return callback(null, v4[0], 4);
      }
      dnsResolver.resolve6(hostname, (err6, v6) => {
        if (!err6 && v6?.length) {
          logger.debug(`DNS ${hostname} → ${v6[0]} (IPv6)`);
          return callback(null, v6[0], 6);
        }
        // Both failed — let system resolver try
        logger.warn(`Custom DNS failed for ${hostname}, falling back to system resolver`);
        callback(null, hostname, 4);
      });
    });
  },
});

const jupiterAxios = axios.create({ httpsAgent, timeout: 15000 });

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
    () => jupiterAxios.get<QuoteResponse>(`${config.jupiterApiUrl}/quote`, {
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
    () => jupiterAxios.post(`${config.jupiterApiUrl}/swap`, {
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
