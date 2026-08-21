// 画面と操作。ゲーム進行と AI はすべてブラウザ内で動く（サーバなし）。
//
// 着手は「駒をクリック → 出目キューの手前側（左）の目を即座に使って動かす」
// 方式。同じ駒から複数の目が使える場合だけ、左の目を優先する（あいまいさの
// 解消。両方使える目が無いときはそのまま使える方の目を使う）。1 手ぶん動かす
// たびに再描画し、次に動かせる駒をハイライトする。

import { WHITE, BLACK } from './src/board.js';
import { NeuralNet } from './src/nn.js';
import { Agent, filtersFor } from './src/agent.js';
import { Game, MOVING, ROLLING, GAME_OVER } from './src/game.js';
import { diceValues, applySingle, nextSingles, boardKey } from './src/rules.js';
import { toMat as buildMat } from './src/mat.js';

const $ = (id) => document.getElementById(id);

/** AI の進行を目で追えるようにする間合い（ms）。 */
const DICE_DELAY = 1000;   // 出目を見せてから動かすまで（ダンスもこの間は見える）
const MOVE_DELAY = 1000;   // 駒 1 個ぶんの着手の間

const state = {
  net: null,
  agent: null,
  game: null,
  humanSide: WHITE,   // 盤は White 視点固定なので、人間も White に固定する
  plies: 2,
  turn: null,         // { root, allowedKeys, applied } 今のターンで確定させた出目
  history: [],         // 1 ターン戻す用のスナップショット
  anim: null,          // AI の着手を 1 手ずつ見せる途中経過
  danceShow: null,     // 動かせなかった出目を見せている側（手番は既に移っている）
  runId: 0,            // 対局をまたいで古いアニメーションが動き続けないように
  busy: false,
  threaded: false,     // Worker で思考できているか
  thinking: false,     // 思考中の表示を出すか
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── AI の思考係 ────────────────────────────────
//
// **3-ply は 1 手 1〜3 秒かかる。** メインスレッドで回すと画面が固まるので
// Web Worker へ逃がす。Worker が使えない環境（file:// など）では
// メインスレッドの Agent に落ちる。**そのときは 3-ply だと固まる。**

const thinker = {
  worker: null,
  ready: null,
  nextId: 1,
  pending: new Map(),
};

function startThinker(modelUrl) {
  let worker;
  try {
    worker = new Worker(new URL('./src/worker.js', import.meta.url), { type: 'module' });
  } catch (error) {
    console.warn('Worker を作れませんでした。メインスレッドで思考します', error);
    return Promise.resolve(false);
  }
  worker.onmessage = (event) => {
    const { id } = event.data;
    const entry = thinker.pending.get(id);
    if (!entry) return;
    thinker.pending.delete(id);
    if (event.data.ok) entry.resolve(event.data);
    else entry.reject(new Error(event.data.error));
  };
  worker.onerror = (event) => {
    console.warn('Worker が落ちました。メインスレッドで思考します', event.message);
    for (const entry of thinker.pending.values()) entry.reject(new Error('worker error'));
    thinker.pending.clear();
    thinker.worker = null;
  };
  thinker.worker = worker;
  return ask({ kind: 'load', url: new URL(modelUrl, import.meta.url).href })
    .then(() => true)
    .catch((error) => {
      console.warn('Worker でモデルを読めませんでした', error);
      thinker.worker = null;
      return false;
    });
}

function ask(payload) {
  const worker = thinker.worker;
  if (!worker) return Promise.reject(new Error('worker なし'));
  const id = thinker.nextId;
  thinker.nextId += 1;
  return new Promise((resolve, reject) => {
    thinker.pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...payload });
  });
}

/**
 * AI に着手を選ばせる。**Worker が使えればそちらで、駄目ならこのスレッドで。**
 * 返すのは `moves` の index。
 */
