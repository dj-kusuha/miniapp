// 1 局まるごとの進行が engine と一致するかを検証する。
//
// 符号化・合法手・NN・着手選択・対局ループが**全部**噛み合っていないと最後まで
// 一致しないので、移植の総合テストとしては一番強い。フィクスチャは 1 手ごとに
// 盤面のスナップショットを持っているため、ズレた瞬間の手番まで特定できる。
//
// ダブリングキューブは移植していないので、`use_cube: false` のトレースだけを使う。
import { readFileSync } from 'node:fs';

import { NeuralNet, Agent } from '../../docs/backgammon/src/nn-test-shim.mjs';
import { Game, GAME_OVER } from '../../docs/backgammon/src/game.js';
import { loadBearoffForTests } from './bearoff-setup.mjs';

// **engine は DB を既定で有効にしている。** 揃えないとベアオフ局面で食い違う。
loadBearoffForTests();

const fixture = JSON.parse(readFileSync(new URL('./parity.json', import.meta.url)));
const net = new NeuralNet(JSON.parse(readFileSync(new URL('../../docs/backgammon/src/model.json', import.meta.url))));

/** 盤面を engine のフィクスチャと同じ形にする。 */
const boardToJson = (board) => ({
  points: [...board.points],
  bar: [board.bar.WHITE, board.bar.BLACK],
  off: [board.off.WHITE, board.off.BLACK],
});

// **`equal_notations` は照合の対象にしない。** engine が「同点だった手」を
// 参考情報として入れているだけで、JS 側は持たない（上の同点処理で使う）。
const strip = (v) => {
  if (!v || typeof v !== 'object' || !('equal_notations' in v)) return v;
  const { equal_notations: _ignored, ...rest } = v;
  return rest;
};
const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));

const traces = fixture.traces.filter((t) => !t.use_cube);
let checked = 0;
let tiesAccepted = 0;
let mismatch = 0;
const details = [];

for (const [index, trace] of traces.entries()) {
  const agent = new Agent(net, trace.search_plies);

  // engine の randint(1, 6) が返した値をそのまま再生する。
  let cursor = 0;
  const rng = () => {
    const value = trace.die_values[cursor];
    cursor += 1;
    if (value === undefined) throw new Error(`trace ${index}: 出目が足りない`);
    return (value - 0.5) / 6;
  };

  const game = new Game(null, rng);
  game.start();

  // engine 側は着手と「着手不能で飛ばしたターン」を別のイベントで記録している。
  // JS 側は skipTurn がログに積むので、両方を 1 本の列に並べて突き合わせる。
  let logRead = 0;
  const seen = [];
  const drainSkips = () => {
    for (; logRead < game.log.length; logRead += 1) {
      const entry = game.log[logRead];
      if (entry.kind === 'skip') {
        seen.push({ type: 'skipped', player: entry.player, roll: entry.roll });
      }
    }
  };

  for (let guard = 0; ; guard += 1) {
    if (guard > 4000) throw new Error(`trace ${index}: 局が終わらない`);
    drainSkips();
    if (game.prepareTurn() === null) break;
    drainSkips();
    let move = game.legalMoves[agent.selectMove(game.legalMoves, game.currentPlayer)];

    // **同点の手は、engine が選んだものに合わせて進める。**
    // 探索の値が完全に同じ手が複数ある局面では、どれを選ぶかは同点崩しの
    // 順序だけで決まる。engine は float32、JS は Float64 で累算するため
    // （ADR-0016 の高速化）、**同点のときだけ順序が割れる**。どちらを選んでも
    // 価値は同じなので不一致とは見なさないが、**ここで engine の手に
    // 揃えないと以降の盤面が全部ずれる**ので合わせて進める。
    const expected = trace.events[seen.length];
    if (expected && expected.type === 'move' && expected.notation !== move.toString()
        && expected.equal_notations?.includes(move.toString())) {
      const forced = game.legalMoves.find((m) => m.toString() === expected.notation);
      if (forced) { move = forced; tiesAccepted += 1; }
    }

    const player = game.currentPlayer;
    const roll = [game.roll.die1, game.roll.die2];
    game.applyMove(game.legalMoves.indexOf(move));
    logRead = game.log.length;
    seen.push({
      type: 'move', player, roll, notation: move.toString(), board: boardToJson(game.board),
    });
  }
  drainSkips();

  if (game.state !== GAME_OVER) throw new Error(`trace ${index}: 決着しなかった`);

  const want = trace.events;
  const total = Math.max(seen.length, want.length);
  for (let i = 0; i < total; i += 1) {
    checked += 1;
    const got = seen[i];
    const exp = want[i];
    if (same(got, exp)) continue;
    mismatch += 1;
    if (details.length < 3) {
      details.push(
        `  trace ${index}（${trace.search_plies}-ply）の ${i} 番目:\n` +
        `    JS     = ${JSON.stringify(got)}\n` +
        `    engine = ${JSON.stringify(exp)}`,
      );
    }
  }

  const gotResult = { winner: game.result.winner, win_type: game.result.winType };
  const wantResult = { winner: trace.result.winner, win_type: trace.result.win_type };
  checked += 1;
  if (!same(gotResult, wantResult)) {
    mismatch += 1;
    details.push(`  trace ${index} の結果: JS=${JSON.stringify(gotResult)} engine=${JSON.stringify(wantResult)}`);
  }

  if (cursor !== trace.die_values.length) {
    mismatch += 1;
    details.push(`  trace ${index} の出目の消費数: JS=${cursor} engine=${trace.die_values.length}`);
  }
}

const plies = traces.map((t) => `${t.search_plies}-ply ${t.events.length} イベント`).join(' / ');
console.log(`1局まるごと: ${traces.length} 局（${plies}）中 ${checked} 件一致 / 不一致 ${mismatch}`
  + (tiesAccepted ? ` / 同点で engine に合わせた手 ${tiesAccepted}` : ''));
details.forEach((line) => console.log(line));
process.exit(mismatch ? 1 : 0);
