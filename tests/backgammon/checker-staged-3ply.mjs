// Full-root / staged 3-ply quality and effective-depth fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Agent, filtersFor } from '../../docs/backgammon/src/agent.js';
import { Board, WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import { NeuralNet } from '../../docs/backgammon/src/nn.js';
import { generateMoves } from '../../docs/backgammon/src/rules.js';
import { scoreCheckerMoves } from '../../docs/backgammon/src/checker.js';

const model = JSON.parse(readFileSync(new URL('../../docs/backgammon/src/model.json', import.meta.url)));
const net = new NeuralNet(model);
const board = new Board();
const moves = generateMoves(board, WHITE, 3, 1);
assert.ok(moves.length > 1);

const contexts = [
  {
    id: 'money-cubeful-jacoby',
    context: {
      cube: { value: 1, owner: 'center', enabled: true, available: true, unboundedMoney: true },
      match: { mode: 'money', jacoby: true },
    },
  },
  {
    id: 'match-mwc-pre-crawford',
    context: {
      cube: { value: 1, owner: 'center', enabled: true, available: true, unboundedMoney: false },
      match: {
        mode: 'match', targetPoints: 5, scoreWhite: 3, scoreBlack: 3,
        crawford: false, crawfordPlayed: false,
      },
    },
  },
];

const rows = [];
for (const { id, context } of contexts) {
  const agent = new Agent(net, 3, filtersFor(3), {
    bearoff: null,
    checkerSearchMode: 'staged3ply',
  });
  const elapsed = (fn) => {
    const start = performance.now();
    const result = fn();
    return { result, elapsedMs: performance.now() - start };
  };

  const legacy = elapsed(() => scoreCheckerMoves(agent, context, moves, WHITE, 'legacy'));
  const fullRoot = elapsed(() => scoreCheckerMoves(agent, context, moves, WHITE, 'full-root'));
  const staged = elapsed(() => scoreCheckerMoves(agent, context, moves, WHITE, 'staged3ply'));
  const fullByIndex = new Map(fullRoot.result.map(({ index, value }) => [index, value]));
  const stagedIndex = staged.result[0].index;
  const regret = fullRoot.result[0].value - fullByIndex.get(stagedIndex);
  assert.ok(agent.checkerLastStagedSearch.twoPlyCandidates <= 8);
  assert.ok(agent.checkerLastStagedSearch.threePlyCandidates <= 4);
  rows.push({
    scenario: id,
    legalMoves: moves.length,
    legacyAction: legacy.result[0].index,
    fullRootAction: fullRoot.result[0].index,
    stagedAction: stagedIndex,
    actionDiffersFromFullRoot: stagedIndex !== fullRoot.result[0].index,
    regretInEvaluationUnit: Number(regret.toFixed(8)),
    legacyMs: Number(legacy.elapsedMs.toFixed(2)),
    fullRootMs: Number(fullRoot.elapsedMs.toFixed(2)),
    stagedMs: Number(staged.elapsedMs.toFixed(2)),
    stage: agent.checkerLastStagedSearch,
    reuse: agent.checkerSearchStats,
  });
}

// Flat neural output creates enough tied candidates to exercise both staged filters
// deterministically, so the test proves two actual afterstate rolls, not only a label.
const flatVector = Float32Array.from([0.5, 0, 0, 0, 0]);
const flatNet = {
  features: 'none',
  outputDim: 5,
  perspective: 'white',
  predict: () => Float32Array.from(flatVector),
  predictBatch: (features) => features.map(() => Float32Array.from(flatVector)),
};
for (const { id, context } of contexts) {
  const agent = new Agent(flatNet, 3, filtersFor(3), {
    bearoff: null,
    checkerSearchMode: 'staged3ply',
    useCubeHead: false,
  });
  scoreCheckerMoves(agent, context, moves.slice(0, 2), WHITE, 'staged3ply');
  assert.equal(agent.checkerLastStagedSearch.maxAdditionalDepth, 2,
    `${id}: effective 3-ply reaches two afterstate rolls`);
  assert.ok(agent.checkerLastStagedSearch.twoPlyCandidates <= 8);
  assert.ok(agent.checkerLastStagedSearch.threePlyCandidates <= 4);
  assert.ok(agent.checkerSearchStats.rollExpansionHits > 0,
    `${id}: ND/DT roll expansions are reused`);
  assert.ok(agent.checkerSearchStats.batchCalls > 0,
    `${id}: NN leaf vectors are batch-evaluated`);
}

console.log(JSON.stringify({ position: 'initial board, White 3-1', rows,
  effective3PlyProbe: 'Match and Money reach depth 2, reuse ND/DT roll expansions, and batch NN vectors' }, null, 2));
