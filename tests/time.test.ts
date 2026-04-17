import { test, describe } from "node:test";
import { strictEqual } from "node:assert/strict";
import { posixToSlot, slotToPosix } from "../src/time.js";

const GENESIS: Record<"preprod" | "preview" | "mainnet", number> = {
  preprod: 1655683200000,
  preview: 1666656000000,
  mainnet: 1591566291000,
};

describe("Shelley genesis constants", () => {
  for (const net of Object.keys(GENESIS) as Array<keyof typeof GENESIS>) {
    test(`${net} slot 0 maps to documented genesis ms`, () => {
      strictEqual(slotToPosix(0, net), GENESIS[net]);
    });
    test(`${net} genesis ms maps back to slot 0`, () => {
      strictEqual(posixToSlot(GENESIS[net], net), 0);
    });
  }
});

describe("slot ↔ posix round-trip", () => {
  const samples = [1, 1000, 100_000, 10_000_000];
  for (const net of Object.keys(GENESIS) as Array<keyof typeof GENESIS>) {
    for (const slot of samples) {
      test(`${net} slot ${slot} round-trips`, () => {
        strictEqual(posixToSlot(slotToPosix(slot, net), net), slot);
      });
    }
  }
});

describe("sub-second ms truncates (1 s slots)", () => {
  test("slot N posix + 999 ms still maps to slot N", () => {
    const base = slotToPosix(12345, "preprod");
    strictEqual(posixToSlot(base + 999, "preprod"), 12345);
  });
  test("slot N posix + 1000 ms maps to slot N+1", () => {
    const base = slotToPosix(12345, "preprod");
    strictEqual(posixToSlot(base + 1000, "preprod"), 12346);
  });
});
