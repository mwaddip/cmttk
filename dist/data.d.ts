/**
 * Plutus Data encoding/decoding — replaces Lucid's Constr and Data.to/Data.from.
 *
 * Constr tag mapping (CIP-0005 / Plutus):
 *   - Constr 0-6  → CBOR tags 121-127
 *   - Constr 7+   → CBOR tag 102 + [index, fields]
 *
 * Field values are recursively encoded:
 *   - bigint → CBOR int (positive or negative)
 *   - string → CBOR bytes (hex string treated as raw bytes)
 *   - Uint8Array → CBOR bytes
 *   - Constr → recursive Plutus Data
 *   - Array → CBOR list of Plutus Data items
 */
/** Plutus Data constructor — matches Lucid's Constr API. */
export declare class Constr<T = PlutusField> {
    readonly index: number;
    readonly fields: T[];
    constructor(index: number, fields: T[]);
}
/** Allowed field types in Plutus Data. */
export type PlutusField = bigint | number | string | Uint8Array | Constr<PlutusField> | PlutusField[] | Map<PlutusField, PlutusField>;
export declare const Data: {
    /** Encode a Plutus Data value (Constr, bigint, hex string, etc.) to CBOR hex. */
    to(value: PlutusField): string;
    /** Decode CBOR hex back to Plutus Data. */
    from(cborHex: string): PlutusField;
};
/** Convert a UTF-8 string to hex — replaces Lucid's fromText(). */
export declare function fromText(text: string): string;
//# sourceMappingURL=data.d.ts.map