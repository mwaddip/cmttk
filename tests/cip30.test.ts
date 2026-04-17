import { test, describe } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert/strict";
import {
  cborArray, cborBytes, cborMap, cborUint, bytesToHex, hexToBytes, decodeCbor,
} from "../src/cbor.js";
import {
  parseCip30Utxos,
  mergeCip30Witness,
  type UnsignedScriptTx,
} from "../src/tx.js";

// Synthetic fixture helpers — we build CBOR with cmttk's own encoder since that
// lets us assert parseCip30Utxos handles all four output shapes deterministically.
// (For cross-wallet captures, add real Eternl/Nami CBORs as a follow-up.)

function makeInput(txHashHex: string, index: number): Uint8Array {
  return cborArray([cborBytes(txHashHex), cborUint(BigInt(index))]);
}

function makePreBabbageOutputAdaOnly(addrHex: string, lovelace: bigint): Uint8Array {
  // [address, value] where value is bare uint
  return cborArray([cborBytes(addrHex), cborUint(lovelace)]);
}

function makePreBabbageOutputMultiAsset(
  addrHex: string, lovelace: bigint, tokens: Array<[string, string, bigint]>,
): Uint8Array {
  const byPolicy = new Map<string, Array<[string, bigint]>>();
  for (const [pid, name, qty] of tokens) {
    const list = byPolicy.get(pid) ?? [];
    list.push([name, qty]);
    byPolicy.set(pid, list);
  }
  const policyEntries: Array<[Uint8Array, Uint8Array]> = [];
  for (const [pid, assets] of byPolicy) {
    const assetEntries: Array<[Uint8Array, Uint8Array]> = assets.map(([name, qty]) => [
      cborBytes(name), cborUint(qty),
    ]);
    policyEntries.push([cborBytes(pid), cborMap(assetEntries)]);
  }
  const multiAsset = cborMap(policyEntries);
  const value = cborArray([cborUint(lovelace), multiAsset]);
  return cborArray([cborBytes(addrHex), value]);
}

function makePostBabbageOutput(
  addrHex: string, lovelace: bigint, tokens?: Array<[string, string, bigint]>,
): Uint8Array {
  const entries: Array<[Uint8Array, Uint8Array]> = [
    [cborUint(0n), cborBytes(addrHex)],
  ];
  if (tokens && tokens.length > 0) {
    const byPolicy = new Map<string, Array<[string, bigint]>>();
    for (const [pid, name, qty] of tokens) {
      const list = byPolicy.get(pid) ?? [];
      list.push([name, qty]);
      byPolicy.set(pid, list);
    }
    const policyEntries: Array<[Uint8Array, Uint8Array]> = [];
    for (const [pid, assets] of byPolicy) {
      const assetEntries: Array<[Uint8Array, Uint8Array]> = assets.map(([name, qty]) => [
        cborBytes(name), cborUint(qty),
      ]);
      policyEntries.push([cborBytes(pid), cborMap(assetEntries)]);
    }
    entries.push([cborUint(1n), cborArray([cborUint(lovelace), cborMap(policyEntries)])]);
  } else {
    entries.push([cborUint(1n), cborUint(lovelace)]);
  }
  return cborMap(entries);
}

const TXH = "a".repeat(64);
const ADDR = "00" + "11".repeat(28) + "22".repeat(28); // 1 header + payment + stake
const PID = "b".repeat(56);
const NAME = "4e4654"; // "NFT" in hex

describe("parseCip30Utxos", () => {
  test("ADA-only pre-Babbage output", () => {
    const entry = cborArray([makeInput(TXH, 0), makePreBabbageOutputAdaOnly(ADDR, 5_000_000n)]);
    const utxos = parseCip30Utxos([bytesToHex(entry)]);
    strictEqual(utxos.length, 1);
    strictEqual(utxos[0]!.txHash, TXH);
    strictEqual(utxos[0]!.index, 0);
    strictEqual(utxos[0]!.lovelace, 5_000_000n);
    deepStrictEqual(utxos[0]!.tokens, {});
  });

  test("ADA + token pre-Babbage output", () => {
    const entry = cborArray([
      makeInput(TXH, 1),
      makePreBabbageOutputMultiAsset(ADDR, 2_000_000n, [[PID, NAME, 1n]]),
    ]);
    const utxos = parseCip30Utxos([bytesToHex(entry)]);
    strictEqual(utxos[0]!.lovelace, 2_000_000n);
    strictEqual(utxos[0]!.tokens[PID + NAME], 1n);
  });

  test("ADA-only post-Babbage map output", () => {
    const entry = cborArray([makeInput(TXH, 2), makePostBabbageOutput(ADDR, 3_000_000n)]);
    const utxos = parseCip30Utxos([bytesToHex(entry)]);
    strictEqual(utxos[0]!.lovelace, 3_000_000n);
    deepStrictEqual(utxos[0]!.tokens, {});
  });

  test("ADA + token post-Babbage map output", () => {
    const entry = cborArray([
      makeInput(TXH, 3),
      makePostBabbageOutput(ADDR, 4_000_000n, [[PID, NAME, 42n]]),
    ]);
    const utxos = parseCip30Utxos([bytesToHex(entry)]);
    strictEqual(utxos[0]!.lovelace, 4_000_000n);
    strictEqual(utxos[0]!.tokens[PID + NAME], 42n);
  });

  test("mixed batch", () => {
    const e1 = cborArray([makeInput(TXH, 0), makePreBabbageOutputAdaOnly(ADDR, 1_000_000n)]);
    const e2 = cborArray([makeInput(TXH, 1), makePostBabbageOutput(ADDR, 2_000_000n)]);
    const utxos = parseCip30Utxos([bytesToHex(e1), bytesToHex(e2)]);
    strictEqual(utxos.length, 2);
    strictEqual(utxos[0]!.lovelace, 1_000_000n);
    strictEqual(utxos[1]!.lovelace, 2_000_000n);
  });
});

