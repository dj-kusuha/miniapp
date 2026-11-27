import {
  BearoffDatabase,
  Board,
  NeuralNet,
  analyzeChecker,
  analyzeCube,
  detectWasmSimdSupport,
  disposeWasmEngine,
  getEngineBackend,
  getEngineBackendStatus,
  getLegalMoves,
  initWasmEngine,
  setBearoffDatabase,
  setEngineBackend,
  setPruneNet,
} from './engine-pkg/src/index.js';

const HARNESS_CFG = globalThis.__HARNESS_CONFIG__ ?? {};
const HARNESS_WORKER_URL = HARNESS_CFG.workerUrl ?? '/benchmarks/issue578/harness-worker.mjs';
const MODEL_ASSET_URL = HARNESS_CFG.modelUrl ?? '/assets/td_gammon.json';
const BEAROFF_ASSET_URL = HARNESS_CFG.bearoffUrl ?? '/assets/bearoff-6x15.bin';
const MONEY_BEAROFF_ASSET_URL = HARNESS_CFG.moneyBearoffUrl ?? '/assets/money-bg2n-6x6-v4.bin';
const PRUNE_NET_ASSET_URL = HARNESS_CFG.pruneNetUrl ?? '/assets/prune_net.json';
const WASM_SIMD_ASSET_URL = HARNESS_CFG.wasmSimdUrl ?? '/assets/bg_engine_simd.wasm';
const WASM_SCALAR_ASSET_URL = HARNESS_CFG.wasmScalarUrl ?? '/assets/bg_engine_scalar.wasm';
const FALLBACK_MIME_SCALAR_URL = HARNESS_CFG.fallbackMimeScalarUrl ?? '/fallback-mime/assets/bg_engine_scalar.wasm';
const PARITY_FIXTURE_URL = HARNESS_CFG.fixtureUrl ?? '/benchmarks/issue353/positions.json';
const HISTORY_STORAGE_KEY = 'bg_issue578_phase4b_device_history_v1';
const STORAGE_PROBE_KEY = '__bg_issue578_phase4b_storage_probe__';
const DEFAULT_RPC_TIMEOUT_MS = 60_000;
const PERSISTENT_RPC_TIMEOUT_MS = 45_000;

const SINGLE_WORKER_STANDARD_MAX_MIB = 20;
const FOUR_WORKER_STANDARD_MAX_MIB = 80;
// money-bg2n-6x6-v4.bin (~9.75 MiB) is lazily uploaded on first unboundedMoney 6x6 cube query
// (staging buffer + parsed Vec<u16> table adds ~20 MiB peak linear memory per worker).
const SINGLE_WORKER_BG2N_MAX_MIB = 42;
const FOUR_WORKER_BG2N_MAX_MIB = 168;

const POOL_ROLLS = [[3, 1], [6, 1], [4, 2], [5, 3]];
const CHAMPION_POOL_ROLLS = [[4, 3], [6, 5], [5, 2], [4, 1]];

const REQUIRED_AUTO_CHECK_KEYS = [
  'secureContext',
  'defaultAutoBackend',
  'mainThreadSimd',
  'mimeFallbackScalar',
  'mainThreadParity',
  'webWorker',
  'fourWorkerPool',
  'diagnostics',
];

const LOAD_PAYLOAD_BASE = {
  kind: 'load',
  url: MODEL_ASSET_URL,
  bearoffUrl: BEAROFF_ASSET_URL,
  moneyBearoffUrl: MONEY_BEAROFF_ASSET_URL,
  pruneNetUrl: PRUNE_NET_ASSET_URL,
};

// 配布パッケージ相当の既定 URL 経路（wasmSimdUrl / wasmScalarUrl 省略 -> usesDefaultAssets=true -> 再 load で runtime 再利用）
const LOAD_PAYLOAD_DEFAULT_AUTO = {
  ...LOAD_PAYLOAD_BASE,
};

// 明示 URL 経路（同一 Worker 内で runtime を作り直すピークメモリ耐性シナリオ用）
const LOAD_PAYLOAD_EXPLICIT_URLS = {
  ...LOAD_PAYLOAD_BASE,
  wasmVariant: 'auto',
  wasmSimdUrl: WASM_SIMD_ASSET_URL,
  wasmScalarUrl: WASM_SCALAR_ASSET_URL,
};

function makeRunId(prefix) {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function formatArgs(args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message || String(a);
    if (typeof a === 'string') return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }).join(' ');
}

function toMiB(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? Number((bytes / (1024 * 1024)).toFixed(2)) : Number.NaN;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sameHandles(a, b) {
  if (!a || !b) return false;
  const keys = ['mlp', 'cubeHead', 'bearoff', 'bg2n', 'met'];
  return keys.every((k) => a[k] === b[k]);
}

function hasExpectedFullHandles(handles) {
  return Boolean(
    handles
    && handles.mlp === 2
    && handles.cubeHead === 1
    && handles.bearoff === 1
    && handles.bg2n === 1
    && handles.met === 1,
  );
}

// ── メインスレッド + Worker 診断ログ捕捉（遅延ログ即時/直前反映対応）────────

const diagnostics = {
  consoleErrors: [],
  consoleWarnings: [],
  pageErrors: [],
  workerErrors: [],
  workerWarnings: [],
};

let autoSuiteCompletedNormally = false;
let autoSuiteFatalError = null;
let autoSuiteChecks = {};
let diagRefreshTimer = null;

function scheduleDiagnosticsRefresh() {
  if (!window.__VERIFY_DONE__) return;
  if (diagRefreshTimer !== null) return;
  diagRefreshTimer = setTimeout(() => {
    diagRefreshTimer = null;
    refreshVerifyResultObject();
  }, 50);
}

const origConsoleError = typeof console.error === 'function' ? console.error.bind(console) : null;
const origConsoleWarn = typeof console.warn === 'function' ? console.warn.bind(console) : null;

console.error = (...args) => {
  diagnostics.consoleErrors.push({ ts: new Date().toISOString(), message: formatArgs(args) });
  if (origConsoleError) origConsoleError(...args);
  scheduleDiagnosticsRefresh();
};

console.warn = (...args) => {
  diagnostics.consoleWarnings.push({ ts: new Date().toISOString(), message: formatArgs(args) });
  if (origConsoleWarn) origConsoleWarn(...args);
  scheduleDiagnosticsRefresh();
};

window.addEventListener('error', (ev) => {
  diagnostics.pageErrors.push({
    ts: new Date().toISOString(),
    message: ev?.message || String(ev?.error || 'window error'),
  });
  scheduleDiagnosticsRefresh();
});

window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev?.reason;
  diagnostics.pageErrors.push({
    ts: new Date().toISOString(),
    message: `unhandledrejection: ${reason instanceof Error ? (reason.stack || reason.message) : String(reason)}`,
  });
  scheduleDiagnosticsRefresh();
});

function buildDiagnosticsCheck() {
  const totalIssues = diagnostics.consoleErrors.length
    + diagnostics.consoleWarnings.length
    + diagnostics.pageErrors.length
    + diagnostics.workerErrors.length
    + diagnostics.workerWarnings.length;
  return {
    consoleErrorCount: diagnostics.consoleErrors.length,
    consoleWarningCount: diagnostics.consoleWarnings.length,
    pageErrorCount: diagnostics.pageErrors.length,
    workerErrorCount: diagnostics.workerErrors.length,
    workerWarningCount: diagnostics.workerWarnings.length,
    totalIssues,
    consoleErrors: [...diagnostics.consoleErrors],
    consoleWarnings: [...diagnostics.consoleWarnings],
    pageErrors: [...diagnostics.pageErrors],
    workerErrors: [...diagnostics.workerErrors],
    workerWarnings: [...diagnostics.workerWarnings],
    scopeNote: 'Captures JS console.error/warn, window error/unhandledrejection, and Worker forwarded console/error events (including delayed logs arriving after suite/session steps). Browser-native DevTools logs (network/CSP/browser warnings outside JS) are NOT visible to page JS and must be checked via Remote Inspector.',
    passed: totalIssues === 0,
  };
}

// ── 永続履歴（localStorage / sessionStorage 両読み統合 & 書込検証で OOM 検知漏れ防止）──

function probeWritableStorage(storeName) {
  try {
    const store = window[storeName];
    if (!store) return false;
    const token = makeRunId('probe');
    store.setItem(STORAGE_PROBE_KEY, token);
    const readBack = store.getItem(STORAGE_PROBE_KEY);
    store.removeItem(STORAGE_PROBE_KEY);
    return readBack === token;
  } catch {
    return false;
  }
}

function pickPreferredWritableStorage() {
  if (probeWritableStorage('localStorage')) return 'localStorage';
  if (probeWritableStorage('sessionStorage')) return 'sessionStorage';
  return 'memory-only';
}

function safeReadStoreRecord(storeName) {
  try {
    const store = window[storeName];
    if (!store) return null;
    const raw = store.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      persistentSessions: Array.isArray(parsed.persistentSessions) ? parsed.persistentSessions : [],
    };
  } catch {
    return null;
  }
}

function chooseNewerSession(a, b) {
  const stepsA = Array.isArray(a.steps) ? a.steps.length : 0;
  const stepsB = Array.isArray(b.steps) ? b.steps.length : 0;
  if (stepsB !== stepsA) return stepsB > stepsA ? b : a;
  const tsA = String(a.lastHeartbeatAt || a.endedAt || a.startedAt || '');
  const tsB = String(b.lastHeartbeatAt || b.endedAt || b.startedAt || '');
  if (tsB !== tsA) return tsB > tsA ? b : a;
  if (b.cleanlyTerminated && !a.cleanlyTerminated) return b;
  return a;
}

function mergeHistoryRecords(records) {
  const runsById = new Map();
  const sessionsById = new Map();
  for (const rec of records) {
    if (!rec) continue;
    for (const run of rec.runs) {
      if (!run || !run.pageRunId) continue;
      const prev = runsById.get(run.pageRunId);
      if (!prev || (!prev.completedAt && run.completedAt)) {
        runsById.set(run.pageRunId, run);
      }
    }
    for (const sess of rec.persistentSessions) {
      if (!sess || !sess.sessionId) continue;
      const prev = sessionsById.get(sess.sessionId);
      sessionsById.set(sess.sessionId, prev ? chooseNewerSession(prev, sess) : sess);
    }
  }
  const sortByStart = (a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || ''));
  return {
    runs: [...runsById.values()].sort(sortByStart).slice(-20),
    persistentSessions: [...sessionsById.values()].sort(sortByStart).slice(-20),
  };
}

