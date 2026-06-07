import http from 'http';
import { config } from './config';
import { logger } from './utils/logger';
import { TelegramBot } from './bot/telegram';
import { WalletMonitor } from './services/walletMonitor';

function startHealthServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
  });
  server.listen(3000, () => logger.info('Health check server on port 3000'));
  return server;
}

async function main() {
  logger.info('Starting Bakugo — USDC → SOL swap+burn bot');
  logger.info(`RPC: ${config.rpcUrl}`);
  logger.info(`Wallets configured: ${config.walletPrivateKeys.length}`);

  startHealthServer();

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
