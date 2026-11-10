// 強さの段（弱い相手の作り方）の検証。
//
// gnubg での採点は `tools/measure-level.mjs` が別途やる（docker が要るので
// ここでは回さない）。ここで守るのは**設計どおりに動いているか**:
//
//   1. **決定的**であること（同じ局面なら何度でも同じ手）
//   2. **足切りが効く**こと（最善から maxLoss 以上劣る手を選ばない）
//   3. **段が単調に弱い**こと（ノイズが大きいほど平均損失が増える）
//   4. **キューブにもノイズが乗る**こと（手だけヘボくならない）
//   5. **初心者だけ**キューブマージン（ダブル／テイク）が付き、ベアオフDBを
//      使わないこと（2026-11-09、テイクは 2026-11-10 追加）
//   6. **ヒントが読み違えず、探索が効いている**こと（壊れても静かなので固定する）
//   7. **ダブルマージンが実際の判断を変える**ことと、search の足切りが
//      新しい判定境界で測られていること（2026-11-09 レビュー対応）
//   8. **初心者だけブロット回避バイアスが効く**こと（2026-11-10）:
//      exposedBlotCount の数え方、集計でブロットを残す選択が最善手より
//      少ないこと、テイクマージンで判断が反転すること

import { readFileSync } from 'node:fs';
import { Board, NeuralNet, Agent } from '../../docs/backgammon/src/nn-test-shim.mjs';
import { WHITE, opponent } from '../../docs/backgammon/src/board.js';
import {
  LEVELS, DEFAULT_LEVEL, ADVICE_LEVEL, agentFor, levelById, gaussianFor,
  setBearoffDatabase, DEFAULT_FILTERS, exposedBlotCount,
} from '../../docs/backgammon/src/agent.js';
import { generateMoves } from '../../docs/backgammon/src/rules.js';
import { Game, ROLLING } from '../../docs/backgammon/src/game.js';
import { loadBearoffForTests } from './bearoff-setup.mjs';

const net = new NeuralNet(JSON.parse(
  readFileSync(new URL('../../docs/backgammon/src/model.json', import.meta.url))));

const failures = [];
const fail = (m) => failures.push(m);

// ── 段の表そのもの ──────────────────────────────

if (LEVELS.length !== 6) fail(`段が ${LEVELS.length} 個（6 のはず）`);
for (const level of LEVELS) {
  if (!level.id || !level.name) fail(`段に id か name が無い: ${JSON.stringify(level)}`);
  if (levelById(level.id) !== level) fail(`levelById(${level.id}) が引けない`);
}
// 弱い順に並んでいること（ノイズは単調減、先読みは単調増）
for (let i = 0; i + 1 < LEVELS.length; i += 1) {
  if (LEVELS[i].noise < LEVELS[i + 1].noise) {
    fail(`${LEVELS[i].id} より ${LEVELS[i + 1].id} のノイズが大きい`);
  }
  if (LEVELS[i].plies > LEVELS[i + 1].plies) {
    fail(`${LEVELS[i].id} より ${LEVELS[i + 1].id} の先読みが浅い`);
  }
}
// **先読み 0 の段が複数ある。** ここが plies で作り分けられない理由。
const zeroPly = LEVELS.filter((l) => l.plies === 0);
if (zeroPly.length < 2) fail('先読み 0 の段が 1 つしかない（段で作り分ける必要が無くなる）');
if (new Set(zeroPly.map((l) => l.noise)).size !== zeroPly.length) {
  fail('先読み 0 の段どうしでノイズが重複している（同じ強さの段ができる）');
}
// **id を直書きしない**（名前を変えただけでテストが落ちるのは意味が無い）。
const WEAKEST = LEVELS[0];
const STRONGEST = LEVELS[LEVELS.length - 1];
const CLEAN = LEVELS.find((l) => l.plies === 0 && l.noise === 0); // ノイズ無しの0-ply段
const DEFAULT = levelById(DEFAULT_LEVEL);
if (!(WEAKEST.noise > 0)) fail('いちばん弱い段にノイズが乗っていない');
if (STRONGEST.noise !== 0) fail('いちばん強い段にノイズが乗っている');
if (!CLEAN) fail('ノイズ無しの段が 1 つも無い');
const fallback = agentFor(net, 'nonexistent-level');
if (fallback.noise !== DEFAULT.noise || fallback.searchPlies !== DEFAULT.plies) {
  fail('知らない段が既定の段に落ちていない');
}