async function chooseMove(board, player, roll, moves, plies) {
  if (thinker.worker && moves.length > 1) {
    try {
      const reply = await ask({
        kind: 'select',
        board: {
          points: board.points,
          bar: [board.bar[WHITE], board.bar[BLACK]],
          off: [board.off[WHITE], board.off[BLACK]],
        },
        player, die1: roll.die1, die2: roll.die2, plies,
      });
      // 合法手の並びは generateMoves が純関数なので一致するはずだが、
      // 念のため鍵で照合する。ずれていたら鍵で引き直す。
      if (boardKey(moves[reply.index].resultingBoard) === reply.key) return reply.index;
      const found = moves.findIndex((m) => boardKey(m.resultingBoard) === reply.key);
      if (found >= 0) return found;
      console.warn('Worker の手がメイン側の合法手に見つかりません。こちらで選び直します');
    } catch (error) {
      console.warn('Worker での思考に失敗しました。こちらで選びます', error);
    }
  }
  return state.agent.selectMove(moves, player);
}

// ── 起動 ──────────────────────────────────────

/**
 * どのモデルを読んでいるかを人が見て分かる形にする。
 *
 * **モデル JSON から導出する。** ここに文字列を直接書くと、モデルを
 * 差し替えたときに古い表示が残るため。
 */
function describeModel(net) {
  const shape = [net.inputDim, ...net.hiddenDims, net.outputDim].join('-');
  const episodes = net.totalEpisodes.toLocaleString();
  const features = net.features === 'none' ? '' : ` / 特徴量 ${net.features}`;
  return `${shape}（${episodes} エピソード学習${features}）`;
}

NeuralNet.load('./src/model.json')
  .then(async (net) => {
    state.net = net;
    $('model-info').textContent = describeModel(net);
    state.threaded = await startThinker('./src/model.json');
    $('loading').textContent = state.threaded
      ? '準備できました'
      : '準備できました（別スレッドが使えないため、最強では画面が一時的に止まります）';
    $('start').disabled = false;
  })
  .catch((error) => {
    $('model-info').textContent = '—';
    $('loading').textContent = `モデルを読み込めませんでした: ${error.message}`;
    $('loading').classList.add('error');
  });

for (const button of document.querySelectorAll('[data-plies]')) {
  button.addEventListener('click', () => selectChoice(button));
}

function selectChoice(button) {
  const group = button.parentElement;
  for (const sibling of group.children) {
    sibling.classList.toggle('is-selected', sibling === button);
    sibling.setAttribute('aria-checked', String(sibling === button));
  }
  state.plies = Number(button.dataset.plies);
}

$('start').addEventListener('click', startGame);
$('again').addEventListener('click', startGame);
$('roll').addEventListener('click', async () => {
  const game = state.game;
  const before = game.currentPlayer;
  game.rollDice();          // 動かせない出目なら内部で手番が飛ぶ
  // ダンスした（手番が移った）ときも、出目をひと呼吸見せてから相手へ渡す
  if (game.currentPlayer !== before) {
    state.danceShow = before;
    render();
    await sleep(DICE_DELAY);
    state.danceShow = null;
  }
  await afterChange();
});
$('undo').addEventListener('click', undo);
$('dice').addEventListener('click', flipDice);

function startGame() {
  // Worker が使えないときのフォールバック。絞り方は Worker と同じものを使う。
  state.agent = new Agent(state.net, state.plies, filtersFor(state.plies));
  state.game = new Game();
  state.history = [];
  state.turn = null;
  state.anim = null;
  state.danceShow = null;
  state.busy = false;
  state.runId += 1;         // 進行中のアニメーションを打ち切る
  state.game.start();
  $('setup').hidden = true;
  $('game').hidden = false;
  $('again').hidden = true;
  buildBoard();
  afterChange();
}

// ── 盤面の組み立て ─────────────────────────────

