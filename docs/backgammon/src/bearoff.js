// 片側ベアオフ データベース（engine の `backgammon/bearoff.py` の移植）。
//
// 両者の駒が自陣に入りきると、局面は**互いに干渉しない 2 つの競走**に分解する。
// 相手を打つことも塞ぐこともできないので、「自分が上がりきるまでに何回振るか」の
// 分布さえ分かれば**勝率が厳密に計算できる**。その表を engine が先に全部計算して
// 配っている（6 ポイント・15 枚で 54,264 状態）。
//
// engine 側の実測（2026-08-28・32,000 局面・2-ply）:
// 標準ベンチが 3.235 → 3.076 mEMG（**-0.159**）。適用範囲は 11.8% だが、
// **着手が変わったのは 1.6%（502 局面）**で、その局面の損失が
// 11.77 → 1.64 mEMG になる。
//
// **厳密さには条件が付く。** 分布は「上がりきるまでの期待回数を最小化する
// 打ち方」のもとで計算されており、勝率を最大化する打ち方とは厳密には別物
// （片側 DB の宿命で gnubg も同じ）。
//
// ファイルは Python / C# / JS で共有する素のバイナリ（'BGBO'）。
// **float16 のまま持ち、引くときだけ変換する**（`Float16Array` は
// 使える環境が限られるため。1 回の問い合わせで触るのは 2 状態ぶんだけ）。

import { WHITE, BLACK, opponent } from './board.js';
import {
  WIN, WIN_GAMMON, WIN_BACKGAMMON, LOSE_GAMMON, LOSE_BACKGAMMON, flipPerspective,
} from './nn.js';

/** float16 のビット列を数値に直す。 */
export function halfToFloat(bits) {
  const sign = (bits >> 15) & 0x1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  let value;
  if (exponent === 0) {
    value = mantissa * 5.9604645e-8;          // 非正規化数（分布の裾に出る）
  } else if (exponent === 31) {
    value = mantissa === 0 ? Infinity : NaN;
  } else {
    value = (1 + mantissa / 1024) * 2 ** (exponent - 15);
  }
  return sign === 1 ? -value : value;
}

export class BearoffDatabase {
  /**
   * engine が書いた素のバイナリを読む。
   *
   *     0   'BGBO' / 4 版 / 5 ポイント数 P / 6 駒数 / 7 窓の枠数 W
   *     8   uint16 分布の枠数 R / 12 uint32 状態数 N
   *     16  uint8[N*P] 状態 / uint8[N] finish 開始位置 / uint8[N] first 開始位置
   *     …   float16[N*W] finish の窓 / float16[N*W] first の窓
   *
   * @param {ArrayBuffer} buffer
   */
  constructor(buffer) {
    const header = new DataView(buffer);
    const magic = String.fromCharCode(header.getUint8(0), header.getUint8(1),
                                      header.getUint8(2), header.getUint8(3));
    if (magic !== 'BGBO') throw new Error('ベアオフ DB のバイナリではありません');
    const version = header.getUint8(4);
    if (version !== 1) throw new Error(`未知の版です: ${version}`);

    this.points = header.getUint8(5);
    this.window = header.getUint8(7);
    this.rolls = header.getUint16(8, true);
    this.count = header.getUint32(12, true);

    let cursor = 16;
    this.states = new Uint8Array(buffer, cursor, this.count * this.points);
    cursor += this.states.length;
    this.finishStart = new Uint8Array(buffer, cursor, this.count);
    cursor += this.count;
    this.firstStart = new Uint8Array(buffer, cursor, this.count);
    cursor += this.count;
    // **float16 のまま Uint16Array で持つ**（引くときに変換する）
    this.finishWindow = new Uint16Array(buffer, cursor, this.count * this.window);
    cursor += this.count * this.window * 2;
    this.firstWindow = new Uint16Array(buffer, cursor, this.count * this.window);

    // 配置 → 状態番号。各ポイントの駒数は 15 以下なので 4 ビットに収まる
    this.index = new Map();
    for (let i = 0; i < this.count; i += 1) {
      let key = 0;
      const offset = i * this.points;
      for (let k = 0; k < this.points; k += 1) key |= this.states[offset + k] << (4 * k);
      this.index.set(key, i);
    }
    // 展開用の作業領域（呼ぶたびに確保しない）
    this.scratch = [new Float64Array(this.rolls), new Float64Array(this.rolls),
                    new Float64Array(this.rolls), new Float64Array(this.rolls)];
  }

