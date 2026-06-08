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
const JUPITER_HOST = 'lite-api.jup.ag';

// Resolve Jupiter IP via Google DNS to bypass Fly.io's broken resolver
const dnsResolver = new Resolver();
dnsResolver.setServers(['8.8.8.8', '1.1.1.1']);

let jupiterIp: string | null = null;

async function getJupiterIp(): Promise<string> {
  if (jupiterIp) return jupiterIp;
  return new Promise((resolve) => {
    dnsResolver.resolve4(JUPITER_HOST, (err, addresses) => {
      if (!err && addresses?.length) {
        jupiterIp = addresses[0];
        logger.info(`Jupiter resolved: ${JUPITER_HOST} → ${jupiterIp}`);
        resolve(jupiterIp);
      } else {
        logger.warn(`Jupiter DNS failed, using hostname`);
        resolve(JUPITER_HOST);
      }
    });
  });
}

// Connect to resolved IP but send correct SNI/Host so TLS cert matches
async function makeJupiterRequest<T>(method: 'get' | 'post', path: string, data?: unknown, params?: unknown): Promise<T> {
  const ip = await getJupiterIp();
  const url = `https://${ip}/v6${path}`;
  const agent = new https.Agent({ servername: JUPITER_HOST });
  const headers = { Host: JUPITER_HOST };

  const res = method === 'get'
    ? await axios.get<T>(url, { params, headers, httpsAgent: agent, timeout: 15000 })
    : await axios.post<T>(url, data, { headers, httpsAgent: agent, timeout: 15000 });

  return res.data;
}

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
      const retriable = ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ENODATA'].includes(e?.code);
      if (retriable && attempt < retries) {
        jupiterIp = null; // force re-resolve on next attempt
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
    () => makeJupiterRequest<QuoteResponse>('get', '/quote', undefined, {
      inputMint: config.usdcMint,
      outputMint: SOL_MINT,
      amount: usdcAmount.toString(),
      slippageBps: config.slippageBps,
      onlyDirectRoutes: false,
    }),
    `${tag} Jupiter quote`,
  );

  const outSol = Number(quote.outAmount) / 1e9;
  logger.info(`${tag} Quote: ${usdcAmount} USDC → ~${outSol.toFixed(6)} SOL (impact: ${quote.priceImpactPct}%)`);

  // 2. Get swap transaction
  const swapData = await withRetry(
    () => makeJupiterRequest<{ swapTransaction: string }>('post', '/swap', {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
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
