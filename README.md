# cmttk — Cardano Minimal Transaction Toolkit

Pure TypeScript Cardano transaction building. No WASM, no CML, no Lucid. ~1500 lines, 236KB compiled, bundles with esbuild to under 500KB.

## What it is

cmttk handles the core operations that Cardano dApp backends need: derive wallets, query the chain, build transactions (with native tokens, Plutus scripts, inline datums, minting), sign with Ed25519, submit. It replaces Lucid Evolution, MeshJS, `@cardano-sdk/*`, and `cardano-multiplatform-lib` — a dependency tree that typically weighs 200MB and includes multiple WASM binaries that resist bundling.

## What it replaces

| cmttk module | Replaces | Size comparison |
|---|---|---|
| `cbor.ts` | `@emurgo/cardano-serialization-lib` (CML) | 12KB vs 8MB WASM |
| `data.ts` | Lucid's `Constr`, `Data.to/from` | 5KB vs pulled in all of CML |
| `tx.ts` | Lucid's transaction builder | 20KB vs ~3MB bundled |
| `provider.ts` | `@lucid-evolution/provider`, `@blockfrost/blockfrost-js` | 8KB vs 40MB SDK |
| `wallet.ts` | `@stricahq/bip32ed25519` + `libsodium-wrappers-sumo` | Uses `noble-bip32ed25519` (4.5KB) |
| `time.ts` | Lucid internal slot conversion | 1KB |

## How it works

Cardano transactions are CBOR-encoded binary structures. Most libraries use cardano-multiplatform-lib (a Rust-compiled WASM module) to serialize them. cmttk encodes the CBOR directly in TypeScript using a minimal encoder/decoder, following the Conway-era CDDL spec.

