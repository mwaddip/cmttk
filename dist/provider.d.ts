/**
 * Chain query provider — abstracts Blockfrost and Koios behind a common interface.
 *
 * Default: Koios (free, no API key required).
 * Optional: Blockfrost (higher rate limits, requires project ID).
 *
 * Both providers use native fetch() — no external SDK dependencies.
 */
import type { CardanoNetwork } from "./types.js";
/** Common interface for chain queries. Both Koios and Blockfrost implement this. */
export interface CardanoProvider {
    readonly name: string;
    fetchUtxos(address: string, asset?: string): Promise<unknown[]>;
    fetchTip(): Promise<{
        slot: number;
        block: number;
        time: number;
    }>;
    submitTx(txCbor: string): Promise<string>;
    fetchTxMetadata(txHash: string): Promise<unknown[]>;
    fetchAddressTransactions(address: string, options?: {
        count?: number;
        order?: "asc" | "desc";
    }): Promise<unknown[]>;
    fetchAssetAddresses(asset: string): Promise<Array<{
        address: string;
        quantity: string;
    }>>;
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
/** Create or return a cached CardanoProvider. Uses Koios by default. */
export declare function getProvider(network: CardanoNetwork, blockfrostProjectId?: string, koiosUrl?: string): CardanoProvider;
/** Reset the cached provider (for testing) */
export declare function resetProvider(): void;
//# sourceMappingURL=provider.d.ts.map