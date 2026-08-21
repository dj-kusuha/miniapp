// 着手の選択。backgammon_engine の `backgammon/agent.py` の移植。
//
// **equity（1 局あたりの期待得点）が最大の手を選ぶ。** 勝率ではないのは、
// ギャモンの有無で 1 局の価値が最大 3 倍変わるため。
//
// 着手後の局面（afterstate）の手番は相手に移っているので、**相手視点の
// equity を求めて符号を反転**すると「自分の equity」になる。

import { WHITE, opponent, encodeBoard } from './board.js';
import { equity, WIN } from './nn.js';
import { generateMoves, diceValues } from './rules.js';

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

/** 「キューブを自分が持っている」ことの価値。engine と同じく 0（実測で改善せず）。 */
export const DEFAULT_CUBE_OWNERSHIP = 0.0;

export class Agent {
  /**
   * @param {NeuralNet} net
   * @param {number} searchPlies 先読みの深さ
   * @param {Array<{candidates: number, tolerance: number}>} filters 段ごとの絞り込み
   */
  constructor(net, searchPlies = 0, filters = DEFAULT_FILTERS, {
    doublePoint = DEFAULT_DOUBLE_POINT,
    cubeOwnership = DEFAULT_CUBE_OWNERSHIP,
  } = {}) {
    this.net = net;
    this.searchPlies = searchPlies;
    this.filters = filters;
    this.doublePoint = doublePoint;
    this.cubeOwnership = cubeOwnership;
  }

  /**
   * 1 局面ぶんの確率ベクトル（**White 視点**の 5 要素）。
   *
   * ジャコビー equity は `2·P(win) - 1` で、**equity からは勝率を逆算できない**
   * ため、生の出力が要る。
   */
  probabilitiesFor(board, turn) {
    return this.net.predict(encodeBoard(board, WHITE, turn));
  }

  /**
   * ジャコビールール下の equity（**キューブがまだ回されていない**局面用）。
   *
   * ギャモンが数えられないので `2·P(win) - 1`。
   * **マネーゲーム専用**で、マッチプレイには無い。
   */
  jacobyEquityFor(board, turn, player) {
    const whiteView = 2 * this.probabilitiesFor(board, turn)[WIN] - 1;
    return player === WHITE ? whiteView : -whiteView;
  }

  /** `player` 視点の cubeless equity（0-ply）。 */
  equityFor(board, turn, player) {
    const mover = this.equitiesFor([board], turn)[0];
    return player === turn ? mover : -mover;
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
   * ダブルを提案すべきか。
   *
   * **キューブ判断は 0-ply。** engine 側は `cube_plies`（既定は着手と同じ深さ）
   * で読むが、**実測では 0-ply の方が良かった**（1,200 局面で 11.2 対 12.6 mEMG。
   * backgammon_engine の docs/adr/0017-cube-measurement.md）。
   * 深く読む版が要るなら、確率ベクトルを伝播する探索（engine の
   * `search_vector`）の移植が要る。
   */
  shouldDouble(game) {
    if (!game.canDouble()) return false;
    const proposer = game.currentPlayer;

    // ジャコビー: キューブが回されるまでギャモンは 1 点なので、判断に使う
    // equity からギャモンぶんを外す
    const jacobyNow = game.jacoby && game.cube.untouched;
    const value = jacobyNow
      ? this.jacobyEquityFor(game.board, proposer, proposer)
      : this.equityFor(game.board, proposer, proposer);

    if (value < this.doublePoint) return false;

    // too good to double: 相手がドロップするなら +1 で終わってしまう。
    // **ジャコビー下の未ダブル局では成立しない**（打ち続けてもギャモンが
    // 数えられないので「ダブルせずギャモンを狙う」に意味が無い）。
    if (!jacobyNow && !this.wouldTake(-value) && value > 1) return false;

    return true;
  }

  /** 相手のダブルを受けるか（テイク = true / ドロップ = false）。 */
  shouldAcceptDouble(game) {
    const proposer = game.doublingProposer;
    const taker = opponent(proposer);
    // **テイクを検討する時点でキューブは回る**ので、ジャコビーでも
    // ギャモンは数えられる。通常の equity でよい。
    return this.wouldTake(this.equityFor(game.board, proposer, taker));
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

  /**
   * 合法手の中から equity が最良のものを選び、その index を返す。
   * @param {Move[]} legalMoves
   */
  selectMove(legalMoves, player) {
    if (legalMoves.length === 1) return 0;
    const boards = legalMoves.map((m) => m.resultingBoard);
    const values = this.equitiesFor(boards, opponent(player)).map((v) => -v);

    if (this.searchPlies < 2) {
      let best = 0;
      for (let i = 1; i < values.length; i += 1) if (values[i] > values[best]) best = i;
      return best;
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
