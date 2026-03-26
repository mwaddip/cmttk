/**
 * CIP-1852 key derivation from BIP39 mnemonic.
 *
 * Derives payment and stake keys from a mnemonic phrase following
 * Cardano's CIP-1852 derivation standard:
 *   m/1852'/1815'/0'/0/0  — payment key
 *   m/1852'/1815'/0'/2/0  — stake key
 */
import { Bip32PrivateKey } from "noble-bip32ed25519";
import { mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { bech32 } from "bech32";
/**
 * Construct a Cardano base address (type 0) from key hashes.
 * Header byte: 0b0000_xxxx where xxxx = network_id (0 = testnet, 1 = mainnet)
 * Payload: header(1) + payment_key_hash(28) + stake_key_hash(28) = 57 bytes
 */
function buildBaseAddress(paymentKeyHash, stakeKeyHash, networkId) {
    const header = networkId & 0x0f;
    const payload = Buffer.concat([
        Buffer.from([header]),
        Buffer.from(paymentKeyHash, "hex"),
        Buffer.from(stakeKeyHash, "hex"),
    ]);
    const words = bech32.toWords(payload);
    const prefix = networkId === 1 ? "addr" : "addr_test";
    return bech32.encode(prefix, words, 1023);
}
/**
 * Derive a Cardano wallet from a BIP39 mnemonic.
 * Path: m/1852'/1815'/0' (CIP-1852)
 * Payment key: m/1852'/1815'/0'/0/0
 * Stake key:   m/1852'/1815'/0'/2/0
 */
export async function deriveWallet(mnemonic, network) {
    if (!validateMnemonic(mnemonic, wordlist)) {
        throw new Error("Invalid mnemonic");
    }
    const entropy = mnemonicToEntropy(mnemonic, wordlist);
    const rootKey = Bip32PrivateKey.fromEntropy(Buffer.from(entropy));
    // CIP-1852 derivation path: m/1852'/1815'/0'
    // Hardened derivation uses index + 0x80000000
    const accountKey = rootKey
        .derive(2147485500) // 1852' (purpose)
        .derive(2147485463) // 1815' (coin type)
        .derive(2147483648); // 0'    (account)
    // Payment key: m/1852'/1815'/0'/0/0
    const paymentBip32Key = accountKey.derive(0).derive(0);
    const paymentPrivKey = paymentBip32Key.toPrivateKey();
    const paymentPubKey = paymentPrivKey.toPublicKey();
    // Stake key: m/1852'/1815'/0'/2/0
    const stakeBip32Key = accountKey.derive(2).derive(0);
    const stakePrivKey = stakeBip32Key.toPrivateKey();
    const stakePubKey = stakePrivKey.toPublicKey();
    // Get key hashes (blake2b-224, computed by the library)
    const paymentKeyHash = Buffer.from(paymentPubKey.hash()).toString("hex");
    const stakeKeyHash = Buffer.from(stakePubKey.hash()).toString("hex");
    // Build bech32 base address (type 0: payment key hash + stake key hash)
    const networkId = network === "mainnet" ? 1 : 0;
    const address = buildBaseAddress(paymentKeyHash, stakeKeyHash, networkId);
    return {
        paymentKey: new Uint8Array(paymentPrivKey.toBytes()),
        paymentPubKey: new Uint8Array(paymentPubKey.toBytes()),
        paymentKeyHash,
        stakeKey: new Uint8Array(stakePrivKey.toBytes()),
        stakePubKey: new Uint8Array(stakePubKey.toBytes()),
        stakeKeyHash,
        address,
        network,
    };
}
//# sourceMappingURL=wallet.js.map