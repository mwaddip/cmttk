# applyParamsToScript — Implementation Specification

## Purpose

Apply Plutus Data parameters to an unparameterized UPLC script from `plutus.json`.
This is the Cardano equivalent of partial application — each parameter removes one
outermost lambda by wrapping the program in a UPLC `Apply(program, Const(Data, param))` node.

## Function Signature

```typescript
function applyParamsToScript(compiledCode: string, params: PlutusField[]): string
```

- `compiledCode`: hex-encoded CBOR byte string from `plutus.json` `validators[].compiledCode`
- `params`: array of Plutus Data values to apply, left-to-right (first param = outermost lambda)
- Returns: new `compiledCode` hex string with parameters applied

## Architecture

The `compiledCode` from Aiken's `plutus.json` is a **CBOR byte string** wrapping a
**flat-encoded UPLC program**. The flat encoding is a bit-level binary format (not
byte-level, not CBOR) defined by the Plutus specification.

Applying parameters requires a **full decode → modify AST → re-encode cycle**:

1. Unwrap the outer CBOR byte string to get flat bytes
2. Decode the flat bytes into a UPLC AST
3. For each parameter, wrap the AST body in `Apply(body, Const(Data, param_cbor))`
4. Re-encode the modified AST back to flat bytes
5. Re-wrap in a CBOR byte string

## Critical: Why You Cannot Just Copy Bits

The flat encoding contains **bytestring values** (used for `Const(Data, ...)` and
`Const(ByteString, ...)` terms). Bytestrings in flat are encoded as:

```
pad_to_byte_boundary + chunked_data + 0x00_terminator
```

The `pad_to_byte_boundary` step writes zeros then a `1` bit until the encoder
reaches the next byte boundary. **This pad depends on the absolute bit position
in the stream.** When you wrap a program in an `Apply` node (which adds 4 bits
at the start), every subsequent bytestring's pad alignment shifts by 4 bits.

This means:
- **Bit-copying the original program and appending the Const encoding WILL NOT WORK**
  for programs that contain any `Const(Data, ...)`, `Const(ByteString, ...)`, or
  `Const(String, ...)` values (which includes almost all real Aiken programs).
- The output will be silently wrong — same length, plausible-looking bytes, but
  different hash. The error manifests as a 4-bit shift at the position of the first
  bytestring constant in the program.
- Simple programs without bytestring constants (like the NFT validator in our test
  suite) WILL pass with the bit-copy approach, making the bug hard to catch.

**You MUST decode to AST and re-encode.** There is no shortcut.

## Flat Encoding Format

### Program structure
```
version_major: 1 byte (pushByte)
version_minor: 1 byte (pushByte)
version_patch: 1 byte (pushByte)
term: variable bits (see below)
pad: zeros + 1 to byte boundary (if already aligned: full 0x01 byte)
```

### Term tags (4 bits each)
```
0 = Var(deBruijn)          — followed by natural (1-indexed on wire)
1 = Delay(term)
2 = Lambda(term)
3 = Apply(func, arg)       — two terms in sequence
4 = Const(type, value)     — type list + type-dependent value
5 = Force(term)
6 = Error                  — no payload
7 = Builtin(tag)           — 7-bit builtin tag
8 = Constr(index, terms)   — natural + list of terms (PlutusV3)
9 = Case(term, terms)      — term + list of terms (PlutusV3)
```

### Natural numbers (variable-length, 7-bit chunks, LSB first)
```
[1 7bits]* [0 7bits]   — continuation bit before each 7-bit chunk, 0 = last
```
Note: this uses `decodeList2` semantics — always reads one final chunk after the
terminating 0 bit.

### Lists (1-bit continuation prefix)
```
[1 item]* [0]           — 1 = more items, 0 = end
```

### Const type encoding
Type is encoded as a list of 4-bit wire tags:
```
[1 4bits]* [0]          — same list encoding as above
```
Wire tag 7 = tyApp prefix for compound types:
- `[7, 5, <inner>]` = list\<inner\>
- `[7, 7, 6, <fst>, <snd>]` = pair\<fst, snd\>
- Simple types: 0=int, 1=bytestring, 2=string, 3=unit, 4=bool, 8=data

### Const value encoding (type-dependent)
- **int**: zigzag-encoded natural (`n >= 0 → 2n`, `n < 0 → -2n - 1`)
- **bytestring/string/data**: `pad() + [len][bytes]...[0x00]` (chunked, max 255 per chunk)
- **unit**: nothing
- **bool**: 1 bit
- **list**: same list encoding as terms, each element encoded by inner type
- **pair**: fst value then snd value

### The pad() function
```
if byte-aligned: write 0x01 (full byte)
else: write 0-bits until 7 bits into byte, then write 1
```
Result: always ends byte-aligned. This is used before bytestring chunks AND at
the end of the program.

## Test Vectors

From the BlockHost Aiken project with `server_key_hash = 2dbdd41304e95e4a1846c045328d746bf2267a0a619ec55976e7beb1`:

### Script hash computation
```
hash = blake2b_224(0x03 || compiledCode_cbor_bytes)
```
Where `compiledCode_cbor_bytes` is the single-CBOR-encoded hex (the `compiledCode`
string decoded from hex), NOT the inner flat bytes.

### Subscription validator (2 parameters)
- Unparameterized hash: `74b80aa2e3dce7265f573e7f6169b7c13881bb4f8a9053eb4c1439f5`
- After `applyParamsToScript(code, [serverKeyHash, serverKeyHash])`:
  - Hash: `864cf4419a059a2f54d8f8c64bbc041353efd85f07153a4e56aced19`

### Beacon validator (1 parameter: subscription_validator_hash)
- Unparameterized hash: `a7b6f2eb81b18111ea089ef7b05c3c028c618779a1d2baa426045291`
- After `applyParamsToScript(code, ["864cf4419a059a2f54d8f8c64bbc041353efd85f07153a4e56aced19"])`:
  - Hash: `49b835b36b9bd41d9bd0e14001230254218a99bf8ce656d48427e914`

### NFT validator (1 parameter: server_key_hash)
- Unparameterized hash: `32e39f6610808c340b7de42fbab42ea9c10f0b5fa7211bf069903cdc`
- After `applyParamsToScript(code, [serverKeyHash])`:
  - Hash: `977981c01b9ea38cb3893999e631b804f7767b6c029ed07ffc46a8b7`

## Implementation Notes

- The AST is represented as tagged arrays for compactness: `[tag, ...fields]`
- No external dependencies — the flat codec is ~180 lines of TypeScript
- `encodeField()` (cmttk's Plutus Data → CBOR encoder) produces the CBOR bytes
  that become the `Const(Data, ...)` value in the flat bytestring encoding
- Integer encoding uses zigzag before natural encoding
- Var indices are 0-indexed internally, 1-indexed on wire (add 1 when encoding)
