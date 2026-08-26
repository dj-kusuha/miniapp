// 着手の選択。backgammon_engine の `backgammon/agent.py` の移植。
//
// **equity（1 局あたりの期待得点）が最大の手を選ぶ。** 勝率ではないのは、
// ギャモンの有無で 1 局の価値が最大 3 倍変わるため。
//
// 着手後の局面（afterstate）の手番は相手に移っているので、**相手視点の
// equity を求めて符号を反転**すると「自分の equity」になる。

import { WHITE, opponent, encodeBoard } from './board.js';
import {
  equity,
  flipPerspective,
  winLossMagnitudes,
  WIN,
  WIN_GAMMON,
  WIN_BACKGAMMON,
  LOSE_GAMMON,
  LOSE_BACKGAMMON,
} from './nn.js';
import { matchWinChance, mwcWithCube, outcomeSpread, redoubleGain } from './met.js';
import { generateMoves, diceValues, boardKey } from './rules.js';

/** 出目 21 通りと、それぞれの確率（engine の `ALL_ROLLS` と同じ）。 */
export const ALL_ROLLS = (() => {
  const rolls = [];
  for (let a = 1; a <= 6; a += 1) {
    for (let b = a; b <= 6; b += 1) {
      rolls.push({ die1: a, die2: b, weight: a === b ? 1 / 36 : 2 / 36 });
    }
  }
  return rolls;
})();

/** 深い段ほどきつく絞る（engine の DEFAULT_SEARCH_FILTERS と同じ）。 */
export const DEFAULT_FILTERS = [
  { candidates: 8, tolerance: 0.160 },   // 段 0（根）
  { candidates: 3, tolerance: 0.080 },   // 段 1 以降
];

/**
 * 3-ply を軽くする構成。**相手の応手を 2 手に絞る。**
 *
 * engine 側の実測（1,500 局面・3-ply・シード対応）で、現行との差は
 * 誤差の内に収まりつつ **1.30 倍**速い。深い段は期待値の推定に寄与する
 * だけで、1 手の違いが結果に効きにくいため
 * （docs/adr/0016-faster-3ply-search.md）。
 *
 * **既定にはしない。** engine の既定と食い違わせないため、
 * これを使うかはアプリ側が選ぶ。
 */
export const FAST_FILTERS = [
  { candidates: 8, tolerance: 0.160 },   // 段 0（根）はそのまま
  { candidates: 2, tolerance: 0.080 },   // 段 1 以降を 2 手に
];

/**
 * その深さで使う絞り方を返す。**アプリと Worker とテストで 1 か所を見る。**
 *
 * 3-ply だけ `FAST_FILTERS`。2-ply では段 1 のフィルタに到達しないので
 * 変えても意味が無く、0-ply はそもそも探索しない。
 */
export function filtersFor(plies) {
  return plies >= 3 ? FAST_FILTERS : DEFAULT_FILTERS;
}

/**
 * ダブルを提案する最低 equity。engine の `DEFAULT_DOUBLE_POINT` と同じ値。
 *
 * キューブ・ベンチマーク 1,200 局面で振って 0.45〜0.46 に底があった
 * （backgammon_engine の docs/adr/0017-cube-measurement.md）。
 * **engine 側と必ず揃えること。**
 */
export const DEFAULT_DOUBLE_POINT = 0.45;

/**
 * 「キューブを自分が持っている」ことの価値（キューブ 1 単位あたり）。
 * **Janowski の x=0.60 に相当する理論値。engine 側と必ず揃えること。**
 *
 * 長らく 0（死んだキューブの仮定）だった。理論上は正のはずなのに実測で
 * 改善せず、2026-08-21 の測定では 0.145 で悪化していた。原因は評価器の誤差が
 * 調整幅より大きかったこと。モデルの精度が上がって equity の絶対誤差が
 * 0.087 → 0.060 になった 2026-08-23 に測り直したところ、テイク判断の損失が
 * 26.0 → 17.5 mEMG（-33%）に改善した。3 つのベンチマークすべてで最小。
 * （backgammon_engine の docs/adr/0017-cube-measurement.md）
 */
export const DEFAULT_CUBE_OWNERSHIP = 0.130;

