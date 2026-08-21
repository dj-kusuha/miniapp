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
    //: engine が保存した日付（YYYY-MM-DD）。**古いモデルには入っていない**ので
    //: 空文字に落とす。対戦前の画面に「どの世代を配っているか」を出すために使う。
    this.savedAt = data.saved_at ?? '';

    if (this.hiddenDims.length < 1) {
      throw new Error(`隠れ層が 1 層以上のモデルにのみ対応します: ${this.hiddenDims}`);
    }

    // 重みのキーは engine と同じ W1/b1, W2/b2, ... という連番。
    // **第 1 層だけ行優先、第 2 層以降は列優先**で持つ。理由は predict を参照。
    const dims = [this.inputDim, ...this.hiddenDims, this.outputDim];
    for (let index = 1; index < dims.length; index += 1) {
      if (!data[`W${index}`] || !data[`b${index}`]) {
        throw new Error(`重み W${index} / b${index} がモデルにありません`);
      }
    }

    // 第 1 層: W1[i] = 「入力ユニット i が全隠れユニットへ寄与する重み」。
    // JSON がもともと行優先なので、そのまま Float32Array にするだけでよい。
    this.rowsFirst = [];
    for (let i = 0; i < dims[0]; i += 1) {
      this.rowsFirst.push(Float32Array.from(data.W1[i]));
    }
    this.biasFirst = Float32Array.from(data.b1);

    // 第 2 層以降: 入力（前段のシグモイド出力）が密なので内積のほうが素直。
    // 転置して「出力ユニットごとに連続した Float32Array」にしておく。
    this.layers = [];
    for (let index = 2; index < dims.length; index += 1) {
      this.layers.push({
        columns: toColumns(data[`W${index}`], dims[index - 1], dims[index]),
        bias: Float32Array.from(data[`b${index}`]),
      });
    }

    // 使い回すバッファ。3-ply では 1 手あたり 10 万回以上 predict を呼ぶので、
    // 毎回確保すると効いてくる。**出力層だけは毎回新しく確保する**
    // （呼び出し側が返り値を保持しても壊れないようにするため。実測 +9%）。
    this.accumulator = new Float64Array(Math.max(...dims));
    this.hiddenBuffers = this.hiddenDims.map((d) => new Float32Array(d));
    this.nonzeroIndex = new Int32Array(this.inputDim);
    this.nonzeroValue = new Float64Array(this.inputDim);
  }

  static async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`モデルを取得できません: ${url} (${response.status})`);
    return new NeuralNet(await response.json());
  }

  /**
   * 1 局面ぶんの順伝播。
   *
   * **第 1 層は疎に回す。** 盤面の符号化 198 次元のうち非ゼロは平均 16.6 個
   * （8.4%）しかない。ゼロを掛けて足しても和は変わらないので、
   * **飛ばしても結果はビット単位で変わらない**（近似ではない）。
   * そのために W1 だけ行優先で持ち、非ゼロの入力ごとに「その行を全体へ
   * 足し込む」形にしている。第 2 層以降は入力が密なので普通の内積。
   *
   * 累算を Float64Array で持つのは**丸めの回数を現行と揃えるため**。
   * Float32Array に直接足し込むと 1 項ごとに丸められて答えが動く。
   *
   * 実測: 1 回 36.3 µs → 7.8 µs（4.6 倍）。400 局面すべてで出力が完全一致。
   *
   * @param {ArrayLike<number>} x 入力（`inputDim` 要素）
   * @returns {Float32Array} 出力（`outputDim` 要素）
   */
  predict(x) {
    const { rowsFirst, biasFirst, accumulator, nonzeroIndex, nonzeroValue } = this;
    const hidden = biasFirst.length;

    let count = 0;
    for (let i = 0; i < x.length; i += 1) {
      const value = x[i];
      if (value !== 0) {
        nonzeroIndex[count] = i;
        nonzeroValue[count] = value;
        count += 1;
      }
    }

    for (let j = 0; j < hidden; j += 1) accumulator[j] = biasFirst[j];
    for (let k = 0; k < count; k += 1) {
      const value = nonzeroValue[k];
      const row = rowsFirst[nonzeroIndex[k]];
      for (let j = 0; j < hidden; j += 1) accumulator[j] += value * row[j];
    }
    // engine の nn.py と同じく、出力層まで含めて全層シグモイド。
    let activation = this.hiddenBuffers[0];
    for (let j = 0; j < hidden; j += 1) activation[j] = sigmoid(accumulator[j]);

    const last = this.layers.length - 1;
    for (let l = 0; l < this.layers.length; l += 1) {
      const { columns, bias } = this.layers[l];
      const next = l === last
        ? new Float32Array(bias.length)
        : this.hiddenBuffers[l + 1];
      for (let j = 0; j < next.length; j += 1) {
        const column = columns[j];
        let sum = bias[j];
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
