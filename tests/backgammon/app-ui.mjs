// app.js の DOM/UI 統合テスト。
// 実際の app.js を Node.js 上で実行して検証する:
//   1. index.html の id と app.js のセレクタが噛み合っているか
//   2. 複合操作（ポイントメイク / 2 駒ベアオフ）の連射ロック
//   3. 連射ロックが通常の駒移動を巻き込まないこと
//   4. 自動ロールの設定と localStorage の往復
//   5. state.busy 中はロールボタンが無効で、手動ロールも通らないこと
//   6. 自動ロールが実際に発火すること
//   7. 手番を丸ごと使う複合操作に確認の 1 クリックが入ること

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

const { state, render, afterChange } = await import('../../docs/backgammon/app.js');
state.delay = 0;

const startBtn = document.getElementById('start');
if (!startBtn) {
  fail('dom-start-button', 'start ボタンが存在しない');
} else {
  startBtn.click(); // startMatch() 実行
  // バックグラウンドで非同期対局ループが走り続けないよう中断する
  state.runId += 1;
}

// 自動ロールの既定は ON。localStorage に保存が無くても ON であること
// （既定値の代入が loadSettings の try の内側に戻ると false になる）。
if (state.autoRoll !== true) {
  fail('auto-roll-default', `自動ロールの既定が ${state.autoRoll}（true のはず）`);
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

// ── 6. 連射ロックが通常の駒移動を巻き込まないこと ──
// event.detail（同じ要素への連続クリック回数）で弾くと、同じマスから素早く
// 2 駒動かす日常操作まで捨ててしまう。ロックは複合操作にだけ掛けること。
{
  const setupMove = (d1, d2) => {
    const board = new Board();
    const game = new Game(board);
    game.currentPlayer = WHITE;
    game.state = MOVING;
    game.roll = { die1: d1, die2: d2 };
    game.legalMoves = generateMoves(board, WHITE, d1, d2);
    state.game = game;
    state.turn = null;
    state.busy = false;
    render();
  };
  const burst = (id, details) => {
    const el = document.getElementById(id);
    for (const d of details) el.dispatchEvent({ type: 'click', detail: d, preventDefault() {} });
  };

  // ゾロ目 3-3 で 13pt(index 12) から 4 駒。素早く 4 回押しても全部通ること
  setupMove(3, 3);
  burst('point-12', [1, 2, 3, 4]);
  if (state.turn !== null) {
    fail('rapid-move-doubles',
      `3-3 で同じポイントを素早く4回押してもターンが終わらない (applied=${state.turn.applied.length})`);
  }

  // 非ゾロ目 6-5 で同じポイントから 2 駒（13/7 13/8）
  setupMove(6, 5);
  burst('point-12', [1, 2]);
  if (state.turn !== null) {
    fail('rapid-move-normal',
      `6-5 で同じポイントを素早く2回押してもターンが終わらない (applied=${state.turn.applied.length})`);
  }
}

// ── 7. state.busy 中は手動ロールが通らないこと ──────
// humanRollDice の busy ガードが外れる、あるいは click 登録が
// `humanRollDice` そのもの（= MouseEvent が第1引数に入り自動ロール扱いになる）に
// 戻ると、AI の手番の間合いでロールできてしまい runAiTurns が二重に走る。
{
  const rollBtn = document.getElementById('roll');
  const game = new Game(new Board());
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  state.game = game;
  state.turn = null;
  state.busy = true;
  state.autoRolling = false;
  render();

  rollBtn.dispatchEvent({ type: 'click', detail: 1, preventDefault() {} });
  if (game.state !== ROLLING) {
    fail('manual-roll-while-busy',
      `busy 中にロールボタンが効いてしまった (game.state=${game.state})`);
  }
  state.busy = false;
}

// ── 8. ベアオフのトレイも busy 中は動かないこと ────
{
  const board = new Board();
  for (let i = 0; i < 24; i += 1) board.points[i] = 0;
  board.points[5] = 6;
  board.off[WHITE] = 9;
  board.points[23] = -15;
  board.bar[WHITE] = 0;
  board.bar[BLACK] = 0;
  board.off[BLACK] = 0;

  const game = new Game(board);
  game.currentPlayer = WHITE;
  game.state = MOVING;
  game.roll = { die1: 6, die2: 6 };
  game.legalMoves = generateMoves(board, WHITE, 6, 6);
  state.game = game;
  state.turn = null;
  state.busy = false;
  render();                       // ここで state.turn が用意される
  state.busy = true;              // AI が動いている想定
  offWhite.dispatchEvent({ type: 'click', detail: 1, preventDefault() {} });
  if (state.turn && state.turn.applied.length !== 0) {
    fail('bearoff-while-busy',
      `busy 中にトレイのクリックが通った (applied=${state.turn.applied.length})`);
  }
  state.busy = false;
}

// ── 9. 自動ロールが実際に発火すること ───────────
// 発火条件（ROLLING / autoRoll / !canHumanDouble）が崩れると、
// 自動ロール機能が丸ごと死んだまま他のテストは緑のままになる。
{
  const game = new Game(new Board());
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  state.game = game;
  state.turn = null;
  state.busy = false;
  state.autoRolling = false;
  state.autoRoll = true;
  state.delay = 0;
  // 自動ロールが働くのはダブルを打てない局面。キューブレスがその代表。
  const savedUseCube = state.match.useCube;
  state.match.useCube = false;

  await afterChange();
  state.match.useCube = savedUseCube;
  if (game.state === ROLLING) {
    fail('auto-roll-fires', '自動ロールが発火せず ROLLING のままになっている');
  }
  state.runId += 1;   // 後続の非同期ループを打ち切る
}

// ── 10. 手番を丸ごと使う複合操作は確認を挟むこと ──
// 1 クリックで確定すると runAiTurns が busy を立てて undo を隠し、
// AI が指せば履歴も消えるので取り返しがつかない。出目がまだ残る
// 部分的な複合操作は、あとから undo できるのでそのまま実行してよい。
{
  // White: 12 と 11 に 2 枚ずつ / 5 に 5 枚 / 23 に 6 枚。index 6 は空なので
  // 6-5 の両方の出目を使って 6pt をメイクできる（＝手番を丸ごと使う）。
  const makeBoard = () => {
    const b = new Board();
    for (let i = 0; i < 24; i += 1) b.points[i] = 0;
    b.points[12] = 2; b.points[11] = 2; b.points[5] = 5; b.points[23] = 6;
    b.points[0] = -15;
    b.bar[WHITE] = 0; b.bar[BLACK] = 0; b.off[WHITE] = 0; b.off[BLACK] = 0;
    return b;
  };
  const setupMake = (d1, d2, board) => {
    const game = new Game(board);
    game.currentPlayer = WHITE;
    game.state = MOVING;
    game.roll = { die1: d1, die2: d2 };
    game.legalMoves = generateMoves(board, WHITE, d1, d2);
    state.game = game;
    state.turn = null;
    state.busy = false;
    render();
  };
  const clickPoint = (id) => document.getElementById(id)
    .dispatchEvent({ type: 'click', detail: 1, preventDefault() {} });
  const appliedCount = () => (state.turn ? state.turn.applied.length : null);

  // 1 回目は確認待ちになり、盤面は動かないこと
  setupMake(6, 5, makeBoard());
  clickPoint('point-6');
  if (appliedCount() !== 0) {
    fail('confirm-first-click',
      `手番を丸ごと使うメイクが 1 クリックで進んだ (applied=${appliedCount()})`);
  }
  if (!document.getElementById('point-6').classList.contains('confirming')) {
    fail('confirm-highlight', '確認待ちなのに point-6 が confirming になっていない');
  }
  if (document.getElementById('hint').textContent !== 'もう一度クリックすると手番を確定します') {
    fail('confirm-hint',
      `確認待ちのヒントが出ていない (${document.getElementById('hint').textContent})`);
  }

  // ダブルクリック相当（連射ロックの窓の内側）では確定しないこと
  setupMake(6, 5, makeBoard());
  clickPoint('point-6');
  clickPoint('point-6');
  if (appliedCount() !== 0) {
    fail('confirm-burst',
      `連射で手番が確定してしまった (applied=${appliedCount()})`);
  }

  // ゾロ目で出目が残るメイクは、確認を挟まず即実行されること
  setupMake(2, 2, new Board());
  clickPoint('point-3');
  if (appliedCount() !== 2) {
    fail('confirm-not-for-partial',
      `出目が残るメイクにまで確認が入った (applied=${appliedCount()})`);
  }
}

// ── 11. 非ゾロ目のベアオフはダブルクリックで確定しないこと ──
// 非ゾロ目は 1 クリックで両方の出目を使い切る＝確認待ちに入る。
// ここで連射ロックが無いと、ダブルクリックの 2 発目がそのまま
// 「確認のクリック」になってしまい、結局 1 ジェスチャで確定してしまう。
{
  const board = new Board();
  for (let i = 0; i < 24; i += 1) board.points[i] = 0;
  board.points[5] = 1;            // 6pt に 1 枚（die 6 で上がる）
  board.points[4] = 1;            // 5pt に 1 枚（die 5 で上がる）
  board.off[WHITE] = 13;
  board.points[23] = -15;
  board.bar[WHITE] = 0;
  board.bar[BLACK] = 0;
  board.off[BLACK] = 0;

  const game = new Game(board);
  game.currentPlayer = WHITE;
  game.state = MOVING;
  game.roll = { die1: 6, die2: 5 };
  game.legalMoves = generateMoves(board, WHITE, 6, 5);
  state.game = game;
  state.turn = null;
  state.busy = false;
  render();

  if (!offWhite.classList.contains('makeable')) {
    fail('bearoff-nondoubles-makeable', '6-5 で 2 駒ベアオフできるのにトレイが makeable でない');
  }

  offWhite.dispatchEvent({ type: 'click', detail: 1, preventDefault() {} });
  offWhite.dispatchEvent({ type: 'click', detail: 2, preventDefault() {} });

  if (state.turn === null) {
    fail('bearoff-nondoubles-burst',
      'ダブルクリックの 2 発目が確認クリックとして通り、手番が確定してしまった');
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
