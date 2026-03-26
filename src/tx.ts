/**
 * Minimal Cardano transaction builder for ADA and native token transfers.
 *
 * Uses raw CBOR construction (no CML, no Lucid) backed by:
 * - src/cardano/cbor.ts (encoder/decoder)
 * - src/cardano/provider.ts (Koios/Blockfrost queries + protocol params)
 * - noble-bip32ed25519 (Ed25519 signing)
 * - bech32 (address encoding)
 *
 * Fee calculation: two-pass deterministic (build → measure → compute → rebuild).
 */

import {
  cborUint,
  cborBytes,
  cborArray,
  cborMap,
  cborTag,
  hexToBytes,
  bytesToHex,
} from "./cbor.js";
import {
  cborHeader,
} from "./cbor.js";
import type { CardanoProvider, ProtocolParams } from "./provider.js";
import { PrivateKey } from "noble-bip32ed25519";
import { blake2b } from "@noble/hashes/blake2b";

// ── Types ───────────────────────────────────────────────────────────────────

/** A parsed UTXO from Koios /address_utxos response. */
export interface Utxo {
  txHash: string;
  index: number;
  lovelace: bigint;
  /** Tokens as { "policyId+assetNameHex": quantity } */
  tokens: Record<string, bigint>;
}

/** Assets for a transaction output. lovelace is always present. */
export interface Assets {
  lovelace: bigint;
  [unit: string]: bigint;
}

// ── Address helpers ─────────────────────────────────────────────────────────

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** Decode a bech32 Cardano address to raw bytes (hex). */
export function addressToHex(addr: string): string {
  const sep = addr.lastIndexOf("1");
  const data: number[] = [];
  for (let i = sep + 1; i < addr.length; i++) {
    const v = BECH32_CHARSET.indexOf(addr.charAt(i));
    if (v === -1) throw new Error("Invalid bech32 character");
    data.push(v);
  }
  // Remove 6-byte checksum
  const words = data.slice(0, -6);
  // Convert 5-bit groups → 8-bit bytes
  let acc = 0;
  let bits = 0;
  const result: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      result.push((acc >> bits) & 0xff);
    }
  }
  return result.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Parse Koios UTXOs ───────────────────────────────────────────────────────

/** Parse Koios /address_utxos response into typed Utxo[]. */
export function parseKoiosUtxos(raw: unknown[]): Utxo[] {
  return (raw as Array<Record<string, unknown>>).map((u) => {
    const tokens: Record<string, bigint> = {};
    const assetList = u["asset_list"] as Array<Record<string, string>> | undefined;
    if (assetList) {
      for (const a of assetList) {
        const unit = (a["policy_id"] ?? "") + (a["asset_name"] ?? "");
        tokens[unit] = BigInt(a["quantity"] ?? "0");
      }
    }
    return {
      txHash: u["tx_hash"] as string,
      index: Number(u["tx_index"] ?? 0),
      lovelace: BigInt((u["value"] as string) ?? "0"),
      tokens,
    };
  });
}

// ── Coin selection (CIP-2 Random-Improve with Largest-First fallback) ───────

function utxoValue(u: Utxo, unit: string): bigint {
  return unit === "lovelace" ? u.lovelace : (u.tokens[unit] ?? 0n);
}

function sumSelected(selected: Utxo[]): Assets {
  const total: Assets = { lovelace: 0n };
  for (const u of selected) {
    total.lovelace += u.lovelace;
    for (const [unit, qty] of Object.entries(u.tokens)) {
      total[unit] = (total[unit] ?? 0n) + qty;
    }
  }
  return total;
}

function isSatisfied(total: Assets, required: Assets): boolean {
  for (const [unit, qty] of Object.entries(required)) {
    if (qty <= 0n) continue;
    const have = unit === "lovelace" ? total.lovelace : (total[unit] ?? 0n);
    if (have < qty) return false;
  }
  return true;
}

/** Fisher-Yates shuffle (in-place). */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

/**
 * Largest-First greedy selection. Used as fallback when Random-Improve
 * fails to find a valid selection.
 */
function largestFirst(utxos: Utxo[], required: Assets): Utxo[] {
  // Sort by total lovelace descending
  const sorted = [...utxos].sort((a, b) => Number(b.lovelace - a.lovelace));
  const selected: Utxo[] = [];
  const total: Assets = { lovelace: 0n };

  for (const u of sorted) {
    if (isSatisfied(total, required)) break;
    selected.push(u);
    total.lovelace += u.lovelace;
    for (const [unit, qty] of Object.entries(u.tokens)) {
      total[unit] = (total[unit] ?? 0n) + qty;
    }
  }

  if (!isSatisfied(total, required)) {
    const missing: string[] = [];
    for (const [unit, qty] of Object.entries(required)) {
      if (qty <= 0n) continue;
      const have = unit === "lovelace" ? total.lovelace : (total[unit] ?? 0n);
      if (have < qty) missing.push(`${unit}: need ${qty}, have ${have}`);
    }
    throw new Error(`Insufficient funds: ${missing.join(", ")}`);
  }

  return selected;
}

