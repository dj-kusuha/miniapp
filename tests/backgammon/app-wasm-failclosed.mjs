// Issue #578 Phase 4c: app.js 対局中 Worker 失敗・停止時のバックエンド契約回帰テスト
// - ?backend=wasm: 起動後の Worker RPC 失敗・合法手不一致・Worker 停止でメイン JS 思考へフォールバックせず
//   fail-closed で安全に中断し、UI (#hint.error / #again) と __BG_BACKEND_DIAG__.runtimeError に明示すること
//   （無限 busy / advising / thinking や unhandledRejection を残さない。合法手 1 件の非探索処理は継続可）
// - ?backend=auto: 起動後の Worker RPC 失敗・停止時に従来どおりメインスレッド JS 思考で継続できること

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Board, WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import { ROLLING, MOVING, DOUBLING_PROPOSED, Game } from '../../docs/backgammon/src/game.js';
import { generateMoves } from '../../docs/backgammon/src/rules.js';

const unhandledRejections = [];
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push(reason);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const html = readFileSync(new URL('../../docs/backgammon/index.html', import.meta.url), 'utf8');
const modelText = readFileSync(new URL('../../docs/backgammon/src/model.json', import.meta.url), 'utf8');
const pruneText = readFileSync(new URL('../../docs/backgammon/src/prune_net.json', import.meta.url), 'utf8');
const bearoffBuf = readFileSync(new URL('../../docs/backgammon/src/bearoff-6x15.bin', import.meta.url));
const moneyBuf = readFileSync(new URL('../../docs/backgammon/src/money-bg2n-6x6-v4.bin', import.meta.url));
const metaText = readFileSync(new URL('../../docs/backgammon/assets/metadata.json', import.meta.url), 'utf8');

class ClassList {
  constructor() { this._set = new Set(); }
  add(...names) { for (const n of names) this._set.add(n); }
  remove(...names) { for (const n of names) this._set.delete(n); }
  toggle(name, force) {
    if (force === undefined) {
      if (this._set.has(name)) this._set.delete(name);
      else this._set.add(name);
    } else if (force) this._set.add(name);
    else this._set.delete(name);
  }
  contains(name) { return this._set.has(name); }
}

