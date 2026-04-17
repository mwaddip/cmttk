/**
 * Chain query provider — abstracts Blockfrost and Koios behind a common interface.
 *
 * Default: Koios (free, no API key required).
 * Optional: Blockfrost (higher rate limits, requires project ID).
 *
 * Both providers use native fetch() — no external SDK dependencies.
 */

import type { CardanoNetwork } from "./types.js";
import { hexToBytes } from "./cbor.js";

// ── Provider interface ──────────────────────────────────────────────────────

/** Common interface for chain queries. Both Koios and Blockfrost implement this. */
export interface CardanoProvider {
  readonly name: string;
  fetchUtxos(address: string, asset?: string): Promise<unknown[]>;
  fetchTip(): Promise<{ slot: number; block: number; time: number }>;
  submitTx(txCbor: string): Promise<string>;
  fetchTxMetadata(txHash: string): Promise<unknown[]>;
  fetchAddressTransactions(address: string, options?: { count?: number; order?: "asc" | "desc" }): Promise<unknown[]>;
  fetchAssetAddresses(asset: string): Promise<Array<{ address: string; quantity: string }>>;
  fetchAddressInfo(address: string): Promise<unknown>;
  fetchProtocolParams(): Promise<ProtocolParams>;
}

/** Subset of protocol parameters needed for tx building. */
export interface ProtocolParams {
  minFeeA: number;
  minFeeB: number;
  coinsPerUtxoByte: number;
  costModelV3?: number[];
  priceMem: number;
  priceStep: number;
}

// ── Koios provider ──────────────────────────────────────────────────────────

const KOIOS_URLS: Record<CardanoNetwork, string> = {
  mainnet: "https://api.koios.rest/api/v1",
  preprod: "https://preprod.koios.rest/api/v1",
  preview: "https://preview.koios.rest/api/v1",
};

class KoiosProvider implements CardanoProvider {
  readonly name = "koios";
  private baseUrl: string;
  private static MAX_RETRIES = 4;
  private static BASE_DELAY_MS = 1000;

  constructor(network: CardanoNetwork, baseUrl?: string) {
    this.baseUrl = baseUrl ?? KOIOS_URLS[network];
  }