describe("mergeCip30Witness", () => {
  // Hand-build a partial witness set (just fields 5 and 7) that matches what
  // buildUnsignedScriptTx would emit — sufficient to test the merge logic
  // without needing a full tx construction round.
  function makePartialWitness(): UnsignedScriptTx {
    const redeemers = cborMap([]); // empty map
    const scripts = cborArray([]); // empty array
    const witnessSet = cborMap([
      [cborUint(5n), redeemers],
      [cborUint(7n), scripts],
    ]);
    // txBodyCbor can be any bytes for this test — merge doesn't touch it except
    // to put into the final tx array. Use a minimal placeholder.
    const txBodyCbor = cborMap([[cborUint(2n), cborUint(100n)]]); // body with just a fee
    return {
      txBodyCbor,
      witnessSet,
      redeemersCbor: redeemers,
      plutusV3Scripts: scripts,
      scriptDataHash: new Uint8Array(0),
      fee: 100n,
    };
  }

  function makeWalletWitness(fields: Array<[bigint, Uint8Array]>): string {
    const entries: Array<[Uint8Array, Uint8Array]> = fields.map(([k, v]) => [cborUint(k), v]);
    return bytesToHex(cborMap(entries));
  }

  test("merges field 0 (vkey_witnesses) with partial fields 5, 7", () => {
    const unsigned = makePartialWitness();
    const pub = new Uint8Array(32).fill(0xaa);
    const sig = new Uint8Array(64).fill(0xbb);
    const vkeyWit = cborArray([cborBytes(pub), cborBytes(sig)]);
    const walletWitnessHex = makeWalletWitness([[0n, cborArray([vkeyWit])]]);

    const signedTxHex = mergeCip30Witness(unsigned, walletWitnessHex);
    const signedTxBytes = hexToBytes(signedTxHex);

    // Outer shape: [body, witnessSet, true, null]
    strictEqual(signedTxBytes[0], 0x84);
    const decoded = decodeCbor(signedTxBytes, 0);
    if (!Array.isArray(decoded.value)) throw new Error("expected array");
    strictEqual(decoded.value.length, 4);

    const witnessSet = decoded.value[1];
    if (!(witnessSet instanceof Map)) throw new Error("expected map witness set");
    // Must contain fields 0 (from wallet), 5 and 7 (from partial)
    strictEqual(witnessSet.has(0n), true);
    strictEqual(witnessSet.has(5n), true);
    strictEqual(witnessSet.has(7n), true);
  });

  test("merges multi-field wallet witness (fields 0 + 1)", () => {
    const unsigned = makePartialWitness();
    const pub = new Uint8Array(32).fill(0xcc);
    const sig = new Uint8Array(64).fill(0xdd);
    const vkeyWit = cborArray([cborBytes(pub), cborBytes(sig)]);
    const nativeScripts = cborArray([]);
    const walletWitnessHex = makeWalletWitness([
      [0n, cborArray([vkeyWit])],
      [1n, nativeScripts],
    ]);

    const signedTxHex = mergeCip30Witness(unsigned, walletWitnessHex);
    const decoded = decodeCbor(hexToBytes(signedTxHex), 0);
    if (!Array.isArray(decoded.value)) throw new Error("expected array");
    const witnessSet = decoded.value[1];
    if (!(witnessSet instanceof Map)) throw new Error("expected map witness set");
    strictEqual(witnessSet.has(0n), true);
    strictEqual(witnessSet.has(1n), true);
    strictEqual(witnessSet.has(5n), true);
    strictEqual(witnessSet.has(7n), true);
  });

  test("wallet entries win on key collision", () => {
    const unsigned = makePartialWitness();
    // Partial already has field 5 (empty map). Wallet also sends field 5 with a
    // different value — wallet should override.
    const walletField5 = cborMap([[cborUint(0n), cborBytes("aa")]]); // non-empty map
    const walletWitnessHex = makeWalletWitness([[5n, walletField5]]);

    const signedTxHex = mergeCip30Witness(unsigned, walletWitnessHex);
    const decoded = decodeCbor(hexToBytes(signedTxHex), 0);
    if (!Array.isArray(decoded.value)) throw new Error("expected array");
    const witnessSet = decoded.value[1];
    if (!(witnessSet instanceof Map)) throw new Error("expected map witness set");
    const field5 = witnessSet.get(5n);
    if (!(field5 instanceof Map)) throw new Error("expected field 5 to be a map");
    strictEqual(field5.size, 1); // wallet's non-empty map, not partial's empty
  });
});