function createDomEnv(search, workerController) {
  const elements = new Map();
  class DOMElement {
    constructor(tag, id = '') {
      this.tagName = tag.toUpperCase();
      this._id = id;
      if (id) elements.set(id, this);
      this.className = '';
      this.classList = new ClassList();
      this.children = [];
      this.parentElement = null;
      this.hidden = false;
      this.disabled = false;
      this.textContent = '';
      this.title = '';
      this.value = '1';
      this.checked = false;
      this.style = {};
      this.dataset = {};
      this._listeners = {};
    }
    get id() { return this._id; }
    set id(val) {
      this._id = val;
      if (val) elements.set(val, this);
    }
    addEventListener(event, handler) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(handler);
    }
    dispatchEvent(event) {
      const handlers = this._listeners[event.type || event] || [];
      for (const h of handlers) h(event);
    }
    click() {
      this.dispatchEvent({ type: 'click', detail: 0, preventDefault() {} });
    }
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    }
    replaceChildren(...newChildren) {
      this.children = [];
      for (const c of newChildren) this.appendChild(c);
    }
    setAttribute(name, val) { this[name] = val; }
    getAttribute(name) { return this[name]; }
    removeAttribute(name) { delete this[name]; }
    focus() {}
    scrollIntoView() {}
    querySelectorAll() { return []; }
  }

  for (const match of html.matchAll(/\bid=["']([^"']+)["']/g)) {
    const id = match[1];
    if (!elements.has(id)) new DOMElement('div', id);
  }
  // start button starts disabled as in index.html
  elements.get('start').disabled = true;

  const storage = new Map();
  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => new DOMElement(tag),
    querySelectorAll: () => [],
  };
  globalThis.localStorage = {
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  };
  globalThis.window = globalThis;
  globalThis.window.matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: `http://127.0.0.1/backgammon/${search}`, search },
  });
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('metadata.json')) return { ok: true, json: async () => JSON.parse(metaText) };
    if (s.includes('prune_net.json')) return { ok: true, json: async () => JSON.parse(pruneText) };
    if (s.includes('model.json')) return { ok: true, json: async () => JSON.parse(modelText) };
    if (s.includes('bearoff-6x15.bin')) {
      return {
        ok: true,
        arrayBuffer: async () => bearoffBuf.buffer.slice(bearoffBuf.byteOffset, bearoffBuf.byteOffset + bearoffBuf.byteLength),
      };
    }
    if (s.includes('money-bg2n-6x6-v4.bin')) {
      return {
        ok: true,
        arrayBuffer: async () => moneyBuf.buffer.slice(moneyBuf.byteOffset, moneyBuf.byteOffset + moneyBuf.byteLength),
      };
    }
    return { ok: false, status: 404 };
  };

  let nextRuntimeId = 1;
  globalThis.Worker = class FakeWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      this.runtimeId = nextRuntimeId++;
    }
    terminate() {}
    postMessage(data) {
      queueMicrotask(() => {
        const { id, kind } = data;
        if (kind === 'load') {
          this.onmessage?.({
            data: {
              id,
              ok: true,
              pruneNetLoaded: true,
              pruneNetStatus: 'loaded',
              backendStatus: {
                configuredBackend: data.backend ?? 'auto',
                activeBackend: 'wasm',
                wasmReady: true,
                wasmVariant: 'simd',
                simdActive: true,
                runtimeId: this.runtimeId,
                fallbackReason: null,
                simdFallbackReason: null,
                abiVersion: 1,
                linearMemoryBytes: 18_000_000,
              },
            },
          });
          return;
        }
        if (kind === 'status') {
          this.onmessage?.({
            data: {
              id,
              ok: true,
              backendStatus: {
                configuredBackend: 'wasm',
                activeBackend: 'wasm',
                wasmReady: true,
                wasmVariant: 'simd',
                simdActive: true,
                runtimeId: this.runtimeId,
                fallbackReason: null,
                simdFallbackReason: null,
                abiVersion: 1,
                linearMemoryBytes: 18_000_000,
              },
            },
          });
          return;
        }
        if (kind === 'dispose') {
          this.onmessage?.({ data: { id, ok: true } });
          return;
        }
        if (workerController.mode === 'reject') {
          this.onmessage?.({
            data: { id, ok: false, error: `simulated ${kind} rpc failure` },
          });
          return;
        }
        if (workerController.mode === 'mismatch-key') {
          if (kind === 'select') {
            this.onmessage?.({ data: { id, ok: true, index: 0, key: 'non-existent-board-key' } });
            return;
          }
          if (kind === 'rank') {
            this.onmessage?.({
              data: {
                id,
                ok: true,
                unit: 'equity',
                evaluation: 'money',
                entries: [{ index: 0, key: 'non-existent-board-key', equity: 0, loss: 0, probabilities: { win1: 0.5, win2: 0, win3: 0, lose1: 0.5, lose2: 0, lose3: 0 } }],
              },
            });
            return;
          }
        }
        this.onmessage?.({
          data: { id, ok: false, error: `unexpected mode=${workerController.mode} kind=${kind}` },
        });
      });
    }
  };

  return { elements };
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function setupPosition(game, { player, phase, board = new Board(), die1 = 3, die2 = 1 }) {
  game.board = board;
  game.currentPlayer = player;
  game.state = phase;
  if (phase === MOVING) {
    game.roll = { die1, die2 };
    game.legalMoves = generateMoves(board, player, die1, die2, 'js');
  } else {
    game.roll = null;
    game.legalMoves = [];
  }
}

function makeForcedSingleMoveBoardForBlack() {
  // Black enters from bar on 1-pt (index 0) with 1, then only one legal move with 1-2:
  // block Black's points 1..5 (indices 1..5) with White anchors; leave index 0 open;
  // put 1 Black checker on bar and 14 on index 23 (already at last point, cannot move with 2).
  // With dice 1, 2: bar -> 0 (1), 0 -> 2 blocked -> only 1 legal move (bar -> 0)!
  const pts = new Array(24).fill(0);
  pts[1] = 2; pts[2] = 2; pts[3] = 2; pts[4] = 2; pts[5] = 2; pts[6] = 5;
  pts[23] = -14;
  return new Board(pts, { [WHITE]: 0, [BLACK]: 1 }, { [WHITE]: 0, [BLACK]: 0 });
}