/**
 * Janowski の cube efficiency（cubeModel === 'janowski' のときだけ効く）。
 * **engine 側と必ず揃えること。**
 *
 * **0.92 は cube efficiency の理論値ではない**（gnubg は 0.6〜0.7）。
 * engine の 32,400 局面の測定では 0.60 以降ずっと単調に下がり続けて 0.91 で底を
 * 打つ。これは「x を上げると良くなる」＝「テイクし足りない」という意味で、
 * **うちの勝率の過小評価（P(win) の平均のずれ -0.0059）を吸収した補正項**に
 * なっている。モデルの較正が改善したら測り直すこと。
 * （backgammon_engine の docs/adr/0017-cube-measurement.md）
 */
export const DEFAULT_CUBE_EFFICIENCY = 0.92;

/**
 * キューブ判断の方式。
 *
 *   'constant' : 2E + c >= -1                     （c は固定）
 *   'janowski' : p >= (L - 0.5) / (W + L + 0.5x)   （W / L は局面ごと）
 *
 * engine の 32,400 局面では定数をどう最適化しても 16.28 mEMG が限界なのに対し
 * Janowski は 14.91。ギャモンが濃い局面ほど差が開く（-3.3）。
 */
export const DEFAULT_CUBE_MODEL = 'janowski';

// ── 弱い相手の作り方 ──────────────────────────────
//
// **先読み 0 が床なので、それより弱くするには別の軸が要る。**
// 採ったのは gnubg が Beginner / Casual を作るのと同じ「評価値にノイズを乗せる」
// 方式。equity に平均 0・標準偏差 `noise` のノイズを足してから最大を選ぶ。
//
// **なぜこれが人間らしいか**: 間違える確率が「判断の難しさ」に自動で連動する。
// equity 差 0.3 の明らかな手はノイズ 0.05 ではまず逆転せず、差 0.02 の際どい手は
// しょっちゅう逆転する。弱い人が「簡単な手は外さず、際どい判断だけ落とす」のと
// 同じ形になる。
//
// **採らなかった案**:
//
// | やり方 | 何が起きるか |
// | --- | --- |
// | ランダムに選ぶ | equity 差を見ていないので、明らかな悪手を平気で打つ |
// | 上位 k 手から等確率 | 差の大きさを見ていない。まともな手が 2 つしかない局面で破綻 |
// | X% の確率でランダム手 | **間違いが難易度と無相関**になる。ふだん完璧で突然おかしい＝人間味の逆 |
//
// ノイズは正規分布なので裾が無限に伸びる。そこで **`maxLoss`（最善からの
// equity 差の上限）で足切りしてから**ノイズを掛ける。「よく間違えるが、
// 絶対にアホなことはしない」の 2 つのつまみ。

/**
 * 盤面から決定的にノイズを作る（32bit FNV-1a + 撹拌）。
 *
 * **毎回乱数を引いてはいけない。** 1 手戻してやり直すと AI の手が変わり、
 * 同じ局面で違う手を打つのが露骨に見える。局面を鍵にすれば、同じ局面は
 * 何度でも同じ読み違えをする。
 */
