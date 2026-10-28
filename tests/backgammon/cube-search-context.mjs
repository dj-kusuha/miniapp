// Money/Match cube-search state propagation contract shared with engine JS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../docs/backgammon/src/agent.js';
import { Board, WHITE } from '../../docs/backgammon/src/board.js';
import { Game, ROLLING } from '../../docs/backgammon/src/game.js';

const fakeNet = {
  perspective: 'white',
  features: 'none',
  cubeHeadMoney: null,
  cubeHeadMatch: null,
  predict() { return [0.55, 0.08, 0.01, 0.06, 0.01]; },
};

function midgameBoard() {
  const points = Array(24).fill(0);
  for (const [point, count] of [[13, 2], [6, 2], [5, 4], [4, 3], [2, 4]]) {
    points[point - 1] = count;
  }
  for (const [point, count] of [[7, 2], [8, 1], [19, 2], [20, 2],
    [21, 2], [22, 2], [23, 2], [24, 2]]) points[point - 1] = -count;
  return new Board(points, { WHITE: 0, BLACK: 0 }, { WHITE: 0, BLACK: 0 });
}

test('Cash Option eligibility follows owner, cube cap, double right, and action context', () => {
  const agent = new Agent(fakeNet, 0);
  const policy = { alpha: 1.0 };
  for (const [depth, owner, cube, allowDouble, context, expected] of [
    [1, 'center', 1, true, 'post_no_double', true],
    [1, 'me', 2, true, 'post_no_double', true],
    [1, 'center', 32, true, 'post_no_double', true],
    [1, 'opponent', 1, true, 'post_no_double', false],
    [1, 'center', 64, true, 'post_no_double', false],
    [1, 'center', 1, false, 'post_no_double', false],
    [1, 'center', 1, true, 'post_double_take', false],
    [0, 'center', 1, true, 'post_no_double', false],
  ]) {
    assert.equal(agent.cashOptionPathEligible(
      policy, depth, owner, cube, allowDouble, context), expected);
  }
  assert.ok(Math.abs(agent.cashOptionValue(
    [0.8, 0.05, 0.01, 0.05, 0.01], 1.0) - 0.74) < 1e-12);
});

test('ND recursion retains Cash Option policy and double-take drops it', () => {
  const agent = new Agent(fakeNet, 0);
  const eligibility = [];
  const originalEligible = agent.cashOptionPathEligible.bind(agent);
  agent.cashOptionPathEligible = function(...args) {
    const eligible = originalEligible(...args);
    eligibility.push({ depth: args[1], owner: args[2], cube: args[3],
      context: args[5], hasPolicy: Boolean(args[0]), eligible });
    return eligible;
  };
  const cashAlphas = [];
  const originalCashValue = agent.cashOptionValue.bind(agent);
  agent.cashOptionValue = function(vector, alpha) {
    cashAlphas.push(alpha);
    return originalCashValue(vector, alpha);
  };
  const originalCubefulEquity = agent.cubefulEquity.bind(agent);
  agent.cubefulEquity = function(vector, owner, ...args) {
    return owner === 'opponent' ? 0.6 : originalCubefulEquity(vector, owner, ...args);
  };
  const policy = { alpha: 1.0 };
  const board = midgameBoard();

  const withoutPolicy = agent.cubefulSearch(board, WHITE, 'opponent', 2, false, 0, null);
  eligibility.length = 0;
  cashAlphas.length = 0;
  const withPolicy = agent.cubefulSearch(board, WHITE, 'opponent', 2, false, 0, null,
    { cashPolicy: policy });
  assert.ok(cashAlphas.length > 0,
    `depth=2 search reaches eligible depth=1 ND leaves: ${JSON.stringify(eligibility.slice(0, 8))}`);
  assert.ok(cashAlphas.every(alpha => alpha === 1.0));
  assert.notEqual(withPolicy, withoutPolicy,
    'Cash Option changes the 2-ply equity when the opponent can pass');
  console.log(`Cash Option recursive fixture: without=${withoutPolicy.toFixed(6)} with=${withPolicy.toFixed(6)} `
    + `(cash calls ${cashAlphas.length})`);
  assert.ok(eligibility.some(x => x.depth === 1 && x.owner === 'me' &&
    x.context === 'post_no_double' && x.hasPolicy && x.eligible));

  eligibility.length = 0;
  cashAlphas.length = 0;
  agent.cubeNode(board, WHITE, 'center', 1, false, 0, null, 1, true, policy);
  assert.ok(eligibility.some(x => x.context === 'post_double_take' &&
    !x.hasPolicy && !x.eligible));
});

test('Money root sends the actual cube and post-double context to both branches', () => {
  const game = new Game(midgameBoard(), Math.random, { jacoby: false });
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  game.cube.value = 4;
  game.cube.owner = WHITE;
  const agent = new Agent(fakeNet, 0, undefined, {
    cubeSearchDepth: 2, cubeLeafPlies: 0, cubeCashOption: true,
  });
  const calls = [];
  agent.cubefulSearch = (...args) => {
    calls.push(args);
    return args[7].actionContext === 'post_double_take' ? 0.2 : 0.1;
  };

  agent.shouldDoubleSearch(game);
  const nd = calls.find(args => args[7]?.actionContext === 'post_no_double');
  const take = calls.find(args => args[7]?.actionContext === 'post_double_take');
  assert.ok(nd);
  assert.equal(nd[7].cubeValue, 4);
  assert.equal(nd[7].cashOption, true);
  assert.equal(nd[7].cashAlpha, agent.cubeCashAlpha);
  assert.equal(nd[7].cashPolicy, undefined,
    'Money cube-action entry preserves the engine legacy cashOption contract');
  assert.ok(take);
  assert.equal(take[7].cubeValue, 8);
});

