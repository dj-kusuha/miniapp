// 推論（NeuralNet）が engine と一致するかを検証する。
import { readFileSync } from 'node:fs';
import { Board, WHITE, BLACK, encodeBoard, NeuralNet, equity } from '../../docs/backgammon/src/nn-test-shim.mjs';

const fixture = JSON.parse(readFileSync(new URL('./parity.json', import.meta.url)));
const net = new NeuralNet(JSON.parse(readFileSync(new URL('../../docs/backgammon/src/model.json', import.meta.url))));
const player = (s) => (s === 'WHITE' ? WHITE : BLACK);
const batchInputs = fixture.net.map((entry) => {
  const board = Board.fromJson(fixture.boards[entry.board]);
  return encodeBoard(board, WHITE, player(entry.turn));
});
const batchOutputs = net.predictBatch(batchInputs);

let bad = 0;
let batchBad = 0;
let maxDiff = 0;
for (const [index, entry] of fixture.net.entries()) {
  const board = Board.fromJson(fixture.boards[entry.board]);
  // perspective='white' のモデルなので viewer は常に WHITE
  const out = net.predict(encodeBoard(board, WHITE, player(entry.turn)));
  for (let unit = 0; unit < out.length; unit += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(out[unit] - batchOutputs[index][unit]));
    if (Math.abs(out[unit] - batchOutputs[index][unit]) > 1e-7) batchBad += 1;
  }
  for (let i = 0; i < entry.outputs.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(out[i] - entry.outputs[i]));
  }
  const eq = equity(out);
  maxDiff = Math.max(maxDiff, Math.abs(eq - entry.equity));
  if (Math.abs(eq - entry.equity) > 1e-5) {
    bad += 1;
    if (bad <= 3) {
      console.log(`  net[board=${entry.board} turn=${entry.turn}] `
        + `equity got=${eq.toFixed(6)} want=${entry.equity.toFixed(6)}`);
    }
  }
}
console.log(`推論: ${fixture.net.length} 件中 ${fixture.net.length - bad} 件一致 / 不一致 ${bad}`);
console.log(`  predictBatch: ${batchOutputs.length} 件中 ${batchOutputs.length - batchBad} 件一致 / 最大誤差 ${maxDiff.toExponential(2)}`);
process.exit(bad || batchBad ? 1 : 0);
