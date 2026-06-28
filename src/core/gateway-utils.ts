import { isAddress, parseUnits } from 'viem';

/**
 * Generic Gateway utilities for the Tessera core.
 * Platform-agnostic — no PeerTube or Owncast specific logic.
 */

/**
 * Flat gas buffer reserved when a buyer withdraws their remaining Gateway balance.
 * The Arc Gateway charges roughly ~0.003–0.005 USDC as a settlement fee.
 */
export const GATEWAY_FEE_BUFFER = parseUnits('0.005', 6);

/**
 * Returns true if `address` is a valid checksummed or lowercase EVM address.
 */
export function isValidEvmAddress(address: string): boolean {
    return isAddress(address);
}