/**
 * CIP-2 Random-Improve coin selection.
 *
 * Phase 1 (Random Select): For each required asset, randomly pick UTxOs
 * until the accumulated value covers the requirement.
 *
 * Phase 2 (Improve): For each selection, try to swap the last-picked UTxO
 * with one from the remaining pool that brings change closer to the output
 * value (ideal change ≈ output value for UTxO diversity).
 *
 * Falls back to Largest-First if Random-Improve can't satisfy requirements
 * within a bounded number of attempts.
 */
export function selectUtxos(
  utxos: Utxo[],
  required: Assets,
): { selected: Utxo[]; inputTotal: Assets } {
  // Collect the units we need to satisfy
  const units: [string, bigint][] = [];
  for (const [unit, qty] of Object.entries(required)) {
    if (qty > 0n) units.push([unit, qty]);
  }
  if (units.length === 0) return { selected: [], inputTotal: { lovelace: 0n } };

  // Try Random-Improve up to 3 times, then fall back
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const pool = new Set(utxos);
      const selectedSet = new Set<Utxo>();

      // Phase 1: Random Select — per asset
      for (const [unit, needed] of units) {
        let accumulated = 0n;
        // Count what we already have from prior rounds
        for (const u of selectedSet) accumulated += utxoValue(u, unit);
        if (accumulated >= needed) continue;

        const candidates = shuffle([...pool].filter(u => utxoValue(u, unit) > 0n));
        for (const u of candidates) {
          if (accumulated >= needed) break;
          selectedSet.add(u);
          pool.delete(u);
          accumulated += utxoValue(u, unit);
        }
        if (accumulated < needed) throw new Error("insufficient"); // trigger fallback
      }

      // Phase 2: Improve — for each asset, try to swap the last selected UTxO
      // with a remaining one that brings change closer to the output value
      const selected = [...selectedSet];
      for (const [unit, needed] of units) {
        // Find the last UTxO selected that contributes to this unit
        let lastIdx = -1;
        for (let i = selected.length - 1; i >= 0; i--) {
          if (utxoValue(selected[i]!, unit) > 0n) { lastIdx = i; break; }
        }
        if (lastIdx < 0) continue;

        const total = selected.reduce((s, u) => s + utxoValue(u, unit), 0n);
        const change = total - needed;
        const idealChange = needed; // CIP-2: ideal change ≈ output value

        // Try each remaining UTxO as a swap candidate
        const last = selected[lastIdx]!;
        let bestSwap: Utxo | undefined;
        let bestDist = change > idealChange ? change - idealChange : idealChange - change;

        for (const candidate of pool) {
          if (utxoValue(candidate, unit) === 0n) continue;
          const newTotal = total - utxoValue(last, unit) + utxoValue(candidate, unit);
          if (newTotal < needed) continue; // swap must still cover requirement
          const newChange = newTotal - needed;
          const dist = newChange > idealChange ? newChange - idealChange : idealChange - newChange;
          if (dist < bestDist) {
            bestDist = dist;
            bestSwap = candidate;
          }
        }

        if (bestSwap) {
          pool.add(last);
          pool.delete(bestSwap);
          selected[lastIdx] = bestSwap;
        }
      }

      // Verify all requirements are met
      const inputTotal = sumSelected(selected);
      if (!isSatisfied(inputTotal, required)) throw new Error("insufficient");

      return { selected, inputTotal };
    } catch {
      // Random attempt failed — retry or fall back
    }
  }

  // Fallback: Largest-First
  const selected = largestFirst(utxos, required);
  return { selected, inputTotal: sumSelected(selected) };
}

// ── Fee calculation ─────────────────────────────────────────────────────────

/** Calculate the minimum fee for a transaction.
 *  For simple txs: minFeeA * size + minFeeB
 *  For script txs: adds ceil(priceMem * totalMem) + ceil(priceStep * totalSteps) */
export function calculateFee(
  txSizeBytes: number,
  pp: ProtocolParams,
  exUnits?: { mem: bigint; steps: bigint },
): bigint {
  let fee = BigInt(pp.minFeeA) * BigInt(txSizeBytes) + BigInt(pp.minFeeB);
  if (exUnits) {
    fee += BigInt(Math.ceil(pp.priceMem * Number(exUnits.mem)));
    fee += BigInt(Math.ceil(pp.priceStep * Number(exUnits.steps)));
  }
  return fee;
}

/** Compute min lovelace for an output from its serialized CBOR size. */
function minLovelace(outputCbor: Uint8Array, pp: ProtocolParams): bigint {
  return BigInt(160 + outputCbor.length) * BigInt(pp.coinsPerUtxoByte);
}

// ── CBOR builders ───────────────────────────────────────────────────────────

