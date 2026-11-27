// WebAssembly バックエンド管理および Rust `bg-core` (bg-wasm) との境界アダプタ。
//
// 設計方針（Issue #578 Phase 4b）:
// - 既定バックエンドは `'auto'`（WASM 優先）。
//   `initWasmEngine()` 済みかつ入力互換なら WASM を使い、
//   未初期化・非対応時は JS へフォールバックして `getEngineBackendStatus().fallbackReason` に理由を残す。
// - `'wasm'` 明示指定時は未初期化や非対応入力で黙って JS へフォールバックせず、
//   明示的なエラーを投げる。
// - `'js'` バックエンドは比較・切り戻し用の非推奨（deprecated）経路として Phase 4d まで保持する。
// - NeuralNet / CubeHead / BearoffDatabase / MoneyBearoffDatabase は WeakMap + FinalizationRegistry
//   でハンドルを 1 度だけアップロードして使い回す。
// - WebAssembly.Memory は成長時に ArrayBuffer が detach されるため、毎回最新の `memory.buffer` からビューを取る。

import { Board, WHITE, BLACK, opponent } from './board.js';
import { MET_LENGTH, PRE_CRAWFORD, POST_CRAWFORD } from './met-table.js';
import { CubeHead } from './nn.js';

export const WASM_ABI_VERSION = 1;
const PACKED_BOARD_BYTES = 28;
const PACKED_STEPS_BYTES = 17;
const ALL_ROLLS_MASK = (1 << 21) - 1;
const FILTER_LEVEL_NONE = 0xFFFFFFFF;
const DEFAULT_MOVEGEN_CAP = 256;

// 最小の WebAssembly SIMD128 検証モジュール（v128.const 0; i8x16.splat）
const WASM_SIMD_PROBE_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03,
  0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00,
  0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b,
]);

const VALID_BACKENDS = new Set(['js', 'wasm', 'auto']);

let configuredBackend = 'auto';
let lastFallbackReason = null;
let initFallbackReason = null;
let runtime = null;
let nextRuntimeId = 1;
let initGeneration = 0;

const textDecoder = new TextDecoder('utf-8');

/** 現在の実行環境が WebAssembly 自体をサポートするか判定する。 */
function isWebAssemblySupported() {
  return typeof WebAssembly === 'object'
    && WebAssembly !== null
    && typeof WebAssembly.instantiate === 'function';
}

/** 現在の実行環境が WebAssembly SIMD128 命令をサポートするか判定する。 */
export function detectWasmSimdSupport() {
  try {
    return typeof WebAssembly === 'object'
      && WebAssembly !== null
      && typeof WebAssembly.validate === 'function'
      && WebAssembly.validate(WASM_SIMD_PROBE_BYTES);
  } catch {
    return false;
  }
}

/** backend 指定が有効か検証する。不正値なら例外を投げる。 */
export function assertValidBackend(backend) {
  if (!VALID_BACKENDS.has(backend)) {
    throw new Error(`未対応の backend 指定です: ${backend} (expected 'js' | 'wasm' | 'auto')`);
  }
}

/**
 * バックエンド選択ポリシーを設定する（`'auto' | 'wasm' | 'js'`、既定 `'auto'`）。
 * `'js'` は比較・切り戻し用の非推奨（deprecated）経路であり、Phase 4d で廃止予定。
 */
export function setEngineBackend(backend) {
  assertValidBackend(backend);
  configuredBackend = backend;
  if (backend !== 'auto') {
    lastFallbackReason = null;
    initFallbackReason = null;
  }
}

/** 現在のバックエンド設定を返す（既定 `'auto'`）。 */
export function getEngineBackend() {
  return configuredBackend;
}

function defaultWasmAssetUrl(variant) {
  // Vite / Rollup / Webpack 5 が静的解析で両 .wasm アセットを dist へ出力・URL 書き換えできるよう
  // テンプレートリテラルではなく静的文字列リテラルで記述する（ADR-0183 Phase 4a）。
  if (variant === 'simd') {
    return new URL('../assets/bg_engine_simd.wasm', import.meta.url);
  }
  return new URL('../assets/bg_engine_scalar.wasm', import.meta.url);
}

async function loadWasmBytesFromUrl(urlLike) {
  const url = urlLike instanceof URL ? urlLike : new URL(String(urlLike), import.meta.url);
  if (url.protocol === 'file:') {
    // Vite / Rollup がブラウザバンドル時に静的解決しないよう動的文字列を使う
    const fsSpecifier = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ fsSpecifier);
    const buf = await readFile(url);
    return {
      bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      response: null,
      resolvedUrl: url.href,
    };
  }
  if (typeof fetch !== 'function') {
    throw new Error(`WASM URL を取得できません（fetch 未定義）: ${url.href}`);
  }
  const response = await fetch(url.href);
  if (!response.ok) {
    throw new Error(`WASM バイナリの取得に失敗しました: ${url.href} (HTTP ${response.status})`);
  }
  return { bytes: null, response, resolvedUrl: url.href };
}

function shouldUseSyncWorkerInstantiation() {
  const inWorker = typeof WorkerGlobalScope !== 'undefined'
    && typeof self !== 'undefined'
    && self instanceof WorkerGlobalScope;
  if (!inWorker) return false;
  const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
  // WebKit (Safari / iOS Safari / iOS CriOS・FxiOS / Playwright WebKit) の Web Worker では、
  // 非同期 WebAssembly.instantiate / instantiateStreaming の完了通知が間欠的に失われ
  // Promise が解決せずハングする挙動がある。
  // WebAssembly JS API 仕様上、Worker 内では 4 KiB 同期制限が無く同期コンパイルが合法のため、
  // WebKit Worker では new WebAssembly.Module / Instance を使用する。
  return /AppleWebKit/i.test(ua) && !/Chrome|Chromium|EdgA?|OPR|Android/i.test(ua);
}

async function instantiateWasmBytes(bytesOrBuffer) {
  if (shouldUseSyncWorkerInstantiation()) {
    try {
      const mod = new WebAssembly.Module(bytesOrBuffer);
      return new WebAssembly.Instance(mod, {});
    } catch (err) {
      if (!(err instanceof RangeError)) {
        throw err;
      }
    }
  }
  const { instance } = await WebAssembly.instantiate(bytesOrBuffer, {});
  return instance;
}

async function instantiateWasmModule({ bytes, response, resolvedUrl }) {
  if (bytes) {
    const instance = await instantiateWasmBytes(bytes);
    return { instance, byteLength: bytes.byteLength, sourceUrl: resolvedUrl };
  }
  let fallbackResponse = response;
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (
    !shouldUseSyncWorkerInstantiation()
    && typeof WebAssembly.instantiateStreaming === 'function'
    && contentType.toLowerCase().includes('application/wasm')
  ) {
    // instantiateStreaming が失敗した際に response.body が消費済みになり得るため、
    // 先に未消費の clone を確保して catch 後の arrayBuffer() フォールバックに使う。
    const backupClone = typeof response.clone === 'function' ? response.clone() : null;
    try {
      const { instance } = await WebAssembly.instantiateStreaming(response, {});
      let byteLength = Number(
        response.headers?.get?.('content-length')
        ?? backupClone?.headers?.get?.('content-length')
        ?? 0,
      );
      if (!Number.isFinite(byteLength) || byteLength <= 0) {
        if (backupClone) {
          byteLength = (await backupClone.arrayBuffer()).byteLength;
        } else {
          byteLength = 0;
        }
      } else {
        backupClone?.body?.cancel?.().catch(() => {});
      }
      return { instance, byteLength, sourceUrl: resolvedUrl };
    } catch {
      if (backupClone) {
        fallbackResponse = backupClone;
      }
    }
  }
  const arrayBuffer = await fallbackResponse.arrayBuffer();
  const instance = await instantiateWasmBytes(arrayBuffer);
  return { instance, byteLength: arrayBuffer.byteLength, sourceUrl: resolvedUrl };
}

class WasmRuntime {
  constructor(
    instance,
    { variant, byteLength, loadTimeMs, sourceUrl, simdFallbackReason = null, usesDefaultAsset = false },
  ) {
    const exports = instance.exports;
    if (typeof exports.bg_wasm_abi_version !== 'function') {
      throw new Error('無効な bg-wasm モジュールです（bg_wasm_abi_version が見つかりません）');
    }
    const abiVersion = exports.bg_wasm_abi_version() >>> 0;
    if (abiVersion !== WASM_ABI_VERSION) {
      throw new Error(`WASM ABI バージョン不一致: got ${abiVersion}, expected ${WASM_ABI_VERSION}`);
    }
    this.id = nextRuntimeId++;
    this.instance = instance;
    this.exports = exports;
    this.memory = exports.memory;
    this.abiVersion = abiVersion;
    this.simdActive = Boolean(exports.bg_wasm_has_simd128());
    this.variant = variant ?? (this.simdActive ? 'simd' : 'scalar');
    this.byteLength = byteLength;
    this.loadTimeMs = loadTimeMs;
    this.sourceUrl = sourceUrl ?? null;
    this.simdFallbackReason = simdFallbackReason ?? null;
    this.usesDefaultAsset = Boolean(usesDefaultAsset);
    this.disposed = false;

    this.mlpHandles = new WeakMap();
    this.cubeHeadHandles = new WeakMap();
    this.bearoffHandles = new WeakMap();
    this.bg2nHandles = new WeakMap();
    this.trackedHandles = {
      mlp: new Set(),
      cubeHead: new Set(),
      bearoff: new Set(),
      bg2n: new Set(),
    };

    this.finalizer = typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry(({ kind, handle, rt }) => {
          if (rt.disposed) return;
          rt.freeHandleByKind(kind, handle);
        })
      : null;

    // 定常呼び出し用の小型スクラッチ領域（16 KiB）を 1 回だけ確保して使い回す
    this.scratchBoardPtr = this.alloc(PACKED_BOARD_BYTES, 4);
    this.scratchEvalU32Ptr = this.alloc(16 * 4, 4);
    this.scratchEvalF64Ptr = this.alloc(16 * 8, 8);
    this.scratchCfgU32Ptr = this.alloc(32 * 4, 4);
    this.scratchCfgF64Ptr = this.alloc(16 * 8, 8);
    this.scratchOutF64Ptr = this.alloc(16 * 8, 8);
    this.scratchOutU32Ptr = this.alloc(16 * 4, 4);
    this.scratchMoveBoardsPtr = this.alloc(DEFAULT_MOVEGEN_CAP * PACKED_BOARD_BYTES, 4);
    this.scratchMoveStepsPtr = this.alloc(DEFAULT_MOVEGEN_CAP * PACKED_STEPS_BYTES, 4);

    // Kazaross XG2 MET を 1 度だけ作成して保持する
    this.metHandle = this.createDefaultMet();
  }