function buildBoard() {
  const board = $('board');
  // ダイスのトレイと「振る」ボタンは盤面の内側（中央の帯）に置くので、
  // 作り直す前に退避する
  const dice = $('dice');
  const diceAi = $('dice-ai');
  const roll = $('roll');
  board.replaceChildren();

  // 上段は index 12..23、下段は 11..0（White が右下から左回りに進む見え方）。
  // バーは 7 列目に固定し、各点の列位置も明示する（auto-flow に任せない）。
  const top = [];
  for (let i = 12; i <= 23; i += 1) top.push(i);
  const bottom = [];
  for (let i = 11; i >= 0; i -= 1) bottom.push(i);

  // 行は 上ラベル / 上段 / 中段（帯） / 下段 / 下ラベル の 5 行。
  // 番号は盤面（三角形）の外側、専用の帯に出す。
  const place = (index, isBottom, col) => {
    const point = makePoint(index, isBottom);
    point.style.gridColumn = String(col);
    point.style.gridRow = isBottom ? '4' : '2';
    board.appendChild(point);
  };
  const placeLabel = (index, isBottom, col) => {
    const label = document.createElement('span');
    label.className = 'point-label';
    label.textContent = String(index + 1);
    label.style.gridColumn = String(col);
    label.style.gridRow = isBottom ? '5' : '1';
    board.appendChild(label);
  };
  top.slice(0, 6).forEach((i, k) => { place(i, false, k + 1); placeLabel(i, false, k + 1); });
  top.slice(6).forEach((i, k) => { place(i, false, k + 8); placeLabel(i, false, k + 8); });
  bottom.slice(0, 6).forEach((i, k) => { place(i, true, k + 1); placeLabel(i, true, k + 1); });
  bottom.slice(6).forEach((i, k) => { place(i, true, k + 8); placeLabel(i, true, k + 8); });

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.id = 'bar';
  bar.style.gridColumn = '7';
  bar.style.gridRow = '2 / 5';
  bar.setAttribute('role', 'button');
  bar.tabIndex = 0;
  bar.setAttribute('aria-label', 'バー');
  bar.addEventListener('click', () => handleSourceClick(null));
  bar.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleSourceClick(null);
    }
  });
  board.appendChild(bar);
  // 中段（行 3）はサイコロの定位置。自分は右半分、AI は左半分。
  // 「振る」ボタンも自分のダイスと同じ場所に出す（振る前は空いている）。
  board.appendChild(diceAi);
  board.appendChild(dice);
  board.appendChild(roll);

  // 上がった駒を置く右端のトレイ。盤の向き（White は右下がホーム）に合わせて、
  // Black は上段側、White は下段側に積む。
  board.appendChild(makeOffTray(BLACK, 2));
  board.appendChild(makeOffTray(WHITE, 4));
}

function makeOffTray(player, row) {
  const tray = document.createElement('div');
  tray.className = `off-tray ${player === WHITE ? 'white' : 'black'}`;
  tray.id = `off-${player}`;
  tray.style.gridColumn = '14';
  tray.style.gridRow = String(row);
  return tray;
}

function makePoint(index, isBottom) {
  const point = document.createElement('button');
  point.type = 'button';
  point.className = `point${index % 2 ? ' odd' : ''}${isBottom ? ' bottom' : ''}`;
  point.dataset.index = String(index);
  point.id = `point-${index}`;
  point.addEventListener('click', () => handleSourceClick(index));
  return point;
}

// ── ターンの進行（出目 1 個ぶんずつ確定させる） ─────────

/** 人間の手番で MOVING の間だけ、進行中のターンを用意する。 */
function syncTurn() {
  const game = state.game;
  if (game.state !== MOVING || game.currentPlayer !== state.humanSide
      || game.legalMoves.length === 0) {
    state.turn = null;
    return;
  }
  if (!state.turn || state.turn.root !== game.legalMoves) {
    state.turn = {
      root: game.legalMoves,
      // 合法な「ターン終了時の盤面」。着手順ではなくこれで判定する。
      allowedKeys: new Set(game.legalMoves.map((m) => boardKey(m.resultingBoard))),
      applied: [],
    };
  }
}

