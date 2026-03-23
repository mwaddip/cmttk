/**
 * cmttk — Cardano Minimal Transaction Toolkit
 *
 * Pure TypeScript Cardano transaction building with no WASM dependencies.
 * ~1500 lines replacing the 200MB Lucid/CML/cardano-sdk stack.
 *
 * Dependencies: noble-bip32ed25519, @noble/curves, @noble/hashes, bech32, bip39
 */

// CBOR encoder/decoder
export {
  hexToBytes,
  bytesToHex,
  concatBytes,
  cborHeader,
  cborUint,
  cborBytes,
  cborArray,
  cborMap,
  cborTag,
  decodeCbor,
} from "./cbor.js";
export type { CborValue, CborDecoded } from "./cbor.js";

// Plutus Data codec
export { Constr, Data, fromText } from "./data.js";
export type { PlutusField } from "./data.js";

// Transaction builder
export {
  parseKoiosUtxos,
  selectUtxos,
  calculateFee,
  addressToHex,
  buildOutputCbor,
  buildAndSubmitTransfer,
  buildAndSubmitScriptTx,
} from "./tx.js";
export type { Utxo, Assets, ScriptInput, TxOutput, MintEntry } from "./tx.js";

// Chain providers (Koios + Blockfrost)
export { getProvider, resetProvider } from "./provider.js";
export type { CardanoProvider, ProtocolParams } from "./provider.js";

// Wallet / key derivation
export { deriveWallet } from "./wallet.js";
export type { CardanoWallet } from "./wallet.js";

// Address utilities
export { isValidAddress, isValidPolicyId, normalizeAddress, getPaymentKeyHash } from "./address.js";

// Slot ↔ POSIX time conversion
export { posixToSlot, slotToPosix } from "./time.js";

// Types
export type { CardanoNetwork, AssetId } from "./types.js";
