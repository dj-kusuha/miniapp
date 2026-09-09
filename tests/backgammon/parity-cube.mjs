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
import {
  DEFAULT_CUBE_MODEL, DEFAULT_CUBE_EFFICIENCY, DEFAULT_MATCH_CUBE_EFFICIENCY,
  FAST_FILTERS,
} from '../../docs/backgammon/src/agent.js';
import { Game, ROLLING } from '../../docs/backgammon/src/game.js';
import { loadBearoffForTests } from './bearoff-setup.mjs';

// **engine は DB を既定で有効にしている。** いまのフィクスチャにベアオフ
// 局面は入っていないが、揃えておかないと**将来入った瞬間に黙って割れる**。
loadBearoffForTests();

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

/** `shouldDoubleSearch` が比べている 2 つ（キューブ探索の生の値）。 */
function cubeSearchValues(agentUsed, c) {
  const game = setup(c);
  const proposer = game.currentPlayer;
  const owner = agentUsed.cubeOwnerKind(game, proposer);
  const jacoby = (agentUsed.jacoby ?? true) && game.jacoby && agentUsed.cubeUntouched(game);
  const depth = agentUsed.cubeSearchDepth;
  return {
    no_double: agentUsed.cubefulSearch(game.board, proposer, owner, depth, jacoby),
    take: 2.0 * agentUsed.cubefulSearch(game.board, proposer, 'opponent', depth, false),
  };
}

// **判断（bool）の突き合わせでは探索の構造のズレが検出できない。**
// engine 側でキューブ木の絞りの段を変えても（`cubeFilterLevel`）60 局面の判断は
// 1 件も変わらず、このテストは素通りした（2026-09-09）。際どいダブル 2,631 局面
// ですら判断が変わるのは 2 件しかない。**生の値を突き合わせること。**
//
// 許容差は float32 のまるめぶんだけ。実測では
//   段が合っている  → 最大 1.4e-07
//   段がズレている  → 最大 3.9e-04
// なので 1e-5 で両者を分けられる。
const VALUE_TOLERANCE = 1e-5;
let valueBad = 0;
let worstValue = 0;

