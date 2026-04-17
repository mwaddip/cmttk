import { test, describe } from "node:test";
import { strictEqual, rejects } from "node:assert/strict";
import { deriveWallet } from "../src/wallet.js";
import { bytesToHex } from "../src/cbor.js";
import { ed25519 } from "@noble/curves/ed25519";
import { PrivateKey } from "noble-bip32ed25519";
import { TEST_MNEMONIC } from "./helpers/mnemonic.js";

describe("deriveWallet — abandon x23 + art", () => {
  test("preprod derivation is stable", async () => {
    const w = await deriveWallet(TEST_MNEMONIC, "preprod");
    strictEqual(w.network, "preprod");
    strictEqual(w.paymentKeyHash.length, 56);
    strictEqual(w.stakeKeyHash.length, 56);
    strictEqual(w.address.startsWith("addr_test1"), true);
    strictEqual(bytesToHex(w.paymentPubKey).length, 64); // 32 bytes
    strictEqual(w.paymentKey.length, 64); // 64-byte extended key
    // Cross-referenced 2026-04-17 against @emurgo/cardano-serialization-lib-nodejs — matches.
    // Reproduction: install @emurgo/cardano-serialization-lib-nodejs in a scratch dir, call
    // Bip32PrivateKey.from_bip39_entropy(mnemonicToEntropy(TEST_MNEMONIC, wordlist), ""),
    // derive m/1852'/1815'/0'/{0,2}/0, then build a BaseAddress from the two pub-key hashes
    // and compare .to_bech32() to the address below.
    strictEqual(w.paymentKeyHash, "00b7847c89d5721592fc0cc8932f50a8f8258b39b93861140a1b99fb");
    strictEqual(w.stakeKeyHash,   "c2f45a16a6685616e566c00fc081fe59f8bd7ab679ee15e9ce203446");
    strictEqual(w.address,        "addr_test1qqqt0pru382hy9vjlsxv3ye02z50sfvt8xunscg5pgden77z73dpdfng2ctw2ekqplqgrljelz7h4dneac27nn3qx3rqqpavzj");
    strictEqual(bytesToHex(w.paymentPubKey), "63c5d69570349e4233a0575811464f0e8a3fd329abe76e9bdc3d3f1b95982179");
  });

  test("mainnet derivation produces different address", async () => {
    const mainnet = await deriveWallet(TEST_MNEMONIC, "mainnet");
    const preprod = await deriveWallet(TEST_MNEMONIC, "preprod");
    // Same keys, different network byte in address
    strictEqual(mainnet.paymentKeyHash, preprod.paymentKeyHash);
    strictEqual(mainnet.stakeKeyHash,   preprod.stakeKeyHash);
    strictEqual(mainnet.address.startsWith("addr1"), true);
    strictEqual(mainnet.address === preprod.address, false);
  });
});

describe("deriveWallet — signing", () => {
  test("sign-and-verify round-trip against @noble/curves Ed25519", async () => {
    const w = await deriveWallet(TEST_MNEMONIC, "preprod");
    const kL = w.paymentKey.slice(0, 32);
    const kR = w.paymentKey.slice(32, 64);
    const priv = new PrivateKey(kL, kR);
    const message = new Uint8Array(32); // 32 zero bytes (e.g., a body hash)
    const signature = priv.sign(message);
    strictEqual(signature.length, 64);
    const ok = ed25519.verify(signature, message, w.paymentPubKey);
    strictEqual(ok, true);
    // Also verify with a non-trivial message to ensure we're not relying on any
    // zero-input short-circuit behaviour.
    const nonZeroMessage = new Uint8Array(32).fill(0xab);
    const sig2 = priv.sign(nonZeroMessage);
    strictEqual(sig2.length, 64);
    strictEqual(ed25519.verify(sig2, nonZeroMessage, w.paymentPubKey), true);
  });
});

describe("deriveWallet — negative", () => {
  test("wrong word count rejected", async () => {
    await rejects(async () => { await deriveWallet("abandon abandon", "preprod"); });
  });
  test("invalid checksum rejected", async () => {
    // 24 'abandon' words has invalid checksum (correct 24-word is ...abandon art)
    const bad = "abandon ".repeat(24).trim();
    await rejects(async () => { await deriveWallet(bad, "preprod"); });
  });
});
