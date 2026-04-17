import { test } from "node:test";
import { strictEqual } from "node:assert/strict";
import { bytesToHex, cborUint } from "../src/cbor.js";

test("runner smoke: cborUint(0) encodes to 0x00", () => {
  strictEqual(bytesToHex(cborUint(0n)), "00");
});
