// Pruning Net（models/prune_net.json）同梱・2 段葉プルーニング・Worker アトミック load の検証。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Agent,
  DEFAULT_LEAF_PRUNE_CANDIDATES,
  DEFAULT_LEAF_PRUNE_TOLERANCE,
  getPruneNet,
  setBearoffDatabase,
  setPruneNet,
  validatePruneNet,
} from '../../docs/backgammon/src/agent.js';
import { BearoffDatabase } from '../../docs/backgammon/src/bearoff.js';
import { BLACK, Board, WHITE } from '../../docs/backgammon/src/board.js';
import { Game, ROLLING } from '../../docs/backgammon/src/game.js';
import { NeuralNet, flipPerspective } from '../../docs/backgammon/src/nn.js';
import { generateMoves } from '../../docs/backgammon/src/rules.js';

const EXPECTED_MODEL_SHA256 = '9543ecb1deaff716de1355726d3109f1529fe34e0ab68d94284654fd7871dd83';
const EXPECTED_PRUNE_BYTES = 317_382;
const EXPECTED_PRUNE_SHA256 = '2c75561140f7532f452c2c83a8e557467d366e1591df1328f087432436dc3dff';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const srcDir = resolve(repoRoot, 'docs/backgammon/src');

const rawModel = readFileSync(resolve(srcDir, 'model.json'));
const rawPrune = readFileSync(resolve(srcDir, 'prune_net.json'));
const rawBearoff = readFileSync(resolve(srcDir, 'bearoff-6x15.bin'));
const fixture = JSON.parse(readFileSync(resolve(here, 'prune-parity.json'), 'utf8'));

// 1. 実ファイル SHA-256 と構成の検証
const actualModelSha = createHash('sha256').update(rawModel).digest('hex');
const actualPruneSha = createHash('sha256').update(rawPrune).digest('hex');
assert.equal(actualModelSha, EXPECTED_MODEL_SHA256, 'model.json SHA-256 不一致');
assert.equal(rawPrune.byteLength, EXPECTED_PRUNE_BYTES, 'prune_net.json バイト数不一致');
assert.equal(actualPruneSha, EXPECTED_PRUNE_SHA256, 'prune_net.json SHA-256 不一致');
assert.equal(DEFAULT_LEAF_PRUNE_CANDIDATES, 7);
assert.equal(DEFAULT_LEAF_PRUNE_TOLERANCE, 0.2);

const net = new NeuralNet(JSON.parse(rawModel.toString('utf8')));
const pruneData = JSON.parse(rawPrune.toString('utf8'));
const pruneNet = new NeuralNet(pruneData);
const bearoff = new BearoffDatabase(
  rawBearoff.buffer.slice(rawBearoff.byteOffset, rawBearoff.byteOffset + rawBearoff.byteLength),
);
assert.deepEqual(pruneNet.hiddenDims, [64, 32]);

setBearoffDatabase(bearoff);

// 2. pruneNet === net の厳密不変条件（White / Black 両手番）
{
  const plain = new Agent(net, 2, undefined, { bearoff, pruneNet: null, jacoby: true });
  const samePruned = new Agent(net, 2, undefined, { bearoff, pruneNet: net, jacoby: true });
  const sample = fixture.positions.slice(0, 2).concat(fixture.positions.slice(12, 14));
  for (const row of sample) {
    const board = Board.fromJson({ points: row.points, bar: row.bar, off: row.borne_off });
    const turn = row.turn === 'white' ? WHITE : BLACK;
    const eqDiff = Math.abs(
      plain.expectedEquityAfterMove(board, turn, turn)
      - samePruned.expectedEquityAfterMove(board, turn, turn),
    );
    assert.ok(eqDiff < 1e-6, `expectedEquityAfterMove 不一致 (${row.turn}): ${eqDiff}`);
    const v1 = plain.expectedVectorAfterMove(board, turn);
    const v2 = samePruned.expectedVectorAfterMove(board, turn);
    for (let k = 0; k < 5; k += 1) {
      assert.ok(Math.abs(v1[k] - v2[k]) < 1e-6, `expectedVectorAfterMove[${k}] 不一致`);
    }
    const moves = generateMoves(board, turn, row.roll[0], row.roll[1]);
    assert.equal(plain.selectMove(moves, turn), samePruned.selectMove(moves, turn));
  }
}

