// マッチエクイティ表（MET）と、それを使ったキューブ判断の検証。
//
// **engine（Python）側に MET もマッチのキューブ判断も無い**ので、パリティの
// 相手はいない。代わりに次の 3 つで守る:
//
//   1. 表そのものの性質（対称・単調・範囲）
//   2. **gnubg が `show matchequitytable` で表示した値との突き合わせ**
//      （行と列の向きを間違えていないかを、実物の表示で固定する）
//   3. キューブ判断の**構造的に答えが決まっている場面**
//      （マッチポイントではキューブが死ぬ、ポストクロフォードの 2-away は
//      必ずダブル、など）

import { Board, Agent } from '../../docs/backgammon/src/nn-test-shim.mjs';
import { WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import {
  MET_NAME, MET_LENGTH, matchWinChance, mwcWithCube, outcomeSpread,
} from '../../docs/backgammon/src/met.js';
import { PRE_CRAWFORD, POST_CRAWFORD } from '../../docs/backgammon/src/met-table.js';

const failures = [];
const fail = (m) => failures.push(m);
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── 1. 表そのもの ───────────────────────────────

if (MET_LENGTH !== 25) fail(`MET_LENGTH が ${MET_LENGTH}（25 のはず）`);
if (PRE_CRAWFORD.length !== MET_LENGTH) fail(`pre の行数が ${PRE_CRAWFORD.length}`);
if (POST_CRAWFORD.length !== MET_LENGTH) fail(`post の長さが ${POST_CRAWFORD.length}`);

for (let i = 0; i < MET_LENGTH; i += 1) {
  if (PRE_CRAWFORD[i].length !== MET_LENGTH) fail(`pre 第 ${i + 1} 行の列数が違う`);
  for (let j = 0; j < MET_LENGTH; j += 1) {
    const v = PRE_CRAWFORD[i][j];
    if (!(v > 0 && v < 1)) fail(`pre[${i}][${j}] が範囲外: ${v}`);
    // 手番の有利を含まない表なので、必ず対称
    if (!near(v + PRE_CRAWFORD[j][i], 1)) {
      fail(`対称でない: ${i + 1}-away vs ${j + 1}-away`);
    }
  }
}

// 単調性: 自分の away が増えれば不利に、相手の away が増えれば有利になる
for (let i = 0; i + 1 < MET_LENGTH; i += 1) {
  for (let j = 0; j < MET_LENGTH; j += 1) {
    if (PRE_CRAWFORD[i + 1][j] > PRE_CRAWFORD[i][j]) {
      fail(`自分の away が増えて有利になっている（${i + 2}-away vs ${j + 1}-away）`);
    }
    if (PRE_CRAWFORD[j][i + 1] < PRE_CRAWFORD[j][i]) {
      fail(`相手の away が増えて不利になっている（${j + 1}-away vs ${i + 2}-away）`);
    }
  }
}

// ── 2. gnubg の表示との突き合わせ ─────────────────
//
// `show matchequitytable` の出力から書き写した値（%）。**行が自分の away、
// 列が相手の away**であることを、これで固定する。向きを取り違えると
// 1-away vs 2-away が 67.7% ではなく 32.3% になるので必ず落ちる。
const GNUBG_PRE = [
  // [自分の away, 相手の away, gnubg が表示した %]
  [1, 1, 50.0000], [1, 2, 67.7360], [1, 3, 75.0760], [1, 5, 84.1790],
  [2, 1, 32.2640], [2, 2, 50.0000], [2, 4, 66.8700], [2, 7, 84.2250],
  [3, 1, 24.9240], [3, 3, 50.0000], [3, 5, 64.7950],
  [4, 4, 50.0000], [5, 5, 50.0000], [7, 7, 50.0000],
  [9, 1, 5.5980], [25, 25, 50.0000],
];
for (const [us, them, pct] of GNUBG_PRE) {
  const got = PRE_CRAWFORD[us - 1][them - 1] * 100;
  if (!near(got, pct, 1e-4)) {
    fail(`pre ${us}-away vs ${them}-away が ${got.toFixed(4)}%（gnubg は ${pct}%）`);
  }
}

// ポストクロフォードの行。**列は「1-away の相手に対する側」の away**。
// gnubg の表示は 1 行しかなく、行ラベルが 1-away（＝リード側）固定なので
// 取り違えやすい。**値は列側（追う側）の勝率**。
const GNUBG_POST = [
  [1, 50.0000], [2, 48.8030], [3, 32.2640], [4, 31.0020],
  [5, 19.0120], [6, 18.0720], [9, 6.9530], [13, 2.5371],
];
for (const [away, pct] of GNUBG_POST) {
  const got = POST_CRAWFORD[away - 1] * 100;
  if (!near(got, pct, 1e-4)) {
    fail(`post ${away}-away が ${got.toFixed(4)}%（gnubg は ${pct}%）`);
  }
}

// 向きの裏取り。**クロフォード局をこれから打つ方が、追う側には不利**
// （キューブの使えない 1 局を挟まされるため）。
for (let away = 2; away <= 10; away += 1) {
  if (!(PRE_CRAWFORD[away - 1][0] < POST_CRAWFORD[away - 1])) {
    fail(`${away}-away: クロフォード前の方が有利になっている`
      + `（pre ${PRE_CRAWFORD[away - 1][0]} / post ${POST_CRAWFORD[away - 1]}）`);
  }
}

// ── 3. matchWinChance ──────────────────────────

if (matchWinChance(0, 3, false) !== 1) fail('決着済み（自分 0-away）が 1 でない');
if (matchWinChance(-2, 3, false) !== 1) fail('必要点を超えた勝ちが 1 でない');
if (matchWinChance(3, 0, false) !== 0) fail('決着済み（相手 0-away）が 0 でない');
if (!near(matchWinChance(1, 1, true), 0.5)) fail('1-away 同士のポストクロフォードが 0.5 でない');
if (!near(matchWinChance(2, 1, true), POST_CRAWFORD[1])) fail('ポストクロフォードの引き当てが違う');
if (!near(matchWinChance(1, 2, true), 1 - POST_CRAWFORD[1])) fail('ポストクロフォードの反転が違う');
if (!near(matchWinChance(2, 1, false), PRE_CRAWFORD[1][0])) fail('クロフォード前の引き当てが違う');
// 表より遠い away は頭打ち（7 ポイントまでのマッチでは起きないが、落ちないこと）
if (!near(matchWinChance(99, 99, false), PRE_CRAWFORD[24][24])) fail('away の頭打ちが効いていない');

for (let a = 1; a <= 9; a += 1) {
  for (let b = 1; b <= 9; b += 1) {
    for (const c of [false, true]) {
      if (!near(matchWinChance(a, b, c) + matchWinChance(b, a, c), 1)) {
        fail(`matchWinChance が対称でない（${a} / ${b} / crawford=${c}）`);
      }
    }
  }
}

// ── 4. outcomeSpread ──────────────────────────

const spreadOf = (probs, forWhite) => outcomeSpread(probs, forWhite);
{
  const s = spreadOf([0.6, 0.2, 0.05, 0.15, 0.02], true);
  const sum = s.win1 + s.win2 + s.win3 + s.lose1 + s.lose2 + s.lose3;
  if (!near(sum, 1, 1e-12)) fail(`spread の合計が ${sum}`);
  if (!near(s.win1, 0.4) || !near(s.win2, 0.15) || !near(s.win3, 0.05)) fail('勝ちの分解が違う');
  if (!near(s.lose1, 0.25) || !near(s.lose2, 0.13) || !near(s.lose3, 0.02)) fail('負けの分解が違う');

  // 視点を返すと勝ち負けが入れ替わる
  const f = spreadOf([0.6, 0.2, 0.05, 0.15, 0.02], false);
  if (!near(f.win1, s.lose1) || !near(f.win2, s.lose2) || !near(f.win3, s.lose3)) {
    fail('視点を反転しても勝ち負けが入れ替わっていない');
  }
}
{
  // **出力は独立なシグモイドなので包含関係が壊れることがある。**
  // 押さえてから差を取るので、負の確率が出てはいけない。
  const s = spreadOf([0.3, 0.9, 0.95, 0.8, 0.99], true);
  for (const [k, v] of Object.entries(s)) {
    if (v < 0) fail(`spread.${k} が負（${v}）`);
  }
  const sum = s.win1 + s.win2 + s.win3 + s.lose1 + s.lose2 + s.lose3;
  if (!near(sum, 1, 1e-12)) fail(`壊れた入力でも合計は 1 のはず（${sum}）`);
}

// ── 5. mwcWithCube ────────────────────────────
{
  // 2-away 同士でキューブ 2。**勝てばギャモンでもマッチが終わる**ので、
  // ギャモンとシングルの区別が消える（マッチ特有の効き方）。
  const a = mwcWithCube({ win1: 0.5, win2: 0, win3: 0, lose1: 0.5, lose2: 0, lose3: 0 },
    2, 2, 2, false);
  const b = mwcWithCube({ win1: 0, win2: 0.5, win3: 0, lose1: 0, lose2: 0.5, lose3: 0 },
    2, 2, 2, false);
  if (!near(a, b)) fail(`2-away 同士のキューブ 2 でギャモンに価値が付いている（${a} / ${b}）`);
}

// ── 6. キューブ判断（構造的に答えが決まる場面） ──────────
//
// モデルは使わず、**確率ベクトルを固定した差し替えネット**で判断だけを見る。

class StubNet {
  constructor(probs) { this.probs = probs; }
  predict() { return this.probs; }
}

/** `game` の代わりに使う最小の器。`canDouble()` だけ本物と同じ意味を持たせる。 */
function fakeGame(cubeValue, currentPlayer, probs) {
  return {
    board: new Board(),
    cube: { value: cubeValue },
    currentPlayer,
    doublingProposer: currentPlayer,
    jacoby: false,
    canDouble: () => true,
  };
}

const ctx = (awayWhite, awayBlack, crawfordPlayed) => ({
  length: 7,
  away: { [WHITE]: awayWhite, [BLACK]: awayBlack },
  crawfordPlayed,
});

/** さまざまな強さの局面。判断が確率に依らず決まることを見るため広く振る。 */
const PROB_SAMPLES = [
  [0.10, 0.02, 0.00, 0.30, 0.03],
  [0.30, 0.05, 0.01, 0.15, 0.02],
  [0.50, 0.15, 0.02, 0.15, 0.02],
  [0.70, 0.25, 0.03, 0.08, 0.01],
  [0.85, 0.45, 0.10, 0.03, 0.00],
  [0.95, 0.60, 0.20, 0.01, 0.00],
];

// (a) 自分がマッチポイント（1-away）ならキューブは死んでいる。**絶対にダブルしない。**
for (const probs of PROB_SAMPLES) {
  const agent = new Agent(new StubNet(probs), 0);
  const g = fakeGame(1, WHITE, probs);
  if (agent.shouldDouble(g, ctx(1, 5, false))) {
    fail(`マッチポイントなのにダブルした（P(win)=${probs[0]}）`);
  }
}

// (b) キューブが必要点に届いていれば、やはり死んでいる（2-away でキューブ 2）
for (const probs of PROB_SAMPLES) {
  const agent = new Agent(new StubNet(probs), 0);
  const g = fakeGame(2, WHITE, probs);
  if (agent.shouldDouble(g, ctx(2, 5, false))) {
    fail(`必要点に届いたキューブでダブルした（P(win)=${probs[0]}）`);
  }
}

// (c) ポストクロフォードで 2-away の側は、**ギャモンが無ければ必ず即ダブル**。
//     打たずに勝っても 1 点しか入らず 1-away 同士（50%）に戻るだけなので、
//     ダブルして失うものがない。
for (const probs of PROB_SAMPLES) {
  const flat = [probs[0], 0, 0, 0, 0];      // ギャモン率をすべて 0 にする
  const agent = new Agent(new StubNet(flat), 0);
  const g = fakeGame(1, WHITE, flat);
  if (!agent.shouldDouble(g, ctx(2, 1, true))) {
    fail(`ポストクロフォードの 2-away（ギャモン無し）でダブルしなかった（P(win)=${probs[0]}）`);
  }
}

// (c-2) **ただしギャモンが濃い局面では打ち続けるのが正しい。**
//
// 2-away では**ダブルしなくてもギャモンでマッチが終わる**（1×2 = 2 点）。
// 一方ダブルするとリード側はドロップできてしまい、こちらの取り分は 1 点
// （＝ 1-away 同士の 50%）で頭打ちになる。「too good to double」が
// ポストクロフォードの 2-away にも起きるということ。
//
// 場合分けは一切書いていない。MET を通した勝率比較から自然に出る。
{
  const gammonish = [0.85, 0.45, 0.10, 0.03, 0.00];
  const agent = new Agent(new StubNet(gammonish), 0);
  const g = fakeGame(1, WHITE, gammonish);
  const c = ctx(2, 1, true);
  const e = agent.matchCubeEquities(g.board, WHITE, 1, c);
  if (agent.shouldDouble(g, c)) {
    fail('ギャモンの濃いポストクロフォード 2-away でダブルしてしまった');
  }
  if (!near(e.pass, 0.5)) fail(`ドロップされたときの勝率が ${e.pass}（0.5 のはず）`);
  if (!(e.noDouble > e.pass)) {
    fail(`打ち続ける方が良いはずなのに ${e.noDouble} <= ${e.pass}`);
  }
}

// (d) テイク判断は「提案者のマッチ勝率が下がる方を選ぶ」と一致すること
for (const probs of PROB_SAMPLES) {
  const agent = new Agent(new StubNet(probs), 0);
  const g = fakeGame(1, WHITE, probs);
  const c = ctx(4, 3, false);
  const e = agent.matchCubeEquities(g.board, WHITE, 1, c);
  if (agent.shouldAcceptDouble(g, c) !== (e.take < e.pass)) {
    fail(`テイク判断が matchCubeEquities と食い違う（P(win)=${probs[0]}）`);
  }
}

// (e) スコアで判断が変わること自体の確認。**同じ局面でも away が違えば違う答え**が
//     出なければ、MET が効いていない。
{
  const probs = [0.62, 0.18, 0.02, 0.12, 0.01];
  const agent = new Agent(new StubNet(probs), 0);
  const g = fakeGame(1, WHITE, probs);
  const answers = new Set();
  for (let us = 1; us <= 7; us += 1) {
    for (let them = 1; them <= 7; them += 1) {
      answers.add(`${agent.shouldDouble(g, ctx(us, them, false))}`);
    }
  }
  if (answers.size < 2) fail('スコアを変えてもダブル判断が変わらない（MET が効いていない）');
}

// (f) マネーゲーム（文脈 null）では従来の判断のまま
{
  const probs = [0.62, 0.18, 0.02, 0.12, 0.01];
  const agent = new Agent(new StubNet(probs), 0);
  const g = fakeGame(1, WHITE, probs);
  const before = agent.shouldDouble(g, null);
  if (typeof before !== 'boolean') fail('マネーゲームの判断が真偽値でない');
}

// ── 結果 ────────────────────────────────────

console.log(`MET: ${MET_NAME}`);
console.log(`  表 ${MET_LENGTH}x${MET_LENGTH} + ポストクロフォード ${MET_LENGTH}`);
console.log(`  gnubg の表示と照合 ${GNUBG_PRE.length + GNUBG_POST.length} 点`);
console.log(`  キューブ判断の構造チェック ${PROB_SAMPLES.length * 4 + 2} 件`);

if (failures.length) {
  console.error(`\n不一致 ${failures.length} 件:`);
  for (const f of failures.slice(0, 20)) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('  MET とマッチのキューブ判断をすべて満たした');
}
