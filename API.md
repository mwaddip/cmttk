# cmttk API Reference

All exports are available from the main entry point:

```typescript
import { deriveWallet, getProvider, buildAndSubmitTransfer, ... } from "cmttk";
```

Subpath imports are also available for tree-shaking:

```typescript
import { Constr, Data } from "cmttk/data";
import { getProvider } from "cmttk/provider";
```

---

## Wallet (`cmttk/wallet`)

### `deriveWallet(mnemonic, network)`

Derive a Cardano wallet from a BIP39 mnemonic phrase using CIP-1852 derivation paths.

```typescript
function deriveWallet(mnemonic: string, network: CardanoNetwork): Promise<CardanoWallet>
```

**Derivation paths:**
- Payment key: `m/1852'/1815'/0'/0/0`
- Stake key: `m/1852'/1815'/0'/2/0`

**Returns:**

```typescript
interface CardanoWallet {
  paymentKey: Uint8Array;      // 64-byte extended private key (kL + kR)
  paymentPubKey: Uint8Array;   // 32-byte Ed25519 public key
  paymentKeyHash: string;      // blake2b-224 hash (56 hex chars)
  stakeKey: Uint8Array;
  stakePubKey: Uint8Array;
  stakeKeyHash: string;
  address: string;             // bech32 base address (addr1... or addr_test1...)
  network: CardanoNetwork;
}
```

---

## Transaction Builder (`cmttk/tx`)

### `buildAndSubmitTransfer(params)`

Build, sign, and submit a simple ADA or native token transfer. Handles UTXO query, coin selection, fee calculation, signing, and submission.

```typescript
function buildAndSubmitTransfer(params: {
  provider: CardanoProvider;
  fromAddress: string;           // sender bech32 address
  toAddress: string;             // recipient bech32 address
  assets: Assets;                // { lovelace: bigint, [unit]: bigint } — lovelace auto-bumped to min-UTxO
  signingKey: Uint8Array;        // 64-byte extended private key
}): Promise<string>              // returns tx hash
```

### `buildAndSubmitScriptTx(params)`

Build, sign, and submit a transaction with Plutus script execution. Supports script spending, minting/burning, inline datums, redeemers, validity ranges, and required signers.

```typescript
function buildAndSubmitScriptTx(params: {
  provider: CardanoProvider;
  walletAddress: string;         // wallet for fee/collateral UTXOs
  scriptInputs: ScriptInput[];   // script UTXOs to spend
  outputs: TxOutput[];           // explicit outputs (change is automatic)
  mints?: MintEntry[];           // mint/burn with Plutus policy
  spendingScriptCbor?: string;   // PlutusV3 spending validator (compiledCode hex)
  validFrom?: number;            // POSIX ms (converted to slots automatically)
  validTo?: number;              // POSIX ms
  network?: CardanoNetwork;      // for slot conversion (default: "preprod")
  requiredSigners?: string[];    // payment key hashes (hex)
  signingKey: Uint8Array;        // 64-byte extended private key
}): Promise<string>              // returns tx hash
```

### Supporting types

```typescript
interface Utxo {
  txHash: string;
  index: number;
  lovelace: bigint;
  tokens: Record<string, bigint>;  // "policyId+assetName" → quantity
}

interface Assets {
  lovelace: bigint;
  [unit: string]: bigint;         // "policyId+assetName" → quantity
}

interface ScriptInput {
  utxo: Utxo;
  address: string;                // bech32 address where the UTXO sits
  redeemerCbor: string;           // Plutus Data CBOR hex (from Data.to())
  exUnits?: { mem: bigint; steps: bigint }; // optional per-redeemer budget (default: max-per-tx / redeemer-count)
}

interface TxOutput {
  address: string;                // bech32 destination
  assets: Assets;                 // lovelace is auto-bumped to min-UTxO if below protocol minimum
  datumCbor?: string;             // inline datum CBOR hex (from Data.to())
}

interface MintEntry {
  policyId: string;               // 56 hex chars
  assets: Record<string, bigint>; // assetNameHex → quantity (negative to burn)
  redeemerCbor: string;           // Plutus Data CBOR hex
  scriptCbor: string;             // compiledCode hex from plutus.json
  exUnits?: { mem: bigint; steps: bigint }; // optional per-redeemer budget (default: max-per-tx / redeemer-count)
}
```

### `parseKoiosUtxos(raw)`

Parse the raw JSON response from Koios `/address_utxos` into typed `Utxo[]`.

