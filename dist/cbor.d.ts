/**
 * Minimal CBOR encoder/decoder for Cardano transactions.
 * Extracted from signup-engine.js — production-tested.
 */
export declare function hexToBytes(hex: string): Uint8Array;
export declare function bytesToHex(bytes: Uint8Array): string;
export declare function concatBytes(arrays: Uint8Array[]): Uint8Array;
/** Encode a CBOR header (major type + argument). */
export declare function cborHeader(major: number, n: number | bigint): Uint8Array;
/** Unsigned integer (major 0). */
export declare function cborUint(n: number | bigint): Uint8Array;
/** Byte string (major 2), definite-length. */
export declare function cborBytes(data: Uint8Array | string): Uint8Array;
/** Array (major 4). Items must already be encoded. */
export declare function cborArray(items: Uint8Array[]): Uint8Array;
/** Map (major 5). Entries are [key, value] pairs, already encoded. */
export declare function cborMap(entries: [Uint8Array, Uint8Array][]): Uint8Array;
/** Tag (major 6). */
export declare function cborTag(tagNum: number, content: Uint8Array): Uint8Array;
export type CborValue = bigint | boolean | null | undefined | string | number | Uint8Array | CborValue[] | Map<CborValue, CborValue>;
export interface CborDecoded {
    value: CborValue;
    offset: number;
}
/** Decode a single CBOR item starting at `pos`. */
export declare function decodeCbor(bytes: Uint8Array, pos: number): CborDecoded;
//# sourceMappingURL=cbor.d.ts.map