/** まだ使っていない出目（ゾロ目なら 4 個から減っていく）。 */
function remainingDice() {
  const rest = diceValues(state.game.roll.die1, state.game.roll.die2);
  for (const single of state.turn.applied) {
    const at = rest.indexOf(single.die);
    if (at >= 0) rest.splice(at, 1);
  }
  return rest;
}

/** いま選べる 1 手の一覧。 */
function currentOptions() {
  if (!state.turn) return [];
  return nextSingles(previewBoard(), state.game.currentPlayer,
    remainingDice(), state.turn.allowedKeys);
}

/** 途中まで指した状態を反映した盤面（まだ game.board には書き戻さない）。 */
function previewBoard() {
  const game = state.game;
  if (state.anim) {
    const board = state.anim.base.clone();
    for (const single of state.anim.applied) applySingle(board, state.anim.player, single);
    return board;
  }
  if (!state.turn || state.turn.applied.length === 0) return game.board;
  const board = game.board.clone();
  for (const single of state.turn.applied) applySingle(board, game.currentPlayer, single);
  return board;
}

function handleSourceClick(from) {
  if (state.busy || !state.turn) return;
  const options = currentOptions().filter((single) => single.from === from);
  if (options.length === 0) return;

  // 同じ駒を複数の目で動かせるときは、出目キューの左（die1）を優先する。
  // 右の目を使いたいときはサイコロをクリックして並びを入れ替える。
  const preferredDie = state.game.roll.die1;
  const chosen = options.find((single) => single.die === preferredDie) ?? options[0];
  state.turn.applied.push(chosen);

  // 合法な終了盤面に達したらターンを確定する（出目が余っていても、
  // それ以上使えない手順は generateMoves が合法として持っている）。
  const key = boardKey(previewBoard());
  if (state.turn.allowedKeys.has(key)) {
    finalizeTurn(state.turn.root.find((m) => boardKey(m.resultingBoard) === key));
  } else {
    render();
  }
}

/** サイコロをクリックすると、どちらの目を先に使うかを入れ替える。 */
function flipDice() {
  const game = state.game;
  if (!game || state.busy) return;
  if (game.state !== MOVING || game.currentPlayer !== state.humanSide) return;
  if (game.roll.die1 === game.roll.die2) return;   // ゾロ目は入れ替える意味がない
  game.roll = { die1: game.roll.die2, die2: game.roll.die1 };
  render();
}

function finalizeTurn(move) {
  const game = state.game;
  state.history.push(snapshot());
  const index = game.legalMoves.indexOf(move);
  game.applyMove(index);
  state.turn = null;
  afterChange();
}

// ── 描画 ──────────────────────────────────────

