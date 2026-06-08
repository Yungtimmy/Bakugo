import http from 'http';
import { setDefaultResultOrder } from 'dns';
import { Resolver } from 'dns/promises';

// Override DNS to use Google's resolvers — fixes ENOTFOUND on Fly.io
const resolver = new Resolver();
resolver.setServers(['8.8.8.8', '8.8.4.4']);
setDefaultResultOrder('ipv4first');
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

  // Start wallet monitor immediately — does not depend on Telegram
  await monitor.start();
  logger.info('Bakugo is running. Monitoring for incoming USDC...');

  // Start Telegram bot in background — retries on 409 without blocking monitor
  telegramBot.start().catch((e) => {
    logger.error('Telegram bot failed to start after all retries:', e);
  });

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
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
