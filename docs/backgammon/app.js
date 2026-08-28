// 画面と操作。ゲーム進行と AI はすべてブラウザ内で動く（サーバなし）。
//
// 着手は「駒をクリック → 出目キューの手前側（左）の目を即座に使って動かす」
// 方式。同じ駒から複数の目が使える場合だけ、左の目を優先する（あいまいさの
// 解消。両方使える目が無いときはそのまま使える方の目を使う）。1 手ぶん動かす
// たびに再描画し、次に動かせる駒をハイライトする。

import { WHITE, BLACK } from './src/board.js';
import { NeuralNet } from './src/nn.js';
import {
  agentFor, levelById, setBearoffDatabase, DEFAULT_LEVEL, ADVICE_LEVEL,
} from './src/agent.js';
import { BearoffDatabase } from './src/bearoff.js';
import { MOVING, ROLLING, DOUBLING_PROPOSED, GAME_OVER } from './src/game.js';
import { Match, MONEY } from './src/match.js';
import { diceValues, applySingle, nextSingles, boardKey, SingleMove, canReach, findPointMakeAction, findBearOffAction, canPlayerDouble } from './src/rules.js';
import { toMat as buildMat } from './src/mat.js';

const $ = (id) => document.getElementById(id);

/**
 * AI の進行を目で追えるようにする間合い（ms）。
 *
 * 出目を見せてから動かすまで（ダンスもこの間は見える）と、駒 1 個ぶんの
 * 着手の間の両方に使う。**対局中にスライダーで変えられる**ので、定数では
 * なく `state.delay` を都度読むこと。
 */
const DEFAULT_DELAY = 1000;

const state = {
  net: null,
  agent: null,
  adviceAgent: null,   // ヒント用。**対戦相手とは別の段**で読み違えも無い
  advice: null,        // 表示中のヒント。局面が動いたら必ず消す
  advising: false,     // ヒントを計算中（段によっては数秒かかる）
  match: null,        // Match。進行中の局は match.game
  game: null,         // = match.game（既存のコードから触りやすいように持つ）
  humanSide: WHITE,   // 盤は White 視点固定なので、人間も White に固定する
  level: DEFAULT_LEVEL,   // AI の強さ（段）。plies はここから引く
  useCube: true,      // ダブリングキューブを使うか
  jacoby: true,       // ジャコビールール（アンリミテッド専用）
  isMatch: false,     // 形式。false = アンリミテッド
  matchLength: MONEY, // 0 = アンリミテッド。1〜7 でポイントマッチ
  delay: DEFAULT_DELAY,   // AI の進行を見せる間合い（ms）
  autoForce: false,   // フォースムーブを自動で動かすか
  autoRoll: true,     // ダブルできない時に自動でダイスを振るか
  autoRolling: false, // 自動ロールの待機中か
  autoForcing: false, // 自動フォースムーブの待機中か
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

/**
 * **画面が実際に描かれるまで待つ。**
 *
 * `render()` は DOM を書き換えるだけで、ブラウザが描くのは次のフレーム。
 * その前に重い同期処理へ入ると、**盤面が古いまま固まって見える**
 * （人が指し終わった直後に AI のキューブ判断が走るのがまさにこれ）。
 *
 * **`setTimeout(0)` では足りない。** 描画より先に回ることがある。
 * requestAnimationFrame を 2 回待つと、1 回目のコールバックの後に描画が入り、
 * 2 回目で「描き終わった後」に戻ってこられる。
 */
const nextFrame = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 0); return; }
  requestAnimationFrame(() => requestAnimationFrame(resolve));
});

/** いまの設定ぶんだけ待つ。スライダーを動かすと次の待ちから効く。 */
const pause = () => sleep(state.delay);

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

/** ベアオフ DB の置き場（モデルと同じ src/ の下）。 */
const BEAROFF_URL = './src/bearoff-6x15.bin';

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
  return ask({
    kind: 'load',
    url: new URL(modelUrl, import.meta.url).href,
    bearoffUrl: new URL(BEAROFF_URL, import.meta.url).href,
  })
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
 * キューブ判断を **Worker に投げる**（駄目ならこのスレッドで）。
 *
 * **cubePlies=2 だと 1 回 1〜2 秒かかる。** しかも `shouldDouble` は
 * 手番のたびに呼ばれるので、メインスレッドに置くと人が指した直後に必ず
 * 固まる（1 フレーム待っても、その後止まる）。
 *
 * **Game をまるごと送らない。** 判断に要るのは盤面・手番・キューブの値と
 * 所有者・ジャコビーだけ。
 */
async function askCube(game, kind) {
  const match = state.match.cubeContext();
  if (thinker.worker) {
    try {
      const reply = await ask({
        kind: 'cube',
        ask: kind,
        board: {
          points: game.board.points,
          bar: [game.board.bar[WHITE], game.board.bar[BLACK]],
          off: [game.board.off[WHITE], game.board.off[BLACK]],
        },
        player: game.currentPlayer,
        cubeValue: game.cube.value,
        cubeOwner: game.cube.owner,
        jacoby: game.jacoby,
        level: state.level,
        match,
      });
      return reply.answer;
    } catch (error) {
      console.warn('Worker でのキューブ判断に失敗しました。こちらで決めます', error);
    }
  }
  return kind === 'accept'
    ? state.agent.shouldAcceptDouble(game, match)
    : state.agent.shouldDouble(game, match);
}

/**
 * AI に着手を選ばせる。**Worker が使えればそちらで、駄目ならこのスレッドで。**
 * 返すのは `moves` の index。
 */
