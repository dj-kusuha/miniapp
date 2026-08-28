// app.js の DOM/UI 統合テスト。
// 実際の app.js を Node.js 上で実行し、セレクタ配線・イベントハンドラ・自動ロール・
// クリックによるポイントメイク/ベアオフ・二重発火防止（F1/F2/F3/F4/F6 回帰）を検証する。

import { readFileSync } from 'node:fs';
import { Board, WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import { ROLLING, MOVING, GAME_OVER, Game } from '../../docs/backgammon/src/game.js';
import { generateMoves, boardKey, applySingle } from '../../docs/backgammon/src/rules.js';

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
  querySelectorAll(sel) { return []; }
}

// index.html から存在する id をすべて抽出して要素を生成する
const html = readFileSync(new URL('../../docs/backgammon/index.html', import.meta.url), 'utf8');
for (const match of html.matchAll(/\bid=["']([^"']+)["']/g)) {
  const id = match[1];
  if (!elements.has(id)) {
    new DOMElement('div', id);
  }
}

const documentShim = {
  getElementById: (id) => elements.get(id) ?? null,
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

const { state, render } = await import('../../docs/backgammon/app.js');
state.delay = 0;

const startBtn = document.getElementById('start');
if (!startBtn) {
  fail('dom-start-button', 'start ボタンが存在しない');
} else {
  startBtn.click(); // startMatch() 実行
  // バックグラウンドで非同期対局ループが走り続けないよう中断する
  state.runId += 1;
}

// ── 1. DOM セレクタ配線の検証 ──────────────────

const offWhite = elements.get(`off-${WHITE}`);
const offBlack = elements.get(`off-${BLACK}`);

if (!offWhite) fail('dom-off-white', `off-${WHITE} 要素が存在しない`);
if (!offBlack) fail('dom-off-black', `off-${BLACK} 要素が存在しない`);

const autoRollToggle = document.getElementById('auto-roll');
const autoForceToggle = document.getElementById('auto-force');
if (!autoRollToggle) fail('dom-auto-roll', 'auto-roll チェックボックス要素が存在しない');
if (!autoForceToggle) fail('dom-auto-force', 'auto-force チェックボックス要素が存在しない');

// ── 2. ポイントメイクのクリック動作と二重発火防止（F2 回帰テスト） ──
{
  const point3 = document.getElementById('point-3');
  if (!point3) {
    fail('point-3-exists', 'point-3 要素が存在しない');
  } else {
    const clickListeners = point3._listeners['click'] || [];
    if (clickListeners.length === 0) {
      fail('point-click-listener', 'point-3 に click リスナーが登録されていない');
    }
    const dblclickListeners = point3._listeners['dblclick'] || [];
    if (dblclickListeners.length > 0) {
      fail('point-dblclick-removed', 'point-3 に dblclick リスナーが残っている（二重発火の危険）');
    }

    // 局面: White 初期配置・ロール 2-2（4pt index 3 をメイク可能）
    const board = new Board();
    const moves = generateMoves(board, WHITE, 2, 2);
    const game = new Game(board);
    game.currentPlayer = WHITE;
    game.state = MOVING;
    game.roll = { die1: 2, die2: 2 };
    game.legalMoves = moves;

    state.game = game;
    state.turn = null;
    state.busy = false;
    render();

    if (!point3.classList.contains('makeable')) {
      fail('point-3-makeable', '2-2 で 4pt メイク可能なのに point-3 が makeable になっていない');
    }

    // click① (detail: 1) -> 4pt メイク成立 (5->3, 5->3)
    point3.dispatchEvent({ type: 'click', detail: 1, preventDefault() {} });

    // click② (detail: 2) -> event.detail > 1 により無視されるべき
    point3.dispatchEvent({ type: 'click', detail: 2, preventDefault() {} });

    // 判定: index 3 に自駒が 2 枚残っていること（blot になっていない）、index 1 に自駒が増えていないこと
    const preview = board.clone();
    if (state.turn) {
      for (const single of state.turn.applied) {
        applySingle(preview, WHITE, single);
      }
    }
    const count3 = preview.points[3];
    const count1 = preview.points[1];

    if (count3 !== 2) {
      fail('point-make-doubleclick-count3', `ダブルクリック後に 4pt (index 3) の駒数が ${count3}（2 枚のはず）`);
    }
    if (count1 !== 0) {
      fail('point-make-doubleclick-count1', `ダブルクリック後に 2pt (index 1) に駒が移動した (count=${count1})`);
    }
    if (!state.turn || state.turn.applied.length !== 2) {
      fail('point-make-doubleclick-applied', `ダブルクリック後の applied が ${state.turn?.applied.length}（2 手のはず）`);
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
    const dblclickListeners = offWhite._listeners['dblclick'] || [];
    if (dblclickListeners.length > 0) {
      fail('off-tray-dblclick-removed', 'off-WHITE に dblclick リスナーが残っている（二重発火の危険）');
    }

    // 局面: White 全駒インナー・6pt (index 5) に 6 枚・オフに 9 枚・ロール 6-6
    const board = new Board();
    for (let i = 0; i < 24; i += 1) board.points[i] = 0;
    board.points[5] = 6;
    board.off[WHITE] = 9;
    board.points[23] = -15;
    board.bar[WHITE] = 0;
    board.bar[BLACK] = 0;
    board.off[BLACK] = 0;

    const moves = generateMoves(board, WHITE, 6, 6);
    const game = new Game(board);
    game.currentPlayer = WHITE;
    game.state = MOVING;
    game.roll = { die1: 6, die2: 6 };
    game.legalMoves = moves;

    state.game = game;
    state.turn = null;
    state.busy = false;
    render();

    // Checkpoint C の検証（セレクタ不一致なら makeable が付かない）
    if (!offWhite.classList.contains('makeable')) {
      fail('off-tray-makeable', 'ベアオフ可能なのに off-WHITE が makeable になっていない');
    }

    // click① (detail: 1) -> 2 駒ベアオフ
    offWhite.dispatchEvent({ type: 'click', detail: 1, preventDefault() {} });
    const appliedAfter1 = state.turn ? state.turn.applied.length : 4;
    if (appliedAfter1 !== 2) {
      fail('off-tray-click1', `1 回目のクリックで 2 駒上がっていない (applied=${appliedAfter1})`);
    }

    // click② (detail: 2) -> event.detail > 1 により無視されるべき
    offWhite.dispatchEvent({ type: 'click', detail: 2, preventDefault() {} });

    // 判定: off が 2 枚しか増えていないこと、isFullTurn が立っていないこと（state.turn が null になっていない）
    if (state.turn === null) {
      fail('off-tray-doubleclick-finished', 'ダブルクリックの 2 回目でターンが確定してしまった（4 駒上がった）');
    } else if (state.turn.applied.length !== 2) {
      fail('off-tray-doubleclick-applied', `ダブルクリック後に ${state.turn.applied.length} 駒上がっている（2 駒のはず）`);
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

// ── 5. 自動ロールの間合い中はロールボタンを無効化する ──
// humanRollDice() は state.busy で早期 return するので、ボタンが出たままだと
// 「押せるように見えて無反応」になる。表示は保ったまま disabled にすること。
{
  const rollBtn = document.getElementById('roll');
  if (!rollBtn) {
    fail('roll-button-exists', 'roll ボタンが存在しない');
  } else {
    const game = new Game(new Board());
    game.currentPlayer = WHITE;
    game.state = ROLLING;

    state.game = game;
    state.turn = null;

    // 自動ロールの pause() 中を再現する
    state.busy = true;
    state.autoRolling = true;
    render();
    if (rollBtn.hidden) {
      fail('roll-hidden-while-autorolling', '自動ロール中にロールボタンが消えている（無効化して見せる想定）');
    }
    if (!rollBtn.disabled) {
      fail('roll-enabled-while-busy', '自動ロールの間合い中にロールボタンが有効のまま（押しても無反応になる）');
    }

    // 間合いが明けたら押せること
    state.busy = false;
    state.autoRolling = false;
    render();
    if (rollBtn.disabled) {
      fail('roll-disabled-after-busy', 'busy が解けてもロールボタンが無効のまま');
    }
  }
}

// ── テスト終了処理 ───────────────────────────
state.runId += 1;
if (state.game) state.game.state = GAME_OVER;

// ── 結果の出力 ───────────────────────────────

console.log('UI / DOM インタラクション (app.js):');
if (failures.length > 0) {
  for (const msg of failures) console.log(`  NG: ${msg}`);
  process.exit(1);
} else {
  console.log('  すべての UI 配線・イベント制御・二重発火防止条件を満たした\n');
}
