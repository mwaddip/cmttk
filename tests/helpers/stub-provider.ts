// tests/helpers/stub-provider.ts
import type { CardanoProvider, ProtocolParams } from "../../src/provider.js";

export type StubProvider = CardanoProvider & { submitLog: string[] };

/** Minimal CardanoProvider stub that returns canned UTxOs + protocol params. */
export function stubProvider(opts: {
  utxos: unknown[];
  pp: ProtocolParams;
  tip?: { slot: number; block: number; time: number };
  submitResponse?: string;
}): StubProvider {
  const submitLog: string[] = [];
  const prov: StubProvider = {
    name: "stub",
    submitLog,
    async fetchUtxos() { return opts.utxos; },
    async fetchTip() { return opts.tip ?? { slot: 1_000_000, block: 100, time: Date.now() }; },
    async submitTx(cborHex: string) { submitLog.push(cborHex); return opts.submitResponse ?? "stub_tx_hash"; },
    async fetchTxMetadata() { return []; },
    async fetchAddressTransactions() { return []; },
    async fetchAssetAddresses() { return []; },
    async fetchAddressInfo() { return null; },
    async fetchProtocolParams() { return opts.pp; },
  };
  return prov;
}