function render() {
  syncTurn();
  const game = state.game;
  const board = previewBoard();

  for (let i = 0; i < 24; i += 1) {
    const el = $(`point-${i}`);
    el.replaceChildren();
    const white = board.count(i, WHITE);
    const black = board.count(i, BLACK);
    const owner = white > 0 ? WHITE : black > 0 ? BLACK : null;
    const n = white + black;
    // 5 個までは駒を並べ、それ以上は数字で示す（縦に溢れさせない）
    for (let k = 0; k < Math.min(n, 5); k += 1) {
      const checker = document.createElement('span');
      checker.className = `checker ${owner === WHITE ? 'white' : 'black'}`;
      el.appendChild(checker);
    }
    if (n > 5) {
      const badge = document.createElement('span');
      badge.className = 'stack-count';
      badge.textContent = `×${n}`;
      el.appendChild(badge);
    }
    el.setAttribute('aria-label',
      `${i + 1} 番ポイント: ${n === 0 ? '空' : `${owner === WHITE ? '白' : '黒'} ${n} 個`}`);
  }

  const bar = $('bar');
  bar.replaceChildren();
  for (const [player, cls] of [[BLACK, 'black'], [WHITE, 'white']]) {
    const group = document.createElement('div');
    group.className = 'bar-group';
    const n = board.bar[player];
    for (let k = 0; k < Math.min(n, 4); k += 1) {
      const checker = document.createElement('span');
      checker.className = `checker ${cls}`;
      group.appendChild(checker);
    }
    if (n > 4) {
      const badge = document.createElement('span');
      badge.className = 'stack-count';
      badge.textContent = `×${n}`;
      group.appendChild(badge);
    }
    bar.appendChild(group);
  }
  bar.setAttribute('aria-label', `バー: 白 ${board.bar.WHITE} 個 / 黒 ${board.bar.BLACK} 個`);

  for (const player of [WHITE, BLACK]) {
    const tray = $(`off-${player}`);
    tray.replaceChildren();
    const n = board.off[player];
    for (let k = 0; k < n; k += 1) {
      const piece = document.createElement('span');
      piece.className = 'off-checker';
      tray.appendChild(piece);
    }
    if (n > 0) {
      const badge = document.createElement('span');
      badge.className = 'off-count';
      badge.textContent = String(n);
      tray.appendChild(badge);
    }
    tray.setAttribute('aria-label',
      `${player === WHITE ? '白' : '黒'}の上がり: ${n} 個`);
  }

  renderStatus();
  renderHighlights();
  renderLog();
}

const opponentSide = () => (state.humanSide === WHITE ? BLACK : WHITE);

/** AI の着手アニメーションで、まだ使っていない出目。 */
function animRemainingDice() {
  const rest = diceValues(state.game.roll.die1, state.game.roll.die2);
  for (const single of state.anim.applied) {
    const at = rest.indexOf(single.die);
    if (at >= 0) rest.splice(at, 1);
  }
  return rest;
}

/**
 * その側のダイスをいま出すか。出すなら `remaining`（未使用の出目）も返す。
 *
 * 実物の盤と同じで、**使い切ったら片付ける**（手番中だけ盤上にある）。
 * 出目は `game.roll` から読むので、クリックで入れ替えた並びがそのまま出る。
 */
function diceFor(player) {
  const game = state.game;
  if (game.state === GAME_OVER || !game.roll) return null;

  // 動かせなかった出目は、手番が移ったあともしばらく見せる
  if (state.danceShow === player) return { roll: game.roll, remaining: null };

  let remaining = null;
  if (state.anim && state.anim.player === player) {
    remaining = animRemainingDice();
  } else if (game.state === MOVING && game.currentPlayer === player) {
    remaining = player === state.humanSide && state.turn ? remainingDice() : null;
  } else {
    return null;
  }

  if (remaining && remaining.length === 0) return null;   // すべて動かし終えた
  return { roll: game.roll, remaining };
}

/** 出目を 1 つのトレイに描く。`remaining` を渡すと使い終わった目に印が付く。 */
function renderDiceTray(el, shown) {
  el.replaceChildren();
  if (!shown) return;
  const faces = diceValues(shown.roll.die1, shown.roll.die2);
  const rest = shown.remaining ? [...shown.remaining] : [...faces];
  for (const die of faces) {
    const at = rest.indexOf(die);
    if (at >= 0) rest.splice(at, 1);
    const span = document.createElement('span');
    span.className = `die${at < 0 ? ' used' : ''}`;
    span.textContent = String(die);
    el.appendChild(span);
  }
}

