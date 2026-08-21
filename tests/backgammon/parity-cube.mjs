// キューブ判断が engine と一致するかを検証する。
//
// **engine の parity.json にはキューブが入っていない**ため、別ファイルで持つ
// （backgammon_engine の csharp/README.md にも同じ穴が記録されている）。
// 作り直すには engine 側で tools/export_cube_parity.py を実行する。
//
// ジャコビー ON / OFF、キューブの所在（センター / 自分）、値（1 / 2 / 4）を
// 変えた組を含む。所在によって「そもそもダブルできるか」が変わるため。
import { readFileSync } from 'node:fs';
import { Board, NeuralNet, Agent } from '../../docs/backgammon/src/nn-test-shim.mjs';
import { Game, ROLLING } from '../../docs/backgammon/src/game.js';

const cases = JSON.parse(readFileSync(new URL('./cube-parity.json', import.meta.url)));
const net = new NeuralNet(JSON.parse(
  readFileSync(new URL('../../docs/backgammon/src/model.json', import.meta.url))));
const agent = new Agent(net, 0);

let bad = 0;
for (const c of cases) {
  const board = new Board([...c.points], { WHITE: c.bar[0], BLACK: c.bar[1] },
                          { WHITE: c.off[0], BLACK: c.off[1] });
  const game = new Game(board, Math.random, { jacoby: c.jacoby });
  game.currentPlayer = c.turn;
  game.state = ROLLING;
  game.cube.value = c.cube_value;
  game.cube.owner = c.cube_owner;
  const got = agent.shouldDouble(game);
  if (got !== c.should_double) {
    bad += 1;
    if (bad <= 3) {
      console.log(`  cube=${c.cube_value}/${c.cube_owner} jacoby=${c.jacoby} `
        + `js=${got} engine=${c.should_double}`);
    }
  }
}
console.log(`キューブ判断: ${cases.length} 件中 ${cases.length - bad} 件一致 / 不一致 ${bad}`);
process.exit(bad ? 1 : 0);
