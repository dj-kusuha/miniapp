// Test the #544 thresholds and stable candidate caps with a deterministic value stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../docs/backgammon/src/agent.js';
import { Board, WHITE } from '../../docs/backgammon/src/board.js';
import { rankCheckerMoves, scoreCheckerMoves, selectCheckerMove } from '../../docs/backgammon/src/checker.js';

const positions = Array.from({ length: 10 }, (_, id) => {
  const board = new Board();
  board.points[0] = id;
  return { resultingBoard: board };
});

function makeAgent(mode, valuesByDepth) {
  const agent = new Agent({
    features: 'none',
    predict: () => Float32Array.from([0.5, 0, 0, 0, 0]),
  }, 3, undefined, {
    bearoff: null,
    useCubeHead: false,
    checkerSearchMode: 'staged3ply',
  });
  if (mode === 'money') {
    agent.cubefulSearch = (board, _turn, _owner, depth, _jacoby, _leaf, _efficiency, options) => {
      const values = valuesByDepth[depth];
      const value = values[board.points[0]];
      return options.cubeValue === 1 ? -value : -1;
    };
  } else {
    agent.mwcSearch = (board, _turn, owner, depth) => {
      if (owner === 'opponent') return 0;
      return 1 - valuesByDepth[depth][board.points[0]];
    };
  }
  return agent;
}

const contexts = {
  money: {
    cube: { value: 1, owner: 'center', enabled: true, available: true, unboundedMoney: true },
    match: { mode: 'money', jacoby: true },
  },
  match: {
    cube: { value: 1, owner: 'center', enabled: true, available: true },
    match: {
      mode: 'match', targetPoints: 5, scoreWhite: 3, scoreBlack: 3,
      crawford: false, crawfordPlayed: false,
    },
  },
};

test('Money stages use equity margins 0.160/0.080 and caps 8/4', () => {
  const agent = makeAgent('money', [
    Array.from({ length: 10 }, (_, index) => 1 - index * 0.02),
    Array.from({ length: 10 }, (_, index) => 1 - index * 0.02),
    Array.from({ length: 10 }, (_, index) => 1 - index * 0.01),
  ]);
  const score = scoreCheckerMoves(agent, contexts.money, positions, WHITE);
  assert.equal(agent.checkerLastStagedSearch.firstMargin, 0.160);
  assert.equal(agent.checkerLastStagedSearch.secondMargin, 0.080);
  assert.equal(agent.checkerLastStagedSearch.twoPlyCandidates, 8);
  assert.equal(agent.checkerLastStagedSearch.threePlyCandidates, 4);
  assert.deepEqual(score.slice(0, 4).map(({ index }) => index), [0, 1, 2, 3]);
  assert.equal(selectCheckerMove(agent, contexts.money, positions, WHITE), score[0].index);
  assert.equal(rankCheckerMoves(agent, contexts.money, positions, WHITE, 3).entries[0].index,
    score[0].index);
});

test('Match stages use MWC margins 0.010/0.005 and caps 8/4', () => {
  const tied = Array(10).fill(0.5);
  const agent = makeAgent('match', [tied, tied, tied]);
  const score = scoreCheckerMoves(agent, contexts.match, positions, WHITE);
  assert.equal(agent.checkerLastStagedSearch.firstMargin, 0.010);
  assert.equal(agent.checkerLastStagedSearch.secondMargin, 0.005);
  assert.equal(agent.checkerLastStagedSearch.twoPlyCandidates, 8);
  assert.equal(agent.checkerLastStagedSearch.threePlyCandidates, 4);
  assert.deepEqual(score.slice(0, 4).map(({ index }) => index), [0, 1, 2, 3]);
  assert.equal(selectCheckerMove(agent, contexts.match, positions, WHITE), score[0].index);
  assert.equal(rankCheckerMoves(agent, contexts.match, positions, WHITE, 3).entries[0].index,
    score[0].index);
  assert.ok(agent.checkerLastStagedSearch.firstMargin !== 0.160);
  assert.ok(agent.checkerLastStagedSearch.secondMargin !== 0.080);
});

test('staged hints report loss only among candidates scored at the same depth', () => {
  const depth0 = [1, 0.95, ...Array(8).fill(0)];
  const depth1 = [0.9, 0.7, ...Array(8).fill(0)];
  const agent = makeAgent('money', [depth0, depth1, depth1]);
  const ranked = rankCheckerMoves(agent, contexts.money, positions, WHITE, 3);
  assert.deepEqual(ranked.entries.map(({ index }) => index), [0, 1]);
  assert.deepEqual(ranked.entries.map(({ loss }) => Math.round(loss * 100) / 100), [0, 0.2]);
});
