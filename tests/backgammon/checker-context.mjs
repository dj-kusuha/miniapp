// CPU着手・ヒント共通checker評価のMET、cube権利、終局fixture。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../docs/backgammon/src/agent.js';
import { WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import { Match, MONEY } from '../../docs/backgammon/src/match.js';
import { matchWinChance, mwcWithCube, outcomeSpread } from '../../docs/backgammon/src/met.js';
import {
  checkerContextFor, rankCheckerMoves, scoreCheckerMoves, selectCheckerMove,
} from '../../docs/backgammon/src/checker.js';

const close = (got, want, tolerance = 1e-5) =>
  assert.ok(Math.abs(got - want) <= tolerance, `${got} ≠ ${want}`);

function makeAgent(values = new WeakMap()) {
  const agent = new Agent({}, 0, undefined, {
    bearoff: null,
    cubeLeafPlies: 0,
    cubeSearchDepth: 1,
    matchCubeEfficiency: 0,
    useCubeHead: false,
  });
  agent.vectorFor = (board) => values.get(board) ?? [0.5, 0.1, 0.02, 0.1, 0.02];
  agent.probabilitiesFor = (board) => agent.vectorFor(board);
  return agent;
}

function board({ winner = null, winType = 1 } = {}) {
  return {
    hasWon: (player) => player === winner,
    winType: () => winType,
  };
}

function context({
  enabled = false,
  available = false,
  owner = 'center',
  value = 1,
  mode = 'match',
  scoreWhite = 3,
  scoreBlack = 3,
  targetPoints = 5,
  crawford = false,
  crawfordPlayed = false,
  jacoby = false,
} = {}) {
  return {
    cube: { enabled, available, owner, value },
    match: mode === 'money'
      ? { mode, jacoby }
      : { mode, targetPoints, scoreWhite, scoreBlack, crawford, crawfordPlayed, jacoby: false },
  };
}

test('5pt MET: score 3-3のシングルは0.67736、ギャモンは1.0', () => {
  const single = { win1: 1, win2: 0, win3: 0, lose1: 0, lose2: 0, lose3: 0 };
  const gammon = { ...single, win1: 0, win2: 1 };
  close(matchWinChance(1, 2, false), 0.67736);
  close(mwcWithCube(single, 1, 2, 2, false), 0.67736);
  close(mwcWithCube(gammon, 1, 2, 2, false), 1.0);
  close(mwcWithCube(single, 1, 1, 2, false), 1.0);
  close(mwcWithCube(gammon, 1, 1, 2, false), 1.0);
});

test('Match cube OFFの候補順位はスコアに応じてギャモン価値が変わる', () => {
  const a = board();
  const b = board();
  const values = new WeakMap([
    [a, [0.80, 0.05, 0, 0, 0]], // 勝率は高いがギャモンが少ない
    [b, [0.65, 0.50, 0, 0, 0]], // 勝率は低いがギャモンが多い
  ]);
  const agent = makeAgent(values);
  const moves = [{ resultingBoard: a }, { resultingBoard: b }];

  const tiedScore = rankCheckerMoves(agent, context({ scoreWhite: 3, scoreBlack: 3 }),
    moves, WHITE, 2);
  assert.equal(tiedScore.unit, 'mwc');
  assert.equal(tiedScore.entries[0].index, 1);
  close(tiedScore.entries[0].equity, 0.714528);

  const matchPoint = rankCheckerMoves(agent, context({ scoreWhite: 4, scoreBlack: 3 }),
    moves, WHITE, 2);
  assert.equal(matchPoint.unit, 'mwc');
  assert.equal(matchPoint.entries[0].index, 0);
  close(matchPoint.entries[0].equity, 0.9);
});

test('Match scoring keeps perspective, cube owner, and enabled/available separate', () => {
  const agent = makeAgent();
  const candidate = board();
  const calls = [];
  const original = agent.mwcSearch.bind(agent);
  agent.mwcSearch = (...args) => {
    calls.push([...args.slice(0, 8), args[8] ?? true]);
    return original(...args);
  };

  // Cubeは有効だが、元の着手側が持つため次手番はDoubleを提示できない。
  const ownedByPrevious = context({ enabled: true, available: false, owner: WHITE });
  const score = scoreCheckerMoves(agent, ownedByPrevious,
    [{ resultingBoard: candidate }], WHITE)[0].value;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], BLACK);
  assert.equal(calls[0][2], 'opponent');
  assert.equal(calls[0][8], true);
  close(score, 1 - original(...calls[0]));
});