/** Sort inputs lexicographically by (txHash, index) — Conway requirement. */
function sortInputs(utxos: Utxo[]): Utxo[] {
  return [...utxos].sort((a, b) => {
    if (a.txHash < b.txHash) return -1;
    if (a.txHash > b.txHash) return 1;
    return a.index - b.index;
  });
}

/** Encode transaction inputs as CBOR (tag 258 set). */
function buildInputsCbor(utxos: Utxo[]): Uint8Array {
  return cborTag(
    258,
    cborArray(
      utxos.map((u) =>
        cborArray([cborBytes(hexToBytes(u.txHash)), cborUint(BigInt(u.index))]),
      ),
    ),
  );
}

/** Build CBOR for a simple output (ADA only or ADA + tokens). */
export function buildOutputCbor(addrHex: string, lovelace: bigint, tokens?: [string, bigint][]): Uint8Array {
  const addrBytes = cborBytes(hexToBytes(addrHex));
  if (tokens && tokens.length > 0) {
    const multiAsset = buildMultiAssetCbor(tokens);
    return cborMap([
      [cborUint(0n), addrBytes],
      [cborUint(1n), cborArray([cborUint(lovelace), multiAsset])],
    ]);
  }
  return cborMap([
    [cborUint(0n), addrBytes],
    [cborUint(1n), cborUint(lovelace)],
  ]);
}

/** Build CBOR for multi-asset value: Map<PolicyId, Map<AssetName, Qty>> */
function buildMultiAssetCbor(tokens: [string, bigint][]): Uint8Array {
  const byPolicy = new Map<string, [string, bigint][]>();
  for (const [unit, qty] of tokens) {
    const policyId = unit.slice(0, 56);
    const assetName = unit.slice(56);
    let list = byPolicy.get(policyId);
    if (!list) {
      list = [];
      byPolicy.set(policyId, list);
    }
    list.push([assetName, qty]);
  }

  const policyEntries: [Uint8Array, Uint8Array][] = [];
  for (const [policyId, assets] of byPolicy) {
    const assetEntries: [Uint8Array, Uint8Array][] = assets.map(([name, qty]) => [
      cborBytes(hexToBytes(name)),
      cborUint(qty),
    ]);
    policyEntries.push([cborBytes(hexToBytes(policyId)), cborMap(assetEntries)]);
  }
  return cborMap(policyEntries);
}

/** Build a transaction body CBOR map. */
function buildTxBody(
  inputs: Utxo[],
  outputs: Uint8Array[],
  fee: bigint,
  ttl: bigint,
): Uint8Array {
  return cborMap([
    [cborUint(0n), buildInputsCbor(inputs)],
    [cborUint(1n), cborArray(outputs)],
    [cborUint(2n), cborUint(fee)],
    [cborUint(3n), cborUint(ttl)],
  ]);
}

/** Sign a tx body hash and return the full witness set CBOR. */
function buildWitnessSet(
  txBodyHash: Uint8Array,
  kL: Uint8Array,
  kR: Uint8Array,
  PrivateKey: typeof import("noble-bip32ed25519").PrivateKey,
): {
  witnessSet: Uint8Array;
  pubKeyBytes: Uint8Array;
} {
  const privKey = new PrivateKey(kL, kR);
  const signature = privKey.sign(txBodyHash);
  const pubKeyBytes = privKey.toPublicKey().toBytes();

  const vkeyWitness = cborArray([cborBytes(pubKeyBytes), cborBytes(signature)]);
  const witnessSet = cborMap([
    [cborUint(0n), cborArray([vkeyWitness])],
  ]);
  return { witnessSet, pubKeyBytes };
}

/** Assemble a full signed transaction from body + witness set. */
function assembleTx(txBody: Uint8Array, witnessSet: Uint8Array): Uint8Array {
  return cborArray([
    txBody,
    witnessSet,
    new Uint8Array([0xf5]), // true (isValid)
    new Uint8Array([0xf6]), // null (no auxiliary data)
  ]);
}

// ── Transaction builder ─────────────────────────────────────────────────────