// ── 1. ?backend=wasm: mid-game Worker failure / mismatch / termination MUST fail-closed ──
{
  const ctrl = { mode: 'reject' };
  const { elements } = createDomEnv('?backend=wasm', ctrl);
  const mod = await import(`../../docs/backgammon/app.js?scenario=wasm-${Date.now()}`);
  const { state, render, afterChange, thinker } = mod;

  await waitFor(() => !elements.get('start').disabled, 'wasm startup ready');
  assert.equal(globalThis.__BG_BACKEND_DIAG__.workerPool.allWasm, true);
  assert.equal(globalThis.__BG_BACKEND_DIAG__.mainThreadBackend.activeBackend, 'js');
  assert.equal(globalThis.__BG_BACKEND_DIAG__.runtimeError, null);

  state.delay = 0;
  state.autoRoll = false;
  state.autoForce = false;
  elements.get('start').click();
  state.runId += 1; // cancel any opening AI loop
  state.busy = false;
  state.level = 'intermediate'; // 1-ply select path so mismatch-key also hits select

  // 1a. Hint RPC reject -> fail-closed (no main JS fallback)
  setupPosition(state.game, { player: WHITE, phase: MOVING, die1: 3, die2: 1 });
  state.turn = null;
  state.advice = null;
  render();
  ctrl.mode = 'reject';
  elements.get('advice-button').click();
  await waitFor(() => !state.advising && state.runtimeError !== null, 'wasm hint rpc reject');
  assert.equal(state.advice, null, 'wasm hint failure must not fall back to main JS advice');
  assert.equal(state.advising, false);
  assert.equal(state.busy, false);
  assert.match(state.runtimeError, /ヒント計算/);
  assert.equal(globalThis.__BG_BACKEND_DIAG__.runtimeError, state.runtimeError);
  assert.equal(elements.get('hint').classList.contains('error'), true);
  assert.equal(elements.get('hint').textContent, state.runtimeError);

  // 1b. AI checker RPC reject -> fail-closed (no main JS move applied, busy/thinking cleared)
  state.match.useCube = false;
  setupPosition(state.game, { player: BLACK, phase: MOVING, die1: 3, die2: 1 });
  assert.ok(state.game.legalMoves.length > 1);
  ctrl.mode = 'reject';
  await afterChange();
  assert.equal(state.busy, false);
  assert.equal(state.thinking, false);
  assert.equal(state.anim, null);
  assert.equal(state.game.currentPlayer, BLACK, 'AI must not silently apply main JS move on wasm failure');
  assert.match(state.runtimeError, /AI 着手/);
  assert.equal(elements.get('hint').classList.contains('error'), true);
  assert.equal(elements.get('again').hidden, false, 'recovery button must be shown when AI turn aborts');

  // 1c. AI checker mismatched key -> fail-closed
  setupPosition(state.game, { player: BLACK, phase: MOVING, die1: 3, die2: 1 });
  ctrl.mode = 'mismatch-key';
  await afterChange();
  assert.equal(state.busy, false);
  assert.equal(state.game.currentPlayer, BLACK);
  assert.match(state.runtimeError, /合法手に見つかりません/);

  // 1d. AI cube double RPC reject -> fail-closed
  state.match.useCube = true;
  setupPosition(state.game, { player: BLACK, phase: ROLLING });
  assert.equal(state.game.canDouble(), true);
  ctrl.mode = 'reject';
  await afterChange();
  assert.equal(state.busy, false);
  assert.equal(state.thinking, false);
  assert.equal(state.game.state, ROLLING, 'AI cube double failure must abort before rolling/JS fallback');
  assert.match(state.runtimeError, /キューブ判断/);
  assert.equal(elements.get('again').hidden, false);

  // 1e. Worker terminated mid-game (thinker.available === false)
  thinker.terminate();
  assert.equal(thinker.available, false);

  // 1e-i. Human double -> AI accept check must fail-closed (no JS fallback, no stuck busy)
  setupPosition(state.game, { player: WHITE, phase: ROLLING });
  state.game.cube.owner = null;
  state.runtimeError = null;
  render();
  elements.get('double').click();
  await waitFor(() => !state.busy && state.runtimeError !== null, 'wasm human double fail-closed');
  assert.equal(state.game.state, DOUBLING_PROPOSED, 'cube accept must not fall back to main JS');
  assert.equal(state.busy, false);
  assert.match(state.runtimeError, /WASM Worker が停止しています/);
  assert.equal(elements.get('hint').classList.contains('error'), true);
  assert.equal(elements.get('again').hidden, false);

  // 1e-ii. AI checker with >1 legal moves when Worker terminated -> fail-closed
  state.match.useCube = false;
  setupPosition(state.game, { player: BLACK, phase: MOVING, die1: 3, die2: 1 });
  await afterChange();
  assert.equal(state.busy, false);
  assert.equal(state.game.currentPlayer, BLACK);
  assert.match(state.runtimeError, /WASM Worker が停止しています/);

  // 1e-iii. Forced single legal move (no search required) still proceeds cleanly
  const forcedBoard = makeForcedSingleMoveBoardForBlack();
  setupPosition(state.game, { player: BLACK, phase: MOVING, board: forcedBoard, die1: 1, die2: 2 });
  assert.equal(state.game.legalMoves.length, 1);
  await afterChange();
  assert.equal(state.busy, false);
  assert.equal(state.game.currentPlayer, WHITE, 'forced single move (non-search) should still apply');
  assert.equal(state.runtimeError, null);

  // 1e-iv. Hint when Worker terminated -> fail-closed
  setupPosition(state.game, { player: WHITE, phase: MOVING, die1: 3, die2: 1 });
  state.turn = null;
  state.advice = null;
  render();
  elements.get('advice-button').click();
  await waitFor(() => !state.advising && state.runtimeError !== null, 'wasm hint terminated');
  assert.equal(state.advice, null);
  assert.match(state.runtimeError, /WASM Worker が停止しています/);

  console.log('1. ?backend=wasm mid-game fail-closed (checker/cube/hint RPC reject, mismatch, terminated + forced-move): PASS');
}