test('cube OFFとCrawfordはfuture doubleを止め、post-Crawfordでは再び使える', () => {
  const agent = makeAgent();
  const candidate = board();
  const original = agent.mwcSearch.bind(agent);
  const calls = [];
  agent.mwcSearch = (...args) => {
    calls.push([...args.slice(0, 8), args[8] ?? true]);
    return original(...args);
  };

  scoreCheckerMoves(agent, context({ enabled: false, owner: BLACK }),
    [{ resultingBoard: candidate }], WHITE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][8], false);
  calls.length = 0;

  scoreCheckerMoves(agent, context({ enabled: true, available: false,
    crawford: true, crawfordPlayed: false }), [{ resultingBoard: candidate }], WHITE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][8], false);
  assert.equal(calls[0][5].crawfordPlayed, true);
  calls.length = 0;

  scoreCheckerMoves(agent, context({ enabled: true, available: true,
    crawford: false, crawfordPlayed: true }), [{ resultingBoard: candidate }], WHITE);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][8], true);
  assert.equal(calls[1][2], 'opponent');
  assert.equal(calls[1][5].crawfordPlayed, true);
});

test('キューブ上限64と相手所有では追加double枝を作らない', () => {
  const agent = makeAgent();
  const candidate = board();
  const original = agent.mwcSearch.bind(agent);
  const calls = [];
  agent.mwcSearch = (...args) => {
    calls.push([...args.slice(0, 8), args[8] ?? true]);
    return original(...args);
  };

  scoreCheckerMoves(agent, context({ enabled: true, owner: WHITE, value: 2 }),
    [{ resultingBoard: candidate }], WHITE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][4], 2);
  calls.length = 0;

  scoreCheckerMoves(agent, context({ enabled: true, owner: BLACK, value: 4 }),
    [{ resultingBoard: candidate }], WHITE);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][4], 4);
  assert.equal(calls[1][4], 8);
  calls.length = 0;

  scoreCheckerMoves(agent, context({ enabled: true, owner: 'center', value: 64 }),
    [{ resultingBoard: candidate }], WHITE);
  assert.equal(calls.length, 1);
});

test('Money cube OFFは固定cubeのequityを使い、Jacoby状態も維持する', () => {
  const candidate = board();
  const values = new WeakMap([[candidate, [0.8, 0.6, 0.2, 0.1, 0.02]]]);
  const agent = makeAgent(values);
  agent.cubefulSearch = () => { throw new Error('cube OFFでcubeful探索を呼びました'); };
  const result = rankCheckerMoves(agent,
    context({ mode: 'money', jacoby: true, enabled: false, owner: 'center' }),
    [{ resultingBoard: candidate }], WHITE, 1);
  close(result.entries[0].equity, 0.6);
  assert.equal(result.unit, 'cube-units');
  assert.equal(result.evaluation, 'cube-disabled');
});

test('terminal single/gammon/backgammonと逆視点をMatch MWCで評価する', () => {
  const agent = makeAgent();
  const fixedCube = context({ scoreWhite: 3, scoreBlack: 3 });
  const value = (winner, winType) => scoreCheckerMoves(agent, fixedCube,
    [{ resultingBoard: board({ winner, winType }) }], WHITE)[0].value;
  close(value(WHITE, 1), 0.67736);
  close(value(WHITE, 2), 1.0);
  close(value(WHITE, 3), 1.0);
  close(value(BLACK, 1), 0.32264);
  close(value(BLACK, 2), 0.0);
  close(value(BLACK, 3), 0.0);

  const blackView = (winner, winType) => scoreCheckerMoves(agent, fixedCube,
    [{ resultingBoard: board({ winner, winType }) }], BLACK)[0].value;
  close(blackView(BLACK, 1), 0.67736);
  close(blackView(WHITE, 1), 0.32264);
});

test('Money cube ON uses the current cube owner and Jacoby only for untouched center', () => {
  const agent = makeAgent();
  const calls = [];
  agent.cubefulSearch = (...args) => {
    calls.push(args);
    return args[7].cubeValue === 1 ? 0.2 : 0.4;
  };
  agent.cubeEfficiencyDtFor = () => 0.3;
  const candidate = board();
  const result = scoreCheckerMoves(agent,
    context({ mode: 'money', jacoby: true, enabled: true, available: true }),
    [{ resultingBoard: candidate }], WHITE)[0];
  assert.equal(calls.length, 2);
  assert.equal(calls[0][2], 'center');
  assert.equal(calls[0][4], true);
  assert.equal(calls[0][7].cubeValue, 1);
  assert.equal(calls[1][2], 'opponent');
  assert.equal(calls[1][4], false);
  assert.equal(calls[1][7].actionContext, 'post_double_take');
  close(result.value, -0.8);

  calls.length = 0;
  scoreCheckerMoves(agent,
    context({ mode: 'money', jacoby: true, enabled: true, available: true, owner: BLACK, value: 2 }),
    [{ resultingBoard: candidate }], WHITE);
  assert.equal(calls[0][2], 'me');
  assert.equal(calls[0][4], false);
});

