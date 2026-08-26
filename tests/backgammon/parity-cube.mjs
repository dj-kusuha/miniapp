// キューブ判断が engine と一致するかを検証する。
//
// **engine の parity.json にはキューブが入っていない**ため、別ファイルで持つ
// （backgammon_engine の csharp/README.md にも同じ穴が記録されている）。
// 作り直すには engine 側で tools/export_cube_parity.py を実行する。
//
// ジャコビー ON / OFF、キューブの所在（センター / 自分）、値（1 / 2 / 4）を
// 変えた組を含む。所在によって「そもそもダブルできるか」が変わるため。
//
// **テイク判断と、テイクの境界値も検証する**（2026-08-23 に追加）。
// それまでは shouldDouble だけを見ており、cubeOwnership が効くのはテイク判断
// だけなので、**engine 側で定数を 0.0 → 0.130 に変えてもこのテストは通って
// しまった**。しかも実局面 60 件は境界（2E + c = -1）から遠く、テイク判断を
// 足すだけでは検出できない。**境界値を直接ぶつけること。**
import { readFileSync } from 'node:fs';
import { Board, NeuralNet, Agent } from '../../docs/backgammon/src/nn-test-shim.mjs';
import { DEFAULT_CUBE_MODEL, DEFAULT_CUBE_EFFICIENCY } from '../../docs/backgammon/src/agent.js';
import { Game, ROLLING } from '../../docs/backgammon/src/game.js';

const data = JSON.parse(readFileSync(new URL('./cube-parity.json', import.meta.url)));
const net = new NeuralNet(JSON.parse(
  readFileSync(new URL('../../docs/backgammon/src/model.json', import.meta.url))));
const agent = new Agent(net, 0);

// **ケースごとに cube_plies が違う。** 既定が min(searchPlies, 2) になったので、
// 上級・エキスパートの実戦は 2 段を通る。**0 段のケースだけで検証すると、
// 探索を実装していなくても全部通ってしまう**（実際に JS 側は 0-ply のまま
// だった。2026-08-26）。engine 側は tools/export_cube_parity.py で書き出す。
const agentFor = (plies) => (plies ? new Agent(net, 0, undefined, { cubePlies: plies }) : agent);

function setup(c) {
  const board = new Board([...c.points], { WHITE: c.bar[0], BLACK: c.bar[1] },
                          { WHITE: c.off[0], BLACK: c.off[1] });
  const game = new Game(board, Math.random, { jacoby: c.jacoby });
  game.currentPlayer = c.turn;
  game.state = ROLLING;
  game.cube.value = c.cube_value;
  game.cube.owner = c.cube_owner;
  return game;
}

let bad = 0;
let takeChecked = 0;
for (const c of data.positions) {
  const agent = agentFor(c.cube_plies ?? 0);
  const got = agent.shouldDouble(setup(c));
  if (got !== c.should_double) {
    bad += 1;
    if (bad <= 3) {
      console.log(`  ダブル cube=${c.cube_value}/${c.cube_owner} jacoby=${c.jacoby} `
        + `plies=${c.cube_plies ?? 0} js=${got} engine=${c.should_double}`);
    }
  }

  if (c.should_accept_double === null) continue;
  const proposed = setup(c);
  if (!proposed.canDouble()) continue;
  proposed.proposeDouble();
  takeChecked += 1;
  const take = agent.shouldAcceptDouble(proposed);
  if (take !== c.should_accept_double) {
    bad += 1;
    if (bad <= 6) {
      console.log(`  テイク cube=${c.cube_value}/${c.cube_owner} jacoby=${c.jacoby} `
        + `plies=${c.cube_plies ?? 0} js=${take} engine=${c.should_accept_double}`);
    }
  }
}

// **境界値。** ここが cubeOwnership のズレを実際に捕まえる。
let borderBad = 0;
for (const c of data.take_threshold) {
  const got = agent.wouldTake(c.equity_for_taker);
  if (got !== c.would_take) {
    borderBad += 1;
    if (borderBad <= 3) {
      console.log(`  境界 E=${c.equity_for_taker} js=${got} engine=${c.would_take}`);
    }
  }
}

// **Janowski の境界値。** take_threshold は定数式の境目なので、
// cubeModel='janowski' に切り替えると何も検出しない。W / L の組み合わせごとに
// 境目が違うため、代表的な (W, L) について境目をまたぐ勝率を並べてある。
let janBad = 0;
for (const c of data.janowski_threshold ?? []) {
  const q = 1 - c.win_probability;
  const vector = [c.win_probability, c.win_probability * (c.w - 1), 0,
                  q * (c.l - 1), 0];
  const got = agent.wouldTakeJanowski(vector);
  if (got !== c.would_take) {
    janBad += 1;
    if (janBad <= 3) {
      console.log(`  Janowski p=${c.win_probability} W=${c.w} L=${c.l} `
        + `js=${got} engine=${c.would_take}`);
    }
  }
}

// **既定そのものを照合する。** 式が正しいことと、それが使われていることは別。
// cubeModel を constant に戻しても境界値の項目は Janowski の式を直接呼ぶので
// 通ってしまい、検出できなかった（2026-08-23）。
let defBad = 0;
for (const [key, want] of Object.entries(data.defaults ?? {})) {
  const got = key === 'cube_model' ? DEFAULT_CUBE_MODEL : DEFAULT_CUBE_EFFICIENCY;
  if (got !== want) {
    defBad += 1;
    console.log(`  既定 ${key}: js=${got} engine=${want}`);
  }
}

console.log(`キューブ判断: ダブル ${data.positions.length} 件 / テイク ${takeChecked} 件 `
  + `中 不一致 ${bad}`);
console.log(`  テイクの境界値: 定数 ${data.take_threshold.length} 件 不一致 ${borderBad}`
  + ` / Janowski ${(data.janowski_threshold ?? []).length} 件 不一致 ${janBad}`);
console.log(`  既定の照合: ${Object.keys(data.defaults ?? {}).length} 件中 不一致 ${defBad}`);
process.exit(bad + borderBad + janBad + defBad ? 1 : 0);