// 3. Rust 参照値との 24 局面パリティ（White 12 / Black 12）
{
  const agent = new Agent(net, 2, undefined, {
    bearoff,
    pruneNet,
    leafPruneCandidates: fixture.leaf_prune_candidates,
    leafPruneTolerance: fixture.leaf_prune_tolerance,
    jacoby: true,
    cubeLeafPlies: 1,
  });
  let maxVecDelta = 0;
  let moveMatches = 0;
  let doubleMatches = 0;
  let takeMatches = 0;

  for (const row of fixture.positions) {
    const board = Board.fromJson({ points: row.points, bar: row.bar, off: row.borne_off });
    const turn = row.turn === 'white' ? WHITE : BLACK;
    const moves = generateMoves(board, turn, row.roll[0], row.roll[1]);
    const pick = agent.selectMove(moves, turn);
    const chosen = moves[pick].resultingBoard;
    const boardEq = (
      chosen.points.every((v, idx) => v === row.resulting_points[idx])
      && chosen.bar.WHITE === row.resulting_bar[0]
      && chosen.bar.BLACK === row.resulting_bar[1]
      && chosen.off.WHITE === row.resulting_borne_off[0]
      && chosen.off.BLACK === row.resulting_borne_off[1]
    );
    if (boardEq) moveMatches += 1;

    const sv = agent.expectedVectorAfterMove(board, turn);
    for (let k = 0; k < 5; k += 1) {
      maxVecDelta = Math.max(maxVecDelta, Math.abs(sv[k] - row.search_vector_d1[k]));
    }

    const cg = new Game(board, Math.random, { jacoby: true });
    cg.currentPlayer = turn;
    cg.state = ROLLING;
    if (Boolean(agent.shouldDouble(cg)) === Boolean(row.should_double)) doubleMatches += 1;
    cg.proposeDouble();
    if (Boolean(agent.shouldAcceptDouble(cg)) === Boolean(row.should_accept_double)) takeMatches += 1;
  }

  assert.equal(moveMatches, fixture.positions.length, `2-ply 一致不足: ${moveMatches}/${fixture.positions.length}`);
  assert.ok(maxVecDelta < 2e-5, `SearchVector(d=1) 誤差超過: ${maxVecDelta}`);
  assert.equal(doubleMatches, fixture.positions.length, `ShouldDouble 一致不足: ${doubleMatches}/${fixture.positions.length}`);
  assert.equal(takeMatches, fixture.positions.length, `ShouldAcceptDouble 一致不足: ${takeMatches}/${fixture.positions.length}`);
}

// 4. white / mover 視点吸収 + 互換バリデーション
{
  assert.throws(
    () => validatePruneNet({ inputDim: 198, outputDim: 5, features: 'none', perspective: 'black', predict: () => [0.5, 0, 0, 0, 0] }),
    /perspective/,
  );
  function flipMoverFeaturesToWhite(feat) {
    const out = new Float64Array(198);
    for (let i = 0; i < 24; i += 1) {
      const src = (23 - i) * 8;
      const dst = i * 8;
      for (let k = 0; k < 4; k += 1) {
        out[dst + k] = feat[src + 4 + k];
        out[dst + 4 + k] = feat[src + k];
      }
    }
    out[192] = feat[193]; out[193] = feat[192];
    out[194] = feat[195]; out[195] = feat[194];
    out[196] = feat[197]; out[197] = feat[196];
    return out;
  }
  const moverPrune = {
    inputDim: 198, outputDim: 5, features: 'none', perspective: 'mover', _turn: WHITE,
    predict(feat) {
      return moverPrune._turn === WHITE
        ? pruneNet.predict(feat)
        : flipPerspective(pruneNet.predict(flipMoverFeaturesToWhite(feat)));
    },
    predictBatch(feats) { return feats.map((f) => moverPrune.predict(f)); },
  };
  const whiteAg = new Agent(net, 2, undefined, { bearoff, pruneNet, jacoby: true });
  const moverAg = new Agent(net, 2, undefined, { bearoff, pruneNet: moverPrune, jacoby: true });
  const pair = [
    fixture.positions.find((r) => r.turn === 'white'),
    fixture.positions.find((r) => r.turn === 'black'),
  ];
  for (const row of pair) {
    const board = Board.fromJson({ points: row.points, bar: row.bar, off: row.borne_off });
    const turn = row.turn === 'white' ? WHITE : BLACK;
    moverPrune._turn = turn === WHITE ? BLACK : WHITE;
    const dEq = Math.abs(
      whiteAg.expectedEquityAfterMove(board, turn, turn)
      - moverAg.expectedEquityAfterMove(board, turn, turn),
    );
    assert.ok(dEq < 1e-6, `mover 視点不一致 (${row.turn}): ${dEq}`);
  }
}

