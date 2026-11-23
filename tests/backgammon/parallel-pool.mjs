// 0.2.5 高速化同期・並列チェッカー/キューブ探索・ThinkerPool の検証。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Board, WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import { NeuralNet } from '../../docs/backgammon/src/nn.js';
import { Game, ROLLING } from '../../docs/backgammon/src/game.js';
import {
  agentFor,
  setBearoffDatabase,
  setMoneyBearoffDatabase,
} from '../../docs/backgammon/src/agent.js';
import {
  combineCheckerMoveRollChunks,
  evaluateCheckerMoveRollChunk,
  evaluateCheckerMovesSubset,
  evaluateCubeDecisionRollChunk,
  finalizeCubeDecisionParallel,
  prepareCubeDecisionParallel,
  rankCheckerMoves,
  selectCheckerMove,
} from '../../docs/backgammon/src/checker.js';
import { ThinkerPool, resolveWorkerSearchOptions } from '../../docs/backgammon/src/thinker-pool.js';
import { generateMoves, boardKey } from '../../docs/backgammon/src/rules.js';
import { loadBearoffForTests } from './bearoff-setup.mjs';

const model = JSON.parse(readFileSync(
  new URL('../../docs/backgammon/src/model.json', import.meta.url), 'utf8'));
const net = new NeuralNet(model);
const bearoff = loadBearoffForTests();
setBearoffDatabase(bearoff);
setMoneyBearoffDatabase(null);

