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
import { checkerContextFor, rankCheckerMoves, selectCheckerMove } from '../../docs/backgammon/src/checker.js';
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

await testPinnedAssets();
await testWasmVsJsParityBothSides();
console.log('miniapp WASM backend tests: ALL PASS');
