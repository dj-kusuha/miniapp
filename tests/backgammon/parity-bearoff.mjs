// ベアオフの厳密解が engine と一致するかを検証する。
//
// engine が書いた `docs/backgammon/src/bearoff-6x15.bin` を読み、
// `parity.json` の `bearoff` にある期待値と突き合わせる。
//
// **float16 で持つので完全一致はしない。** engine 側の実測で最大 1.2e-04
// （3,776 局面の判定で変わったのは 16 局面・平均差 +0.003 mEMG）。
import { readFileSync } from 'node:fs';
import {
  Board, WHITE, BLACK, NeuralNet, agentFor, setBearoffDatabase,
} from '../../docs/backgammon/src/nn-test-shim.mjs';
import { BearoffDatabase } from '../../docs/backgammon/src/bearoff.js';

const TOLERANCE = 1e-3;

const fixture = JSON.parse(readFileSync(new URL('./parity.json', import.meta.url)));
const entries = fixture.bearoff;
if (!Array.isArray(entries) || entries.length === 0) {
  console.log('parity.json に bearoff がありません（engine 側で書き出し直すこと）');
  process.exit(1);
}

const bytes = readFileSync(new URL('../../docs/backgammon/src/bearoff-6x15.bin', import.meta.url));
const db = new BearoffDatabase(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

let bad = 0;
let gammons = 0;
for (const [index, entry] of entries.entries()) {
  const board = Board.fromJson(entry.board);
  const turn = entry.turn === 'WHITE' ? WHITE : BLACK;
  const got = db.boardProbabilities(board, turn);
  if (got === null) {
    console.log(`  [${index}] 適用範囲のはずが null`);
    bad += 1;
    continue;
  }
  if (entry.probabilities[1] > 0 || entry.probabilities[3] > 0) gammons += 1;
  for (let k = 0; k < 5; k += 1) {
    const diff = Math.abs(got[k] - entry.probabilities[k]);
    if (diff > TOLERANCE) {
      bad += 1;
      if (bad <= 3) {
        console.log(`  [${index}] 出力 ${k}: got=${got[k].toFixed(6)} `
          + `want=${entry.probabilities[k]} 差=${diff.toExponential(2)}`);
      }
    }
  }
}

// **配線も確かめる。** DB を読めていても Agent が使っていなければ意味がない
// （「移植したつもりで動いていない」がいちばん怖い）。
const net = new NeuralNet(JSON.parse(
  readFileSync(new URL('../../docs/backgammon/src/model.json', import.meta.url))));
const sample = entries.find((e) => e.turn === 'WHITE');
const sampleBoard = Board.fromJson(sample.board);

setBearoffDatabase(null);
const withoutDb = agentFor(net, 'expert').vectorFor(sampleBoard, WHITE);
setBearoffDatabase(db);
const withDb = agentFor(net, 'expert').vectorFor(sampleBoard, WHITE);

if (Math.abs(withDb[0] - sample.probabilities[0]) > TOLERANCE) {
  console.log(`  **Agent が DB を使っていない**: got=${withDb[0]} want=${sample.probabilities[0]}`);
  bad += 1;
}
if (Math.abs(withoutDb[0] - withDb[0]) < 1e-9) {
  console.log('  **DB あり / なしで値が同じ**（差し替えが効いていない疑い）');
  bad += 1;
}

console.log(`ベアオフの厳密解: ${entries.length} 件（うちギャモンを含む ${gammons} 件）`
  + ` / 状態 ${db.count.toLocaleString()}`);
console.log(`  Agent 経由でも厳密解になる（DB なし ${withoutDb[0].toFixed(4)} → `
  + `あり ${withDb[0].toFixed(4)}）`);
if (bad > 0) {
  console.log(`  **${bad} 件ずれた**`);
  process.exit(1);
}
console.log('  engine と一致（許容差 1e-3）');