function readHistoryStorage() {
  // localStorage.getItem が空を返しても setItem 失敗で sessionStorage へ書かれている場合があるため、
  // 両ストレージから読み出して統合し、さらに実際に書き込み可能なストレージを判定する。
  const sourcesRead = [];
  const records = [];
  for (const storeName of ['localStorage', 'sessionStorage']) {
    const rec = safeReadStoreRecord(storeName);
    if (rec) {
      sourcesRead.push(storeName);
      records.push(rec);
    }
  }
  const merged = mergeHistoryRecords(records);
  const writableStore = pickPreferredWritableStorage();
  return {
    storage: writableStore,
    sourcesRead,
    runs: merged.runs,
    persistentSessions: merged.persistentSessions,
  };
}

function writeHistoryStorage(data) {
  const payload = JSON.stringify({
    runs: (data.runs || []).slice(-20),
    persistentSessions: (data.persistentSessions || []).slice(-20),
  });
  for (const storeName of ['localStorage', 'sessionStorage']) {
    try {
      const store = window[storeName];
      if (!store) continue;
      store.setItem(HISTORY_STORAGE_KEY, payload);
      if (store.getItem(HISTORY_STORAGE_KEY) === payload) {
        return storeName;
      }
    } catch {
      // try next fallback
    }
  }
  return 'memory-only';
}

function clearHistoryStorage() {
  for (const storeName of ['localStorage', 'sessionStorage']) {
    try {
      window[storeName]?.removeItem(HISTORY_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

const pageRunId = makeRunId('page');
const pageStartedAt = new Date().toISOString();
const historyState = readHistoryStorage();
const uncleanPreviousSessions = historyState.persistentSessions.filter(
  (s) => s && s.cleanlyTerminated === false,
);
const currentRunRecord = {
  pageRunId,
  startedAt: pageStartedAt,
  completedAt: null,
  autoPassed: null,
  userAgent: navigator.userAgent,
};
historyState.runs.push(currentRunRecord);
historyState.storage = writeHistoryStorage(historyState);

function persistHistory() {
  historyState.storage = writeHistoryStorage(historyState);
}

// ── Worker RPC（タイムアウト & 診断ログ転送対応）──────────────────────────

function rpcWorker(worker, { label = 'worker', timeoutMs = DEFAULT_RPC_TIMEOUT_MS } = {}) {
  let nextId = 1;
  const pending = new Map();

  const rejectAll = (err) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  };

  worker.onmessage = (ev) => {
    const data = ev.data;
    if (data && data.type === '__harness_diag__') {
      const item = {
        ts: data.ts || new Date().toISOString(),
        worker: label,
        level: data.level,
        message: data.message,
      };
      if (data.level === 'warn') {
        diagnostics.workerWarnings.push(item);
      } else {
        diagnostics.workerErrors.push(item);
      }
      scheduleDiagnosticsRefresh();
      return;
    }
    const entry = pending.get(data?.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok) entry.resolve(data);
    else entry.reject(new Error(data.error || 'worker error'));
  };

  worker.onerror = (ev) => {
    const msg = ev?.message || 'worker error event';
    diagnostics.workerErrors.push({
      ts: new Date().toISOString(),
      worker: label,
      level: 'onerror',
      message: msg,
    });
    scheduleDiagnosticsRefresh();
    rejectAll(new Error(`[${label}] ${msg}`));
  };

  worker.onmessageerror = () => {
    const msg = 'worker messageerror event';
    diagnostics.workerErrors.push({
      ts: new Date().toISOString(),
      worker: label,
      level: 'messageerror',
      message: msg,
    });
    scheduleDiagnosticsRefresh();
    rejectAll(new Error(`[${label}] ${msg}`));
  };

  return (payload, overrideTimeoutMs = timeoutMs) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`[${label}] RPC timeout after ${overrideTimeoutMs} ms (kind=${payload.kind})`));
    }, overrideTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, ...payload });
  });
}

function makeInitialBoardJson() {
  const initBoard = new Board();
  return {
    points: [...initBoard.points],
    bar: [initBoard.bar.WHITE, initBoard.bar.BLACK],
    off: [initBoard.off.WHITE, initBoard.off.BLACK],
  };
}

function makeBg2n6x6BoardJson() {
  const pts = new Array(24).fill(0);
  // White (5 checkers in home 0..5): 2 on pt0, 1 on pt1, 1 on pt3, 1 on pt5
  pts[0] = 2;
  pts[1] = 1;
  pts[3] = 1;
  pts[5] = 1;
  // Black (5 checkers in home 18..23): symmetric mirror
  pts[23] = -1;
  pts[22] = -2;
  pts[20] = -1;
  pts[18] = -1;
  return {
    points: pts,
    bar: [0, 0],
    off: [10, 10],
  };
}

// ── 実機専用: 4-Worker BG2N 持続セッション（長時間稼働・再ロード・復帰検証）──

const persistentPoolState = {
  active: false,
  busy: false,
  workers: [],
  rpcs: [],
  session: null,
  baselineChampionKeys: null,
  expectedExpertSelectKeys: null, // 独立 JS 基準 (4 workers)
  expectedStandardCube: null, // { white: boolean, black: boolean } 独立 JS 基準
  expectedBg2n: null, // { white: boolean, black: boolean } 独立 JS 基準
  expectedChampionWorker0Key: null, // 自動スイート 3-ply champion (WHITE 4-3) 基準
  expectedAutoVariant: null,
  simdSupported: null,
  heartbeatTimer: null,
};

function evaluatePersistentGate(session) {
  if (!session) {
    return {
      status: 'not_run',
      passed: false,
      details: {
        started: false,
        reloadedDefaultReuse: false,
        reloadedExplicitSwap: false,
        resumedRequery: false,
        disposedCleanly: false,
        allStepsPassed: false,
        championWorkloadExecuted: false,
      },
    };
  }
  const steps = Array.isArray(session.steps) ? session.steps : [];
  const allStepsPassed = steps.length > 0 && steps.every((s) => s.passed === true);
  const started = steps.some((s) => s.action === 'start' && s.passed === true);
  const reloadedDefaultReuse = steps.some(
    (s) => s.action === 'reload_default_reuse' && s.passed === true,
  );
  const reloadedExplicitSwap = steps.some(
    (s) => s.action === 'reload_explicit_swap' && s.passed === true,
  );
  const resumedRequery = steps.some(
    (s) => s.action === 'resume_requery' && s.passed === true,
  );
  const disposedCleanly = Boolean(session.cleanlyTerminated)
    && steps.some((s) => s.action === 'dispose_terminate' && s.passed === true);
  const championWorkloadExecuted = steps.some(
    (s) => s.championWorkloadExecuted === true && s.passed === true,
  );

  const passed = !persistentPoolState.active
    && allStepsPassed
    && started
    && reloadedDefaultReuse
    && resumedRequery
    && disposedCleanly
    && championWorkloadExecuted;

  let status;
  if (persistentPoolState.active) {
    status = allStepsPassed ? 'running' : 'failed';
  } else if (passed) {
    status = 'passed';
  } else {
    status = 'failed';
  }

  return {
    status,
    passed,
    details: {
      started,
      reloadedDefaultReuse,
      reloadedExplicitSwap,
      resumedRequery,
      disposedCleanly,
      allStepsPassed,
      championWorkloadExecuted,
    },
  };
}

// ── 実機 UI 描画 & クリップボード/保存 ────────────────────────────────────

function syncOutputElements(result) {
  const jsonText = JSON.stringify(result, null, 2);
  const outEl = document.getElementById('out');
  if (outEl) outEl.textContent = jsonText;
  const copyBox = document.getElementById('json-copy-box');
  if (copyBox) copyBox.value = jsonText;
}

function renderUncleanSessionBanner() {
  const banner = document.getElementById('oom-banner');
  if (!banner) return;
  if (uncleanPreviousSessions.length === 0) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  const latest = uncleanPreviousSessions[uncleanPreviousSessions.length - 1];
  banner.hidden = false;
  banner.textContent = [
    `[警告] 未終了の 4-Worker 持続セッションが ${uncleanPreviousSessions.length} 件検出されました（iOS Jetsam / OOM 強制再起動またはタブ強制終了の可能性あり）。`,
    `最新未終了セッション: ${latest.sessionId} (開始=${latest.startedAt}, 最終ハートビート=${latest.lastHeartbeatAt || 'n/a'}, ステップ数=${(latest.steps || []).length})`,
    'テストをやり直す場合は確認後に「履歴をクリア」を押してください。',
  ].join('\n');
}