  alloc(size, align = 8) {
    const ptr = this.exports.bg_wasm_alloc(size, align) >>> 0;
    if (ptr === 0 && size > 0) {
      throw new Error(`WASM 線形メモリ確保に失敗しました (size=${size}, align=${align})`);
    }
    return ptr;
  }

  dealloc(ptr, size, align = 8) {
    if (ptr && size > 0) {
      this.exports.bg_wasm_dealloc(ptr, size, align);
    }
  }

  readLastError() {
    const len = this.exports.bg_wasm_last_error_len() >>> 0;
    if (len === 0) return 'unknown WASM error';
    const ptr = this.exports.bg_wasm_last_error_ptr() >>> 0;
    if (ptr === 0) return 'unknown WASM error';
    return textDecoder.decode(new Uint8Array(this.memory.buffer, ptr, len));
  }

  createDefaultMet() {
    const preFlat = new Float64Array(MET_LENGTH * MET_LENGTH);
    for (let i = 0; i < MET_LENGTH; i += 1) {
      const row = PRE_CRAWFORD[i];
      for (let j = 0; j < MET_LENGTH; j += 1) {
        preFlat[i * MET_LENGTH + j] = row[j];
      }
    }
    const postFlat = Float64Array.from(POST_CRAWFORD);
    const prePtr = this.alloc(preFlat.byteLength, 8);
    const postPtr = this.alloc(postFlat.byteLength, 8);
    try {
      new Float64Array(this.memory.buffer, prePtr, preFlat.length).set(preFlat);
      new Float64Array(this.memory.buffer, postPtr, postFlat.length).set(postFlat);
      const handle = this.exports.bg_wasm_met_create(
        MET_LENGTH, prePtr, preFlat.length, postPtr, postFlat.length,
      ) >>> 0;
      if (handle === 0) {
        throw new Error(`WASM MET 初期化失敗: ${this.readLastError()}`);
      }
      return handle;
    } finally {
      this.dealloc(prePtr, preFlat.byteLength, 8);
      this.dealloc(postPtr, postFlat.byteLength, 8);
    }
  }

  freeHandleByKind(kind, handle) {
    if (!handle || this.disposed) return false;
    this.trackedHandles[kind]?.delete(handle);
    if (kind === 'mlp') return Boolean(this.exports.bg_wasm_mlp_free(handle));
    if (kind === 'cubeHead') return Boolean(this.exports.bg_wasm_cube_head_free(handle));
    if (kind === 'bearoff') return Boolean(this.exports.bg_wasm_bearoff_free(handle));
    if (kind === 'bg2n') return Boolean(this.exports.bg_wasm_bg2n_free(handle));
    return false;
  }

  releaseResource(resource) {
    if (!resource || typeof resource !== 'object' || this.disposed) return false;
    let released = false;
    const mlp = this.mlpHandles.get(resource);
    if (mlp) {
      this.mlpHandles.delete(resource);
      this.finalizer?.unregister(resource);
      released = this.freeHandleByKind('mlp', mlp) || released;
      if (resource.cubeHeadMoney) this.releaseResource(resource.cubeHeadMoney);
      if (resource.cubeHeadMatch) this.releaseResource(resource.cubeHeadMatch);
    }
    const ch = this.cubeHeadHandles.get(resource);
    if (ch) {
      this.cubeHeadHandles.delete(resource);
      this.finalizer?.unregister(resource);
      released = this.freeHandleByKind('cubeHead', ch) || released;
    }
    const bo = this.bearoffHandles.get(resource);
    if (bo) {
      this.bearoffHandles.delete(resource);
      this.finalizer?.unregister(resource);
      released = this.freeHandleByKind('bearoff', bo) || released;
    }
    const bg2n = this.bg2nHandles.get(resource);
    if (bg2n) {
      this.bg2nHandles.delete(resource);
      this.finalizer?.unregister(resource);
      released = this.freeHandleByKind('bg2n', bg2n) || released;
    }
    return released;
  }

  activeHandleCounts() {
    const rc = this.exports.bg_wasm_stats_handles(this.scratchOutU32Ptr);
    if (rc !== 0) return null;
    const view = new Uint32Array(this.memory.buffer, this.scratchOutU32Ptr, 5);
    return {
      mlp: view[0],
      cubeHead: view[1],
      bearoff: view[2],
      bg2n: view[3],
      met: view[4],
    };
  }

  dispose() {
    if (this.disposed) return;
    for (const h of [...this.trackedHandles.mlp]) this.exports.bg_wasm_mlp_free(h);
    for (const h of [...this.trackedHandles.cubeHead]) this.exports.bg_wasm_cube_head_free(h);
    for (const h of [...this.trackedHandles.bearoff]) this.exports.bg_wasm_bearoff_free(h);
    for (const h of [...this.trackedHandles.bg2n]) this.exports.bg_wasm_bg2n_free(h);
    this.trackedHandles.mlp.clear();
    this.trackedHandles.cubeHead.clear();
    this.trackedHandles.bearoff.clear();
    this.trackedHandles.bg2n.clear();
    if (this.metHandle) {
      this.exports.bg_wasm_met_free(this.metHandle);
      this.metHandle = 0;
    }
    this.dealloc(this.scratchBoardPtr, PACKED_BOARD_BYTES, 4);
    this.dealloc(this.scratchEvalU32Ptr, 16 * 4, 4);
    this.dealloc(this.scratchEvalF64Ptr, 16 * 8, 8);
    this.dealloc(this.scratchCfgU32Ptr, 32 * 4, 4);
    this.dealloc(this.scratchCfgF64Ptr, 16 * 8, 8);
    this.dealloc(this.scratchOutF64Ptr, 16 * 8, 8);
    this.dealloc(this.scratchOutU32Ptr, 16 * 4, 4);
    this.dealloc(this.scratchMoveBoardsPtr, DEFAULT_MOVEGEN_CAP * PACKED_BOARD_BYTES, 4);
    this.dealloc(this.scratchMoveStepsPtr, DEFAULT_MOVEGEN_CAP * PACKED_STEPS_BYTES, 4);
    this.disposed = true;
  }

  ensureMlpHandle(net, { allowMoverPerspective = false } = {}) {
    const cached = this.mlpHandles.get(net);
    if (cached) return cached;

    const compat = checkNetCompatibility(net, { allowMoverPerspective });
    if (!compat.ok) {
      throw new Error(`WASM 非対応の NeuralNet です: ${compat.reason}`);
    }

    const dims = [net.inputDim, ...net.hiddenDims, net.outputDim];
    const numLayers = dims.length - 1;
    const dimsArr = new Uint32Array(numLayers * 2);
    let totalW = 0;
    let totalB = 0;
    for (let l = 0; l < numLayers; l += 1) {
      dimsArr[l * 2] = dims[l];
      dimsArr[l * 2 + 1] = dims[l + 1];
      totalW += dims[l] * dims[l + 1];
      totalB += dims[l + 1];
    }

    const weights = new Float32Array(totalW);
    const biases = new Float32Array(totalB);

    // Layer 0: flatFirst はすでに行優先 (inDim * outDim)
    weights.set(net.flatFirst, 0);
    biases.set(net.biasFirst, 0);
    let wOff = dims[0] * dims[1];
    let bOff = dims[1];

    // Layer 1..: JS NeuralNet の layers[l-1].flat は列優先 (outDim * inDim) なので行優先へ転置
    for (let l = 1; l < numLayers; l += 1) {
      const layer = net.layers[l - 1];
      const { flat, bias, inDim, outDim } = layer;
      for (let i = 0; i < inDim; i += 1) {
        const dstRow = wOff + i * outDim;
        for (let j = 0; j < outDim; j += 1) {
          weights[dstRow + j] = flat[j * inDim + i];
        }
      }
      biases.set(bias, bOff);
      wOff += inDim * outDim;
      bOff += outDim;
    }

    const actCode = net.activation === 'silu' ? 1 : 0;
    const trCode = net.outputTransform === 'hierarchical_cumulative_v1' ? 1 : 0;
    const perspCode = (net.perspective ?? 'white') === 'mover' ? 1 : 0;

    const dimsPtr = this.alloc(dimsArr.byteLength, 4);
    const wPtr = this.alloc(weights.byteLength, 4);
    const bPtr = this.alloc(biases.byteLength, 4);
    try {
      new Uint32Array(this.memory.buffer, dimsPtr, dimsArr.length).set(dimsArr);
      new Float32Array(this.memory.buffer, wPtr, weights.length).set(weights);
      new Float32Array(this.memory.buffer, bPtr, biases.length).set(biases);
      const handle = this.exports.bg_wasm_mlp_create(
        numLayers, dimsPtr, wPtr, bPtr, actCode, trCode, perspCode,
      ) >>> 0;
      if (handle === 0) {
        throw new Error(`WASM MLP 登録に失敗しました: ${this.readLastError()}`);
      }
      this.mlpHandles.set(net, handle);
      this.trackedHandles.mlp.add(handle);
      this.finalizer?.register(net, { kind: 'mlp', handle, rt: this }, net);
      return handle;
    } finally {
      this.dealloc(dimsPtr, dimsArr.byteLength, 4);
      this.dealloc(wPtr, weights.byteLength, 4);
      this.dealloc(bPtr, biases.byteLength, 4);
    }
  }

