// 2 つのモデルの着手選択の速さを、**同じ局面で交互に**測る。
//
//   node tools/measure-speed.mjs <modelA.json> <modelB.json> [--plies 3] [--rounds 4] [--positions 16]
//
// **なぜ交互反復なのか**: 混雑したマシンでの単発計測は同じ変更に対して
// 0.89 倍と 1.26 倍の両方を出したことがある。A→B→B→A の順で何周も回して
// 各周の比を並べれば、背景負荷や熱による drift が両者に等しく乗るので、
// **比は安定する**（backgammon_engine の bg-model-swap / bg-longrun）。
//
// **ブラウザで効くのは JS の速さ。** Python 側で測った比はそのまま当てには
// ならない（JS は第 1 層の疎性を使うなど別の最適化が入っている。ADR-0016）。
//
// 局面はパリティ用のフィクスチャ（tests/backgammon/parity.json）から取る。
// 固定なので、モデルを替えても同じ問題を解かせられる。
import { readFileSync } from 'node:fs';
import {
  Board, WHITE, BLACK, NeuralNet, generateMoves, Agent,
} from '../docs/backgammon/src/nn-test-shim.mjs';
import { filtersFor } from '../docs/backgammon/src/agent.js';
import { loadBearoffForTests } from '../tests/backgammon/bearoff-setup.mjs';

// **ベアオフ DB は既定で有効。** 外すとベアオフ局面だけ別の速さになる。
loadBearoffForTests();

const args = process.argv.slice(2);
// **`--plies 3` の「3」をファイル名と取り違えないこと。** フラグの次は値。
const files = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith('--')) i += 1;
  else files.push(args[i]);
}
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
if (files.length !== 2) {
  console.error('モデルを 2 つ指定してください');
  process.exit(1);
}

const plies = opt('plies', 3);
const rounds = opt('rounds', 4);
const wanted = opt('positions', 16);

const fixture = JSON.parse(readFileSync(new URL('../tests/backgammon/parity.json', import.meta.url)));
const player = (s) => (s === 'WHITE' ? WHITE : BLACK);

// 合法手が 2 つ以上ある局面だけ使う（1 手しかない局面は探索が走らない）
const cases = [];
for (const entry of fixture.select_move) {
  const board = Board.fromJson(fixture.boards[entry.board]);
  const p = player(entry.player);
  const legal = generateMoves(board, p, entry.roll[0], entry.roll[1]);
  if (legal.length < 2) continue;
  cases.push({ legal, p });
  if (cases.length >= wanted) break;
}

const agents = files.map((path) => {
  const net = new NeuralNet(JSON.parse(readFileSync(path)));
  return { path, agent: new Agent(net, plies, filtersFor(plies)) };
});

/** 1 周ぶん計測して 1 手あたりのミリ秒を返す。 */
function timeOne({ agent }) {
  const t0 = performance.now();
  for (const { legal, p } of cases) agent.selectMove(legal, p);
  return (performance.now() - t0) / cases.length;
}

console.log(`${plies}-ply / ${cases.length} 局面 / ${rounds} 周（交互）`);
for (const { path } of agents) console.log(`  ${path}`);

// **1 周目は捨てる。** JIT の暖機が乗るので、そのまま混ぜると比が歪む。
for (const a of agents) timeOne(a);

const results = [[], []];
for (let r = 0; r < rounds; r += 1) {
  // 周ごとに順番を入れ替える（A→B→B→A…）。drift が片方に偏らないように。
  const order = r % 2 === 0 ? [0, 1] : [1, 0];
  for (const i of order) results[i].push(timeOne(agents[i]));
  const [a, b] = results.map((xs) => xs[xs.length - 1]);
  console.log(`  周 ${r + 1}: A ${a.toFixed(1)} ms/手 / B ${b.toFixed(1)} ms/手`
    + `  → B/A = ${(b / a).toFixed(3)}`);
}

const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
const [a, b] = results.map(median);
console.log(`\n中央値: A ${a.toFixed(1)} ms/手 / B ${b.toFixed(1)} ms/手`);
console.log(`**B は A の ${(b / a).toFixed(3)} 倍**`);