// 5. Worker 非同期 load アトミック化（重複 load / 省略 / 404 / HTTP 200 非互換 JSON）
{
  const workerScope = {
    messages: [],
    postMessage(msg) { this.messages.push(msg); },
  };
  const prevSelf = globalThis.self;
  const prevFetch = globalThis.fetch;
  const prevWarn = console.warn;
  const badPruneJson = JSON.stringify({ ...pruneData, perspective: 'black' });
  const warnings = [];
  globalThis.self = workerScope;
  console.warn = (...args) => warnings.push(args.join(' '));
  await import('../../docs/backgammon/src/worker.js');

  function deferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
  }

  let fetchImpl = async () => new Response('unexpected', { status: 500 });
  globalThis.fetch = (url) => fetchImpl(url);
  const byId = (id) => workerScope.messages.find((m) => m.id === id);

  try {
    // 5a. 重複 load: 遅い loadA(pruneA) を loadB(省略) が追い越しても pruneA が混入しない
    const slowPrune = deferred();
    const asked = deferred();
    fetchImpl = async (url) => {
      if (url.endsWith('/modelA.json') || url.endsWith('/modelB.json')) return new Response(rawModel, { status: 200 });
      if (url.endsWith('/slow-prune.json')) { asked.resolve(); return slowPrune.promise; }
      return new Response('not found', { status: 404 });
    };
    const pA = workerScope.onmessage({
      data: { id: 'ov-A', kind: 'load', url: 'https://test.invalid/modelA.json', pruneNetUrl: 'https://test.invalid/slow-prune.json' },
    });
    await asked.promise;
    await workerScope.onmessage({ data: { id: 'ov-B', kind: 'load', url: 'https://test.invalid/modelB.json' } });
    assert.equal(byId('ov-B')?.ok, true);
    assert.equal(byId('ov-B')?.pruneNetLoaded, false);
    assert.equal(byId('ov-B')?.pruneNetStatus, 'disabled');
    assert.equal(getPruneNet(), null);
    slowPrune.resolve(new Response(rawPrune, { status: 200 }));
    await pA;
    assert.equal(byId('ov-A')?.superseded, true);
    assert.equal(getPruneNet(), null, '古い loadA の pruneNet が modelB へ混入しました');

    // 5b. HTTP 200 非互換 JSON -> load 時点で弾いて null フォールバック、後続 select も成功
    warnings.length = 0;
    fetchImpl = async (url) => {
      if (url.endsWith('/modelA.json')) return new Response(rawModel, { status: 200 });
      if (url.endsWith('/bad-prune.json')) return new Response(badPruneJson, { status: 200 });
      return new Response('not found', { status: 404 });
    };
    await workerScope.onmessage({
      data: { id: 'bad-200', kind: 'load', url: 'https://test.invalid/modelA.json', pruneNetUrl: 'https://test.invalid/bad-prune.json' },
    });
    assert.equal(byId('bad-200')?.ok, true);
    assert.equal(byId('bad-200')?.pruneNetLoaded, false);
    assert.equal(byId('bad-200')?.pruneNetStatus, 'fallback');
    assert.equal(getPruneNet(), null);
    assert.ok(warnings.length > 0);

    const row = fixture.positions[0];
    await workerScope.onmessage({
      data: {
        id: 'sel-after-bad', kind: 'select',
        board: { points: row.points, bar: row.bar, off: row.borne_off },
        player: row.turn.toUpperCase(), die1: row.roll[0], die2: row.roll[1], level: 'expert',
      },
    });
    assert.equal(byId('sel-after-bad')?.ok, true);

    // 5c. 正常ロードで pruneNet が有効になり、pruneNetLoaded / pruneNetStatus も正しく返る
    fetchImpl = async (url) => {
      if (url.endsWith('/modelA.json')) return new Response(rawModel, { status: 200 });
      if (url.endsWith('/prune.json')) return new Response(rawPrune, { status: 200 });
      return new Response('not found', { status: 404 });
    };
    await workerScope.onmessage({
      data: { id: 'ok-prune', kind: 'load', url: 'https://test.invalid/modelA.json', pruneNetUrl: 'https://test.invalid/prune.json' },
    });
    assert.equal(byId('ok-prune')?.ok, true);
    assert.equal(byId('ok-prune')?.pruneNetLoaded, true);
    assert.equal(byId('ok-prune')?.pruneNetStatus, 'loaded');
    assert.notEqual(getPruneNet(), null);
  } finally {
    setPruneNet(null);
    globalThis.fetch = prevFetch;
    globalThis.self = prevSelf;
    console.warn = prevWarn;
  }
}

console.log('Pruning Net: SHA-256 / 24局面 Rust パリティ / mover視点 / Worker アトミック load OK');
