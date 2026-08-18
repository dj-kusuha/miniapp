// ニューラルネットの推論。198 -> 80 -> 5 の 3 層 MLP。
//
// backgammon_engine の `backgammon/nn.py` の移植。**重みは学習済みのものを
// そのまま読む**ので、ここでやるのは順伝播だけ。行列積 2 回とシグモイド 2 回。

/** 出力ユニットの意味（engine の nn.py と同じ並び）。 */
export const WIN = 0;
export const WIN_GAMMON = 1;
export const WIN_BACKGAMMON = 2;
export const LOSE_GAMMON = 3;
export const LOSE_BACKGAMMON = 4;

/**
 * engine と同じ範囲でクリップする。
 *
 * Python 側は `np.clip(x, -15, 15)` してから exp を取る。JS でも同じ範囲に
 * しないと、飽和した局面で最後の桁が食い違う。
 */
function sigmoid(x) {
  const z = x < -15 ? -15 : x > 15 ? 15 : x;
  return 1 / (1 + Math.exp(-z));
}

export class NeuralNet {
  /**
   * @param {object} data engine の `models/*.json` をそのまま渡す。
   */
  constructor(data) {
    this.inputDim = data.input_dim;
    this.hiddenDims = data.hidden_dims ?? [data.hidden_dim];
    this.outputDim = data.output_dim ?? 1;
    this.perspective = data.perspective ?? 'white';
    this.features = data.features ?? 'none';
    this.totalEpisodes = data.total_episodes ?? 0;

    if (this.hiddenDims.length !== 1) {
      // 1 層ぶんしか順伝播を書いていない。多層の重みを黙って無視しないよう落とす。
      throw new Error(`隠れ層が 1 層のモデルにのみ対応します: ${this.hiddenDims}`);
    }

    // JSON は行優先の 2 次元配列。内側のループで走るのは列なので、
    // 転置して「出力ユニットごとに連続した Float32Array」にしておく。
    this.w1 = toColumns(data.W1, this.inputDim, this.hiddenDims[0]);
    this.b1 = Float32Array.from(data.b1);
    this.w2 = toColumns(data.W2, this.hiddenDims[0], this.outputDim);
    this.b2 = Float32Array.from(data.b2);
  }

  static async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`モデルを取得できません: ${url} (${response.status})`);
    return new NeuralNet(await response.json());
  }

  /**
   * 1 局面ぶんの順伝播。
   * @param {ArrayLike<number>} x 入力（`inputDim` 要素）
   * @returns {Float32Array} 出力（`outputDim` 要素）
   */
  predict(x) {
    const hidden = new Float32Array(this.b1.length);
    for (let j = 0; j < hidden.length; j += 1) {
      const column = this.w1[j];
      let sum = this.b1[j];
      for (let i = 0; i < x.length; i += 1) sum += x[i] * column[i];
      hidden[j] = sigmoid(sum);
    }

    const out = new Float32Array(this.b2.length);
    for (let k = 0; k < out.length; k += 1) {
      const column = this.w2[k];
      let sum = this.b2[k];
      for (let j = 0; j < hidden.length; j += 1) sum += hidden[j] * column[j];
      out[k] = sigmoid(sum);
    }
    return out;
  }
}

function toColumns(matrix, rows, cols) {
  const columns = [];
  for (let c = 0; c < cols; c += 1) {
    const column = new Float32Array(rows);
    for (let r = 0; r < rows; r += 1) column[r] = matrix[r][c];
    columns.push(column);
  }
  return columns;
}

/**
 * 出力を equity（1 局あたりの期待得点・White 視点）に換算する。
 *
 *   equity = 2·P(win) + P(win g) + P(win bg) − P(lose g) − P(lose bg) − 1
 */
export function equity(outputs) {
  if (outputs.length === 1) return 2 * outputs[WIN] - 1;
  return (
    2 * outputs[WIN] +
    outputs[WIN_GAMMON] +
    outputs[WIN_BACKGAMMON] -
    outputs[LOSE_GAMMON] -
    outputs[LOSE_BACKGAMMON] -
    1
  );
}
