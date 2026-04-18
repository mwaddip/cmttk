import { test, describe } from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert/strict";
import {
  hexToBytes,
  cborUint,
  cborBytes,
  cborArray,
  cborMap,
} from "../src/cbor.js";
import {
  buildOutputCbor,
  addressToHex,
  calculateFee,
  parseKoiosUtxos,
  selectUtxos,
  type Utxo,
} from "../src/tx.js";

const DEPLOYER = "addr_test1qqkmm4qnqn54ujscgmqy2v5dw34lyfn6pfsea32ewmnmavv32enf02z4rss8f9fk5s55t4wrqh6kvdqcxx79zwtkkhtqvugrgs";

describe("buildOutputCbor", () => {
  test("ADA-only output: map {0: addr, 1: lovelace}", () => {
    const addrHex = addressToHex(DEPLOYER);
    const out = buildOutputCbor(addrHex, 2_000_000n);
    // Map with 2 entries → 0xa2, keys 00, 01, etc.
    strictEqual(out[0], 0xa2);
    // Manually reconstruct:
    const expected = cborMap([
      [cborUint(0n), cborBytes(hexToBytes(addrHex))],
      [cborUint(1n), cborUint(2_000_000n)],
    ]);
    deepStrictEqual(out, expected);
  });

  test("ADA + token output: value is [lovelace, multiasset]", () => {
    const addrHex = addressToHex(DEPLOYER);
    const pid = "b".repeat(56);
    const name = "4e4654";
    const out = buildOutputCbor(addrHex, 2_000_000n, [[pid + name, 1n]]);
    // Decode back and verify shape
    strictEqual(out[0], 0xa2);
    // Manually build the expected
    const expected = cborMap([
      [cborUint(0n), cborBytes(hexToBytes(addrHex))],
      [cborUint(1n), cborArray([
        cborUint(2_000_000n),
        cborMap([[cborBytes(pid), cborMap([[cborBytes(name), cborUint(1n)]])]]),
      ])],
    ]);
    deepStrictEqual(out, expected);
  });
});

describe("parseKoiosUtxos", () => {
  test("parses typical Koios /address_utxos entry", () => {
    const raw = [{
      tx_hash: "a".repeat(64),
      tx_index: 0,
      value: "5000000",
      asset_list: [
        { policy_id: "b".repeat(56), asset_name: "4e4654", quantity: "1" },
      ],
    }];
    const utxos = parseKoiosUtxos(raw);
    strictEqual(utxos.length, 1);
    strictEqual(utxos[0]!.lovelace, 5_000_000n);
    strictEqual(utxos[0]!.tokens["b".repeat(56) + "4e4654"], 1n);
  });

  test("handles missing asset_list as no tokens", () => {
    const raw = [{ tx_hash: "a".repeat(64), tx_index: 0, value: "1000000" }];
    const utxos = parseKoiosUtxos(raw);
    deepStrictEqual(utxos[0]!.tokens, {});
  });
});

describe("calculateFee", () => {
  test("simple tx: minFeeA * size + minFeeB", () => {
    const fee = calculateFee(200, {
      minFeeA: 44, minFeeB: 155381, coinsPerUtxoByte: 4310,
      priceMem: 0.0577, priceStep: 0.0000721,
    });
    strictEqual(fee, 164181n); // 44*200 + 155381
  });

  test("script tx adds ex-units cost (ceil)", () => {
    const fee = calculateFee(500, {
      minFeeA: 44, minFeeB: 155381, coinsPerUtxoByte: 4310,
      priceMem: 0.0577, priceStep: 0.0000721,
    }, { mem: 1_000_000n, steps: 100_000_000n });
    // 44*500 + 155381 + ceil(0.0577 * 1_000_000) + ceil(0.0000721 * 100_000_000)
    // = 22000 + 155381 + 57700 + 7210 = 242291
    strictEqual(fee, 242291n);
  });
});

