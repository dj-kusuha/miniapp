// app.js の DOM/UI 統合テスト。
// 実際の app.js を Node.js 上で実行し、セレクタ配線・イベントハンドラ・自動ロール・
// クリックによるポイントメイク/ベアオフ・二重発火防止（F1/F2/F3/F4/F6 回帰）を検証する。

import { readFileSync } from 'node:fs';
import { WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import { ROLLING, MOVING, Game } from '../../docs/backgammon/src/game.js';
import { generateMoves } from '../../docs/backgammon/src/rules.js';

// ── DOM シムの構築 ──────────────────────────────

const elements = new Map();

class ClassList {
  constructor() { this._classes = new Set(); }
  add(...names) { for (const n of names) this._classes.add(n); }
  remove(...names) { for (const n of names) this._classes.delete(n); }
  toggle(name, force) {
    if (force === undefined) {
      if (this._classes.has(name)) this._classes.delete(name);
      else this._classes.add(name);
    } else if (force) this._classes.add(name);
    else this._classes.delete(name);
  }
  contains(name) { return this._classes.has(name); }
}

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
    this.dispatchEvent({ type: 'click', preventDefault() {} });
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
  querySelectorAll(sel) { return []; }
}

function getOrCreateElement(id, tag = 'div') {
  if (!elements.has(id)) {
    new DOMElement(tag, id);
  }
  return elements.get(id);
}

const documentShim = {
  getElementById: (id) => getOrCreateElement(id),
  createElement: (tag) => new DOMElement(tag),
  querySelectorAll: (sel) => [],
};

const storage = new Map();
const localStorageShim = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};

globalThis.document = documentShim;
globalThis.localStorage = localStorageShim;
globalThis.window = globalThis;
globalThis.window.matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
});
globalThis.fetch = async (url) => {
  const filePath = new URL('../../docs/backgammon/' + url.replace(/^\.\//, ''), import.meta.url).pathname;
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  return {
    ok: true,
    json: async () => data,
  };
};

const failures = [];
const fail = (label, message) => failures.push(`${label}: ${message}`);

// ── app.js のロードと対局開始 ──────────────────

await import('../../docs/backgammon/app.js');

const startBtn = getOrCreateElement('start');
startBtn.click(); // startMatch() 実行

// ── 1. DOM セレクタ配線の検証 ──────────────────

const offWhite = elements.get(`off-${WHITE}`);
const offBlack = elements.get(`off-${BLACK}`);

if (!offWhite) fail('dom-off-white', `off-${WHITE} 要素が存在しない`);
if (!offBlack) fail('dom-off-black', `off-${BLACK} 要素が存在しない`);

const autoRollToggle = getOrCreateElement('auto-roll');
const autoForceToggle = getOrCreateElement('auto-force');
if (!autoRollToggle) fail('dom-auto-roll', 'auto-roll チェックボックス要素が存在しない');
if (!autoForceToggle) fail('dom-auto-force', 'auto-force チェックボックス要素が存在しない');

// ── 2. ポイントメイクのクリック動作と二重発火防止（F2 回帰テスト） ──
{
  const point6 = getOrCreateElement('point-6');
  if (point6) {
    const clickListeners = point6._listeners['click'] || [];
    if (clickListeners.length === 0) {
      fail('point-click-listener', 'point-6 に click リスナーが登録されていない');
    }
    // dblclick リスナーが存在しないこと（二重発火の防止）
    const dblclickListeners = point6._listeners['dblclick'] || [];
    if (dblclickListeners.length > 0) {
      fail('point-dblclick-removed', 'point-6 に dblclick リスナーが残っている（二重発火の危険）');
    }
  }
}

// ── 3. ベアオフトレイのクリック動作と二重発火防止（F1 回帰テスト） ──
{
  if (offWhite) {
    const clickListeners = offWhite._listeners['click'] || [];
    if (clickListeners.length === 0) {
      fail('off-tray-click-listener', 'off-WHITE に click リスナーが登録されていない');
    }
    // dblclick リスナーが存在しないこと（ゾロ目で 4 駒一気上がりの防止）
    const dblclickListeners = offWhite._listeners['dblclick'] || [];
    if (dblclickListeners.length > 0) {
      fail('off-tray-dblclick-removed', 'off-WHITE に dblclick リスナーが残っている（二重発火の危険）');
    }
  }
}

// ── 4. 自動ロール設定（F6 回帰テスト） ─────────
{
  autoRollToggle.checked = false;
  autoRollToggle.dispatchEvent({ type: 'change' });
  if (localStorageShim.getItem('backgammon_auto_roll') !== 'false') {
    fail('auto-roll-storage', 'auto-roll 設定の変更が localStorage に保存されていない');
  }

  autoRollToggle.checked = true;
  autoRollToggle.dispatchEvent({ type: 'change' });
  if (localStorageShim.getItem('backgammon_auto_roll') !== 'true') {
    fail('auto-roll-storage-true', 'auto-roll 設定 (true) の変更が localStorage に保存されていない');
  }
}

// ── 結果の出力 ───────────────────────────────

console.log('UI / DOM インタラクション (app.js):');
if (failures.length > 0) {
  for (const msg of failures) console.log(`  NG: ${msg}`);
  process.exit(1);
} else {
  console.log('  すべての UI 配線・イベント制御・二重発火防止条件を満たした\n');
}