async function chooseMove(board, player, roll, moves, level) {
  if (thinker.worker && moves.length > 1) {
    try {
      const reply = await ask({
        kind: 'select',
        board: {
          points: board.points,
          bar: [board.bar[WHITE], board.bar[BLACK]],
          off: [board.off[WHITE], board.off[BLACK]],
        },
        player, die1: roll.die1, die2: roll.die2, level,
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
  const parts = [[net.inputDim, ...net.hiddenDims, net.outputDim].join('-')];
  // **オフラインの教師あり学習はエピソードを進めない**ので 0 になる。
  // 「0 エピソード学習」と出ても何の情報にもならないため、そのときは出さない。
  if (net.totalEpisodes > 0) parts.push(`${net.totalEpisodes.toLocaleString()} エピソード`);
  if (net.features !== 'none') parts.push(`特徴量 ${net.features}`);
  // **日付も覚え書きも古いモデルには入っていない**ので、無ければ出さない
  if (net.savedAt) parts.push(net.savedAt);
  if (net.note) parts.push(net.note);
  return parts.join(' / ');
}

NeuralNet.load('./src/model.json')
  .then(async (net) => {
    state.net = net;
    $('model-info').textContent = describeModel(net);
    // **ベアオフ DB はモデルと一緒に読む。** 終盤の競走を厳密解で評価する
    // ためのもので（`src/bearoff.js`）、1 MB ほど。**読めなくても対局は
    // できる**（ネットの推定に落ちるだけ）ので、失敗しても止めない。
    $('loading').textContent = 'ベアオフ表を読み込んでいます…';
    try {
      setBearoffDatabase(await BearoffDatabase.load(BEAROFF_URL));
    } catch (error) {
      console.warn('ベアオフ DB を読めませんでした', error);
    }
    state.threaded = await startThinker('./src/model.json');
    $('loading').textContent = state.threaded
      ? '準備できました'
      : '準備できました（別スレッドが使えないため、エキスパートでは画面が一時的に止まります）';
    $('start').disabled = false;
  })
  .catch((error) => {
    $('model-info').textContent = '—';
    $('loading').textContent = `モデルを読み込めませんでした: ${error.message}`;
    $('loading').classList.add('error');
  });

for (const button of document.querySelectorAll('[data-level]')) {
  button.addEventListener('click', () => selectChoice(button));
}
for (const button of document.querySelectorAll('[data-cube]')) {
  button.addEventListener('click', () => {
    selectChoice(button);
    state.useCube = button.dataset.cube === 'on';
    syncFormatFields();
  });
}
for (const button of document.querySelectorAll('[data-jacoby]')) {
  button.addEventListener('click', () => {
    selectChoice(button);
    state.jacoby = button.dataset.jacoby === 'on';
  });
}

// 形式とマッチの長さ。**長さのスライダーは形式と独立に覚えておく**ので、
// アンリミテッドへ切り替えて戻しても選び直さなくてよい。
const lengthInput = $('match-length');

for (const button of document.querySelectorAll('[data-format]')) {
  button.addEventListener('click', () => {
    selectChoice(button);
    state.isMatch = button.dataset.format === 'match';
    syncFormatFields();
  });
}
lengthInput.addEventListener('input', syncFormatFields);

/**
 * 形式に応じて設定項目を出し入れし、`state.matchLength` を決める。
 *
 * - **マッチの長さ**はポイントマッチのときだけ選ばせる
 * - **ジャコビーはアンリミテッド専用**。マッチには無いルールなので隠す
 *   （キューブを使わない設定のときも、選ばせる意味がないので隠す）
 */
function syncFormatFields() {
  const points = Number(lengthInput.value);
  state.matchLength = state.isMatch ? points : MONEY;
  $('match-length-value').textContent = `${points} ポイント`;
  $('length-field').hidden = !state.isMatch;
  $('jacoby-field').hidden = !state.useCube || state.isMatch;
}
syncFormatFields();

// ── AI の間合い・設定 ────────────────────────────
//
// 出目を見せる時間と、駒 1 個ぶんの着手の間。既定の 1 秒は「AI が何をしたか
// 追える」代わりに待たされるので、対局中でも変えられるようにする。

const STORAGE_KEY_SPEED = 'backgammon_speed';
const STORAGE_KEY_AUTO_FORCE = 'backgammon_auto_force';
const STORAGE_KEY_AUTO_ROLL = 'backgammon_auto_roll';

const speedInput = $('speed');
const autoForceInput = $('auto-force');
const autoRollInput = $('auto-roll');

function syncSpeed() {
  const seconds = Number(speedInput.value);
  state.delay = Math.round(seconds * 1000);
  $('speed-value').textContent = `${seconds.toFixed(1)} 秒`;
  saveSetting(STORAGE_KEY_SPEED, speedInput.value);
}
speedInput?.addEventListener('input', syncSpeed);

function syncAutoForce() {
  if (!autoForceInput) return;
  state.autoForce = autoForceInput.checked;
  saveSetting(STORAGE_KEY_AUTO_FORCE, state.autoForce);
}
autoForceInput?.addEventListener('change', syncAutoForce);

function syncAutoRoll() {
  if (!autoRollInput) return;
  state.autoRoll = autoRollInput.checked;
  saveSetting(STORAGE_KEY_AUTO_ROLL, state.autoRoll);
}
autoRollInput?.addEventListener('change', syncAutoRoll);

function loadSettings() {
  if (autoRollInput) {
    autoRollInput.checked = true;
  }
  try {
    const savedSpeed = localStorage.getItem(STORAGE_KEY_SPEED);
    if (savedSpeed !== null && speedInput) {
      const val = parseFloat(savedSpeed);
      if (!Number.isNaN(val) && val >= 0.1 && val <= 2) {
        speedInput.value = String(val);
      }
    }
    const savedAutoForce = localStorage.getItem(STORAGE_KEY_AUTO_FORCE);
    if (savedAutoForce !== null && autoForceInput) {
      autoForceInput.checked = savedAutoForce === 'true';
    }
    const savedAutoRoll = localStorage.getItem(STORAGE_KEY_AUTO_ROLL);
    if (savedAutoRoll !== null && autoRollInput) {
      autoRollInput.checked = savedAutoRoll === 'true';
    }
  } catch {
    // localStorage が使えない環境でも安全に落とす
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // 保存に失敗しても対局は継続する
  }
}

loadSettings();
syncSpeed();
syncAutoForce();
syncAutoRoll();

function selectChoice(button) {
  const group = button.parentElement;
  for (const sibling of group.children) {
    sibling.classList.toggle('is-selected', sibling === button);
    sibling.setAttribute('aria-checked', String(sibling === button));
  }
  if (button.dataset.level !== undefined) {
    state.level = button.dataset.level;
    syncLevelNote();
  }
}

/** 選んだ段の補足（先読みの深さなど）を出す。 */
function syncLevelNote() {
  $('level-note').textContent = levelById(state.level).note;
}
syncLevelNote();

$('start').addEventListener('click', startMatch);
// マッチが続いていれば次の局へ、終わっていれば同じ設定で新しいマッチへ。
$('again').addEventListener('click', () => {
  if (state.match && !state.match.isOver) nextGame();
  else startMatch();
});
/** 人間がダブルを提案できる状態か（手番、ロール前かつ権利がある）。 */
function canHumanDouble() {
  return canPlayerDouble(state.game, state.match, state.humanSide);
}

/** 人間のダイスロール。手動クリックと自動ロールの両方から使う。 */
async function humanRollDice(fromAutoRoll = false) {
  const game = state.game;
  if (!game || game.state !== ROLLING || game.currentPlayer !== state.humanSide) return;
  if (!fromAutoRoll && state.busy) return;
  if (fromAutoRoll) {
    state.autoRolling = false;
    state.busy = false;
  }
  const before = game.currentPlayer;
  game.rollDice();          // 動かせない出目なら内部で手番が飛ぶ
  // ダンスした（手番が移った）ときも、出目をひと呼吸見せてから相手へ渡す
  if (game.currentPlayer !== before) {
    state.danceShow = before;
    render();
    await pause();
    state.danceShow = null;
  }
  await afterChange();
}

$('roll').addEventListener('click', () => humanRollDice());
$('double').addEventListener('click', async () => {
  const game = state.game;
  if (!state.match.useCube || !game.canDouble()) return;
  game.proposeDouble();
  state.history = [];          // ダブルを出したら戻せない
  render();
  await pause();               // AI が考えているように見せる

  const accepted = await askCube(game, 'accept');
  if (accepted) {
    game.acceptDouble();
    render();
    await pause();
  } else {
    game.declineDouble();
    render();
    return;
  }
  await afterChange();
});

$('take').addEventListener('click', async () => {
  state.game.acceptDouble();
  state.history = [];
  render();
  await afterChange();
});

$('pass').addEventListener('click', () => {
  state.game.declineDouble();
  state.history = [];
  render();
});

$('undo').addEventListener('click', undo);
$('dice').addEventListener('click', flipDice);

// ── ヒント ────────────────────────────────────
//
// **助言は対戦相手の段とは無関係**（`ADVICE_LEVEL`）。初心者と対局していても
// 助言は良いものであってほしいし、読み違えの乗った助言は助言ではない。
//
// **手番の最初にしか出さない。** 駒を動かし始めたあとに「1 手番まるごとの最善」
// を見せても、既に動かしたものと食い違って混乱するだけ。1 手戻せばまた出せる。

/**
 * 候補手を強い順に並べる。**Worker が使えればそちらで、駄目ならこのスレッドで。**
 *
 * `chooseMove` と同じ理由で Worker へ逃がす。いまの `ADVICE_LEVEL`（2-ply）は
 * 数十 ms で終わるが、**3-ply に戻したら 1〜3 秒かかる**。メインスレッドで回すと
 * その間ずっと画面が固まるので、速い段でも Worker 経由のままにしておく。
 */
async function rankMoves(board, player, roll, moves, level, limit = 3) {
  if (thinker.worker) {
    try {
      const reply = await ask({
        kind: 'rank',
        board: {
          points: board.points,
          bar: [board.bar[WHITE], board.bar[BLACK]],
          off: [board.off[WHITE], board.off[BLACK]],
        },
        player, die1: roll.die1, die2: roll.die2, level, limit,
      });
      // 着手のときと同じく、**鍵で照合**してからメイン側の Move に結び直す
      const entries = reply.entries.map((entry) => {
        const at = entry.index < moves.length
          && boardKey(moves[entry.index].resultingBoard) === entry.key
          ? entry.index
          : moves.findIndex((m) => boardKey(m.resultingBoard) === entry.key);
        return at >= 0 ? { ...entry, index: at, move: moves[at] } : null;
      });
      if (entries.length && entries.every(Boolean)) return entries;
      console.warn('Worker のヒントがメイン側の合法手に見つかりません。こちらで計算します');
    } catch (error) {
      console.warn('Worker でのヒント計算に失敗しました。こちらで計算します', error);
    }
  }
  return state.adviceAgent.rankMoves(moves, player, limit);
}

$('advice-button').addEventListener('click', async () => {
  const game = state.game;
  if (!canAdvise() || state.advising) return;
  // **この手番の合法手そのものを鍵にする。** 局面が動けば別の配列になるので、
  // 「消し忘れて古い助言が残る」が起こらない（消して回る必要がない）。
  const root = game.legalMoves;
  const runId = state.runId;

  state.advising = true;
  render();                       // ボタンを「考えています…」に
  try {
    const entries = await rankMoves(
      game.board, game.currentPlayer, game.roll, root, ADVICE_LEVEL, 3);
    // **待っている間に局面が動いていたら捨てる。** 深い段では数秒あるので起きる。
    if (state.runId === runId && state.game === game && game.legalMoves === root) {
      state.advice = { root, entries };
    }
  } finally {
    state.advising = false;
    render();
  }
});

/** いまヒントを出せるか。 */
function canAdvise() {
  const game = state.game;
  return Boolean(state.adviceAgent) && !state.busy
    && game.state === MOVING
    && game.currentPlayer === state.humanSide
    && game.legalMoves.length > 0
    && !(state.turn && state.turn.applied.length > 0);
}

/** 出せない状況になっていたらヒントを捨てる。描画のたびに通す。 */
function syncAdvice() {
  if (!state.advice) return;
  if (!canAdvise() || state.advice.root !== state.game.legalMoves) state.advice = null;
}

/** 設定画面から。新しいマッチ（アンリミテッドなら新しいセッション）を始める。 */
function startMatch() {
  // Worker が使えないときのフォールバック。絞り方は Worker と同じものを使う。
  state.agent = agentFor(state.net, state.level);
  state.adviceAgent = agentFor(state.net, ADVICE_LEVEL);
  state.match = new Match({
    length: state.matchLength,
    jacoby: state.jacoby,
    useCube: state.useCube,
    rng: Math.random,
  });
  $('setup').hidden = true;
  $('game').hidden = false;
  buildBoard();
  nextGame();
}

/** マッチの次の 1 局を始める。スコアとクロフォードの状態は Match が持つ。 */
function nextGame() {
  state.game = state.match.startGame();
  state.history = [];
  state.turn = null;
  state.anim = null;
  state.danceShow = null;
  state.busy = false;
  state.autoRolling = false;
  state.autoForcing = false;
  clearCompoundLock();
  state.runId += 1;         // 進行中のアニメーションを打ち切る
  $('again').hidden = true;
  afterChange();
}

// ── 盤面の組み立て ─────────────────────────────

function buildBoard() {
  const board = $('board');
  // ダイスのトレイと「振る」「ダブル」ボタンは盤面の内側（中央の帯）に置くので、
  // 作り直す前に退避する
  const dice = $('dice');
  const diceAi = $('dice-ai');
  const roll = $('roll');
  const double = $('double');
  board.replaceChildren();

  // 上段は index 12..23、下段は 11..0（White が右下から左回りに進む見え方）。
  // 列は「1: キューブ置き場 / 2-7: 点 / 8: バー / 9-14: 点 / 15: 上がりトレイ」。
  // 位置は auto-flow に任せず全部明示する。
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
  top.slice(0, 6).forEach((i, k) => { place(i, false, k + 2); placeLabel(i, false, k + 2); });
  top.slice(6).forEach((i, k) => { place(i, false, k + 9); placeLabel(i, false, k + 9); });
  bottom.slice(0, 6).forEach((i, k) => { place(i, true, k + 2); placeLabel(i, true, k + 2); });
  bottom.slice(6).forEach((i, k) => { place(i, true, k + 9); placeLabel(i, true, k + 9); });

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.id = 'bar';
  bar.style.gridColumn = '8';
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
  // 「ダブル」は左半分。ロール前だけなので AI のダイスとは重ならない。
  board.appendChild(diceAi);
  board.appendChild(dice);
  board.appendChild(roll);
  board.appendChild(double);

  // 上がった駒を置く右端のトレイ。盤の向き（White は右下がホーム）に合わせて、
  // Black は上段側、White は下段側に積む。
  board.appendChild(makeOffTray(BLACK, 2));
  board.appendChild(makeOffTray(WHITE, 4));

  // キューブ置き場は上がりトレイの反対側（左端）。中身は render で入れ替える。
  const cubeTray = document.createElement('div');
  cubeTray.className = 'cube-tray';
  cubeTray.id = 'cube-tray';
  board.appendChild(cubeTray);

  // ダブルを提案している間だけ、盤に「打った」キューブを出す（中段の帯）。
  const cubeOffer = document.createElement('span');
  cubeOffer.className = 'cube';
  cubeOffer.id = 'cube-offer';
  cubeOffer.hidden = true;
  board.appendChild(cubeOffer);
}

function makeOffTray(player, row) {
  const tray = document.createElement('div');
  tray.className = `off-tray ${player === WHITE ? 'white' : 'black'}`;
  tray.id = `off-${player}`;
  tray.style.gridColumn = '15';
  tray.style.gridRow = String(row);
  if (player === state.humanSide) {
    // bar と同じく、素の div でもキーボードから触れるようにしておく。
    tray.setAttribute('role', 'button');
    tray.tabIndex = 0;
    tray.setAttribute('aria-label', '上がりトレイ');
    tray.addEventListener('click', () => handleBearOffDblClick());
    tray.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handleBearOffDblClick();
      }
    });
  }
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

// 複合操作（ポイントメイク / 2 駒ベアオフ）は 1 クリックで出目を 2 つ使う。
// ダブルクリックの 2 発目がそのまま走ると、作ったポイントを崩したり
// ゾロ目で 4 駒上げてしまうので、**直前に複合操作をした対象への連射だけ**を
// 短時間ロックする。event.detail は使わない——あれは「同じ要素への連続
// クリック回数」なので、同じマスから素早く 2 駒動かす通常操作まで捨ててしまう。
const COMPOUND_LOCK_MS = 400;
// 上がりトレイは番号を持たないので、ロックの対象キーを 1 つ決めておく。
const OFF_TARGET = 'off';
let compoundLock = { target: undefined, at: 0 };

/** 直前の複合操作と同じ対象への、ダブルクリック相当の連射か。 */
function compoundLocked(target) {
  return compoundLock.target === target && Date.now() - compoundLock.at < COMPOUND_LOCK_MS;
}

function markCompound(target) {
  compoundLock = { target, at: Date.now() };
}

// 複合操作が**手番を丸ごと**消費するときだけ、もう一度クリックさせる。
// 1 クリックで確定してしまうと、そのあと runAiTurns が busy を立てて undo を
// 隠し、AI が指せば履歴も消えるので**取り返しがつかない**。出目がまだ残る
// 部分的な複合操作は、あとから undo できるのでそのまま実行してよい。
const COMPOUND_CONFIRM_MS = 4000;
let compoundConfirm = { target: undefined, key: '', at: 0 };

/**
 * 確認は「マス」ではなく「その時に見せた手順」に紐づける。
 * **これが最後の砦。** 盤面を動かす経路（通常移動 / undo / ターン差し替え）は
 * それぞれ確認を捨てているので、いまはここに到達する筋が無い。それでも残すのは、
 * 将来 applied を触る経路が増えたときに、クリアを書き忘れても
 * 「見せた手順と違うものが確認なしで走る」ことだけは起きないようにするため。
 */
function actionKey(action) {
  return action.singles.map((single) => `${single.from}>${single.to}:${single.die}`).join('|');
}

function confirmPending(target, key) {
  return compoundConfirm.target === target
    && compoundConfirm.key === key
    && Date.now() - compoundConfirm.at < COMPOUND_CONFIRM_MS;
}

/** ターンや局が替わったらロックも確認待ちも持ち越さない。 */
function clearCompoundLock() {
  compoundLock = { target: undefined, at: 0 };
  clearCompoundConfirm();
}

/**
 * 盤面が動いたら確認待ちは捨てる。**見せた手順と、次に押したときに走る手順が
 * 食い違う**のを防ぐため。ハイライトとヒントの消し忘れも兼ねる。
 */
function clearCompoundConfirm() {
  compoundConfirm = { target: undefined, key: '', at: 0 };
}

/**
 * 手番を丸ごと使う複合操作なら、1 回目は確認待ちにして false を返す。
 * 2 回目（400ms〜4 秒）で true を返し、そのまま確定させる。
 */
function needsConfirm(action, target) {
  if (!action.isFullTurn) return false;
  const key = actionKey(action);
  if (confirmPending(target, key)) {
    clearCompoundConfirm();
    return false;
  }
  compoundConfirm = { target, key, at: Date.now() };
  render();
  return true;
}

function handlePointDblClick(targetIndex) {
  if (state.busy) return;
  const game = state.game;
  if (!game || game.state !== MOVING || game.currentPlayer !== state.humanSide || !state.turn) return;

  const action = findPointMakeAction(
    previewBoard(), game.legalMoves, state.humanSide, game.roll, state.turn.applied, targetIndex, state.turn.allowedKeys
  );
  if (!action) return;
  markCompound(targetIndex);
  if (needsConfirm(action, targetIndex)) return;

  if (action.isFullTurn && action.move) {
    state.turn = null;
    finalizeTurn(action.move);
  } else {
    for (const single of action.singles) {
      state.turn.applied.push(single);
    }
    const key = boardKey(previewBoard());
    if (state.turn.allowedKeys.has(key)) {
      finalizeTurn(state.turn.root.find((m) => boardKey(m.resultingBoard) === key));
    } else {
      render();
    }
  }
}

function handleBearOffDblClick() {
  if (state.busy) return;
  if (compoundLocked(OFF_TARGET)) return;
  const game = state.game;
  if (!game || game.state !== MOVING || game.currentPlayer !== state.humanSide || !state.turn) return;

  const action = findBearOffAction(
    previewBoard(), game.legalMoves, state.humanSide, game.roll, state.turn.applied, state.turn.allowedKeys
  );
  if (!action) return;
  markCompound(OFF_TARGET);
  if (needsConfirm(action, OFF_TARGET)) return;

  if (action.isFullTurn && action.move) {
    state.turn = null;
    finalizeTurn(action.move);
  } else {
    for (const single of action.singles) {
      state.turn.applied.push(single);
    }
    const key = boardKey(previewBoard());
    if (state.turn.allowedKeys.has(key)) {
      finalizeTurn(state.turn.root.find((m) => boardKey(m.resultingBoard) === key));
    } else {
      render();
    }
  }
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
    // **ターンが差し替わったら確認待ちは捨てる。** 前のターンで見せた手順が
    // 残っていると、新しいターンの 1 クリック目が確認なしで走ってしまう。
    clearCompoundConfirm();
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
  // 直前にここで複合操作をしたなら、ダブルクリックの 2 発目を捨てる。
  // これが無いと、メイクした直後にその駒を動かしてポイントを崩してしまう。
  if (compoundLocked(from)) return;
  const options = currentOptions().filter((single) => single.from === from);
  if (options.length === 0) {
    // 動かせる自駒がないマスをクリックした時、メイク可能ならタップでメイクを実行
    if (from !== null && typeof from === 'number') {
      handlePointDblClick(from);
    }
    return;
  }

  // 同じ駒を複数の目で動かせるときは、出目キューの左（die1）を優先する。
  // 右の目を使いたいときはサイコロをクリックして並びを入れ替える。
  const preferredDie = state.game.roll.die1;
  const chosen = options.find((single) => single.die === preferredDie) ?? options[0];
  state.turn.applied.push(chosen);
  clearCompoundConfirm();   // 盤面が動いたので、見せていた確認は無効

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
  clearCompoundLock();
  state.history.push(snapshot());
  const index = game.legalMoves.indexOf(move);
  game.applyMove(index);
  state.turn = null;
  afterChange();
}

// ── 描画 ──────────────────────────────────────

function render() {
  // **局が決着していたらスコアへ反映する。** 局が終わる経路は複数ある
  // （着手で上がる / ダブルを断る）ので、取りこぼさないよう描画のたびに通す。
  // `Match.sync()` は冪等なので何度呼んでもよい。
  state.match.sync();
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

  syncAdvice();
  renderStatus();
  renderAdvice();
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
/** いまのキューブの値と持ち主を出す。使わない設定なら隠す。 */
function renderCubeState() {
  const el = $('cube-state');
  if (!state.match.useCube) {
    el.hidden = true;
    return;
  }
  const game = state.game;
  const cube = game.cube;
  const who = cube.owner === null ? 'センター'
    : (cube.owner === state.humanSide ? 'あなた' : 'AI');
  // **ジャコビーは局が持っている値を見る。** マッチでは設定に関わらず切られる
  // ので、設定側（state.jacoby）を見ると嘘になる。
  const jacoby = (game.jacoby && cube.untouched)
    ? '・ギャモンは 1 点（ジャコビー）' : '';
  el.textContent = `キューブ ${cube.value}（${who}）${jacoby}`;
  el.hidden = false;
}

/**
 * 盤の左端（上がりトレイの反対側）にダブリングキューブを描く。
 *
 * 持ち主がいなければ中央に置き、**数字は 64** を出す。実物のキューブには
 * 1 の面が無く、まだ回っていない状態を 64 の面で表すのに合わせている。
 * 誰かが持っていればその側（White は下、Black は上）へ移し、いまの値を出す。
 *
 * **返事待ちの間だけは置き場から外し、盤に「打った」形で出す。** 出す側は
 * ダイスと同じ半分（自分は右、AI は左）。値は提案後の値（＝いまの倍）。
 */
function renderCube() {
  const tray = $('cube-tray');
  const offer = $('cube-offer');
  tray.replaceChildren();
  tray.classList.remove('at-center', 'at-top', 'at-bottom');
  tray.removeAttribute('aria-label');
  offer.hidden = true;
  offer.classList.remove('at-left', 'at-right');
  if (!state.match.useCube) return;

  const game = state.game;
  const cube = game.cube;

  if (game.state === DOUBLING_PROPOSED) {
    const mine = game.doublingProposer === state.humanSide;
    const offered = cube.value * 2;
    offer.classList.add(mine ? 'at-right' : 'at-left');
    offer.textContent = String(offered);
    offer.setAttribute('aria-label',
      `${mine ? 'あなた' : 'AI'}が ${offered} のダブルを提案中`);
    offer.hidden = false;
    return;
  }

  const center = cube.owner === null;
  // 盤は White 視点固定なので、White が下・Black が上で決め打ってよい。
  tray.classList.add(center ? 'at-center' : (cube.owner === WHITE ? 'at-bottom' : 'at-top'));

  const box = document.createElement('span');
  box.className = `cube${center ? ' is-center' : ''}`;
  box.textContent = String(center ? 64 : cube.value);
  tray.appendChild(box);

  const who = center ? 'センター' : (cube.owner === state.humanSide ? 'あなた' : 'AI');
  tray.setAttribute('aria-label', `ダブリングキューブ ${cube.value}（${who}）`);
}

/**
 * スコアと形式を出す。
 *
 * ポイントマッチでは**あと何点で勝てるか**（away）まで出す。キューブの判断も
 * クロフォードも away で決まるので、点差より分かりやすい。クロフォード局は
 * 「なぜダブルできないのか」が分からないと理不尽に見えるため必ず断る。
 */
function renderScore() {
  const match = state.match;
  const el = $('score');
  const me = match.scores[state.humanSide];
  const ai = match.scores[opponentSide()];

  if (match.isMoney) {
    // アンリミテッドは終わりが無いので、通算だけ出す（0-0 のうちは出さない）
    el.hidden = me === 0 && ai === 0;
    el.textContent = `通算 あなた ${me} - ${ai} AI`;
    return;
  }

  const parts = [`${match.length} ポイントマッチ`, `あなた ${me} - ${ai} AI`];
  if (!match.isOver) {
    parts.push(`あと あなた ${match.awayFor(state.humanSide)} / AI ${match.awayFor(opponentSide())}`);
    if (state.game.crawford) parts.push('クロフォード局（ダブル禁止）');
    else if (match.postCrawford) parts.push('ポストクロフォード');
  }
  el.textContent = parts.join(' ・ ');
  el.hidden = false;
}

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

  renderCubeState();
  renderCube();
  renderScore();

  if (game.state === GAME_OVER) {
    const match = state.match;
    const result = game.result;
    const who = result.winner === state.humanSide ? 'あなた' : 'AI';
    let kind;
    if (result.declined) {
      kind = 'パス';
    } else {
      kind = { 1: 'シングル', 2: 'ギャモン', 3: 'バックギャモン' }[result.winType];
    }
    if (match.isOver) {
      const winner = match.winner === state.humanSide ? 'あなた' : 'AI';
      $('turn').textContent = `${winner}のマッチ勝ち`
        + `（${match.scores[state.humanSide]} - ${match.scores[opponentSide()]}）`;
    } else {
      $('turn').textContent = `${who}の勝ち（${kind} ${result.points} 点）`;
    }
    renderDiceTray($('dice'), null);
    renderDiceTray($('dice-ai'), null);
    if (result.jacobyApplied) {
      // なぜ点が伸びなかったのかを説明する。黙って 1 点だと理不尽に見える
      $('hint').textContent =
        `${kind}だが、キューブが回っていないのでジャコビールールにより 1 点。`;
    } else if (result.declined) {
      $('hint').textContent = 'ダブルを断ったので、キューブの値ぶんの失点。';
    } else {
      $('hint').textContent = `白 ${game.board.off.WHITE} 個 / 黒 ${game.board.off.BLACK} 個 上がり`;
    }
    for (const id of ['roll', 'undo', 'double', 'take', 'pass', 'advice-button']) {
      $(id).hidden = true;
    }
    $('again').textContent = match.isOver ? '新しいマッチ'
      : (match.isMoney ? 'もう一局' : '次の局');
    $('again').hidden = false;
    return;
  }

  // ── ダブルを提案されている ────────────────────────
  if (game.state === DOUBLING_PROPOSED) {
    const toMe = game.doublingProposer !== state.humanSide;
    $('turn').textContent = toMe ? 'AI がダブルしました' : 'ダブルを提案中';
    $('hint').textContent = toMe
      ? `受ければキューブは ${game.cube.value * 2}。断れば ${game.cube.value} 点の負け。`
      : 'AI が考えています…';
    renderDiceTray($('dice'), null);
    renderDiceTray($('dice-ai'), null);
    for (const id of ['roll', 'undo', 'again', 'double', 'advice-button']) $(id).hidden = true;
    $('take').hidden = !toMe;
    $('pass').hidden = !toMe;
    return;
  }
  $('take').hidden = true;
  $('pass').hidden = true;

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
  // 自動ロールの間合い中はこちらの手番のままボタンが出るが、humanRollDice() は
  // state.busy で弾く。押せるように見えて無反応にならないよう明示的に止める。
  $('roll').disabled = state.busy;
  $('undo').hidden = !(mine && (state.history.length > 0 || midTurn));
  // ヒントは手番の最初だけ。駒を動かし始めたら引っ込める。
  // **深い段にすると数秒かかる**ので、計算中はそう見せて二度押しも止める
  // （いまの 2-ply では一瞬だが、段を変えたときに効く）。
  const adviceButton = $('advice-button');
  adviceButton.hidden = !canAdvise();
  adviceButton.disabled = state.advising;
  adviceButton.textContent = state.advising ? '考えています…' : 'ヒント';
  $('again').hidden = true;
  // ダブルはロール前だけ。キューブを相手が持っていたら出せない
  $('double').hidden = !canHumanDouble();

  if (state.busy) {
    if (mine) {
      if (state.autoRolling) $('hint').textContent = '自動でダイスを振っています…';
      else if (state.autoForcing) $('hint').textContent = '自動で着手しています…';
      // AI がダンスすると手番はこちらに移るが、出目を見せている間はまだ busy。
      // ここを空にすると、押せないボタンと「あなたの番」だけが出て固まって見える。
      else if (state.danceShow !== null && state.danceShow !== state.humanSide) {
        $('hint').textContent = 'AI は動かせる出目がありません…';
      }
      else $('hint').textContent = '';
    } else {
      // 3-ply では出目の間合い（既定 1 秒。間合いを縮めるほど頻繁に）で
      // 終わらないことがある。
      // そのときだけ「長考」と出して、固まったのではないと分かるようにする。
      if (state.anim) $('hint').textContent = 'AI が指しています…';
      else if (state.thinking) $('hint').textContent = 'AI が長考しています…';
      else $('hint').textContent = 'AI が考えています…';
    }
  }
  else if (mine && game.state === MOVING) {
    // 手番を丸ごと使う複合操作は、確認の 1 クリックを挟む（戻せないため）
    if (compoundConfirm.target !== undefined) {
      $('hint').textContent = 'もう一度クリックすると手番を確定します';
    } else {
      $('hint').textContent = midTurn
        ? '続けて駒をクリックしてください'
        : '動かす駒をクリックしてください';
    }
  } else $('hint').textContent = '';
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

/**
 * ヒントを描く。
 *
 * 出すのは**最善手の表記**と、**その手を指したあとの見込み**（勝ち / 負けを
 * ギャモン・バックギャモンまで分けたもの）。次点も equity の差つきで並べる。
 *
 * > **順位と確率で読みの深さが違う。** 順位は 2 手先読みで付けているが、
 * > 確率は着手後の局面を先読みなしで評価したもの。探索が equity しか返さない
 * > ため。**「この % を根拠にこの順位」ではない。**
 */
function renderAdvice() {
  const el = $('advice');
  if (!state.advice) {
    el.replaceChildren();
    el.hidden = true;
    return;
  }
  const [best, ...rest] = state.advice.entries;
  const p = best.probabilities;
  const win = p.win1 + p.win2 + p.win3;

  el.replaceChildren();
  const head = document.createElement('p');
  head.className = 'advice-move';
  head.textContent = `最善手 ${best.move.toString()}`;
  el.appendChild(head);

  const detail = document.createElement('p');
  detail.className = 'note';
  detail.textContent = `この手のあと 勝ち ${pct(win)}`
    + `（ギャモン ${pct(p.win2 + p.win3)} / バックギャモン ${pct(p.win3)}）`
    + ` ・ 負け ${pct(1 - win)}`
    + `（ギャモン ${pct(p.lose2 + p.lose3)} / バックギャモン ${pct(p.lose3)}）`;
  el.appendChild(detail);

  const legend = document.createElement('p');
  legend.className = 'note';
  if (rest.length) {
    const list = document.createElement('ul');
    list.className = 'advice-rest';
    for (const entry of rest) {
      const li = document.createElement('li');
      // 差は mEMG（1 局あたりの期待得点の 1/1000）。小さいほど僅差
      li.textContent = `${entry.move.toString()}（−${(entry.loss * 1000).toFixed(0)}）`;
      list.appendChild(li);
    }
    el.appendChild(list);
    legend.textContent = '括弧内は最善手との差（1/1000 点）。小さいほど僅差。';
  } else {
    // 候補が 1 つしか残らないのは「ほかが明らかに劣る」ということ。
    // 空欄にせず、そう言ってしまう方が初心者には有用。
    legend.textContent = 'ほかの手は大きく劣ります（迷うところではありません）。';
  }
  el.appendChild(legend);
  el.hidden = false;
}

/** 次の 1 手で動かせる駒（＝出目の移動元）や、ポイントを作れる場所を光らせる。 */
function renderHighlights() {
  for (let i = 0; i < 24; i += 1) {
    $(`point-${i}`).classList.remove('selectable', 'advised', 'makeable', 'confirming');
  }
  $('bar').classList.remove('selectable', 'advised');
  $(`off-${state.humanSide}`)?.classList.remove('makeable', 'confirming');

  // ヒントの最善手の移動元に印を付ける。**表記だけだと盤上で探すのが大変。**
  if (state.advice) {
    for (const single of state.advice.entries[0].move.singles) {
      if (single.from === null) $('bar').classList.add('advised');
      else $(`point-${single.from}`)?.classList.add('advised');
    }
  }

  if (state.busy || !state.turn) return;

  for (const single of currentOptions()) {
    if (single.from === null) $('bar').classList.add('selectable');
    else $(`point-${single.from}`)?.classList.add('selectable');
  }

  // 確認待ちの対象は、押せば確定すると分かるように別扱いにする
  if (compoundConfirm.target === OFF_TARGET) {
    $(`off-${state.humanSide}`)?.classList.add('confirming');
  } else if (typeof compoundConfirm.target === 'number') {
    $(`point-${compoundConfirm.target}`)?.classList.add('confirming');
  }

  const board = previewBoard();
  const legalMoves = state.game.legalMoves;
  const player = state.humanSide;
  const roll = state.game.roll;
  const applied = state.turn.applied;
  const allowedKeys = state.turn.allowedKeys;

  // クリックでポイントを作れる（メイクできる）マスを光らせる
  for (let i = 0; i < 24; i += 1) {
    if (findPointMakeAction(board, legalMoves, player, roll, applied, i, allowedKeys)) {
      $(`point-${i}`)?.classList.add('makeable');
    }
  }

  // クリックで 2 駒ベアオフできるときは上がりトレイを光らせる
  if (findBearOffAction(board, legalMoves, player, roll, applied, allowedKeys)) {
    $(`off-${state.humanSide}`)?.classList.add('makeable');
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
    // キューブの出来事も残す。あとから棋譜を読むとき、値がどこで動いたのかが
    // 分からないと着手の意味が追えない
    else if (event.kind === 'double') li.textContent = `${who}: ダブル（${event.value} を提案）`;
    else if (event.kind === 'take') li.textContent = `${who}: テイク（キューブ ${event.value}）`;
    else if (event.kind === 'pass') li.textContent = `${who}: パス（${event.value} 点で終局）`;
    else if (event.kind === 'end') li.textContent = `${who}の勝ち`;
    list.appendChild(li);
  }
  $('mat').textContent = toMat();
}

// ── 棋譜の書き出し ──────────────────────────────
//
// 形式の細かい決まりごとは src/mat.js に置いてある。

function toMat() {
  // **マッチ（セッション）まるごと出す。** 1 局だけ出すと、ポイントマッチでは
  // スコアの動きが分からない棋譜になる。
  return buildMat({
    games: state.match.matGames(),
    length: state.match.length,
    humanSide: state.humanSide,
  });
}

/** `backgammon-5pt-20260823-1930.mat` のような、中身が分かる名前。 */
function matFileName() {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const kind = state.match.isMoney ? 'money' : `${state.match.length}pt`;
  return `backgammon-${kind}-${stamp}.mat`;
}

$('download-mat').addEventListener('click', () => {
  const blob = new Blob([toMat()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = matFileName();
  // **一度 DOM に入れてから click する。** 付けずに click しても動くブラウザは
  // あるが、Firefox など一部では無視される。
  document.body.appendChild(link);
  link.click();
  link.remove();
  // すぐ revoke すると、ダウンロードが始まる前に URL が消える環境がある
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

// **Ctrl+A（⌘+A）でこの欄だけを全選択する。**
//
// 素のままだとページ全体が選択されてしまい、棋譜だけ取り出せない。
// `tabindex="0"` を付けてあるので、クリックかタブ移動でここへフォーカスが来る。
$('mat').addEventListener('keydown', (event) => {
  if (event.key !== 'a' && event.key !== 'A') return;
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const selection = window.getSelection();
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents($('mat'));
  selection.addRange(range);
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
  // 盤面が戻るので、見せていた確認は無効。戻すものが無くても、
  // ハイライトとヒントは消すために描き直す。
  const hadConfirm = compoundConfirm.target !== undefined;
  clearCompoundConfirm();
  // ターンの途中なら、まずは今のターンで確定させた出目を 1 つだけ戻す。
  if (state.turn && state.turn.applied.length > 0) {
    state.turn.applied.pop();
    render();
    return;
  }
  const snap = state.history.pop();
  if (!snap) {
    if (hadConfirm) render();
    return;
  }
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
      await pause();
      state.danceShow = null;
      await afterChange();
      return;
    }
    // ダブルが打てない状態（権利がない、クロフォード、キューブなし等）なら自動でダイスを振る
    if (state.autoRoll && game.state === ROLLING && !canHumanDouble() && !state.busy) {
      const runId = state.runId;
      state.busy = true;
      state.autoRolling = true;
      render();
      await pause();
      const wasAutoRolling = state.autoRolling;
      state.autoRolling = false;
      if (state.runId !== runId || state.game !== game || game.state !== ROLLING
          || game.currentPlayer !== state.humanSide || !wasAutoRolling) {
        if (wasAutoRolling) state.busy = false;
        render();
        return;
      }
      state.busy = false;
      await humanRollDice(true);
      return;
    }
    // フォースムーブ（唯一の合法手）なら自動で動かす
    if (state.autoForce && game.state === MOVING && game.legalMoves.length === 1 && !state.busy) {
      const move = game.legalMoves[0];
      const runId = state.runId;
      state.busy = true;
      state.autoForcing = true;
      render();
      await pause();
      const wasAutoForcing = state.autoForcing;
      state.autoForcing = false;
      if (state.runId !== runId || state.game !== game || game.state !== MOVING
          || game.currentPlayer !== state.humanSide || !wasAutoForcing) {
        if (wasAutoForcing) state.busy = false;
        render();
        return;
      }
      state.busy = false;
      finalizeTurn(move);
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
  // **ここで 1 フレーム待つ。** 直後のキューブ判断（`shouldDouble`）は
  // メインスレッドで同期に走り、2 段の展開だと 1 秒を超えることがある。
  // 待たないと**人が指した手が盤に出ないまま固まる。**
  await nextFrame();
  if (!alive()) return;

  while (alive() && game.state !== GAME_OVER && game.currentPlayer !== state.humanSide) {
    const ai = game.currentPlayer;

    // ── ダブルの提案（ロール前だけ）────────────────
    if (state.match.useCube && game.state === ROLLING && game.canDouble()
        && await askCube(game, 'double')) {
      game.proposeDouble();
      render();
      await pause();
      if (!alive()) return;
      // ここで人間の返事を待つ。テイク / パスのボタンが出る
      state.busy = false;
      render();
      return;
    }

    if (game.state === ROLLING) {
      game.rollDice();          // 動かせない目なら内部で手番が飛ぶ
      if (game.currentPlayer !== ai) state.danceShow = ai;
    }
    render();

    // **Worker が使えないときは `chooseMove` が同期で走る。** 出目を見せる
    // 描画を挟んでから考え始めないと、出目が出ないまま固まる。
    await nextFrame();
    if (!alive()) return;

    // **出目を見せている間に裏で考えさせる。** 3-ply の思考時間のうち
    // 間合いのぶんはこれで隠れる。ダンスしたときは考える必要が無い。
    const danced = game.currentPlayer !== ai;
    const thinking = danced
      ? null
      : chooseMove(game.board, ai, game.roll, game.legalMoves, state.level);

    await pause();
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
      await pause();
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

export { state, render, afterChange };