function renderDeviceSummary(result) {
  const summaryEl = document.getElementById('summary');
  if (!summaryEl) return;
  const d = result.diagnostics || buildDiagnosticsCheck();
  const pStatus = result.persistentStatus || 'not_run';
  const gateText = result.deviceGatePassed ? 'PASS' : `NOT MET (auto=${result.allPassed}, persistent=${pStatus}, diagIssues=${d.totalIssues}, uncleanPrev=${uncleanPreviousSessions.length})`;

  if (result.error) {
    summaryEl.className = 'fail';
    summaryEl.textContent = [
      `STATUS: FAIL (Auto Suite Fatal Error) | Device Auto Gate: ${gateText}`,
      `Page Run ID: ${pageRunId} (history storage=${historyState.storage}, uncleanPrev=${uncleanPreviousSessions.length})`,
      `Error: ${result.error}`,
      `Captured diagnostics (JS/Worker): consoleErr=${d.consoleErrorCount}, consoleWarn=${d.consoleWarningCount}, pageErr=${d.pageErrorCount}, workerErr=${d.workerErrorCount}, workerWarn=${d.workerWarningCount}`,
    ].join('\n');
    return;
  }
  const def = result.defaultAutoBackend || {};
  const mp = result.mainThreadParity || {};
  const w = result.webWorker || {};
  const p = result.fourWorkerPool || {};
  const statusText = result.allPassed
    ? 'ALL PASS (自動スイート + JS/Worker 捕捉ログ 0 件)'
    : `FAIL (自動スイート失敗 または JS/Worker 捕捉エラー/警告あり: totalIssues=${d.totalIssues})`;
  const persistentLabel = pStatus === 'passed'
    ? 'PASS'
    : (pStatus === 'not_run' ? 'NOT RUN (未実施)' : pStatus.toUpperCase());
  const storageWarning = historyState.storage === 'memory-only'
    ? ' [注意: memory-only のため OOM 赤バナー検知不可 — 同一 pageRunId/sessionId + hidden->visible + 復帰再照会で判定]'
    : '';
  summaryEl.className = result.allPassed && pStatus !== 'failed' ? 'pass' : 'fail';
  summaryEl.textContent = [
    `AUTO SUITE: ${statusText}`,
    `PERSISTENT 4-WORKER BG2N: ${persistentLabel} | DEVICE AUTO GATE: ${gateText}`,
    `Page Run ID: ${pageRunId} (history storage=${historyState.storage}, readFrom=[${historyState.sourcesRead.join(',')}], uncleanPrev=${uncleanPreviousSessions.length})${storageWarning}`,
    `Default backend: ${def.initialConfiguredBackend} -> ${def.postInitActiveBackend} (${def.postInitVariant}, simd=${def.postInitSimdActive})`,
    `2-ply speedup: ${mp.speedup}x (JS ${mp.jsCheckerMs} ms -> WASM ${mp.wasmCheckerMs} ms, diff=${mp.checkerDiff})`,
    `1-Worker memory: standard=${w.singleWorkerLinearMemoryMiB} MiB (<= ${w.singleWorkerStandardBudgetMiB}) | BG2N=${w.singleWorkerWithBg2nLinearMemoryMiB} -> ${w.singleWorkerWithBg2nAfterReloadMiB} MiB (<= ${w.singleWorkerBg2nBudgetMiB})`,
    `4-Worker memory: standard=${p.totalLinearMemoryMiB} MiB (<= ${p.poolStandardBudgetMiB}) | BG2N=${p.totalWithBg2nLinearMemoryMiB} MiB (<= ${p.poolBg2nBudgetMiB}) [WASM linear only; JS heap separate]`,
    `3-ply champion (telemetry): ${w.worker3PlyWorldClassMs} ms | max rAF gap: ${w.maxRafGapMs} ms (n=${w.rafFrameCount})`,
    `Captured diagnostics (JS/Worker): consoleErr=${d.consoleErrorCount}, consoleWarn=${d.consoleWarningCount}, pageErr=${d.pageErrorCount}, workerErr=${d.workerErrorCount}, workerWarn=${d.workerWarningCount}`,
    '※ deviceGatePassed はページ内自動項目（自動スイート + 持続セッション基本ステップ + JS/Worker 捕捉ログ 0 件 + 未終了履歴 0 件）のみを表します。',
    '※ 実機必須ゲートの完了には、反復リロード 2〜3 回・復帰 4 点生存（同一 ID / hidden->visible / 再照会 / storage）・リモートインスペクタ確認（ネイティブログ 0 件）の手動確認が別途必須です。',
  ].join('\n');
}

function wireDeviceUiButtons() {
  const reloadBtn = document.getElementById('reload-btn');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => window.location.reload());
  }

  const copyBtn = document.getElementById('copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      // コピー直前に必ず最新の遅延ログ・持続セッション状態を再集計する
      refreshVerifyResultObject();
      const text = JSON.stringify(window.__VERIFY_RESULT__ ?? {}, null, 2);
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = 'コピーしました (Clipboard API)';
          return;
        } catch {
          // 非セキュア HTTP (LAN) 等では失敗するため textarea 経由へフォールバック
        }
      }
      const box = document.getElementById('json-copy-box');
      if (box) {
        box.value = text;
        box.focus();
        box.select();
        try {
          box.setSelectionRange(0, text.length);
        } catch {
          // ignore on unsupported inputs
        }
        try {
          if (typeof document.execCommand === 'function' && document.execCommand('copy')) {
            copyBtn.textContent = 'コピーしました (execCommand)';
            return;
          }
        } catch {
          // ignore
        }
        copyBtn.textContent = '下のテキスト欄を選択しました — 手動コピーしてください';
      } else {
        copyBtn.textContent = '下の JSON を手動コピーしてください';
      }
    });
  }

  const downloadBtn = document.getElementById('download-btn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      // ダウンロード直前に必ず最新の遅延ログ・持続セッション状態を再集計する
      refreshVerifyResultObject();
      const text = JSON.stringify(window.__VERIFY_RESULT__ ?? {}, null, 2);
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `phase4b-device-verify-${pageRunId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
      downloadBtn.textContent = 'JSON を保存しました';
    });
  }
}

function refreshVerifyResultObject() {
  if (!window.__VERIFY_DONE__) return;
  const diagCheck = buildDiagnosticsCheck();
  const checksSnapshot = { ...autoSuiteChecks, diagnostics: diagCheck };

  // fail-closed: 自動スイートが例外終了した・必須チェックが欠けている場合は絶対に allPassed=false を維持
  const autoAllPassed = autoSuiteCompletedNormally
    && autoSuiteFatalError === null
    && REQUIRED_AUTO_CHECK_KEYS.every((k) => checksSnapshot[k]?.passed === true);

  const persistentGate = evaluatePersistentGate(persistentPoolState.session);
  const deviceGatePassed = Boolean(
    autoAllPassed
    && persistentGate.passed
    && diagCheck.passed
    && uncleanPreviousSessions.length === 0,
  );

  const nextResult = {
    allPassed: autoAllPassed,
    persistentStatus: persistentGate.status,
    persistentPassed: persistentGate.passed,
    persistentGateDetails: persistentGate.details,
    deviceGatePassed,
    deviceGateNote: 'Automated in-page gate subset only (auto suite + baseline persistent 4-Worker steps + 0 captured JS/Worker logs + 0 unclean history). Final real-device gate additionally requires manual verification of 2-3x reloads, 4-point background resume survival (same pageRunId/sessionId, hidden->visible, re-query PASS, non-memory-only storage), and 0 Remote Inspector native logs.',
    pageRunId,
    recordedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    previewMetadata: HARNESS_CFG.previewMetadata ?? null,
    appRouteVerification: window.__APP_ROUTE_VERIFY__ ?? null,
    ...(autoSuiteFatalError !== null ? { error: autoSuiteFatalError } : {}),
    ...checksSnapshot,
    persistentHistory: {
      storage: historyState.storage,
      sourcesRead: historyState.sourcesRead,
      oomBannerDetectionAvailable: historyState.storage !== 'memory-only',
      totalRecordedRuns: historyState.runs.length,
      uncleanPreviousSessionCount: uncleanPreviousSessions.length,
      uncleanPreviousSessions: uncleanPreviousSessions.map((s) => ({
        sessionId: s.sessionId,
        pageRunId: s.pageRunId,
        startedAt: s.startedAt,
        lastHeartbeatAt: s.lastHeartbeatAt,
        stepCount: (s.steps || []).length,
      })),
      recentSessions: historyState.persistentSessions.slice(-5).map((s) => ({
        sessionId: s.sessionId,
        pageRunId: s.pageRunId,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        cleanlyTerminated: s.cleanlyTerminated,
        stepCount: (s.steps || []).length,
        visibilityEventCount: (s.visibilityEvents || []).length,
      })),
    },
    persistentSession: persistentPoolState.session,
  };

  window.__VERIFY_RESULT__ = nextResult;
  renderDeviceSummary(nextResult);
  syncOutputElements(nextResult);
}

window.__REFRESH_VERIFY_JSON__ = refreshVerifyResultObject;

function renderPersistentPanel() {
  const statusEl = document.getElementById('soak-status');
  const logEl = document.getElementById('soak-log');
  const startBtn = document.getElementById('soak-start-btn');
  const reloadBtn = document.getElementById('soak-reload-btn');
  const reloadSwapBtn = document.getElementById('soak-reload-swap-btn');
  const requeryBtn = document.getElementById('soak-requery-btn');
  const stopBtn = document.getElementById('soak-stop-btn');
  const clearBtn = document.getElementById('soak-clear-history-btn');
  if (!statusEl) return;

  const readyToStart = Boolean(
    autoSuiteCompletedNormally
    && autoSuiteFatalError === null
    && persistentPoolState.expectedBg2n
    && persistentPoolState.expectedExpertSelectKeys
    && persistentPoolState.expectedStandardCube,
  );
  const { active, busy, session } = persistentPoolState;

  if (startBtn) startBtn.disabled = !readyToStart || active || busy;
  if (reloadBtn) reloadBtn.disabled = !active || busy;
  if (reloadSwapBtn) reloadSwapBtn.disabled = !active || busy;
  if (requeryBtn) requeryBtn.disabled = !active || busy;
  if (stopBtn) stopBtn.disabled = !active || busy;
  if (clearBtn) clearBtn.disabled = busy;

  if (!session) {
    statusEl.className = 'soak-box';
    statusEl.textContent = readyToStart
      ? '待機中: 「1. 4-Worker (BG2N) 開始・保持」を押すと既定 URL（runtime 再利用経路）で 4 Worker を起動し、expert/champion/通常cube/BG2N 保持状態にします。'
      : (autoSuiteFatalError ? '自動スイートが失敗したため持続セッションを開始できません。' : '自動スイート完了後に操作可能になります...');
    if (logEl) logEl.textContent = '(まだステップ履歴はありません)';
    return;
  }

  const gate = evaluatePersistentGate(session);
  const lastStep = session.steps[session.steps.length - 1] || null;
  const anyFail = session.steps.some((s) => !s.passed);
  statusEl.className = anyFail ? 'soak-box fail' : (active ? 'soak-box active' : (gate.passed ? 'soak-box pass' : 'soak-box'));
  statusEl.textContent = [
    `Session ID: ${session.sessionId} (pageRunId=${pageRunId}) | state=${busy ? 'BUSY' : (active ? 'RUNNING (4 Workers ALIVE)' : (gate.passed ? 'PASSED & STOPPED CLEANLY' : (session.cleanlyTerminated ? 'STOPPED (INCOMPLETE GATE)' : 'STOPPED WITH ERROR')))}`,
    `Started: ${session.startedAt} | Heartbeat: ${session.lastHeartbeatAt || 'n/a'} | Visibility events: ${session.visibilityEvents.length}`,
    `Gate checklist: start=${gate.details.started}, defaultReuseReload=${gate.details.reloadedDefaultReuse}, explicitSwapReload=${gate.details.reloadedExplicitSwap}(opt), resumeRequery=${gate.details.resumedRequery}, champion3ply=${gate.details.championWorkloadExecuted}, cleanStop=${gate.details.disposedCleanly}`,
    lastStep
      ? `Latest step #${lastStep.stepNo} (${lastStep.action}/${lastStep.reloadMode}): passed=${lastStep.passed}, totalMem=${lastStep.totalLinearMemoryMiB ?? 'n/a'} MiB, duration=${lastStep.durationMs} ms${lastStep.error ? `, error=${lastStep.error}` : ''}`
      : 'No steps yet',
  ].join('\n');

  if (logEl) {
    const lines = session.steps.map((s) => {
      const perW = (s.perWorker || []).map((w) => (
        `w${w.workerIndex}:${w.linearMemoryMiB}MiB(h=${w.activeHandles?.mlp}/${w.activeHandles?.cubeHead}/${w.activeHandles?.bearoff}/${w.activeHandles?.bg2n}/${w.activeHandles?.met},expOk=${w.selectMatch},cubeOk=${w.standardCubeMatch},bg2nOk=${w.bg2nMatch}${w.championMatch !== null ? `,chOk=${w.championMatch}` : ''},rtSame=${w.sameRuntimeAsPrev})`
      )).join(' | ');
      return `#${s.stepNo} [${s.at}] ${s.action} (${s.reloadMode}) -> ${s.passed ? 'PASS' : 'FAIL'} (${s.durationMs}ms, total=${s.totalLinearMemoryMiB ?? 'n/a'}MiB)${s.error ? ` ERR=${s.error}` : ''}${perW ? `\n   ${perW}` : ''}`;
    });
    if (session.visibilityEvents.length > 0) {
      lines.push('--- visibilitychange ---');
      for (const ev of session.visibilityEvents) {
        lines.push(`[${ev.at}] visibility=${ev.state}`);
      }
    }
    logEl.textContent = lines.join('\n') || '(履歴なし)';
  }
}

