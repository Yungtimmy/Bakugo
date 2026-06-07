import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Closes the USDC associated token account for the wallet.
 * This is the Sol Incinerator mechanic — reclaims the rent lamports back to
 * the wallet owner and permanently destroys the token account.
 *
 * Must be called AFTER the USDC balance has been fully swapped (balance = 0),
 * otherwise the close instruction will fail.
 */
export async function burnUsdcTokenAccount(
  connection: Connection,
  wallet: Keypair,
): Promise<string | null> {
  const usdcMint = new PublicKey(config.usdcMint);

  const ata = await getAssociatedTokenAddress(usdcMint, wallet.publicKey);

  // Verify account exists
  const accountInfo = await connection.getAccountInfo(ata);
  if (!accountInfo) {
    logger.warn(`[${wallet.publicKey.toBase58().slice(0, 8)}] USDC token account does not exist, skipping burn`);
    return null;
  }

  logger.info(`[${wallet.publicKey.toBase58().slice(0, 8)}] Closing USDC token account (Sol Incinerator): ${ata.toBase58()}`);

  const closeIx = createCloseAccountInstruction(
    ata,               // account to close
    wallet.publicKey,  // rent destination
    wallet.publicKey,  // authority
    [],
    TOKEN_PROGRAM_ID,
  );

  const tx = new Transaction().add(closeIx);

  const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
    commitment: 'confirmed',
  });

  logger.info(`[${wallet.publicKey.toBase58().slice(0, 8)}] Token account closed (burned): ${sig}`);
  return sig;
}
