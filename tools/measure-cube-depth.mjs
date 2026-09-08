// キューブ判断を深く読ませてよいかを測る。
//
//   node tools/measure-cube-depth.mjs [--positions 2631] [--reps 3] [--timing-sample 100]
//
// **強い段で `cubeLeafPlies: 1` を有効にしてよいかを決めるための道具。**
// 有効にすると葉でもダイスを 1 段展開するのでコストが跳ねる。値打ちがあるかは
// 「速さ」と「正答率」の両方を見ないと決まらない。
//
// 測るのは 3 つ:
//
//   1. **正答率**（gnubg 3-ply の正解に対する誤り数）。深さがまだ効くか。
//   2. **コスト**（1 判断あたりの ms）。ブラウザの予算に載るか。
//   3. **マネー側の足切り幅の較正**。engine の ADR-0038 が較正したのは
//      マッチ側（MWC）だけで、マネー（equity）は単位が違うので流用できない。
//
// ## なぜ測り直しが要るのか
//
// engine の ADR-0038 は「`cube_leaf_plies` 0→1 で **-0.910 mEMG**」を得たが、
// **それはマッチの cube efficiency が 0.68 だったときの値**である。ADR-0041 で
// 0.55 に変えた（-2.641 mEMG）ので、ADR-0041 自身が
// **「深さの効果は測り直しになる」**と書いている。深さが拾っていた改善と
// 0.55 が拾った改善が重なっていれば、深くしてもほぼ動かない。
//
// ## 読み方の決まり（**外すと数字を読み違える**）
//
// - **正答率で読む。** 際どいベンチは失点の上限が margin そのものなので、
//   mEMG は構造的に小さく出る。全ベンチの mEMG と並べてはいけない。
// - **速度は空いたマシンで測る。** 混雑下の単発計測は同じ変更に対して
//   0.89x と 1.26x の両方を出したことがある。このスクリプトは起動時に
//   load average を見て警告する。
// - **足切り幅は「大きいほど深く読む」。** 判定は「差が幅より開いていれば
//   打ち切る」なので、幅 0 は足切り自体を無効にする＝常に深く読む。

import { readFileSync } from 'node:fs';

const src = (name) => new URL(`../docs/backgammon/src/${name}`, import.meta.url).href;
const { NeuralNet } = await import(src('nn.js'));
const { Agent, filtersFor } = await import(src('agent.js'));
const { Board } = await import(src('board.js'));
const { Game } = await import(src('game.js'));

const BENCH = '/home/kusuha/repos/backgammon_engine/benchmarks/cube_hard_double.json';
const MODEL = new URL('../docs/backgammon/src/model.json', import.meta.url);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const WANT = arg('positions', 2631);
const REPS = arg('reps', 3);
const TIMING_N = arg('timing-sample', 100);
const PLIES = arg('plies', 2);      // 上級 = 2-ply。--plies 3 でエキスパート

// ── マシンが空いているか ────────────────────────────
const load1 = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
const cores = (await import('node:os')).cpus().length;
if (load1 > cores * 0.25) {
  console.log(`⚠ load average ${load1.toFixed(2)} / ${cores} コア。`
    + '**速度の数字は信用しないこと**（正答率は決定的なので影響なし）。\n');
}

const all = JSON.parse(readFileSync(BENCH)).positions;
const step = Math.max(1, Math.floor(all.length / WANT));
const sample = [];
for (let i = 0; i < all.length && sample.length < WANT; i += step) sample.push(all[i]);

const net = new NeuralNet(JSON.parse(readFileSync(MODEL)));

function build(c) {
  const board = new Board([...c.points], { WHITE: c.bar[0], BLACK: c.bar[1] },
                          { WHITE: c.borne_off[0], BLACK: c.borne_off[1] });
  const game = new Game(board, Math.random, { jacoby: false });
  game.currentPlayer = c.on_roll === 'white' ? 'WHITE' : 'BLACK';
  game.cube.value = c.cube_value;
  game.cube.owner = c.cube_owner === null ? null
    : (c.cube_owner === 'white' ? 'WHITE' : 'BLACK');
  const away = { WHITE: c.match_length - c.scores[0], BLACK: c.match_length - c.scores[1] };
  return {
    game,
    match: { length: c.match_length, away, crawfordPlayed: false },
    // gnubg 3-ply の正解。"Double, take" / "No double, take" など
    shouldDouble: c.proper.startsWith('Double'),
  };
}

const cases = sample.map(build);
const agentWith = (opts) => new Agent(net, PLIES, filtersFor(PLIES), opts);

function run(opts, useMatch) {
  const agent = agentWith(opts);
  const t0 = process.hrtime.bigint();
  const got = cases.map(({ game, match }) => agent.shouldDouble(game, useMatch ? match : null));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { got, ms };
}