// ── ノイズそのもの ─────────────────────────────
{
  // 同じ鍵なら必ず同じ値
  if (gaussianFor('abc') !== gaussianFor('abc')) fail('gaussianFor が決定的でない');
  if (gaussianFor('abc') === gaussianFor('abd')) fail('鍵が違うのに同じ値');
  // ざっくり標準正規分布になっていること（偏っていると σ の意味が変わる）
  const xs = [];
  for (let i = 0; i < 20000; i += 1) xs.push(gaussianFor(`key-${i}`));
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  if (Math.abs(mean) > 0.05) fail(`ノイズの平均が ${mean.toFixed(3)}（0 のはず）`);
  if (Math.abs(sd - 1) > 0.05) fail(`ノイズの標準偏差が ${sd.toFixed(3)}（1 のはず）`);
}

// ── 局面を集める ───────────────────────────────
//
// ノイズ無しの段で自己対局し、選択肢が 2 つ以上ある局面を貯める。

function seeded(s0) {
  let s = s0 >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const reference = agentFor(net, CLEAN.id);
const cases = [];
{
  const rng = seeded(20260822);
  const die = () => 1 + Math.floor(rng() * 6);
  let board = new Board();
  let turn = WHITE;
  for (let i = 0; i < 4000 && cases.length < 400; i += 1) {
    const d1 = die();
    const d2 = die();
    const moves = generateMoves(board, turn, d1, d2);
    if (moves.length > 1) cases.push({ board, turn, moves });
    if (moves.length) board = moves[reference.selectMove(moves, turn)].resultingBoard;
    turn = opponent(turn);
    if (board.hasWon(WHITE) || board.hasWon(opponent(WHITE))) { board = new Board(); turn = WHITE; }
  }
}
if (cases.length < 200) fail(`検体が ${cases.length} しか集まらなかった`);

/** その局面の、各手の真の equity（ノイズ無し）。 */
function trueValues({ board, turn, moves }) {
  return reference.equitiesFor(moves.map((m) => m.resultingBoard), opponent(turn))
    .map((v) => -v);
}

// ── 段ごとの振る舞い ────────────────────────────

const summary = [];
for (const level of LEVELS.filter((l) => l.plies === 0)) {
  const agent = agentFor(net, level.id);
  let agree = 0;
  let lossSum = 0;
  let worst = 0;
  let overCap = 0;
  let unstable = 0;

  for (const c of cases) {
    const values = trueValues(c);
    const best = Math.max(...values);
    const pick = agent.selectMove(c.moves, c.turn);

    // (1) 決定的か。**同じ局面で答えが変わると「考え直した」ように見える。**
    if (agent.selectMove(c.moves, c.turn) !== pick) unstable += 1;

    const loss = best - values[pick];
    if (loss <= 1e-12) agree += 1;
    lossSum += loss;
    worst = Math.max(worst, loss);
    // (2) 足切り。**最善から maxLoss 以上劣る手は選ばない。**
    if (loss > level.maxLoss + 1e-9) overCap += 1;
  }

  if (unstable > 0) fail(`${level.id}: 同じ局面で答えが変わった（${unstable} 件）`);
  if (overCap > 0) fail(`${level.id}: 足切りを超える手を ${overCap} 件選んだ`);
  if (level.noise === 0 && agree !== cases.length) {
    fail(`${level.id}: ノイズ無しなのに最善を外した（${cases.length - agree} 件）`);
  }
  if (level.noise > 0 && agree === cases.length) {
    fail(`${level.id}: ノイズを乗せたのに一度も最善を外していない`);
  }

  summary.push({
    id: level.id,
    name: level.name,
    agree: agree / cases.length,
    meanLoss: lossSum / cases.length,
    worst,
  });
}

// (3) 段が単調に弱いこと。弱い段ほど平均損失が大きく、一致率が低い。
for (let i = 0; i + 1 < summary.length; i += 1) {
  if (!(summary[i].meanLoss > summary[i + 1].meanLoss)) {
    fail(`${summary[i].id} が ${summary[i + 1].id} より弱くない`
      + `（平均損失 ${summary[i].meanLoss.toFixed(4)} / ${summary[i + 1].meanLoss.toFixed(4)}）`);
  }
  if (!(summary[i].agree < summary[i + 1].agree)) {
    fail(`${summary[i].id} の一致率が ${summary[i + 1].id} を下回っていない`);
  }
}

// (4) キューブにもノイズが乗ること。**着手だけ弱いと「手はヘボいがダブルは完璧」**
//     という妙な相手になる。同じ局面で強弱の equity が違うことを見る。
{
  const weak = agentFor(net, WEAKEST.id);
  const strong = agentFor(net, CLEAN.id);
  let differ = 0;
  for (const c of cases.slice(0, 100)) {
    const a = weak.equityFor(c.board, c.turn, c.turn);
    const b = strong.equityFor(c.board, c.turn, c.turn);
    if (Math.abs(a - b) > 1e-9) differ += 1;
  }
  if (differ === 0) fail('キューブ判断に使う equity にノイズが乗っていない');
  // 確率ベクトル側も同じく
  const p = weak.probabilitiesFor(cases[0].board, cases[0].turn);
  const q = strong.probabilitiesFor(cases[0].board, cases[0].turn);
  if (Math.abs(p[0] - q[0]) < 1e-9) fail('確率ベクトルにノイズが乗っていない');
  if (!(p[0] > 0 && p[0] < 1)) fail(`ノイズ後の P(win) が範囲外: ${p[0]}`);
}

// (5) 初心者だけの体感調整（2026-11-09、臆病化 2026-11-10）。**静かに外れると初心者がまた
//     完璧になる**ので、付いていることと他段に付いていないことを固定する。
{
  const weak = agentFor(net, WEAKEST.id);
  if (!(weak.doubleMargin > 0)) fail('初心者に doubleMargin が付いていない');
  if (!(weak.matchDoubleMargin > 0)) fail('初心者に matchDoubleMargin が付いていない');
  if (!(weak.takeMargin < 0)) fail('初心者の takeMargin が「テイクしすぎ」（負）になっていない');
  if (!(weak.matchTakeMargin < 0)) fail('初心者の matchTakeMargin が「テイクしすぎ」（負）になっていない');
  if (!(weak.blotPenalty > 0)) fail('初心者に blotPenalty が付いていない');
  for (const level of LEVELS.slice(1)) {
    const agent = agentFor(net, level.id);
    if (agent.doubleMargin !== 0 || agent.matchDoubleMargin !== 0
      || agent.takeMargin !== 0 || agent.matchTakeMargin !== 0
      || agent.blotPenalty !== 0) {
      fail(`${level.id} にキューブマージンかブロット罰が付いている（初心者だけのつもり）`);
    }
  }
  // ベアオフDBを配った状態で、初心者だけ受け取らないこと
  loadBearoffForTests();
  try {
    if (agentFor(net, WEAKEST.id).bearoff !== null) {
      fail('初心者がベアオフDBを使っている（終盤だけ完璧になる）');
    }
    if (agentFor(net, CLEAN.id).bearoff === null) {
      fail('ノイズ無しの段がベアオフDBを受け取っていない');
    }
  } finally {
    setBearoffDatabase(null);
  }
}

// (6) ヒント（`rankMoves`）。**壊れても静かなので固定する。**
//
// 検証は**2 段構え**にしてある: 仕組みは速い段で数を回し、**`ADVICE_LEVEL` が
// 本当にその段で繋がっているか**だけを少数の局面で確かめる。
//
// **ADVICE_LEVEL の深さを変えても壊れないように**この形を保つこと
// （深い読みは 1 局面ごとのコストが高く、多数の局面には掛けられない）。
let adviceStats = null;
{
  const level = levelById(ADVICE_LEVEL);

  // 助言に読み違えが乗っていたら助言ではない
  if (level.noise !== 0) fail('ヒントの段にノイズが乗っている');
  // **先読みする段であること。** 0-ply の助言では中級と同じ手しか出ず、
  // 「最善手を教える」機能として弱い。どこまで深くするかは速度との兼ね合いで
  // 選ぶ（いまは 2-ply。3-ply 相当へ戻すと待たされ過ぎる）。
  if (!(level.plies >= 2)) fail(`ヒントの段が ${level.plies}-ply（先読みしていない）`);

  // ── 仕組みの検証（速い段で数を回す） ──
  //
  // 2-ply でも 1 局面は数十〜数百 ms かかる。**主張に必要なだけ**に絞る
  // （全 400 局面だと 1 分近くかかり、テストとして回らなくなる）。
  const advice = agentFor(net, LEVELS.find((l) => l.plies === 2).id);
  const adviceCases = cases.slice(0, 80);
  let sameAsSelect = 0;
  let differFromFlat = 0;
  let ordered = 0;
  const flat = agentFor(net, CLEAN.id);   // 先読みなし・ノイズなし

  for (const c of adviceCases) {
    const ranked = advice.rankMoves(c.moves, c.turn, 3);
    if (ranked.length === 0) { fail('ヒントが空を返した'); break; }

    // **ヒントの 1 位は、同じ段の Agent が実際に選ぶ手と一致するはず。**
    // ここがずれると「AI が指さない手を最善だと言う」ことになる。
    if (ranked[0].index === advice.selectMove(c.moves, c.turn)) sameAsSelect += 1;
    // 探索が本当に効いているか（効いていなければ 0-ply と常に一致する）
    if (ranked[0].index !== flat.selectMove(c.moves, c.turn)) differFromFlat += 1;

    // 強い順に並び、loss は最善との差で単調に増える
    const okOrder = ranked.every((e, i) => (i === 0
      ? Math.abs(e.loss) < 1e-12
      : e.equity <= ranked[i - 1].equity + 1e-12 && e.loss >= ranked[i - 1].loss - 1e-12));
    if (okOrder) ordered += 1;

    // 確率は合計 1・非負
    const p = ranked[0].probabilities;
    const sum = p.win1 + p.win2 + p.win3 + p.lose1 + p.lose2 + p.lose3;
    if (Math.abs(sum - 1) > 1e-9) fail(`ヒントの確率の合計が ${sum}`);
    if (Object.values(p).some((v) => v < 0)) fail('ヒントの確率が負');
  }

  if (sameAsSelect !== adviceCases.length) {
    fail(`ヒントの 1 位が同じ段の着手と食い違う（${adviceCases.length - sameAsSelect} 件）`);
  }
  if (ordered !== adviceCases.length) {
    fail(`ヒントの並びが強い順でない（${adviceCases.length - ordered} 件）`);
  }
  // **0-ply と常に同じなら探索が繋がっていない。** 静かに壊れる形なので明示的に見る。
  if (differFromFlat === 0) fail('ヒントが 0-ply と常に同じ手（探索が効いていない）');

  // ── `ADVICE_LEVEL` が本当にその深さで繋がっているか（少数だけ） ──
  //
  // 深い読みは 1 局面ごとのコストが高いので数を絞る。ここで見たいのは正しさの統計ではなく
  // **「アプリが使う段で rankMoves が動き、着手と一致するか」**の 1 点。
  const deep = agentFor(net, ADVICE_LEVEL);
  if (deep.searchPlies !== level.plies) fail('ヒント用 Agent の先読みが段の表と違う');
  let deepChecked = 0;
  for (const c of cases.slice(0, 3)) {
    const ranked = deep.rankMoves(c.moves, c.turn, 3);
    if (!ranked.length) { fail('ヒント（最深）が空を返した'); break; }
    if (ranked[0].index !== deep.selectMove(c.moves, c.turn)) {
      fail('ヒント（最深）の 1 位が同じ段の着手と食い違う');
      break;
    }
    deepChecked += 1;
  }

  adviceStats = {
    sameAsSelect, differFromFlat, total: adviceCases.length, deepChecked, plies: level.plies,
  };
}

// (7) ダブルマージンの振る舞いと、search の足切りの境界（レビュー対応）。
//
// 設定値が付いているだけでは「判断が変わる」保証にならないので、
// 判断そのものが境界で反転することを、探索の中身を脚本化して確かめる。
{
  const freshGame = () => {
    const game = new Game(new Board(), Math.random, { jacoby: false });
    game.currentPlayer = WHITE;
    game.state = ROLLING;
    return game;
  };

  // ── マネー（閾値フォールバック経路）: equity 0.55 は素の基準 0.45 では
  //    ダブル、マージン 0.15 を足した 0.60 ではダブルしない。
  const thresholdAgent = (doubleMargin) => {
    const agent = new Agent(net, 0, DEFAULT_FILTERS, {
      noise: 0, doubleMargin, cubeDecision: 'threshold', useCubeHead: false,
    });
    agent.searchedEquityFor = () => 0.55;
    agent.jacobyEquityFor = () => 0.55;
    return agent;
  };
  if (thresholdAgent(0).shouldDouble(freshGame(), null) !== true) {
    fail('マネー: マージン 0 で equity 0.55 がダブルにならない');
  }
  if (thresholdAgent(0.15).shouldDouble(freshGame(), null) !== false) {
    fail('マネー: マージン 0.15 で equity 0.55 がダブルになってしまう');
  }

  // ── マッチ（search 経路）: take 0.52 / noDouble 0.50 は素ではダブル、
  //    マージン 0.03 を足すとダブルしない。
  const matchAgent = (matchDoubleMargin) => {
    const agent = new Agent(net, 0, DEFAULT_FILTERS, {
      noise: 0, matchDoubleMargin, useCubeHead: false,
    });
    agent.matchCubeSearch = () => ({ noDouble: 0.50, take: 0.52, drop: 0.60 });
    return agent;
  };
  const matchCtx = {
    length: 5, away: { [WHITE]: 2, [opponent(WHITE)]: 2 }, crawfordPlayed: true,
  };
  if (matchAgent(0).shouldDouble(freshGame(), matchCtx) !== true) {
    fail('マッチ: マージン 0 で take 0.52 がダブルにならない');
  }
  if (matchAgent(0.03).shouldDouble(freshGame(), matchCtx) !== false) {
    fail('マッチ: マージン 0.03 で take 0.52 がダブルになってしまう');
  }

  // ── マネー search の足切り: 差は新しい判定境界からの距離で測る。
  //    `cubefulSearch` を脚本化し、葉 0 段（leaf=0）と深い評価（leaf=null）
  //    で違う値を返す。nd は owner='center'、take 側は owner='opponent'。
  const scriptedAgent = (leaf0, deep) => {
    const agent = new Agent(net, 0, DEFAULT_FILTERS, {
      noise: 0, doubleMargin: 0.15, cubeLeafPlies: 1, cubeScreenMargin: 0.05,
      useCubeHead: false,
    });
    const calls = [];
    agent.cubefulSearch = (board, turn, owner, depth, jacoby, leaf) => {
      calls.push(leaf);
      const v = leaf === null ? deep : leaf0;
      return owner === 'opponent' ? v.tk : v.nd;
    };
    return { agent, calls };
  };
  // 境界の内側（浅い advantage -0.03）: 深い評価へ進み、その結果で決まる。
  // 旧実装は |0.12| > 0.05 で浅いまま確定し、false を返していた。
  {
    const { agent, calls } = scriptedAgent(
      { nd: 0.50, tk: 0.31 }, { nd: 0.50, tk: 0.40 });
    if (agent.shouldDoubleSearch(freshGame()) !== true) {
      fail('search 足切り: 境界の内側なのに深い評価の結果（ダブル）にならない');
    }
    if (!calls.includes(null)) {
      fail('search 足切り: 境界の内側なのに深い評価へ進んでいない');
    }
  }
  // 境界の外側（浅い advantage +0.25 / -0.25）: 足切りで確定し、深く読まない。
  for (const [leaf0, want] of [[{ nd: 0.50, tk: 0.45 }, true], [{ nd: 0.50, tk: 0.20 }, false]]) {
    const { agent, calls } = scriptedAgent(leaf0, { nd: 0.50, tk: 0.40 });
    if (agent.shouldDoubleSearch(freshGame()) !== want) {
      fail(`search 足切り: 境界の外側で浅い評価の結果（${want}）にならない`);
    }
    if (calls.includes(null)) {
      fail('search 足切り: 境界の外側なのに深い評価へ進んでしまった');
    }
  }
}

// (8) ブロット回避バイアスとテイクマージン（2026-11-10）。
//
// 罰が付いているだけでは性格が付いた保証にならないので、数え方の単位、
// 集計での振る舞い、テイク判断の反転までを固定する。
{
  // -- exposedBlotCount の数え方。
  //    White のブロット: 10 は Black（7 から射程 3）で打たれる、20 は安全。
  const points = new Array(24).fill(0);
  points[10] = 1; points[20] = 1; points[7] = -1;
  const board = new Board(points, { WHITE: 0, [opponent(WHITE)]: 0 },
    { WHITE: 0, [opponent(WHITE)]: 0 });
  if (exposedBlotCount(board, WHITE) !== 1) {
    fail('exposedBlotCount: 直接射程の数え方が違う');
  }
  //    バー再入場: Black がバーにいれば、White のホームボードのブロットは危ない。
  const points2 = new Array(24).fill(0);
  points2[3] = 1; points2[15] = -2;
  const board2 = new Board(points2, { WHITE: 0, [opponent(WHITE)]: 1 },
    { WHITE: 0, [opponent(WHITE)]: 0 });
  if (exposedBlotCount(board2, WHITE) !== 1) {
    fail('exposedBlotCount: バー再入場で打たれるブロットを数えていない');
  }

  // -- 集計: 「安全な代替手があるのにブロットを残す」割合が、初心者は
  //    最善手（ノイズ無し）より低いはず（ノイズだけでは逆に高かった）。
  const weak = agentFor(net, WEAKEST.id);
  let choice = 0; let weakBlot = 0; let cleanBlot = 0;
  for (const c of cases) {
    const blots = c.moves.map((m) => exposedBlotCount(m.resultingBoard, c.turn));
    if (!(Math.min(...blots) === 0 && Math.max(...blots) >= 1)) continue;
    choice += 1;
    if (blots[weak.selectMove(c.moves, c.turn)] >= 1) weakBlot += 1;
    if (blots[reference.selectMove(c.moves, c.turn)] >= 1) cleanBlot += 1;
  }
  if (choice < 50) fail(`ブロット回避: 選択局面が ${choice} しかない`);
  if (!(weakBlot < cleanBlot)) {
    fail('ブロット回避: 初心者のブロット選択が最善手を下回っていない');
  }
  console.log(`  ブロット回避: 選択局面 ${choice} で初心者 ${weakBlot} / 最善手 ${cleanBlot}（残す選択の数）`);

  // -- テイクマージンで判断が反転する（脚本化した探索）。
  const freshGame = () => {
    const game = new Game(new Board(), Math.random, { jacoby: false });
    game.currentPlayer = WHITE;
    game.state = ROLLING;
    return game;
  };
  // マネー（search 経路）: take 側の値 0.95 は素ではテイク、マージン 0.10 では降りる。
  const moneyTakeAgent = (takeMargin) => {
    const agent = new Agent(net, 0, DEFAULT_FILTERS, {
      noise: 0, takeMargin, useCubeHead: false,
    });
    agent.cubefulSearch = () => 0.475;
    return agent;
  };
  if (moneyTakeAgent(0).shouldAcceptDouble(freshGame(), null) !== true) {
    fail('テイク（マネー）: マージン 0 で take 0.95 がテイクにならない');
  }
  if (moneyTakeAgent(0.10).shouldAcceptDouble(freshGame(), null) !== false) {
    fail('テイク（マネー）: マージン 0.10 で take 0.95 をテイクしてしまう');
  }
  // マッチ（search 経路）: 提案者視点 take 0.49 / drop 0.50 は素ではテイク、
  // マージン 0.02 では降りる。
  const matchCtx = {
    length: 5, away: { [WHITE]: 2, [opponent(WHITE)]: 2 }, crawfordPlayed: true,
  };
  const matchTakeAgent = (matchTakeMargin) => {
    const agent = new Agent(net, 0, DEFAULT_FILTERS, {
      noise: 0, matchTakeMargin, useCubeHead: false,
    });
    agent.matchCubeSearch = () => ({ noDouble: 0.50, take: 0.49, drop: 0.50 });
    return agent;
  };
  if (matchTakeAgent(0).shouldAcceptDouble(freshGame(), matchCtx) !== true) {
    fail('テイク（マッチ）: マージン 0 で take 0.49 がテイクにならない');
  }
  if (matchTakeAgent(0.02).shouldAcceptDouble(freshGame(), matchCtx) !== false) {
    fail('テイク（マッチ）: マージン 0.02 で take 0.49 をテイクしてしまう');
  }

  // -- 初心者本人（段の設定そのもの）: 少し悪いテイクでも受けてしまう。
  //    マネー: take 側の値 1.02 は素なら降りるが、初心者は受ける。
  const weakMoney = agentFor(net, WEAKEST.id);
  weakMoney.cubefulSearch = () => 0.51;
  if (weakMoney.shouldAcceptDouble(freshGame(), null) !== true) {
    fail('テイク（初心者・マネー）: take 1.02 を受けない（テイクしすぎになっていない）');
  }
  //    マッチ: 提案者視点 take 0.51 / drop 0.50 は素なら降りるが、初心者は受ける。
  const weakMatch = agentFor(net, WEAKEST.id);
  weakMatch.matchCubeSearch = () => ({ noDouble: 0.50, take: 0.51, drop: 0.50 });
  if (weakMatch.shouldAcceptDouble(freshGame(), matchCtx) !== true) {
    fail('テイク（初心者・マッチ）: take 0.51 を受けない（テイクしすぎになっていない）');
  }
}

// ── 結果 ────────────────────────────────────

console.log(`強さの段: ${cases.length} 局面（選択肢 2 つ以上）で確認`);
for (const s of summary) {
  console.log(`  ${s.name.padEnd(4)} 最善一致 ${(s.agree * 100).toFixed(1)}%`
    + ` / 平均損失 ${(s.meanLoss * 1000).toFixed(1)} mEMG`
    + ` / 最悪 ${(s.worst * 1000).toFixed(0)} mEMG`);
}

if (adviceStats) {
  console.log(`  ヒントの仕組み（2-ply で検証） 1 位が同段の着手と一致`
    + ` ${adviceStats.sameAsSelect}/${adviceStats.total}`
    + ` / 0-ply と違った ${adviceStats.differFromFlat}`);
  console.log(`  ヒントの段: ${levelById(ADVICE_LEVEL).name}`
    + `（${adviceStats.plies}-ply）を ${adviceStats.deepChecked} 局面で結線確認`);
}

if (failures.length) {
  console.error(`\n不一致 ${failures.length} 件:`);
  for (const f of failures.slice(0, 20)) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('  段の性質（決定的・足切り・単調・キューブ連動）をすべて満たした');
}
