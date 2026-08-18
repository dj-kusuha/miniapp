// 盤面と、ニューラルネットへの符号化。
//
// backgammon_engine の `backgammon/board.py` / `features.py` の移植。
//
// **向きに注意。** White は index 23 → 0、Black は 0 → 23 に進む。ホームボードも
// ベアオフ方向もバーからの復帰位置も左右で逆になる。engine の AGENTS.md が
// 「特に間違えやすい点」の筆頭に挙げているところで、**片方のプレイヤーでだけ
// 静かに壊れる**ため、必ず両者で検証すること（test/parity.js）。

export const WHITE = 'WHITE';
export const BLACK = 'BLACK';
export const TOTAL_CHECKERS = 15;

export const opponent = (player) => (player === WHITE ? BLACK : WHITE);

/** `player` の駒が進む向き。White は index を減らし、Black は増やす。 */
export const direction = (player) => (player === WHITE ? -1 : 1);

/** `player` のホームボード（index の配列。ベアオフに近い順ではない）。 */
export const homeRange = (player) =>
  player === WHITE ? [0, 1, 2, 3, 4, 5] : [18, 19, 20, 21, 22, 23];

/** index からベアオフまでの距離（1 なら次の 1 で上がれる）。 */
export const distanceToOff = (player, point) =>
  player === WHITE ? point + 1 : 24 - point;

export class Board {
  constructor(points, bar, off) {
    // points[i] > 0 は White の駒数、< 0 は Black の駒数。
    this.points = points ?? Board.initialPoints();
    this.bar = bar ?? { WHITE: 0, BLACK: 0 };
    this.off = off ?? { WHITE: 0, BLACK: 0 };
  }

  static initialPoints() {
    const points = new Array(24).fill(0);
    points[23] = 2; points[12] = 5; points[7] = 3; points[5] = 5;     // White
    points[0] = -2; points[11] = -5; points[16] = -3; points[18] = -5; // Black
    return points;
  }

  static fromJson(data) {
    return new Board([...data.points],
      { WHITE: data.bar[0], BLACK: data.bar[1] },
      { WHITE: data.off[0], BLACK: data.off[1] });
  }

  clone() {
    return new Board([...this.points], { ...this.bar }, { ...this.off });
  }

  /** `player` の駒が `point` に何個あるか（相手の駒なら 0）。 */
  count(point, player) {
    const v = this.points[point];
    return player === WHITE ? Math.max(v, 0) : Math.max(-v, 0);
  }

  /** `player` がその点に置けるか（相手が 2 個以上ならブロック）。 */
  canLand(point, player) {
    if (point < 0 || point > 23) return false;
    return this.count(point, opponent(player)) <= 1;
  }

  /** その点が相手のブロット（1 個だけ）か。 */
  isBlot(point, player) {
    return this.count(point, opponent(player)) === 1;
  }

  allInHome(player) {
    if (this.bar[player] > 0) return false;
    let total = this.off[player];
    for (const p of homeRange(player)) total += this.count(p, player);
    return total === TOTAL_CHECKERS;
  }

  /** 最も遠い（ベアオフから遠い）駒の index。無ければ -1。 */
  farthestChecker(player) {
    if (player === WHITE) {
      for (let p = 23; p >= 0; p -= 1) if (this.count(p, player) > 0) return p;
    } else {
      for (let p = 0; p < 24; p += 1) if (this.count(p, player) > 0) return p;
    }
    return -1;
  }

  hasWon(player) {
    return this.off[player] === TOTAL_CHECKERS;
  }

  /**
   * `loser` の負け方。1=シングル / 2=ギャモン / 3=バックギャモン。
   * engine の `Board.win_type()` と同じ規則。
   */
  winType(loser) {
    if (this.off[loser] > 0) return 1;
    // 1 枚も上げていない。相手陣かバーに残っていればバックギャモン。
    if (this.bar[loser] > 0) return 3;
    for (const p of homeRange(opponent(loser))) {
      if (this.count(p, loser) > 0) return 3;
    }
    return 2;
  }
}

/**
 * ニューラルネットの入力 198 次元を作る。
 *
 * engine の `Board.encode(viewer, turn)` の移植。**並びを勝手に決めないこと。**
 * 学習済みの重みは engine の並びに対応しているので、1 つでもずれると
 * まったく別の関数になる。
 *
 * 並び:
 *   - 24 点ぶん、**点ごとに「viewer の 4 ユニット + 相手の 4 ユニット」**を交互に
 *   - 点の順は **viewer の 24 番ポイント → 1 番ポイント**
 *     （White なら index 23→0、Black なら index 0→23）
 *   - 192: viewer のバー / 2、193: 相手のバー / 2
 *   - 194: viewer の上がり / 15、195: 相手の上がり / 15
 *   - 196/197: 手番（viewer が手番なら 196、そうでなければ 197 が 1）
 *
 * 4 ユニットは**排他的**な符号化で、駒数ちょうど 1 / ちょうど 2 / 3 以上 に
 * 対応する。3 を超えるぶんだけ 4 番目に `(n-3)/2` が入る。
 * 累積（n>=1, n>=2, ...）ではないので注意。
 */
export function encodeBoard(board, viewer, turn) {
  const features = new Array(198).fill(0);
  const isWhite = viewer === WHITE;
  let k = 0;

  for (let i = 0; i < 24; i += 1) {
    // viewer の 24 番ポイントから 1 番ポイントへ
    const value = isWhite ? board.points[23 - i] : board.points[i];
    let own;
    let other;
    if (isWhite) {
      own = value > 0 ? value : 0;
      other = value > 0 ? 0 : -value;
    } else {
      own = value < 0 ? -value : 0;
      other = value < 0 ? 0 : value;
    }

    for (const count of [own, other]) {
      if (count === 1) {
        features[k] = 1;
      } else if (count === 2) {
        features[k + 1] = 1;
      } else if (count >= 3) {
        features[k + 2] = 1;
        if (count > 3) features[k + 3] = (count - 3) / 2;
      }
      k += 4;
    }
  }

  const opp = opponent(viewer);
  features[192] = board.bar[viewer] / 2;
  features[193] = board.bar[opp] / 2;
  features[194] = board.off[viewer] / TOTAL_CHECKERS;
  features[195] = board.off[opp] / TOTAL_CHECKERS;
  if (turn === viewer) features[196] = 1;
  else features[197] = 1;

  return features;
}