const errors = (got) => got.reduce((n, v, i) => n + (v !== cases[i].shouldDouble ? 1 : 0), 0);
const differs = (a, b) => a.reduce((n, v, i) => n + (v !== b[i] ? 1 : 0), 0);
const pct = (n) => `${((n / cases.length) * 100).toFixed(1)}%`;

// ══ 1. 正答率: 深さがまだ効くか（マッチの経路）═══════════════
console.log(`■ 正答率（際どいダブル ${cases.length} 局面 / ${PLIES}-ply / gnubg 3-ply が正解）\n`);

const flat = run({ cubeLeafPlies: 0 }, true);
const deep = run({ cubeLeafPlies: 1, matchCubeScreenMargin: 0.020 }, true);

const eFlat = errors(flat.got);
const eDeep = errors(deep.got);
console.log(`  leaf=0            誤り ${eFlat} 件 (${pct(eFlat)})`);
console.log(`  leaf=1 (幅 0.020)  誤り ${eDeep} 件 (${pct(eDeep)})`);

let fixed = 0;
let broken = 0;
flat.got.forEach((v, i) => {
  if (v === deep.got[i]) return;
  if (deep.got[i] === cases[i].shouldDouble) fixed += 1; else broken += 1;
});
console.log(`  判断が変わった ${fixed + broken} 件（直った ${fixed} / 壊れた ${broken}）`);
console.log(`  → 深さの利得: ${eFlat - eDeep > 0 ? '+' : ''}${eFlat - eDeep} 件\n`);

// ══ 2. マネー側の足切り幅を較正する ════════════════════════
//
// 基準は「足切りなしの leaf=1」。**同じ判断を出す中でいちばん速い幅**を採る。
// マッチ側（0.020）と違って単位が equity なので、桁から探る。
console.log('■ マネー側の足切り幅の較正（基準 = 足切りなしの leaf=1・同じ判断か）\n');

const moneyRef = run({ cubeLeafPlies: 1 }, false);
console.log(`  幅なし（常に深く読む）  ${moneyRef.ms.toFixed(0)} ms`
  + `  1 判断 ${(moneyRef.ms / cases.length).toFixed(1)} ms`);

for (const margin of [0.005, 0.010, 0.020, 0.040, 0.080]) {
  const r = run({ cubeLeafPlies: 1, cubeScreenMargin: margin }, false);
  const d = differs(r.got, moneyRef.got);
  console.log(`  幅 ${margin.toFixed(3)}            ${r.ms.toFixed(0)} ms`
    + `  1 判断 ${(r.ms / cases.length).toFixed(1)} ms`
    + `  ${(moneyRef.ms / r.ms).toFixed(2)}x  判断の食い違い ${d} 件`);
}
console.log('');

// ══ 3. コスト: ブラウザの予算に載るか ═════════════════════
console.log(`■ コスト（${TIMING_N} 局面 / ${REPS} 反復・交互）\n`);

// **マネーとマッチの両方を測る。** アプリの既定はマネー（アンリミテッド）
// なので、マッチだけ測って「載る」と判断すると既定の遊び方を外す。
const timing = cases.slice(0, TIMING_N);
const CONFIGS = [
  ['マネー leaf=0（既定）', { cubeLeafPlies: 0 }, false],
  ['マネー leaf=1 幅なし', { cubeLeafPlies: 1 }, false],
  ['マネー leaf=1 幅 0.040', { cubeLeafPlies: 1, cubeScreenMargin: 0.040 }, false],
  ['マッチ leaf=0（既定）', { cubeLeafPlies: 0 }, true],
  ['マッチ leaf=1 幅なし', { cubeLeafPlies: 1 }, true],
  ['マッチ leaf=1 幅 0.020', { cubeLeafPlies: 1, matchCubeScreenMargin: 0.020 }, true],
];
const times = CONFIGS.map(() => []);
for (let r = 0; r < REPS; r++) {
  CONFIGS.forEach(([, opts, useMatch], ci) => {
    const agent = agentWith(opts);
    const t0 = process.hrtime.bigint();
    for (const { game, match } of timing) agent.shouldDouble(game, useMatch ? match : null);
    times[ci].push(Number(process.hrtime.bigint() - t0) / 1e6);
  });
}
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
CONFIGS.forEach(([name], i) => {
  // **比べる相手はその形式の leaf=0。** マネーとマッチは経路が違うので、
  // まとめて 1 つの基準にすると倍率の意味が消える。
  const base = med(times[i < 3 ? 0 : 3]);
  const m = med(times[i]);
  console.log(`  ${name.padEnd(22)} 1 判断 ${(m / timing.length).toFixed(1).padStart(8)} ms`
    + `  leaf=0 比 ${(m / base).toFixed(1).padStart(6)}x`
    + `  [${times[i].map((t) => (t / timing.length).toFixed(1)).join(', ')}]`);
});

if (load1 > cores * 0.25) {
  console.log('\n⚠ 混雑下で測った。**上の速度は使えない。**'
    + ' 空いたマシンで測り直すこと（正答率と足切りの較正は決定的なので有効）。');
}