```typescript
function parseKoiosUtxos(raw: unknown[]): Utxo[]
```

### `parseCip30Utxos(cborHexArray)`

Parse the CBOR hex strings returned by CIP-30 `api.getUtxos()` or `api.getCollateral()` into typed `Utxo[]`. Each entry encodes a `[input, output]` pair; both pre-Babbage array outputs and post-Babbage map outputs are accepted.

```typescript
function parseCip30Utxos(cborHexArray: string[]): Utxo[]
```

### `buildUnsignedScriptTx(params)`

Build a script transaction ready for CIP-30 wallet signing. Mirrors `buildAndSubmitScriptTx` but takes wallet UTxOs and collateral UTxOs as pre-parsed parameters (CIP-30 wallets expose `api.getUtxos()` and `api.getCollateral()` explicitly) and returns the unsigned body plus a partial witness set instead of signing and submitting.

```typescript
function buildUnsignedScriptTx(params: {
  provider: CardanoProvider;
  walletAddress: string;
  walletUtxos: Utxo[];            // from parseCip30Utxos(api.getUtxos())
  collateralUtxos: Utxo[];        // from parseCip30Utxos(api.getCollateral())
  scriptInputs: ScriptInput[];
  outputs: TxOutput[];
  mints?: MintEntry[];
  spendingScriptCbor?: string;
  validFrom?: number;
  validTo?: number;
  network?: CardanoNetwork;
  requiredSigners?: string[];
}): Promise<UnsignedScriptTx>
```

```typescript
interface UnsignedScriptTx {
  txBodyCbor: Uint8Array;         // pass to api.signTx(bytesToHex(txBodyCbor), true)
  witnessSet: Uint8Array;         // partial witness set: redeemers + scripts, no vkeys
  redeemersCbor: Uint8Array;
  plutusV3Scripts: Uint8Array;
  scriptDataHash: Uint8Array;     // already embedded in txBodyCbor
  fee: bigint;
}
```

### `mergeCip30Witness(unsigned, walletWitnessCbor)`

Merge the CBOR witness set returned by CIP-30 `api.signTx(cbor, partial=true)` into the partial witness set from `buildUnsignedScriptTx`, producing a fully-signed transaction hex string ready for `provider.submitTx`.

```typescript
function mergeCip30Witness(
  unsigned: UnsignedScriptTx,
  walletWitnessCbor: string,
): string
```

The wallet typically returns a witness set containing only field 0 (vkey_witnesses) and sometimes field 1 (native_scripts) or field 4 (bootstrap_witness). None collide with the partial set's field 5 (redeemers) or field 7 (plutus_v3_scripts); on any collision the wallet's value wins.

### `selectUtxos(utxos, required)`

CIP-2 Random-Improve coin selection. Randomly selects UTxOs until requirements are met, then improves by swapping to bring change closer to the output value (promoting UTxO diversity). Falls back to Largest-First greedy selection if randomness doesn't produce a solution within 3 attempts.

```typescript
function selectUtxos(utxos: Utxo[], required: Assets): {
  selected: Utxo[];
  inputTotal: Assets;
}
```

Throws if requirements cannot be met.

### `calculateFee(txSizeBytes, pp, exUnits?)`

Deterministic fee calculation from protocol parameters.

```typescript
function calculateFee(
  txSizeBytes: number,
  pp: ProtocolParams,
  exUnits?: { mem: bigint; steps: bigint },
): bigint
```

Formula: `minFeeA * size + minFeeB + ceil(priceMem * mem) + ceil(priceStep * steps)`

### `addressToHex(addr)`

Decode a bech32 Cardano address to raw hex bytes.

```typescript
function addressToHex(addr: string): string
```

### `buildOutputCbor(addrHex, lovelace, tokens?)`

Build CBOR for a single transaction output.

```typescript
function buildOutputCbor(
  addrHex: string,
  lovelace: bigint,
  tokens?: [string, bigint][],
): Uint8Array
```

---

## Plutus Data (`cmttk/data`)

### `Constr`

Plutus Data constructor. Matches Lucid's `Constr` API.

```typescript
class Constr<T = PlutusField> {
  readonly index: number;
  readonly fields: T[];
  constructor(index: number, fields: T[]);
}
```

CBOR tag mapping:
- `Constr(0)` through `Constr(6)` → CBOR tags 121–127
- `Constr(7+)` → CBOR tag 102 + `[index, fields]`