function renderStatus() {
  const game = state.game;
  $('hint').classList.toggle('is-thinking', Boolean(state.thinking));
  const mine = game.currentPlayer === state.humanSide;
  const midTurn = Boolean(state.turn && state.turn.applied.length > 0);

  if (game.state === GAME_OVER) {
    const kind = { 1: 'シングル', 2: 'ギャモン', 3: 'バックギャモン' }[game.result.winType];
    const who = game.result.winner === state.humanSide ? 'あなた' : 'AI';
    $('turn').textContent = `${who}の勝ち（${kind} ${game.result.points} 点）`;
    renderDiceTray($('dice'), null);
    renderDiceTray($('dice-ai'), null);
    $('hint').textContent = `白 ${game.board.off.WHITE} 個 / 黒 ${game.board.off.BLACK} 個 上がり`;
    $('roll').hidden = true;
    $('undo').hidden = true;
    $('again').hidden = false;
    return;
  }

  $('turn').textContent = mine ? 'あなたの番' : 'AI の番';

  // 出目は手番中の側だけ盤上に出す（使い切ったら片付ける）。
  const dice = $('dice');
  const shownMine = diceFor(state.humanSide);
  const flippable = Boolean(shownMine) && mine && game.state === MOVING
    && game.roll.die1 !== game.roll.die2;
  dice.classList.toggle('is-flippable', flippable);
  dice.title = flippable ? 'クリックで使う順番を入れ替える' : '';
  renderDiceTray(dice, shownMine);
  renderDiceTray($('dice-ai'), diceFor(opponentSide()));

  $('roll').hidden = !(mine && game.state === ROLLING);
  $('undo').hidden = !(mine && (state.history.length > 0 || midTurn));
  $('again').hidden = true;

  if (state.busy) {
    // 3-ply では出目の間合い（1 秒）で終わらないことがある。
    // そのときだけ「長考」と出して、固まったのではないと分かるようにする。
    if (state.anim) $('hint').textContent = 'AI が指しています…';
    else if (state.thinking) $('hint').textContent = 'AI が長考しています…';
    else $('hint').textContent = 'AI が考えています…';
  }
  else if (mine && game.state === MOVING) {
    $('hint').textContent = midTurn
      ? '続けて駒をクリックしてください'
      : '動かす駒をクリックしてください';
  } else $('hint').textContent = '';
}

/** 次の 1 手で動かせる駒（＝出目の移動元）を光らせる。 */
function renderHighlights() {
  for (let i = 0; i < 24; i += 1) $(`point-${i}`).classList.remove('selectable');
  $('bar').classList.remove('selectable');
  if (state.busy || !state.turn) return;

  for (const single of currentOptions()) {
    if (single.from === null) $('bar').classList.add('selectable');
    else $(`point-${single.from}`)?.classList.add('selectable');
  }
}

function renderLog() {
  const list = $('log');
  list.replaceChildren();
  for (const event of state.game.log.slice(-30)) {
    const li = document.createElement('li');
    const who = event.player === state.humanSide ? 'あなた' : 'AI';
    if (event.kind === 'move') li.textContent = `${who}: ${event.text}`;
    else if (event.kind === 'skip') li.textContent = `${who}: 動かせず（${event.roll.join('-')}）`;
    else if (event.kind === 'roll' || event.kind === 'open') li.textContent = `${who}: ${event.roll.join('-')}`;
    else if (event.kind === 'end') li.textContent = `${who}の勝ち`;
    list.appendChild(li);
  }
  $('mat').textContent = toMat();
}

// ── 棋譜の書き出し ──────────────────────────────
//
// 形式の細かい決まりごとは src/mat.js に置いてある。

function toMat() {
  const game = state.game;
  return buildMat({
    log: game.log,
    result: game.state === GAME_OVER ? game.result : null,
    humanSide: state.humanSide,
  });
}

$('copy-mat').addEventListener('click', async () => {
  const button = $('copy-mat');
  try {
    await navigator.clipboard.writeText(toMat());
    button.textContent = 'コピーしました';
  } catch {
    button.textContent = '選択してコピーしてください';
  }
  setTimeout(() => { button.textContent = 'コピー'; }, 2000);
});