  ensureCubeHeadHandle(head, { net = null, label = 'cubeHead', minContextDim = 4 } = {}) {
    if (!head) return 0;
    const cached = this.cubeHeadHandles.get(head);
    if (cached) return cached;
    const compat = checkCubeHeadCompatibility(head, net, label, { minContextDim });
    if (!compat.ok) {
      throw new Error(`WASM 非対応の CubeHead オブジェクトです: ${compat.reason}`);
    }
    const inDim = head.hiddenDim + head.contextDim;
    const mlpDim = head.mlpDim;
    // columnsW1 は列優先 [mlpDim][inDim] なので行優先 [inDim][mlpDim] へ転置
    const w1 = new Float32Array(inDim * mlpDim);
    for (let j = 0; j < mlpDim; j += 1) {
      const col = head.columnsW1[j];
      for (let i = 0; i < inDim; i += 1) {
        w1[i * mlpDim + j] = col[i];
      }
    }
    const w1Ptr = this.alloc(w1.byteLength, 4);
    const b1Ptr = this.alloc(head.b1.byteLength, 4);
    const w2Ptr = this.alloc(head.colW2.byteLength, 4);
    try {
      new Float32Array(this.memory.buffer, w1Ptr, w1.length).set(w1);
      new Float32Array(this.memory.buffer, b1Ptr, head.b1.length).set(head.b1);
      new Float32Array(this.memory.buffer, w2Ptr, head.colW2.length).set(head.colW2);
      const handle = this.exports.bg_wasm_cube_head_create(
        head.hiddenDim,
        head.contextDim,
        mlpDim,
        head.baselineX,
        w1Ptr,
        b1Ptr,
        w2Ptr,
        head.b2,
      ) >>> 0;
      if (handle === 0) {
        throw new Error(`WASM CubeHead 登録に失敗しました: ${this.readLastError()}`);
      }
      this.cubeHeadHandles.set(head, handle);
      this.trackedHandles.cubeHead.add(handle);
      this.finalizer?.register(head, { kind: 'cubeHead', handle, rt: this }, head);
      return handle;
    } finally {
      this.dealloc(w1Ptr, w1.byteLength, 4);
      this.dealloc(b1Ptr, head.b1.byteLength, 4);
      this.dealloc(w2Ptr, head.colW2.byteLength, 4);
    }
  }

  ensureBearoffHandle(db) {
    if (!db) return 0;
    const cached = this.bearoffHandles.get(db);
    if (cached) return cached;
    if (!(db.buffer instanceof ArrayBuffer)) {
      throw new Error('WASM 非対応の BearoffDatabase です（buffer がありません）');
    }
    const bytes = new Uint8Array(db.buffer);
    const ptr = this.alloc(bytes.byteLength, 8);
    try {
      new Uint8Array(this.memory.buffer, ptr, bytes.byteLength).set(bytes);
      const handle = this.exports.bg_wasm_bearoff_load_bytes(ptr, bytes.byteLength) >>> 0;
      if (handle === 0) {
        throw new Error(`WASM Bearoff DB 読込に失敗しました: ${this.readLastError()}`);
      }
      this.bearoffHandles.set(db, handle);
      this.trackedHandles.bearoff.add(handle);
      this.finalizer?.register(db, { kind: 'bearoff', handle, rt: this }, db);
      return handle;
    } finally {
      this.dealloc(ptr, bytes.byteLength, 8);
    }
  }

  ensureBg2nHandle(db) {
    if (!db) return 0;
    const cached = this.bg2nHandles.get(db);
    if (cached) return cached;
    if (!(db.buffer instanceof ArrayBuffer)) {
      throw new Error('WASM 非対応の MoneyBearoffDatabase です（buffer がありません）');
    }
    const bytes = new Uint8Array(db.buffer);
    const ptr = this.alloc(bytes.byteLength, 8);
    try {
      new Uint8Array(this.memory.buffer, ptr, bytes.byteLength).set(bytes);
      const handle = this.exports.bg_wasm_bg2n_load_bytes(ptr, bytes.byteLength) >>> 0;
      if (handle === 0) {
        throw new Error(`WASM Money BG2N DB 読込に失敗しました: ${this.readLastError()}`);
      }
      this.bg2nHandles.set(db, handle);
      this.trackedHandles.bg2n.add(handle);
      this.finalizer?.register(db, { kind: 'bg2n', handle, rt: this }, db);
      return handle;
    } finally {
      this.dealloc(ptr, bytes.byteLength, 8);
    }
  }

  writeBoardTo(ptr, board) {
    const mem = new Uint8Array(this.memory.buffer, ptr, PACKED_BOARD_BYTES);
    const pts = board.points;
    for (let i = 0; i < 24; i += 1) {
      mem[i] = pts[i] & 0xff;
    }
    mem[24] = (board.bar.WHITE ?? board.bar[0] ?? 0) & 0xff;
    mem[25] = (board.bar.BLACK ?? board.bar[1] ?? 0) & 0xff;
    mem[26] = (board.off.WHITE ?? board.off[0] ?? 0) & 0xff;
    mem[27] = (board.off.BLACK ?? board.off[1] ?? 0) & 0xff;
  }

  readBoardFrom(ptr) {
    const i8 = new Int8Array(this.memory.buffer, ptr, 24);
    const u8 = new Uint8Array(this.memory.buffer, ptr + 24, 4);
    const points = new Array(24);
    for (let i = 0; i < 24; i += 1) points[i] = i8[i];
    return new Board(
      points,
      { [WHITE]: u8[0], [BLACK]: u8[1] },
      { [WHITE]: u8[2], [BLACK]: u8[3] },
    );
  }

  writeEvalConfig(net, pruneNet, bearoff, leafPruneCandidates = 0, leafPruneTolerance = 0) {
    const mlp = this.ensureMlpHandle(net, { allowMoverPerspective: false });
    const pruneMlp = pruneNet ? this.ensureMlpHandle(pruneNet, { allowMoverPerspective: true }) : 0;
    const bo = bearoff ? this.ensureBearoffHandle(bearoff) : 0;
    const u32 = new Uint32Array(this.memory.buffer, this.scratchEvalU32Ptr, 4);
    u32[0] = mlp;
    u32[1] = pruneMlp;
    u32[2] = bo;
    u32[3] = pruneMlp ? (leafPruneCandidates >>> 0) : 0;
    const f64 = new Float64Array(this.memory.buffer, this.scratchEvalF64Ptr, 1);
    f64[0] = leafPruneTolerance ?? 0;
  }

  withFilters(filters, fn) {
    const list = Array.isArray(filters) && filters.length > 0 ? filters : null;
    if (!list) return fn(0, 0, 0);
    const len = list.length;
    const cPtr = this.alloc(len * 4, 4);
    const tPtr = this.alloc(len * 8, 8);
    try {
      const cView = new Uint32Array(this.memory.buffer, cPtr, len);
      const tView = new Float64Array(this.memory.buffer, tPtr, len);
      for (let i = 0; i < len; i += 1) {
        cView[i] = list[i].candidates >>> 0;
        tView[i] = Number(list[i].tolerance ?? 0);
      }
      return fn(cPtr, tPtr, len);
    } finally {
      this.dealloc(cPtr, len * 4, 4);
      this.dealloc(tPtr, len * 8, 8);
    }
  }
}

// ── 初期化・解放・ステータス API ──────────────────────────────────────

async function loadAndInstantiateVariant({
  targetVariant,
  wasmUrl,
  wasmScalarUrl,
  wasmSimdUrl,
  wasmBytes,
  simdFallbackReason = null,
  usesDefaultAsset = false,
}) {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let source;
  if (wasmBytes) {
    const u8 = wasmBytes instanceof Uint8Array
      ? wasmBytes
      : new Uint8Array(wasmBytes);
    source = { bytes: u8, response: null, resolvedUrl: 'memory://wasmBytes' };
  } else {
    const targetUrl = wasmUrl
      ?? (targetVariant === 'simd' ? wasmSimdUrl : wasmScalarUrl)
      ?? defaultWasmAssetUrl(targetVariant);
    source = await loadWasmBytesFromUrl(targetUrl);
  }

  const { instance, byteLength, sourceUrl } = await instantiateWasmModule(source);
  const loadTimeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt;

  const nextRuntime = new WasmRuntime(instance, {
    variant: targetVariant,
    byteLength,
    loadTimeMs,
    sourceUrl,
    simdFallbackReason,
    usesDefaultAsset,
  });

  if (targetVariant === 'simd' && !nextRuntime.simdActive) {
    nextRuntime.dispose();
    throw new Error('SIMD128 バリアントが要求されましたが、読み込まれた WASM は scalar ビルドです');
  }
  if (targetVariant === 'scalar' && nextRuntime.simdActive) {
    nextRuntime.dispose();
    throw new Error('scalar バリアントが要求されましたが、読み込まれた WASM は SIMD128 ビルドです');
  }

  return nextRuntime;
}

/**
 * グローバル状態を一切変更せずに新しい WASM runtime を準備する。
 *
 * Worker の世代管理 (`loadGeneration`) や競合する `initWasmEngine()` で、
 * 最新世代が確定するまで既存 runtime を壊さないために準備と commit を分離する。
 *
 * 契約:
 * - `variant === 'auto'` かつ SIMD128 対応環境で SIMD 読込が失敗した場合、
 *   `wasmBytes` / `wasmUrl` 未指定かつ (`wasmSimdUrl` 未指定 または `wasmScalarUrl` も明示指定)
 *   のときのみ Scalar WASM へ自動縮退し、失敗理由を `simdFallbackReason` に記録する
 *   （`wasmSimdUrl` のみカスタム指定した場合は同梱 scalar へ勝手にフォールバックしない）。
 * - デフォルト URL 経由で Scalar へ縮退済みの場合、`forceReload === false` の後続 `variant: 'auto'`
 *   呼び出しでは有効な Scalar runtime（ハンドル・キャッシュ含む）をそのまま再利用し、
 *   SIMD 失敗と再初期化の反復を防ぐ。SIMD を再試行したい場合は `forceReload: true` または
 *   `variant: 'simd'` を指定する。
 */
export async function prepareWasmRuntime({
  variant = 'auto',
  wasmUrl = null,
  wasmScalarUrl = null,
  wasmSimdUrl = null,
  wasmBytes = null,
  forceReload = false,
} = {}) {
  if (!['auto', 'simd', 'scalar'].includes(variant)) {
    throw new Error(`未対応の wasm variant です: ${variant}`);
  }
  if (!isWebAssemblySupported()) {
    throw new Error('この実行環境は WebAssembly に対応していません');
  }
  const simdSupported = detectWasmSimdSupport();
  const chosenVariant = variant === 'auto'
    ? (simdSupported ? 'simd' : 'scalar')
    : variant;

  if (chosenVariant === 'simd' && !simdSupported) {
    throw new Error('WASM SIMD128 が要求されましたが、現在の環境は SIMD128 に対応していません');
  }

  const usesDefaultAssets = !wasmBytes && !wasmUrl && !wasmScalarUrl && !wasmSimdUrl;
  const canReuseDegradedScalar = variant === 'auto'
    && chosenVariant === 'simd'
    && runtime?.variant === 'scalar'
    && runtime?.usesDefaultAsset
    && runtime?.simdFallbackReason !== null;
  if (
    runtime && !runtime.disposed && !forceReload
    && usesDefaultAssets
    && (runtime.variant === chosenVariant || canReuseDegradedScalar)
  ) {
    return { reused: true, runtime };
  }

  const canFallbackToScalar = variant === 'auto'
    && chosenVariant === 'simd'
    && !wasmBytes
    && !wasmUrl
    && (wasmSimdUrl == null || wasmScalarUrl != null);

  try {
    const nextRuntime = await loadAndInstantiateVariant({
      targetVariant: chosenVariant,
      wasmUrl,
      wasmScalarUrl,
      wasmSimdUrl,
      wasmBytes,
      simdFallbackReason: null,
      usesDefaultAsset: usesDefaultAssets,
    });
    return { reused: false, runtime: nextRuntime };
  } catch (simdError) {
    if (!canFallbackToScalar) {
      throw simdError;
    }
    const simdMsg = String(simdError && simdError.message || simdError);
    try {
      const scalarRuntime = await loadAndInstantiateVariant({
        targetVariant: 'scalar',
        wasmUrl: null,
        wasmScalarUrl,
        wasmSimdUrl: null,
        wasmBytes: null,
        simdFallbackReason: simdMsg,
        usesDefaultAsset: usesDefaultAssets,
      });
      return { reused: false, runtime: scalarRuntime };
    } catch (scalarError) {
      const scalarMsg = String(scalarError && scalarError.message || scalarError);
      throw new Error(`WASM SIMD128/Scalar 双方の初期化に失敗しました (simd: ${simdMsg}; scalar: ${scalarMsg})`);
    }
  }
}