/** Build, sign, and submit a simple ADA/token transfer with proper fee calculation. */
export async function buildAndSubmitTransfer(params: {
  provider: CardanoProvider;
  fromAddress: string;
  toAddress: string;
  assets: Assets;
  signingKey: Uint8Array; // 64-byte Ed25519 extended private key (kL + kR)
}): Promise<string> {
  const { provider, fromAddress, toAddress, assets, signingKey } = params;
  const kL = signingKey.slice(0, 32);
  const kR = signingKey.slice(32, 64);

  // 1. Fetch UTXOs, protocol params, and tip concurrently
  const [rawUtxos, pp, tip] = await Promise.all([
    provider.fetchUtxos(fromAddress),
    provider.fetchProtocolParams(),
    provider.fetchTip(),
  ]);

  const utxos = parseKoiosUtxos(rawUtxos);
  if (utxos.length === 0) throw new Error("No UTXOs at sender address");
  const ttl = BigInt(tip.slot + 900);

  const toAddrHex = addressToHex(toAddress);
  const fromAddrHex = addressToHex(fromAddress);

  // 2. First pass: build with a generous placeholder fee to determine coin selection
  const maxFee = 500000n; // 0.5 ADA — well above any simple tx fee
  const required: Assets = { lovelace: assets.lovelace + maxFee };
  for (const [unit, qty] of Object.entries(assets)) {
    if (unit !== "lovelace") required[unit] = qty;
  }
  const { selected, inputTotal } = selectUtxos(utxos, required);
  const sortedInputs = sortInputs(selected);

  // Compute change tokens (same regardless of fee)
  const changeTokens: [string, bigint][] = [];
  for (const [unit, qty] of Object.entries(inputTotal)) {
    if (unit === "lovelace") continue;
    const sent = assets[unit] ?? 0n;
    const rem = qty - sent;
    if (rem > 0n) changeTokens.push([unit, rem]);
  }

  // Helper: build outputs for a given fee
  const hasTokens = Object.keys(assets).some((u) => u !== "lovelace");
  const tokenEntries = Object.entries(assets).filter(([u]) => u !== "lovelace");

  function buildOutputs(fee: bigint): Uint8Array[] {
    const outs: Uint8Array[] = [];

    // Recipient output — enforce min-UTxO
    let recipientLv = assets.lovelace;
    const recipientOut = hasTokens
      ? buildOutputCbor(toAddrHex, recipientLv, tokenEntries)
      : buildOutputCbor(toAddrHex, recipientLv);
    const minLv = minLovelace(recipientOut, pp);
    if (recipientLv < minLv) recipientLv = minLv;

    const changeLv = inputTotal.lovelace - recipientLv - fee;

    // When change is below min UTxO and there are no change tokens, add it to the
    // recipient output. At most ~1 ADA — better than losing it as excess fee.
    const dustChange = changeLv > 0n && changeLv < minLv && changeTokens.length === 0;
    if (dustChange) recipientLv += changeLv;

    // Build final recipient output with adjusted lovelace
    if (hasTokens) {
      outs.push(buildOutputCbor(toAddrHex, recipientLv, tokenEntries));
    } else {
      outs.push(buildOutputCbor(toAddrHex, recipientLv));
    }

    // Change output (only when enough for min UTxO or tokens need returning)
    if (!dustChange && changeLv > 0n) {
      if (changeTokens.length > 0) {
        const changeOut = buildOutputCbor(fromAddrHex, changeLv, changeTokens);
        const changeMin = minLovelace(changeOut, pp);
        outs.push(buildOutputCbor(fromAddrHex, changeLv < changeMin ? changeMin : changeLv, changeTokens));
      } else if (changeLv >= minLv) {
        outs.push(buildOutputCbor(fromAddrHex, changeLv));
      }
    }

    return outs;
  }

  // 3. Iterative fee calculation — rebuild until fee stabilizes
  let currentFee = maxFee;
  for (let i = 0; i < 5; i++) {
    const outs = buildOutputs(currentFee);
    const body = buildTxBody(sortedInputs, outs, currentFee, ttl);
    const bodyHash = blake2b(body, { dkLen: 32 });
    const { witnessSet: ws } = buildWitnessSet(bodyHash, kL, kR, PrivateKey);
    const tx = assembleTx(body, ws);
    const neededFee = calculateFee(tx.length, pp);

    if (neededFee <= currentFee) {
      return provider.submitTx(bytesToHex(tx));
    }
    currentFee = neededFee;
  }

  // Fallback
  const outs = buildOutputs(currentFee);
  const body = buildTxBody(sortedInputs, outs, currentFee, ttl);
  const bodyHash = blake2b(body, { dkLen: 32 });
  const { witnessSet: ws } = buildWitnessSet(bodyHash, kL, kR, PrivateKey);
  const tx = assembleTx(body, ws);
  return provider.submitTx(bytesToHex(tx));
}

// ── Script transaction builder ──────────────────────────────────────────────

/** A script input to spend from a validator. */
export interface ScriptInput {
  utxo: Utxo;
  /** Address the UTXO sits at (bech32) */
  address: string;
  /** Redeemer CBOR hex (from Data.to()) */
  redeemerCbor: string;
}

/** An output with an optional inline datum. */
export interface TxOutput {
  address: string;
  assets: Assets;
  /** Inline datum CBOR hex (from Data.to()) — omit for plain outputs */
  datumCbor?: string;
}

/** Mint/burn entry. */
export interface MintEntry {
  policyId: string;
  assets: Record<string, bigint>; // assetNameHex → quantity (negative to burn)
  redeemerCbor: string;
  /** PlutusV3 script CBOR hex (from plutus.json compiledCode) */
  scriptCbor: string;
}

