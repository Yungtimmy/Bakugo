import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export const config = {
  // Up to 3 wallet private keys (base58 encoded)
  walletPrivateKeys: [
    process.env.WALLET_PRIVATE_KEY_1,
    process.env.WALLET_PRIVATE_KEY_2,
    process.env.WALLET_PRIVATE_KEY_3,
  ].filter((k): k is string => !!k),

  rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',

  // USDC mint on Solana mainnet
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',

  // Minimum USDC (in lamports / token units) to trigger swap — 0.01 USDC
  minUsdcThreshold: 10_000,

  // Jupiter unified API (lite-api.jup.ag avoids Fly.io DNS blocks on quote-api.jup.ag)
  jupiterApiUrl: 'https://lite-api.jup.ag/swap/v1',

  // Poll interval ms (websocket preferred, polling as fallback)
  pollIntervalMs: 5000,

  // Slippage in bps (0.5%)
  slippageBps: 50,
};
