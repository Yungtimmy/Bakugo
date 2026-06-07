import {
  Connection,
  Keypair,
  PublicKey,
  TokenAmount,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  TokenAccountNotFoundError,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from '../config';
import { logger } from '../utils/logger';
import { swapUsdcToSol } from './swapService';
import { burnUsdcTokenAccount } from './burnService';

export type SwapBurnCallback = (params: {
  walletAddress: string;
  usdcAmount: bigint;
  usdcFormatted: string;
  swapTx: string;
  burnTx: string | null;
}) => void;

interface WalletState {
  wallet: Keypair;
  connection: Connection;
  lastKnownBalance: bigint;
  processing: boolean;
  subscriptionId: number | null;
}

export class WalletMonitor {
  private wallets: WalletState[] = [];
  private onSwapBurn: SwapBurnCallback;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(onSwapBurn: SwapBurnCallback) {
    this.onSwapBurn = onSwapBurn;
  }

  async start(): Promise<void> {
    if (config.walletPrivateKeys.length === 0) {
      throw new Error('No wallet private keys configured. Add WALLET_PRIVATE_KEY_1 etc. to .env');
    }

    for (const key of config.walletPrivateKeys) {
      const secretKey = bs58.decode(key);
      const wallet = Keypair.fromSecretKey(secretKey);
      const connection = new Connection(config.rpcUrl, 'confirmed');

      this.wallets.push({
        wallet,
        connection,
        lastKnownBalance: BigInt(0),
        processing: false,
        subscriptionId: null,
      });

      logger.info(`Monitoring wallet: ${wallet.publicKey.toBase58()}`);
    }

    // Try websocket first, fall back to polling
    await this.startWebsocketSubscriptions();

    // Polling fallback runs alongside websocket — catches missed events
    this.pollTimer = setInterval(() => this.pollAll(), config.pollIntervalMs);
    logger.info(`Polling active every ${config.pollIntervalMs}ms as fallback`);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);

    for (const state of this.wallets) {
      if (state.subscriptionId !== null) {
        try {
          await state.connection.removeAccountChangeListener(state.subscriptionId);
        } catch {
          // ignore
        }
      }
    }
  }

  private async startWebsocketSubscriptions(): Promise<void> {
    for (const state of this.wallets) {
      const usdcMint = new PublicKey(config.usdcMint);
      let ata: PublicKey;

      try {
        ata = await getAssociatedTokenAddress(usdcMint, state.wallet.publicKey);
      } catch (e) {
        logger.warn(`Could not derive ATA for ${state.wallet.publicKey.toBase58().slice(0, 8)}, will rely on polling`);
        continue;
      }

      try {
        const subId = state.connection.onAccountChange(
          ata,
          async (accountInfo) => {
            if (state.processing) return;

            // Decode token account balance from account data
            // Token account layout: 64 bytes header, amount at offset 64 (u64 LE)
            if (accountInfo.data.length >= 72) {
              const amount = accountInfo.data.readBigUInt64LE(64);
              if (amount > BigInt(config.minUsdcThreshold) && amount !== state.lastKnownBalance) {
                state.lastKnownBalance = amount;
                await this.handleIncomingUsdc(state, amount);
              }
            }
          },
          'confirmed',
        );
        state.subscriptionId = subId;
        logger.info(`Websocket subscribed for ${state.wallet.publicKey.toBase58().slice(0, 8)} ATA`);
      } catch (e) {
        logger.warn(`Websocket subscription failed for ${state.wallet.publicKey.toBase58().slice(0, 8)}, relying on polling`);
      }
    }
  }

  private async pollAll(): Promise<void> {
    await Promise.allSettled(this.wallets.map((s) => this.pollWallet(s)));
  }

  private async pollWallet(state: WalletState): Promise<void> {
    if (state.processing) return;

    try {
      const usdcMint = new PublicKey(config.usdcMint);
      const ata = await getAssociatedTokenAddress(usdcMint, state.wallet.publicKey);
      const account = await getAccount(state.connection, ata, 'confirmed');
      const amount = account.amount;

      if (amount > BigInt(config.minUsdcThreshold) && amount !== state.lastKnownBalance) {
        state.lastKnownBalance = amount;
        await this.handleIncomingUsdc(state, amount);
      }
    } catch (e) {
      if (e instanceof TokenAccountNotFoundError) {
        // Wallet has no USDC token account yet — normal
        return;
      }
      logger.error(`Poll error for ${state.wallet.publicKey.toBase58().slice(0, 8)}:`, e);
    }
  }

  private async handleIncomingUsdc(state: WalletState, amount: bigint): Promise<void> {
    state.processing = true;
    const walletShort = state.wallet.publicKey.toBase58().slice(0, 8);
    const usdcFormatted = (Number(amount) / 1_000_000).toFixed(6);

    logger.info(`[${walletShort}] Detected ${usdcFormatted} USDC — starting swap+burn`);

    try {
      const swapTx = await swapUsdcToSol(state.connection, state.wallet, amount);

      // Small delay to ensure token account balance is settled at 0
      await sleep(2000);

      const burnTx = await burnUsdcTokenAccount(state.connection, state.wallet);

      // Reset so next incoming USDC is detected
      state.lastKnownBalance = BigInt(0);

      this.onSwapBurn({
        walletAddress: state.wallet.publicKey.toBase58(),
        usdcAmount: amount,
        usdcFormatted,
        swapTx,
        burnTx,
      });
    } catch (e) {
      logger.error(`[${walletShort}] Swap+burn failed:`, e);
      state.lastKnownBalance = BigInt(0); // reset so it retries on next poll
    } finally {
      state.processing = false;
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
