// miniapp 実経路（ThinkerPool + docs/backgammon/src/worker.js）の WASM 診断モジュール。
// 専用 Phase 4b ハーネス（browser-harness.mjs）とは別枠で結果を記録し、
// 4-Worker 並列 champion staged3ply・ヒント 2-ply・Money BG2N 6x6・Match キューブの
// 実効 WASM 稼働と JS 基準パリティを検証する。

import { Board, WHITE } from '../backgammon/src/board.js';
import { Game, ROLLING } from '../backgammon/src/game.js';
import { Match, MONEY } from '../backgammon/src/match.js';
import { NeuralNet } from '../backgammon/src/nn.js';
import { BearoffDatabase } from '../backgammon/src/bearoff.js';
import { agentFor, setBearoffDatabase, setPruneNet } from '../backgammon/src/agent.js';
import { checkerContextFor } from '../backgammon/src/checker.js';
import { generateMovesJs } from '../backgammon/src/rules.js';
import { ThinkerPool } from '../backgammon/src/thinker-pool.js';

const MODEL_URL = new URL('../backgammon/src/model.json', import.meta.url).href;
const BEAROFF_URL = new URL('../backgammon/src/bearoff-6x15.bin', import.meta.url).href;
const MONEY_BEAROFF_URL = new URL('../backgammon/src/money-bg2n-6x6-v4.bin', import.meta.url).href;
const PRUNE_NET_URL = new URL('../backgammon/src/prune_net.json', import.meta.url).href;
const WORKER_URL = new URL('../backgammon/src/worker.js', import.meta.url).href;
const METADATA_URL = new URL('../backgammon/assets/metadata.json', import.meta.url).href;

const SINGLE_WORKER_BG2N_MAX_MIB = 42;
const FOUR_WORKER_BG2N_MAX_MIB = 168;

function toMiB(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? Number((bytes / (1024 * 1024)).toFixed(2)) : Number.NaN;
}

function makeBg2nBoard() {
  const pts = new Array(24).fill(0);
  pts[0] = 2; pts[1] = 2; pts[2] = 1;
  pts[23] = -2; pts[22] = -2; pts[21] = -1;
  return Board.fromJson({ points: pts, bar: [0, 0], off: [10, 10] });
}

function boardDtoOf(board) {
  return {
    points: [...board.points],
    bar: [board.bar[WHITE], board.bar.BLACK ?? board.bar.black ?? 0],
    off: [board.off[WHITE], board.off.BLACK ?? board.off.black ?? 0],
  };
}