Aiken boolean convention: `True` = `Constr(1, [])`, `False` = `Constr(0, [])`

### `Data.to(value)`

Encode a Plutus Data value to CBOR hex string.

```typescript
Data.to(value: PlutusField): string
```

Accepts `bigint`, hex `string` (encoded as bytes), `Uint8Array`, `Constr`, arrays, and `Map`.

### `Data.from(cborHex)`

Decode CBOR hex back to Plutus Data. Preserves nested `Constr` tags.

```typescript
Data.from(cborHex: string): PlutusField
```

### `fromText(text)`

Convert a UTF-8 string to hex encoding (for Plutus `ByteArray` fields).

```typescript
function fromText(text: string): string
```

### `applyParamsToScript(compiledCode, params)`

Apply Plutus Data parameters to an unparameterized UPLC script from `plutus.json`. Each parameter wraps the program in a UPLC `Apply(program, Const(Data, param))` node. Compatible with Aiken's `blueprint apply`, Lucid, and MeshJS.

```typescript
function applyParamsToScript(compiledCode: string, params: PlutusField[]): string
```

- `compiledCode` — hex-encoded CBOR from `plutus.json` (the `validators[].compiledCode` field)
- `params` — parameters to apply, left-to-right (first param = outermost lambda)
- Returns the new `compiledCode` with parameters applied

Parameters are typically 28-byte key hashes or script hashes (passed as hex strings), but any `PlutusField` value is supported.

```typescript
import { applyParamsToScript } from "cmttk";

// Apply server_key_hash to an Aiken validator
const parameterized = applyParamsToScript(
  validator.compiledCode,
  ["2dbdd41304e95e4a1846c045328d746bf2267a0a619ec55976e7beb1"],
);

// Multiple parameters are applied left-to-right
const fullyApplied = applyParamsToScript(code, [param1, param2]);
// Equivalent to: applyParamsToScript(applyParamsToScript(code, [param1]), [param2])
```

Internally, this fully decodes and re-encodes the UPLC flat binary format. This is necessary because the flat encoding's bytestring alignment is position-dependent — wrapping in an Apply node shifts all subsequent byte boundaries. See [APPLY_PARAMS_SPEC.md](./APPLY_PARAMS_SPEC.md) for implementation details.

### `PlutusField`

Union type for all valid Plutus Data values:

```typescript
type PlutusField =
  | bigint
  | number
  | string              // hex-encoded bytes
  | Uint8Array
  | Constr<PlutusField>
  | PlutusField[]
  | Map<PlutusField, PlutusField>;
```

---

## Provider (`cmttk/provider`)

### `getProvider(network, blockfrostProjectId?, koiosUrl?)`

Create or return a cached chain query provider. Uses Koios by default (free, no API key). Pass a Blockfrost project ID to use Blockfrost instead. Pass a custom Koios URL to override the default endpoint (useful for private instances or endpoint rotation).

```typescript
function getProvider(
  network: CardanoNetwork,
  blockfrostProjectId?: string,
  koiosUrl?: string,
): CardanoProvider
```

When `koiosUrl` is provided and no Blockfrost ID is set, the Koios provider uses the custom URL instead of the hardcoded default for that network.

### `resetProvider()`

Clear the cached provider (useful in tests).

### `CardanoProvider` interface

```typescript
interface CardanoProvider {
  readonly name: string;
  fetchUtxos(address: string, asset?: string): Promise<unknown[]>;
  fetchTip(): Promise<{ slot: number; block: number; time: number }>;
  submitTx(txCbor: string): Promise<string>;
  fetchTxMetadata(txHash: string): Promise<unknown[]>;
  fetchAddressTransactions(address: string, options?: { count?: number; order?: "asc" | "desc" }): Promise<unknown[]>;
  fetchAssetAddresses(asset: string): Promise<Array<{ address: string; quantity: string }>>;
  fetchAddressInfo(address: string): Promise<unknown>;
  fetchProtocolParams(): Promise<ProtocolParams>;
}
```

### `ProtocolParams`

```typescript
interface ProtocolParams {
  minFeeA: number;           // lovelace per byte
  minFeeB: number;           // fixed fee component
  coinsPerUtxoByte: number;  // for min UTXO calculation
  costModelV3?: number[];    // PlutusV3 cost model (297 values)
  priceMem: number;          // lovelace per memory unit (decimal)
  priceStep: number;         // lovelace per CPU step (decimal)
}
```

---