/** 採用されなかった準備済み WASM runtime を安全に解放する。 */
export function discardPreparedWasmRuntime(prepared) {
  if (!prepared || prepared.reused || !prepared.runtime) return;
  if (!prepared.runtime.disposed && prepared.runtime !== runtime) {
    prepared.runtime.dispose();
  }
}

/**
 * 準備済み WASM runtime（または auto 初期化失敗時の JS フォールバック状態）を同期的に確定する。
 *
 * - `prepared` があるとき: 旧 runtime を解放して新 runtime を有効化し、fallbackReason をクリアする。
 * - `prepared === null` かつ `disposeOnNull: true` のとき: 旧 runtime を解放して JS 状態へ遷移する。
 * - `fallbackReason` を渡したとき: `auto` モードの `getEngineBackendStatus().fallbackReason` に保持する。
 */
export function commitPreparedWasmRuntime(
  prepared,
  { backend = null, fallbackReason = undefined, disposeOnNull = false } = {},
) {
  // 状態変更・旧 runtime 破棄の前に backend 指定と prepared の妥当性を検証する。
  if (backend !== null && backend !== undefined) {
    assertValidBackend(backend);
  }
  if (prepared && prepared.runtime.disposed) {
    throw new Error('解放済みの WASM runtime は commit できません');
  }

  initGeneration += 1;
  if (prepared) {
    if (!prepared.reused) {
      if (runtime && !runtime.disposed && runtime !== prepared.runtime) {
        runtime.dispose();
      }
      runtime = prepared.runtime;
    }
    initFallbackReason = null;
    lastFallbackReason = null;
  } else if (disposeOnNull) {
    if (runtime && !runtime.disposed) {
      runtime.dispose();
    }
    runtime = null;
  }

  if (backend !== null && backend !== undefined) {
    setEngineBackend(backend);
  }
  if (fallbackReason !== undefined) {
    if (!prepared) {
      initFallbackReason = fallbackReason;
    }
    lastFallbackReason = fallbackReason;
  }
  return getEngineBackendStatus();
}

/**
 * WebAssembly バックエンドを非同期に初期化する。
 *
 * 既存の同期 API（`selectMove`, `analyzeChecker`, `analyzeCube` 等）は変えず、
 * 起動時または Worker `load` 時に 1 回だけこの関数を `await` する。
 *
 * 契約:
 * - メインスレッドの `initWasmEngine()` は `backend: 'auto'`（既定）であっても
 *   WASM 初期化に失敗した場合は Promise を reject する（未初期化の `'auto'` 状態なら
 *   `getEngineBackendStatus().fallbackReason` にも理由を記録する）。
 *   `try / catch` で受け止めた後も、同期 API 自体は `'auto'` のまま JS フォールバックで利用できる。
 * - 一方、`./worker` の `load` は実効 backend が `'auto'` の場合、WASM 初期化失敗時に
 *   JS へフォールバックして `{ ok: true, backendStatus }` で resolve する。
 */
export async function initWasmEngine({
  variant = 'auto',
  wasmUrl = null,
  wasmScalarUrl = null,
  wasmSimdUrl = null,
  wasmBytes = null,
  backend = null,
  forceReload = false,
} = {}) {
  if (backend !== null && backend !== undefined) {
    assertValidBackend(backend);
  }
  const gen = ++initGeneration;
  let prepared;
  try {
    prepared = await prepareWasmRuntime({
      variant,
      wasmUrl,
      wasmScalarUrl,
      wasmSimdUrl,
      wasmBytes,
      forceReload,
    });
  } catch (error) {
    const effectiveBackend = backend ?? configuredBackend;
    if (gen === initGeneration && (!runtime || runtime.disposed) && effectiveBackend === 'auto') {
      initFallbackReason = String(error && error.message || error);
      lastFallbackReason = initFallbackReason;
    }
    throw error;
  }
  if (gen !== initGeneration) {
    discardPreparedWasmRuntime(prepared);
    return getEngineBackendStatus();
  }
  return commitPreparedWasmRuntime(prepared, { backend });
}

/** 初期化済み WASM インスタンスおよび全ネイティブリソースハンドルを解放する。 */
export function disposeWasmEngine() {
  initGeneration += 1;
  if (runtime && !runtime.disposed) {
    runtime.dispose();
  }
  runtime = null;
  initFallbackReason = null;
  lastFallbackReason = null;
}

/** 特定の NeuralNet / CubeHead / BearoffDatabase / MoneyBearoffDatabase の WASM ハンドルを即時解放する。 */
export function releaseWasmHandle(resource) {
  if (!runtime || runtime.disposed) return false;
  return runtime.releaseResource(resource);
}

/** WASM 内部キャッシュ（葉ベクトルキャッシュ / サブツリーキャッシュ）をクリアする。 */
export function clearWasmCaches() {
  if (runtime && !runtime.disposed) {
    runtime.exports.bg_wasm_clear_caches();
  }
}

/** 現在のエンジンバックエンド状態・SIMD 有効状態・ハンドル数・メモリ使用量を返す。 */
export function getEngineBackendStatus() {
  const simdSupported = detectWasmSimdSupport();
  const wasmReady = Boolean(runtime && !runtime.disposed);
  const autoFallback = configuredBackend === 'auto'
    ? (lastFallbackReason ?? initFallbackReason)
    : null;
  const activeBackend = configuredBackend === 'js'
    ? 'js'
    : (wasmReady && !(configuredBackend === 'auto' && autoFallback) ? 'wasm' : 'js');
  return {
    configuredBackend,
    activeBackend,
    wasmReady,
    runtimeId: wasmReady ? runtime.id : null,
    wasmVariant: wasmReady ? runtime.variant : null,
    simdSupported,
    simdActive: wasmReady ? runtime.simdActive : false,
    abiVersion: wasmReady ? runtime.abiVersion : null,
    wasmByteLength: wasmReady ? runtime.byteLength : null,
    loadTimeMs: wasmReady ? runtime.loadTimeMs : null,
    sourceUrl: wasmReady ? runtime.sourceUrl : null,
    fallbackReason: autoFallback,
    simdFallbackReason: wasmReady ? runtime.simdFallbackReason : null,
    activeHandles: wasmReady ? runtime.activeHandleCounts() : null,
    linearMemoryBytes: wasmReady ? runtime.memory.buffer.byteLength : null,
  };
}

// ── 互換性チェック・バックエンド解決 ──────────────────────────────────

/**
 * NeuralNet が JS 実装と同一セマンティクスで WASM 実行可能か検証する。
 *
 * - JS の `nn.js` は `'sigmoid'` と `'silu'` のみ実装（他は sigmoid にフォールバック）するため、
 *   `'relu'` 等を WASM へ通すと JS と意味が食い違う。したがって `'sigmoid' | 'silu'` のみ許可する。
 * - JS の主ネット評価 (`vectorFor`) は White 視点固定 (`encodeBoard(board, WHITE, turn)`) なのに対し、
 *   `pruneNet` (`equitiesWithNet`) は `'white'` / `'mover'` 両方に対応する。
 *   主ネットは `'white'` のみ許可し、`pruneNet` は `allowMoverPerspective: true` で `'mover'` も許可する。
 */
export function checkNetCompatibility(net, { allowMoverPerspective = false } = {}) {
  if (!net || typeof net !== 'object') {
    return { ok: false, reason: 'net is null or not an object' };
  }
  if (!(net.flatFirst instanceof Float32Array) || !(net.biasFirst instanceof Float32Array)) {
    return { ok: false, reason: 'net does not expose Float32Array weights (mock or custom net)' };
  }
  if (
    !Array.isArray(net.hiddenDims)
    || net.hiddenDims.length < 1
    || !Array.isArray(net.layers)
    || net.layers.length !== net.hiddenDims.length
  ) {
    return { ok: false, reason: 'net layer metadata is missing or inconsistent' };
  }
  if (net.inputDim !== 198 || net.outputDim !== 5) {
    return { ok: false, reason: `unsupported dimensions (${net.inputDim} -> ${net.outputDim})` };
  }
  if ((net.features ?? 'none') !== 'none') {
    return { ok: false, reason: `unsupported features mode: ${net.features}` };
  }
  const perspective = net.perspective ?? 'white';
  const allowedPerspectives = allowMoverPerspective ? ['white', 'mover'] : ['white'];
  if (!allowedPerspectives.includes(perspective)) {
    return {
      ok: false,
      reason: `unsupported perspective for ${allowMoverPerspective ? 'pruneNet' : 'main net'}: ${perspective}`,
    };
  }
  const activation = net.activation ?? 'sigmoid';
  if (!['sigmoid', 'silu'].includes(activation)) {
    return { ok: false, reason: `unsupported activation: ${activation} (supported: sigmoid, silu)` };
  }
  if (
    !['independent_sigmoid', 'hierarchical_cumulative_v1'].includes(
      net.outputTransform ?? 'independent_sigmoid',
    )
  ) {
    return { ok: false, reason: `unsupported outputTransform: ${net.outputTransform}` };
  }
  return { ok: true, reason: null };
}

/**
 * CubeHead が WASM へアップロード可能かつ主ネットの最終隠れ層次元と整合するか検証する。
 */
