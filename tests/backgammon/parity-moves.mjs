// 合法手の生成が engine と一致するかを検証する。
//
// **棋譜表記の集合として比べる。** 順序は問わないが、集合が 1 手でも違えば
// 不一致とする。engine が正本。
import { readFileSync } from 'node:fs';
import { Board, WHITE, BLACK, generateMoves } from '../../docs/backgammon/src/nn-test-shim.mjs';

const fixture = JSON.parse(readFileSync(new URL('./parity.json', import.meta.url)));
const player = (s) => (s === 'WHITE' ? WHITE : BLACK);

let bad = 0;
let shown = 0;
for (const entry of fixture.moves) {
  const board = Board.fromJson(fixture.boards[entry.board]);
  const got = generateMoves(board, player(entry.player), entry.roll[0], entry.roll[1])
    .map((m) => m.toString()).sort();
  const want = [...entry.moves].sort();

  const same = got.length === want.length && got.every((v, i) => v === want[i]);
  if (!same) {
    bad += 1;
    if (shown < 3) {
      shown += 1;
      const missing = want.filter((v) => !got.includes(v));
      const extra = got.filter((v) => !want.includes(v));
      console.log(`  moves[board=${entry.board} ${entry.player} roll=${entry.roll}] `
        + `got=${got.length} want=${want.length}`);
      if (missing.length) console.log(`    足りない: ${missing.slice(0, 5).join(' | ')}`);
      if (extra.length) console.log(`    余分    : ${extra.slice(0, 5).join(' | ')}`);
    }
  }
}
console.log(`合法手: ${fixture.moves.length} 件中 ${fixture.moves.length - bad} 件一致 / 不一致 ${bad}`);
process.exit(bad ? 1 : 0);
