// 画面と操作。ゲーム進行と AI はすべてブラウザ内で動く（サーバなし）。
//
// 着手は「移動元をクリック → 出目を自動割当」方式。engine の Web フロントと
// 同じで、ドラッグ&ドロップにはしない（小さい画面で扱いにくいため）。

import { WHITE, BLACK } from './src/board.js';
import { NeuralNet } from './src/nn.js';
import { Agent } from './src/agent.js';
import { Game, MOVING, ROLLING, GAME_OVER } from './src/game.js';

const $ = (id) => document.getElementById(id);
const state = {
  net: null,
  agent: null,
  game: null,
  humanSide: WHITE,
  plies: 2,
  selected: null,     // 選択中の移動元（index か 'bar'）
  history: [],        // 1 手戻す用のスナップショット
  busy: false,
};

// ── 起動 ──────────────────────────────────────

NeuralNet.load('./src/model.json')
  .then((net) => {
    state.net = net;
    $('loading').textContent =
      `準備できました（${net.totalEpisodes.toLocaleString()} エピソード学習）`;
    $('start').disabled = false;
  })
  .catch((error) => {
    $('loading').textContent = `モデルを読み込めませんでした: ${error.message}`;
    $('loading').classList.add('error');
  });

for (const button of document.querySelectorAll('[data-side]')) {
  button.addEventListener('click', () => selectChoice(button, 'side'));
}
for (const button of document.querySelectorAll('[data-plies]')) {
  button.addEventListener('click', () => selectChoice(button, 'plies'));
}

function selectChoice(button, kind) {
  const group = button.parentElement;
  for (const sibling of group.children) {
    sibling.classList.toggle('is-selected', sibling === button);
    sibling.setAttribute('aria-checked', String(sibling === button));
  }
  if (kind === 'side') state.humanSide = button.dataset.side;
  else state.plies = Number(button.dataset.plies);
}

$('start').addEventListener('click', startGame);
$('again').addEventListener('click', startGame);
$('roll').addEventListener('click', () => {
  state.game.rollDice();
  afterChange();
});
$('undo').addEventListener('click', undo);

function startGame() {
  state.agent = new Agent(state.net, state.plies);
  state.game = new Game();
  state.history = [];
  state.selected = null;
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
  board.replaceChildren();

  // 上段は index 12..23、下段は 11..0（White が右下から左回りに進む見え方）
  const top = [];
  for (let i = 12; i <= 23; i += 1) top.push(i);
  const bottom = [];
  for (let i = 11; i >= 0; i -= 1) bottom.push(i);

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.id = 'bar';

  top.slice(0, 6).forEach((i) => board.appendChild(makePoint(i, false)));
  board.appendChild(bar);
  top.slice(6).forEach((i) => board.appendChild(makePoint(i, false)));
  bottom.slice(0, 6).forEach((i) => board.appendChild(makePoint(i, true)));
  bottom.slice(6).forEach((i) => board.appendChild(makePoint(i, true)));
}

function makePoint(index, isBottom) {
  const point = document.createElement('button');
  point.type = 'button';
  point.className = `point${index % 2 ? ' odd' : ''}${isBottom ? ' bottom' : ''}`;
  point.dataset.index = String(index);
  point.id = `point-${index}`;
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = String(index + 1);
  point.appendChild(num);
  point.addEventListener('click', () => onPointClick(index));
  return point;
}

// ── 描画 ──────────────────────────────────────

function render() {
  const game = state.game;
  const board = game.board;

  for (let i = 0; i < 24; i += 1) {
    const el = $(`point-${i}`);
    const num = el.querySelector('.num');
    el.replaceChildren(num);
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
    const n = board.bar[player];
    const slot = document.createElement('div');
    slot.textContent = n ? `${cls === 'white' ? '白' : '黒'}×${n}` : '';
    slot.style.fontSize = '10px';
    slot.style.color = '#fff';
    bar.appendChild(slot);
  }

  renderStatus();
  renderHighlights();
  renderLog();
}