## Address (`cmttk/address`)

### `isValidAddress(addr)`

Validate a Cardano bech32 address (`addr1...` or `addr_test1...`).

```typescript
function isValidAddress(addr: string): boolean
```

### `isValidPolicyId(policyId)`

Validate a policy ID (56 hex characters).

```typescript
function isValidPolicyId(policyId: string): boolean
```

### `getPaymentKeyHash(addr)`

Extract the 28-byte payment key hash from a bech32 address. Returns `null` for script addresses or addresses without a key hash payment credential.

```typescript
function getPaymentKeyHash(addr: string): string | null
```

### `buildBaseAddress(paymentKeyHash, stakeKeyHash, network)`

Build a Shelley base address (type 0) from raw 28-byte key hashes. Use when you have raw key material without going through `deriveWallet`.

```typescript
function buildBaseAddress(paymentKeyHash: string, stakeKeyHash: string, network: CardanoNetwork): string
```

Both hashes must be 56 hex chars (28 bytes). Returns a bech32 address with prefix `addr` (mainnet) or `addr_test` (testnet/preprod/preview).

### `buildEnterpriseAddress(hash, network, isScript?)`

Build a Shelley enterprise address (no staking component) from a key hash or script hash. For validator script addresses, pass `isScript: true`.

```typescript
function buildEnterpriseAddress(hash: string, network: CardanoNetwork, isScript?: boolean): string
```

```typescript
import { buildEnterpriseAddress } from "cmttk";

// Script address from a validator hash
const scriptAddr = buildEnterpriseAddress(validatorHash, "preprod", true);

// Key-based enterprise address (no staking)
const keyAddr = buildEnterpriseAddress(paymentKeyHash, "preprod");
```

### `normalizeAddress(addr)`

Lowercase normalize an address string.

```typescript
function normalizeAddress(addr: string): string
```

---

## Time (`cmttk/time`)

### `posixToSlot(posixMs, network)`

Convert POSIX milliseconds to an absolute Cardano slot number.

```typescript
function posixToSlot(posixMs: number, network: CardanoNetwork): number
```

### `slotToPosix(slot, network)`

Convert an absolute slot number to POSIX milliseconds.

```typescript
function slotToPosix(slot: number, network: CardanoNetwork): number
```

**Shelley genesis times (immutable per network):**

| Network | Shelley start (ms) | Slot length |
|---|---|---|
| preprod | 1655683200000 | 1 second |
| preview | 1666656000000 | 1 second |
| mainnet | 1591566291000 | 1 second |

---

## CBOR (`cmttk/cbor`)

Low-level CBOR encoder/decoder. You typically don't need these directly — `Data.to/from` and the transaction builder handle CBOR internally. Exposed for advanced use cases (custom datum formats, raw transaction construction).

### Encoder

```typescript
function cborUint(n: number | bigint): Uint8Array
function cborBytes(data: Uint8Array | string): Uint8Array    // string = hex
function cborArray(items: Uint8Array[]): Uint8Array           // items must be pre-encoded
function cborMap(entries: [Uint8Array, Uint8Array][]): Uint8Array
function cborTag(tagNum: number, content: Uint8Array): Uint8Array
function cborHeader(major: number, n: number | bigint): Uint8Array
```

### Decoder

```typescript
function decodeCbor(bytes: Uint8Array, pos: number): CborDecoded

interface CborDecoded {
  value: CborValue;
  offset: number;   // position after the decoded item
}

type CborValue =
  | bigint | boolean | null | undefined | string | number
  | Uint8Array | CborValue[] | Map<CborValue, CborValue>;
```

### Map entry parser

```typescript
function parseCborMap(bytes: Uint8Array, pos?: number): {
  entries: Array<{ key: CborValue; rawValue: Uint8Array }>;
  endOffset: number;
}
```

Parse a CBOR map, returning each entry's decoded key alongside the value's original CBOR bytes. Lets you re-emit or merge maps without round-tripping the values through the decoder. Used internally by `mergeCip30Witness`.

### Byte utilities

```typescript
function hexToBytes(hex: string): Uint8Array
function bytesToHex(bytes: Uint8Array): string
function concatBytes(arrays: Uint8Array[]): Uint8Array
```

---

## Types (`cmttk/types`)

```typescript
type CardanoNetwork = "mainnet" | "preprod" | "preview";

interface AssetId {
  policyId: string;    // 56 hex chars
  assetName: string;   // hex-encoded
}
```