export async function runMiniappAppRouteVerification(onLog = () => {}) {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  let wasmPool = null;
  let jsPool = null;

  try {
    onLog('Loading miniapp metadata, model, bearoff, and pruneNet...');
    const [metaResp, net, bearoff, pruneNet] = await Promise.all([
      fetch(METADATA_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      NeuralNet.load(MODEL_URL),
      BearoffDatabase.load(BEAROFF_URL),
      NeuralNet.load(PRUNE_NET_URL),
    ]);
    setBearoffDatabase(bearoff);
    setPruneNet(pruneNet);
    const adviceAgent = agentFor(net, 'expert', { backend: 'js' });

    const loadPayload = {
      url: MODEL_URL,
      bearoffUrl: BEAROFF_URL,
      moneyBearoffUrl: MONEY_BEAROFF_URL,
      pruneNetUrl: PRUNE_NET_URL,
    };

    onLog('Starting miniapp ThinkerPool (4 workers, default auto -> WASM) and JS reference pool...');
    wasmPool = new ThinkerPool({
      maxWorkers: 4,
      createWorker: () => new Worker(WORKER_URL, { type: 'module' }),
    });
    jsPool = new ThinkerPool({
      maxWorkers: 2,
      explicitBackend: 'js',
      createWorker: () => new Worker(WORKER_URL, { type: 'module' }),
    });

    const wasmStarted = await wasmPool.start(loadPayload);
    const jsStarted = await jsPool.start(loadPayload);
    if (!wasmStarted || !jsStarted) {
      throw new Error(`ThinkerPool start failed (wasm=${wasmStarted}, js=${jsStarted})`);
    }

    const match = new Match({ length: MONEY, jacoby: true, useCube: true, unboundedMoneyCube: true });
    const game = match.startGame();
    game.currentPlayer = WHITE;
    const moves31 = generateMovesJs(game.board, WHITE, 3, 1);
    const context = checkerContextFor(game, match, WHITE);
    const initialDto = boardDtoOf(game.board);

    onLog('Running champion 3-ply staged3ply parallel chooseMove (WASM vs JS)...');
    const tChamp0 = performance.now();
    const wasmChamp = await wasmPool.chooseMove({
      boardDto: initialDto,
      player: WHITE,
      die1: 3,
      die2: 1,
      level: 'champion',
      moves: moves31,
      context,
    });
    const wasmChampMs = Number((performance.now() - tChamp0).toFixed(2));
    const jsChamp = await jsPool.chooseMove({
      boardDto: initialDto,
      player: WHITE,
      die1: 3,
      die2: 1,
      level: 'champion',
      moves: moves31,
      context,
    });

    onLog('Running expert 2-ply hint rankMoves (WASM vs JS)...');
    const tHint0 = performance.now();
    const wasmHint = await wasmPool.rankMoves({
      boardDto: initialDto,
      player: WHITE,
      die1: 3,
      die2: 1,
      level: 'expert',
      moves: moves31,
      context,
      limit: 3,
      adviceAgent,
    });
    const wasmHintMs = Number((performance.now() - tHint0).toFixed(2));
    const jsHint = await jsPool.rankMoves({
      boardDto: initialDto,
      player: WHITE,
      die1: 3,
      die2: 1,
      level: 'expert',
      moves: moves31,
      context,
      limit: 3,
      adviceAgent,
    });

    onLog('Running Money BG2N 6x6 cube & Match cube decisions (WASM vs JS)...');
    const bg2nBoard = makeBg2nBoard();
    const bg2nGame = new Game(bg2nBoard, Math.random, { jacoby: false, unboundedMoneyCube: true });
    bg2nGame.currentPlayer = WHITE;
    bg2nGame.state = ROLLING;
    const bg2nDto = boardDtoOf(bg2nBoard);
    const cubeReqBg2n = {
      boardDto: bg2nDto,
      player: WHITE,
      cubeValue: 1,
      cubeOwner: null,
      jacoby: false,
      crawford: false,
      level: 'expert',
      match: null,
      ask: 'double',
      game: bg2nGame,
    };
    const wasmBg2nCube = await wasmPool.decideCube(cubeReqBg2n);
    const jsBg2nCube = await jsPool.decideCube(cubeReqBg2n);

    const match5 = new Match({ length: 5, jacoby: false, useCube: true });
    const matchGame = match5.startGame();
    matchGame.currentPlayer = WHITE;
    matchGame.state = ROLLING;
    const cubeReqMatch = {
      boardDto: initialDto,
      player: WHITE,
      cubeValue: 1,
      cubeOwner: null,
      jacoby: false,
      crawford: false,
      level: 'expert',
      match: match5.cubeContext(),
      ask: 'double',
      game: matchGame,
    };
    const wasmMatchCube = await wasmPool.decideCube(cubeReqMatch);
    const jsMatchCube = await jsPool.decideCube(cubeReqMatch);

    const poolBackend = await wasmPool.refreshBackendStatuses();
    const poolPrune = wasmPool.pruneNetStatus;
    const perWorkerMiB = poolBackend.workers.map((w) => toMiB(w.linearMemoryBytes));
    const totalMiB = Number(perWorkerMiB.reduce((s, m) => s + (Number.isFinite(m) ? m : 0), 0).toFixed(2));
    const perWorkerMemOk = perWorkerMiB.length > 0
      && perWorkerMiB.every((m) => Number.isFinite(m) && m > 0 && m <= SINGLE_WORKER_BG2N_MAX_MIB);
    const totalMemOk = Number.isFinite(totalMiB) && totalMiB > 0 && totalMiB <= FOUR_WORKER_BG2N_MAX_MIB;

    const hintTopEquityDiff = Math.abs(
      (wasmHint.entries[0]?.equity ?? Number.NaN) - (jsHint.entries[0]?.equity ?? Number.NaN),
    );
    const champMatch = wasmChamp.key === jsChamp.key && wasmChamp.index === jsChamp.index;
    const hintMatch = wasmHint.entries[0]?.key === jsHint.entries[0]?.key
      && Number.isFinite(hintTopEquityDiff)
      && hintTopEquityDiff < 1e-5;
    const bg2nCubeMatch = wasmBg2nCube === jsBg2nCube;
    const matchCubeMatch = wasmMatchCube === jsMatchCube;

    onLog('Disposing ThinkerPool workers...');
    await wasmPool.dispose();
    await jsPool.dispose();
    wasmPool = null;
    jsPool = null;

    const passed = Boolean(
      poolBackend.allWasm
      && poolBackend.workerCount >= 1
      && poolBackend.fallbackReasons.length === 0
      && poolBackend.runtimeIds.every((id) => id !== null && id !== undefined)
      && poolPrune.state === 'loaded'
      && poolPrune.consistent
      && perWorkerMemOk
      && totalMemOk
      && champMatch
      && hintMatch
      && bg2nCubeMatch
      && matchCubeMatch,
    );

    const result = {
      route: 'miniapp-thinker-pool',
      startedAt,
      completedAt: new Date().toISOString(),
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      engineMetadata: metaResp,
      poolBackend,
      pruneNetStatus: poolPrune,
      memory: {
        perWorkerMiB,
        totalMiB,
        perWorkerBudgetMiB: SINGLE_WORKER_BG2N_MAX_MIB,
        totalBudgetMiB: FOUR_WORKER_BG2N_MAX_MIB,
        perWorkerMemOk,
        totalMemOk,
      },
      parity: {
        championStaged3Ply: {
          wasmKey: wasmChamp.key,
          jsKey: jsChamp.key,
          wasmMs: wasmChampMs,
          match: champMatch,
        },
        expertHint2Ply: {
          wasmTopKey: wasmHint.entries[0]?.key ?? null,
          jsTopKey: jsHint.entries[0]?.key ?? null,
          equityDiff: Number(hintTopEquityDiff.toExponential(3)),
          wasmMs: wasmHintMs,
          match: hintMatch,
        },
        moneyBg2nCube: { wasm: wasmBg2nCube, js: jsBg2nCube, match: bg2nCubeMatch },
        matchCube: { wasm: wasmMatchCube, js: jsMatchCube, match: matchCubeMatch },
      },
      passed,
    };
    onLog(`miniapp app-route check ${passed ? 'PASS' : 'FAIL'} (${result.elapsedMs} ms)`);
    return result;
  } catch (error) {
    return {
      route: 'miniapp-thinker-pool',
      startedAt,
      completedAt: new Date().toISOString(),
      elapsedMs: Number((performance.now() - t0).toFixed(2)),
      error: String(error?.stack || error),
      passed: false,
    };
  } finally {
    if (wasmPool) await wasmPool.dispose().catch(() => wasmPool.terminate());
    if (jsPool) await jsPool.dispose().catch(() => jsPool.terminate());
  }
}
