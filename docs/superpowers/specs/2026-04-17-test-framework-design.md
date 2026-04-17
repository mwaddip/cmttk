# Test framework for cmttk

**Date:** 2026-04-17
**Status:** Approved design, awaiting spec review
**Version impact:** 1.2.0 — additive only (new devDep, new npm script, no public API change)

## Motivation

cmttk is a ~1500-line pure-TypeScript Cardano toolkit whose value comes from replacing
~200 MB of WASM/Rust crypto with hand-ported TypeScript. It currently has no tests. A
cryptographic library without tests is a liability: subtle correctness drift between
cmttk and the upstream references it was extracted from (noble-bip32ed25519, @noble/hashes,
MeshJS, Lucid Evolution, CML, bech32) can only be caught with vectorised assertions, not
"it compiled" or "a preprod tx went through".

This spec adds a ports-and-vectors suite: port the canonical test vectors upstream libraries
ship, rewrite their assertions to cmttk's API, and add a handful of golden-tx fixtures
captured from the deployer wallet's preprod history.

## Non-goals

- No live-network integration (Koios/Blockfrost/node). Provider behaviour out of scope.
- No property-based / fuzz testing. Fixed-input round-trips are enough.
- No coverage target. We chase correctness vectors, not lines.
- No mainnet fixtures. CBOR determinism is network-agnostic; network-id differences are
  already covered by per-network assertions in `time.test.ts` / `address.test.ts`.

## Framework & layout

- **Runner:** `node:test` driven by `tsx --test`. `.ts` runs directly — zero compile in the
  test path, matches cmttk's "no heavy deps" ethos.
- **DevDep added:** `tsx` only. Assertions come from `node:assert/strict`.
- **Location:** `tests/` at repo root, excluded from the npm tarball by the existing
  `files: ["dist", "src", "LICENSE"]` allowlist. One file per src module:
  - `tests/wallet.test.ts`
  - `tests/data.test.ts`
  - `tests/cbor.test.ts`
  - `tests/address.test.ts`
  - `tests/time.test.ts`
  - `tests/tx.test.ts`
  - `tests/cip30.test.ts`
- **Fixtures:** `tests/fixtures/` — JSON files with captured CBOR / hex vectors / tx goldens.
- **Scripts:**
  - `"test": "tsx --test tests/**/*.test.ts"`
  - `"prepublishOnly"` extended to `"npm test && npm run build"`.
- **CI:** none in this PR. Dev discipline for now; a follow-up can add a GitHub Action.

## Test matrix

### `wallet.test.ts`
- CIP-1852 derivation vectors from noble-bip32ed25519's suite and the Cardano Foundation
  `cardano-wallet` reference tests: a known mnemonic derives the expected root xprv, payment
  key hash, stake key hash, and base address on all three networks.
- Round-trip: derive payment key → sign a known 32-byte body hash → verify signature with
  `@noble/curves` Ed25519 `verify` against the derived public key.
- Negative: invalid mnemonic (wrong word count, invalid word) throws.

### `data.test.ts`
- `Constr` index ↔ CBOR-tag mapping for 0–6 (tags 121–127) and 7+ (tag 102 + `[index, fields]`).
- `fromText` for ASCII and multi-byte UTF-8, cross-checked against manual hex.
- `Data.to` / `Data.from` round-trip on: bare bigint, hex string, `Uint8Array`, nested
  `Constr`, list of `Constr`, `Map<ByteArray, bigint>`. Golden hex from Lucid Evolution's
  Data tests where applicable.
- `applyParamsToScript` against Aiken `blueprint apply` goldens for two validators (one with
  one param, one with two). Uses a checked-in `plutus.json` fixture.

### `cbor.test.ts`
- RFC 8949 Appendix A examples: unsigned ints, negative ints, byte strings, text strings,
  arrays, maps, tags. Each encoded bytewise-compared to the RFC hex, then decoded value-compared.
- `parseCborMap` on maps with uint, bytestring, and text keys. `rawValue` slice re-decodes
  to the expected value via `decodeCbor`.
- Boundary: `cborUint` over the 24 / 256 / 65536 / 4 294 967 296 thresholds (1/2/3/5/9-byte).

### `address.test.ts`
- CIP-5 worked examples: payment key hash + stake key hash reproduce the given base address
  bech32 on preprod/preview/mainnet.
