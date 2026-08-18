// 符号化と推論が engine と一致するかを検証する。
// 使い方: node apps/backgammon/test/parity-encode.mjs
import { readFileSync } from 'node:fs';
import { Board, WHITE, BLACK, encodeBoard } from '../src/nn-test-shim.mjs';

const fixture = JSON.parse(readFileSync(new URL('./parity.json', import.meta.url)));
const player = (s) => (s === 'WHITE' ? WHITE : BLACK);

let checked = 0;
let bad = 0;
for (const entry of fixture.encode) {
  const board = Board.fromJson(fixture.boards[entry.board]);
  const got = encodeBoard(board, player(entry.viewer), player(entry.turn));
  const want = entry.base;
  checked += 1;
  if (got.length !== want.length) {
    bad += 1;
    console.log(`  長さ違い: got=${got.length} want=${want.length}`);
    continue;
  }
  for (let i = 0; i < want.length; i += 1) {
    if (Math.abs(got[i] - want[i]) > 1e-9) {
      bad += 1;
      console.log(`  encode[board=${entry.board} viewer=${entry.viewer} turn=${entry.turn}] `
        + `index ${i}: got=${got[i]} want=${want[i]}`);
      break;
    }
  }
}
console.log(`符号化: ${checked} 件中 ${checked - bad} 件一致 / 不一致 ${bad}`);
process.exit(bad ? 1 : 0);