  /** fetch して読む。 */
  static async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`ベアオフ DB を読み込めません: ${response.status}`);
    return new BearoffDatabase(await response.arrayBuffer());
  }

  /** 配置の状態番号（見つからなければ -1）。 */
  indexOf(counts) {
    let key = 0;
    for (let k = 0; k < counts.length; k += 1) key |= counts[k] << (4 * k);
    const found = this.index.get(key);
    return found === undefined ? -1 : found;
  }

  /**
   * 状態の分布を `into` に展開する。
   *
   * **切り詰めと float16 の丸めで和が 1 からずれる。** 累積和で P(X >= k) を
   * 作るので、揃えておかないと裾がわずかに負になりうる。
   */
  expand(state, first, into) {
    into.fill(0);
    const starts = first ? this.firstStart : this.finishStart;
    const windows = first ? this.firstWindow : this.finishWindow;
    const start = starts[state];
    const offset = state * this.window;
    let total = 0;
    for (let k = 0; k < this.window; k += 1) {
      const value = halfToFloat(windows[offset + k]);
      into[start + k] = value;
      total += value;
    }
    if (total > 0) {
      for (let k = 0; k < into.length; k += 1) into[k] /= total;
    }
    return into;
  }

  /**
   * 両者の配置から**手番側視点**の 5 要素を返す。
   *
   * 手番側が n 回目で上がりきったとき、相手は n-1 回しか振れていない。
   * したがって P(手番側の勝ち) = Σ_n P(A = n) · P(B ≥ n)。
   */
  probabilities(onRoll, waiting) {
    const a = this.indexOf(onRoll);
    const b = this.indexOf(waiting);
    if (a < 0 || b < 0) return null;
    if (onRoll.reduce((x, y) => x + y, 0) === 0) {
      // 決着済みをここで引いてはいけない（ギャモン率が常に 1 になる）
      throw new Error('手番側が既に上がりきっています');
    }

    const [finishA, finishB, firstA, firstB] = this.scratch;
    this.expand(a, false, finishA);
    this.expand(b, false, finishB);
    this.expand(a, true, firstA);
    this.expand(b, true, firstB);

    let win = 0;
    let winGammon = 0;
    let loseGammon = 0;
    let tailFinishB = 1;      // P(B >= n)
    let tailFirstB = 1;       // P(B の 1 枚目が n 回以上)
    let tailFirstA = 1;       // P(A の 1 枚目が n 回以上)
    let nextTailFirstA = 1 - firstA[0];
    for (let n = 0; n < this.rolls; n += 1) {
      win += finishA[n] * tailFinishB;
      winGammon += finishA[n] * tailFirstB;
      loseGammon += finishB[n] * nextTailFirstA;
      tailFinishB -= finishB[n];
      tailFirstB -= firstB[n];
      tailFirstA -= firstA[n];
      nextTailFirstA = n + 1 < this.rolls ? tailFirstA - firstA[n + 1] : 0;
    }

    const vector = new Float32Array(5);
    vector[WIN] = win;
    vector[WIN_GAMMON] = winGammon;
    vector[WIN_BACKGAMMON] = 0;        // 両者とも自陣にいるのでありえない
    vector[LOSE_GAMMON] = loseGammon;
    vector[LOSE_BACKGAMMON] = 0;
    return vector;
  }

  /** 盤面から player の自陣の駒数を読む（範囲外なら null）。 */
  countsFor(board, player) {
    if (board.bar[player] > 0) return null;
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 24; i += 1) {
      const checkers = board.count(i, player);
      if (checkers <= 0) continue;
      // White は index 0-5、Black は 23-18 が自陣（pip 距離が同じ順に読む）
      const distance = player === WHITE ? i : 23 - i;
      if (distance >= 6) return null;
      counts[distance] = checkers;
    }
    return counts;
  }

  /**
   * 両者とも自陣に入っていれば **White 視点**の 5 要素を返す。
   * まだ通常の局面、または決着済みなら null。
   */
  boardProbabilities(board, turn) {
    if (board.hasWon(WHITE) || board.hasWon(BLACK)) return null;
    const mine = this.countsFor(board, turn);
    const theirs = this.countsFor(board, opponent(turn));
    if (mine === null || theirs === null) return null;
    const vector = this.probabilities(mine, theirs);   // 手番側視点
    if (vector === null) return null;
    return turn === WHITE ? vector : Float32Array.from(flipPerspective(vector));
  }
}