export function checkCubeHeadCompatibility(
  head,
  net = null,
  label = 'cubeHead',
  { minContextDim = 4 } = {},
) {
  if (!head) return { ok: true, reason: null };
  if (typeof head !== 'object') {
    return { ok: false, reason: `${label} is not an object` };
  }
  if (
    !Array.isArray(head.columnsW1)
    || !(head.b1 instanceof Float32Array)
    || !(head.colW2 instanceof Float32Array)
  ) {
    return { ok: false, reason: `${label} does not expose Float32Array weights (custom JS CubeHead)` };
  }
  if (typeof head.predict === 'function' && head.predict !== CubeHead.prototype.predict) {
    return { ok: false, reason: `${label} uses custom predict() implementation` };
  }
  const { hiddenDim, contextDim, mlpDim, baselineX, b2 } = head;
  if (!Number.isInteger(hiddenDim) || hiddenDim <= 0) {
    return { ok: false, reason: `${label} has invalid hiddenDim: ${hiddenDim}` };
  }
  if (!Number.isInteger(contextDim) || contextDim < minContextDim) {
    return { ok: false, reason: `${label} has invalid contextDim: ${contextDim} (min ${minContextDim})` };
  }
  if (!Number.isInteger(mlpDim) || mlpDim <= 0) {
    return { ok: false, reason: `${label} has invalid mlpDim: ${mlpDim}` };
  }
  if (!Number.isFinite(baselineX) || !Number.isFinite(b2)) {
    return { ok: false, reason: `${label} has non-finite baselineX or b2` };
  }
  const inDim = hiddenDim + contextDim;
  if (head.columnsW1.length !== mlpDim || head.b1.length !== mlpDim || head.colW2.length !== mlpDim) {
    return { ok: false, reason: `${label} weight dimensions do not match mlpDim=${mlpDim}` };
  }
  for (let j = 0; j < mlpDim; j += 1) {
    const col = head.columnsW1[j];
    if (!(col instanceof Float32Array || Array.isArray(col)) || col.length !== inDim) {
      return { ok: false, reason: `${label} columnsW1[${j}] length does not match hiddenDim+contextDim=${inDim}` };
    }
  }
  if (net && Array.isArray(net.hiddenDims) && net.hiddenDims.length > 0) {
    const lastHiddenDim = net.hiddenDims[net.hiddenDims.length - 1];
    if (hiddenDim !== lastHiddenDim) {
      return {
        ok: false,
        reason: `${label} hiddenDim (${hiddenDim}) does not match net last hidden dim (${lastHiddenDim})`,
      };
    }
  }
  return { ok: true, reason: null };
}

function checkBearoffCompatibility(bearoff) {
  if (!bearoff) return { ok: true, reason: null };
  if (!(bearoff.buffer instanceof ArrayBuffer)) {
    return { ok: false, reason: 'bearoff database does not expose raw ArrayBuffer' };
  }
  return { ok: true, reason: null };
}

/**
 * 指定コンテキストで `'wasm'` と `'js'` のどちらを使うか厳密に解決する。
 *
 * - `'wasm'` 明示時: 未初期化・非対応入力では必ず例外を投げ、黙って JS へ落とさない。
 * - `'auto'` 時: 条件を満たせば `'wasm'`、満たさなければ `fallbackReason` を記録して `'js'`。
 * - `'js'` 時: 常に `'js'`。
 */
export function resolveEngineBackend({
  backend = null,
  net = undefined,
  pruneNet = null,
  bearoff = null,
  moneyBearoff = null,
  cubeHeadMoney = null,
  cubeHeadMatch = null,
  requireBoardObject = null,
} = {}) {
  const pref = backend ?? configuredBackend;
  if (!VALID_BACKENDS.has(pref)) {
    throw new Error(`未対応の backend 指定です: ${pref}`);
  }
  if (pref === 'js') return 'js';

  let reason = null;
  if (!runtime || runtime.disposed) {
    reason = (pref === 'auto' && initFallbackReason)
      ? initFallbackReason
      : 'WASM backend is not initialized (call await initWasmEngine() first)';
  } else if (requireBoardObject !== null && !Array.isArray(requireBoardObject?.points)) {
    reason = 'board object does not expose standard 24-point array';
  } else if (net !== undefined) {
    const netCheck = checkNetCompatibility(net, { allowMoverPerspective: false });
    if (!netCheck.ok) reason = netCheck.reason;
  }
  if (!reason && cubeHeadMoney) {
    const headCheck = checkCubeHeadCompatibility(cubeHeadMoney, net, 'cubeHeadMoney', { minContextDim: 4 });
    if (!headCheck.ok) reason = headCheck.reason;
  }
  if (!reason && cubeHeadMatch) {
    const headCheck = checkCubeHeadCompatibility(cubeHeadMatch, net, 'cubeHeadMatch', { minContextDim: 6 });
    if (!headCheck.ok) reason = headCheck.reason;
  }
  if (!reason && pruneNet) {
    const pruneCheck = checkNetCompatibility(pruneNet, { allowMoverPerspective: true });
    if (!pruneCheck.ok) reason = `pruneNet incompatible: ${pruneCheck.reason}`;
  }
  if (!reason && bearoff) {
    const boCheck = checkBearoffCompatibility(bearoff);
    if (!boCheck.ok) reason = boCheck.reason;
  }
  if (!reason && moneyBearoff && !(moneyBearoff.buffer instanceof ArrayBuffer)) {
    reason = 'moneyBearoff database does not expose raw ArrayBuffer';
  }

  if (reason) {
    if (pref === 'wasm') {
      throw new Error(`WASM バックエンドを実行できません: ${reason}`);
    }
    lastFallbackReason = reason;
    return 'js';
  }

  if (pref === 'auto') {
    lastFallbackReason = null;
  }
  return 'wasm';
}

function requireRuntime() {
  if (!runtime || runtime.disposed) {
    throw new Error('WASM backend is not initialized (call await initWasmEngine() first)');
  }
  return runtime;
}

function encodePlayer(player) {
  if (player === WHITE || player === 'white') return 0;
  if (player === BLACK || player === 'black') return 1;
  throw new Error(`unknown player: ${player}`);
}

function encodeOwner(owner) {
  if (owner === 'center' || owner === null || owner === undefined) return 0;
  if (owner === 'me') return 1;
  if (owner === 'opponent') return 2;
  throw new Error(`unknown cube owner: ${owner}`);
}

function encodeRollMask(rollIndices) {
  if (rollIndices === null || rollIndices === undefined) return ALL_ROLLS_MASK;
  let mask = 0;
  for (let i = 0; i < rollIndices.length; i += 1) {
    const idx = rollIndices[i];
    if (!Number.isInteger(idx) || idx < 0 || idx >= 21) {
      throw new Error(`rollIndices out of range: ${idx}`);
    }
    mask |= (1 << idx);
  }
  return mask >>> 0;
}

// ── コア演算ラッパー ──────────────────────────────────────────────────

/**
 * 合法手（盤面 + 手順ステップ配列）を WASM で生成する。
 * `rules.js` との循環参照を避けるため、生の `{ singles, resultingBoard }` 配列を返す。
 */
export function wasmGenerateMovesRaw(board, player, die1, die2) {
  const rt = requireRuntime();
  const pl = encodePlayer(player);
  rt.writeBoardTo(rt.scratchBoardPtr, board);

  let boardsPtr = rt.scratchMoveBoardsPtr;
  let stepsPtr = rt.scratchMoveStepsPtr;
  let cap = DEFAULT_MOVEGEN_CAP;
  let allocated = false;

  try {
    let count = rt.exports.bg_wasm_movegen_detailed(
      rt.scratchBoardPtr, pl, die1 >>> 0, die2 >>> 0, boardsPtr, stepsPtr, cap,
    );
    if (count < 0) {
      throw new Error(`WASM movegen 失敗: ${rt.readLastError()}`);
    }
    if (count === 0) return [];

    if (count > cap) {
      cap = count;
      boardsPtr = rt.alloc(cap * PACKED_BOARD_BYTES, 4);
      stepsPtr = rt.alloc(cap * PACKED_STEPS_BYTES, 4);
      allocated = true;
      count = rt.exports.bg_wasm_movegen_detailed(
        rt.scratchBoardPtr, pl, die1 >>> 0, die2 >>> 0, boardsPtr, stepsPtr, cap,
      );
      if (count < 0) {
        throw new Error(`WASM movegen 再試行失敗: ${rt.readLastError()}`);
      }
    }

    const out = new Array(count);
    const stepsBuf = new Uint8Array(rt.memory.buffer, stepsPtr, count * PACKED_STEPS_BYTES);
    const stepsI8 = new Int8Array(rt.memory.buffer, stepsPtr, count * PACKED_STEPS_BYTES);

    for (let i = 0; i < count; i += 1) {
      const resultingBoard = rt.readBoardFrom(boardsPtr + i * PACKED_BOARD_BYTES);
      const sOff = i * PACKED_STEPS_BYTES;
      const len = stepsBuf[sOff];
      const singles = new Array(len);
      for (let s = 0; s < len; s += 1) {
        const base = sOff + 1 + s * 4;
        const fromRaw = stepsI8[base];
        const toRaw = stepsI8[base + 1];
        const die = stepsBuf[base + 2];
        const hit = stepsBuf[base + 3] !== 0;
        singles[s] = {
          from: fromRaw < 0 ? null : fromRaw,
          to: toRaw < 0 ? null : toRaw,
          die,
          hit,
        };
      }
      out[i] = { singles, resultingBoard };
    }
    return out;
  } finally {
    if (allocated) {
      rt.dealloc(boardsPtr, cap * PACKED_BOARD_BYTES, 4);
      rt.dealloc(stepsPtr, cap * PACKED_STEPS_BYTES, 4);
    }
  }
}

