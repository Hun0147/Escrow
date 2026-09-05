import { getSetting } from './settings';

/**
 * The one place the escrow fee rate is decided.
 *
 * The rate lives in platform_settings, not in a constant, so compliance or
 * operations can change what Goal 27 charges without a deploy — and so there
 * is exactly one answer to "what is the fee?", whether the caller is settling
 * a match, paying a tournament prize or processing a withdrawal.
 */
export async function escrowFeeBpsFor(anySubscriber: boolean): Promise<number> {
  return anySubscriber ? getSetting('pro_escrow_fee_bps') : getSetting('escrow_fee_bps');
}

/** Both published rates, for clients that need to preview a fee. */
export async function publishedFeeRates(): Promise<{ standardBps: number; proBps: number }> {
  return {
    standardBps: await getSetting('escrow_fee_bps'),
    proBps: await getSetting('pro_escrow_fee_bps'),
  };
}