function assertClose(actual, expected, tol = 1e-12, label = '') {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`,
  );
}

function boardDto(board) {
  return {
    points: [...board.points],
    bar: [board.bar[WHITE], board.bar[BLACK]],
    off: [board.off[WHITE], board.off[BLACK]],
  };
}

function mirrorBoard(board) {
  return new Board(
    [...board.points].reverse().map((v) => -v),
    { [WHITE]: board.bar[BLACK], [BLACK]: board.bar[WHITE] },
    { [WHITE]: board.off[BLACK], [BLACK]: board.off[WHITE] },
  );
}

// 1. IEEE 754 逐次加算順のビット一致回帰テスト（Sigmoid / SiLU）
{
  const BIG = 2 ** 54;
  const w2Col = [BIG, 1, 0, 0, -BIG, 0, 0, 0];
  for (const activation of ['sigmoid', 'silu']) {
    const data = {
      input_dim: 2,
      hidden_dims: [8, 4],
      output_dim: 1,
      activation,
      W1: [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]],
      b1: [15, 15, 15, 15, 15, 15, 15, 15],
      W2: w2Col.map((v) => [v, v, 0, 0]),
      b2: [0, 0, 0, 0],
      W3: [[1], [0], [0], [0]],
      b3: [0],
    };
    const synthetic = new NeuralNet(data);
    const x = new Float64Array([1, 0]);
    const out = synthetic.predict(x);
    const batch = synthetic.predictBatch([x])[0];
    const hidden = synthetic.lastHidden(x);
    assert.deepEqual(Array.from(batch), Array.from(out), `${activation} predictBatch`);
    if (activation === 'sigmoid') {
      assert.equal(hidden[0], 0.5, 'sequential summation must absorb +1 before subtracting 2^54');
    }
  }
}

// 2. resolveWorkerSearchOptions 契約
assert.deepEqual(resolveWorkerSearchOptions('champion', null), { mode: 'staged3ply', cubeFilterLevel: 1 });
assert.deepEqual(resolveWorkerSearchOptions('expert', null), { mode: 'legacy', cubeFilterLevel: null });
assert.deepEqual(resolveWorkerSearchOptions('intermediate', null), { mode: 'legacy', cubeFilterLevel: null });
assert.deepEqual(resolveWorkerSearchOptions('champion', 'legacy'), { mode: 'legacy', cubeFilterLevel: null });
assert.deepEqual(resolveWorkerSearchOptions('champion', 'staged3ply'), { mode: 'staged3ply', cubeFilterLevel: 1 });
assert.deepEqual(resolveWorkerSearchOptions('champion', 'full-root'), { mode: 'full-root', cubeFilterLevel: null });

// 3. worker.js と同じプロトコルを処理するインメモリ Worker で ThinkerPool を検証
let spawnedCount = 0;
let rollChunkCalls = 0;
let cubeChunkCalls = 0;

function createInMemoryWorker() {
  spawnedCount += 1;
  const agents = new Map();
  let defaultMode = 'legacy';
  const getAgent = (level, { mode = null, cubeFilterLevel = undefined } = {}) => {
    const effectiveMode = ['legacy', 'full-root', 'staged3ply'].includes(mode) ? mode : defaultMode;
    const key = `${level}|${effectiveMode}|${cubeFilterLevel ?? ''}`;
    let agent = agents.get(key);
    if (!agent) {
      const overrides = { checkerSearchMode: effectiveMode };
      if (cubeFilterLevel !== null && cubeFilterLevel !== undefined) {
        overrides.cubeFilterLevel = cubeFilterLevel;
      }
      agent = agentFor(net, level, overrides);
      agents.set(key, agent);
    }
    return agent;
  };
  const buildGame = (data) => {
    const game = new Game(Board.fromJson(data.board), Math.random, {
      jacoby: data.jacoby,
      crawford: Boolean(data.crawford),
      unboundedMoneyCube: data.match == null,
    });
    game.currentPlayer = data.player;
    game.state = ROLLING;
    game.cube.value = data.cubeValue;
    game.cube.owner = data.cubeOwner;
    if (data.ask === 'accept') game.proposeDouble();
    return game;
  };

  const worker = {
    onmessage: null,
    onerror: null,
    terminate() {},
    postMessage(data) {
      queueMicrotask(() => {
        const { id, kind } = data;
        try {
          if (kind === 'load') {
            defaultMode = data.checkerSearchMode ?? 'legacy';
            agents.clear();
            worker.onmessage?.({ data: { id, ok: true } });
            return;
          }
          if (kind === 'select') {
            const moves = generateMoves(Board.fromJson(data.board), data.player, data.die1, data.die2);
            const agent = getAgent(data.level, { mode: data.mode, cubeFilterLevel: data.cubeFilterLevel });
            const index = selectCheckerMove(agent, data.context, moves, data.player);
            worker.onmessage?.({ data: { id, ok: true, index, key: boardKey(moves[index].resultingBoard) } });
            return;
          }
          if (kind === 'rank') {
            const moves = generateMoves(Board.fromJson(data.board), data.player, data.die1, data.die2);
            const agent = getAgent(data.level, { mode: data.mode, cubeFilterLevel: data.cubeFilterLevel });
            const result = rankCheckerMoves(agent, data.context, moves, data.player, data.limit ?? 3);
            worker.onmessage?.({
              data: {
                id,
                ok: true,
                unit: result.unit,
                evaluation: result.evaluation,
                entries: result.entries.map((entry) => ({
                  index: entry.index,
                  key: boardKey(entry.move.resultingBoard),
                  equity: entry.equity,
                  loss: entry.loss,
                  probabilities: entry.probabilities,
                })),
              },
            });
            return;
          }
          if (kind === 'eval-checker-subset') {
            const moves = generateMoves(Board.fromJson(data.board), data.player, data.die1, data.die2);
            const agent = getAgent(data.level, { mode: data.mode, cubeFilterLevel: data.cubeFilterLevel });
            const entries = evaluateCheckerMovesSubset(agent, data.context, moves, data.player, {
              moveIndices: data.moveIndices,
              depth: data.depth,
              efficienciesByIndex: data.efficienciesByIndex,
              mode: data.mode,
            });
            worker.onmessage?.({ data: { id, ok: true, entries } });
            return;
          }
          if (kind === 'eval-checker-roll-chunk') {
            rollChunkCalls += 1;
            const moves = generateMoves(Board.fromJson(data.board), data.player, data.die1, data.die2);
            const agent = getAgent(data.level, { mode: data.mode, cubeFilterLevel: data.cubeFilterLevel });
            const chunk = evaluateCheckerMoveRollChunk(agent, data.context, moves[data.moveIndex], data.player, {
              depth: data.depth,
              rollIndices: data.rollIndices,
              efficiencies: data.efficiencies,
            });
            worker.onmessage?.({ data: { id, ok: true, chunk } });
            return;
          }
          if (kind === 'prepare-cube-parallel') {
            const agent = getAgent(data.level);
            const game = buildGame(data);
            const prepared = prepareCubeDecisionParallel(agent, game, data.match ?? null, data.ask);
            worker.onmessage?.({ data: { id, ok: true, prepared } });
            return;
          }
          if (kind === 'eval-cube-roll-chunk') {
            cubeChunkCalls += 1;
            const agent = getAgent(data.level);
            const game = buildGame(data);
            const chunk = evaluateCubeDecisionRollChunk(
              agent, game, data.match ?? null, data.rollIndices, data.context);
            worker.onmessage?.({ data: { id, ok: true, chunk } });
            return;
          }
          throw new Error(`unknown kind: ${kind}`);
        } catch (error) {
          worker.onmessage?.({ data: { id, ok: false, error: String(error?.message ?? error) } });
        }
      });
    },
  };
  return worker;
}

const pool = new ThinkerPool({
  maxWorkers: 4,
  createWorker: createInMemoryWorker,
});
assert.equal(await pool.start({ url: 'memory://model.json' }), true);
assert.equal(spawnedCount, 1, 'initial start spawns only 1 worker');

const startBoard = new Board();
const moneyCtx = {
  cube: { value: 1, owner: 'center', enabled: true, available: true, unboundedMoney: true },
  match: { mode: 'money', jacoby: true },
};
const matchCtx = {
  cube: { value: 1, owner: 'center', enabled: true, available: true, unboundedMoney: false },
  match: {
    mode: 'match', targetPoints: 5, scoreWhite: 2, scoreBlack: 3,
    crawford: false, crawfordPlayed: false, jacoby: false,
  },
};

// 3a. 0-ply 段は追加 Worker を起動せずに単一 Worker で処理する
{
  const moves = generateMoves(startBoard, WHITE, 3, 1);
  const reply = await pool.chooseMove({
    boardDto: boardDto(startBoard),
    player: WHITE,
    die1: 3,
    die2: 1,
    level: 'advanced',
    moves,
    context: moneyCtx,
  });
  const ref = selectCheckerMove(agentFor(net, 'advanced'), moneyCtx, moves, WHITE);
  assert.equal(reply.index, ref, '0-ply single worker matches reference');
  assert.equal(spawnedCount, 1, '0-ply does not spawn extra workers');
}

// 3b. 2-ply expert 着手 & ヒント（White / Black、Money / Match）の並列一致
for (const player of [WHITE, BLACK]) {
  const board = player === WHITE ? startBoard : mirrorBoard(startBoard);
  const moves = generateMoves(board, player, 3, 1);
  for (const [label, ctx] of [['money', moneyCtx], ['match', matchCtx]]) {
    const reply = await pool.chooseMove({
      boardDto: boardDto(board),
      player,
      die1: 3,
      die2: 1,
      level: 'expert',
      moves,
      context: ctx,
    });
    const refAgent = agentFor(net, 'expert');
    assert.equal(reply.index, selectCheckerMove(refAgent, ctx, moves, player), `expert ${player} ${label} select`);

    const ranked = await pool.rankMoves({
      boardDto: boardDto(board),
      player,
      die1: 3,
      die2: 1,
      level: 'expert',
      moves,
      context: ctx,
      limit: 3,
      adviceAgent: refAgent,
    });
    const refRank = rankCheckerMoves(refAgent, ctx, moves, player, 3);
    assert.equal(ranked.unit, refRank.unit);
    assert.equal(ranked.evaluation, refRank.evaluation);
    assert.deepEqual(
      ranked.entries.map((e) => e.index),
      refRank.entries.map((e) => e.index),
      `expert ${player} ${label} rank order`,
    );
    for (let i = 0; i < refRank.entries.length; i += 1) {
      assertClose(ranked.entries[i].equity, refRank.entries[i].equity, 1e-12, `rank equity ${i}`);
      assertClose(ranked.entries[i].loss, refRank.entries[i].loss, 1e-12, `rank loss ${i}`);
    }
  }
}
assert.equal(spawnedCount, 4, '2-ply scales up pool to 4 workers');

// 3c. champion 段（既定 staged3ply + cubeFilterLevel: 1）の並列一致 + 候補数 < 4 でのロール分割一致
{
  const moves = generateMoves(startBoard, WHITE, 3, 1);
  const reply = await pool.chooseMove({
    boardDto: boardDto(startBoard),
    player: WHITE,
    die1: 3,
    die2: 1,
    level: 'champion',
    moves,
    context: moneyCtx,
  });
  const refChampion = agentFor(net, 'champion', { checkerSearchMode: 'staged3ply', cubeFilterLevel: 1 });
  assert.equal(reply.index, selectCheckerMove(refChampion, moneyCtx, moves, WHITE), 'champion staged3ply opening');

  // 候補数が 2 手だけの局面でロール分割（eval-checker-roll-chunk）が使われ、単一経路と一致すること
  const twoMoves = moves.slice(0, 2);
  const beforeChunks = rollChunkCalls;
  const twoReply = await pool.chooseMove({
    boardDto: boardDto(startBoard),
    player: WHITE,
    die1: 3,
    die2: 1,
    level: 'expert',
    moves: twoMoves,
    context: moneyCtx,
  });
  assert.ok(rollChunkCalls > beforeChunks, 'fewer moves than workers triggers roll-chunk parallelization');
  const refExpert = agentFor(net, 'expert');
  assert.equal(twoReply.index, selectCheckerMove(refExpert, moneyCtx, twoMoves, WHITE), 'roll-chunk select parity');

  // 直接 combineCheckerMoveRollChunks と evaluateCheckerMovesSubset の厳密一致も確認
  const chunks = [[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12, 13, 14, 15], [16, 17, 18, 19, 20]]
    .map((rollIndices) => evaluateCheckerMoveRollChunk(refExpert, matchCtx, twoMoves[0], WHITE, {
      depth: 1, rollIndices,
    }));
  const combined = combineCheckerMoveRollChunks(WHITE, chunks);
  const serial = evaluateCheckerMovesSubset(refExpert, matchCtx, twoMoves, WHITE, {
    moveIndices: [0], depth: 1,
  })[0].equity;
  assertClose(combined, serial, 1e-12, 'combineCheckerMoveRollChunks match parity');
}

// 4. 並列キューブ判断（Money / Match、double / accept、際どい roll-chunks 経路含む）の一致検証
{
  const makeGame = (board, player, isMoney, ask) => {
    const game = new Game(board.clone(), Math.random, { jacoby: isMoney, unboundedMoneyCube: isMoney });
    game.currentPlayer = player;
    game.state = ROLLING;
    game.cube.value = 1;
    game.cube.owner = null;
    if (ask === 'accept') game.proposeDouble();
    return game;
  };
  const matchCubeCtx = { length: 5, away: { [WHITE]: 3, [BLACK]: 2 }, crawfordPlayed: false };
  const closeBoard = new Board(
    [-2, 0, 0, 0, 0, 4, 0, 3, 0, 0, 0, -4, 4, 0, 0, 0, -3, 0, -4, 0, 0, 0, 0, 2],
    { [WHITE]: 0, [BLACK]: 0 },
    { [WHITE]: 2, [BLACK]: 2 },
  );

  for (const [label, board, player, matchObj, ask, level] of [
    ['money-double-start', startBoard, WHITE, null, 'double', 'expert'],
    ['money-accept-close', closeBoard, WHITE, null, 'accept', 'expert'],
    ['match-double-close', closeBoard, WHITE, matchCubeCtx, 'double', 'expert'],
    ['match-accept-close', closeBoard, BLACK, matchCubeCtx, 'accept', 'expert'],
    ['beginner-accept', closeBoard, WHITE, null, 'accept', 'beginner'],
  ]) {
    const game = makeGame(board, player, matchObj === null, ask);
    const refAgent = agentFor(net, level);
    const refAnswer = ask === 'accept'
      ? refAgent.shouldAcceptDouble(game, matchObj)
      : refAgent.shouldDouble(game, matchObj);
    const parallelAnswer = await pool.decideCube({
      boardDto: boardDto(board),
      player,
      cubeValue: game.cube.value,
      cubeOwner: game.cube.owner,
      jacoby: game.jacoby,
      crawford: game.crawford,
      level,
      match: matchObj,
      ask,
      game,
    });
    assert.equal(parallelAnswer, refAnswer, `cube decision parity: ${label}`);
  }
  assert.ok(cubeChunkCalls > 0, 'accept/close cube decisions exercised roll-chunk parallel path');

  // 直接 finalizeCubeDecisionParallel と shouldAcceptDouble の一致も検証
  const gAccept = makeGame(closeBoard, WHITE, true, 'accept');
  const expAgent = agentFor(net, 'expert');
  const prepared = prepareCubeDecisionParallel(expAgent, gAccept, null, 'accept');
  assert.equal(prepared.kind, 'roll-chunks');
  const chunks = [[0, 1, 2, 3, 4, 5], [6, 7, 8, 9, 10], [11, 12, 13, 14, 15], [16, 17, 18, 19, 20]]
    .map((rollIndices) => evaluateCubeDecisionRollChunk(expAgent, gAccept, null, rollIndices, prepared.context));
  assert.equal(
    finalizeCubeDecisionParallel(gAccept, null, chunks, prepared.context),
    expAgent.shouldAcceptDouble(gAccept, null),
    'direct parallel cube accept matches shouldAcceptDouble',
  );
}

pool.terminate();

// 5. Worker 追加起動失敗・初期化失敗・全滅時に無限ループせず安全に縮退 / reject すること
{
  const moves = generateMoves(startBoard, WHITE, 3, 1);
  const refExpert = agentFor(net, 'expert');
  const expectedMove = selectCheckerMove(refExpert, moneyCtx, moves, WHITE);
  const expectedRank = rankCheckerMoves(refExpert, moneyCtx, moves, WHITE, 3);
  const closeBoard = new Board(
    [-2, 0, 0, 0, 0, 4, 0, 3, 0, 0, 0, -4, 4, 0, 0, 0, -3, 0, -4, 0, 0, 0, 0, 2],
    { [WHITE]: 0, [BLACK]: 0 },
    { [WHITE]: 2, [BLACK]: 2 },
  );
  const makeCloseAcceptGame = () => {
    const game = new Game(closeBoard.clone(), Math.random, { jacoby: true, unboundedMoneyCube: true });
    game.currentPlayer = WHITE;
    game.state = ROLLING;
    game.cube.value = 1;
    game.cube.owner = null;
    game.proposeDouble();
    return game;
  };
  const expectedAccept = refExpert.shouldAcceptDouble(makeCloseAcceptGame(), null);

  // 5a. 1 本目は起動成功、2 本目以降の createWorker() が例外を投げるケース
  let attempts = 0;
  const degradedPool = new ThinkerPool({
    maxWorkers: 4,
    createWorker: () => {
      attempts += 1;
      if (attempts > 1) throw new Error('CSP / resource limit');
      return createInMemoryWorker();
    },
  });
  assert.equal(await degradedPool.start({ url: 'memory://model.json' }), true);
  assert.equal(attempts, 1);

  const degradedChoice = await degradedPool.chooseMove({
    boardDto: boardDto(startBoard),
    player: WHITE,
    die1: 3,
    die2: 1,
    level: 'expert',
    moves,
    context: moneyCtx,
  });
  assert.equal(degradedChoice.index, expectedMove, 'degraded 1-worker chooseMove matches reference');
  assert.equal(attempts, 2, 'scale-up stops immediately after first createWorker failure');

  const degradedRank = await degradedPool.rankMoves({
    boardDto: boardDto(startBoard),
    player: WHITE,
    die1: 3,
    die2: 1,
    level: 'expert',
    moves,
    context: moneyCtx,
    limit: 3,
    adviceAgent: refExpert,
  });
  assert.deepEqual(
    degradedRank.entries.map((entry) => entry.index),
    expectedRank.entries.map((entry) => entry.index),
    'degraded 1-worker rankMoves matches reference',
  );
  assert.equal(attempts, 3, 'rankMoves scale-up also stops immediately on failure');

  const acceptGame = makeCloseAcceptGame();
  const degradedCube = await degradedPool.decideCube({
    boardDto: boardDto(closeBoard),
    player: WHITE,
    cubeValue: acceptGame.cube.value,
    cubeOwner: acceptGame.cube.owner,
    jacoby: acceptGame.jacoby,
    crawford: acceptGame.crawford,
    level: 'expert',
    match: null,
    ask: 'accept',
    game: acceptGame,
  });
  assert.equal(degradedCube, expectedAccept, 'degraded 1-worker decideCube matches reference');
  assert.equal(attempts, 4, 'decideCube scale-up also stops immediately on failure');
  degradedPool.terminate();

  // 5b. 2 本目以降の load 初期化が非同期失敗（ok:false）するケース
  let asyncCreated = 0;
  const loadFailPool = new ThinkerPool({
    maxWorkers: 4,
    createWorker: () => {
      asyncCreated += 1;
      if (asyncCreated === 1) return createInMemoryWorker();
      const broken = {
        onmessage: null,
        onerror: null,
        terminate() {},
        postMessage(data) {
          queueMicrotask(() => {
            broken.onmessage?.({ data: { id: data.id, ok: false, error: 'load failed' } });
          });
        },
      };
      return broken;
    },
  });
  assert.equal(await loadFailPool.start({ url: 'memory://model.json' }), true);
  const loadFailChoice = await loadFailPool.chooseMove({
    boardDto: boardDto(startBoard),
    player: WHITE,
    die1: 3,
    die2: 1,
    level: 'expert',
    moves,
    context: moneyCtx,
  });
  assert.equal(loadFailChoice.index, expectedMove, 'async load failure on extra workers degrades safely');
  loadFailPool.terminate();

  // 5c. 初回起動失敗および全 Worker 死亡＋再起動不可で明示的に reject（fallback 到達可能）
  const deadPool = new ThinkerPool({
    maxWorkers: 4,
    createWorker: () => { throw new Error('workers blocked'); },
  });
  assert.equal(await deadPool.start({ url: 'memory://model.json' }), false);
  assert.equal(deadPool.available, false);
  await assert.rejects(
    () => deadPool.chooseMove({
      boardDto: boardDto(startBoard),
      player: WHITE,
      die1: 3,
      die2: 1,
      level: 'expert',
      moves,
      context: moneyCtx,
    }),
    /worker なし/,
    'chooseMove rejects explicitly when no workers can spawn',
  );
  await assert.rejects(
    () => deadPool.rankMoves({
      boardDto: boardDto(startBoard),
      player: WHITE,
      die1: 3,
      die2: 1,
      level: 'expert',
      moves,
      context: moneyCtx,
      limit: 3,
      adviceAgent: refExpert,
    }),
    /worker なし/,
    'rankMoves rejects explicitly when no workers can spawn',
  );
  const deadCubeGame = makeCloseAcceptGame();
  await assert.rejects(
    () => deadPool.decideCube({
      boardDto: boardDto(closeBoard),
      player: WHITE,
      cubeValue: deadCubeGame.cube.value,
      cubeOwner: deadCubeGame.cube.owner,
      jacoby: deadCubeGame.jacoby,
      crawford: deadCubeGame.crawford,
      level: 'expert',
      match: null,
      ask: 'accept',
      game: deadCubeGame,
    }),
    /worker なし/,
    'decideCube rejects explicitly when no workers can spawn',
  );
  deadPool.terminate();
}

console.log('OK: parallel-pool (0.2.5 sync, sequential NN, 4-worker checker/hint/cube parity, spawn failure handling)');
