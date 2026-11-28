// Issue #578 Phase 4c: miniapp WASM バックエンド統合テスト
// - 固定資産 SHA-256（bg_engine_scalar.wasm / bg_engine_simd.wasm / metadata.json）検証
// - WASM (auto) vs JS パリティ（White & Black、beginner blotPenalty/margin 維持含む）
// - Worker / ThinkerPool の既定 auto -> WASM 起動、?backend=js 切り戻し、dispose 検証

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Board, WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import { Game, ROLLING } from '../../docs/backgammon/src/game.js';
import { Match, MONEY } from '../../docs/backgammon/src/match.js';
import { NeuralNet } from '../../docs/backgammon/src/nn.js';
import { BearoffDatabase } from '../../docs/backgammon/src/bearoff.js';
import { MoneyBearoffDatabase } from '../../docs/backgammon/src/money-bearoff.js';
import {
  agentFor,
  setBearoffDatabase,
  setMoneyBearoffDatabase,
  setPruneNet,
} from '../../docs/backgammon/src/agent.js';
import {
  checkerContextFor,
  evaluateCheckerMoveRollChunk,
  evaluateCheckerMovesSubset,
  rankCheckerMoves,
  selectCheckerMove,
} from '../../docs/backgammon/src/checker.js';
import { ThinkerPool } from '../../docs/backgammon/src/thinker-pool.js';
import { generateMoves, generateMovesJs, boardKey } from '../../docs/backgammon/src/rules.js';
import {
  disposeWasmEngine,
  getEngineBackendStatus,
  initWasmEngine,
  setEngineBackend,
} from '../../docs/backgammon/src/wasm-backend.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BG_ROOT = resolve(HERE, '../../docs/backgammon');