function hash32(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** 標準正規分布の値を 1 つ、鍵から決定的に作る（Box-Muller）。 */
export function gaussianFor(key) {
  // log(0) を避けるため u1 は 0 を取らないようにずらす
  const u1 = (hash32(key, 0x811c9dc5) + 1) / 4294967297;
  const u2 = hash32(key, 0x01000193) / 4294967296;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * 強さの段。**着手・キューブ・Worker が同じ表を見る。**
 *
 * `plies` だけで Agent を作り分けると、**先読み 0 の段が 3 つあるせいで
 * 弱い段が黙って上級のまま**になる（Worker は plies を鍵に使い回していた）。
 * Agent を作る入口は `agentFor()` 1 つに統一すること。
 *
 * `noise` / `maxLoss` は equity（1 局あたりの期待得点）の単位。
 *
 * **σ は勘で置かない。** `tools/measure-level.mjs` で自己対局の棋譜を gnubg に
 * 採点させ、技量帯に合わせて選んである（30 局・約 1,700 手ずつ。3-ply だけ
 * 24 局・1,136 手 / 2026-08-22）。
 *
 * **小さい標本では帯をまたぐ。** 3-ply を 8 局で測ったときは 5.7（Expert）
 * だったが、24 局で測り直すと 4.1（World class）になった。
 */
//
// | 設定 | 実測 ER | gnubg のラベル（W / B） | 採否 |
// | --- | --- | --- | --- |
// | σ=0.30 / cap 0.3 | 75.5 | Awful! / Awful! | |
// | σ=0.20 / cap 0.3 | 62.1 | Awful! / Awful! | |
// | σ=0.12 / cap 0.4 | 42.9 | Awful! / Awful! | |
// | **σ=0.07 / cap 0.5** | **29.2** | Beginner / Beginner | **初心者** |
// | **σ=0.04 / cap 0.5** | **20.6** | Casual / Casual | **カジュアル** |
// | **0-ply** | **12.8** | Advanced / Intermediate | **中級** |
// | **2-ply** | **8.3** | Advanced / Expert | **上級** |
// | **3-ply** | **4.1** | World class / World class | **エキスパート** |
//
// **最初に当てで置いた σ=0.16 は ER 50 超（Awful!）だった。** 0.12 より下は
// 「読み違えが多い人」ではなく「でたらめ」に見え始めるので採らない。
//
// 名前は gnubg の技量帯から借りた**目安**。「よわい」「つよい」のような主観語を
// 避けたかったのと、σ を決めた根拠と同じ言葉にしておくと後から追いやすいため。
// **ぴったり一致させることは狙っていない**（0-ply と 2-ply は W と B で別の
// ラベルが付いており、そもそも境界をまたいでいる）。
export const LEVELS = [
  {
    id: 'beginner', name: '初心者', plies: 0, noise: 0.07, maxLoss: 0.50,
    note: '読み違えが多め',
  },
  {
    id: 'casual', name: 'カジュアル', plies: 0, noise: 0.04, maxLoss: 0.50,
    note: 'ときどき読み違える',
  },
  {
    id: 'intermediate', name: '中級', plies: 0, noise: 0, maxLoss: Infinity,
    note: '先読みなし・読み違え無し',
  },
  {
    id: 'advanced', name: '上級', plies: 2, noise: 0, maxLoss: Infinity,
    note: '2 手先読み',
  },
  {
    id: 'expert', name: 'エキスパート', plies: 3, noise: 0, maxLoss: Infinity,
    note: '3 手先読み・1 手に数秒かかる',
  },
];

/** 既定の段（設定画面の初期選択）。 */
export const DEFAULT_LEVEL = 'intermediate';

/**
 * ヒントを出すときの段。**対戦相手の段とは無関係に固定する。**
 *
 * 初心者と対局していても、助言は良いものであってほしい。
 * **読み違えの無い段**であることが必須（ノイズの乗った助言は助言ではない）。
 *
 * **上級（2-ply）にしている。** エキスパート（3-ply）も試したが 1 手 1〜3 秒
 * かかって待たされ過ぎた（2-ply は実測 14〜53ms で押した瞬間に出る）。
 *
 * **ここを `'expert'` に変えるだけで 3-ply に戻せる。** ヒントは着手と同じく
 * Web Worker 経由で、計算中は「考えています…」を出す作りのままにしてあるので、
 * 遅い段にしても画面は固まらない。
 */
export const ADVICE_LEVEL = 'advanced';

export function levelById(id) {
  return LEVELS.find((l) => l.id === id) ?? LEVELS.find((l) => l.id === DEFAULT_LEVEL);
}

/**
 * 段から Agent を作る。**アプリ・Worker・テストはここだけを通すこと。**
 */
export function agentFor(net, levelId) {
  const level = levelById(levelId);
  return new Agent(net, level.plies, filtersFor(level.plies), {
    noise: level.noise,
    maxLoss: level.maxLoss,
  });
}

export class Agent {
  /**
   * @param {NeuralNet} net
   * @param {number} searchPlies 先読みの深さ
   * @param {Array<{candidates: number, tolerance: number}>} filters 段ごとの絞り込み
   */
  constructor(net, searchPlies = 0, filters = DEFAULT_FILTERS, {
    doublePoint = DEFAULT_DOUBLE_POINT,
    cubeOwnership = DEFAULT_CUBE_OWNERSHIP,
    cubeEfficiency = DEFAULT_CUBE_EFFICIENCY,
    cubeModel = DEFAULT_CUBE_MODEL,
    cubePlies = null,
    noise = 0,
    maxLoss = Infinity,
  } = {}) {
    this.net = net;
    this.searchPlies = searchPlies;
    this.filters = filters;
    this.doublePoint = doublePoint;
    this.cubeOwnership = cubeOwnership;
    this.cubeEfficiency = cubeEfficiency;
    this.cubeModel = cubeModel;
    this.cubePlies = cubePlies ?? Math.min(searchPlies, 2);
    this.noise = noise;
    this.maxLoss = maxLoss;
  }

  /**
   * この局面をどれだけ読み違えるか（equity 単位）。強い段では常に 0。
   *
   * **キューブの判断にも同じ値を掛ける。** 着手だけ弱くすると「手はヘボいのに
   * ダブルは完璧」という妙な相手になる。
   */
  noiseFor(board) {
    if (this.noise <= 0) return 0;
    return this.noise * gaussianFor(boardKey(board));
  }

  /**
   * 1 局面ぶんの確率ベクトル（**White 視点**の 5 要素）。
   *
   * ジャコビー equity は `2·P(win) - 1` で、**equity からは勝率を逆算できない**
   * ため、生の出力が要る。
   */
  probabilitiesFor(board, turn) {
    const probs = this.net.predict(encodeBoard(board, WHITE, turn));
    const noise = this.noiseFor(board);
    if (noise === 0) return probs;
    // **確率の側でも同じだけ読み違える。** equity ≒ 2·P(win) − 1 なので、
    // equity 単位のノイズは P(win) では半分。
    //
    // ここでずらすのは P(win) だけ。ギャモンの累積が P(win) を超え得るが、
    // **`met.js` の `outcomeSpread()` が包含関係を押さえ直す**ので、負の確率は
    // 出ない（元の出力も独立なシグモイドなので同じ問題を持っており、
    // その対策がそのまま効く）。
    const w = Math.min(0.999, Math.max(0.001, probs[WIN] + noise / 2));
    const out = [...probs];
    out[WIN] = w;
    return out;
  }

  /**
   * ジャコビールール下の equity（**キューブがまだ回されていない**局面用）。
   *
   * ギャモンが数えられないので `2·P(win) - 1`。**equity ではなく確率
   * ベクトルを伝播する必要がある**ため、`searchedVectorFor` を使う。
   * **マネーゲーム専用**で、マッチプレイには無い。
   *
   * @param {Board} board
   * @param {string} turn
   * @param {string} player
   * @param {?number} plies 省略時は this.cubePlies
   */
  jacobyEquityFor(board, turn, player, plies = null) {
    const depth = plies ?? this.cubePlies;
    const vector = depth < 1
      ? this.probabilitiesFor(board, turn)
      : this.expandRollsVector(board, turn, depth, 0);
    const whiteView = 2 * vector[WIN] - 1;
    return player === WHITE ? whiteView : -whiteView;
  }

  /**
   * `player` 視点の cubeless equity（0-ply）。
   *
   * **キューブ判断でしか使わない**ので、ここでノイズを乗せる（着手側は
   * `selectMove` が足切りと一緒に掛ける）。
   */
  equityFor(board, turn, player) {
    const mover = this.equitiesFor([board], turn)[0] + this.noiseFor(board);
    return player === turn ? mover : -mover;
  }

  /**
   * `plies` 段ぶんダイスを展開した cubeless equity（キューブ判断用）。
   *
   * @param {Board} board
   * @param {string} turn
   * @param {string} player
   * @param {?number} plies 省略時は this.cubePlies
   */
  searchedEquityFor(board, turn, player, plies = null) {
    const depth = plies ?? this.cubePlies;
    if (depth < 1) {
      return this.equityFor(board, turn, player);
    }
    return this.expandRolls(board, turn, player, depth, 0);
  }

  /**
   * `searchedEquityFor` の確率ベクトル版（`player` 視点）。
   *
   * @param {Board} board
   * @param {string} turn
   * @param {string} player
   * @param {?number} plies 省略時は this.cubePlies
   */
  searchedVectorFor(board, turn, player, plies = null) {
    const depth = plies ?? this.cubePlies;
    const vector = depth < 1
      ? this.probabilitiesFor(board, turn)
      : this.expandRollsVector(board, turn, depth, 0);
    return player === WHITE ? vector : flipPerspective(vector);
  }

  /**
   * その equity でテイクするのが正しいか（engine の `would_take` と同じ式）。
   *
   *   ドロップ → 確定で -1
   *   テイク   → 以後キューブ 2 倍で続くので 2·E、さらに所有価値が乗る
   */
  wouldTake(equityForTaker) {
    return 2 * equityForTaker + this.cubeOwnership >= -1;
  }

  /**
   * Janowski のテイクポイントで判断する（engine の would_take_janowski）。
   *
   *   テイク ⟺ p >= (L - 0.5) / (W + L + 0.5x)
   *
   * W（勝ったときの平均得点）と L（負けたときの平均失点）を**局面ごとに**
   * 出すので、**ギャモン負けが多い局面では自動的にテイクポイントが上がる**。
   * 定数 cubeOwnership は x·TP に相当するが、TP が W / L に依存する
   * ため定数 1 個では表せない。
   *
   * @param {number[]} outputs **テイクする側から見た** 5 要素の確率ベクトル
   */
  wouldTakeJanowski(outputs) {
    const { p, win, lose } = winLossMagnitudes(outputs);
    const denominator = win + lose + 0.5 * this.cubeEfficiency;
    if (denominator <= 1e-9) return false;
    return p >= (lose - 0.5) / denominator;
  }

  /**
   * テイクする側から見た確率ベクトル。
   */
  takerProbabilities(board, proposer) {
    return this.searchedVectorFor(board, proposer, opponent(proposer));
  }

  /** 提案された側がテイクするか（too good to double の判定用）。 */
  opponentWouldTake(board, proposer) {
    const taker = opponent(proposer);
    if (this.cubeModel === 'janowski') {
      return this.wouldTakeJanowski(this.searchedVectorFor(board, proposer, taker));
    }
    return this.wouldTake(this.searchedEquityFor(board, proposer, taker));
  }

  /**
   * マッチでのキューブ判断に使う 3 つのマッチ勝率（**提案者から見た値**）。
   *
   * マネーゲームの equity（1 局あたりの期待得点）はマッチでは使えない。
   * **同じ 1 点でも、スコアによって価値が違う**（マッチポイントの 1 点と
   * 0-0 の 1 点は別物）。MET を通して**マッチに勝つ確率**へ換算する。
   *
   * @param {object} match `Match.cubeContext()` が返す文脈
   * @returns {{noDouble: number, take: number, pass: number}}
   */
  matchCubeEquities(board, proposer, cubeValue, match) {
    const spread = outcomeSpread(this.probabilitiesFor(board, proposer), proposer === WHITE);
    const awayUs = match.away[proposer];
    const awayThem = match.away[opponent(proposer)];
    const played = match.crawfordPlayed;
    const nextCube = cubeValue * 2;

    const noDouble = mwcWithCube(spread, cubeValue, awayUs, awayThem, played);
    let take = mwcWithCube(spread, nextCube, awayUs, awayThem, played);

    // 相手がキューブを持つことによるリダブル脅威（MET から厳密に算出）
    const gain = redoubleGain(awayUs, awayThem, nextCube, played);
    if (gain > 0) {
      take -= gain * 0.12;
    }

    return {
      noDouble,
      take,
      // ドロップされたら、いまのキューブの値ぶんを取って局が終わる
      pass: matchWinChance(awayUs - cubeValue, awayThem, played),
    };
  }

  /**
   * ダブルを提案すべきか。
   *
   * @param {Game} game
   * @param {?object} match `Match.cubeContext()`。**アンリミテッドでは null**
   *   で、その場合は従来どおり equity の閾値で決める。
   */
  shouldDouble(game, match = null) {
    if (!game.canDouble()) return false;
    const proposer = game.currentPlayer;

    if (match) {
      const e = this.matchCubeEquities(game.board, proposer, game.cube.value, match);
      // 相手のテイク / パスはこちらが選べない。相手は自分に有利な方を選ぶ。
      //
      // **センターキューブ保持のオプション価値（先送りマージン）**:
      // センターキューブを持っている間は「後からもっと有利になってからダブルする権利」があるため、
      // 単なる静的 MWC よりもノーダブルの価値が高い（XG のノーダブル > ダブル/テイクと同じ原理）。
      const opponentTakes = e.take <= e.pass;
      const holdMargin = (opponentTakes && game.cube.value === 1) ? 0.020 : 0.0;
      return Math.min(e.take, e.pass) > (e.noDouble + holdMargin);
    }

    // ジャコビー: キューブが回されるまでギャモンは 1 点なので、判断に使う
    // equity からギャモンぶんを外す
    const jacobyNow = game.jacoby && game.cube.untouched;
    const value = jacobyNow
      ? this.jacobyEquityFor(game.board, proposer, proposer)
      : this.searchedEquityFor(game.board, proposer, proposer);

    if (value < this.doublePoint) return false;

    // too good to double: 相手がドロップするなら +1 で終わってしまう。
    // **ジャコビー下の未ダブル局では成立しない**（打ち続けてもギャモンが
    // 数えられないので「ダブルせずギャモンを狙う」に意味が無い）。
    if (!jacobyNow && value > 1
        && !this.opponentWouldTake(game.board, proposer)) return false;

    return true;
  }

  /** 相手のダブルを受けるか（テイク = true / ドロップ = false）。 */
  shouldAcceptDouble(game, match = null) {
    const proposer = game.doublingProposer;
    const taker = opponent(proposer);

    if (match) {
      // 提案者視点の値をそのまま使う。MET は対称（`MWC(a,b) + MWC(b,a) = 1`）
      // なので、**提案者のマッチ勝率が低い方**がテイク側にとって良い方。
      const e = this.matchCubeEquities(game.board, proposer, game.cube.value, match);
      return e.take < e.pass;
    }

    // **テイクを検討する時点でキューブは回る**ので、ジャコビーでも
    // ギャモンは数えられる。通常の equity でよい。
    if (this.cubeModel === 'janowski') {
      return this.wouldTakeJanowski(this.searchedVectorFor(game.board, proposer, taker));
    }
    return this.wouldTake(this.searchedEquityFor(game.board, proposer, taker));
  }

  /**
   * 候補手を強い順に並べる。**ヒント表示用**で、対局の着手選択には使わない。
   *
   * 並べ替えは `selectMove` と同じ基準（`searchPlies` の深さ）。**2-ply 以上では
   * 絞り込み（shortlist）に残った手だけを深く読む**ので、返すのはその中の上位。
   * 絞り落とされた手は 0-ply の時点で明らかに劣っているものなので、ヒントとして
   * 出す価値がない。
   *
   * `probabilities` は**着手後の局面を 0-ply で評価した**確率
   * （手番は相手に移っている）。探索は equity しか返さないため、深く読んだ
   * 結果ではない。**順位と確率で深さが違う**ことに注意。
   *
   * @returns {{move, index, equity, loss, probabilities}[]} loss は最善との差
   */
  rankMoves(legalMoves, player, limit = 3) {
    const boards = legalMoves.map((m) => m.resultingBoard);
    const shallow = this.equitiesFor(boards, opponent(player)).map((v) => -v);
    const picks = this.searchPlies >= 2
      ? this.shortlist(boards, player)
      : shallow.map((_, i) => i);

    const scored = picks.map((i) => ({
      index: i,
      equity: this.searchPlies >= 2
        ? this.expandRolls(boards[i], opponent(player), player, this.searchPlies - 1, 1)
        : shallow[i],
    }));
    scored.sort((a, b) => b.equity - a.equity);

    const best = scored.length ? scored[0].equity : 0;
    return scored.slice(0, limit).map(({ index, equity: value }) => ({
      move: legalMoves[index],
      index,
      equity: value,
      loss: best - value,
      probabilities: outcomeSpread(
        this.probabilitiesFor(boards[index], opponent(player)), player === WHITE),
    }));
  }

  /** 各盤面の **turn（手番側）から見た** equity。 */
  equitiesFor(boards, turn) {
    // perspective='white' のモデルなので White 視点で評価して符号を合わせる
    const sign = turn === WHITE ? 1 : -1;
    return boards.map((b) => sign * equity(this.net.predict(encodeBoard(b, WHITE, turn))));
  }

  /** 決着済みなら viewer 視点の確定 equity、まだなら null。 */
  terminalEquity(board, viewer) {
    for (const player of [WHITE, opponent(WHITE)]) {
      if (board.hasWon(player)) {
        const points = board.winType(opponent(player));
        return player === viewer ? points : -points;
      }
    }
    return null;
  }

  filterFor(level) {
    return this.filters[Math.min(level, this.filters.length - 1)];
  }

  /** `toMove` から見て強い順に並べ、深く読む手の index を返す。 */
  shortlist(boards, toMove, level = 0) {
    const filter = this.filterFor(level);
    const own = this.equitiesFor(boards, opponent(toMove)).map((v) => -v);
    const order = own.map((v, i) => i).sort((a, b) => own[b] - own[a])
      .slice(0, filter.candidates);
    if (filter.tolerance > 0) {
      const best = own[order[0]];
      return order.filter((i) => own[i] >= best - filter.tolerance);
    }
    return order;
  }

  /**
   * 出目 21 通りを展開し、最善を尽くしたときの viewer 視点 equity。
   * 最深段（残り 1 段）専用。応手は 0-ply で選ぶ。
   */
  expectedEquityAfterMove(board, toMove, viewer) {
    let total = 0;
    for (const { die1, die2, weight } of ALL_ROLLS) {
      const moves = generateMoves(board, toMove, die1, die2);
      let boards;
      if (moves.length === 0) {
        boards = [board];                       // 動かせなければ手番が移るだけ
      } else {
        boards = moves.map((m) => m.resultingBoard);
      }
      const values = this.equitiesFor(boards, opponent(toMove))
        .map((v, i) => {
          const terminal = this.terminalEquity(boards[i], viewer);
          if (terminal !== null) return terminal;
          return opponent(toMove) === viewer ? v : -v;
        });
      total += weight * (toMove === viewer ? Math.max(...values) : Math.min(...values));
    }
    return total;
  }

  /** `board`（`toMove` の手番）を depth 段ぶん展開し、viewer 視点の equity を返す。 */
  expandRolls(board, toMove, viewer, depth, level) {
    const terminal = this.terminalEquity(board, viewer);
    if (terminal !== null) return terminal;
    if (depth <= 0) {
      const v = this.equitiesFor([board], toMove)[0];
      return toMove === viewer ? v : -v;
    }
    if (depth === 1) return this.expectedEquityAfterMove(board, toMove, viewer);

    let total = 0;
    for (const { die1, die2, weight } of ALL_ROLLS) {
      const moves = generateMoves(board, toMove, die1, die2);
      if (moves.length === 0) {
        total += weight * this.expandRolls(board, opponent(toMove), viewer, depth - 1, level + 1);
        continue;
      }
      const boards = moves.map((m) => m.resultingBoard);
      const picks = this.shortlist(boards, toMove, level);
      const values = picks.map((i) =>
        this.expandRolls(boards[i], opponent(toMove), viewer, depth - 1, level + 1));
      total += weight * (toMove === viewer ? Math.max(...values) : Math.min(...values));
    }
    return total;
  }

  /** 決着済みなら White 視点の確定ベクトル、まだなら null。 */
  terminalVector(board) {
    for (const player of [WHITE, opponent(WHITE)]) {
      if (board.hasWon(player)) {
        const winType = board.winType(opponent(player));
        const target = [0, 0, 0, 0, 0];
        if (player === WHITE) {
          target[WIN] = 1.0;
          if (winType >= 2) target[WIN_GAMMON] = 1.0;
          if (winType >= 3) target[WIN_BACKGAMMON] = 1.0;
        } else {
          if (winType >= 2) target[LOSE_GAMMON] = 1.0;
          if (winType >= 3) target[LOSE_BACKGAMMON] = 1.0;
        }
        return target;
      }
    }
    return null;
  }

  /** `toMove` にとって最良のベクトルの index。 */
  pickOwnBest(vectors, toMove) {
    let bestIndex = 0;
    let bestEquity = equity(vectors[0]);
    if (toMove === WHITE) {
      for (let i = 1; i < vectors.length; i += 1) {
        const val = equity(vectors[i]);
        if (val > bestEquity) {
          bestEquity = val;
          bestIndex = i;
        }
      }
    } else {
      for (let i = 1; i < vectors.length; i += 1) {
        const val = equity(vectors[i]);
        if (val < bestEquity) {
          bestEquity = val;
          bestIndex = i;
        }
      }
    }
    return bestIndex;
  }

  /**
   * 出目 21 通りを展開し、最善を尽くしたときの White 視点ベクトル。
   * 最深段（残り 1 段）専用。応手は 0-ply で選ぶ。
   */
  expectedVectorAfterMove(board, toMove) {
    const total = [0, 0, 0, 0, 0];
    for (const { die1, die2, weight } of ALL_ROLLS) {
      const moves = generateMoves(board, toMove, die1, die2);
      let boards;
      if (moves.length === 0) {
        boards = [board];                       // 動かせなければ手番が移るだけ
      } else {
        boards = moves.map((m) => m.resultingBoard);
      }
      const vectors = boards.map((b) => {
        const terminal = this.terminalVector(b);
        if (terminal !== null) return terminal;
        return this.net.predict(encodeBoard(b, WHITE, opponent(toMove)));
      });
      const bestIdx = this.pickOwnBest(vectors, toMove);
      const bestVec = vectors[bestIdx];
      for (let k = 0; k < 5; k += 1) {
        total[k] += weight * bestVec[k];
      }
    }
    return total;
  }

  /**
   * `board`（`toMove` の手番）を depth 段ぶん展開し、White 視点の確率ベクトルを返す。
   * 絞り込みはスカラー側と同じ `shortlist` を使う。
   */
  expandRollsVector(board, toMove, depth, level) {
    const terminal = this.terminalVector(board);
    if (terminal !== null) return terminal;
    if (depth <= 0) {
      return this.net.predict(encodeBoard(board, WHITE, toMove));
    }
    if (depth === 1) return this.expectedVectorAfterMove(board, toMove);

    const total = [0, 0, 0, 0, 0];
    for (const { die1, die2, weight } of ALL_ROLLS) {
      const moves = generateMoves(board, toMove, die1, die2);
      if (moves.length === 0) {
        // 合法手が無ければ手番が相手に移るだけ（1段は消費する）
        const next = this.expandRollsVector(board, opponent(toMove), depth - 1, level + 1);
        for (let k = 0; k < 5; k += 1) {
          total[k] += weight * next[k];
        }
        continue;
      }
      const boards = moves.map((m) => m.resultingBoard);
      const picks = this.shortlist(boards, toMove, level);
      const vectors = picks.map((i) =>
        this.expandRollsVector(boards[i], opponent(toMove), depth - 1, level + 1));
      const bestIdx = this.pickOwnBest(vectors, toMove);
      const bestVec = vectors[bestIdx];
      for (let k = 0; k < 5; k += 1) {
        total[k] += weight * bestVec[k];
      }
    }
    return total;
  }

  /**
   * 合法手の中から equity が最良のものを選び、その index を返す。
   * @param {Move[]} legalMoves
   */
  selectMove(legalMoves, player) {
    if (legalMoves.length === 1) return 0;
    const boards = legalMoves.map((m) => m.resultingBoard);
    const values = this.equitiesFor(boards, opponent(player)).map((v) => -v);

    if (this.searchPlies < 2) {
      if (this.noise <= 0) {
        let best = 0;
        for (let i = 1; i < values.length; i += 1) if (values[i] > values[best]) best = i;
        return best;
      }
      // **足切りしてからノイズ。** 最善から maxLoss 以上劣る手は候補にすら
      // 入れない（ノイズは正規分布で裾が無限に伸びるため、これが無いと
      // ごく稀に「その手はやらんやろ」が出る）。最善手は必ず生き残る。
      const best = Math.max(...values);
      let pick = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < values.length; i += 1) {
        if (values[i] < best - this.maxLoss) continue;
        const score = values[i] + this.noiseFor(boards[i]);
        if (score > bestScore) { bestScore = score; pick = i; }
      }
      return pick;
    }

    const picks = this.shortlist(boards, player);
    let bestIndex = picks[0];
    let bestValue = null;
    for (const i of picks) {
      const value = this.expandRolls(
        boards[i], opponent(player), player, this.searchPlies - 1, 1);
      if (bestValue === null || value > bestValue) {
        bestIndex = i;
        bestValue = value;
      }
    }
    return bestIndex;
  }
}