test('Money shouldDoubleSearch Cash Option remains a depth-1 entry contract', () => {
  const run = (depth) => {
    const game = new Game(midgameBoard(), Math.random, { jacoby: false });
    game.currentPlayer = WHITE;
    game.state = ROLLING;
    const agent = new Agent(fakeNet, 0, undefined, {
      cubeSearchDepth: depth, cubeLeafPlies: 0, cubeCashOption: true,
    });
    const cashAlphas = [];
    const originalCashValue = agent.cashOptionValue.bind(agent);
    agent.cashOptionValue = (vector, alpha) => {
      cashAlphas.push(alpha);
      return originalCashValue(vector, alpha);
    };
    agent.searchedVectorFor = () => [0.55, 0.08, 0.01, 0.06, 0.01];
    const originalEquity = agent.cubefulEquity.bind(agent);
    agent.cubefulEquity = (vector, owner, ...args) => owner === 'opponent'
      ? 0.6 : originalEquity(vector, owner, ...args);

    agent.shouldDoubleSearch(game);
    return cashAlphas;
  };

  assert.ok(run(1).length > 0,
    'the existing root depth-1 Cash Option path remains active');
  assert.equal(run(2).length, 0,
    'depth-2 Money action remains aligned with the engine cube-action entry');
});

test('accepted double passes the doubled cube value into search', () => {
  const agent = new Agent(fakeNet, 0, undefined, { cubeSearchDepth: 1 });
  let received;
  agent.cubefulSearch = (...args) => {
    received = args[7];
    return 0.25;
  };
  assert.equal(agent.wouldTakeSearch(midgameBoard(), WHITE, 32), true);
  assert.equal(received.cubeValue, 64);
  assert.equal(received.actionContext, 'post_double_take');
});

test('Money and Match CubeHeads read hidden state after volatility inference', () => {
  const shared = new Float32Array([0]);
  const observed = [];
  const head = {
    contextDim: 5,
    predict(hidden) { observed.push(hidden[0]); return 0.6; },
  };
  const agent = new Agent(fakeNet, 0, undefined, {
    cubeHeadMoney: head, cubeHeadMatch: head,
  });
  agent.net.lastHidden = () => { shared[0] = 1; return shared; };
  agent.rollVolatility = () => { shared[0] = 99; return 0.2; };

  agent.cubeHeadActionEfficiencies(midgameBoard(), WHITE, 2, 'center');
  agent.matchCubeHeadActionEfficiencies(midgameBoard(), WHITE, 2, 'center', {
    away: { WHITE: 3, BLACK: 2 }, crawfordPlayed: false,
  });
  agent.cubeHeadFor(midgameBoard(), WHITE, 2, 'center');
  assert.deepEqual(observed, [1, 1, 1, 1, 1]);
});

test('centered Jacoby terminal gammon scores a single and cube 64 has no redouble', () => {
  const agent = new Agent(fakeNet, 0);
  const points = Array(24).fill(0);
  points[0] = -15;
  const terminal = new Board(points, { WHITE: 0, BLACK: 0 }, { WHITE: 15, BLACK: 0 });
  assert.equal(agent.cubefulSearch(terminal, WHITE, 'center', 0, true), 1);
  assert.equal(agent.cubefulSearch(terminal, WHITE, 'center', 0, false), 3);

  const calls = [];
  agent.cubefulSearch = (...args) => { calls.push(args); return 0.25; };
  assert.equal(agent.cubeNode(midgameBoard(), WHITE, 'me', 0, false, 0, null, 64), 0.25);
  assert.equal(calls.length, 1, '64 cube must not offer a 128 cube');
});

test('Match cube node suppresses doubles when unavailable or already at 64', () => {
  const agent = new Agent(fakeNet, 0);
  const originalMwcSearch = agent.mwcSearch.bind(agent);
  const calls = [];
  agent.mwcSearch = (...args) => {
    calls.push(args);
    return 0.4;
  };
  const match = { away: { WHITE: 5, BLACK: 5 }, crawfordPlayed: false };
  const board = midgameBoard();

  agent.mwcNode(board, WHITE, 'me', 1, 64, match);
  assert.equal(calls.length, 1, '64 cube must not create a 128 cube branch');
  calls.length = 0;
  agent.mwcNode(board, WHITE, 'me', 1, 4, match, null, null, false);
  assert.equal(calls.length, 1, 'Crawford/no-double state must not offer take/drop branches');

  const rights = [];
  agent.mwcNode = (...args) => { rights.push(args[8]); return 0.4; };
  originalMwcSearch(board, WHITE, 'me', 1, 4, match, 0, null, false);
  assert.ok(rights.length > 0);
  assert.ok(rights.every(allowed => allowed === false),
    'Crawford/no-double right is carried to every recursive Match node');
});
