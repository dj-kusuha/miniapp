// 強さの段（弱い相手の作り方）の検証。
//
// gnubg での採点は `tools/measure-level.mjs` が別途やる（docker が要るので
// ここでは回さない）。ここで守るのは**設計どおりに動いているか**:
//
//   1. **決定的**であること（同じ局面なら何度でも同じ手）
//   2. **足切りが効く**こと（最善から maxLoss 以上劣る手を選ばない）
//   3. **段が単調に弱い**こと（ノイズが大きいほど平均損失が増える）
//   4. **キューブにもノイズが乗る**こと（手だけヘボくならない）

import { readFileSync } from 'node:fs';
import { Board, NeuralNet, Agent } from '../../docs/backgammon/src/nn-test-shim.mjs';
import { WHITE, opponent } from '../../docs/backgammon/src/board.js';
import {
  LEVELS, DEFAULT_LEVEL, agentFor, levelById, gaussianFor,
} from '../../docs/backgammon/src/agent.js';
import { generateMoves } from '../../docs/backgammon/src/rules.js';

const net = new NeuralNet(JSON.parse(
  readFileSync(new URL('../../docs/backgammon/src/model.json', import.meta.url))));

const failures = [];
const fail = (m) => failures.push(m);

// ── 段の表そのもの ──────────────────────────────

if (LEVELS.length !== 5) fail(`段が ${LEVELS.length} 個（5 のはず）`);
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
const CLEAN = LEVELS.find((l) => l.noise === 0);   // ノイズ無しで最も弱い段
if (!(WEAKEST.noise > 0)) fail('いちばん弱い段にノイズが乗っていない');
if (STRONGEST.noise !== 0) fail('いちばん強い段にノイズが乗っている');
if (!CLEAN) fail('ノイズ無しの段が 1 つも無い');
if (agentFor(net, 'nonexistent-level').noise !== 0) fail('知らない段が既定に落ちていない');
if (levelById(DEFAULT_LEVEL).noise !== 0) fail('既定の段にノイズが乗っている');

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

// ── 結果 ────────────────────────────────────

console.log(`強さの段: ${cases.length} 局面（選択肢 2 つ以上）で確認`);
for (const s of summary) {
  console.log(`  ${s.name.padEnd(4)} 最善一致 ${(s.agree * 100).toFixed(1)}%`
    + ` / 平均損失 ${(s.meanLoss * 1000).toFixed(1)} mEMG`
    + ` / 最悪 ${(s.worst * 1000).toFixed(0)} mEMG`);
}

if (failures.length) {
  console.error(`\n不一致 ${failures.length} 件:`);
  for (const f of failures.slice(0, 20)) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('  段の性質（決定的・足切り・単調・キューブ連動）をすべて満たした');
}
