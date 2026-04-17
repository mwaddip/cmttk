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
/**
 * CIP-2 Random-Improve coin selection.
 *
 * Phase 1 (Random Select): For each required asset, randomly pick UTxOs
 * until the accumulated value covers the requirement.
 *
 * Phase 2 (Improve): For each selection, try to swap the last-picked UTxO
 * with one from the remaining pool that brings change closer to the output
 * value (ideal change ≈ output value for UTxO diversity).
 *
 * Falls back to Largest-First if Random-Improve can't satisfy requirements
 * within a bounded number of attempts.
 */
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
    /** Optional execution unit budget. If omitted, uses max-per-tx / redeemer-count. */
    exUnits?: {
        mem: bigint;
        steps: bigint;
    };
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
    /** Optional execution unit budget. If omitted, uses max-per-tx / redeemer-count. */
    exUnits?: {
        mem: bigint;
        steps: bigint;
    };
}
/** Pieces of an unsigned script tx, ready for CIP-30 `signTx` + merge + submit. */
export interface UnsignedScriptTx {
    /** Serialised tx body — pass this to CIP-30 `wallet.signTx(hex, true)`. */
    txBodyCbor: Uint8Array;
    /** Partial witness set: redeemers (field 5) + plutus scripts (field 7). No vkeys. */
    witnessSet: Uint8Array;
    /** Redeemer map CBOR alone (for merging or display). */
    redeemersCbor: Uint8Array;
    /** PlutusV3 scripts array CBOR (for merging or display). */
    plutusV3Scripts: Uint8Array;
    /** Computed script_data_hash, already embedded in txBodyCbor. */
    scriptDataHash: Uint8Array;
    /** Final fee used in the body. */
    fee: bigint;
}
/**
 * Build, sign, and submit a transaction with script inputs, datums, minting.
 *
 * Handles: script spending, redeemers, inline datums, minting/burning,
 * validity ranges, required signers, iterative fee calculation.
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
/**
 * Build a script transaction ready for CIP-30 wallet signing.
 *
 * Mirrors `buildAndSubmitScriptTx` but:
 *   1. takes `walletUtxos` as a pre-parsed parameter (wallet already has them via `api.getUtxos()`);
 *   2. takes `collateralUtxos` explicitly (CIP-30 exposes `api.getCollateral()`);
 *   3. does not sign or submit — returns the body and partial witness set
 *      (redeemers + scripts, no vkeys) for the wallet to co-sign.
 *
 * Flow: consumer calls this, then `api.signTx(bytesToHex(txBodyCbor), true)`,
 * then `mergeCip30Witness(unsigned, walletWitnessHex)`, then `submitTx`.
 */
export declare function buildUnsignedScriptTx(params: {
    provider: CardanoProvider;
    walletAddress: string;
    /** Pre-parsed UTxOs from CIP-30 `api.getUtxos()` via `parseCip30Utxos()`. */
    walletUtxos: Utxo[];
    /** Pre-parsed collateral UTxOs from CIP-30 `api.getCollateral()` via `parseCip30Utxos()`. */
    collateralUtxos: Utxo[];
    scriptInputs: ScriptInput[];
    outputs: TxOutput[];
    mints?: MintEntry[];
    spendingScriptCbor?: string;
    validFrom?: number;
    validTo?: number;
    network?: import("./types.js").CardanoNetwork;
    requiredSigners?: string[];
}): Promise<UnsignedScriptTx>;
/**
 * Parse a CIP-30 `api.getUtxos()` / `api.getCollateral()` response into
 * typed `Utxo[]`. Each entry is CBOR hex encoding `[input, output]`.
 *
 * Supports both post-Babbage map outputs (`{0: address, 1: value, ...}`)
 * and pre-Babbage array outputs (`[address, value, ?datum_hash]`). Value
 * may be a bare uint (ADA-only) or `[lovelace, multiasset]`.
 */
export declare function parseCip30Utxos(cborHexArray: string[]): Utxo[];
/**
 * Merge the witness set returned by CIP-30 `api.signTx(cbor, partial=true)`
 * into the partial witness set from `buildUnsignedScriptTx`, producing a
 * fully-signed transaction hex string ready for `provider.submitTx`.
 *
 * Wallet entries take precedence on key collision; in practice wallets add
 * field 0 (vkey_witnesses), sometimes field 1 (native_scripts) or field 4
 * (bootstrap_witness), none of which collide with the partial's field 5
 * (redeemers) or field 7 (plutus_v3_scripts).
 */
export declare function mergeCip30Witness(unsigned: UnsignedScriptTx, walletWitnessCbor: string): string;
//# sourceMappingURL=tx.d.ts.map