/**
 * Build, sign, and submit a transaction with script inputs, datums, minting.
 *
 * Handles: script spending, redeemers, inline datums, minting/burning,
 * validity ranges, required signers, two-pass fee calculation.
 */
export async function buildAndSubmitScriptTx(params: {
  provider: CardanoProvider;
  /** Wallet UTXOs for fee/collateral (bech32 address) */
  walletAddress: string;
  /** Script inputs to spend (with redeemers) */
  scriptInputs: ScriptInput[];
  /** All outputs (recipient, continuing, change handled automatically) */
  outputs: TxOutput[];
  /** Minting/burning entries */
  mints?: MintEntry[];
  /** PlutusV3 spending validator CBOR hex (from plutus.json compiledCode) */
  spendingScriptCbor?: string;
  /** Validity range (POSIX ms) — converted to slots automatically */
  validFrom?: number;
  validTo?: number;
  /** Cardano network (for slot conversion). Default: preprod */
  network?: import("./types.js").CardanoNetwork;
  /** Required signer key hashes (hex) */
  requiredSigners?: string[];
  /** 64-byte signing key (kL + kR) */
  signingKey: Uint8Array;
}): Promise<string> {
  const {
    provider, walletAddress, scriptInputs, outputs,
    mints, spendingScriptCbor, validFrom, validTo,
    network: net = "preprod", requiredSigners, signingKey,
  } = params;

  const { posixToSlot } = await import("./time.js");

  const kL = signingKey.slice(0, 32);
  const kR = signingKey.slice(32, 64);

  const hasScripts = scriptInputs.length > 0 || (mints && mints.length > 0);

  // 1. Fetch wallet UTXOs and protocol params
  const [rawWalletUtxos, pp] = await Promise.all([
    provider.fetchUtxos(walletAddress),
    provider.fetchProtocolParams(),
  ]);
  const walletUtxos = parseKoiosUtxos(rawWalletUtxos);

  // Convert POSIX ms → slot numbers
  const validFromSlot = validFrom !== undefined
    ? BigInt(posixToSlot(validFrom, net))
    : undefined;
  const validToSlot = BigInt(posixToSlot(validTo ?? (Date.now() + 600_000), net));

  // 2. Calculate how much ADA the outputs need
  let outputLovelace = 0n;
  for (const out of outputs) {
    outputLovelace += out.assets.lovelace;
  }

  // Script inputs contribute ADA
  let scriptInputLovelace = 0n;
  for (const si of scriptInputs) {
    scriptInputLovelace += si.utxo.lovelace;
  }

  // We need wallet UTXOs for: fee + collateral + any ADA shortfall
  // Script txs need much higher fees due to execution units
  const maxFee = hasScripts ? 2_000_000n : 500000n;
  const collateralAmount = hasScripts ? maxFee * 3n / 2n : 0n; // 150% of fee for scripts
  const adaNeeded = outputLovelace > scriptInputLovelace
    ? outputLovelace - scriptInputLovelace + maxFee + collateralAmount
    : maxFee + collateralAmount;

  // Pre-select the best ADA-only UTxO for collateral before greedy selection.
  // The greedy selector doesn't guarantee an ADA-only UTxO ends up in the set,
  // so we reserve one upfront and run coin selection on the remainder.
  let collateralUtxo: Utxo | undefined;
  let selectionPool = walletUtxos;
  let adjustedAdaNeeded = adaNeeded;

  if (hasScripts) {
    const adaOnly = walletUtxos
      .filter(u => Object.keys(u.tokens).length === 0)
      .sort((a, b) => Number(a.lovelace - b.lovelace)); // ascending — pick smallest sufficient
    // Find the smallest UTxO that covers collateral; fall back to the largest if none qualifies
    collateralUtxo = adaOnly.find(u => u.lovelace >= collateralAmount) ?? adaOnly[adaOnly.length - 1];
    if (!collateralUtxo) {
      throw new Error("No ADA-only UTXOs available for collateral — send ADA to a clean UTXO first");
    }
    selectionPool = walletUtxos.filter(u => !(u.txHash === collateralUtxo!.txHash && u.index === collateralUtxo!.index));
    adjustedAdaNeeded = adaNeeded > collateralUtxo.lovelace ? adaNeeded - collateralUtxo.lovelace : 0n;
  }

  const { selected: walletCoinSelected, inputTotal: walletInputTotal } = adjustedAdaNeeded > 0n
    ? selectUtxos(selectionPool, { lovelace: adjustedAdaNeeded })
    : { selected: [] as Utxo[], inputTotal: { lovelace: 0n } as Assets };

  // Prepend collateral UTxO so it's always in the input set
  const walletSelected = collateralUtxo
    ? [collateralUtxo, ...walletCoinSelected]
    : walletCoinSelected;

  // Adjust inputTotal to include collateral
  if (collateralUtxo) {
    walletInputTotal.lovelace += collateralUtxo.lovelace;
  }

  // 3. Build the transaction body fields

  // All inputs: script inputs + wallet inputs, sorted
  const allInputs: Utxo[] = [
    ...scriptInputs.map(si => si.utxo),
    ...walletSelected,
  ];
  const sortedInputs = sortInputs(allInputs);

  // Build outputs CBOR
  function buildAllOutputs(fee: bigint): Uint8Array[] {
    const outs: Uint8Array[] = [];

    // Explicit outputs — enforce min-UTxO
    let actualOutputLovelace = 0n;
    for (const out of outputs) {
      const addrHex = addressToHex(out.address);
      const hasTokens = Object.keys(out.assets).some(u => u !== "lovelace");
      const tokenEntries = Object.entries(out.assets).filter(([u]) => u !== "lovelace");
      let lv = out.assets.lovelace;

      if (out.datumCbor) {
        // Output with inline datum (post-Babbage map format)
        const datumBytes = hexToBytes(out.datumCbor);
        const datumField: [Uint8Array, Uint8Array] = [
          cborUint(2n),
          cborArray([cborUint(1n), cborTag(24, cborBytes(datumBytes))]),
        ];
        // Build once to compute min-UTxO, then rebuild with adjusted lovelace
        const trial = cborMap([
          [cborUint(0n), cborBytes(hexToBytes(addrHex))],
          hasTokens
            ? [cborUint(1n), cborArray([cborUint(lv), buildMultiAssetCbor(tokenEntries)])]
            : [cborUint(1n), cborUint(lv)],
          datumField,
        ]);
        const minLv = minLovelace(trial, pp);
        if (lv < minLv) lv = minLv;
        const valueField: [Uint8Array, Uint8Array] = hasTokens
          ? [cborUint(1n), cborArray([cborUint(lv), buildMultiAssetCbor(tokenEntries)])]
          : [cborUint(1n), cborUint(lv)];
        outs.push(cborMap([[cborUint(0n), cborBytes(hexToBytes(addrHex))], valueField, datumField]));
      } else {
        const trial = buildOutputCbor(addrHex, lv, hasTokens ? tokenEntries : undefined);
        const minLv = minLovelace(trial, pp);
        if (lv < minLv) lv = minLv;
        outs.push(buildOutputCbor(addrHex, lv, hasTokens ? tokenEntries : undefined));
      }
      actualOutputLovelace += lv;
    }

    // Change output (wallet gets back its excess ADA + any tokens)
    const totalInputLv = scriptInputLovelace + walletInputTotal.lovelace;
    const changeLv = totalInputLv - actualOutputLovelace - fee;

    // Collect leftover tokens from wallet inputs not consumed by outputs
    const changeTokens: [string, bigint][] = [];
    const walletTokens = new Map<string, bigint>();
    for (const [unit, qty] of Object.entries(walletInputTotal)) {
      if (unit !== "lovelace" && qty > 0n) walletTokens.set(unit, qty);
    }
    // Subtract tokens sent in explicit outputs
    for (const out of outputs) {
      for (const [unit, qty] of Object.entries(out.assets)) {
        if (unit !== "lovelace") {
          const have = walletTokens.get(unit) ?? 0n;
          const rem = have - qty;
          if (rem > 0n) walletTokens.set(unit, rem);
          else walletTokens.delete(unit);
        }
      }
    }
    for (const [unit, qty] of walletTokens) {
      changeTokens.push([unit, qty]);
    }

    if (changeLv > 0n || changeTokens.length > 0) {
      const changeOut = buildOutputCbor(addressToHex(walletAddress), changeLv > 0n ? changeLv : 0n,
        changeTokens.length > 0 ? changeTokens : undefined);
      const changeMin = minLovelace(changeOut, pp);
      if (changeLv >= changeMin || changeTokens.length > 0) {
        const actualChangeLv = changeLv < changeMin ? changeMin : changeLv;
        outs.push(buildOutputCbor(addressToHex(walletAddress), actualChangeLv,
          changeTokens.length > 0 ? changeTokens : undefined));
      }
    }

    return outs;
  }

  // Script input indices (position in sorted inputs) for redeemers
  function scriptInputIndex(utxo: Utxo): number {
    return sortedInputs.findIndex(
      u => u.txHash === utxo.txHash && u.index === utxo.index,
    );
  }

  // Build redeemers: CBOR array of [tag, index, data, ex_units]
  // tag 0 = spend, tag 1 = mint. data is raw Plutus Data CBOR (not wrapped in bytes).
  // Default ex_units are generous — Koios/ogmios can evaluate exact units later.
  const EX_MEM = 14000000n;
  const EX_STEPS = 10000000000n;

  // Conway redeemers: map of [tag, index] → [data, ex_units]
  function buildRedeemers(): Uint8Array {
    const mapEntries: [Uint8Array, Uint8Array][] = [];

    for (const si of scriptInputs) {
      const idx = scriptInputIndex(si.utxo);
      const key = cborArray([cborUint(0n), cborUint(BigInt(idx))]); // [spend, index]
      const val = cborArray([hexToBytes(si.redeemerCbor), cborArray([cborUint(EX_MEM), cborUint(EX_STEPS)])]);
      mapEntries.push([key, val]);
    }

    if (mints) {
      const sortedPolicies = mints.map(m => m.policyId).sort();
      for (const m of mints) {
        const idx = sortedPolicies.indexOf(m.policyId);
        const key = cborArray([cborUint(1n), cborUint(BigInt(idx))]); // [mint, index]
        const val = cborArray([hexToBytes(m.redeemerCbor), cborArray([cborUint(EX_MEM), cborUint(EX_STEPS)])]);
        mapEntries.push([key, val]);
      }
    }

    return cborMap(mapEntries);
  }

  // Build Plutus V3 script witnesses (field 7 in witness set).
  // compiledCode from plutus.json is hex-encoded CBOR (a byte string wrapping flat UPLC).
  // In the witness set, each script entry must be cborBytes(compiledCode_bytes) —
  // the same double-wrap as reference scripts. The node computes the script hash
  // as blake2b_224(0x03 ++ full_CBOR) which matches plutus.json's hash field.
  function buildPlutusV3Scripts(): Uint8Array[] {
    const scripts: Uint8Array[] = [];
    if (spendingScriptCbor) {
      scripts.push(cborBytes(hexToBytes(spendingScriptCbor)));
    }
    if (mints) {
      for (const m of mints) {
        scripts.push(cborBytes(hexToBytes(m.scriptCbor)));
      }
    }
    return scripts;
  }

  /**
   * Compute script_data_hash per Alonzo/Babbage/Conway spec:
   *   blake2b_256(redeemers_bytes ++ datums_bytes ++ language_views_bytes)
   *
   * - redeemers_bytes: the CBOR-encoded redeemers array
   * - datums_bytes: CBOR empty array (0x80) when using inline datums only
   * - language_views_bytes: CBOR map { language_id: [cost_model_values] }
   *   where language_id is an integer (0=V1, 1=V2, 2=V3)
   *
   * The language views encoding uses the CBOR *integer array* format for
   * cost model values — each value encoded as a CBOR integer, wrapped in
   * a definite-length CBOR array.
   */
  function computeScriptDataHash(redeemersCbor: Uint8Array): Uint8Array {
    // When no datums in witness set, datum part is empty (zero bytes) per the ledger spec:
    // "if null (d ^. unTxDatsL) then mempty else originalBytes d"
    const emptyDatums = new Uint8Array(0);

    // Encode language views: { 2: [cost_model_values...] } for PlutusV3
    let languageViews: Uint8Array;
    if (pp.costModelV3 && pp.costModelV3.length > 0) {
      const values = pp.costModelV3.map(v => {
        if (v >= 0) return cborUint(BigInt(v));
        return cborHeader(1, BigInt(-v - 1)); // negative CBOR int
      });
      const costModelArray = cborArray(values);
      languageViews = cborMap([[cborUint(2n), costModelArray]]);
    } else {
      languageViews = new Uint8Array([0xa0]); // empty map
    }

    // Concatenate: redeemers ++ datums ++ language_views
    const total = redeemersCbor.length + emptyDatums.length + languageViews.length;
    const combined = new Uint8Array(total);
    let offset = 0;
    combined.set(redeemersCbor, offset); offset += redeemersCbor.length;
    combined.set(emptyDatums, offset); offset += emptyDatums.length;
    combined.set(languageViews, offset);

    return blake2b(combined, { dkLen: 32 });
  }

  // Build full transaction body
  function buildFullTxBody(fee: bigint): Uint8Array {
    const outs = buildAllOutputs(fee);
    const bodyFields: [Uint8Array, Uint8Array][] = [
      [cborUint(0n), buildInputsCbor(sortedInputs)],
      [cborUint(1n), cborArray(outs)],
      [cborUint(2n), cborUint(fee)],
    ];

    // TTL (field 3) — use validTo as slot
    bodyFields.push([cborUint(3n), cborUint(validToSlot)]);

    // Mint (field 9)
    if (mints && mints.length > 0) {
      const mintEntries: [string, bigint][] = [];
      for (const m of mints) {
        for (const [assetName, qty] of Object.entries(m.assets)) {
          mintEntries.push([m.policyId + assetName, qty]);
        }
      }
      // Build mint map — need to handle negative quantities for burns
      const byPolicy = new Map<string, [string, bigint][]>();
      for (const [unit, qty] of mintEntries) {
        const pid = unit.slice(0, 56);
        const aname = unit.slice(56);
        let list = byPolicy.get(pid);
        if (!list) { list = []; byPolicy.set(pid, list); }
        list.push([aname, qty]);
      }
      const policyEntries: [Uint8Array, Uint8Array][] = [];
      for (const [pid, assets] of byPolicy) {
        const assetEntries: [Uint8Array, Uint8Array][] = assets.map(([name, qty]) => [
          cborBytes(hexToBytes(name)),
          qty >= 0n ? cborUint(qty) : cborHeader(1, -qty - 1n),
        ]);
        policyEntries.push([cborBytes(hexToBytes(pid)), cborMap(assetEntries)]);
      }
      bodyFields.push([cborUint(9n), cborMap(policyEntries)]);
    }

    // Collateral (fields 13, 16, 17) — required for any Plutus script execution
    if (hasScripts && collateralUtxo) {
      const collUtxo = collateralUtxo;
      // Field 13: collateral inputs
      bodyFields.push([
        cborUint(13n),
        cborTag(258, cborArray([
          cborArray([cborBytes(hexToBytes(collUtxo.txHash)), cborUint(BigInt(collUtxo.index))]),
        ])),
      ]);
      // Field 16: collateral return (send excess back to wallet)
      const totalColl = (fee * 3n + 1n) / 2n; // ceiling division for 150%
      const collReturn = collUtxo.lovelace - totalColl;
      if (collReturn > 0n) {
        bodyFields.push([
          cborUint(16n),
          buildOutputCbor(addressToHex(walletAddress), collReturn),
        ]);
      }
      // Field 17: total collateral
      bodyFields.push([cborUint(17n), cborUint(totalColl)]);
    }

    // Required signers (field 14)
    if (requiredSigners && requiredSigners.length > 0) {
      bodyFields.push([
        cborUint(14n),
        cborTag(258, cborArray(requiredSigners.map(h => cborBytes(hexToBytes(h))))),
      ]);
    }

    // Validity start (field 8) — POSIX ms
    if (validFromSlot !== undefined) {
      bodyFields.push([cborUint(8n), cborUint(validFromSlot)]);
    }

    // Script data hash (field 11) — required when scripts are present
    if (scriptInputs.length > 0 || (mints && mints.length > 0)) {
      const redeemersCbor = buildRedeemers();
      const sdh = computeScriptDataHash(redeemersCbor);
      bodyFields.push([cborUint(11n), cborBytes(sdh)]);
    }

    // Sort body fields by key for canonical CBOR
    bodyFields.sort((a, b) => {
      const ka = a[0]!;
      const kb = b[0]!;
      if (ka.length !== kb.length) return ka.length - kb.length;
      for (let i = 0; i < ka.length; i++) {
        if (ka[i]! !== kb[i]!) return ka[i]! - kb[i]!;
      }
      return 0;
    });

    return cborMap(bodyFields);
  }

  // Build full witness set
  function buildFullWitnessSet(txBodyHash: Uint8Array): Uint8Array {
    const privKey = new PrivateKey(kL, kR);
    const signature = privKey.sign(txBodyHash);
    const pubKeyBytes = privKey.toPublicKey().toBytes();

    const witnessFields: [Uint8Array, Uint8Array][] = [];

    // VKey witnesses (field 0)
    const vkeyWitness = cborArray([cborBytes(pubKeyBytes), cborBytes(signature)]);
    witnessFields.push([cborUint(0n), cborArray([vkeyWitness])]);

    // Redeemers (field 5)
    if (scriptInputs.length > 0 || (mints && mints.length > 0)) {
      witnessFields.push([cborUint(5n), buildRedeemers()]);
    }

    // PlutusV3 scripts (field 7)
    const v3Scripts = buildPlutusV3Scripts();
    if (v3Scripts.length > 0) {
      witnessFields.push([cborUint(7n), cborArray(v3Scripts)]);
    }

    return cborMap(witnessFields);
  }

  // Total execution units across all redeemers (for fee calculation)
  const numRedeemers = scriptInputs.length + (mints?.length ?? 0);
  const totalExUnits = numRedeemers > 0
    ? { mem: EX_MEM * BigInt(numRedeemers), steps: EX_STEPS * BigInt(numRedeemers) }
    : undefined;

  // 4. Iterative fee calculation — rebuild until fee stabilizes
  let currentFee = maxFee;
  for (let i = 0; i < 5; i++) {
    const body = buildFullTxBody(currentFee);
    const hash = blake2b(body, { dkLen: 32 });
    const witness = buildFullWitnessSet(hash);
    const tx = assembleTx(body, witness);
    const neededFee = calculateFee(tx.length, pp, totalExUnits);

    if (neededFee <= currentFee) {
      // Fee is sufficient — submit
      return provider.submitTx(bytesToHex(tx));
    }
    currentFee = neededFee;
  }

  // Fallback: use the last computed fee
  const body = buildFullTxBody(currentFee);
  const hash = blake2b(body, { dkLen: 32 });
  const witness = buildFullWitnessSet(hash);
  const tx = assembleTx(body, witness);
  return provider.submitTx(bytesToHex(tx));
}