/** 複数盤面の White 視点 5-vector を 1 回の WASM 呼び出しで評価する。 */
export function wasmEvalBoardsVectors(net, bearoff, boards, turn) {
  const n = boards.length;
  if (n === 0) return [];
  const rt = requireRuntime();
  const mlp = rt.ensureMlpHandle(net);
  const bo = bearoff ? rt.ensureBearoffHandle(bearoff) : 0;
  const pl = encodePlayer(turn);

  const boardsPtr = rt.alloc(n * PACKED_BOARD_BYTES, 4);
  const outPtr = rt.alloc(n * 5 * 4, 4);
  try {
    for (let i = 0; i < n; i += 1) {
      rt.writeBoardTo(boardsPtr + i * PACKED_BOARD_BYTES, boards[i]);
    }
    const rc = rt.exports.bg_wasm_eval_boards_vectors(mlp, bo, boardsPtr, n, pl, outPtr);
    if (rc !== 0) {
      throw new Error(`WASM eval_boards_vectors 失敗: ${rt.readLastError()}`);
    }
    const flat = new Float32Array(rt.memory.buffer, outPtr, n * 5);
    const out = new Array(n);
    for (let i = 0; i < n; i += 1) {
      out[i] = Float32Array.from(flat.subarray(i * 5, (i + 1) * 5));
    }
    return out;
  } finally {
    rt.dealloc(boardsPtr, n * PACKED_BOARD_BYTES, 4);
    rt.dealloc(outPtr, n * 5 * 4, 4);
  }
}

/** 複数盤面の `turn` 視点 cubeless equity を 1 回の WASM 呼び出しで評価する。 */
export function wasmEvalBoardsEquities(net, bearoff, boards, turn) {
  const n = boards.length;
  if (n === 0) return new Float64Array(0);
  const rt = requireRuntime();
  const mlp = rt.ensureMlpHandle(net);
  const bo = bearoff ? rt.ensureBearoffHandle(bearoff) : 0;
  const pl = encodePlayer(turn);

  const boardsPtr = rt.alloc(n * PACKED_BOARD_BYTES, 4);
  const outPtr = rt.alloc(n * 8, 8);
  try {
    for (let i = 0; i < n; i += 1) {
      rt.writeBoardTo(boardsPtr + i * PACKED_BOARD_BYTES, boards[i]);
    }
    const rc = rt.exports.bg_wasm_eval_boards_equities(mlp, bo, boardsPtr, n, pl, outPtr);
    if (rc !== 0) {
      throw new Error(`WASM eval_boards_equities 失敗: ${rt.readLastError()}`);
    }
    return Float64Array.from(new Float64Array(rt.memory.buffer, outPtr, n));
  } finally {
    rt.dealloc(boardsPtr, n * PACKED_BOARD_BYTES, 4);
    rt.dealloc(outPtr, n * 8, 8);
  }
}

/** BG2N strict exact-root を WASM で評価する（循環依存を避け `{ ok, result | category, message }` を返す）。 */
export function wasmEvaluateMoneyBg2nRootRaw(board, turn, cubeValue, owner, moneyBearoff, allowDouble = true) {
  const rt = requireRuntime();
  const bg2n = rt.ensureBg2nHandle(moneyBearoff);
  const pl = encodePlayer(turn);
  const own = encodeOwner(owner);
  rt.writeBoardTo(rt.scratchBoardPtr, board);

  const rc = rt.exports.bg_wasm_bg2n_eval_root(
    bg2n,
    rt.scratchBoardPtr,
    pl,
    cubeValue >>> 0,
    own,
    allowDouble ? 1 : 0,
    rt.scratchOutF64Ptr,
    rt.scratchOutU32Ptr,
  );
  if (rc === 0) {
    const f = new Float64Array(rt.memory.buffer, rt.scratchOutF64Ptr, 6);
    const actionCode = new Uint32Array(rt.memory.buffer, rt.scratchOutU32Ptr, 1)[0];
    const action = actionCode === 1 ? 'double_take' : actionCode === 2 ? 'double_pass' : 'no_double';
    return {
      ok: true,
      result: {
        action,
        cube: cubeValue,
        owner,
        ND_points: f[0],
        DT_points: Number.isNaN(f[1]) ? null : f[1],
        DP_points: Number.isNaN(f[2]) ? null : f[2],
        no_double: f[3],
        double_take: f[4],
        double_pass: f[5],
      },
    };
  }
  const message = rt.readLastError();
  const category = rc === 1
    ? 'unsupported_root'
    : rc === 2
      ? 'child_miss'
      : 'runtime_error';
  return { ok: false, category, message };
}

/** 1 ロール標準偏差 (`rollVolatility`) を WASM で計算する。 */
export function wasmRollVolatility(agent, board, toMove) {
  const rt = requireRuntime();
  const mlp = rt.ensureMlpHandle(agent.net);
  const bo = agent.bearoff ? rt.ensureBearoffHandle(agent.bearoff) : 0;
  const pl = encodePlayer(toMove);
  rt.writeBoardTo(rt.scratchBoardPtr, board);
  const rc = rt.exports.bg_wasm_roll_volatility(
    mlp, bo, rt.scratchBoardPtr, pl, rt.scratchOutF64Ptr,
  );
  if (rc !== 0) {
    throw new Error(`WASM roll_volatility 失敗: ${rt.readLastError()}`);
  }
  return new Float64Array(rt.memory.buffer, rt.scratchOutF64Ptr, 1)[0];
}

/** Money CubeHead による `[xNd, xDt]` を WASM で推論する。 */
export function wasmCubeHeadMoneyEfficiencies(
  agent, board, proposer, cubeValue, owner, { floorNd = null, floorDt = null } = {},
) {
  const rt = requireRuntime();
  const mlp = rt.ensureMlpHandle(agent.net);
  const bo = agent.bearoff ? rt.ensureBearoffHandle(agent.bearoff) : 0;
  const head = rt.ensureCubeHeadHandle(agent.cubeHeadMoney, {
    net: agent.net, label: 'cubeHeadMoney', minContextDim: 4,
  });
  const pl = encodePlayer(proposer);
  const own = encodeOwner(owner);
  const resolvedFloorNd = floorNd ?? (agent.cubeEfficiencyFloor ?? 0);
  const resolvedFloorDt = floorDt ?? (
    (agent.cubeEfficiencyFloorDt ?? 0) > 0 ? agent.cubeEfficiencyFloorDt : resolvedFloorNd
  );
  rt.writeBoardTo(rt.scratchBoardPtr, board);
  const rc = rt.exports.bg_wasm_cube_head_money_efficiencies(
    mlp, bo, head, rt.scratchBoardPtr, pl, cubeValue >>> 0, own,
    resolvedFloorNd, resolvedFloorDt, rt.scratchOutF64Ptr,
  );
  if (rc !== 0) {
    throw new Error(`WASM cube_head_money_efficiencies 失敗: ${rt.readLastError()}`);
  }
  const out = new Float64Array(rt.memory.buffer, rt.scratchOutF64Ptr, 2);
  return [out[0], out[1]];
}

/** Match CubeHead による `[xNd, xDt]` を WASM で推論する。 */
export function wasmCubeHeadMatchEfficiencies(agent, board, proposer, cubeValue, owner, match) {
  const rt = requireRuntime();
  const mlp = rt.ensureMlpHandle(agent.net);
  const bo = agent.bearoff ? rt.ensureBearoffHandle(agent.bearoff) : 0;
  const head = rt.ensureCubeHeadHandle(agent.cubeHeadMatch, {
    net: agent.net, label: 'cubeHeadMatch', minContextDim: 6,
  });
  const pl = encodePlayer(proposer);
  const own = encodeOwner(owner);
  rt.writeBoardTo(rt.scratchBoardPtr, board);
  const rc = rt.exports.bg_wasm_cube_head_match_efficiencies(
    mlp, bo, head, rt.scratchBoardPtr, pl, cubeValue >>> 0, own,
    match.away[WHITE] | 0, match.away[BLACK] | 0, match.crawfordPlayed ? 1 : 0,
    rt.scratchOutF64Ptr,
  );
  if (rc !== 0) {
    throw new Error(`WASM cube_head_match_efficiencies 失敗: ${rt.readLastError()}`);
  }
  const out = new Float64Array(rt.memory.buffer, rt.scratchOutF64Ptr, 2);
  return [out[0], out[1]];
}

/** Cubeless N-ply 期待 equity (`expandRolls`) を WASM で実行する。 */
export function wasmSearchCubelessEquity(agent, board, toMove, viewer, depth, level, useCache = true) {
  const rt = requireRuntime();
  rt.writeEvalConfig(
    agent.net,
    agent.pruneNet,
    agent.bearoff,
    agent.leafPruneCandidates,
    agent.leafPruneTolerance,
  );
  rt.writeBoardTo(rt.scratchBoardPtr, board);
  const tm = encodePlayer(toMove);
  const vw = encodePlayer(viewer);
  return rt.withFilters(agent.filters, (cPtr, tPtr, fLen) => {
    const rc = rt.exports.bg_wasm_search_cubeless_equity(
      rt.scratchEvalU32Ptr,
      rt.scratchEvalF64Ptr,
      rt.scratchBoardPtr,
      tm,
      vw,
      depth >>> 0,
      level >>> 0,
      cPtr,
      tPtr,
      fLen,
      useCache ? 1 : 0,
      rt.scratchOutF64Ptr,
    );
    if (rc !== 0) {
      throw new Error(`WASM search_cubeless_equity 失敗: ${rt.readLastError()}`);
    }
    return new Float64Array(rt.memory.buffer, rt.scratchOutF64Ptr, 1)[0];
  });
}

/** Cubeless `expandRollsVector`（ロールマスク対応）を WASM で実行する。 */
export function wasmSearchVectorRolls(agent, board, toMove, depth, level, rollIndices = null, useCache = false) {
  const rt = requireRuntime();
  rt.writeEvalConfig(
    agent.net,
    agent.pruneNet,
    agent.bearoff,
    agent.leafPruneCandidates,
    agent.leafPruneTolerance,
  );
  rt.writeBoardTo(rt.scratchBoardPtr, board);
  const tm = encodePlayer(toMove);
  const mask = encodeRollMask(rollIndices);
  return rt.withFilters(agent.filters, (cPtr, tPtr, fLen) => {
    const rc = rt.exports.bg_wasm_search_vector_rolls(
      rt.scratchEvalU32Ptr,
      rt.scratchEvalF64Ptr,
      rt.scratchBoardPtr,
      tm,
      depth >>> 0,
      level >>> 0,
      mask,
      cPtr,
      tPtr,
      fLen,
      useCache ? 1 : 0,
      rt.scratchOutF64Ptr,
    );
    if (rc !== 0) {
      throw new Error(`WASM search_vector_rolls 失敗: ${rt.readLastError()}`);
    }
    const v = new Float64Array(rt.memory.buffer, rt.scratchOutF64Ptr, 5);
    return [v[0], v[1], v[2], v[3], v[4]];
  });
}

