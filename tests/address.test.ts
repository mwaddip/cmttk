import { test, describe } from "node:test";
import { strictEqual } from "node:assert/strict";
import {
  isValidAddress,
  isValidPolicyId,
  getPaymentKeyHash,
  buildBaseAddress,
  buildEnterpriseAddress,
  normalizeAddress,
} from "../src/address.js";
import { addressToHex } from "../src/tx.js";

// Known preprod/mainnet addresses — deployer preprod, and a mainnet reference.
// These serve as regression fixtures; they're not authoritative CIP-5 vectors,
// but they cover the real address shapes cmttk handles.
const DEPLOYER_PREPROD = "addr_test1qqkmm4qnqn54ujscgmqy2v5dw34lyfn6pfsea32ewmnmavv32enf02z4rss8f9fk5s55t4wrqh6kvdqcxx79zwtkkhtqvugrgs";
// NOTE: the MAINNET_EXAMPLE in the original plan had an invalid bech32 checksum,
// so it was substituted with a synthesized address built from the same known
// hashes used in the buildBaseAddress test below (confirmed valid via bech32.decode).
const MAINNET_EXAMPLE = "addr1qyt0whgfsn49ujscgvqy22psmjxhuf3aq5kr8k9vhw0866atxve6llz4llll865a9cv276j23ljyerdyk0j9xnuudwhslfcyfx";

describe("isValidAddress", () => {
  test("accepts preprod base address", () => {
    strictEqual(isValidAddress(DEPLOYER_PREPROD), true);
  });
  test("accepts mainnet base address", () => {
    strictEqual(isValidAddress(MAINNET_EXAMPLE), true);
  });
  test("rejects malformed checksum", () => {
    const broken = DEPLOYER_PREPROD.slice(0, -1) + "x"; // flip last char
    strictEqual(isValidAddress(broken), false);
  });
  test("rejects wrong HRP", () => {
    strictEqual(isValidAddress("btc1qexampleaddress"), false);
  });
  test("rejects empty string", () => {
    strictEqual(isValidAddress(""), false);
  });
});

describe("isValidPolicyId", () => {
  test("accepts 56-hex-char policy id", () => {
    strictEqual(isValidPolicyId("2dbdd41304e95e4a1846c045328d746bf2267a0a619ec55976e7beb1"), true);
  });
  test("rejects shorter hex", () => {
    strictEqual(isValidPolicyId("2dbdd41304"), false);
  });
  test("rejects non-hex", () => {
    strictEqual(isValidPolicyId("z".repeat(56)), false);
  });
});

describe("getPaymentKeyHash", () => {
  test("base address → 28-byte payment key hash", () => {
    const hash = getPaymentKeyHash(DEPLOYER_PREPROD);
    strictEqual(typeof hash, "string");
    strictEqual(hash!.length, 56); // 28 bytes = 56 hex chars
  });
  test("invalid address returns null", () => {
    strictEqual(getPaymentKeyHash("not an address"), null);
  });
});

describe("buildBaseAddress → addressToHex round-trip", () => {
  test("building a base address from known hashes produces a valid bech32", () => {
    const paymentKeyHash = "16f75d0984ea5e4a184300452830dc8d7e263d052c33d8acbb9e7d6b";
    const stakeKeyHash   = "ab3333affc55fffff3ea9d2e18af6a4a8fe44c8da4b3e4534f9c6baf";
    const addr = buildBaseAddress(paymentKeyHash, stakeKeyHash, "preprod");
    strictEqual(isValidAddress(addr), true);
    // Extracted payment key hash must equal what we put in
    strictEqual(getPaymentKeyHash(addr), paymentKeyHash);
  });
});

describe("buildEnterpriseAddress", () => {
  test("key-based enterprise address", () => {
    const keyHash = "16f75d0984ea5e4a184300452830dc8d7e263d052c33d8acbb9e7d6b";
    const addr = buildEnterpriseAddress(keyHash, "preprod");
    strictEqual(isValidAddress(addr), true);
    strictEqual(getPaymentKeyHash(addr), keyHash);
  });
  test("script-based enterprise address", () => {
    const scriptHash = "2dbdd41304e95e4a1846c045328d746bf2267a0a619ec55976e7beb1";
    const addr = buildEnterpriseAddress(scriptHash, "preprod", true);
    strictEqual(isValidAddress(addr), true);
    // Script addresses have no payment key hash — cmttk returns null
    strictEqual(getPaymentKeyHash(addr), null);
  });
});

describe("normalizeAddress", () => {
  test("lowercases", () => {
    strictEqual(normalizeAddress("ADDR_TEST1ABC"), "addr_test1abc");
  });
});

describe("addressToHex", () => {
  test("decodes a known address to non-empty hex", () => {
    const hex = addressToHex(DEPLOYER_PREPROD);
    // Preprod base address = 57 bytes (1 header + 28 payment hash + 28 stake hash)
    strictEqual(hex.length, 114); // 57 bytes * 2 hex chars
    // First byte's top nibble is 0 (type 0 = base, key-key) on preprod (net id 0)
    strictEqual(hex[0], "0");
  });
});