function renderStatus() {
  const game = state.game;
  const mine = game.currentPlayer === state.humanSide;

  if (game.state === GAME_OVER) {
    const kind = { 1: 'シングル', 2: 'ギャモン', 3: 'バックギャモン' }[game.result.winType];
    const who = game.result.winner === state.humanSide ? 'あなた' : 'AI';
    $('turn').textContent = `${who}の勝ち（${kind} ${game.result.points} 点）`;
    $('dice').replaceChildren();
    $('hint').textContent = `白 ${game.board.off.WHITE} 個 / 黒 ${game.board.off.BLACK} 個 上がり`;
    $('roll').hidden = true;
    $('undo').hidden = true;
    $('again').hidden = false;
    return;
  }

  $('turn').textContent = mine ? 'あなたの番' : 'AI の番';
  const dice = $('dice');
  dice.replaceChildren();
  if (game.state === MOVING) {
    for (const die of [game.roll.die1, game.roll.die2]) {
      const el = document.createElement('span');
      el.className = 'die';
      el.textContent = String(die);
      dice.appendChild(el);
    }
  }
  $('roll').hidden = !(mine && game.state === ROLLING);
  $('undo').hidden = !(mine && state.history.length > 0);
  $('again').hidden = true;

  if (state.busy) $('hint').textContent = 'AI が考えています…';
  else if (mine && game.state === MOVING) {
    $('hint').textContent = state.selected === null
      ? '動かす駒をクリックしてください'
      : 'もう一度クリックで選択解除できます';
  } else $('hint').textContent = '';
}

/** いま選べる移動元と、選択中なら移動先を光らせる。 */
function renderHighlights() {
  for (let i = 0; i < 24; i += 1) {
    $(`point-${i}`).classList.remove('selectable', 'selected', 'target');
  }
  const game = state.game;
  if (game.state !== MOVING || game.currentPlayer !== state.humanSide || state.busy) return;

  if (state.selected === null) {
    for (const from of sourcesOf(game.legalMoves)) {
      if (from !== null) $(`point-${from}`)?.classList.add('selectable');
    }
  } else {
    if (state.selected !== 'bar') $(`point-${state.selected}`).classList.add('selected');
    for (const move of movesFrom(game.legalMoves, state.selected)) {
      const to = move.singles[0].to;
      if (to !== null) $(`point-${to}`)?.classList.add('target');
    }
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
}

// ── 操作 ──────────────────────────────────────

function sourcesOf(moves) {
  return [...new Set(moves.map((m) => m.singles[0].from))];
}

function movesFrom(moves, from) {
  const key = from === 'bar' ? null : from;
  return moves.filter((m) => m.singles[0].from === key);
}

function onPointClick(index) {
  const game = state.game;
  if (state.busy || game.state !== MOVING || game.currentPlayer !== state.humanSide) return;

  if (state.selected === index) {     // 同じ場所をもう一度 → 解除
    state.selected = null;
    renderHighlights();
    renderStatus();
    return;
  }

  if (state.selected === null) {
    if (!sourcesOf(game.legalMoves).includes(index)) return;
    state.selected = index;
    renderHighlights();
    renderStatus();
    return;
  }

  // 移動先として選ばれた
  const candidates = movesFrom(game.legalMoves, state.selected)
    .filter((m) => m.singles[0].to === index);
  if (candidates.length === 0) return;
  play(game.legalMoves.indexOf(candidates[0]));
}

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
  const snap = state.history.pop();
  if (!snap) return;
  restore(snap);
  state.selected = null;
  render();
}

function play(index) {
  state.history.push(snapshot());
  state.game.applyMove(index);
  state.selected = null;
  afterChange();
}

/**
 * 盤面を描いてから、AI の番なら考えさせる。
 *
 * 2-ply は 1 手 25ms 程度だが、**描画を挟んでから計算する**。同期のまま
 * 走らせると「AI が考えています」が画面に出ないまま固まって見える。
 */
function afterChange() {
  render();
  const game = state.game;
  if (game.state === GAME_OVER) return;
  if (game.currentPlayer === state.humanSide) {
    if (game.state === MOVING && game.legalMoves.length === 0) game.skipTurn();
    render();
    return;
  }

  state.busy = true;
  renderStatus();
  // 1 フレーム譲ってから計算する
  requestAnimationFrame(() => setTimeout(() => {
    try {
      while (state.game.state !== GAME_OVER
             && state.game.currentPlayer !== state.humanSide) {
        const roll = state.game.prepareTurn();
        if (roll === null) break;
        const index = state.agent.selectMove(
          state.game.legalMoves, state.game.currentPlayer);
        state.game.applyMove(index);
      }
    } finally {
      state.busy = false;
      state.history = [];   // AI が指したら戻せない
      afterChange();
    }
  }, 0));
}