async function queryPersistentPool(
  actionName,
  { reloadMode = 'none', runChampionWorkload = false } = {},
) {
  const session = persistentPoolState.session;
  const boardJson = makeInitialBoardJson();
  const bg2nBoardJson = makeBg2n6x6BoardJson();
  const t0 = performance.now();

  if (reloadMode === 'default-url-reuse') {
    // 既定 URL 経路（wasm URL 省略・forceReloadWasm=false）: 同一 Worker かつ同一 WASM runtime を再利用する
    await Promise.all(
      persistentPoolState.rpcs.map((call) => call(LOAD_PAYLOAD_DEFAULT_AUTO, PERSISTENT_RPC_TIMEOUT_MS)),
    );
  } else if (reloadMode === 'explicit-url-swap') {
    // 明示 URL 経路: 同一 Worker 内で新しい WASM runtime を作り直すピークメモリ耐性シナリオ
    await Promise.all(
      persistentPoolState.rpcs.map((call) => call(LOAD_PAYLOAD_EXPLICIT_URLS, PERSISTENT_RPC_TIMEOUT_MS)),
    );
  }

  // 1. 通常 expert select (4 Worker W/B 交互) — 独立 JS 基準 (expectedExpertSelectKeys) と照合
  const selectResults = await Promise.all(persistentPoolState.rpcs.map((call, idx) => call({
    kind: 'select',
    board: boardJson,
    player: idx % 2 === 0 ? 'WHITE' : 'BLACK',
    die1: POOL_ROLLS[idx][0],
    die2: POOL_ROLLS[idx][1],
    level: 'expert',
  }, PERSISTENT_RPC_TIMEOUT_MS)));

  // 2. 通常 cube 評価 (4 Worker W/B 交互) — cubeHead=1 を確実にアクティブ化し独立 JS 基準と照合
  const standardCubeResults = await Promise.all(persistentPoolState.rpcs.map((call, idx) => call({
    kind: 'cube',
    board: boardJson,
    player: idx % 2 === 0 ? 'WHITE' : 'BLACK',
    cubeValue: 1,
    cubeOwner: null,
    jacoby: true,
    level: 'expert',
    match: null,
    ask: 'double',
  }, PERSISTENT_RPC_TIMEOUT_MS)));

  // 3. 3-ply champion 負荷 (4 Worker 並列、実利用に近い重負荷)
  let championResults = null;
  if (runChampionWorkload) {
    championResults = await Promise.all(persistentPoolState.rpcs.map((call, idx) => call({
      kind: 'select',
      board: boardJson,
      player: idx % 2 === 0 ? 'WHITE' : 'BLACK',
      die1: CHAMPION_POOL_ROLLS[idx][0],
      die2: CHAMPION_POOL_ROLLS[idx][1],
      level: 'champion',
    }, PERSISTENT_RPC_TIMEOUT_MS)));
    if (!persistentPoolState.baselineChampionKeys) {
      persistentPoolState.baselineChampionKeys = championResults.map((r) => r.key);
    }
  }

  // 4. BG2N 6x6 exact-root cube 評価 (4 Worker W/B 交互、unboundedMoney=true) — 独立 JS 基準と照合
  const bg2nResults = await Promise.all(persistentPoolState.rpcs.map((call, idx) => call({
    kind: 'cube',
    board: bg2nBoardJson,
    player: idx % 2 === 0 ? 'WHITE' : 'BLACK',
    cubeValue: 1,
    cubeOwner: null,
    jacoby: false,
    level: 'expert',
    match: null,
    ask: 'double',
    unboundedMoney: true,
  }, PERSISTENT_RPC_TIMEOUT_MS)));

  const statuses = await Promise.all(persistentPoolState.rpcs.map((call) => call(
    { kind: 'status' },
    PERSISTENT_RPC_TIMEOUT_MS,
  )));

  const durationMs = Number((performance.now() - t0).toFixed(2));
  const prevStepWithMem = [...session.steps].reverse().find(
    (s) => Array.isArray(s.perWorker) && s.perWorker.length === 4,
  );

  const perWorker = statuses.map((s, idx) => {
    const bs = s.backendStatus;
    const expectedExpertKey = persistentPoolState.expectedExpertSelectKeys[idx];
    const expectedStdCubeAns = idx % 2 === 0
      ? persistentPoolState.expectedStandardCube.white
      : persistentPoolState.expectedStandardCube.black;
    const expectedBg2nAns = idx % 2 === 0
      ? persistentPoolState.expectedBg2n.white
      : persistentPoolState.expectedBg2n.black;

    const selectKey = selectResults[idx].key;
    const selectMatch = isNonEmptyString(selectKey) && selectKey === expectedExpertKey;
    const standardCubeMatch = standardCubeResults[idx].answer === expectedStdCubeAns;
    const bg2nMatch = bg2nResults[idx].answer === expectedBg2nAns;

    let championKey = null;
    let championMatch = null;
    if (championResults) {
      championKey = championResults[idx].key;
      const baseChampKey = persistentPoolState.baselineChampionKeys[idx];
      const matchesWorker0AutoRef = idx !== 0
        || !persistentPoolState.expectedChampionWorker0Key
        || championKey === persistentPoolState.expectedChampionWorker0Key;
      championMatch = isNonEmptyString(championKey)
        && championKey === baseChampKey
        && matchesWorker0AutoRef;
    }

    const memMiB = toMiB(bs.linearMemoryBytes);
    const workerMemWithinBudget = Number.isFinite(memMiB)
      && memMiB > 0
      && memMiB <= SINGLE_WORKER_BG2N_MAX_MIB;

    const prevWorker = prevStepWithMem?.perWorker?.[idx] ?? null;
    const handlesExpected = hasExpectedFullHandles(bs.activeHandles);
    const handlesSameAsPrev = !prevWorker || sameHandles(bs.activeHandles, prevWorker.activeHandles);
    const memStableVsPrev = !prevWorker || bs.linearMemoryBytes <= prevWorker.linearMemoryBytes;
    const sameRuntimeAsPrev = prevWorker
      ? (bs.runtimeId !== null && bs.runtimeId === prevWorker.runtimeId)
      : null;

    return {
      workerIndex: idx,
      configuredBackend: bs.configuredBackend,
      activeBackend: bs.activeBackend,
      wasmReady: bs.wasmReady,
      runtimeId: bs.runtimeId,
      wasmVariant: bs.wasmVariant,
      simdActive: bs.simdActive,
      loadTimeMs: bs.loadTimeMs,
      sourceUrl: bs.sourceUrl,
      sameRuntimeAsPrev,
      fallbackReason: bs.fallbackReason,
      simdFallbackReason: bs.simdFallbackReason,
      linearMemoryBytes: bs.linearMemoryBytes,
      linearMemoryMiB: memMiB,
      workerMemWithinBudget,
      memStableVsPrev,
      activeHandles: bs.activeHandles,
      handlesExpected,
      handlesSameAsPrev,
      selectKey,
      selectMatch,
      standardCubeAnswer: standardCubeResults[idx].answer,
      standardCubeMatch,
      championKey,
      championMatch,
      bg2nAnswer: bg2nResults[idx].answer,
      bg2nMatch,
    };
  });

  const totalLinearMemoryBytes = perWorker.reduce((sum, w) => sum + (w.linearMemoryBytes || 0), 0);
  const totalLinearMemoryMiB = toMiB(totalLinearMemoryBytes);
  const allPerWorkerMemWithinBudget = perWorker.every((w) => w.workerMemWithinBudget);
  const allAnswersMatch = perWorker.every(
    (w) => w.selectMatch
      && w.standardCubeMatch
      && w.bg2nMatch
      && (w.championMatch === null || w.championMatch === true),
  );
  const allHandlesExpected = perWorker.every((w) => w.handlesExpected && w.handlesSameAsPrev);
  const allMemStableVsPrev = perWorker.every((w) => w.memStableVsPrev);
  const allReusedRuntimeWhenExpected = reloadMode !== 'default-url-reuse'
    || !prevStepWithMem
    || perWorker.every((w) => w.sameRuntimeAsPrev === true);
  const allWasmAuto = perWorker.every(
    (w) => w.configuredBackend === 'auto'
      && w.activeBackend === 'wasm'
      && w.wasmReady === true
      && w.wasmVariant === persistentPoolState.expectedAutoVariant
      && w.simdActive === persistentPoolState.simdSupported,
  );
  const memWithinBudget = Number.isFinite(totalLinearMemoryMiB)
    && totalLinearMemoryMiB > 0
    && totalLinearMemoryMiB <= FOUR_WORKER_BG2N_MAX_MIB
    && allPerWorkerMemWithinBudget;

  const stepRecord = {
    stepNo: session.steps.length + 1,
    action: actionName,
    reloadMode,
    runtimeReuseNote: reloadMode === 'explicit-url-swap'
      ? 'Same 4 Workers with explicit wasmSimdUrl/wasmScalarUrl (intentionally swaps WASM runtime per reload to stress peak memory).'
      : (reloadMode === 'default-url-reuse'
          ? 'Same 4 Workers with omitted wasm URLs (default production path: reuses active WASM runtime and verifies zero handle/memory growth).'
          : 'No reload (queries existing 4 Workers and WASM runtimes in place).'),
    championWorkloadExecuted: Boolean(runChampionWorkload),
    at: new Date().toISOString(),
    durationMs,
    totalLinearMemoryBytes,
    totalLinearMemoryMiB,
    memWithinBudget,
    allPerWorkerMemWithinBudget,
    allMemStableVsPrev,
    allHandlesExpected,
    allReusedRuntimeWhenExpected,
    allAnswersMatch,
    allWasmAuto,
    perWorker,
    error: null,
    passed: memWithinBudget
      && allMemStableVsPrev
      && allHandlesExpected
      && allReusedRuntimeWhenExpected
      && allAnswersMatch
      && allWasmAuto,
  };
  session.steps.push(stepRecord);
  session.lastHeartbeatAt = new Date().toISOString();
  persistHistory();
  return stepRecord;
}

