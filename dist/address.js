/**
 * Address validation and normalization for Cardano bech32 addresses.
 */
import { bech32 } from "bech32";
/** Validate a Cardano bech32 address */
export function isValidAddress(addr) {
    try {
        if (addr.startsWith("addr1") || addr.startsWith("addr_test1")) {
            bech32.decode(addr, 256);
            return true;
        }
        return false;
    }
    catch {
        return false;
    }
}
// ── Address construction ────────────────────────────────────────────────────
function validateHash(hash) {
    if (!/^[0-9a-fA-F]{56}$/.test(hash)) {
        throw new Error("Invalid hash: expected 56 hex chars (28 bytes), got " + hash.length + " chars");
    }
    return Buffer.from(hash, "hex");
}
function bech32Prefix(network) {
    return network === "mainnet" ? "addr" : "addr_test";
}
function networkId(network) {
    return network === "mainnet" ? 1 : 0;
}
/**
 * Build a Shelley base address (type 0) from payment + staking key hashes.
 * Use when you have raw 28-byte key hashes and need a bech32 address.
 */
export function buildBaseAddress(paymentKeyHash, stakeKeyHash, network) {
    const payment = validateHash(paymentKeyHash);
    const stake = validateHash(stakeKeyHash);
    const header = 0x00 | networkId(network); // type 0 = key/key base address
    const bytes = new Uint8Array(57);
    bytes[0] = header;
    bytes.set(payment, 1);
    bytes.set(stake, 29);
    return bech32.encode(bech32Prefix(network), bech32.toWords(bytes), 256);
}
/**
 * Build a Shelley enterprise address (no staking component) from a key or script hash.
 * For validator script addresses, pass isScript=true.
 */
export function buildEnterpriseAddress(hash, network, isScript = false) {
    const hashBytes = validateHash(hash);
    const typeNibble = isScript ? 0x70 : 0x60; // type 7 = script enterprise, type 6 = key enterprise
    const header = typeNibble | networkId(network);
    const bytes = new Uint8Array(29);
    bytes[0] = header;
    bytes.set(hashBytes, 1);
    return bech32.encode(bech32Prefix(network), bech32.toWords(bytes), 256);
}
/** Validate a policy ID (28 bytes = 56 hex chars) */
export function isValidPolicyId(policyId) {
    return /^[0-9a-fA-F]{56}$/.test(policyId);
}
/** Normalize address to lowercase */
export function normalizeAddress(addr) {
    return addr.toLowerCase();
}
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
export function getPaymentKeyHash(addr) {
    try {
        const decoded = bech32.decode(addr, 256);
        const bytes = bech32.fromWords(decoded.words);
        if (bytes.length < 29)
            return null;
        const header = bytes[0];
        const addrType = (header >> 4) & 0x0f;
        // Types 0x00 and 0x01 have a key hash payment credential
        // Types 0x02 and 0x03 have a script hash payment credential
        // Types 0x06 and 0x07 are enterprise addresses (key/script, no staking)
        if (addrType === 0 || addrType === 1 || addrType === 6) {
            // Key hash payment credential: bytes 1-28
            return Buffer.from(bytes.slice(1, 29)).toString("hex");
        }
        return null; // script address or unsupported type
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=address.js.map