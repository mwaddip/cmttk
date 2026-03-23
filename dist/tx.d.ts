/**
 * Minimal Cardano transaction builder for ADA and native token transfers.
 *
 * Uses raw CBOR construction (no CML, no Lucid) backed by:
 * - src/cardano/cbor.ts (encoder/decoder)
 * - src/cardano/provider.ts (Koios/Blockfrost queries + protocol params)
 * - noble-bip32ed25519 (Ed25519 signing)
 * - bech32 (address encoding)
 *
 * Fee calculation: two-pass deterministic (build → measure → compute → rebuild).
 */
import type { CardanoProvider, ProtocolParams } from "./provider.js";
/** A parsed UTXO from Koios /address_utxos response. */
export interface Utxo {
    txHash: string;
    index: number;
    lovelace: bigint;
    /** Tokens as { "policyId+assetNameHex": quantity } */
    tokens: Record<string, bigint>;
}
/** Assets for a transaction output. lovelace is always present. */
export interface Assets {
    lovelace: bigint;
    [unit: string]: bigint;
}
/** Decode a bech32 Cardano address to raw bytes (hex). */
export declare function addressToHex(addr: string): string;
/** Parse Koios /address_utxos response into typed Utxo[]. */
export declare function parseKoiosUtxos(raw: unknown[]): Utxo[];
/** Simple greedy coin selection. Returns selected UTXOs or throws. */
export declare function selectUtxos(utxos: Utxo[], required: Assets): {
    selected: Utxo[];
    inputTotal: Assets;
};
/** Calculate the minimum fee for a transaction.
 *  For simple txs: minFeeA * size + minFeeB
 *  For script txs: adds ceil(priceMem * totalMem) + ceil(priceStep * totalSteps) */
export declare function calculateFee(txSizeBytes: number, pp: ProtocolParams, exUnits?: {
    mem: bigint;
    steps: bigint;
}): bigint;
/** Build CBOR for a simple output (ADA only or ADA + tokens). */
export declare function buildOutputCbor(addrHex: string, lovelace: bigint, tokens?: [string, bigint][]): Uint8Array;
/** Build, sign, and submit a simple ADA/token transfer with proper fee calculation. */
export declare function buildAndSubmitTransfer(params: {
    provider: CardanoProvider;
    fromAddress: string;
    toAddress: string;
    assets: Assets;
    signingKey: Uint8Array;
}): Promise<string>;
/** A script input to spend from a validator. */
export interface ScriptInput {
    utxo: Utxo;
    /** Address the UTXO sits at (bech32) */
    address: string;
    /** Redeemer CBOR hex (from Data.to()) */
    redeemerCbor: string;
}
/** An output with an optional inline datum. */
export interface TxOutput {
    address: string;
    assets: Assets;
    /** Inline datum CBOR hex (from Data.to()) — omit for plain outputs */
    datumCbor?: string;
}
/** Mint/burn entry. */
export interface MintEntry {
    policyId: string;
    assets: Record<string, bigint>;
    redeemerCbor: string;
    /** PlutusV3 script CBOR hex (from plutus.json compiledCode) */
    scriptCbor: string;
}
/**
 * Build, sign, and submit a transaction with script inputs, datums, minting.
 *
 * Handles: script spending, redeemers, inline datums, minting/burning,
 * validity ranges, required signers, two-pass fee calculation.
 */
export declare function buildAndSubmitScriptTx(params: {
    provider: CardanoProvider;
    /** Wallet UTXOs for fee/collateral (bech32 address) */
    walletAddress: string;
    /** Script inputs to spend (with redeemers) */
    scriptInputs: ScriptInput[];
    /** All outputs (recipient, continuing, change handled automatically) */
    outputs: TxOutput[];
    /** Minting/burning entries */
    mints?: MintEntry[];
    /** PlutusV3 spending validator CBOR hex (from plutus.json compiledCode) */
    spendingScriptCbor?: string;
    /** Validity range (POSIX ms) — converted to slots automatically */
    validFrom?: number;
    validTo?: number;
    /** Cardano network (for slot conversion). Default: preprod */
    network?: import("./types.js").CardanoNetwork;
    /** Required signer key hashes (hex) */
    requiredSigners?: string[];
    /** 64-byte signing key (kL + kR) */
    signingKey: Uint8Array;
}): Promise<string>;
//# sourceMappingURL=tx.d.ts.map