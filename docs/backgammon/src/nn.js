// ニューラルネットの推論。198 -> 隠れ層（1 層以上） -> 5 の MLP。
//
// backgammon_engine の `backgammon/nn.py` の移植。**重みは学習済みのものを
// そのまま読む**ので、ここでやるのは順伝播だけ。
//
// 隠れ層の数は `hidden_dims` の長さで決まる。同梱モデルは 2 層（128 -> 64）
// だが、1 層の旧モデルもそのまま読める（`hidden_dims` を持たない世代は
// `hidden_dim` から 1 層とみなす）。

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

    if (this.hiddenDims.length < 1) {
      throw new Error(`隠れ層が 1 層以上のモデルにのみ対応します: ${this.hiddenDims}`);
    }

    // 層ごとの (重み, バイアス)。JSON は行優先の 2 次元配列だが、内側のループで
    // 走るのは列なので、転置して「出力ユニットごとに連続した Float32Array」に
    // しておく。重みのキーは engine と同じ W1/b1, W2/b2, ... という連番。
    const dims = [this.inputDim, ...this.hiddenDims, this.outputDim];
    this.layers = [];
    for (let index = 1; index < dims.length; index += 1) {
      const weight = data[`W${index}`];
      const bias = data[`b${index}`];
      if (!weight || !bias) {
        throw new Error(`重み W${index} / b${index} がモデルにありません`);
      }
      this.layers.push({
        columns: toColumns(weight, dims[index - 1], dims[index]),
        bias: Float32Array.from(bias),
      });
    }
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
    // engine の nn.py と同じく、出力層まで含めて全層シグモイド。
    let activation = x;
    for (const layer of this.layers) {
      const next = new Float32Array(layer.bias.length);
      for (let j = 0; j < next.length; j += 1) {
        const column = layer.columns[j];
        let sum = layer.bias[j];
        for (let i = 0; i < activation.length; i += 1) sum += activation[i] * column[i];
        next[j] = sigmoid(sum);
      }
      activation = next;
    }
    return activation;
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
