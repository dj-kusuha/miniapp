// Phase 4b 実機検証ハーネス用 Worker エントリ（Issue #587 HTTPS preview 再利用版）。
// ESM 静的 import 評価順により、まず診断フックを登録したあとで `engine-pkg/src/worker.js` を読み込む。
// さらに Worker 内の Secure Context / crypto.subtle 可用性を事前検査する軽量プローブ
// (`__harness_env_probe__`) のみをインターセプトする。
import './harness-worker-hooks.mjs';
import './engine-pkg/src/worker.js';

const workerOnMessage = self.onmessage;
self.onmessage = (event) => {
  if (event?.data?.kind === '__harness_env_probe__') {
    const id = event.data.id;
    self.postMessage({
      id,
      ok: true,
      isSecureContext: Boolean(self.isSecureContext),
      hasSubtleDigest: typeof self.crypto?.subtle?.digest === 'function',
    });
    return;
  }
  if (typeof workerOnMessage === 'function') {
    return workerOnMessage(event);
  }
  return undefined;
};
