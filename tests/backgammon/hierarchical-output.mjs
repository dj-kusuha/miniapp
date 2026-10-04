// engine と同じ階層型累積確率の変換と旧 JSON 互換を検証する。
import assert from 'node:assert/strict';
import { NeuralNet } from '../../docs/backgammon/src/nn-test-shim.mjs';

function logit(probability) {
  return Math.log(probability / (1 - probability));
}

function modelData(probabilities, outputTransform) {
  const data = {
    input_dim: 1,
    hidden_dims: [1],
    output_dim: probabilities.length,
    perspective: 'white',
    features: 'none',
    W1: [[0]],
    b1: [0],
    W2: [probabilities.map(() => 0)],
    b2: probabilities.map(logit),
  };
  if (outputTransform !== undefined) data.output_transform = outputTransform;
  return data;
}

function close(actual, expected, tolerance = 1e-7) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `actual=${actual} expected=${expected} tolerance=${tolerance}`,
  );
}

const probabilities = [0.8, 0.5, 0.2, 0.25, 0.3];
const legacy = new NeuralNet(modelData(probabilities));
assert.equal(legacy.outputTransform, 'independent_sigmoid');
const conditionals = legacy.predict([0]);
for (let i = 0; i < probabilities.length; i += 1) {
  close(conditionals[i], probabilities[i]);
}

const hierarchical = new NeuralNet(modelData(probabilities, 'hierarchical_cumulative_v1'));
const output = hierarchical.predict([0]);
const expected = [
  conditionals[0],
  Math.fround(conditionals[0] * conditionals[1]),
  Math.fround(Math.fround(conditionals[0] * conditionals[1]) * conditionals[2]),
  Math.fround(Math.fround(1 - conditionals[0]) * conditionals[3]),
  Math.fround(Math.fround(Math.fround(1 - conditionals[0]) * conditionals[3])
    * conditionals[4]),
];
assert.deepEqual(Array.from(output), expected);
assert.ok(output[2] <= output[1] && output[1] <= output[0]);
assert.ok(output[4] <= output[3] && output[3] <= 1 - output[0]);

const equalConditionals = new NeuralNet(modelData([0.5, 0.5, 0.5, 0.5, 0.5],
  'hierarchical_cumulative_v1'));
assert.deepEqual(Array.from(equalConditionals.predict([0])), [0.5, 0.25, 0.125, 0.25, 0.125]);

assert.throws(
  () => new NeuralNet(modelData(probabilities, 'future_transform')),
  /未対応の output_transform/,
);
assert.throws(
  () => new NeuralNet(modelData([0.5], 'hierarchical_cumulative_v1')),
  /5出力専用/,
);
console.log('階層型累積確率: 旧 JSON・float32 変換・順序制約・不正形式すべて一致');