function writeMoneyConfig(rt, agent, {
  cubeValue = 1,
  leaf = null,
  cubeEfficiency = null,
  cashOption = false,
  cashAlpha = null,
  cashPolicy = null,
  allowDouble = true,
  actionContext = 'post_no_double',
  unboundedMoney = false,
}) {
  const postDt = actionContext === 'post_double_take';
  let cashMode = 0;
  let alpha = cashAlpha ?? agent.cubeCashAlpha;
  if (!postDt) {
    if (cashPolicy) {
      cashMode = 2; // Policy
      alpha = cashPolicy.alpha ?? alpha;
    } else if (cashOption) {
      cashMode = 1; // Legacy
    }
  }
  const leafPlies = leaf ?? agent.cubeLeafPlies;
  const u32 = new Uint32Array(rt.memory.buffer, rt.scratchCfgU32Ptr, 10);
  u32[0] = cubeValue >>> 0;
  u32[1] = leafPlies >>> 0;
  u32[2] = cashMode;
  u32[3] = allowDouble ? 1 : 0;
  u32[4] = unboundedMoney ? 1 : 0;
  u32[5] = 0; // bearoff_early_cutoff (JS 互換: false)
  u32[6] = agent.cubeSearchDepth >>> 0;
  u32[7] = agent.cubeFilterLevel === null || agent.cubeFilterLevel === undefined
    ? FILTER_LEVEL_NONE
    : (agent.cubeFilterLevel >>> 0);
  u32[8] = 1; // use_leaf_cache
  u32[9] = 0; // bg2n_leaf_handle (JS では leaf DB 不使用)

  const f64 = new Float64Array(rt.memory.buffer, rt.scratchCfgF64Ptr, 2);
  f64[0] = cubeEfficiency ?? agent.cubeEfficiency;
  f64[1] = alpha;
  return postDt;
}

/** Money `cubefulSearch`（ロールマスク対応）を WASM で実行する。 */
export function wasmMoneyCubefulSearch(
  agent,
  board,
  turn,
  owner,
  depth,
  jacoby,
  leaf = null,
  cubeEfficiency = null,
  options = {},
  clearCache = true,
) {
  const rt = requireRuntime();
  rt.writeEvalConfig(
    agent.net,
    agent.pruneNet,
    agent.bearoff,
    agent.leafPruneCandidates,
    agent.leafPruneTolerance,
  );
  rt.writeBoardTo(rt.scratchBoardPtr, board);
  const postDt = writeMoneyConfig(rt, agent, {
    ...options,
    leaf,
    cubeEfficiency,
  });
  const pl = encodePlayer(turn);
  const own = encodeOwner(owner);
  const mask = encodeRollMask(options.rollIndices ?? null);
  return rt.withFilters(agent.cubeFilters, (cPtr, tPtr, fLen) => (
    rt.withFilters(agent.filters, (lfCPtr, lfTPtr, lfLen) => {
      const rc = rt.exports.bg_wasm_money_cubeful_search(
        rt.scratchEvalU32Ptr,
        rt.scratchEvalF64Ptr,
        rt.scratchBoardPtr,
        pl,
        own,
        depth >>> 0,
        jacoby ? 1 : 0,
        postDt ? 1 : 0,
        mask,
        clearCache ? 1 : 0,
        rt.scratchCfgU32Ptr,
        rt.scratchCfgF64Ptr,
        cPtr,
        tPtr,
        fLen,
        lfCPtr,
        lfTPtr,
        lfLen,
        rt.scratchOutF64Ptr,
      );
      if (rc !== 0) {
        throw new Error(`WASM money_cubeful_search 失敗: ${rt.readLastError()}`);
      }
      return new Float64Array(rt.memory.buffer, rt.scratchOutF64Ptr, 1)[0];
    })
  ));
}

/** Money ND/DT 両枝を共有フレーム＆共有キャッシュで一括評価する。 */
export function wasmMoneyCubeActionValues(
  agent,
  board,
  turn,
  owner,
  depth,
  jacoby,
  leaf,
  xNd,
  xDt,
  computeDt = true,
  options = {},
  clearCache = true,
) {
  const rt = requireRuntime();
  rt.writeEvalConfig(
    agent.net,
    agent.pruneNet,
    agent.bearoff,
    agent.leafPruneCandidates,
    agent.leafPruneTolerance,
  );
  rt.writeBoardTo(rt.scratchBoardPtr, board);
  writeMoneyConfig(rt, agent, {
    ...options,
    leaf,
    cubeEfficiency: xNd ?? agent.cubeEfficiency,
    actionContext: 'post_no_double',
  });
  const pl = encodePlayer(turn);
  const own = encodeOwner(owner);
  const mask = encodeRollMask(options.rollIndices ?? null);
  return rt.withFilters(agent.cubeFilters, (cPtr, tPtr, fLen) => (
    rt.withFilters(agent.filters, (lfCPtr, lfTPtr, lfLen) => {
      const rc = rt.exports.bg_wasm_money_cube_action_values(
        rt.scratchEvalU32Ptr,
        rt.scratchEvalF64Ptr,
        rt.scratchBoardPtr,
        pl,
        own,
        depth >>> 0,
        jacoby ? 1 : 0,
        xNd ?? agent.cubeEfficiency,
        xDt ?? agent.cubeEfficiency,
        computeDt ? 1 : 0,
        mask,
        clearCache ? 1 : 0,
        rt.scratchCfgU32Ptr,
        rt.scratchCfgF64Ptr,
        cPtr,
        tPtr,
        fLen,
        lfCPtr,
        lfTPtr,
        lfLen,
        rt.scratchOutF64Ptr,
      );
      if (rc !== 0) {
        throw new Error(`WASM money_cube_action_values 失敗: ${rt.readLastError()}`);
      }
      const out = new Float64Array(rt.memory.buffer, rt.scratchOutF64Ptr, 2);
      return { noDouble: out[0], doubleTake: out[1] };
    })
  ));
}

function writeMatchConfig(rt, agent, match, {
  leaf = null,
  matchCubeEfficiency = null,
  allowDouble = true,
}) {
  const leafPlies = leaf ?? agent.cubeLeafPlies;
  const u32 = new Uint32Array(rt.memory.buffer, rt.scratchCfgU32Ptr, 12);
  u32[0] = (match.away[WHITE] | 0) >>> 0;
  u32[1] = (match.away[BLACK] | 0) >>> 0;
  u32[2] = match.crawfordPlayed ? 1 : 0;
  u32[3] = leafPlies >>> 0;
  u32[4] = 0; // MwcLeafModel::Dead (JS mwcLeaf と同一)
  u32[5] = 0; // MwcCenterModel::Min (JS mwcLeaf と同一)
  u32[6] = 0; // ResponseFilterMode::Money (ADR-0150 既定)
  u32[7] = allowDouble ? 1 : 0;
  u32[8] = 0; // bearoff_early_cutoff (JS 互換: false)
  u32[9] = agent.cubeSearchDepth >>> 0;
  u32[10] = agent.cubeFilterLevel === null || agent.cubeFilterLevel === undefined
    ? FILTER_LEVEL_NONE
    : (agent.cubeFilterLevel >>> 0);
  u32[11] = 1; // use_leaf_cache

  const f64 = new Float64Array(rt.memory.buffer, rt.scratchCfgF64Ptr, 1);
  f64[0] = matchCubeEfficiency ?? agent.matchCubeEfficiency;
}

/** Match `mwcSearch`（ロールマスク対応）を WASM で実行する。 */
export function wasmMatchMwcSearch(
  agent,
  board,
  turn,
  owner,
  depth,
  cube,
  match,
  leaf = null,
  matchCubeEfficiency = null,
  allowDouble = true,
  rollIndices = null,
  clearCache = true,
) {
  const rt = requireRuntime();
  rt.writeEvalConfig(
    agent.net,
    agent.pruneNet,
    agent.bearoff,
    agent.leafPruneCandidates,
    agent.leafPruneTolerance,
  );
  rt.writeBoardTo(rt.scratchBoardPtr, board);
  writeMatchConfig(rt, agent, match, { leaf, matchCubeEfficiency, allowDouble });
  const pl = encodePlayer(turn);
  const own = encodeOwner(owner);
  const mask = encodeRollMask(rollIndices);
  return rt.withFilters(agent.cubeFilters, (cPtr, tPtr, fLen) => (
    rt.withFilters(agent.filters, (lfCPtr, lfTPtr, lfLen) => {
      const rc = rt.exports.bg_wasm_match_mwc_search(
        rt.scratchEvalU32Ptr,
        rt.scratchEvalF64Ptr,
        rt.metHandle,
        rt.scratchBoardPtr,
        pl,
        own,
        depth >>> 0,
        cube >>> 0,
        mask,
        clearCache ? 1 : 0,
        rt.scratchCfgU32Ptr,
        rt.scratchCfgF64Ptr,
        cPtr,
        tPtr,
        fLen,
        lfCPtr,
        lfTPtr,
        lfLen,
        rt.scratchOutF64Ptr,
      );
      if (rc !== 0) {
        throw new Error(`WASM match_mwc_search 失敗: ${rt.readLastError()}`);
      }
      return new Float64Array(rt.memory.buffer, rt.scratchOutF64Ptr, 1)[0];
    })
  ));
}

/** Match ND/DT/DP を共有フレーム＆共有キャッシュで一括評価する。 */
export function wasmMatchCubeActionValues(
  agent,
  board,
  turn,
  owner,
  depth,
  cube,
  match,
  leaf,
  xNd,
  xDt,
  computeDt = true,
  allowDouble = true,
  rollIndices = null,
  clearCache = true,
) {
  const rt = requireRuntime();
  rt.writeEvalConfig(
    agent.net,
    agent.pruneNet,
    agent.bearoff,
    agent.leafPruneCandidates,
    agent.leafPruneTolerance,
  );
  rt.writeBoardTo(rt.scratchBoardPtr, board);
  writeMatchConfig(rt, agent, match, {
    leaf,
    matchCubeEfficiency: xNd ?? agent.matchCubeEfficiency,
    allowDouble,
  });
  const pl = encodePlayer(turn);
  const own = encodeOwner(owner);
  const mask = encodeRollMask(rollIndices);
  return rt.withFilters(agent.cubeFilters, (cPtr, tPtr, fLen) => (
    rt.withFilters(agent.filters, (lfCPtr, lfTPtr, lfLen) => {
      const rc = rt.exports.bg_wasm_match_cube_action_values(
        rt.scratchEvalU32Ptr,
        rt.scratchEvalF64Ptr,
        rt.metHandle,
        rt.scratchBoardPtr,
        pl,
        own,
        depth >>> 0,
        cube >>> 0,
        xNd ?? agent.matchCubeEfficiency,
        xDt ?? agent.matchCubeEfficiency,
        computeDt ? 1 : 0,
        mask,
        clearCache ? 1 : 0,
        rt.scratchCfgU32Ptr,
        rt.scratchCfgF64Ptr,
        cPtr,
        tPtr,
        fLen,
        lfCPtr,
        lfTPtr,
        lfLen,
        rt.scratchOutF64Ptr,
      );
      if (rc !== 0) {
        throw new Error(`WASM match_cube_action_values 失敗: ${rt.readLastError()}`);
      }
      const out = new Float64Array(rt.memory.buffer, rt.scratchOutF64Ptr, 3);
      return { noDouble: out[0], doubleTake: out[1], doublePass: out[2] };
    })
  ));
}

