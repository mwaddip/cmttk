/**
 * Chain query provider — abstracts Blockfrost and Koios behind a common interface.
 *
 * Default: Koios (free, no API key required).
 * Optional: Blockfrost (higher rate limits, requires project ID).
 *
 * Both providers use native fetch() — no external SDK dependencies.
 */
// ── Koios provider ──────────────────────────────────────────────────────────
const KOIOS_URLS = {
    mainnet: "https://api.koios.rest/api/v1",
    preprod: "https://preprod.koios.rest/api/v1",
    preview: "https://preview.koios.rest/api/v1",
};
class KoiosProvider {
    name = "koios";
    baseUrl;
    static MAX_RETRIES = 4;
    static BASE_DELAY_MS = 1000;
    constructor(network, baseUrl) {
        this.baseUrl = baseUrl ?? KOIOS_URLS[network];
    }
    async request(path, options) {
        const url = `${this.baseUrl}${path}`;
        for (let attempt = 0; attempt <= KoiosProvider.MAX_RETRIES; attempt++) {
            const res = await fetch(url, {
                ...options,
                headers: { "Content-Type": "application/json", "Accept": "application/json", ...options?.headers },
            });
            if (res.ok)
                return res.json();
            if (res.status === 404)
                return null;
            if (res.status === 429 || res.status >= 500) {
                if (attempt < KoiosProvider.MAX_RETRIES) {
                    const retryAfter = res.headers.get("Retry-After");
                    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : KoiosProvider.BASE_DELAY_MS * Math.pow(2, attempt);
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
            }
            throw new Error(`Koios ${res.status}: ${await res.text()}`);
        }
        throw new Error(`Koios: retries exhausted for ${path}`);
    }
    async post(path, body) {
        return this.request(path, { method: "POST", body: JSON.stringify(body) });
    }
    async fetchUtxos(address, asset) {
        const result = await this.post("/address_utxos", { _addresses: [address], _extended: true });
        if (!result)
            return [];
        if (asset) {
            return result.filter((utxo) => {
                const assetList = utxo["asset_list"];
                if (!assetList)
                    return false;
                const policyId = asset.slice(0, 56);
                const assetName = asset.slice(56);
                return assetList.some((a) => a["policy_id"] === policyId && a["asset_name"] === assetName);
            });
        }
        return result;
    }
    async fetchTip() {
        const result = await this.request("/tip");
        if (!result || result.length === 0)
            throw new Error("Failed to fetch tip from Koios");
        const tip = result[0];
        return { slot: Number(tip["abs_slot"] ?? 0), block: Number(tip["block_no"] ?? 0), time: Number(tip["block_time"] ?? 0) };
    }
    async submitTx(txCbor) {
        const cborBytes = Buffer.from(txCbor, "hex");
        const res = await fetch(`${this.baseUrl}/submittx`, { method: "POST", headers: { "Content-Type": "application/cbor" }, body: cborBytes });
        if (!res.ok)
            throw new Error(`Koios submit failed ${res.status}: ${await res.text()}`);
        return (await res.text()).replace(/"/g, "").trim();
    }
    async fetchTxMetadata(txHash) {
        return await this.post("/tx_metadata", { _tx_hashes: [txHash] }) ?? [];
    }
    async fetchAddressTransactions(address, options) {
        const result = await this.post("/address_txs", { _addresses: [address], _after_block_height: 0 });
        if (!result)
            return [];
        const sorted = options?.order === "asc" ? result : result.reverse();
        return options?.count ? sorted.slice(0, options.count) : sorted;
    }
    async fetchAssetAddresses(asset) {
        const result = await this.post("/asset_addresses", { _asset_policy: asset.slice(0, 56), _asset_name: asset.slice(56) });
        if (!result)
            return [];
        return result.map((r) => ({ address: r["payment_address"] ?? r["address"] ?? "", quantity: r["quantity"] ?? "0" }));
    }
    async fetchAddressInfo(address) {
        return (await this.post("/address_info", { _addresses: [address] }))?.[0] ?? null;
    }
    async fetchProtocolParams() {
        const result = await this.request("/epoch_params?limit=1");
        if (!result || result.length === 0)
            throw new Error("Failed to fetch protocol params from Koios");
        const p = result[0];
        const costModels = p["cost_models"];
        return {
            minFeeA: Number(p["min_fee_a"] ?? 44), minFeeB: Number(p["min_fee_b"] ?? 155381),
            coinsPerUtxoByte: Number(p["coins_per_utxo_size"] ?? 4310), costModelV3: costModels?.["PlutusV3"],
            priceMem: Number(p["price_mem"] ?? 0.0577), priceStep: Number(p["price_step"] ?? 0.0000721),
        };
    }
}
// ── Blockfrost provider (native fetch) ──────────────────────────────────────
const BLOCKFROST_URLS = {
    mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
    preprod: "https://cardano-preprod.blockfrost.io/api/v0",
    preview: "https://cardano-preview.blockfrost.io/api/v0",
};
class BlockfrostProvider {
    name = "blockfrost";
    baseUrl;
    projectId;
    constructor(projectId, network) {
        this.baseUrl = BLOCKFROST_URLS[network];
        this.projectId = projectId;
    }
    async request(path, options) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            ...options,
            headers: { "project_id": this.projectId, "Content-Type": "application/json", ...options?.headers },
        });
        if (res.ok)
            return res.json();
        if (res.status === 404)
            return null;
        throw new Error(`Blockfrost ${res.status}: ${await res.text()}`);
    }
    async fetchUtxos(address, asset) {
        const path = asset ? `/addresses/${address}/utxos/${asset}` : `/addresses/${address}/utxos`;
        const all = [];
        let page = 1;
        while (true) {
            const result = await this.request(`${path}?page=${page}&order=asc`);
            if (!result || result.length === 0)
                break;
            all.push(...result);
            if (result.length < 100)
                break;
            page++;
        }
        return all;
    }
    async fetchTip() {
        const tip = await this.request("/blocks/latest");
        if (!tip)
            throw new Error("Failed to fetch tip from Blockfrost");
        return { slot: Number(tip["slot"] ?? 0), block: Number(tip["height"] ?? 0), time: Number(tip["time"] ?? 0) };
    }
    async submitTx(txCbor) {
        const res = await fetch(`${this.baseUrl}/tx/submit`, {
            method: "POST", headers: { "project_id": this.projectId, "Content-Type": "application/cbor" },
            body: Buffer.from(txCbor, "hex"),
        });
        if (!res.ok)
            throw new Error(`Blockfrost submit ${res.status}: ${await res.text()}`);
        return (await res.text()).replace(/"/g, "").trim();
    }
    async fetchTxMetadata(txHash) {
        return await this.request(`/txs/${txHash}/metadata`) ?? [];
    }
    async fetchAddressTransactions(address, options) {
        const count = options?.count ?? 100;
        const order = options?.order ?? "desc";
        return await this.request(`/addresses/${address}/transactions?count=${count}&order=${order}`) ?? [];
    }
    async fetchAssetAddresses(asset) {
        const result = await this.request(`/assets/${asset}/addresses`);
        if (!result)
            return [];
        return result.map((r) => ({ address: r["address"] ?? "", quantity: r["quantity"] ?? "0" }));
    }
    async fetchAddressInfo(address) {
        return this.request(`/addresses/${address}`);
    }
    async fetchProtocolParams() {
        const p = await this.request("/epochs/latest/parameters");
        if (!p)
            throw new Error("Failed to fetch protocol params from Blockfrost");
        const costModels = p["cost_models"];
        let costModelV3;
        if (costModels?.["PlutusV3"]) {
            const raw = costModels["PlutusV3"];
            // Blockfrost returns a named dict; Koios returns an array.
            // Sort keys alphabetically to match the canonical ledger ordering.
            costModelV3 = Array.isArray(raw)
                ? raw
                : Object.keys(raw).sort().map(k => raw[k]);
        }
        return {
            minFeeA: Number(p["min_fee_a"] ?? 44), minFeeB: Number(p["min_fee_b"] ?? 155381),
            coinsPerUtxoByte: Number(p["coins_per_utxo_size"] ?? "4310"), costModelV3,
            priceMem: Number(p["price_mem"] ?? "0.0577"), priceStep: Number(p["price_step"] ?? "0.0000721"),
        };
    }
}
// ── Factory ─────────────────────────────────────────────────────────────────
let _provider = null;
/** Create or return a cached CardanoProvider. Uses Koios by default. */
export function getProvider(network, blockfrostProjectId, koiosUrl) {
    if (_provider)
        return _provider;
    _provider = blockfrostProjectId
        ? new BlockfrostProvider(blockfrostProjectId, network)
        : new KoiosProvider(network, koiosUrl);
    return _provider;
}
/** Reset the cached provider (for testing) */
export function resetProvider() {
    _provider = null;
}
//# sourceMappingURL=provider.js.map