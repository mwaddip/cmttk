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
import { cborHeader, cborUint, cborBytes, cborArray, cborMap, cborTag, decodeCbor, hexToBytes, bytesToHex, } from "./cbor.js";
// ── Constr ──────────────────────────────────────────────────────────────────
/** Plutus Data constructor — matches Lucid's Constr API. */
export class Constr {
    index;
    fields;
    constructor(index, fields) {
        this.index = index;
        this.fields = fields;
    }
}
// ── Encode ──────────────────────────────────────────────────────────────────
/** Encode a Plutus Data value to CBOR bytes. */
function encodeField(field) {
    if (field instanceof Constr) {
        return encodeConstr(field);
    }
    if (field instanceof Uint8Array) {
        return cborBytes(field);
    }
    if (Array.isArray(field)) {
        return cborArray(field.map(encodeField));
    }
    if (field instanceof Map) {
        const entries = [];
        for (const [k, v] of field) {
            entries.push([encodeField(k), encodeField(v)]);
        }
        return cborMap(entries);
    }
    if (typeof field === "bigint") {
        if (field >= 0n)
            return cborUint(field);
        // Negative: CBOR major 1, value = -1 - n
        return cborHeader(1, -field - 1n);
    }
    if (typeof field === "number") {
        return encodeField(BigInt(field));
    }
    if (typeof field === "string") {
        // Hex string → bytes
        return cborBytes(hexToBytes(field));
    }
    throw new Error(`Unsupported Plutus Data field type: ${typeof field}`);
}
/** Encode a Constr to CBOR with the correct tag. */
function encodeConstr(constr) {
    const fieldsCbor = cborArray(constr.fields.map(encodeField));
    if (constr.index >= 0 && constr.index <= 6) {
        // Tags 121-127
        return cborTag(121 + constr.index, fieldsCbor);
    }
    // Tag 102 + [index, fields]
    return cborTag(102, cborArray([cborUint(BigInt(constr.index)), fieldsCbor]));
}
// ── Decode ──────────────────────────────────────────────────────────────────
/** Read CBOR argument value at pos (after initial byte). Returns [argVal, newPos]. */
function readCborArg(bytes, pos, additional) {
    if (additional < 24)
        return [BigInt(additional), pos];
    if (additional === 24)
        return [BigInt(bytes[pos]), pos + 1];
    if (additional === 25) {
        return [BigInt((bytes[pos] << 8) | bytes[pos + 1]), pos + 2];
    }
    if (additional === 26) {
        return [BigInt(((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0), pos + 4];
    }
    if (additional === 27) {
        let v = 0n;
        for (let i = 0; i < 8; i++)
            v = (v << 8n) | BigInt(bytes[pos + i]);
        return [v, pos + 8];
    }
    if (additional === 31)
        return [-1n, pos]; // indefinite
    throw new Error("CBOR: unsupported additional " + additional);
}
/**
 * Decode a CBOR Plutus Data value. Fully recursive — preserves Constr tags
 * through nested arrays, maps, etc. Does NOT delegate to the generic decodeCbor.
 */
function decodeField(bytes, pos) {
    const initial = bytes[pos];
    const major = initial >> 5;
    const additional = initial & 0x1f;
    pos++;
    const [argVal, argEnd] = readCborArg(bytes, pos, additional);
    pos = argEnd;
    switch (major) {
        case 0: // unsigned int
            return { value: argVal, offset: pos };
        case 1: // negative int
            return { value: -1n - argVal, offset: pos };
        case 2: { // byte string → hex
            const len = Number(argVal);
            const val = bytesToHex(bytes.slice(pos, pos + len));
            return { value: val, offset: pos + len };
        }
        case 3: { // text string
            const len = Number(argVal);
            const val = new TextDecoder().decode(bytes.slice(pos, pos + len));
            return { value: val, offset: pos + len };
        }
        case 4: { // array — decode children with decodeField (preserves Constr)
            const arr = [];
            if (argVal < 0n) {
                while (bytes[pos] !== 0xff) {
                    const item = decodeField(bytes, pos);
                    arr.push(item.value);
                    pos = item.offset;
                }
                pos++; // skip break
            }
            else {
                for (let i = 0; i < Number(argVal); i++) {
                    const item = decodeField(bytes, pos);
                    arr.push(item.value);
                    pos = item.offset;
                }
            }
            return { value: arr, offset: pos };
        }
        case 5: { // map
            const map = new Map();
            if (argVal < 0n) {
                while (bytes[pos] !== 0xff) {
                    const k = decodeField(bytes, pos);
                    const v = decodeField(bytes, k.offset);
                    map.set(k.value, v.value);
                    pos = v.offset;
                }
                pos++;
            }
            else {
                for (let i = 0; i < Number(argVal); i++) {
                    const k = decodeField(bytes, pos);
                    const v = decodeField(bytes, k.offset);
                    map.set(k.value, v.value);
                    pos = v.offset;
                }
            }
            return { value: map, offset: pos };
        }
        case 6: { // tag — Constr encoding
            if (argVal >= 121n && argVal <= 127n) {
                // Constr 0-6: tag content is the fields array
                const inner = decodeField(bytes, pos);
                const fields = inner.value;
                return { value: new Constr(Number(argVal) - 121, fields), offset: inner.offset };
            }
            if (argVal === 102n) {
                // Constr 7+: content is [index, fields]
                const inner = decodeField(bytes, pos);
                const arr = inner.value;
                const index = Number(arr[0]);
                const fields = arr[1];
                return { value: new Constr(index, fields), offset: inner.offset };
            }
            // Unknown tag — decode content and return as-is
            const inner = decodeField(bytes, pos);
            return { value: inner.value, offset: inner.offset };
        }
        case 7: { // simple values
            if (argVal === 20n)
                return { value: 0n, offset: pos }; // false
            if (argVal === 21n)
                return { value: 1n, offset: pos }; // true
            if (argVal === 22n)
                return { value: 0n, offset: pos }; // null
            return { value: BigInt(Number(argVal)), offset: pos };
        }
        default:
            throw new Error("CBOR: unsupported major type " + major);
    }
}
// ── Public API (matches Lucid's Data) ───────────────────────────────────────
export const Data = {
    /** Encode a Plutus Data value (Constr, bigint, hex string, etc.) to CBOR hex. */
    to(value) {
        return bytesToHex(encodeField(value));
    },
    /** Decode CBOR hex back to Plutus Data. */
    from(cborHex) {
        const bytes = hexToBytes(cborHex);
        const { value } = decodeField(bytes, 0);
        return value;
    },
};
/** Convert a UTF-8 string to hex — replaces Lucid's fromText(). */
export function fromText(text) {
    return Buffer.from(text, "utf8").toString("hex");
}
class FlatDec {
    d;
    x = 0;
    a = 0x80;
    constructor(d) { this.d = d; }
    popBit() { if (this.a < 1) {
        this.a = 0x80;
        this.x++;
    } const r = (this.d[this.x] & this.a) ? 1 : 0; this.a >>= 1; return r; }
    popBits(n) { let v = 0; for (let i = 0; i < n; i++)
        v = (v << 1) | this.popBit(); return v; }
    popByte() { if (this.a !== 0x80) {
        this.a = 0x80;
        this.x++;
    } return this.d[this.x++]; }
    skipByte() { if (this.a < 1) {
        this.a = 0x80;
        this.x++;
    } this.x++; this.a = 0x80; }
    decodeList(fn) { const r = []; while (this.popBit() === 1)
        r.push(fn()); return r; }
    decodeNat() {
        const chunks = [];
        let cont = this.popBit();
        while (cont === 1) {
            chunks.push(this.popBits(7));
            cont = this.popBit();
        }
        chunks.push(this.popBits(7));
        let v = 0n;
        for (let i = 0; i < chunks.length; i++)
            v += BigInt(chunks[i]) << (BigInt(i) * 7n);
        return v;
    }
    decodeBS() {
        this.skipByte();
        let len = this.popByte();
        if (len === 0)
            return new Uint8Array();
        const parts = [];
        while (len > 0) {
            parts.push(this.d.slice(this.x, this.x + len));
            this.x += len;
            len = this.d[this.x++];
        }
        if (parts.length === 1)
            return parts[0];
        let total = 0;
        for (const p of parts)
            total += p.length;
        const out = new Uint8Array(total);
        let off = 0;
        for (const p of parts) {
            out.set(p, off);
            off += p.length;
        }
        return out;
    }
    decodeTerm() {
        const tag = this.popBits(4);
        switch (tag) {
            case 0: return [0, this.decodeNat() - 1n];
            case 1: return [1, this.decodeTerm()];
            case 2: return [2, this.decodeTerm()];
            case 3: {
                const f = this.decodeTerm();
                return [3, f, this.decodeTerm()];
            }
            case 4: {
                const wt = this.decodeList(() => this.popBits(4));
                return [4, wt, this.decodeCV(wt, 0)[0]];
            }
            case 5: return [5, this.decodeTerm()];
            case 6: return [6];
            case 7: return [7, this.popBits(7)];
            case 8: return [8, this.decodeNat(), this.decodeList(() => this.decodeTerm())];
            case 9: {
                const t = this.decodeTerm();
                return [9, t, this.decodeList(() => this.decodeTerm())];
            }
            default: throw new Error("flat: tag " + tag);
        }
    }
    decodeCV(w, i) {
        const t = w[i];
        if (t === 7) {
            const n = w[i + 1];
            if (n === 5) { // list
                const s = i + 2;
                const items = this.decodeList(() => this.decodeCV(w, s)[0]);
                return [items, this.skipTE(w, s)];
            }
            if (n === 7 && w[i + 2] === 6) { // pair
                const a = i + 3, b = this.skipTE(w, a);
                const [fst] = this.decodeCV(w, a);
                const [snd] = this.decodeCV(w, b);
                return [[fst, snd], this.skipTE(w, b)];
            }
        }
        switch (t) {
            case 0: {
                const nat = this.decodeNat();
                return [nat % 2n === 0n ? nat / 2n : -((nat + 1n) / 2n), i + 1];
            }
            case 1: return [this.decodeBS(), i + 1];
            case 2: return [this.decodeBS(), i + 1]; // string as bytes
            case 3: return [undefined, i + 1];
            case 4: return [this.popBit() === 1, i + 1];
            case 8: return [this.decodeBS(), i + 1]; // data as CBOR bytes
            default: throw new Error("flat: cv " + t);
        }
    }
    skipTE(w, i) {
        if (w[i] === 7) {
            const n = w[i + 1];
            if (n === 5)
                return this.skipTE(w, i + 2);
            if (n === 7 && w[i + 2] === 6)
                return this.skipTE(w, this.skipTE(w, i + 3));
        }
        return i + 1;
    }
}
class FlatEnc {
    b = new Uint8Array(256);
    n = 0;
    c = 0;
    i = 0;
    g() { const t = this.b; this.b = new Uint8Array(t.length * 2); this.b.set(t); }
    pushBit(v) { this.c = (this.c << 1) | v; if (++this.i >= 8) {
        if (this.n >= this.b.length)
            this.g();
        this.b[this.n++] = this.c;
        this.c = 0;
        this.i = 0;
    } }
    pushBits(v, n) { for (let j = n - 1; j >= 0; j--)
        this.pushBit(((v >> j) & 1)); }
    pushByte(v) { if (this.n >= this.b.length)
        this.g(); this.b[this.n++] = v; }
    pushBytes(d) { while (this.n + d.length > this.b.length)
        this.g(); this.b.set(d, this.n); this.n += d.length; }
    pad() { if (this.i === 0) {
        this.pushByte(1);
        return;
    } while (this.i < 7)
        this.pushBit(0); this.pushBit(1); }
    bytes() { return this.b.slice(0, this.n); }
    encList(items, fn) { for (const it of items) {
        this.pushBit(1);
        fn(it);
    } this.pushBit(0); }
    encNat(n) {
        if (n < 0n)
            throw new Error("flat: negative nat");
        const chunks = [];
        if (n <= 127n) {
            chunks.push(Number(n));
        }
        else {
            let v = n;
            while (v > 0n) {
                chunks.push(Number(v & 0x7fn));
                v >>= 7n;
            }
        }
        for (let i = 0; i < chunks.length; i++) {
            this.pushBit(i < chunks.length - 1 ? 1 : 0);
            this.pushBits(chunks[i], 7);
        }
    }
    encBS(d) {
        this.pad();
        if (d.length === 0) {
            this.pushByte(0);
            return;
        }
        for (let i = 0; i < d.length; i += 255) {
            const end = Math.min(i + 255, d.length);
            this.pushByte(end - i);
            this.pushBytes(d.subarray(i, end));
        }
        this.pushByte(0);
    }
    encTerm(t) {
        const tag = t[0];
        this.pushBits(tag, 4);
        switch (tag) {
            case 0:
                this.encNat(t[1] + 1n);
                break;
            case 1:
                this.encTerm(t[1]);
                break;
            case 2:
                this.encTerm(t[1]);
                break;
            case 3:
                this.encTerm(t[1]);
                this.encTerm(t[2]);
                break;
            case 4: {
                const wt = t[1];
                this.encList(wt, v => this.pushBits(v, 4));
                this.encCV(wt, 0, t[2]);
                break;
            }
            case 5:
                this.encTerm(t[1]);
                break;
            case 6: break;
            case 7:
                this.pushBits(t[1], 7);
                break;
            case 8:
                this.encNat(t[1]);
                this.encList(t[2], tt => this.encTerm(tt));
                break;
            case 9:
                this.encTerm(t[1]);
                this.encList(t[2], tt => this.encTerm(tt));
                break;
        }
    }
    encCV(w, i, v) {
        const t = w[i];
        if (t === 7) {
            const n = w[i + 1];
            if (n === 5) { // list
                const s = i + 2;
                this.encList(v, item => this.encCV(w, s, item));
                return this.skipTE(w, s);
            }
            if (n === 7 && w[i + 2] === 6) { // pair
                const a = i + 3, b = this.skipTE(w, a);
                const [fst, snd] = v;
                this.encCV(w, a, fst);
                this.encCV(w, b, snd);
                return this.skipTE(w, b);
            }
        }
        switch (t) {
            case 0: {
                const n = v;
                this.encNat(n >= 0n ? n * 2n : -n * 2n - 1n);
                break;
            }
            case 1:
                this.encBS(v);
                break;
            case 2:
                this.encBS(v);
                break;
            case 3: break;
            case 4:
                this.pushBit(v ? 1 : 0);
                break;
            case 8:
                this.encBS(v);
                break;
            default: throw new Error("flat: encCV " + t);
        }
        return i + 1;
    }
    skipTE(w, i) {
        if (w[i] === 7) {
            const n = w[i + 1];
            if (n === 5)
                return this.skipTE(w, i + 2);
            if (n === 7 && w[i + 2] === 6)
                return this.skipTE(w, this.skipTE(w, i + 3));
        }
        return i + 1;
    }
}
// ── Apply parameters to UPLC scripts ────────────────────────────────────────
/**
 * Apply Plutus Data parameters to an unparameterized UPLC script (from plutus.json).
 *
 * Each parameter wraps the program in a UPLC Apply(program, Const(Data, param))
 * node. Fully decodes and re-encodes the flat UPLC to handle bytestring alignment.
 *
 * Compatible with CIP-57 / Aiken / Lucid encoding conventions.
 *
 * @param compiledCode - hex-encoded CBOR from plutus.json (a CBOR byte string wrapping flat UPLC)
 * @param params - Plutus Data parameters to apply (left-to-right = outermost lambda first)
 * @returns new compiledCode hex string with parameters applied
 */
export function applyParamsToScript(compiledCode, params) {
    if (params.length === 0)
        return compiledCode;
    const outerBytes = hexToBytes(compiledCode);
    let flat = decodeCbor(outerBytes, 0).value;
    // Decode flat UPLC
    const dec = new FlatDec(flat);
    const v0 = dec.popByte(), v1 = dec.popByte(), v2 = dec.popByte();
    let body = dec.decodeTerm();
    // Wrap in Apply(body, Const(Data, param)) for each parameter
    for (const param of params) {
        const paramCbor = encodeField(param);
        // Const(Data) node: tag=4, wireType=[8], value=CBOR bytes
        const constNode = [4, [8], paramCbor];
        body = [3, body, constNode]; // Apply(body, const)
    }
    // Re-encode
    const enc = new FlatEnc();
    enc.pushByte(v0);
    enc.pushByte(v1);
    enc.pushByte(v2);
    enc.encTerm(body);
    enc.pad();
    return bytesToHex(cborBytes(enc.bytes()));
}
//# sourceMappingURL=data.js.map