/**
 * 複数候補手の一括評価（通常単一深さ & staged3ply の両対応）を 1 回の WASM 呼び出しで実行する。
 */
export function wasmScoreCheckerCandidates(agent, {
  boards,
  player,
  match,
  cubeEnabled,
  canOffer,
  cubeValue,
  ownerOfNext,
  jacoby,
  unboundedMoney,
  depth,
  staged = false,
  stagedFirstMargin = 0.160,
  stagedSecondMargin = 0.080,
  suppliedEffs = null,
  captureProbVectors = false,
}) {
  const n = boards.length;
  if (n === 0) {
    return { values: [], stages: [], effs: [], probVectors: null, stagedStats: null };
  }
  const rt = requireRuntime();
  rt.writeEvalConfig(
    agent.net,
    agent.pruneNet,
    agent.bearoff,
    agent.leafPruneCandidates,
    agent.leafPruneTolerance,
  );

  let mode;
  if (match) {
    mode = cubeEnabled ? 3 : 2;
  } else {
    mode = cubeEnabled ? 1 : 0;
  }

  let cubeHeadHandle = 0;
  if (mode === 1 && agent.useCubeHead && agent.cubeHeadMoney) {
    cubeHeadHandle = rt.ensureCubeHeadHandle(agent.cubeHeadMoney, {
      net: agent.net, label: 'cubeHeadMoney', minContextDim: 4,
    });
  } else if (mode === 3 && agent.useCubeHead && agent.cubeHeadMatch) {
    cubeHeadHandle = rt.ensureCubeHeadHandle(agent.cubeHeadMatch, {
      net: agent.net, label: 'cubeHeadMatch', minContextDim: 6,
    });
  }

  const floorNd = agent.cubeEfficiencyFloor ?? 0;
  const floorDt = (agent.cubeEfficiencyFloorDt ?? 0) > 0 ? agent.cubeEfficiencyFloorDt : floorNd;

  const cu = new Uint32Array(rt.memory.buffer, rt.scratchCfgU32Ptr, 19);
  cu[0] = mode;
  cu[1] = encodePlayer(player);
  cu[2] = depth >>> 0;
  cu[3] = staged ? 1 : 0;
  cu[4] = cubeValue >>> 0;
  cu[5] = encodeOwner(ownerOfNext);
  cu[6] = canOffer ? 1 : 0;
  cu[7] = jacoby ? 1 : 0;
  cu[8] = unboundedMoney ? 1 : 0;
  cu[9] = agent.cubeCashOption ? 1 : 0;
  cu[10] = match ? ((match.away[WHITE] | 0) >>> 0) : 0;
  cu[11] = match ? ((match.away[BLACK] | 0) >>> 0) : 0;
  cu[12] = match?.crawfordPlayed ? 1 : 0;
  cu[13] = agent.cubeSearchDepth >>> 0;
  cu[14] = agent.cubeFilterLevel === null || agent.cubeFilterLevel === undefined
    ? FILTER_LEVEL_NONE
    : (agent.cubeFilterLevel >>> 0);
  cu[15] = match ? rt.metHandle : 0;
  cu[16] = cubeHeadHandle;
  cu[17] = suppliedEffs ? 1 : 0;
  cu[18] = captureProbVectors && mode === 0 ? 1 : 0;

  const cf = new Float64Array(rt.memory.buffer, rt.scratchCfgF64Ptr, 9);
  cf[0] = agent.cubeEfficiency;
  cf[1] = agent.cubeEfficiencyDt;
  cf[2] = agent.cubeEfficiencyDtRace;
  cf[3] = agent.matchCubeEfficiency;
  cf[4] = agent.cubeCashAlpha;
  cf[5] = floorNd;
  cf[6] = floorDt;
  cf[7] = stagedFirstMargin;
  cf[8] = stagedSecondMargin;

  const candPtr = rt.alloc(n * PACKED_BOARD_BYTES, 4);
  const outValPtr = rt.alloc(n * 8, 8);
  const outStagePtr = rt.alloc(n, 1);
  const outEffPtr = rt.alloc(n * 2 * 8, 8);
  const supEffPtr = suppliedEffs ? rt.alloc(n * 2 * 8, 8) : 0;
  const outProbPtr = (captureProbVectors && mode === 0) ? rt.alloc(n * 5 * 8, 8) : 0;

  try {
    for (let i = 0; i < n; i += 1) {
      rt.writeBoardTo(candPtr + i * PACKED_BOARD_BYTES, boards[i]);
    }
    if (suppliedEffs) {
      const supView = new Float64Array(rt.memory.buffer, supEffPtr, n * 2);
      for (let i = 0; i < n; i += 1) {
        const eff = suppliedEffs[i];
        supView[i * 2] = eff && eff.xNd !== null && eff.xNd !== undefined ? eff.xNd : Number.NaN;
        supView[i * 2 + 1] = eff && eff.xDt !== null && eff.xDt !== undefined ? eff.xDt : Number.NaN;
      }
    }

    return rt.withFilters(agent.filters, (fCPtr, fTPtr, fLen) => (
      rt.withFilters(agent.cubeFilters, (cfCPtr, cfTPtr, cfLen) => {
        const rc = rt.exports.bg_wasm_score_checker_candidates(
          rt.scratchEvalU32Ptr,
          rt.scratchEvalF64Ptr,
          candPtr,
          n,
          rt.scratchCfgU32Ptr,
          rt.scratchCfgF64Ptr,
          supEffPtr,
          fCPtr,
          fTPtr,
          fLen,
          cfCPtr,
          cfTPtr,
          cfLen,
          outValPtr,
          outStagePtr,
          outEffPtr,
          outProbPtr,
          staged ? rt.scratchOutU32Ptr : 0,
        );
        if (rc !== 0) {
          throw new Error(`WASM score_checker_candidates 失敗: ${rt.readLastError()}`);
        }
        const values = Array.from(new Float64Array(rt.memory.buffer, outValPtr, n));
        const stages = Array.from(new Uint8Array(rt.memory.buffer, outStagePtr, n));
        const effFlat = new Float64Array(rt.memory.buffer, outEffPtr, n * 2);
        const effs = new Array(n);
        for (let i = 0; i < n; i += 1) {
          const xNd = effFlat[i * 2];
          const xDt = effFlat[i * 2 + 1];
          effs[i] = {
            xNd: Number.isNaN(xNd) ? null : xNd,
            xDt: Number.isNaN(xDt) ? null : xDt,
          };
        }
        let probVectors = null;
        if (outProbPtr) {
          const pFlat = new Float64Array(rt.memory.buffer, outProbPtr, n * 5);
          probVectors = new Array(n);
          for (let i = 0; i < n; i += 1) {
            const base = i * 5;
            probVectors[i] = [
              pFlat[base], pFlat[base + 1], pFlat[base + 2], pFlat[base + 3], pFlat[base + 4],
            ];
          }
        }
        let stagedStats = null;
        if (staged) {
          const sView = new Uint32Array(rt.memory.buffer, rt.scratchOutU32Ptr, 4);
          stagedStats = {
            onePlyCandidates: sView[0],
            twoPlyCandidates: sView[1],
            threePlyCandidates: sView[2],
            maxAdditionalDepth: sView[3],
          };
        }
        return { values, stages, effs, probVectors, stagedStats };
      })
    ));
  } finally {
    rt.dealloc(candPtr, n * PACKED_BOARD_BYTES, 4);
    rt.dealloc(outValPtr, n * 8, 8);
    rt.dealloc(outStagePtr, n, 1);
    rt.dealloc(outEffPtr, n * 2 * 8, 8);
    if (supEffPtr) rt.dealloc(supEffPtr, n * 2 * 8, 8);
    if (outProbPtr) rt.dealloc(outProbPtr, n * 5 * 8, 8);
  }
}

/** Cubeless `Agent.selectMove` を 1 回の WASM 呼び出しで実行する。 */
export function wasmSelectMoveCubeless(agent, originBoard, candidateBoards, player, needExactEquity = false) {
  const n = candidateBoards.length;
  if (n === 0) return { index: -1, equity: 0 };
  if (n === 1 && !needExactEquity) return { index: 0, equity: 0 };
  const rt = requireRuntime();
  rt.writeEvalConfig(
    agent.net,
    agent.pruneNet,
    agent.bearoff,
    agent.leafPruneCandidates,
    agent.leafPruneTolerance,
  );
  rt.writeBoardTo(rt.scratchBoardPtr, originBoard);
  const pl = encodePlayer(player);
  const candPtr = rt.alloc(n * PACKED_BOARD_BYTES, 4);
  try {
    for (let i = 0; i < n; i += 1) {
      rt.writeBoardTo(candPtr + i * PACKED_BOARD_BYTES, candidateBoards[i]);
    }
    return rt.withFilters(agent.filters, (cPtr, tPtr, fLen) => {
      const rc = rt.exports.bg_wasm_search_cubeless_select(
        rt.scratchEvalU32Ptr,
        rt.scratchEvalF64Ptr,
        rt.scratchBoardPtr,
        candPtr,
        n,
        pl,
        agent.searchPlies >>> 0,
        cPtr,
        tPtr,
        fLen,
        agent.searchPlies >= 3 ? 1 : 0,
        needExactEquity ? 1 : 0,
        rt.scratchOutU32Ptr,
        rt.scratchOutF64Ptr,
      );
      if (rc !== 0) {
        throw new Error(`WASM search_cubeless_select 失敗: ${rt.readLastError()}`);
      }
      const index = new Uint32Array(rt.memory.buffer, rt.scratchOutU32Ptr, 1)[0];
      const eq = new Float64Array(rt.memory.buffer, rt.scratchOutF64Ptr, 1)[0];
      return { index, equity: eq };
    });
  } finally {
    rt.dealloc(candPtr, n * PACKED_BOARD_BYTES, 4);
  }
}