// PC 幅では棋譜を右側に開いたまま置く。狭い画面では折りたたむ。
const wideScreen = window.matchMedia('(min-width: 900px)');
const syncRecordOpen = () => { $('record').open = wideScreen.matches; };
wideScreen.addEventListener('change', syncRecordOpen);
syncRecordOpen();

// ── 操作 ──────────────────────────────────────

function snapshot() {
  const game = state.game;
  return {
    board: game.board.clone(),
    currentPlayer: game.currentPlayer,
    roll: { ...game.roll },
    legalMoves: game.legalMoves,
    state: game.state,
    logLength: game.log.length,
  };
}

function restore(snap) {
  const game = state.game;
  game.board = snap.board;
  game.currentPlayer = snap.currentPlayer;
  game.roll = snap.roll;
  game.legalMoves = snap.legalMoves;
  game.state = snap.state;
  game.log.length = snap.logLength;
  game.result = null;
}

function undo() {
  // ターンの途中なら、まずは今のターンで確定させた出目を 1 つだけ戻す。
  if (state.turn && state.turn.applied.length > 0) {
    state.turn.applied.pop();
    render();
    return;
  }
  const snap = state.history.pop();
  if (!snap) return;
  restore(snap);
  state.turn = null;
  render();
}

/** 盤面を描いてから、AI の番なら（間合いを取りながら）指させる。 */
async function afterChange() {
  render();
  const game = state.game;
  if (game.state === GAME_OVER) return;
  if (game.currentPlayer === state.humanSide) {
    if (game.state === MOVING && game.legalMoves.length === 0) {
      state.danceShow = game.currentPlayer;
      game.skipTurn();
      render();
      await sleep(DICE_DELAY);
      state.danceShow = null;
      await afterChange();
      return;
    }
    render();
    return;
  }
  await runAiTurns();
}

/**
 * AI の手番を、1 手ずつ見せながら進める。
 *
 * まとめて適用すると「気づいたら自分の番になっていた」状態になり、相手が何を
 * したのか分からない。**出目を見せる → 駒を 1 個ずつ動かす**の順で間を置く。
 * ダンス（動かせない出目）のときも出目を見せる時間を必ず取る。
 */
async function runAiTurns() {
  const game = state.game;
  const runId = state.runId;
  const alive = () => state.runId === runId && state.game === game;

  state.busy = true;
  render();

  while (alive() && game.state !== GAME_OVER && game.currentPlayer !== state.humanSide) {
    const ai = game.currentPlayer;

    if (game.state === ROLLING) {
      game.rollDice();          // 動かせない目なら内部で手番が飛ぶ
      if (game.currentPlayer !== ai) state.danceShow = ai;
    }
    render();

    // **出目を見せている間に裏で考えさせる。** 3-ply の思考時間のうち
    // DICE_DELAY ぶんはこれで隠れる。ダンスしたときは考える必要が無い。
    const danced = game.currentPlayer !== ai;
    const thinking = danced
      ? null
      : chooseMove(game.board, ai, game.roll, game.legalMoves, state.plies);

    await sleep(DICE_DELAY);
    state.danceShow = null;
    if (!alive()) return;
    if (danced) { render(); continue; }

    // 出目の間合いで終わっていなければ「考え中」を出して待つ
    let index;
    if (thinking) {
      let settled = false;
      thinking.then(() => { settled = true; });
      await Promise.race([thinking, sleep(0)]);
      if (!settled) {
        state.thinking = true;
        render();
      }
      index = await thinking;
      state.thinking = false;
      if (!alive()) return;
    }
    const move = game.legalMoves[index];

    state.anim = { base: game.board.clone(), player: ai, applied: [] };
    for (const single of move.singles) {
      state.anim.applied.push(single);
      render();
      await sleep(MOVE_DELAY);
      if (!alive()) return;
    }
    state.anim = null;
    game.applyMove(index);
    render();
  }

  if (!alive()) return;
  state.anim = null;
  state.busy = false;
  state.history = [];   // AI が指したら戻せない
  await afterChange();
}