let bad = 0;
let takeChecked = 0;
for (const c of data.positions) {
  const agent = agentFor(c.cube_plies ?? 0);

  // **フィクスチャに値が無ければ落とす。** 「あれば見る」にすると、
  // 作り直しを忘れた瞬間に検査が黙って消える（それが今回の穴だった）。
  if (!c.cube_search) {
    console.log('  cube_search がフィクスチャに無い。'
      + 'engine 側で tools/export_cube_parity.py --refresh を掛けること');
    valueBad += 1;
  } else {
    const got = cubeSearchValues(agent, c);
    for (const key of ['no_double', 'take']) {
      const diff = Math.abs(got[key] - c.cube_search[key]);
      if (diff > worstValue) worstValue = diff;
      if (diff > VALUE_TOLERANCE) {
        valueBad += 1;
        if (valueBad <= 3) {
          console.log(`  値 ${key} cube=${c.cube_value}/${c.cube_owner} `
            + `js=${got[key].toFixed(6)} engine=${c.cube_search[key].toFixed(6)} `
            + `差=${diff.toExponential(2)}`);
        }
      }
    }
  }

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
// **キーごとに対応づける。** 「cube_model 以外はすべて cube_efficiency」と
// 書いていたので、engine が match_cube_efficiency を足しても**マネーの定数と
// 比べて**しまい、マッチ側のズレを検出できなかった。
// 知らないキーが来たら**落とす**（照合したつもりで素通りするのを防ぐ）。
const ENGINE_DEFAULTS = {
  cube_model: DEFAULT_CUBE_MODEL,
  cube_efficiency: DEFAULT_CUBE_EFFICIENCY,
  match_cube_efficiency: DEFAULT_MATCH_CUBE_EFFICIENCY,
};
for (const [key, want] of Object.entries(data.defaults ?? {})) {
  if (!(key in ENGINE_DEFAULTS)) {
    defBad += 1;
    console.log(`  既定 ${key}: js 側に対応する定数が無い（engine=${want}）`);
    continue;
  }
  const got = ENGINE_DEFAULTS[key];
  if (got !== want) {
    defBad += 1;
    console.log(`  既定 ${key}: js=${got} engine=${want}`);
  }
}

// ── 深さ 2 の確率ベクトル ────────────────────────────────────
//
// **マッチのキューブ判断は engine と突き合わせられない**（engine にマッチ対応が
// 無い）。だが MET へ渡す入力は確率ベクトルなので、**そこだけは突き合わせられる。**
// ベクトルが一致していれば、あとは検証済みの MET の計算に渡すだけになる。
let vectorBad = 0;
let vectorMaxDiff = 0;
for (const c of data.searched_vectors ?? []) {
  const agent2 = agentFor(c.cube_plies);
  const board = new Board([...c.points], { WHITE: c.bar[0], BLACK: c.bar[1] },
                          { WHITE: c.off[0], BLACK: c.off[1] });
  const got = agent2.searchedVectorFor(board, c.turn, 'WHITE');
  for (let i = 0; i < c.vector.length; i += 1) {
    const diff = Math.abs(got[i] - c.vector[i]);
    vectorMaxDiff = Math.max(vectorMaxDiff, diff);
    if (diff > 1e-5) {
      vectorBad += 1;
      if (vectorBad <= 3) {
        console.log(`  ベクトル turn=${c.turn} [${i}] `
          + `js=${got[i].toFixed(6)} engine=${c.vector[i].toFixed(6)}`);
      }
    }
  }
}
if (data.searched_vectors) {
  console.log(`  深さ 2 のベクトル: ${data.searched_vectors.length} 件 `
    + `不一致 ${vectorBad} / 最大誤差 ${vectorMaxDiff.toExponential(2)}`);
  bad += vectorBad;
}

// **エキスパート段（`FAST_FILTERS`）でも同じ木を読むこと。**
//
// エキスパートは着手木の応手を 2 手に絞る（3-ply を実用速度にするため）。
// キューブ木がその表を借りると、**エキスパートだけ engine より狭い木**を読む。
// engine と ADR-0038 が測ったのは段 1 = 3 手なので、借りさせない。
//
// 借りていたときの実測: 120 値のうち 1 件が 2.4e-04 ずれた（判断は 60 件とも
// 変わらなかったので、**bool のテストでは絶対に見つからない**）。
let fastBad = 0;
let worstFast = 0;
for (const c of data.positions) {
  if (!c.cube_search) continue;
  const fast = new Agent(net, 0, FAST_FILTERS, { cubePlies: c.cube_plies ?? 0 });
  const got = cubeSearchValues(fast, c);
  for (const key of ['no_double', 'take']) {
    const diff = Math.abs(got[key] - c.cube_search[key]);
    if (diff > worstFast) worstFast = diff;
    if (diff > VALUE_TOLERANCE) {
      fastBad += 1;
      if (fastBad <= 3) {
        console.log(`  エキスパートの値 ${key} cube=${c.cube_value}/${c.cube_owner} `
          + `js=${got[key].toFixed(6)} engine=${c.cube_search[key].toFixed(6)} `
          + `差=${diff.toExponential(2)}（キューブ木が着手木の絞りを借りていないか）`);
      }
    }
  }
}

console.log(`  キューブ探索の値: ${data.positions.length * 2} 件 不一致 ${valueBad}`
  + ` / 最大誤差 ${worstValue.toExponential(2)}`);
console.log(`  エキスパート段（FAST_FILTERS）でも同値: 不一致 ${fastBad}`
  + ` / 最大誤差 ${worstFast.toExponential(2)}`);
console.log(`キューブ判断: ダブル ${data.positions.length} 件 / テイク ${takeChecked} 件 `
  + `中 不一致 ${bad}`);
console.log(`  テイクの境界値: 定数 ${data.take_threshold.length} 件 不一致 ${borderBad}`
  + ` / Janowski ${(data.janowski_threshold ?? []).length} 件 不一致 ${janBad}`);
console.log(`  既定の照合: ${Object.keys(data.defaults ?? {}).length} 件中 不一致 ${defBad}`);
process.exit(bad + borderBad + janBad + defBad + valueBad + fastBad ? 1 : 0);