function stopHeartbeat() {
  if (persistentPoolState.heartbeatTimer !== null) {
    clearInterval(persistentPoolState.heartbeatTimer);
    persistentPoolState.heartbeatTimer = null;
  }
}

function wirePersistentPoolUi() {
  const startBtn = document.getElementById('soak-start-btn');
  const reloadBtn = document.getElementById('soak-reload-btn');
  const reloadSwapBtn = document.getElementById('soak-reload-swap-btn');
  const requeryBtn = document.getElementById('soak-requery-btn');
  const stopBtn = document.getElementById('soak-stop-btn');
  const clearBtn = document.getElementById('soak-clear-history-btn');
  if (!startBtn) return;

  document.addEventListener('visibilitychange', () => {
    if (!persistentPoolState.active || !persistentPoolState.session) return;
    persistentPoolState.session.visibilityEvents.push({
      state: document.visibilityState,
      at: new Date().toISOString(),
    });
    persistentPoolState.session.lastHeartbeatAt = new Date().toISOString();
    persistHistory();
    renderPersistentPanel();
    refreshVerifyResultObject();
  });

  const runAction = async (actionLabel, fn) => {
    persistentPoolState.busy = true;
    renderPersistentPanel();
    try {
      await fn();
    } catch (err) {
      const msg = String(err?.stack || err);
      if (persistentPoolState.session) {
        persistentPoolState.session.steps.push({
          stepNo: persistentPoolState.session.steps.length + 1,
          action: actionLabel,
          reloadMode: 'error',
          championWorkloadExecuted: false,
          at: new Date().toISOString(),
          durationMs: 0,
          totalLinearMemoryMiB: null,
          perWorker: [],
          error: msg,
          passed: false,
        });
        persistentPoolState.session.lastHeartbeatAt = new Date().toISOString();
        persistHistory();
      }
    } finally {
      persistentPoolState.busy = false;
      renderPersistentPanel();
      refreshVerifyResultObject();
    }
  };

  startBtn.addEventListener('click', () => runAction('start', async () => {
    const session = {
      sessionId: makeRunId('soak4w'),
      pageRunId,
      startedAt: new Date().toISOString(),
      endedAt: null,
      lastHeartbeatAt: new Date().toISOString(),
      cleanlyTerminated: false,
      visibilityEvents: [],
      steps: [],
    };
    persistentPoolState.session = session;
    persistentPoolState.baselineChampionKeys = null;
    historyState.persistentSessions.push(session);
    persistHistory();

    const workers = Array.from({ length: 4 }, () => new Worker(HARNESS_WORKER_URL, { type: 'module' }));
    const rpcs = workers.map((w, idx) => rpcWorker(w, {
      label: `persistent-pool-${idx}`,
      timeoutMs: PERSISTENT_RPC_TIMEOUT_MS,
    }));
    persistentPoolState.workers = workers;
    persistentPoolState.rpcs = rpcs;
    persistentPoolState.active = true;

    stopHeartbeat();
    persistentPoolState.heartbeatTimer = setInterval(() => {
      if (persistentPoolState.active && persistentPoolState.session) {
        persistentPoolState.session.lastHeartbeatAt = new Date().toISOString();
        persistHistory();
      }
    }, 5_000);

    try {
      await queryPersistentPool('start', {
        reloadMode: 'default-url-reuse',
        runChampionWorkload: true,
      });
    } catch (err) {
      stopHeartbeat();
      for (const w of workers) w.terminate();
      persistentPoolState.workers = [];
      persistentPoolState.rpcs = [];
      persistentPoolState.active = false;
      throw err;
    }
  }));

  reloadBtn.addEventListener('click', () => runAction('reload_default_reuse', async () => {
    await queryPersistentPool('reload_default_reuse', {
      reloadMode: 'default-url-reuse',
      runChampionWorkload: false,
    });
  }));

  if (reloadSwapBtn) {
    reloadSwapBtn.addEventListener('click', () => runAction('reload_explicit_swap', async () => {
      await queryPersistentPool('reload_explicit_swap', {
        reloadMode: 'explicit-url-swap',
        runChampionWorkload: false,
      });
    }));
  }

  requeryBtn.addEventListener('click', () => runAction('resume_requery', async () => {
    await queryPersistentPool('resume_requery', {
      reloadMode: 'none',
      runChampionWorkload: true,
    });
  }));

  stopBtn.addEventListener('click', () => runAction('dispose_terminate', async () => {
    const t0 = performance.now();
    const disposeResults = await Promise.allSettled(
      persistentPoolState.rpcs.map((call) => call({ kind: 'dispose' }, 15_000)),
    );
    for (const w of persistentPoolState.workers) {
      w.terminate();
    }
    stopHeartbeat();
    persistentPoolState.workers = [];
    persistentPoolState.rpcs = [];
    persistentPoolState.active = false;

    const allDisposed = disposeResults.every(
      (r) => r.status === 'fulfilled' && r.value?.backendStatus?.wasmReady === false,
    );
    const session = persistentPoolState.session;
    session.endedAt = new Date().toISOString();
    session.lastHeartbeatAt = session.endedAt;
    session.cleanlyTerminated = allDisposed;
    session.steps.push({
      stepNo: session.steps.length + 1,
      action: 'dispose_terminate',
      reloadMode: 'none',
      championWorkloadExecuted: false,
      at: session.endedAt,
      durationMs: Number((performance.now() - t0).toFixed(2)),
      totalLinearMemoryMiB: 0,
      allDisposed,
      perWorker: [],
      error: allDisposed ? null : 'One or more workers failed to dispose cleanly before terminate',
      passed: allDisposed,
    });
    persistHistory();
  }));

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearHistoryStorage();
      historyState.runs = [currentRunRecord];
      historyState.persistentSessions = persistentPoolState.session ? [persistentPoolState.session] : [];
      uncleanPreviousSessions.length = 0;
      persistHistory();
      renderUncleanSessionBanner();
      renderPersistentPanel();
      refreshVerifyResultObject();
    });
  }
}

// ── メイン自動検証スイート ─────────────────────────────────────────────────

