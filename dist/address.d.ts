/**
 * Address validation and normalization for Cardano bech32 addresses.
 */
import type { CardanoNetwork } from "./types.js";
/** Validate a Cardano bech32 address */
export declare function isValidAddress(addr: string): boolean;
/**
 * Build a Shelley base address (type 0) from payment + staking key hashes.
 * Use when you have raw 28-byte key hashes and need a bech32 address.
 */
export declare function buildBaseAddress(paymentKeyHash: string, stakeKeyHash: string, network: CardanoNetwork): string;
/**
 * Build a Shelley enterprise address (no staking component) from a key or script hash.
 * For validator script addresses, pass isScript=true.
 */
export declare function buildEnterpriseAddress(hash: string, network: CardanoNetwork, isScript?: boolean): string;
/** Validate a policy ID (28 bytes = 56 hex chars) */
export declare function isValidPolicyId(policyId: string): boolean;
/** Normalize address to lowercase */
export declare function normalizeAddress(addr: string): string;
/**
 * Extract the payment credential key hash from a bech32 address.
 * Replaces Lucid's getAddressDetails().paymentCredential.hash.
 *
 * Cardano base address layout (type 0x00/0x01):
 *   header(1) + paymentKeyHash(28) + stakeKeyHash(28) = 57 bytes
 *
 * Returns the 28-byte payment key hash as 56-char hex, or null if
 * the address type doesn't contain a key hash payment credential.
 */
export declare function getPaymentKeyHash(addr: string): string | null;
//# sourceMappingURL=address.d.ts.map