import { config } from './config';
import { logger } from './utils/logger';
import { TelegramBot } from './bot/telegram';
import { WalletMonitor } from './services/walletMonitor';

async function main() {
  logger.info('Starting Bakugo — USDC → SOL swap+burn bot');
  logger.info(`RPC: ${config.rpcUrl}`);
  logger.info(`Wallets configured: ${config.walletPrivateKeys.length}`);

  const telegramBot = new TelegramBot();
  const monitor = new WalletMonitor((params) => {
    logger.info(`Swap+burn complete for ${params.walletAddress}: ${params.usdcFormatted} USDC`);
    telegramBot.notifySwapBurn(params);
  });

  await telegramBot.start();
  await monitor.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await monitor.stop();
    await telegramBot.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
  });

  logger.info('Bakugo is running. Monitoring for incoming USDC...');
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
