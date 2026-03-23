/** Cardano network type */
export type CardanoNetwork = "mainnet" | "preprod" | "preview";

/** Cardano native asset identifier */
export interface AssetId {
  policyId: string;   // 56 hex chars (28 bytes)
  assetName: string;  // hex-encoded asset name
}
