// AI の着手選択が engine と一致するかを検証する（0-ply と 2-ply）。
import { readFileSync } from 'node:fs';
import { Board, WHITE, BLACK, NeuralNet, generateMoves, Agent } from '../src/nn-test-shim.mjs';

const fixture = JSON.parse(readFileSync(new URL('./parity.json', import.meta.url)));
const net = new NeuralNet(JSON.parse(readFileSync(new URL('../src/model.json', import.meta.url))));
const player = (s) => (s === 'WHITE' ? WHITE : BLACK);

for (const plies of [0, 2]) {
  const agent = new Agent(net, plies);
  const key = `selected_${plies}ply`;
  let bad = 0;
  let shown = 0;
  // 壁時計（Date.now）は NTP の時刻補正で巻き戻ることがある。
  // 実際に -888.9 ms/手 という表示が出たので単調時計を使う。
  const t0 = performance.now();
  // フィクスチャは 2-ply の答えを一部の局面にしか持たない（生成が重いため）
  const entries = fixture.select_move.filter((e) => e[key] !== undefined);
  for (const entry of entries) {
    const board = Board.fromJson(fixture.boards[entry.board]);
    const p = player(entry.player);
    const legal = generateMoves(board, p, entry.roll[0], entry.roll[1]);
    if (legal.length === 0) continue;
    const got = agent.selectMove(legal, p);
    if (got !== entry[key]) {
      bad += 1;
      if (shown < 3) {
        shown += 1;
        console.log(`  select[board=${entry.board} ${entry.player} roll=${entry.roll}] `
          + `${plies}-ply got=${got} want=${entry[key]} (${legal.length} 手)`);
        console.log(`    got : ${legal[got]}`);
        console.log(`    want: ${legal[entry[key]]}`);
      }
    }
  }
  const n = entries.length;
  const ms = performance.now() - t0;
  console.log(`${plies}-ply の着手: ${n} 件中 ${n - bad} 件一致 / 不一致 ${bad}`
    + `  (${(ms / n).toFixed(1)} ms/手)`);
}
