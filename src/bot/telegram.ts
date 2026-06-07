import { Telegraf, Context } from 'telegraf';
import { config } from '../config';
import { logger } from '../utils/logger';

export class TelegramBot {
  private bot: Telegraf;
  private startTime = Date.now();
  private swapCount = 0;
  private totalUsdcSwapped = BigInt(0);

  constructor() {
    this.bot = new Telegraf(config.telegramBotToken);
    this.registerCommands();
  }

  private registerCommands(): void {
    this.bot.start((ctx) => {
      ctx.reply(
        '🤖 *Bakugo Bot is running*\n\n' +
        'Automatically swaps incoming USDC → SOL and burns the token account.\n\n' +
        'Commands:\n' +
        '/status — show bot status\n' +
        '/wallets — list monitored wallets\n' +
        '/help — show this message',
        { parse_mode: 'Markdown' },
      );
    });

    this.bot.command('help', (ctx) => ctx.reply(
      '/status — bot uptime & swap stats\n/wallets — monitored wallets\n/help — this message',
    ));

    this.bot.command('status', (ctx) => {
      const uptimeSec = Math.floor((Date.now() - this.startTime) / 1000);
      const h = Math.floor(uptimeSec / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      const s = uptimeSec % 60;
      const totalUsdc = (Number(this.totalUsdcSwapped) / 1_000_000).toFixed(6);

      ctx.reply(
        `*Bakugo Bot Status*\n\n` +
        `Uptime: ${h}h ${m}m ${s}s\n` +
        `Swaps completed: ${this.swapCount}\n` +
        `Total USDC swapped: ${totalUsdc} USDC`,
        { parse_mode: 'Markdown' },
      );
    });

    this.bot.command('wallets', (ctx) => {
      if (config.walletPrivateKeys.length === 0) {
        return ctx.reply('No wallets configured.');
      }

      // We only show public keys, never private keys
      const { Keypair } = require('@solana/web3.js');
      const bs58 = require('bs58');

      const lines = config.walletPrivateKeys.map((k, i) => {
        const pub = Keypair.fromSecretKey(bs58.default.decode(k)).publicKey.toBase58();
        return `${i + 1}. \`${pub}\``;
      });

      ctx.reply(`*Monitored Wallets:*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
    });

    this.bot.catch((err: unknown, ctx: Context) => {
      logger.error('Telegram bot error:', err);
    });
  }

  async notifySwapBurn(params: {
    walletAddress: string;
    usdcFormatted: string;
    swapTx: string;
    burnTx: string | null;
  }): Promise<void> {
    this.swapCount++;
    const usdcValue = parseFloat(params.usdcFormatted);
    this.totalUsdcSwapped += BigInt(Math.round(usdcValue * 1_000_000));

    const walletShort = `${params.walletAddress.slice(0, 4)}...${params.walletAddress.slice(-4)}`;
    const swapLink = `https://solscan.io/tx/${params.swapTx}`;
    const burnLine = params.burnTx
      ? `🔥 [Burn tx](https://solscan.io/tx/${params.burnTx})`
      : '🔥 Burn: account already closed';

    const message =
      `✅ *Swap + Burn Complete*\n\n` +
      `Wallet: \`${walletShort}\`\n` +
      `Amount: ${params.usdcFormatted} USDC\n\n` +
      `💱 [Swap tx](${swapLink})\n` +
      `${burnLine}`;

    try {
      await this.bot.telegram.sendMessage(config.telegramChatId, message, {
        parse_mode: 'Markdown',
        // @ts-ignore — link_preview_options not in all type versions
        disable_web_page_preview: true,
      });
    } catch (e) {
      logger.error('Failed to send Telegram notification:', e);
    }
  }

  async notifyError(walletAddress: string, error: string): Promise<void> {
    const walletShort = `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;
    try {
      await this.bot.telegram.sendMessage(
        config.telegramChatId,
        `⚠️ *Swap/Burn Error*\n\nWallet: \`${walletShort}\`\nError: ${error}`,
        { parse_mode: 'Markdown' },
      );
    } catch (e) {
      logger.error('Failed to send error notification:', e);
    }
  }

  async start(): Promise<void> {
    await this.bot.launch();
    logger.info('Telegram bot launched');
  }

  async stop(): Promise<void> {
    this.bot.stop('SIGTERM');
  }
}
