/**
 * CIP-1852 key derivation from BIP39 mnemonic.
 *
 * Derives payment and stake keys from a mnemonic phrase following
 * Cardano's CIP-1852 derivation standard:
 *   m/1852'/1815'/0'/0/0  — payment key
 *   m/1852'/1815'/0'/2/0  — stake key
 */
import type { CardanoNetwork } from "./types.js";
export interface CardanoWallet {
    paymentKey: Uint8Array;
    paymentPubKey: Uint8Array;
    paymentKeyHash: string;
    stakeKey: Uint8Array;
    stakePubKey: Uint8Array;
    stakeKeyHash: string;
    address: string;
    network: CardanoNetwork;
}
/**
 * Derive a Cardano wallet from a BIP39 mnemonic.
 * Path: m/1852'/1815'/0' (CIP-1852)
 * Payment key: m/1852'/1815'/0'/0/0
 * Stake key:   m/1852'/1815'/0'/2/0
 */
export declare function deriveWallet(mnemonic: string, network: CardanoNetwork): Promise<CardanoWallet>;
//# sourceMappingURL=wallet.d.ts.map