// ── 2. ?backend=auto: mid-game Worker failure / termination MUST continue on main JS fallback ──
{
  const ctrl = { mode: 'reject' };
  const { elements } = createDomEnv('?backend=auto', ctrl);
  const mod = await import(`../../docs/backgammon/app.js?scenario=auto-${Date.now()}`);
  const { state, render, afterChange, thinker } = mod;

  await waitFor(() => !elements.get('start').disabled, 'auto startup ready');
  assert.equal(globalThis.__BG_BACKEND_DIAG__.workerPool.allWasm, true);

  state.delay = 0;
  state.autoRoll = false;
  state.autoForce = false;
  elements.get('start').click();
  state.runId += 1;
  state.busy = false;
  state.level = 'intermediate';

  // 2a. Hint RPC reject -> falls back to main JS cleanly
  setupPosition(state.game, { player: WHITE, phase: MOVING, die1: 3, die2: 1 });
  state.turn = null;
  state.advice = null;
  render();
  ctrl.mode = 'reject';
  elements.get('advice-button').click();
  await waitFor(() => !state.advising && state.advice !== null, 'auto hint JS fallback');
  assert.ok(state.advice.entries.length > 0);
  assert.equal(state.runtimeError, null);
  assert.equal(elements.get('hint').classList.contains('error'), false);

  // 2b. Worker terminated -> AI checker move continues on main JS
  thinker.terminate();
  state.match.useCube = false;
  setupPosition(state.game, { player: BLACK, phase: MOVING, die1: 3, die2: 1 });
  await afterChange();
  assert.equal(state.busy, false);
  assert.equal(state.game.currentPlayer, WHITE, 'auto mode must continue on main JS after Worker termination');
  assert.equal(state.runtimeError, null);

  // 2c. Worker terminated -> Human double AI accept continues on main JS
  state.match.useCube = true;
  setupPosition(state.game, { player: WHITE, phase: ROLLING });
  state.game.cube.owner = null;
  render();
  elements.get('double').click();
  await waitFor(() => !state.busy && state.game.state !== DOUBLING_PROPOSED, 'auto double JS fallback');
  assert.equal(state.busy, false);
  assert.equal(state.runtimeError, null);

  console.log('2. ?backend=auto mid-game JS fallback continuation (hint/checker/cube after reject & terminate): PASS');
}

// Drain macrotasks/microtasks to verify zero unhandled rejections
await sleep(50);
assert.equal(
  unhandledRejections.length,
  0,
  `Expected 0 unhandled rejections, got: ${unhandledRejections.map(String).join('; ')}`,
);
console.log('miniapp ?backend=wasm fail-closed / ?backend=auto fallback tests: ALL PASS');