async function run() {
  wireDeviceUiButtons();
  wirePersistentPoolUi();
  renderUncleanSessionBanner();
  renderPersistentPanel();

  const step = (name) => {
    window.__VERIFY_STEP__ = name;
  };
  const checks = {};

  // Pre-flight: Verify Secure Context & Web Crypto (crypto.subtle.digest) in BOTH main thread and Web Worker.
  // MoneyBearoffDatabase (BG2N v4) strictly requires crypto.subtle.digest('SHA-256', ...) and will fail on
  // plain non-loopback LAN HTTP (http://<LAN_IP>). Fail fast with actionable guidance before running checks.
  step('0:secureContext');
  const mainIsSecureContext = Boolean(window.isSecureContext);
  const mainHasSubtleDigest = typeof globalThis.crypto?.subtle?.digest === 'function';
  let workerIsSecureContext = false;
  let workerHasSubtleDigest = false;
  let workerProbeError = null;
  const probeWorker = new Worker(HARNESS_WORKER_URL, { type: 'module' });
  try {
    const probeRpc = rpcWorker(probeWorker, { label: 'env-probe', timeoutMs: 15_000 });
    const probeRes = await probeRpc({ kind: '__harness_env_probe__' }, 15_000);
    workerIsSecureContext = Boolean(probeRes.isSecureContext);
    workerHasSubtleDigest = Boolean(probeRes.hasSubtleDigest);
  } catch (err) {
    workerProbeError = String(err?.message || err);
  } finally {
    probeWorker.terminate();
  }
  const secureContextPassed = mainIsSecureContext
    && mainHasSubtleDigest
    && workerIsSecureContext
    && workerHasSubtleDigest
    && workerProbeError === null;
  const secureContextGuidance = secureContextPassed
    ? null
    : [
        'このページは Secure Context ではないため Web Crypto (crypto.subtle.digest) が利用できず、BG2N v4 の SHA-256 検証を実行できません。',
        `現在アクセス先: ${window.location.origin} (main: isSecureContext=${mainIsSecureContext}, subtle=${mainHasSubtleDigest} / worker: isSecureContext=${workerIsSecureContext}, subtle=${workerHasSubtleDigest})`,
        '対処法 (いずれかを使用してください):',
        '  1. [推奨 / LAN 実機] mkcert 等で実機が信頼する CA 証明書を作成し、`serve-device-verify.py --cert <cert.pem> --key <key.pem>` で HTTPS 配信して `https://<LAN_IP>:<port>/harness.html` を開く（ブラウザの証明書警告を無視するだけでは Secure Context にならない場合があります）。',
        '  2. [Android USB デバッグ] `adb reverse tcp:8787 tcp:8787` を実行し、実機ブラウザで `http://127.0.0.1:8787/harness.html` を開く。',
        '  3. [ローカル macOS Safari] `http://127.0.0.1:8787/harness.html` を開く。',
      ].join('\n');
  checks.secureContext = {
    origin: window.location.origin,
    protocol: window.location.protocol,
    mainIsSecureContext,
    mainHasSubtleDigest,
    workerIsSecureContext,
    workerHasSubtleDigest,
    workerProbeError,
    guidance: secureContextGuidance,
    passed: secureContextPassed,
  };
  if (!secureContextPassed) {
    autoSuiteChecks = checks;
    autoSuiteCompletedNormally = false;
    autoSuiteFatalError = secureContextGuidance;
    currentRunRecord.completedAt = new Date().toISOString();
    currentRunRecord.autoPassed = false;
    persistHistory();
    step('done:insecureContext');
    window.__VERIFY_DONE__ = true;
    renderPersistentPanel();
    refreshVerifyResultObject();
    return;
  }

  // 0. Phase 4b default 'auto' backend check (fresh state -> pre-init transparent JS fallback -> omitted-backend WASM promotion)
  step('0:defaultAutoBackend');
  const simdSupported = detectWasmSimdSupport();
  const expectedAutoVariant = simdSupported ? 'simd' : 'scalar';
  const freshConfigured = getEngineBackend();
  const freshStatus = getEngineBackendStatus();
  const b0 = new Board();
  const preInitMoves = getLegalMoves({
    board: {
      points: [...b0.points],
      bar: { white: b0.bar.WHITE, black: b0.bar.BLACK },
      off: { white: b0.off.WHITE, black: b0.off.BLACK },
    },
    turn: 'white',
    dice: { die1: 3, die2: 1 },
    cube: { value: 1, owner: 'center', available: true, enabled: true },
    match: { mode: 'money', jacoby: true },
  });
  const preInitFallbackStatus = getEngineBackendStatus();

  // 1. Main-thread SIMD128 auto-detection + streaming instantiation (application/wasm) using omitted backend & default URLs
  step('1:mainThreadSimd');
  const simdStatus = await initWasmEngine({
    variant: 'auto',
    forceReload: true,
  });
  checks.defaultAutoBackend = {
    initialConfiguredBackend: freshConfigured,
    initialActiveBackend: freshStatus.activeBackend,
    initialWasmReady: freshStatus.wasmReady,
    preInitMoveCount: preInitMoves.length,
    preInitFallbackReason: preInitFallbackStatus.fallbackReason,
    postInitConfiguredBackend: simdStatus.configuredBackend,
    postInitActiveBackend: simdStatus.activeBackend,
    postInitVariant: simdStatus.wasmVariant,
    postInitSimdActive: simdStatus.simdActive,
    postInitFallbackReason: simdStatus.fallbackReason,
    postInitSimdFallbackReason: simdStatus.simdFallbackReason,
    passed: freshConfigured === 'auto'
      && freshStatus.configuredBackend === 'auto'
      && freshStatus.activeBackend === 'js'
      && freshStatus.wasmReady === false
      && preInitMoves.length > 0
      && preInitFallbackStatus.activeBackend === 'js'
      && Boolean(preInitFallbackStatus.fallbackReason)
      && simdStatus.configuredBackend === 'auto'
      && simdStatus.activeBackend === 'wasm'
      && simdStatus.wasmReady === true
      && simdStatus.wasmVariant === expectedAutoVariant
      && simdStatus.simdActive === simdSupported
      && simdStatus.fallbackReason === null
      && simdStatus.simdFallbackReason === null,
  };
  checks.mainThreadSimd = {
    simdSupported,
    expectedAutoVariant,
    wasmVariant: simdStatus.wasmVariant,
    simdActive: simdStatus.simdActive,
    configuredBackend: simdStatus.configuredBackend,
    activeBackend: simdStatus.activeBackend,
    loadTimeMs: Number(simdStatus.loadTimeMs.toFixed(2)),
    passed: simdStatus.wasmReady
      && simdStatus.configuredBackend === 'auto'
      && simdStatus.wasmVariant === expectedAutoVariant
      && simdStatus.simdActive === simdSupported
      && simdStatus.activeBackend === 'wasm',
  };

  // 2. MIME fallback (application/octet-stream) + scalar variant:
  //    Verify the server ACTUALLY returned application/octet-stream AND instantiateStreaming was NOT invoked.
  step('2:mimeFallbackScalar');
  const fallbackUrl = FALLBACK_MIME_SCALAR_URL;
  const probeResp = await fetch(fallbackUrl);
  const fallbackContentType = (probeResp.headers.get('content-type') || '').toLowerCase();
  await probeResp.arrayBuffer();

  let streamingCalledCount = 0;
  const origInstantiateStreaming = WebAssembly.instantiateStreaming;
  if (typeof origInstantiateStreaming === 'function') {
    WebAssembly.instantiateStreaming = (...args) => {
      streamingCalledCount += 1;
      return origInstantiateStreaming.apply(WebAssembly, args);
    };
  }
  let fallbackStatus;
  try {
    fallbackStatus = await initWasmEngine({
      variant: 'scalar',
      wasmScalarUrl: fallbackUrl,
      backend: 'wasm',
      forceReload: true,
    });
  } finally {
    if (typeof origInstantiateStreaming === 'function') {
      WebAssembly.instantiateStreaming = origInstantiateStreaming;
    }
  }
  const mimeIsOctetStream = fallbackContentType.includes('application/octet-stream')
    && !fallbackContentType.includes('application/wasm');
  checks.mimeFallbackScalar = {
    contentType: fallbackContentType,
    streamingCalledCount,
    wasmVariant: fallbackStatus.wasmVariant,
    simdActive: fallbackStatus.simdActive,
    activeBackend: fallbackStatus.activeBackend,
    passed: mimeIsOctetStream
      && streamingCalledCount === 0
      && fallbackStatus.wasmVariant === 'scalar'
      && !fallbackStatus.simdActive
      && fallbackStatus.wasmReady
      && fallbackStatus.activeBackend === 'wasm',
  };

  // Switch back to auto (SIMD when supported, scalar otherwise) via default URL for main-thread parity check
  step('3:mainThreadParity');
  await initWasmEngine({
    variant: 'auto',
    backend: 'wasm',
    forceReload: true,
  });

  // 3. Main-thread JS vs WASM browser parity on real model + bearoff + pruneNet
  const net = await NeuralNet.load(MODEL_ASSET_URL);
  const pruneNet = await NeuralNet.load(PRUNE_NET_ASSET_URL);
  const bearoff = await BearoffDatabase.load(BEAROFF_ASSET_URL);
  setBearoffDatabase(bearoff);
  setPruneNet(pruneNet);

  const fixture = await (await fetch(PARITY_FIXTURE_URL)).json();
  const samplePos = {
    ...fixture.positions[0].position,
    cube: { value: 1, owner: 'center', available: true, enabled: true },
  };
  const cubePos = { ...samplePos, dice: null };

  setEngineBackend('js');
  const tJs0 = performance.now();
  const jsChecker = analyzeChecker(samplePos, { net, profile: { plies: 2 } });
  const jsCheckerMs = performance.now() - tJs0;
  const jsCube = analyzeCube(cubePos, { net, profile: { plies: 2 } });

  setEngineBackend('wasm');
  // Warm up handle upload
  analyzeChecker(samplePos, { net, profile: { plies: 0 } });
  const tWasm0 = performance.now();
  const wasmChecker = analyzeChecker(samplePos, { net, profile: { plies: 2 } });
  const wasmCheckerMs = performance.now() - tWasm0;
  const wasmCube = analyzeCube(cubePos, { net, profile: { plies: 2 } });

  const checkerDiff = Math.abs(jsChecker.candidates[0].equity - wasmChecker.candidates[0].equity);
  const cubeNdDiff = Math.abs(jsCube.candidates[0].equity - wasmCube.candidates[0].equity);
  const cubeDtDiff = Math.abs(jsCube.candidates[1].equity - wasmCube.candidates[1].equity);
  checks.mainThreadParity = {
    jsCheckerMs: Number(jsCheckerMs.toFixed(2)),
    wasmCheckerMs: Number(wasmCheckerMs.toFixed(2)),
    speedup: Number((jsCheckerMs / wasmCheckerMs).toFixed(2)),
    topMoveMatch: jsChecker.candidates[0].move.id === wasmChecker.candidates[0].move.id,
    checkerDiff: Number(checkerDiff.toExponential(3)),
    cubeActionMatch: jsCube.recommendedAction === wasmCube.recommendedAction,
    cubeNdDiff: Number(cubeNdDiff.toExponential(3)),
    cubeDtDiff: Number(cubeDtDiff.toExponential(3)),
    passed: jsChecker.candidates[0].move.id === wasmChecker.candidates[0].move.id
      && Number.isFinite(checkerDiff) && checkerDiff < 1e-5
      && jsCube.recommendedAction === wasmCube.recommendedAction
      && Number.isFinite(cubeNdDiff) && cubeNdDiff < 1e-5
      && Number.isFinite(cubeDtDiff) && cubeDtDiff < 1e-5,
  };

  disposeWasmEngine();
  setEngineBackend('auto');

  // 4. Real Web Worker (JS vs WASM):
  //    Uses default URL path (LOAD_PAYLOAD_DEFAULT_AUTO) so reload tests actual runtime reuse!
  step('4:singleWorkerLoad');
  const jsWorker = new Worker(HARNESS_WORKER_URL, { type: 'module' });
  const wasmWorker = new Worker(HARNESS_WORKER_URL, { type: 'module' });
  const jsRpc = rpcWorker(jsWorker, { label: 'single-js' });
  const wasmRpc = rpcWorker(wasmWorker, { label: 'single-wasm' });

  await jsRpc({ ...LOAD_PAYLOAD_BASE, backend: 'js' });
  const wasmLoad1 = await wasmRpc(LOAD_PAYLOAD_DEFAULT_AUTO);

  step('4:singleWorkerOpsStandard');
  const boardJson = makeInitialBoardJson();
  const bg2nBoardJson = makeBg2n6x6BoardJson();

  const jsSel = await jsRpc({ kind: 'select', board: boardJson, player: 'WHITE', die1: 3, die2: 1, level: 'expert' });
  const wasmSel = await wasmRpc({ kind: 'select', board: boardJson, player: 'WHITE', die1: 3, die2: 1, level: 'expert' });

  // 持続 4-Worker セッション用の独立 JS 基準 (expert 4 ロール + 通常 cube W/B) もここで計算しておく
  const jsPoolExpertRefs = [jsSel.key];
  for (let idx = 1; idx < POOL_ROLLS.length; idx += 1) {
    const r = await jsRpc({
      kind: 'select',
      board: boardJson,
      player: idx % 2 === 0 ? 'WHITE' : 'BLACK',
      die1: POOL_ROLLS[idx][0],
      die2: POOL_ROLLS[idx][1],
      level: 'expert',
    });
    jsPoolExpertRefs.push(r.key);
  }

  const jsRank = await jsRpc({ kind: 'rank', board: boardJson, player: 'BLACK', die1: 6, die2: 1, level: 'expert', limit: 3 });
  const wasmRank = await wasmRpc({ kind: 'rank', board: boardJson, player: 'BLACK', die1: 6, die2: 1, level: 'expert', limit: 3 });

  const jsCubeW = await jsRpc({
    kind: 'cube', board: boardJson, player: 'WHITE', cubeValue: 1, cubeOwner: null,
    jacoby: true, level: 'expert', match: null, ask: 'double',
  });
  const jsCubeB = await jsRpc({
    kind: 'cube', board: boardJson, player: 'BLACK', cubeValue: 1, cubeOwner: null,
    jacoby: true, level: 'expert', match: null, ask: 'double',
  });
  const wasmCubeW = await wasmRpc({
    kind: 'cube', board: boardJson, player: 'WHITE', cubeValue: 1, cubeOwner: null,
    jacoby: true, level: 'expert', match: null, ask: 'double',
  });

  // Snapshot 4A: Standard search (BG2N not yet uploaded)
  const statusStandardBeforeBg2n = (await wasmRpc({ kind: 'status' })).backendStatus;

  // Snapshot 4B: Trigger lazy BG2N 6x6 strict exact-root upload (White & Black, unboundedMoney=true)
  step('4:singleWorkerBg2n');
  const jsBg2nW = await jsRpc({
    kind: 'cube', board: bg2nBoardJson, player: 'WHITE', cubeValue: 1, cubeOwner: null,
    jacoby: false, level: 'expert', match: null, ask: 'double', unboundedMoney: true,
  });
  const wasmBg2nW = await wasmRpc({
    kind: 'cube', board: bg2nBoardJson, player: 'WHITE', cubeValue: 1, cubeOwner: null,
    jacoby: false, level: 'expert', match: null, ask: 'double', unboundedMoney: true,
  });
  const jsBg2nB = await jsRpc({
    kind: 'cube', board: bg2nBoardJson, player: 'BLACK', cubeValue: 1, cubeOwner: null,
    jacoby: false, level: 'expert', match: null, ask: 'double', unboundedMoney: true,
  });
  const wasmBg2nB = await wasmRpc({
    kind: 'cube', board: bg2nBoardJson, player: 'BLACK', cubeValue: 1, cubeOwner: null,
    jacoby: false, level: 'expert', match: null, ask: 'double', unboundedMoney: true,
  });
  const statusWithBg2nBeforeReload = (await wasmRpc({ kind: 'status' })).backendStatus;

  // Snapshot 4C: Reload worker via DEFAULT URL (runtime reuse path) with identical full workload (including BG2N!)
  step('4:singleWorkerReloadWithBg2n');
  await wasmRpc(LOAD_PAYLOAD_DEFAULT_AUTO);
  await wasmRpc({ kind: 'select', board: boardJson, player: 'WHITE', die1: 3, die2: 1, level: 'expert' });
  await wasmRpc({
    kind: 'cube', board: boardJson, player: 'WHITE', cubeValue: 1, cubeOwner: null,
    jacoby: true, level: 'expert', match: null, ask: 'double',
  });
  const wasmBg2nAfterReload = await wasmRpc({
    kind: 'cube', board: bg2nBoardJson, player: 'WHITE', cubeValue: 1, cubeOwner: null,
    jacoby: false, level: 'expert', match: null, ask: 'double', unboundedMoney: true,
  });
  const statusWithBg2nAfterReload = (await wasmRpc({ kind: 'status' })).backendStatus;

  // Snapshot 4D: UI responsiveness via requestAnimationFrame during heavy 3-ply search
  step('4:singleWorker3Ply');
  const rafGaps = [];
  let rafActive = true;
  let lastFrame = performance.now();
  const rafLoop = (now) => {
    rafGaps.push(now - lastFrame);
    lastFrame = now;
    if (rafActive) requestAnimationFrame(rafLoop);
  };
  requestAnimationFrame(rafLoop);
  const t3Ply0 = performance.now();
  const wcRes = await wasmRpc({
    kind: 'select', board: boardJson, player: 'WHITE', die1: 4, die2: 3, level: 'champion',
  });
  const worker3PlyMs = performance.now() - t3Ply0;
  rafActive = false;
  const maxRafGapMs = rafGaps.length ? Math.max(...rafGaps) : Number.NaN;

  // Dispose worker WASM cleanly
  step('4:singleWorkerDispose');
  const disposeRes = await wasmRpc({ kind: 'dispose' });
  jsWorker.terminate();
  wasmWorker.terminate();

  const singleStdMiB = toMiB(statusStandardBeforeBg2n.linearMemoryBytes);
  const singleBg2nMiB = toMiB(statusWithBg2nBeforeReload.linearMemoryBytes);
  const singleBg2nAfterReloadMiB = toMiB(statusWithBg2nAfterReload.linearMemoryBytes);

  const rankEquityDiff = Math.abs(jsRank.entries[0].equity - wasmRank.entries[0].equity);
  const rankTopMatch = jsRank.entries.length === wasmRank.entries.length
    && jsRank.entries[0].key === wasmRank.entries[0].key
    && Number.isFinite(rankEquityDiff)
    && rankEquityDiff < 1e-5;

  const standardHandlesExpected = statusStandardBeforeBg2n.activeHandles?.mlp === 2
    && statusStandardBeforeBg2n.activeHandles?.cubeHead === 1
    && statusStandardBeforeBg2n.activeHandles?.bearoff === 1
    && statusStandardBeforeBg2n.activeHandles?.bg2n === 0
    && statusStandardBeforeBg2n.activeHandles?.met === 1;
  const bg2nHandlesLoaded = hasExpectedFullHandles(statusWithBg2nBeforeReload.activeHandles);
  const handlesNoLeakOnReload = bg2nHandlesLoaded
    && sameHandles(statusWithBg2nBeforeReload.activeHandles, statusWithBg2nAfterReload.activeHandles);
  const reloadReusedRuntime = statusWithBg2nBeforeReload.runtimeId !== null
    && statusWithBg2nBeforeReload.runtimeId === statusWithBg2nAfterReload.runtimeId;

  const bg2nCubeParityMatch = jsBg2nW.answer === wasmBg2nW.answer
    && jsBg2nB.answer === wasmBg2nB.answer
    && wasmBg2nAfterReload.answer === jsBg2nW.answer;

  const singleStandardMemWithinBudget = Number.isFinite(singleStdMiB)
    && singleStdMiB > 0
    && singleStdMiB <= SINGLE_WORKER_STANDARD_MAX_MIB;
  const singleBg2nMemWithinBudget = Number.isFinite(singleBg2nMiB)
    && singleBg2nMiB > 0
    && singleBg2nMiB <= SINGLE_WORKER_BG2N_MAX_MIB
    && Number.isFinite(singleBg2nAfterReloadMiB)
    && singleBg2nAfterReloadMiB > 0
    && singleBg2nAfterReloadMiB <= singleBg2nMiB;

  checks.webWorker = {
    configuredBackend: wasmLoad1.backendStatus.configuredBackend,
    activeBackend: wasmLoad1.backendStatus.activeBackend,
    wasmVariant: wasmLoad1.backendStatus.wasmVariant,
    wasmSimdActive: wasmLoad1.backendStatus.simdActive,
    selectMatch: isNonEmptyString(wasmSel.key) && jsSel.key === wasmSel.key && jsSel.index === wasmSel.index,
    rankTopMatch,
    rankEquityDiff: Number(rankEquityDiff.toExponential(3)),
    cubeMatch: jsCubeW.answer === wasmCubeW.answer,
    bg2nCubeParityMatch,
    // Scenario 4A: Standard search (BG2N not yet uploaded)
    singleWorkerLinearMemoryMiB: singleStdMiB,
    singleWorkerStandardBudgetMiB: SINGLE_WORKER_STANDARD_MAX_MIB,
    singleStandardMemWithinBudget,
    handlesStandardBeforeBg2n: statusStandardBeforeBg2n.activeHandles,
    standardHandlesExpected,
    // Scenario 4B & 4C: After BG2N 6x6 upload + default-URL reload runtime reuse stability
    singleWorkerWithBg2nLinearMemoryMiB: singleBg2nMiB,
    singleWorkerWithBg2nAfterReloadMiB: singleBg2nAfterReloadMiB,
    singleWorkerBg2nBudgetMiB: SINGLE_WORKER_BG2N_MAX_MIB,
    singleBg2nMemWithinBudget,
    handlesWithBg2nBeforeReload: statusWithBg2nBeforeReload.activeHandles,
    handlesWithBg2nAfterReload: statusWithBg2nAfterReload.activeHandles,
    handlesNoLeakOnReload,
    reloadReusedRuntime,
    worker3PlyWorldClassMs: Number(worker3PlyMs.toFixed(2)),
    worker3PlyKey: wcRes.key,
    rafFrameCount: rafGaps.length,
    maxRafGapMs: Number.isFinite(maxRafGapMs) ? Number(maxRafGapMs.toFixed(2)) : null,
    telemetryNote: 'worker3PlyWorldClassMs and maxRafGapMs are observed telemetry; rafFrameCount > 0, standard/BG2N memory budgets, bg2n=1 handle upload, default-URL runtime reuse & reload stability, and parity are hard gates.',
    disposedCleanly: disposeRes.backendStatus.wasmReady === false,
    passed: wasmLoad1.backendStatus.configuredBackend === 'auto'
      && wasmLoad1.backendStatus.activeBackend === 'wasm'
      && wasmLoad1.backendStatus.wasmReady
      && wasmLoad1.backendStatus.wasmVariant === expectedAutoVariant
      && wasmLoad1.backendStatus.simdActive === simdSupported
      && isNonEmptyString(wasmSel.key)
      && jsSel.key === wasmSel.key
      && jsSel.index === wasmSel.index
      && rankTopMatch
      && jsCubeW.answer === wasmCubeW.answer
      && bg2nCubeParityMatch
      && standardHandlesExpected
      && singleStandardMemWithinBudget
      && bg2nHandlesLoaded
      && singleBg2nMemWithinBudget
      && handlesNoLeakOnReload
      && reloadReusedRuntime
      && rafGaps.length > 0
      && disposeRes.backendStatus.wasmReady === false,
  };

  // 5. 4 concurrent Web Workers (parallel pool simulation) — default URLs & omitted backend ('auto')
  step('5:fourWorkerPoolLoad');
  const workers = Array.from({ length: 4 }, () => new Worker(HARNESS_WORKER_URL, { type: 'module' }));
  const rpcs = workers.map((w, idx) => rpcWorker(w, { label: `pool-${idx}` }));
  const tPoolLoad0 = performance.now();
  const poolLoaded = [false, false, false, false];
  await Promise.all(rpcs.map((call, idx) => call(LOAD_PAYLOAD_DEFAULT_AUTO).then((res) => {
    poolLoaded[idx] = true;
    step(`5:fourWorkerPoolLoad:${poolLoaded.map(Number).join('')}`);
    return res;
  })));
  const poolLoadMs = performance.now() - tPoolLoad0;

  step('5:fourWorkerPoolRunStandard');
  const tPoolRun0 = performance.now();
  const poolDone = [false, false, false, false];
  const poolResults = await Promise.all(rpcs.map((call, idx) => call({
    kind: 'select',
    board: boardJson,
    player: idx % 2 === 0 ? 'WHITE' : 'BLACK',
    die1: POOL_ROLLS[idx][0],
    die2: POOL_ROLLS[idx][1],
    level: 'champion',
  }).then((res) => {
    poolDone[idx] = true;
    step(`5:fourWorkerPoolRun:${poolDone.map(Number).join('')}`);
    return res;
  })));
  const poolRunMs = performance.now() - tPoolRun0;

  step('5:fourWorkerPoolStatusStandard');
  const poolStatusesStd = await Promise.all(rpcs.map((call) => call({ kind: 'status' })));
  const perWorkerStdMemWithinBudget = poolStatusesStd.every((s) => {
    const m = toMiB(s.backendStatus.linearMemoryBytes);
    return Number.isFinite(m) && m > 0 && m <= SINGLE_WORKER_STANDARD_MAX_MIB;
  });
  const perWorkerStdHandlesLoaded = poolStatusesStd.every(
    (s) => s.backendStatus.activeHandles?.mlp === 2
      && s.backendStatus.activeHandles?.bearoff === 1
      && s.backendStatus.activeHandles?.bg2n === 0
      && s.backendStatus.activeHandles?.met === 1,
  );
  const totalPoolStdMemMiB = perWorkerStdMemWithinBudget
    ? toMiB(poolStatusesStd.reduce((sum, s) => sum + s.backendStatus.linearMemoryBytes, 0))
    : Number.NaN;
  const poolStdMemWithinBudget = perWorkerStdMemWithinBudget
    && Number.isFinite(totalPoolStdMemMiB)
    && totalPoolStdMemMiB > 0
    && totalPoolStdMemMiB <= FOUR_WORKER_STANDARD_MAX_MIB;

  // 5B: Trigger BG2N 6x6 unboundedMoney=true cube query on ALL 4 workers
  step('5:fourWorkerPoolBg2n');
  const poolBg2nResults = await Promise.all(rpcs.map((call, idx) => call({
    kind: 'cube',
    board: bg2nBoardJson,
    player: idx % 2 === 0 ? 'WHITE' : 'BLACK',
    cubeValue: 1,
    cubeOwner: null,
    jacoby: false,
    level: 'expert',
    match: null,
    ask: 'double',
    unboundedMoney: true,
  })));
  const poolBg2nParityMatch = poolBg2nResults.every((r, idx) => (
    r.answer === (idx % 2 === 0 ? jsBg2nW.answer : jsBg2nB.answer)
  ));
  const poolStatusesBg2n = await Promise.all(rpcs.map((call) => call({ kind: 'status' })));
  const perWorkerBg2nMemWithinBudget = poolStatusesBg2n.every((s) => {
    const m = toMiB(s.backendStatus.linearMemoryBytes);
    return Number.isFinite(m) && m > 0 && m <= SINGLE_WORKER_BG2N_MAX_MIB;
  });
  const perWorkerBg2nHandlesLoaded = poolStatusesBg2n.every(
    (s) => s.backendStatus.activeHandles?.mlp === 2
      && s.backendStatus.activeHandles?.bearoff === 1
      && s.backendStatus.activeHandles?.bg2n === 1
      && s.backendStatus.activeHandles?.met === 1,
  );
  const totalPoolBg2nMemMiB = perWorkerBg2nMemWithinBudget
    ? toMiB(poolStatusesBg2n.reduce((sum, s) => sum + s.backendStatus.linearMemoryBytes, 0))
    : Number.NaN;
  const poolBg2nMemWithinBudget = perWorkerBg2nMemWithinBudget
    && Number.isFinite(totalPoolBg2nMemMiB)
    && totalPoolBg2nMemMiB > 0
    && totalPoolBg2nMemMiB <= FOUR_WORKER_BG2N_MAX_MIB;

  for (const w of workers) w.terminate();

  const perfMem = performance.memory
    ? {
        usedJSHeapMiB: toMiB(performance.memory.usedJSHeapSize),
        totalJSHeapMiB: toMiB(performance.memory.totalJSHeapSize),
      }
    : null;

  checks.fourWorkerPool = {
    sameAssetSetAsSingleWorker: true,
    allConfiguredAuto: poolStatusesBg2n.every(
      (s) => s.backendStatus.configuredBackend === 'auto' && s.backendStatus.activeBackend === 'wasm',
    ),
    poolLoadMs: Number(poolLoadMs.toFixed(2)),
    poolRunMs: Number(poolRunMs.toFixed(2)),
    // Scenario 5A: Standard search (BG2N not yet uploaded)
    totalLinearMemoryMiB: totalPoolStdMemMiB,
    poolStandardBudgetMiB: FOUR_WORKER_STANDARD_MAX_MIB,
    perWorkerStdMemWithinBudget,
    poolStdMemWithinBudget,
    perWorkerStdHandlesLoaded,
    // Scenario 5B: After BG2N 6x6 upload on all 4 workers
    totalWithBg2nLinearMemoryMiB: totalPoolBg2nMemMiB,
    poolBg2nBudgetMiB: FOUR_WORKER_BG2N_MAX_MIB,
    perWorkerBg2nMemWithinBudget,
    poolBg2nMemWithinBudget,
    perWorkerBg2nHandlesLoaded,
    poolBg2nParityMatch,
    allExpectedVariant: poolStatusesBg2n.every(
      (s) => s.backendStatus.wasmVariant === expectedAutoVariant
        && s.backendStatus.simdActive === simdSupported,
    ),
    allSimdActive: poolStatusesBg2n.every((s) => s.backendStatus.simdActive),
    allReturnedValidKey: poolResults.every((r) => isNonEmptyString(r.key)),
    mainThreadJsHeap: perfMem,
    passed: poolStdMemWithinBudget
      && perWorkerStdHandlesLoaded
      && poolBg2nMemWithinBudget
      && perWorkerBg2nHandlesLoaded
      && poolBg2nParityMatch
      && poolStatusesBg2n.every(
        (s) => s.backendStatus.configuredBackend === 'auto'
          && s.backendStatus.activeBackend === 'wasm'
          && s.backendStatus.wasmReady
          && s.backendStatus.wasmVariant === expectedAutoVariant
          && s.backendStatus.simdActive === simdSupported,
      )
      && poolResults.every((r) => isNonEmptyString(r.key)),
  };

  autoSuiteChecks = checks;
  autoSuiteCompletedNormally = true;
  autoSuiteFatalError = null;

  const diagCheck = buildDiagnosticsCheck();
  const autoAllPassed = REQUIRED_AUTO_CHECK_KEYS.every(
    (k) => ({ ...checks, diagnostics: diagCheck })[k]?.passed === true,
  );
  currentRunRecord.completedAt = new Date().toISOString();
  currentRunRecord.autoPassed = autoAllPassed;
  persistHistory();

  // 実機専用: 4-Worker BG2N 持続セッション用の独立 JS 基準値を設定して UI を解放
  persistentPoolState.expectedExpertSelectKeys = jsPoolExpertRefs;
  persistentPoolState.expectedStandardCube = { white: jsCubeW.answer, black: jsCubeB.answer };
  persistentPoolState.expectedBg2n = { white: jsBg2nW.answer, black: jsBg2nB.answer };
  persistentPoolState.expectedChampionWorker0Key = wcRes.key;
  persistentPoolState.expectedAutoVariant = expectedAutoVariant;
  persistentPoolState.simdSupported = simdSupported;

  step('done');
  window.__VERIFY_DONE__ = true;
  renderPersistentPanel();
  refreshVerifyResultObject();
}

run().catch((err) => {
  autoSuiteCompletedNormally = false;
  autoSuiteFatalError = String(err?.stack || err);
  currentRunRecord.completedAt = new Date().toISOString();
  currentRunRecord.autoPassed = false;
  persistHistory();
  window.__VERIFY_DONE__ = true;
  renderPersistentPanel();
  refreshVerifyResultObject();
});
