// Phase 4b 実機検証ハーネス用の Worker 診断フック。
// 本番の `src/worker.js` を変更せず、Worker 内の console.warn / console.error /
// error / unhandledrejection をメインスレッドへ転送してハーネス診断へ集計する。

function formatDiagArgs(args) {
  return args.map((arg) => {
    if (arg instanceof Error) return arg.stack || arg.message || String(arg);
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');
}

function emitDiag(level, args) {
  try {
    self.postMessage({
      type: '__harness_diag__',
      level,
      message: formatDiagArgs(args),
      ts: new Date().toISOString(),
    });
  } catch {
    // Worker 終了直前の postMessage 失敗は無視
  }
}

const origWarn = typeof console.warn === 'function' ? console.warn.bind(console) : null;
const origError = typeof console.error === 'function' ? console.error.bind(console) : null;

console.warn = (...args) => {
  emitDiag('warn', args);
  if (origWarn) origWarn(...args);
};

console.error = (...args) => {
  emitDiag('error', args);
  if (origError) origError(...args);
};

self.addEventListener('error', (ev) => {
  emitDiag('workererror', [ev?.message || String(ev?.error || ev)]);
});

self.addEventListener('unhandledrejection', (ev) => {
  emitDiag('unhandledrejection', [ev?.reason ?? 'unhandledrejection']);
});