  private async request(path: string, options?: RequestInit): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; attempt <= KoiosProvider.MAX_RETRIES; attempt++) {
      const res = await fetch(url, {
        ...options,
        headers: { "Content-Type": "application/json", "Accept": "application/json", ...options?.headers },
      });
      if (res.ok) return res.json();
      if (res.status === 404) return null;
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

  private async post(path: string, body: unknown): Promise<unknown> {
    return this.request(path, { method: "POST", body: JSON.stringify(body) });
  }

  async fetchUtxos(address: string, asset?: string): Promise<unknown[]> {
    const result = await this.post("/address_utxos", { _addresses: [address], _extended: true }) as unknown[] | null;
    if (!result) return [];
    if (asset) {
      return (result as Array<Record<string, unknown>>).filter((utxo) => {
        const assetList = utxo["asset_list"] as Array<Record<string, string>> | undefined;
        if (!assetList) return false;
        const policyId = asset.slice(0, 56);
        const assetName = asset.slice(56);
        return assetList.some((a) => a["policy_id"] === policyId && a["asset_name"] === assetName);
      });
    }
    return result;
  }

  async fetchTip(): Promise<{ slot: number; block: number; time: number }> {
    const result = await this.request("/tip") as Array<Record<string, unknown>> | null;
    if (!result || result.length === 0) throw new Error("Failed to fetch tip from Koios");
    const tip = result[0]!;
    return { slot: Number(tip["abs_slot"] ?? 0), block: Number(tip["block_no"] ?? 0), time: Number(tip["block_time"] ?? 0) };
  }

  async submitTx(txCbor: string): Promise<string> {
    const cborBytes = hexToBytes(txCbor);
    const res = await fetch(`${this.baseUrl}/submittx`, { method: "POST", headers: { "Content-Type": "application/cbor" }, body: cborBytes });
    if (!res.ok) throw new Error(`Koios submit failed ${res.status}: ${await res.text()}`);
    return (await res.text()).replace(/"/g, "").trim();
  }

  async fetchTxMetadata(txHash: string): Promise<unknown[]> {
    return (await this.post("/tx_metadata", { _tx_hashes: [txHash] }) as unknown[] | null) ?? [];
  }

  async fetchAddressTransactions(address: string, options?: { count?: number; order?: "asc" | "desc" }): Promise<unknown[]> {
    const result = await this.post("/address_txs", { _addresses: [address], _after_block_height: 0 }) as unknown[] | null;
    if (!result) return [];
    const sorted = options?.order === "asc" ? result : result.reverse();
    return options?.count ? sorted.slice(0, options.count) : sorted;
  }

  async fetchAssetAddresses(asset: string): Promise<Array<{ address: string; quantity: string }>> {
    const result = await this.post("/asset_addresses", { _asset_policy: asset.slice(0, 56), _asset_name: asset.slice(56) }) as Array<Record<string, string>> | null;
    if (!result) return [];
    return result.map((r) => ({ address: r["payment_address"] ?? r["address"] ?? "", quantity: r["quantity"] ?? "0" }));
  }

  async fetchAddressInfo(address: string): Promise<unknown> {
    return (await this.post("/address_info", { _addresses: [address] }) as unknown[] | null)?.[0] ?? null;
  }

  async fetchProtocolParams(): Promise<ProtocolParams> {
    const result = await this.request("/epoch_params?limit=1") as Array<Record<string, unknown>> | null;
    if (!result || result.length === 0) throw new Error("Failed to fetch protocol params from Koios");
    const p = result[0]!;
    const costModels = p["cost_models"] as Record<string, number[]> | undefined;
    return {
      minFeeA: Number(p["min_fee_a"] ?? 44), minFeeB: Number(p["min_fee_b"] ?? 155381),
      coinsPerUtxoByte: Number(p["coins_per_utxo_size"] ?? 4310), costModelV3: costModels?.["PlutusV3"],
      priceMem: Number(p["price_mem"] ?? 0.0577), priceStep: Number(p["price_step"] ?? 0.0000721),
    };
  }
}

// ── Blockfrost provider (native fetch) ──────────────────────────────────────

const BLOCKFROST_URLS: Record<CardanoNetwork, string> = {
  mainnet: "https://cardano-mainnet.blockfrost.io/api/v0",
  preprod: "https://cardano-preprod.blockfrost.io/api/v0",
  preview: "https://cardano-preview.blockfrost.io/api/v0",
};

class BlockfrostProvider implements CardanoProvider {
  readonly name = "blockfrost";
  private baseUrl: string;
  private projectId: string;

  constructor(projectId: string, network: CardanoNetwork) {
    this.baseUrl = BLOCKFROST_URLS[network];
    this.projectId = projectId;
  }

  private async request(path: string, options?: RequestInit): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { "project_id": this.projectId, "Content-Type": "application/json", ...options?.headers },
    });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    throw new Error(`Blockfrost ${res.status}: ${await res.text()}`);
  }

  async fetchUtxos(address: string, asset?: string): Promise<unknown[]> {
    const path = asset ? `/addresses/${address}/utxos/${asset}` : `/addresses/${address}/utxos`;
    const all: unknown[] = [];
    let page = 1;
    while (true) {
      const result = await this.request(`${path}?page=${page}&order=asc`) as unknown[] | null;
      if (!result || result.length === 0) break;
      all.push(...result);
      if (result.length < 100) break;
      page++;
    }
    // Normalize Blockfrost format to Koios format so parseKoiosUtxos works on both
    return all.map((utxo) => {
      const u = utxo as Record<string, unknown>;
      const amounts = u["amount"] as Array<{ unit: string; quantity: string }> | undefined;
      const lovelace = amounts?.find(a => a.unit === "lovelace")?.quantity ?? "0";
      const assets = amounts?.filter(a => a.unit !== "lovelace").map(a => ({
        policy_id: a.unit.slice(0, 56),
        asset_name: a.unit.slice(56),
        quantity: a.quantity,
      })) ?? [];
      return {
        tx_hash: u["tx_hash"],
        tx_index: u["output_index"] ?? u["tx_index"],
        value: lovelace,
        asset_list: assets,
      };
    });
  }

  async fetchTip(): Promise<{ slot: number; block: number; time: number }> {
    const tip = await this.request("/blocks/latest") as Record<string, unknown> | null;
    if (!tip) throw new Error("Failed to fetch tip from Blockfrost");
    return { slot: Number(tip["slot"] ?? 0), block: Number(tip["height"] ?? 0), time: Number(tip["time"] ?? 0) };
  }

  async submitTx(txCbor: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/tx/submit`, {
      method: "POST", headers: { "project_id": this.projectId, "Content-Type": "application/cbor" },
      body: hexToBytes(txCbor),
    });
    if (!res.ok) throw new Error(`Blockfrost submit ${res.status}: ${await res.text()}`);
    return (await res.text()).replace(/"/g, "").trim();
  }

  async fetchTxMetadata(txHash: string): Promise<unknown[]> {
    return (await this.request(`/txs/${txHash}/metadata`) as unknown[] | null) ?? [];
  }

  async fetchAddressTransactions(address: string, options?: { count?: number; order?: "asc" | "desc" }): Promise<unknown[]> {
    const count = options?.count ?? 100;
    const order = options?.order ?? "desc";
    return (await this.request(`/addresses/${address}/transactions?count=${count}&order=${order}`) as unknown[] | null) ?? [];
  }

  async fetchAssetAddresses(asset: string): Promise<Array<{ address: string; quantity: string }>> {
    const result = await this.request(`/assets/${asset}/addresses`) as Array<Record<string, string>> | null;
    if (!result) return [];
    return result.map((r) => ({ address: r["address"] ?? "", quantity: r["quantity"] ?? "0" }));
  }

  async fetchAddressInfo(address: string): Promise<unknown> {
    return this.request(`/addresses/${address}`);
  }

  async fetchProtocolParams(): Promise<ProtocolParams> {
    const p = await this.request("/epochs/latest/parameters") as Record<string, unknown> | null;
    if (!p) throw new Error("Failed to fetch protocol params from Blockfrost");
    const costModels = p["cost_models"] as Record<string, unknown> | undefined;
    let costModelV3: number[] | undefined;
    if (costModels?.["PlutusV3"]) {
      const raw = costModels["PlutusV3"] as number[] | Record<string, number>;
      // Blockfrost returns a named dict; Koios returns an array.
      // Sort keys alphabetically to match the canonical ledger ordering.
      costModelV3 = Array.isArray(raw)
        ? raw
        : Object.keys(raw).sort().map(k => (raw as Record<string, number>)[k]!);
    }
    return {
      minFeeA: Number(p["min_fee_a"] ?? 44), minFeeB: Number(p["min_fee_b"] ?? 155381),
      coinsPerUtxoByte: Number(p["coins_per_utxo_size"] ?? "4310"), costModelV3,
      priceMem: Number(p["price_mem"] ?? "0.0577"), priceStep: Number(p["price_step"] ?? "0.0000721"),
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

let _provider: CardanoProvider | null = null;

/** Create or return a cached CardanoProvider. Uses Koios by default. */
export function getProvider(network: CardanoNetwork, blockfrostProjectId?: string, koiosUrl?: string): CardanoProvider {
  if (_provider) return _provider;
  _provider = blockfrostProjectId
    ? new BlockfrostProvider(blockfrostProjectId, network)
    : new KoiosProvider(network, koiosUrl);
  return _provider;
}

/** Reset the cached provider (for testing) */
export function resetProvider(): void {
  _provider = null;
}
