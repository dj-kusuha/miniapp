export const ENGINE_PACKAGE_VERSION = '0.2.8-wasm-preview.727ae55';
export const DEFAULT_MODEL_VERSION = 'cycle700';

export const PRUNE_NET_METADATA = Object.freeze({
  id: 'prune-64-32-d0-1m-cycle700',
  hiddenDims: Object.freeze([64, 32]),
  parameters: 14_981,
  bytes: 317_382,
  sha256: '2c75561140f7532f452c2c83a8e557467d366e1591df1328f087432436dc3dff',
  targetModelSha256: '9543ecb1deaff716de1355726d3109f1529fe34e0ab68d94284654fd7871dd83',
  defaultLeafPruneCandidates: 7,
  defaultLeafPruneTolerance: 0.200,
  assetExport: '@dj-kusuha/backgammon-engine/assets/prune-net',
  relativeAssetPath: 'assets/prune_net.json',
});

export const MONEY_BEAROFF_METADATA = Object.freeze({
  id: 'money-bg2n-6x6-v4',
  format: 'BG2N',
  formatVersion: 4,
  valueFormat: 'uint16-symmetric-q32767',
  maximumCheckers: 6,
  sideCount: 923,
  recordCount: 5_111_574,
  bytes: 10_223_244,
  sha256: '2ddee6d0b8285c8f755e0fe027bb5c66b678269a9dc89427f8ae9921d4a7daa1',
  payloadSha256: 'e03d9e57b641ab4854ab0021fa6ef8fc2945ee2bf4d47c76b026e82f2a0ef01d',
  sourceSha256: 'b594caed010b59d7b91b0b3e99201e8da553c325423385bd6b01f4bba3acd658',
  assetExport: '@dj-kusuha/backgammon-engine/assets/money-bearoff',
  relativeAssetPath: 'assets/money-bg2n-6x6-v4.bin',
});

export const WASM_ASSETS_METADATA = Object.freeze({
  abiVersion: 1,
  scalar: Object.freeze({
    assetExport: '@dj-kusuha/backgammon-engine/assets/wasm-scalar',
    relativeAssetPath: 'assets/bg_engine_scalar.wasm',
  }),
  simd: Object.freeze({
    assetExport: '@dj-kusuha/backgammon-engine/assets/wasm-simd',
    relativeAssetPath: 'assets/bg_engine_simd.wasm',
  }),
});

export function validateBundledPruneNetPair({
  modelSha256,
  pruneNetBytes,
  pruneNetSha256,
}) {
  if (
    pruneNetBytes !== PRUNE_NET_METADATA.bytes
    || pruneNetSha256 !== PRUNE_NET_METADATA.sha256
  ) {
    throw new Error(
      `Prune net asset integrity check failed: bytes=${pruneNetBytes}, sha256=${pruneNetSha256}`,
    );
  }
  if (modelSha256 !== PRUNE_NET_METADATA.targetModelSha256) {
    throw new Error(
      `Model/Prune net pairing mismatch: td_gammon.json sha256=${modelSha256}`
      + ` != expected targetModelSha256=${PRUNE_NET_METADATA.targetModelSha256}`,
    );
  }
}

export function modelVersionFromModelData(data) {
  if (data?.model_version) return String(data.model_version);
  const note = String(data?.note ?? '');
  const cycle = note.match(/(?:^|\b)cycle[_ -]?(\d+)\b/i);
  return cycle ? `cycle${cycle[1]}` : DEFAULT_MODEL_VERSION;
}

export function runtimeMetadata(modelData) {
  return {
    enginePackageVersion: ENGINE_PACKAGE_VERSION,
    modelVersion: modelVersionFromModelData(modelData),
  };
}