test('cube OFF Matchの選択、順位、Hint lossは同じMWC候補値を共有する', () => {
  const a = board();
  const b = board();
  const values = new WeakMap([[a, [0.8, 0.2, 0, 0, 0]], [b, [0.6, 0.1, 0, 0, 0]]]);
  const agent = makeAgent(values);
  const moves = [{ resultingBoard: a }, { resultingBoard: b }];
  const ctx = context({ enabled: false, owner: 'center' });
  const ranked = rankCheckerMoves(agent, ctx, moves, WHITE, 2);
  assert.equal(selectCheckerMove(agent, ctx, moves, WHITE), ranked.entries[0].index);
  close(ranked.entries[1].loss, ranked.entries[0].equity - ranked.entries[1].equity);
  assert.equal(ranked.unit, 'mwc');
  assert.equal(ranked.evaluation, 'cube-disabled');
  assert.deepEqual(Object.keys(ranked.entries[0].probabilities),
    ['win1', 'win2', 'win3', 'lose1', 'lose2', 'lose3']);
});

test('Match/GameからWorker DTOへscore・Crawford・Jacoby・権利が届く', () => {
  const makeMatch = ({ scoreWhite = 3, scoreBlack = 3, crawfordDone = false, useCube = true } = {}) => {
    let die = 0;
    const match = new Match({
      length: 5, useCube,
      rng: () => [0, 0.2][die++] ?? 0.2,
    });
    match.scores = { [WHITE]: scoreWhite, [BLACK]: scoreBlack };
    match.crawfordDone = crawfordDone;
    return { match, game: match.startGame() };
  };

  const pre = makeMatch();
  const preDto = checkerContextFor(pre.game, pre.match, WHITE);
  assert.deepEqual(preDto.match, {
    mode: 'match', targetPoints: 5, scoreWhite: 3, scoreBlack: 3,
    crawford: false, crawfordPlayed: false, jacoby: false,
  });
  assert.deepEqual(preDto.cube, {
    value: 1, owner: 'center', enabled: true, available: true,
  });

  const crawford = makeMatch({ scoreWhite: 4, scoreBlack: 3 });
  const crawfordDto = checkerContextFor(crawford.game, crawford.match, WHITE);
  assert.equal(crawfordDto.match.crawford, true);
  assert.equal(crawfordDto.match.crawfordPlayed, true);
  assert.equal(crawfordDto.cube.enabled, true);
  assert.equal(crawfordDto.cube.available, false);

  const post = makeMatch({ crawfordDone: true });
  const postDto = checkerContextFor(post.game, post.match, WHITE);
  assert.equal(postDto.match.crawford, false);
  assert.equal(postDto.match.crawfordPlayed, true);
  assert.equal(postDto.cube.available, true);

  const money = new Match({ length: MONEY, jacoby: true, useCube: false });
  const moneyGame = money.startGame();
  const moneyDto = checkerContextFor(moneyGame, money, WHITE);
  assert.deepEqual(moneyDto.match, { mode: 'money', jacoby: true });
  assert.equal(moneyDto.cube.enabled, false);
  assert.equal(moneyDto.cube.available, false);

  pre.game.cube.owner = WHITE;
  const previousOwnerDto = checkerContextFor(pre.game, pre.match, WHITE);
  assert.equal(previousOwnerDto.cube.enabled, true);
  assert.equal(previousOwnerDto.cube.available, false);
  assert.equal(previousOwnerDto.cube.owner, WHITE);
});

test('Money cubefulとMatch MWCは3-ply候補評価を1ロールまでに制限する', () => {
  const candidate = board();
  const move = [{ resultingBoard: candidate }];
  const agent = makeAgent();
  agent.searchPlies = 3;
  agent.cubeEfficiencyDtFor = () => 0;

  const moneyDepths = [];
  agent.cubefulSearch = (...args) => {
    moneyDepths.push(args[3]);
    return args[7].cubeValue === 1 ? 0.2 : 0.4;
  };
  scoreCheckerMoves(agent,
    context({ mode: 'money', enabled: true, available: true }), move, WHITE);
  assert.deepEqual(moneyDepths, [1, 1]);

  const matchDepths = [];
  agent.mwcSearch = (...args) => {
    matchDepths.push(args[3]);
    return 0.4;
  };
  scoreCheckerMoves(agent,
    context({ mode: 'match', enabled: true, available: true }), move, WHITE);
  assert.deepEqual(matchDepths, [1, 1]);

  matchDepths.length = 0;
  scoreCheckerMoves(agent,
    context({ mode: 'match', enabled: false, available: false }), move, WHITE);
  assert.deepEqual(matchDepths, [1]);

  const moneyOffDepths = [];
  agent.terminalVector = () => null;
  agent.expandRollsVector = (board, turn, depth) => {
    moneyOffDepths.push(depth);
    return [0.5, 0.1, 0, 0.1, 0];
  };
  scoreCheckerMoves(agent,
    context({ mode: 'money', enabled: false, available: false }), move, WHITE);
  assert.deepEqual(moneyOffDepths, [2]);
});
