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
import { cborUint, cborBytes, cborArray, cborMap, cborTag, cborHeader, hexToBytes, bytesToHex, decodeCbor, parseCborMap, } from "./cbor.js";
import { PrivateKey } from "noble-bip32ed25519";
import { blake2b } from "@noble/hashes/blake2b";
// ── Address helpers ─────────────────────────────────────────────────────────
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
/** Decode a bech32 Cardano address to raw bytes (hex). */
export function addressToHex(addr) {
    const sep = addr.lastIndexOf("1");
    const data = [];
    for (let i = sep + 1; i < addr.length; i++) {
        const v = BECH32_CHARSET.indexOf(addr.charAt(i));
        if (v === -1)
            throw new Error("Invalid bech32 character");
        data.push(v);
    }
    // Remove 6-byte checksum
    const words = data.slice(0, -6);
    // Convert 5-bit groups → 8-bit bytes
    let acc = 0;
    let bits = 0;
    const result = [];
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
export function parseKoiosUtxos(raw) {
    return raw.map((u) => {
        const tokens = {};
        const assetList = u["asset_list"];
        if (assetList) {
            for (const a of assetList) {
                const unit = (a["policy_id"] ?? "") + (a["asset_name"] ?? "");
                tokens[unit] = BigInt(a["quantity"] ?? "0");
            }
        }
        return {
            txHash: u["tx_hash"],
            index: Number(u["tx_index"] ?? 0),
            lovelace: BigInt(u["value"] ?? "0"),
            tokens,
        };
    });
}
// ── Coin selection (CIP-2 Random-Improve with Largest-First fallback) ───────
function utxoValue(u, unit) {
    return unit === "lovelace" ? u.lovelace : (u.tokens[unit] ?? 0n);
}
function sumSelected(selected) {
    const total = { lovelace: 0n };
    for (const u of selected) {
        total.lovelace += u.lovelace;
        for (const [unit, qty] of Object.entries(u.tokens)) {
            total[unit] = (total[unit] ?? 0n) + qty;
        }
    }
    return total;
}
function isSatisfied(total, required) {
    for (const [unit, qty] of Object.entries(required)) {
        if (qty <= 0n)
            continue;
        const have = unit === "lovelace" ? total.lovelace : (total[unit] ?? 0n);
        if (have < qty)
            return false;
    }
    return true;
}
/** Fisher-Yates shuffle (in-place). */
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
/**
 * Largest-First greedy selection. Used as fallback when Random-Improve
 * fails to find a valid selection.
 */
function largestFirst(utxos, required) {
    // Sort by total lovelace descending
    const sorted = [...utxos].sort((a, b) => Number(b.lovelace - a.lovelace));
    const selected = [];
    const total = { lovelace: 0n };
    for (const u of sorted) {
        if (isSatisfied(total, required))
            break;
        selected.push(u);
        total.lovelace += u.lovelace;
        for (const [unit, qty] of Object.entries(u.tokens)) {
            total[unit] = (total[unit] ?? 0n) + qty;
        }
    }
    if (!isSatisfied(total, required)) {
        const missing = [];
        for (const [unit, qty] of Object.entries(required)) {
            if (qty <= 0n)
                continue;
            const have = unit === "lovelace" ? total.lovelace : (total[unit] ?? 0n);
            if (have < qty)
                missing.push(`${unit}: need ${qty}, have ${have}`);
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
export function selectUtxos(utxos, required) {
    // Collect the units we need to satisfy
    const units = [];
    for (const [unit, qty] of Object.entries(required)) {
        if (qty > 0n)
            units.push([unit, qty]);
    }
    if (units.length === 0)
        return { selected: [], inputTotal: { lovelace: 0n } };
    // Try Random-Improve up to 3 times, then fall back
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const pool = new Set(utxos);
            const selectedSet = new Set();
            // Phase 1: Random Select — per asset
            for (const [unit, needed] of units) {
                let accumulated = 0n;
                // Count what we already have from prior rounds
                for (const u of selectedSet)
                    accumulated += utxoValue(u, unit);
                if (accumulated >= needed)
                    continue;
                const candidates = shuffle([...pool].filter(u => utxoValue(u, unit) > 0n));
                for (const u of candidates) {
                    if (accumulated >= needed)
                        break;
                    selectedSet.add(u);
                    pool.delete(u);
                    accumulated += utxoValue(u, unit);
                }
                if (accumulated < needed)
                    throw new Error("insufficient"); // trigger fallback
            }
            // Phase 2: Improve — for each asset, try to swap the last selected UTxO
            // with a remaining one that brings change closer to the output value
            const selected = [...selectedSet];
            for (const [unit, needed] of units) {
                // Find the last UTxO selected that contributes to this unit
                let lastIdx = -1;
                for (let i = selected.length - 1; i >= 0; i--) {
                    if (utxoValue(selected[i], unit) > 0n) {
                        lastIdx = i;
                        break;
                    }
                }
                if (lastIdx < 0)
                    continue;
                const total = selected.reduce((s, u) => s + utxoValue(u, unit), 0n);
                const change = total - needed;
                const idealChange = needed; // CIP-2: ideal change ≈ output value
                // Try each remaining UTxO as a swap candidate
                const last = selected[lastIdx];
                let bestSwap;
                let bestDist = change > idealChange ? change - idealChange : idealChange - change;
                for (const candidate of pool) {
                    if (utxoValue(candidate, unit) === 0n)
                        continue;
                    const newTotal = total - utxoValue(last, unit) + utxoValue(candidate, unit);
                    if (newTotal < needed)
                        continue; // swap must still cover requirement
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
            if (!isSatisfied(inputTotal, required))
                throw new Error("insufficient");
            return { selected, inputTotal };
        }
        catch {
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
export function calculateFee(txSizeBytes, pp, exUnits) {
    let fee = BigInt(pp.minFeeA) * BigInt(txSizeBytes) + BigInt(pp.minFeeB);
    if (exUnits) {
        fee += BigInt(Math.ceil(pp.priceMem * Number(exUnits.mem)));
        fee += BigInt(Math.ceil(pp.priceStep * Number(exUnits.steps)));
    }
    return fee;
}
/** Compute min lovelace for an output from its serialized CBOR size. */
function minLovelace(outputCbor, pp) {
    return BigInt(160 + outputCbor.length) * BigInt(pp.coinsPerUtxoByte);
}
// ── CBOR builders ───────────────────────────────────────────────────────────
/** Sort inputs lexicographically by (txHash, index) — Conway requirement. */
function sortInputs(utxos) {
    return [...utxos].sort((a, b) => {
        if (a.txHash < b.txHash)
            return -1;
        if (a.txHash > b.txHash)
            return 1;
        return a.index - b.index;
    });
}
/** Encode transaction inputs as CBOR (tag 258 set). */
function buildInputsCbor(utxos) {
    return cborTag(258, cborArray(utxos.map((u) => cborArray([cborBytes(hexToBytes(u.txHash)), cborUint(BigInt(u.index))]))));
}
/** Build CBOR for a simple output (ADA only or ADA + tokens). */
export function buildOutputCbor(addrHex, lovelace, tokens) {
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
function buildMultiAssetCbor(tokens) {
    const byPolicy = new Map();
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
    const policyEntries = [];
    for (const [policyId, assets] of byPolicy) {
        const assetEntries = assets.map(([name, qty]) => [
            cborBytes(hexToBytes(name)),
            cborUint(qty),
        ]);
        policyEntries.push([cborBytes(hexToBytes(policyId)), cborMap(assetEntries)]);
    }
    return cborMap(policyEntries);
}
/** Build a transaction body CBOR map. */
function buildTxBody(inputs, outputs, fee, ttl) {
    return cborMap([
        [cborUint(0n), buildInputsCbor(inputs)],
        [cborUint(1n), cborArray(outputs)],
        [cborUint(2n), cborUint(fee)],
        [cborUint(3n), cborUint(ttl)],
    ]);
}
/** Sign a tx body hash and return the full witness set CBOR. */
function buildWitnessSet(txBodyHash, kL, kR, PrivateKey) {
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
function assembleTx(txBody, witnessSet) {
    return cborArray([
        txBody,
        witnessSet,
        new Uint8Array([0xf5]), // true (isValid)
        new Uint8Array([0xf6]), // null (no auxiliary data)
    ]);
}
// ── Transaction builder ─────────────────────────────────────────────────────
/** Build, sign, and submit a simple ADA/token transfer with proper fee calculation. */
export async function buildAndSubmitTransfer(params) {
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
    if (utxos.length === 0)
        throw new Error("No UTXOs at sender address");
    const ttl = BigInt(tip.slot + 900);
    const toAddrHex = addressToHex(toAddress);
    const fromAddrHex = addressToHex(fromAddress);
    // 2. First pass: build with a generous placeholder fee to determine coin selection
    const maxFee = 500000n; // 0.5 ADA — well above any simple tx fee
    const required = { lovelace: assets.lovelace + maxFee };
    for (const [unit, qty] of Object.entries(assets)) {
        if (unit !== "lovelace")
            required[unit] = qty;
    }
    const { selected, inputTotal } = selectUtxos(utxos, required);
    const sortedInputs = sortInputs(selected);
    // Compute change tokens (same regardless of fee)
    const changeTokens = [];
    for (const [unit, qty] of Object.entries(inputTotal)) {
        if (unit === "lovelace")
            continue;
        const sent = assets[unit] ?? 0n;
        const rem = qty - sent;
        if (rem > 0n)
            changeTokens.push([unit, rem]);
    }
    // Helper: build outputs for a given fee
    const hasTokens = Object.keys(assets).some((u) => u !== "lovelace");
    const tokenEntries = Object.entries(assets).filter(([u]) => u !== "lovelace");
    function buildOutputs(fee) {
        const outs = [];
        // Recipient output — enforce min-UTxO (two-pass: lovelace CBOR size may grow after bump)
        let recipientLv = assets.lovelace;
        const buildRecipient = (lv) => hasTokens
            ? buildOutputCbor(toAddrHex, lv, tokenEntries)
            : buildOutputCbor(toAddrHex, lv);
        let minLv = minLovelace(buildRecipient(recipientLv), pp);
        if (recipientLv < minLv) {
            recipientLv = minLv;
            minLv = minLovelace(buildRecipient(recipientLv), pp);
            if (recipientLv < minLv)
                recipientLv = minLv;
        }
        const changeLv = inputTotal.lovelace - recipientLv - fee;
        // When change is below min UTxO and there are no change tokens, add it to the
        // recipient output. At most ~1 ADA — better than losing it as excess fee.
        const dustChange = changeLv > 0n && changeLv < minLv && changeTokens.length === 0;
        if (dustChange)
            recipientLv += changeLv;
        // Build final recipient output with adjusted lovelace
        if (hasTokens) {
            outs.push(buildOutputCbor(toAddrHex, recipientLv, tokenEntries));
        }
        else {
            outs.push(buildOutputCbor(toAddrHex, recipientLv));
        }
        // Change output (only when enough for min UTxO or tokens need returning)
        if (!dustChange && changeLv > 0n) {
            if (changeTokens.length > 0) {
                const buildChange = (v) => buildOutputCbor(fromAddrHex, v, changeTokens);
                let changeMin = minLovelace(buildChange(changeLv), pp);
                let actualChange = changeLv < changeMin ? changeMin : changeLv;
                changeMin = minLovelace(buildChange(actualChange), pp);
                if (actualChange < changeMin)
                    actualChange = changeMin;
                outs.push(buildChange(actualChange));
            }
            else if (changeLv >= minLv) {
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
/**
 * Core builder — takes pre-fetched protocol params, wallet UTxOs (collateral
 * excluded), and a pre-selected collateral UTxO. Produces all the pieces of
 * an unsigned script tx: body, partial witness set (no vkeys), redeemers,
 * scripts, script_data_hash, fee.
 *
 * Both `buildAndSubmitScriptTx` (signs + submits) and `buildUnsignedScriptTx`
 * (returns pieces for CIP-30) wrap this.
 */
async function _buildScriptTxPieces(params) {
    const { walletAddress, walletUtxos, collateralUtxo, scriptInputs, outputs, mints, spendingScriptCbor, validFrom, validTo, network: net = "preprod", requiredSigners, pp, } = params;
    const { posixToSlot } = await import("./time.js");
    const hasScripts = scriptInputs.length > 0 || (mints && mints.length > 0);
    const validFromSlot = validFrom !== undefined
        ? BigInt(posixToSlot(validFrom, net))
        : undefined;
    const validToSlot = BigInt(posixToSlot(validTo ?? (Date.now() + 600_000), net));
    let outputLovelace = 0n;
    for (const out of outputs)
        outputLovelace += out.assets.lovelace;
    let scriptInputLovelace = 0n;
    for (const si of scriptInputs)
        scriptInputLovelace += si.utxo.lovelace;
    const maxFee = hasScripts ? 2000000n : 500000n;
    const adaNeeded = outputLovelace > scriptInputLovelace
        ? outputLovelace - scriptInputLovelace + maxFee
        : maxFee;
    const adjustedAdaNeeded = collateralUtxo
        ? (adaNeeded > collateralUtxo.lovelace ? adaNeeded - collateralUtxo.lovelace : 0n)
        : adaNeeded;
    const { selected: walletCoinSelected, inputTotal: walletInputTotal } = adjustedAdaNeeded > 0n
        ? selectUtxos(walletUtxos, { lovelace: adjustedAdaNeeded })
        : { selected: [], inputTotal: { lovelace: 0n } };
    const walletSelected = collateralUtxo
        ? [collateralUtxo, ...walletCoinSelected]
        : walletCoinSelected;
    if (collateralUtxo) {
        walletInputTotal.lovelace += collateralUtxo.lovelace;
        // Defensive: include any tokens in collateral UTxO so they don't vanish
        // from change accounting. In practice collateral is ADA-only.
        for (const [unit, qty] of Object.entries(collateralUtxo.tokens)) {
            walletInputTotal[unit] = (walletInputTotal[unit] ?? 0n) + qty;
        }
    }
    const allInputs = [
        ...scriptInputs.map(si => si.utxo),
        ...walletSelected,
    ];
    const sortedInputs = sortInputs(allInputs);
    function buildAllOutputs(fee) {
        const outs = [];
        let actualOutputLovelace = 0n;
        for (const out of outputs) {
            const addrHex = addressToHex(out.address);
            const hasTokens = Object.keys(out.assets).some(u => u !== "lovelace");
            const tokenEntries = Object.entries(out.assets).filter(([u]) => u !== "lovelace");
            let lv = out.assets.lovelace;
            if (out.datumCbor) {
                const datumBytes = hexToBytes(out.datumCbor);
                const datumField = [
                    cborUint(2n),
                    cborArray([cborUint(1n), cborTag(24, cborBytes(datumBytes))]),
                ];
                const buildDatumOut = (v) => cborMap([
                    [cborUint(0n), cborBytes(hexToBytes(addrHex))],
                    hasTokens
                        ? [cborUint(1n), cborArray([cborUint(v), buildMultiAssetCbor(tokenEntries)])]
                        : [cborUint(1n), cborUint(v)],
                    datumField,
                ]);
                let minLv = minLovelace(buildDatumOut(lv), pp);
                if (lv < minLv) {
                    lv = minLv;
                    minLv = minLovelace(buildDatumOut(lv), pp);
                    if (lv < minLv)
                        lv = minLv;
                }
                outs.push(buildDatumOut(lv));
            }
            else {
                const buildOut = (v) => buildOutputCbor(addrHex, v, hasTokens ? tokenEntries : undefined);
                let minLv = minLovelace(buildOut(lv), pp);
                if (lv < minLv) {
                    lv = minLv;
                    minLv = minLovelace(buildOut(lv), pp);
                    if (lv < minLv)
                        lv = minLv;
                }
                outs.push(buildOut(lv));
            }
            actualOutputLovelace += lv;
        }
        const totalInputLv = scriptInputLovelace + walletInputTotal.lovelace;
        const changeLv = totalInputLv - actualOutputLovelace - fee;
        const changeTokens = [];
        const walletTokens = new Map();
        for (const [unit, qty] of Object.entries(walletInputTotal)) {
            if (unit !== "lovelace" && qty > 0n)
                walletTokens.set(unit, qty);
        }
        for (const out of outputs) {
            for (const [unit, qty] of Object.entries(out.assets)) {
                if (unit !== "lovelace") {
                    const have = walletTokens.get(unit) ?? 0n;
                    const rem = have - qty;
                    if (rem > 0n)
                        walletTokens.set(unit, rem);
                    else
                        walletTokens.delete(unit);
                }
            }
        }
        for (const [unit, qty] of walletTokens) {
            changeTokens.push([unit, qty]);
        }
        if (changeLv > 0n || changeTokens.length > 0) {
            const walletAddrHex = addressToHex(walletAddress);
            const toks = changeTokens.length > 0 ? changeTokens : undefined;
            const buildChange = (v) => buildOutputCbor(walletAddrHex, v, toks);
            let changeMin = minLovelace(buildChange(changeLv > 0n ? changeLv : 0n), pp);
            let actualChangeLv = changeLv < changeMin ? changeMin : changeLv;
            changeMin = minLovelace(buildChange(actualChangeLv), pp);
            if (actualChangeLv < changeMin)
                actualChangeLv = changeMin;
            if (changeLv >= changeMin || changeTokens.length > 0) {
                outs.push(buildChange(actualChangeLv));
            }
        }
        return outs;
    }
    function scriptInputIndex(utxo) {
        return sortedInputs.findIndex(u => u.txHash === utxo.txHash && u.index === utxo.index);
    }
    // Cardano preprod/mainnet limits: 16.5M mem, 10B steps per tx.
    const MAX_TX_MEM = 16500000n;
    const MAX_TX_STEPS = 10000000000n;
    const numRedeemers = scriptInputs.length + (mints?.length ?? 0);
    const defaultMem = numRedeemers > 0 ? MAX_TX_MEM / BigInt(numRedeemers) : MAX_TX_MEM;
    const defaultSteps = numRedeemers > 0 ? MAX_TX_STEPS / BigInt(numRedeemers) : MAX_TX_STEPS;
    // Conway redeemers: map of [tag, index] → [data, ex_units]
    function buildRedeemers() {
        const mapEntries = [];
        for (const si of scriptInputs) {
            const idx = scriptInputIndex(si.utxo);
            const mem = si.exUnits?.mem ?? defaultMem;
            const steps = si.exUnits?.steps ?? defaultSteps;
            const key = cborArray([cborUint(0n), cborUint(BigInt(idx))]); // [spend, index]
            const val = cborArray([hexToBytes(si.redeemerCbor), cborArray([cborUint(mem), cborUint(steps)])]);
            mapEntries.push([key, val]);
        }
        if (mints) {
            const sortedPolicies = mints.map(m => m.policyId).sort();
            for (const m of mints) {
                const mem = m.exUnits?.mem ?? defaultMem;
                const steps = m.exUnits?.steps ?? defaultSteps;
                const idx = sortedPolicies.indexOf(m.policyId);
                const key = cborArray([cborUint(1n), cborUint(BigInt(idx))]); // [mint, index]
                const val = cborArray([hexToBytes(m.redeemerCbor), cborArray([cborUint(mem), cborUint(steps)])]);
                mapEntries.push([key, val]);
            }
        }
        return cborMap(mapEntries);
    }
    function buildPlutusV3Scripts() {
        const scripts = [];
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
    function computeScriptDataHash(redeemersCbor) {
        const emptyDatums = new Uint8Array(0);
        let languageViews;
        if (pp.costModelV3 && pp.costModelV3.length > 0) {
            const values = pp.costModelV3.map(v => {
                if (v >= 0)
                    return cborUint(BigInt(v));
                return cborHeader(1, BigInt(-v - 1));
            });
            const costModelArray = cborArray(values);
            languageViews = cborMap([[cborUint(2n), costModelArray]]);
        }
        else {
            languageViews = new Uint8Array([0xa0]);
        }
        const total = redeemersCbor.length + emptyDatums.length + languageViews.length;
        const combined = new Uint8Array(total);
        let offset = 0;
        combined.set(redeemersCbor, offset);
        offset += redeemersCbor.length;
        combined.set(emptyDatums, offset);
        offset += emptyDatums.length;
        combined.set(languageViews, offset);
        return blake2b(combined, { dkLen: 32 });
    }
    function buildFullTxBody(fee) {
        const outs = buildAllOutputs(fee);
        const bodyFields = [
            [cborUint(0n), buildInputsCbor(sortedInputs)],
            [cborUint(1n), cborArray(outs)],
            [cborUint(2n), cborUint(fee)],
        ];
        bodyFields.push([cborUint(3n), cborUint(validToSlot)]);
        if (mints && mints.length > 0) {
            const mintEntries = [];
            for (const m of mints) {
                for (const [assetName, qty] of Object.entries(m.assets)) {
                    mintEntries.push([m.policyId + assetName, qty]);
                }
            }
            const byPolicy = new Map();
            for (const [unit, qty] of mintEntries) {
                const pid = unit.slice(0, 56);
                const aname = unit.slice(56);
                let list = byPolicy.get(pid);
                if (!list) {
                    list = [];
                    byPolicy.set(pid, list);
                }
                list.push([aname, qty]);
            }
            const policyEntries = [];
            for (const [pid, assets] of byPolicy) {
                const assetEntries = assets.map(([name, qty]) => [
                    cborBytes(hexToBytes(name)),
                    qty >= 0n ? cborUint(qty) : cborHeader(1, -qty - 1n),
                ]);
                policyEntries.push([cborBytes(hexToBytes(pid)), cborMap(assetEntries)]);
            }
            bodyFields.push([cborUint(9n), cborMap(policyEntries)]);
        }
        if (hasScripts && collateralUtxo) {
            const collUtxo = collateralUtxo;
            bodyFields.push([
                cborUint(13n),
                cborTag(258, cborArray([
                    cborArray([cborBytes(hexToBytes(collUtxo.txHash)), cborUint(BigInt(collUtxo.index))]),
                ])),
            ]);
            const totalColl = (fee * 3n + 1n) / 2n; // ceiling division for 150%
            const collReturn = collUtxo.lovelace - totalColl;
            if (collReturn > 0n) {
                bodyFields.push([
                    cborUint(16n),
                    buildOutputCbor(addressToHex(walletAddress), collReturn),
                ]);
            }
            bodyFields.push([cborUint(17n), cborUint(totalColl)]);
        }
        if (requiredSigners && requiredSigners.length > 0) {
            bodyFields.push([
                cborUint(14n),
                cborTag(258, cborArray(requiredSigners.map(h => cborBytes(hexToBytes(h))))),
            ]);
        }
        if (validFromSlot !== undefined) {
            bodyFields.push([cborUint(8n), cborUint(validFromSlot)]);
        }
        if (hasScripts) {
            const redeemersCbor = buildRedeemers();
            const sdh = computeScriptDataHash(redeemersCbor);
            bodyFields.push([cborUint(11n), cborBytes(sdh)]);
        }
        bodyFields.sort((a, b) => {
            const ka = a[0];
            const kb = b[0];
            if (ka.length !== kb.length)
                return ka.length - kb.length;
            for (let i = 0; i < ka.length; i++) {
                if (ka[i] !== kb[i])
                    return ka[i] - kb[i];
            }
            return 0;
        });
        return cborMap(bodyFields);
    }
    // Sizing witness set: includes a dummy vkey witness so the fee calc accounts
    // for the signature that will be merged in (either by the local signer in
    // buildAndSubmitScriptTx or by the CIP-30 wallet via mergeCip30Witness).
    function buildSizingWitnessSet() {
        const dummyPub = new Uint8Array(32);
        const dummySig = new Uint8Array(64);
        const dummyVkeyWitness = cborArray([cborBytes(dummyPub), cborBytes(dummySig)]);
        const fields = [];
        fields.push([cborUint(0n), cborArray([dummyVkeyWitness])]);
        if (hasScripts)
            fields.push([cborUint(5n), buildRedeemers()]);
        const v3Scripts = buildPlutusV3Scripts();
        if (v3Scripts.length > 0)
            fields.push([cborUint(7n), cborArray(v3Scripts)]);
        return cborMap(fields);
    }
    let totalMem = 0n;
    let totalSteps = 0n;
    for (const si of scriptInputs) {
        totalMem += si.exUnits?.mem ?? defaultMem;
        totalSteps += si.exUnits?.steps ?? defaultSteps;
    }
    for (const m of mints ?? []) {
        totalMem += m.exUnits?.mem ?? defaultMem;
        totalSteps += m.exUnits?.steps ?? defaultSteps;
    }
    const totalExUnits = numRedeemers > 0 ? { mem: totalMem, steps: totalSteps } : undefined;
    // Iterative fee calculation — rebuild until fee stabilizes
    let currentFee = maxFee;
    for (let i = 0; i < 5; i++) {
        const body = buildFullTxBody(currentFee);
        const sizingWitness = buildSizingWitnessSet();
        const sizingTx = assembleTx(body, sizingWitness);
        const neededFee = calculateFee(sizingTx.length, pp, totalExUnits);
        if (neededFee <= currentFee)
            break;
        currentFee = neededFee;
    }
    const body = buildFullTxBody(currentFee);
    const redeemersCbor = hasScripts ? buildRedeemers() : new Uint8Array(0);
    const plutusV3ScriptList = buildPlutusV3Scripts();
    const plutusV3Scripts = cborArray(plutusV3ScriptList);
    const scriptDataHash = hasScripts ? computeScriptDataHash(redeemersCbor) : new Uint8Array(0);
    // Partial witness fields — no vkey. Sorted: 5 < 7.
    const witnessFieldsNoVkey = [];
    if (hasScripts)
        witnessFieldsNoVkey.push([cborUint(5n), redeemersCbor]);
    if (plutusV3ScriptList.length > 0)
        witnessFieldsNoVkey.push([cborUint(7n), plutusV3Scripts]);
    return {
        txBodyCbor: body,
        witnessFieldsNoVkey,
        redeemersCbor,
        plutusV3Scripts,
        scriptDataHash,
        fee: currentFee,
    };
}
/**
 * Build, sign, and submit a transaction with script inputs, datums, minting.
 *
 * Handles: script spending, redeemers, inline datums, minting/burning,
 * validity ranges, required signers, iterative fee calculation.
 */
export async function buildAndSubmitScriptTx(params) {
    const { provider, walletAddress, scriptInputs, outputs, mints, spendingScriptCbor, validFrom, validTo, network, requiredSigners, signingKey, } = params;
    const kL = signingKey.slice(0, 32);
    const kR = signingKey.slice(32, 64);
    const hasScripts = scriptInputs.length > 0 || (mints && mints.length > 0);
    const [rawWalletUtxos, pp] = await Promise.all([
        provider.fetchUtxos(walletAddress),
        provider.fetchProtocolParams(),
    ]);
    const walletUtxos = parseKoiosUtxos(rawWalletUtxos);
    // Pre-select the smallest ADA-only UTxO covering 150% of maxFee as collateral.
    // The greedy selector doesn't guarantee an ADA-only UTxO ends up in the set,
    // so we reserve one upfront and run coin selection on the remainder.
    let collateralUtxo;
    let walletUtxosPool = walletUtxos;
    if (hasScripts) {
        const maxFee = 2000000n;
        const collateralAmount = maxFee * 3n / 2n;
        const adaOnly = walletUtxos
            .filter(u => Object.keys(u.tokens).length === 0)
            .sort((a, b) => Number(a.lovelace - b.lovelace));
        collateralUtxo = adaOnly.find(u => u.lovelace >= collateralAmount) ?? adaOnly[adaOnly.length - 1];
        if (!collateralUtxo) {
            throw new Error("No ADA-only UTXOs available for collateral — send ADA to a clean UTXO first");
        }
        walletUtxosPool = walletUtxos.filter(u => !(u.txHash === collateralUtxo.txHash && u.index === collateralUtxo.index));
    }
    const pieces = await _buildScriptTxPieces({
        walletAddress,
        walletUtxos: walletUtxosPool,
        collateralUtxo,
        scriptInputs,
        outputs,
        mints,
        spendingScriptCbor,
        validFrom,
        validTo,
        network,
        requiredSigners,
        pp,
    });
    // Sign body hash with real key, merge vkey witness into partial witness set
    const bodyHash = blake2b(pieces.txBodyCbor, { dkLen: 32 });
    const privKey = new PrivateKey(kL, kR);
    const signature = privKey.sign(bodyHash);
    const pubKeyBytes = privKey.toPublicKey().toBytes();
    const vkeyWitness = cborArray([cborBytes(pubKeyBytes), cborBytes(signature)]);
    // Full witness set: prepend field 0 (vkey) before partial fields (5, 7).
    // Already sorted since 0 < 5 < 7.
    const fullWitnessFields = [
        [cborUint(0n), cborArray([vkeyWitness])],
        ...pieces.witnessFieldsNoVkey,
    ];
    const fullWitnessSet = cborMap(fullWitnessFields);
    const tx = assembleTx(pieces.txBodyCbor, fullWitnessSet);
    return provider.submitTx(bytesToHex(tx));
}
/**
 * Build a script transaction ready for CIP-30 wallet signing.
 *
 * Mirrors `buildAndSubmitScriptTx` but:
 *   1. takes `walletUtxos` as a pre-parsed parameter (wallet already has them via `api.getUtxos()`);
 *   2. takes `collateralUtxos` explicitly (CIP-30 exposes `api.getCollateral()`);
 *   3. does not sign or submit — returns the body and partial witness set
 *      (redeemers + scripts, no vkeys) for the wallet to co-sign.
 *
 * Flow: consumer calls this, then `api.signTx(bytesToHex(txBodyCbor), true)`,
 * then `mergeCip30Witness(unsigned, walletWitnessHex)`, then `submitTx`.
 */
export async function buildUnsignedScriptTx(params) {
    const { provider, walletUtxos, collateralUtxos, scriptInputs, mints, ...rest } = params;
    const hasScripts = scriptInputs.length > 0 || (mints && mints.length > 0);
    const pp = await provider.fetchProtocolParams();
    let collateralUtxo;
    if (hasScripts) {
        const maxFee = 2000000n;
        const collateralAmount = maxFee * 3n / 2n;
        // Prefer the first UTxO that covers 150% of maxFee; fall back to the largest.
        const sortedByLovelace = [...collateralUtxos].sort((a, b) => Number(a.lovelace - b.lovelace));
        collateralUtxo = sortedByLovelace.find(u => u.lovelace >= collateralAmount)
            ?? sortedByLovelace[sortedByLovelace.length - 1];
        if (!collateralUtxo) {
            throw new Error("buildUnsignedScriptTx: script tx requires at least one collateral UTxO (from api.getCollateral())");
        }
    }
    // If the collateral UTxO appears in walletUtxos too, exclude it from the
    // coin-selection pool to avoid double-counting.
    const walletUtxosPool = collateralUtxo
        ? walletUtxos.filter(u => !(u.txHash === collateralUtxo.txHash && u.index === collateralUtxo.index))
        : walletUtxos;
    const pieces = await _buildScriptTxPieces({
        walletUtxos: walletUtxosPool,
        collateralUtxo,
        scriptInputs,
        mints,
        pp,
        ...rest,
    });
    return {
        txBodyCbor: pieces.txBodyCbor,
        witnessSet: cborMap(pieces.witnessFieldsNoVkey),
        redeemersCbor: pieces.redeemersCbor,
        plutusV3Scripts: pieces.plutusV3Scripts,
        scriptDataHash: pieces.scriptDataHash,
        fee: pieces.fee,
    };
}
/**
 * Parse a CIP-30 `api.getUtxos()` / `api.getCollateral()` response into
 * typed `Utxo[]`. Each entry is CBOR hex encoding `[input, output]`.
 *
 * Supports both post-Babbage map outputs (`{0: address, 1: value, ...}`)
 * and pre-Babbage array outputs (`[address, value, ?datum_hash]`). Value
 * may be a bare uint (ADA-only) or `[lovelace, multiasset]`.
 */
export function parseCip30Utxos(cborHexArray) {
    return cborHexArray.map(hex => parseOneCip30Utxo(hexToBytes(hex)));
}
function parseOneCip30Utxo(bytes) {
    const decoded = decodeCbor(bytes, 0);
    if (!Array.isArray(decoded.value) || decoded.value.length < 2) {
        throw new Error("parseCip30Utxos: expected [input, output]");
    }
    const input = decoded.value[0];
    const output = decoded.value[1];
    if (!Array.isArray(input) || input.length < 2) {
        throw new Error("parseCip30Utxos: input is not [txHash, index]");
    }
    const txHashBytes = input[0];
    const txIndex = input[1];
    if (!(txHashBytes instanceof Uint8Array))
        throw new Error("parseCip30Utxos: tx hash not bytes");
    if (typeof txIndex !== "bigint")
        throw new Error("parseCip30Utxos: tx index not uint");
    let rawValue;
    if (output instanceof Map) {
        const v = output.get(1n);
        if (v === undefined)
            throw new Error("parseCip30Utxos: output missing value (field 1)");
        rawValue = v;
    }
    else if (Array.isArray(output)) {
        if (output.length < 2)
            throw new Error("parseCip30Utxos: pre-Babbage output too short");
        rawValue = output[1];
    }
    else {
        throw new Error("parseCip30Utxos: output is neither map nor array");
    }
    let lovelace;
    const tokens = {};
    if (typeof rawValue === "bigint") {
        lovelace = rawValue;
    }
    else if (Array.isArray(rawValue)) {
        if (rawValue.length < 2)
            throw new Error("parseCip30Utxos: multi-asset value too short");
        if (typeof rawValue[0] !== "bigint")
            throw new Error("parseCip30Utxos: lovelace not uint");
        lovelace = rawValue[0];
        const multiAsset = rawValue[1];
        if (multiAsset instanceof Map) {
            for (const [policyIdVal, assetsVal] of multiAsset) {
                if (!(policyIdVal instanceof Uint8Array))
                    throw new Error("parseCip30Utxos: policy id not bytes");
                if (!(assetsVal instanceof Map))
                    throw new Error("parseCip30Utxos: assets not map");
                const policyId = bytesToHex(policyIdVal);
                for (const [assetNameVal, qtyVal] of assetsVal) {
                    if (!(assetNameVal instanceof Uint8Array))
                        throw new Error("parseCip30Utxos: asset name not bytes");
                    if (typeof qtyVal !== "bigint")
                        throw new Error("parseCip30Utxos: quantity not uint");
                    tokens[policyId + bytesToHex(assetNameVal)] = qtyVal;
                }
            }
        }
    }
    else {
        throw new Error("parseCip30Utxos: value is neither uint nor array");
    }
    return {
        txHash: bytesToHex(txHashBytes),
        index: Number(txIndex),
        lovelace,
        tokens,
    };
}
/**
 * Merge the witness set returned by CIP-30 `api.signTx(cbor, partial=true)`
 * into the partial witness set from `buildUnsignedScriptTx`, producing a
 * fully-signed transaction hex string ready for `provider.submitTx`.
 *
 * Wallet entries take precedence on key collision; in practice wallets add
 * field 0 (vkey_witnesses), sometimes field 1 (native_scripts) or field 4
 * (bootstrap_witness), none of which collide with the partial's field 5
 * (redeemers) or field 7 (plutus_v3_scripts).
 */
export function mergeCip30Witness(unsigned, walletWitnessCbor) {
    const walletBytes = hexToBytes(walletWitnessCbor);
    const walletEntries = parseCborMap(walletBytes, 0).entries;
    const partialEntries = parseCborMap(unsigned.witnessSet, 0).entries;
    // Merge — uint keys only. Wallet wins any collision (shouldn't happen).
    const byKey = new Map();
    for (const e of partialEntries) {
        if (typeof e.key !== "bigint")
            throw new Error("mergeCip30Witness: partial key not uint");
        byKey.set(e.key, e.rawValue);
    }
    for (const e of walletEntries) {
        if (typeof e.key !== "bigint")
            throw new Error("mergeCip30Witness: wallet key not uint");
        byKey.set(e.key, e.rawValue);
    }
    // All keys are small uints (0..7), encoded in 1 CBOR byte each, so numeric
    // sort matches canonical CBOR sort (shortest first, then lexicographic).
    const sortedKeys = [...byKey.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const entries = sortedKeys.map(k => [cborUint(k), byKey.get(k)]);
    const fullWitnessSet = cborMap(entries);
    const tx = assembleTx(unsigned.txBodyCbor, fullWitnessSet);
    return bytesToHex(tx);
}
//# sourceMappingURL=tx.js.map