const EXPECTED_SHA = {
  engineSourceSha: 'a1ec1daed55c2bee291bdcea6c136599491a4868',
  enginePackageVersion: '0.2.8',
  wasmScalarSha256: '2e0a4e5a249ee3d1d4d26ec4045d3dcf6d83f0285aa594521359e7e7edbabfb1',
  wasmSimdSha256: '9b6a43b0bfa1e5ecd22c626277eccdd721ef4b7929251395ce4f895f485929b9',
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function testPinnedAssets() {
  const meta = JSON.parse(await readFile(resolve(BG_ROOT, 'assets/metadata.json'), 'utf8'));
  assert.equal(meta.engineSourceSha, EXPECTED_SHA.engineSourceSha);
  assert.equal(meta.enginePackageVersion, EXPECTED_SHA.enginePackageVersion);
  assert.equal(meta.wasmScalarSha256, EXPECTED_SHA.wasmScalarSha256);
  assert.equal(meta.wasmSimdSha256, EXPECTED_SHA.wasmSimdSha256);

  const scalarBytes = await readFile(resolve(BG_ROOT, 'assets/bg_engine_scalar.wasm'));
  const simdBytes = await readFile(resolve(BG_ROOT, 'assets/bg_engine_simd.wasm'));
  assert.equal(sha256(scalarBytes), EXPECTED_SHA.wasmScalarSha256);
  assert.equal(sha256(simdBytes), EXPECTED_SHA.wasmSimdSha256);
  console.log('1. Pinned WASM asset SHA-256: PASS');
}

async function testWasmVsJsParityBothSides() {
  const modelJson = JSON.parse(await readFile(resolve(BG_ROOT, 'src/model.json'), 'utf8'));
  const pruneJson = JSON.parse(await readFile(resolve(BG_ROOT, 'src/prune_net.json'), 'utf8'));
  const bearoffBuf = await readFile(resolve(BG_ROOT, 'src/bearoff-6x15.bin'));
  const moneyBuf = await readFile(resolve(BG_ROOT, 'src/money-bg2n-6x6-v4.bin'));

  const net = new NeuralNet(modelJson);
  const pruneNet = new NeuralNet(pruneJson);
  const bearoff = new BearoffDatabase(
    bearoffBuf.buffer.slice(bearoffBuf.byteOffset, bearoffBuf.byteOffset + bearoffBuf.byteLength),
  );
  const moneyDb = await MoneyBearoffDatabase.fromArrayBuffer(
    moneyBuf.buffer.slice(moneyBuf.byteOffset, moneyBuf.byteOffset + moneyBuf.byteLength),
  );

  setBearoffDatabase(bearoff);
  setMoneyBearoffDatabase(moneyDb);
  setPruneNet(pruneNet);

  try {
    disposeWasmEngine();
    setEngineBackend('auto');
    const status = await initWasmEngine({ variant: 'auto' });
    assert.equal(status.configuredBackend, 'auto');
    assert.equal(status.activeBackend, 'wasm');
    assert.equal(status.wasmReady, true);
    assert.ok(status.runtimeId !== null);
    assert.equal(status.fallbackReason, null);

    // White & Black movegen + expert 2-ply + beginner (blotPenalty/margins) parity
    for (const player of [WHITE, BLACK]) {
      const board = new Board();
      const wasmMoves = generateMoves(board, player, 3, 1, 'wasm');
      const jsMoves = generateMovesJs(board, player, 3, 1);
      assert.deepEqual(
        wasmMoves.map((m) => boardKey(m.resultingBoard)),
        jsMoves.map((m) => boardKey(m.resultingBoard)),
        `movegen mismatch for ${player}`,
      );

      const match = new Match({ length: MONEY, jacoby: true, useCube: true, unboundedMoneyCube: true });
      const game = match.startGame();
      game.currentPlayer = player;
      const ctx = checkerContextFor(game, match, player);

      const wasmExpert = agentFor(net, 'expert', { backend: 'wasm' });
      const jsExpert = agentFor(net, 'expert', { backend: 'js' });
      const wasmRank = rankCheckerMoves(wasmExpert, ctx, wasmMoves, player, 3);
      const jsRank = rankCheckerMoves(jsExpert, ctx, jsMoves, player, 3);
      assert.equal(
        boardKey(wasmRank.entries[0].move.resultingBoard),
        boardKey(jsRank.entries[0].move.resultingBoard),
        `expert 2-ply top move mismatch for ${player}`,
      );
      assert.ok(
        Math.abs(wasmRank.entries[0].equity - jsRank.entries[0].equity) < 1e-5,
        `expert 2-ply equity diff too large for ${player}`,
      );

      // Beginner preserves blotPenalty / noise / cube margins identically across backends
      const wasmBeginner = agentFor(net, 'beginner', { backend: 'wasm' });
      const jsBeginner = agentFor(net, 'beginner', { backend: 'js' });
      assert.equal(wasmBeginner.blotPenalty, 0.20);
      assert.equal(wasmBeginner.doubleMargin, 0.25);
      assert.equal(wasmBeginner.takeMargin, -0.10);
      assert.equal(
        wasmBeginner.selectMove(wasmMoves, player),
        jsBeginner.selectMove(jsMoves, player),
        `beginner cubeless selectMove mismatch for ${player}`,
      );
      assert.equal(
        selectCheckerMove(wasmBeginner, ctx, wasmMoves, player),
        selectCheckerMove(jsBeginner, ctx, jsMoves, player),
        `beginner cubeful selectCheckerMove mismatch for ${player}`,
      );

      // Money BG2N 6x6 cube decision parity (White & Black)
      const pts = new Array(24).fill(0);
      pts[0] = 2; pts[1] = 2; pts[2] = 1;
      pts[23] = -2; pts[22] = -2; pts[21] = -1;
      const bg2nGame = new Game(Board.fromJson({ points: pts, bar: [0, 0], off: [10, 10] }), Math.random, {
        jacoby: false,
        unboundedMoneyCube: true,
      });
      bg2nGame.currentPlayer = player;
      bg2nGame.state = ROLLING;
      assert.equal(
        wasmExpert.shouldDouble(bg2nGame, null),
        jsExpert.shouldDouble(bg2nGame, null),
        `BG2N shouldDouble mismatch for ${player}`,
      );
    }

    disposeWasmEngine();
    assert.equal(getEngineBackendStatus().wasmReady, false);
    console.log(`2. WASM (${status.wasmVariant}) vs JS parity (White & Black, beginner/expert/BG2N): PASS`);
  } finally {
    disposeWasmEngine();
    setEngineBackend('auto');
    setBearoffDatabase(null);
    setMoneyBearoffDatabase(null);
    setPruneNet(null);
  }
}

async function testThinkerPoolDiagnosticsAndMixedBackends() {
  const modelJson = JSON.parse(await readFile(resolve(BG_ROOT, 'src/model.json'), 'utf8'));
  const pruneJson = JSON.parse(await readFile(resolve(BG_ROOT, 'src/prune_net.json'), 'utf8'));
  const bearoffBuf = await readFile(resolve(BG_ROOT, 'src/bearoff-6x15.bin'));

  const net = new NeuralNet(modelJson);
  const pruneNet = new NeuralNet(pruneJson);
  const bearoff = new BearoffDatabase(
    bearoffBuf.buffer.slice(bearoffBuf.byteOffset, bearoffBuf.byteOffset + bearoffBuf.byteLength),
  );

  setBearoffDatabase(bearoff);
  setMoneyBearoffDatabase(null);
  setPruneNet(pruneNet);

  const toBoardDto = (board) => ({
    points: [...board.points],
    bar: [board.bar[WHITE], board.bar[BLACK]],
    off: [board.off[WHITE], board.off[BLACK]],
  });

  const makeInMemoryWorker = ({
    backend,
    statusRef,
    counters,
  }) => {
    const agents = new Map();
    const getAgent = (level, { mode = 'legacy', cubeFilterLevel = undefined } = {}) => {
      const key = `${level}|${mode}|${cubeFilterLevel ?? ''}|${backend}`;
      let agent = agents.get(key);
      if (!agent) {
        const overrides = {
          checkerSearchMode: mode,
          pruneNet,
          backend,
        };
        if (cubeFilterLevel !== null && cubeFilterLevel !== undefined) {
          overrides.cubeFilterLevel = cubeFilterLevel;
        }
        agent = agentFor(net, level, overrides);
        agents.set(key, agent);
      }
      return agent;
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
              worker.onmessage?.({
                data: {
                  id,
                  ok: true,
                  pruneNetLoaded: true,
                  pruneNetStatus: 'loaded',
                  backendStatus: { ...statusRef.current },
                },
              });
              return;
            }
            if (kind === 'status') {
              worker.onmessage?.({
                data: {
                  id,
                  ok: true,
                  backendStatus: { ...statusRef.current },
                },
              });
              return;
            }
            if (kind === 'dispose') {
              statusRef.current = {
                ...statusRef.current,
                activeBackend: 'js',
                wasmReady: false,
                wasmVariant: null,
                simdActive: false,
                runtimeId: null,
                linearMemoryBytes: null,
              };
              worker.onmessage?.({
                data: {
                  id,
                  ok: true,
                  backendStatus: { ...statusRef.current },
                },
              });
              return;
            }
            if (kind === 'eval-checker-subset') {
              counters.subsetCalls += 1;
              const moves = generateMoves(Board.fromJson(data.board), data.player, data.die1, data.die2, backend);
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
              counters.rollChunkCalls += 1;
              const moves = generateMoves(Board.fromJson(data.board), data.player, data.die1, data.die2, backend);
              const agent = getAgent(data.level, { mode: data.mode, cubeFilterLevel: data.cubeFilterLevel });
              const chunk = evaluateCheckerMoveRollChunk(agent, data.context, moves[data.moveIndex], data.player, {
                rollIndices: data.rollIndices,
                depth: data.depth,
                efficiencies: data.efficiencies,
              });
              worker.onmessage?.({ data: { id, ok: true, chunk } });
              return;
            }
            throw new Error(`unexpected worker message: ${kind}`);
          } catch (error) {
            worker.onmessage?.({
              data: { id, ok: false, error: error instanceof Error ? error.message : String(error) },
            });
          }
        });
      },
    };
    return worker;
  };

  try {
    // 3a. Live diagnostics: 0 -> 1 -> 4 lazy expansion, refreshBackendStatuses() mixed transition, dispose()
    disposeWasmEngine();
    setEngineBackend('auto');
    const wasmStatus = await initWasmEngine({ variant: 'auto' });
    const statusRefs = [];
    const counters = { subsetCalls: 0, rollChunkCalls: 0 };
    const diagPool = new ThinkerPool({
      maxWorkers: 4,
      createWorker: () => {
        const idx = statusRefs.length;
        const ref = {
          current: {
            ...wasmStatus,
            runtimeId: idx + 1,
          },
        };
        statusRefs.push(ref);
        return makeInMemoryWorker({ backend: 'wasm', statusRef: ref, counters });
      },
    });

    assert.equal(diagPool.backendStatus.workerCount, 0);
    assert.equal(diagPool.backendStatus.activeBackend, 'none');
    assert.equal(diagPool.backendStatus.allWasm, false);

    assert.equal(await diagPool.start({ url: 'mock-model' }), true);
    assert.equal(diagPool.backendStatus.workerCount, 1);
    assert.equal(diagPool.backendStatus.activeBackend, 'wasm');
    assert.equal(diagPool.backendStatus.allWasm, true);

    const openBoard = new Board();
    const match = new Match({ length: MONEY, jacoby: true, useCube: true, unboundedMoneyCube: true });
    const game = match.startGame();
    game.currentPlayer = WHITE;
    const ctx = checkerContextFor(game, match, WHITE);
    const openMoves = generateMoves(openBoard, WHITE, 3, 1, 'js');
    await diagPool.chooseMove({
      boardDto: toBoardDto(openBoard),
      player: WHITE,
      die1: 3,
      die2: 1,
      level: 'expert',
      moves: openMoves,
      context: ctx,
    });
    assert.equal(diagPool.backendStatus.workerCount, 4, '2-ply search should lazily expand 1 -> 4 workers');
    assert.equal(diagPool.backendStatus.allWasm, true);
    assert.deepEqual(diagPool.backendStatus.runtimeIds, [1, 2, 3, 4]);

    // Simulate runtime fallback on worker #2 and confirm refreshBackendStatuses() reflects mixed state
    statusRefs[2].current = {
      ...statusRefs[2].current,
      activeBackend: 'js',
      wasmReady: false,
      wasmVariant: null,
      simdActive: false,
      runtimeId: null,
      fallbackReason: 'simulated-oom',
      linearMemoryBytes: null,
    };
    const refreshed = await diagPool.refreshBackendStatuses();
    assert.equal(refreshed.workerCount, 4);
    assert.equal(refreshed.activeBackend, 'mixed');
    assert.equal(refreshed.allWasm, false);
    assert.deepEqual(refreshed.fallbackReasons, ['simulated-oom']);
    assert.equal(diagPool.backendStatus.activeBackend, 'mixed');
    assert.equal(diagPool.backendStatus.allWasm, false);

    await diagPool.dispose();
    assert.equal(diagPool.backendStatus.workerCount, 0);
    assert.equal(diagPool.backendStatus.activeBackend, 'none');
    assert.equal(diagPool.backendStatus.allWasm, false);
    console.log('3. ThinkerPool live diagnostics (0 -> 1 -> 4 -> mixed -> disposed): PASS');

    // 3b. Mixed WASM (simd & scalar passes) + JS Workers in ThinkerPool: subset & roll-chunk parity (White & Black)
    const variantsToTest = wasmStatus.simdActive ? ['simd', 'scalar'] : ['scalar'];
    for (const variant of variantsToTest) {
      disposeWasmEngine();
      setEngineBackend('auto');
      const activeWasm = await initWasmEngine({ variant });
      assert.equal(activeWasm.wasmVariant, variant);

      const workerBackends = ['wasm', 'js', 'wasm', 'js'];
      let spawnIdx = 0;
      const mixCounters = { subsetCalls: 0, rollChunkCalls: 0 };
      const mixedPool = new ThinkerPool({
        maxWorkers: 4,
        createWorker: () => {
          const i = spawnIdx++;
          const backend = workerBackends[i % workerBackends.length];
          const ref = {
            current: backend === 'wasm'
              ? { ...activeWasm, runtimeId: i + 1 }
              : {
                configuredBackend: 'auto',
                activeBackend: 'js',
                wasmReady: false,
                wasmVariant: null,
                simdActive: false,
                runtimeId: null,
                fallbackReason: 'simulated-mixed-js',
                simdFallbackReason: null,
                abiVersion: null,
                linearMemoryBytes: null,
              },
          };
          return makeInMemoryWorker({ backend, statusRef: ref, counters: mixCounters });
        },
      });

      assert.equal(await mixedPool.start({ url: 'mock-model' }), true);

      for (const player of [WHITE, BLACK]) {
        const m = new Match({ length: MONEY, jacoby: true, useCube: true, unboundedMoneyCube: true });
        const g = m.startGame();
        g.currentPlayer = player;
        const c = checkerContextFor(g, m, player);
        const jsExpert = agentFor(net, 'expert', { backend: 'js', pruneNet });

        // Subset split (many candidates across mixed WASM + JS workers)
        const b1 = new Board();
        const moves1 = generateMovesJs(b1, player, 3, 1);
        const ref1 = rankCheckerMoves(jsExpert, c, moves1, player, 3);
        const mix1 = await mixedPool.chooseMove({
          boardDto: toBoardDto(b1),
          player,
          die1: 3,
          die2: 1,
          level: 'expert',
          moves: moves1,
          context: c,
        });
        assert.equal(mixedPool.backendStatus.workerCount, 4);
        assert.equal(mixedPool.backendStatus.activeBackend, 'mixed');
        assert.equal(mixedPool.backendStatus.allWasm, false);
        assert.equal(mix1.key, boardKey(ref1.entries[0].move.resultingBoard), `mixed ${variant}+js subset top move mismatch (${player})`);
        assert.ok(
          Math.abs(mix1.scored[0].value - ref1.entries[0].equity) < 1e-5,
          `mixed ${variant}+js subset equity diff too large (${player})`,
        );

        // Roll-chunk split (2 legal non-bearoff moves across 4 mixed WASM + JS workers)
        const pts = new Array(24).fill(0);
        let bar;
        if (player === WHITE) {
          pts[23] = -2; pts[22] = -2; pts[21] = -2; pts[20] = -2; pts[19] = -2; pts[15] = -5;
          pts[10] = 1; pts[0] = 13;
          bar = { [WHITE]: 1, [BLACK]: 0 };
        } else {
          pts[0] = 2; pts[1] = 2; pts[2] = 2; pts[3] = 2; pts[4] = 2; pts[8] = 5;
          pts[13] = -1; pts[23] = -13;
          bar = { [WHITE]: 0, [BLACK]: 1 };
        }
        const b2 = new Board(pts, bar, { [WHITE]: 0, [BLACK]: 0 });
        const moves2 = generateMovesJs(b2, player, 6, 5);
        assert.equal(moves2.length, 2, `expected 2 legal moves for roll-chunk test (${player}), got ${moves2.length}`);
        const ref2 = rankCheckerMoves(jsExpert, c, moves2, player, 2);
        const mix2 = await mixedPool.chooseMove({
          boardDto: toBoardDto(b2),
          player,
          die1: 6,
          die2: 5,
          level: 'expert',
          moves: moves2,
          context: c,
        });
        assert.equal(mix2.key, boardKey(ref2.entries[0].move.resultingBoard), `mixed ${variant}+js roll-chunk top move mismatch (${player})`);
        assert.ok(
          Math.abs(mix2.scored[0].value - ref2.entries[0].equity) < 1e-5,
          `mixed ${variant}+js roll-chunk equity diff too large (${player})`,
        );
      }

      assert.ok(mixCounters.subsetCalls >= 8, `expected subset calls >= 8, got ${mixCounters.subsetCalls}`);
      assert.ok(mixCounters.rollChunkCalls >= 16, `expected roll-chunk calls >= 16, got ${mixCounters.rollChunkCalls}`);
      await mixedPool.dispose();
    }
    console.log(`4. ThinkerPool mixed (${variantsToTest.join('/')} + JS) subset & roll-chunk parity (White & Black): PASS`);
  } finally {
    disposeWasmEngine();
    setEngineBackend('auto');
    setBearoffDatabase(null);
    setMoneyBearoffDatabase(null);
    setPruneNet(null);
  }
}

await testPinnedAssets();
await testWasmVsJsParityBothSides();
await testThinkerPoolDiagnosticsAndMixedBackends();
console.log('miniapp WASM backend tests: ALL PASS');