describe("selectUtxos — deterministic cases", () => {
  // Cases where the result doesn't depend on shuffle order.
  test("exact match: single UTxO that exactly covers the requirement", () => {
    const utxos: Utxo[] = [
      { txHash: "a".repeat(64), index: 0, lovelace: 5_000_000n, tokens: {} },
    ];
    const { selected, inputTotal } = selectUtxos(utxos, { lovelace: 5_000_000n });
    strictEqual(selected.length, 1);
    strictEqual(inputTotal.lovelace, 5_000_000n);
  });

  test("insufficient funds throws", () => {
    const utxos: Utxo[] = [
      { txHash: "a".repeat(64), index: 0, lovelace: 1_000_000n, tokens: {} },
    ];
    // Need more than available — Random-Improve retries, then Largest-First also fails
    let threw = false;
    try {
      selectUtxos(utxos, { lovelace: 10_000_000n });
    } catch (e) {
      threw = true;
      strictEqual(/Insufficient funds/.test(String(e)), true);
    }
    strictEqual(threw, true);
  });

  test("all UTxOs required when sum just covers", () => {
    const utxos: Utxo[] = [
      { txHash: "a".repeat(64), index: 0, lovelace: 3_000_000n, tokens: {} },
      { txHash: "a".repeat(64), index: 1, lovelace: 3_000_000n, tokens: {} },
    ];
    // Need 5.5 ADA; either UTxO alone is insufficient, both together sufficient.
    // But Random-Improve's Phase 1 might pick a subset that covers the need.
    // Since each is 3M and we need 5.5M, picking 1 UTxO (3M) is not enough;
    // selection MUST pick both to cover.
    const { selected, inputTotal } = selectUtxos(utxos, { lovelace: 5_500_000n });
    strictEqual(selected.length, 2);
    strictEqual(inputTotal.lovelace, 6_000_000n);
  });
});

import { buildAndSubmitTransfer } from "../src/tx.js";
import { resetProvider } from "../src/provider.js";
import { deriveWallet } from "../src/wallet.js";
import { stubProvider } from "./helpers/stub-provider.js";
import { TEST_MNEMONIC } from "./helpers/mnemonic.js";

describe("buildAndSubmitTransfer — self-regression", () => {
  test("given fixed UTxOs, pp, tip, and Math.random=0, produces deterministic tx", async () => {
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      resetProvider(); // cmttk's getProvider caches; ensure a fresh one isn't used
      // Use deriveWallet to get a valid CIP-1852 key — PrivateKey from
      // noble-bip32ed25519 rejects arbitrary byte patterns for kL.
      const wallet = await deriveWallet(TEST_MNEMONIC, "preprod");
      const provider = stubProvider({
        utxos: [
          { tx_hash: "a".repeat(64), tx_index: 0, value: "10000000", asset_list: [] },
        ],
        pp: {
          minFeeA: 44, minFeeB: 155381, coinsPerUtxoByte: 4310,
          priceMem: 0.0577, priceStep: 0.0000721,
        },
        tip: { slot: 50_000_000, block: 1_000_000, time: Date.now() },
      });

      const txHash = await buildAndSubmitTransfer({
        provider,
        fromAddress: wallet.address,
        toAddress: wallet.address, // self-send — simplest case
        assets: { lovelace: 2_000_000n },
        signingKey: wallet.paymentKey,
      });

      // buildAndSubmitTransfer returns the provider.submitTx response
      strictEqual(txHash, "stub_tx_hash");
      // The stubProvider captured the submitted CBOR hex — freeze it as golden
      const submittedHex = (provider as unknown as { submitLog: string[] }).submitLog[0]!;
      strictEqual(typeof submittedHex, "string");
      strictEqual(submittedHex.length > 0, true);
      // Golden frozen from first deterministic run.
      strictEqual(submittedHex, "84a400d9010281825820aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000182a20058390000b7847c89d5721592fc0cc8932f50a8f8258b39b93861140a1b99fbc2f45a16a6685616e566c00fc081fe59f8bd7ab679ee15e9ce203446011a001e8480a20058390000b7847c89d5721592fc0cc8932f50a8f8258b39b93861140a1b99fbc2f45a16a6685616e566c00fc081fe59f8bd7ab679ee15e9ce203446011a007270e0021a0007a120031a02faf404a1008182582063c5d69570349e4233a0575811464f0e8a3fd329abe76e9bdc3d3f1b959821795840495ee752e743ec938f79351f78f4155e2a45fca4a667eef895c4913c88a7eb59ed1102353a33315e4f6dbc09be606db78bb47e929ca8be96bc5f6bd49fd95206f5f6");
    } finally {
      Math.random = origRandom;
    }
  });
});
