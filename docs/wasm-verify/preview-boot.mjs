// Bootstrap for miniapp HTTPS preview /wasm-verify/ page.
// Configures relative URLs for the reused Phase 4b browser-harness.mjs and wires the
// separate miniapp app-route verification panel.

import { runMiniappAppRouteVerification } from './app-route-check.mjs';

const resolveUrl = (rel) => new URL(rel, import.meta.url).href;

let engineMetadata = null;
try {
  const resp = await fetch(resolveUrl('../backgammon/assets/metadata.json'));
  if (resp.ok) engineMetadata = await resp.json();
} catch {
  engineMetadata = null;
}

window.__HARNESS_CONFIG__ = {
  workerUrl: resolveUrl('./harness-worker.mjs'),
  modelUrl: resolveUrl('../backgammon/src/model.json'),
  bearoffUrl: resolveUrl('../backgammon/src/bearoff-6x15.bin'),
  moneyBearoffUrl: resolveUrl('../backgammon/src/money-bg2n-6x6-v4.bin'),
  pruneNetUrl: resolveUrl('../backgammon/src/prune_net.json'),
  wasmSimdUrl: resolveUrl('./engine-pkg/assets/bg_engine_simd.wasm'),
  wasmScalarUrl: resolveUrl('./engine-pkg/assets/bg_engine_scalar.wasm'),
  fallbackMimeScalarUrl: resolveUrl('./fallback-mime/bg_engine_scalar.wasm.bin'),
  fixtureUrl: resolveUrl('./fixtures/positions.json'),
  previewMetadata: {
    target: 'miniapp-https-preview',
    deliveryUrl: window.location.href,
    engineSourceSha: engineMetadata?.engineSourceSha ?? '727ae5559be62b2f8992a37e2fa469fc16123997',
    enginePackageVersion: engineMetadata?.enginePackageVersion ?? '0.2.8-wasm-preview.727ae55',
    wasmScalarSha256: engineMetadata?.wasmScalarSha256 ?? null,
    wasmSimdSha256: engineMetadata?.wasmSimdSha256 ?? null,
    modelSha256: engineMetadata?.modelSha256 ?? null,
    moneyBearoffSha256: engineMetadata?.moneyBearoffSha256 ?? null,
  },
};

const appRouteBtn = document.getElementById('app-route-run-btn');
const appRouteStatus = document.getElementById('app-route-status');
const appRouteLog = document.getElementById('app-route-log');

async function executeAppRouteCheck() {
  if (!appRouteBtn || !appRouteStatus || !appRouteLog) return;
  appRouteBtn.disabled = true;
  appRouteStatus.className = 'soak-box active';
  appRouteStatus.textContent = 'RUNNING — miniapp 実経路診断 (ThinkerPool 4-Worker) を実行中...';
  const lines = [];
  const log = (msg) => {
    lines.push(`[${new Date().toISOString()}] ${msg}`);
    appRouteLog.textContent = lines.join('\n');
  };
  const result = await runMiniappAppRouteVerification(log);
  window.__APP_ROUTE_VERIFY__ = result;
  appRouteStatus.className = `soak-box ${result.passed ? 'pass' : 'fail'}`;
  if (result.passed) {
    const variants = result.poolBackend?.wasmVariants?.join('/') || 'wasm';
    appRouteStatus.textContent = [
      `PASS — miniapp 実経路 (ThinkerPool ${result.poolBackend?.workerCount ?? 0}w) WASM (${variants}) / JS パリティ一致`,
      `champion staged3ply: ${result.parity?.championStaged3Ply?.wasmMs} ms | expert hint: ${result.parity?.expertHint2Ply?.wasmMs} ms`,
      `Linear memory: ${result.memory?.totalMiB} MiB total (${result.memory?.perWorkerMiB?.join(', ')} MiB)`,
    ].join('\n');
  } else {
    appRouteStatus.textContent = `FAIL — miniapp 実経路診断で失敗がありました: ${result.error ?? '下段 JSON を確認してください'}`;
  }
  appRouteBtn.disabled = false;
  if (typeof window.__REFRESH_VERIFY_JSON__ === 'function') {
    window.__REFRESH_VERIFY_JSON__();
  }
}

appRouteBtn?.addEventListener('click', () => {
  executeAppRouteCheck();
});

// Load the reused Phase 4b browser harness (auto-runs on import)
await import('./browser-harness.mjs');
