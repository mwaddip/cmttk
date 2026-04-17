import { test, describe } from "node:test";
import { strictEqual, deepStrictEqual, throws } from "node:assert/strict";
import {
  bytesToHex,
  hexToBytes,
  cborUint,
  cborBytes,
  cborArray,
  cborMap,
  cborTag,
  cborHeader,
  decodeCbor,
  parseCborMap,
} from "../src/cbor.js";

// RFC 8949 Appendix A — canonical examples. See https://datatracker.ietf.org/doc/html/rfc8949#appendix-A

describe("cborUint — RFC 8949 integer vectors", () => {
  const cases: Array<[bigint, string]> = [
    [0n, "00"],
    [1n, "01"],
    [10n, "0a"],
    [23n, "17"],
    [24n, "1818"],
    [25n, "1819"],
    [100n, "1864"],
    [1000n, "1903e8"],
    [1_000_000n, "1a000f4240"],
    [1_000_000_000_000n, "1b000000e8d4a51000"],
    [4_294_967_295n, "1affffffff"],         // max 32-bit
    [4_294_967_296n, "1b0000000100000000"], // min 64-bit
  ];
  for (const [value, hex] of cases) {
    test(`${value} → 0x${hex}`, () => {
      strictEqual(bytesToHex(cborUint(value)), hex);
    });
  }
});

describe("cborHeader — negative integers (major 1)", () => {
  // -1 encodes as major 1, arg 0; -n encodes as major 1, arg (n-1).
  const cases: Array<[bigint, string]> = [
    [0n, "20"],    // major 1, arg 0 → -1
    [9n, "29"],    // major 1, arg 9 → -10
    [99n, "3863"], // major 1, arg 99 → -100
  ];
  for (const [arg, hex] of cases) {
    test(`major=1 arg=${arg} → 0x${hex}`, () => {
      strictEqual(bytesToHex(cborHeader(1, arg)), hex);
    });
  }
});

describe("cborBytes", () => {
  test("empty byte string → 0x40", () => {
    strictEqual(bytesToHex(cborBytes(new Uint8Array(0))), "40");
  });
  test("'IETF' (4 bytes) → 0x4449455446", () => {
    strictEqual(bytesToHex(cborBytes("49455446")), "4449455446");
  });
  test("accepts hex string input", () => {
    strictEqual(bytesToHex(cborBytes("01020304")), "4401020304");
  });
  test("24-byte string uses 1+1 header", () => {
    strictEqual(bytesToHex(cborBytes("00".repeat(24))), "5818" + "00".repeat(24));
  });
});

describe("cborArray", () => {
  test("empty → 0x80", () => {
    strictEqual(bytesToHex(cborArray([])), "80");
  });
  test("[1, 2, 3] → 0x83010203", () => {
    strictEqual(
      bytesToHex(cborArray([cborUint(1n), cborUint(2n), cborUint(3n)])),
      "83010203",
    );
  });
});

describe("cborMap", () => {
  test("empty → 0xa0", () => {
    strictEqual(bytesToHex(cborMap([])), "a0");
  });
  test("{1: 2, 3: 4} → 0xa201020304", () => {
    strictEqual(
      bytesToHex(cborMap([
        [cborUint(1n), cborUint(2n)],
        [cborUint(3n), cborUint(4n)],
      ])),
      "a201020304",
    );
  });
});

describe("cborTag", () => {
  test("tag 24 wrapping bytes", () => {
    // tag 24 (0xd818) wrapping cborBytes(hex '01') = 0xd8184101
    strictEqual(bytesToHex(cborTag(24, cborBytes("01"))), "d8184101");
  });
});

describe("decodeCbor round-trips", () => {
  test("uint round-trip", () => {
    const enc = cborUint(1_000_000n);
    const dec = decodeCbor(enc, 0);
    strictEqual(dec.value, 1_000_000n);
    strictEqual(dec.offset, enc.length);
  });
  test("negative int round-trip", () => {
    const enc = cborHeader(1, 99n);
    const dec = decodeCbor(enc, 0);
    strictEqual(dec.value, -100n);
  });
  test("byte string round-trip", () => {
    const enc = cborBytes("deadbeef");
    const dec = decodeCbor(enc, 0);
    deepStrictEqual(dec.value, hexToBytes("deadbeef"));
  });
  test("array round-trip", () => {
    const enc = cborArray([cborUint(1n), cborUint(2n), cborUint(3n)]);
    const dec = decodeCbor(enc, 0);
    deepStrictEqual(dec.value, [1n, 2n, 3n]);
  });
  test("map round-trip", () => {
    const enc = cborMap([
      [cborUint(1n), cborUint(2n)],
      [cborUint(3n), cborUint(4n)],
    ]);
    const dec = decodeCbor(enc, 0);
    const expected = new Map<unknown, unknown>([[1n, 2n], [3n, 4n]]);
    deepStrictEqual(dec.value, expected);
  });
});

describe("parseCborMap", () => {
  test("preserves rawValue bytes for each entry", () => {
    const enc = cborMap([
      [cborUint(0n), cborBytes("aa")],
      [cborUint(5n), cborArray([cborUint(1n), cborUint(2n)])],
    ]);
    const parsed = parseCborMap(enc, 0);
    strictEqual(parsed.entries.length, 2);
    strictEqual(parsed.entries[0]!.key, 0n);
    strictEqual(bytesToHex(parsed.entries[0]!.rawValue), "41aa");
    strictEqual(parsed.entries[1]!.key, 5n);
    strictEqual(bytesToHex(parsed.entries[1]!.rawValue), "82" + "01" + "02");
    strictEqual(parsed.endOffset, enc.length);
  });
  test("throws on non-map input", () => {
    throws(() => parseCborMap(cborUint(42n), 0), /not a CBOR map/);
  });
});