- `isValidAddress` accepts all CIP-5 examples, rejects malformed checksums.
- `getPaymentKeyHash`: base address → hash, enterprise address → hash, script address → null,
  stake address → null.
- `buildBaseAddress`/`buildEnterpriseAddress` round-trip against `addressToHex`.

### `time.test.ts`
- `posixToSlot(slotToPosix(n)) === n` for sampled `n` on each network.
- Shelley-genesis sanity: `slotToPosix(0, net)` equals the documented genesis constants.

### `tx.test.ts`
**Golden preprod fixtures — the centrepiece of the suite.**

- 4 txs captured from the deployer wallet (`addr_test1qqkmm4qn…tkkhtqvugrgs`): one plain
  transfer (`send`), one script mint (`mint_nft`), one script output with inline datum
  (`plan`), one script spend (`withdraw`).
- Each fixture `tests/fixtures/preprod-txs/<hash>.json` contains:
  - `inputs`: array of `{txHash, index, lovelace, tokens}` (consumed UTxOs at that epoch)
  - `pp`: protocol params at that epoch (`minFeeA`, `minFeeB`, `coinsPerUtxoByte`, `priceMem`,
    `priceStep`, `costModelV3`)
  - `call`: reconstructed args for `buildAndSubmitTransfer` / `buildAndSubmitScriptTx`
  - `expectedBodyHex`: the tx body CBOR, extracted as element 0 of the outer
    `[body, witnessSet, isValid, auxData]` array returned by Koios `tx_cbor`.
- Test wires a stub `CardanoProvider` returning the fixture's `pp` and the fixture's `inputs`
  for `fetchUtxos(walletAddress)`. Test asserts cmttk builds a byte-equal body. Witness set
  excluded from comparison (signature non-deterministic without the deployer's key).

**Encoder-parity test** (separate concern from builder correctness):
- Hand-construct a tx body map field by field (synthetic, not from a real tx), bytewise-compare
  cmttk's output to a fixed golden hex taken from the Cardano ledger spec's CDDL conformance
  vectors (or CML's `tests/serialization.rs`).

### `cip30.test.ts`
- `parseCip30Utxos`: 4 fixture CBOR hex strings — ADA-only pre-Babbage, ADA+token pre-Babbage,
  ADA-only post-Babbage map, ADA+token post-Babbage map. Asserts `Utxo` structure matches.
- `mergeCip30Witness` (single-field wallet witness): build a partial via `buildUnsignedScriptTx`
  against a fixture tx, synthesise `{0: [[pub, sig]]}`, merge, decode, assert fields 0/5/7
  present and correct.
- `mergeCip30Witness` (multi-field wallet witness): include field 1 (native_scripts), confirm
  it merges alongside 5/7.

## Fixture capture workflow

A one-time helper, `tests/fixtures/capture-preprod-tx.ts`:

- Input: tx hash + the `call` args used to build it (pulled manually from
  `blockhost-engine-cardano` source).
- Queries Koios for: the tx's consumed inputs with values (`tx_info`), protocol params for
  the epoch of that tx's block (`epoch_params`), and the raw tx CBOR (`tx_cbor`).
- Writes the `<hash>.json` fixture.

Run manually, once per fixture, committed as static files. Fixtures are regenerated only when
builder behaviour is intentionally changed — at which point the byte-mismatch is exactly the
correctness signal we want to surface.

## Risks & mitigations

- **Koios preprod pruning.** Capture fixtures soon after this lands. Koios has retained
  preprod history years-long in practice.
- **Aiken blueprint-apply format churn.** Commit the exact `plutus.json` used and regenerate
  only on intentional Aiken upgrade.
- **Lucid indefinite-length arrays vs cmttk definite.** Cross-library byte goldens only from
  sources that match cmttk's definite-length convention (ledger spec / Aiken / hand-constructed).
  Lucid comparisons are semantic via `Data.from` round-trip, never bytewise.

## Verification

- `npm test` passes.
- `npm pack --dry-run` output contains no `tests/` or `tests/fixtures/` paths.
- `tsc --noEmit` clean.

## Follow-ups (explicit out-of-scope)

- CIP-30 browser demo page — doubles as a real-wallet fixture source for `cip30.test.ts`.
- GitHub Actions CI running `npm test` on PR.
- Property-based testing with `fast-check` for encoder round-trips.
- Benchmark suite (cmttk encoder vs `@harmoniclabs/cbor`, signer vs libsodium).