Signing uses [noble-bip32ed25519](https://github.com/mwaddip/noble-bip32ed25519) — a pure JS implementation of BIP32-Ed25519 key derivation backed by `@noble/curves`. The same library provides a drop-in `libsodium-wrappers-sumo` shim if your dependency tree still references it transitively.

Chain queries go through Koios (free, no API key) or Blockfrost (optional, with project ID) via native `fetch()`. No SDK.

## Installation

```bash
npm install github:mwaddip/cmttk#v0.2.1
```

Or add to `package.json`:
```json
"cmttk": "github:mwaddip/cmttk#v0.2.1"
```

## Quick start

### Send ADA

```typescript
import { deriveWallet, getProvider, buildAndSubmitTransfer } from "cmttk";

const wallet = await deriveWallet("your twenty four word mnemonic ...", "preprod");
const provider = getProvider("preprod");

const txHash = await buildAndSubmitTransfer({
  provider,
  fromAddress: wallet.address,
  toAddress: "addr_test1qz...",
  assets: { lovelace: 5_000_000n }, // 5 ADA (auto-bumped to min-UTxO if below)
  signingKey: wallet.paymentKey,
});

console.log(txHash);
```

### Mint a token with Plutus script

```typescript
import { deriveWallet, getProvider, buildAndSubmitScriptTx, Constr, Data } from "cmttk";

const wallet = await deriveWallet("your mnemonic ...", "preprod");
const provider = getProvider("preprod");

const mintRedeemer = Data.to(new Constr(0, [])); // MintNft
const datum = Data.to(new Constr(0, ["deadbeef"]));

const txHash = await buildAndSubmitScriptTx({
  provider,
  walletAddress: wallet.address,
  scriptInputs: [],
  outputs: [
    { address: wallet.address, assets: { lovelace: 2_000_000n, [policyId + assetName]: 1n } },
    { address: wallet.address, assets: { lovelace: 2_000_000n, [policyId + refName]: 1n }, datumCbor: datum },
  ],
  mints: [{
    policyId,
    assets: { [assetName]: 1n, [refName]: 1n },
    redeemerCbor: mintRedeemer,
    scriptCbor: compiledCode, // from plutus.json
  }],
  validFrom: Date.now() - 120_000,
  validTo: Date.now() + 600_000,
  network: "preprod",
  requiredSigners: [serverKeyHash],
  signingKey: wallet.paymentKey,
});
```

### Spend a script UTXO

```typescript
import { buildAndSubmitScriptTx, Constr, Data, getProvider, deriveWallet, parseKoiosUtxos } from "cmttk";

const provider = getProvider("preprod");
const wallet = await deriveWallet("your mnemonic ...", "preprod");

// Find the UTXO to spend
const rawUtxos = await provider.fetchUtxos(validatorAddress);
const utxos = parseKoiosUtxos(rawUtxos);
const target = utxos[0]; // pick your UTXO

// Decode inline datum, compute updated datum
const oldDatum = Data.from(inlineDatumHex);
const newDatum = Data.to(new Constr(0, [/* updated fields */]));

const txHash = await buildAndSubmitScriptTx({
  provider,
  walletAddress: wallet.address,
  scriptInputs: [{
    utxo: target,
    address: validatorAddress,
    redeemerCbor: Data.to(new Constr(0, [])),
  }],
  outputs: [{
    address: validatorAddress, // continuing output
    assets: { lovelace: 2_000_000n },
    datumCbor: newDatum,
  }],
  spendingScriptCbor: compiledCode,
  validFrom: Date.now() - 120_000,
  validTo: Date.now() + 600_000,
  network: "preprod",
  requiredSigners: [keyHash],
  signingKey: wallet.paymentKey,
});
```

### Apply parameters to Aiken validators

```typescript
import { applyParamsToScript } from "cmttk";
import { blake2b } from "@noble/hashes/blake2b";
import { hexToBytes, bytesToHex } from "cmttk/cbor";
import plutus from "./plutus.json" with { type: "json" };

const serverKeyHash = "2dbdd41304e95e4a1846c045328d746bf2267a0a619ec55976e7beb1";

// Apply parameters to the subscription validator (2 params)
const subValidator = plutus.validators.find(v => v.title === "subscription.subscription.spend")!;
const subCode = applyParamsToScript(subValidator.compiledCode, [serverKeyHash, serverKeyHash]);

// Compute the script hash (for deriving the validator address)
function scriptHash(compiledCode: string): string {
  const bytes = hexToBytes(compiledCode);
  const preimage = new Uint8Array(1 + bytes.length);
  preimage[0] = 0x03; // PlutusV3 prefix
  preimage.set(bytes, 1);
  return bytesToHex(blake2b(preimage, { dkLen: 28 }));
}
const subHash = scriptHash(subCode); // use as policy ID or to derive validator address

// Chain: apply subscription hash to beacon validator
const beaconValidator = plutus.validators.find(v => v.title === "beacon.beacon.mint")!;
const beaconCode = applyParamsToScript(beaconValidator.compiledCode, [subHash]);
```

### Encode Plutus Data

```typescript
import { Constr, Data, fromText } from "cmttk";

// Encode
const datum = new Constr(0, [
  42n,                           // Int
  fromText("hello"),             // ByteArray (UTF-8 → hex)
  new Constr(1, []),             // Bool True (Aiken convention)
  [new Constr(0, ["ab", "cd"])], // List of Constr
]);
const cborHex = Data.to(datum);

// Decode
const decoded = Data.from(cborHex);
// decoded is Constr { index: 0, fields: [42n, "68656c6c6f", Constr { index: 1, fields: [] }, ...] }
```

## Migrating from Lucid / MeshJS

Replace `Lucid()` / `MeshTxBuilder` initialization with `getProvider()` + `deriveWallet()`. Replace `lucid.newTx().pay.ToAddress()...complete()...sign()...submit()` chains with a single `buildAndSubmitTransfer()` or `buildAndSubmitScriptTx()` call. Replace `import { Constr, Data } from "@lucid-evolution/lucid"` with `import { Constr, Data } from "cmttk"` — the API is identical. Replace `getAddressDetails(addr).paymentCredential.hash` with `getPaymentKeyHash(addr)`. `applyParamsToScript` is a drop-in replacement for Lucid's — same signature, same behavior. Blockfrost and Koios are both supported through `getProvider("preprod", blockfrostId?, koiosUrl?)` with the same query interface.

## What it does not do

- **Plutus script evaluation / ex-unit calculation.** Execution unit budgets in redeemers are set to generous defaults. The node validates them and rejects if exceeded, but you won't get exact costs. For production, use the Koios or Blockfrost `/ogmios` evaluate endpoint to get precise ex-units before submission.

- **Multi-signature transactions.** Only single Ed25519 signer from a BIP39 mnemonic. Multi-sig, native scripts, and hardware wallet signing are not implemented.

- **Governance.** Conway-era governance actions (DRep registration, voting, proposals) are not supported.

- **Stake pool operations.** Pool registration, delegation, and reward withdrawal transactions are not built.

- **Datum witness sets.** Only inline datums (post-Babbage) are supported. Legacy datum-hash-based outputs are not.

- **Browser CIP-30 wallet integration.** This is a backend toolkit. For browser-side CIP-30 wallet interaction, use the wallet's `signTx` / `submitTx` APIs directly with the CBOR output from the encoder.

- **Automatic UTXO management.** Coin selection uses CIP-2 Random-Improve (with Largest-First fallback), which promotes healthy UTxO distribution. It does not do multi-output balancing or UTxO consolidation.

These are deliberate scope boundaries, not missing features. The toolkit handles the 90% case — query, build, sign, submit — for dApp backends interacting with Plutus validators. If you need governance transactions or hardware wallet support, use a full-featured library.

## API reference

See [API.md](./API.md) for the complete function and type reference.

## Architecture

```
cmttk/src/
  index.ts      barrel export
  cbor.ts       CBOR encoder/decoder (all major types)
  data.ts       Plutus Data: Constr, Data.to/from, fromText, applyParamsToScript
  tx.ts         transaction builder, coin selection, fee calc
  provider.ts   Koios + Blockfrost (native fetch)
  wallet.ts     CIP-1852 key derivation from BIP39 mnemonic
  address.ts    bech32 validation, payment key hash extraction
  time.ts       slot <-> POSIX millisecond conversion
  types.ts      CardanoNetwork, AssetId
```

Dependencies:
- [noble-bip32ed25519](https://github.com/mwaddip/noble-bip32ed25519) — BIP32-Ed25519 key derivation + libsodium shim
- [@noble/curves](https://github.com/paulmillr/noble-curves) — Ed25519 elliptic curve operations
- [@noble/hashes](https://github.com/paulmillr/noble-hashes) — SHA-512, BLAKE2b, HMAC
- [bech32](https://github.com/bitcoinjs/bech32) — Bech32 address encoding
- [bip39](https://github.com/bitcoinjs/bip39) — Mnemonic phrase generation/validation

## Tested on-chain

All operations have been tested on Cardano preprod testnet:

- ADA transfers (simple and with calculated fees)
- Native token transfers
- Plan creation with inline datums
- Reference script deployment (PlutusV3)
- Beacon token minting (with Plutus redeemer)
- Subscription UTXO creation at validator address
- ServiceCollect spending (continuing output with updated datum)
- CIP-68 NFT minting (user + reference tokens)

## Contributing

This is a small, focused library. If it solves your problem, use it. If it's missing something you need, PRs are welcome. If you disagree with a design decision, fork it — the codebase is small enough to own entirely.

Issues and pull requests: [github.com/mwaddip/cmttk](https://github.com/mwaddip/cmttk)

## License

MIT
