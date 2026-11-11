// BG2N v4 Readerとstrict rootをengine production固定fixtureに照合する。
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Board, WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import { Agent, agentFor, setMoneyBearoffDatabase } from '../../docs/backgammon/src/agent.js';
import { checkerContextFor } from '../../docs/backgammon/src/checker.js';
import { DoublingCube } from '../../docs/backgammon/src/cube.js';
import { Game, ROLLING } from '../../docs/backgammon/src/game.js';
import { Match } from '../../docs/backgammon/src/match.js';
import {
  evaluateMoneyBg2nRoot,
  MONEY_BG2N_FILE_SHA256,
  MONEY_BG2N_PAYLOAD_SHA256,
  MoneyBearoffDatabase,
} from '../../docs/backgammon/src/money-bearoff.js';

const fixture = JSON.parse(await readFile(new URL('./money-bg2n-parity.json', import.meta.url), 'utf8'));
const filePath = fileURLToPath(new URL('../../docs/backgammon/src/money-bg2n-6x6-v4.bin', import.meta.url));
const file = await readFile(filePath);
const fileSha256 = createHash('sha256').update(file).digest('hex');
assert.equal(file.length, 10_223_244, 'production BG2N v4 bytes');
assert.equal(fileSha256, fixture.databaseSha256, 'engine fixture file SHA-256');
assert.equal(fileSha256, MONEY_BG2N_FILE_SHA256, 'reader file SHA-256');

const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const database = await MoneyBearoffDatabase.fromArrayBuffer(buffer, webcrypto);
assert.equal(database.version, 4);
assert.equal(database.valueFormat, 'uint16-symmetric-q32767');
assert.equal(database.payloadSha256, MONEY_BG2N_PAYLOAD_SHA256);

function boardFromCounts(white, black) {
  const points = Array(24).fill(0);
  white.forEach((count, distance) => { points[distance] += count; });
  black.forEach((count, distance) => { points[23 - distance] -= count; });
  return new Board(points);
}

function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1e-12,
    `${label}: expected ${expected}, got ${actual}`);
}

for (const expected of fixture.lookups) {
  const value = database.lookupNormalizedCounts(
    fixture.white, fixture.black, expected.turn === 'WHITE' ? WHITE : BLACK, expected.owner);
  close(value, expected.value, `lookup ${expected.turn}/${expected.owner}`);
}

const board = boardFromCounts(fixture.white, fixture.black);
for (const expected of fixture.roots) {
  const result = evaluateMoneyBg2nRoot(board,
    expected.turn === 'WHITE' ? WHITE : BLACK, expected.cube, expected.owner, database);
  for (const field of ['ND_points', 'DT_points', 'DP_points']) {
    if (expected[field] === null) assert.equal(result[field], null, `${field} unavailable`);
    else close(result[field], expected[field], `${expected.turn}/${expected.cube}/${field}`);
  }
  assert.equal(result.action, expected.action,
    `${expected.turn}/${expected.cube}/${expected.owner} action`);
}

// Exact root action and response use the same engine branch values. The strict
// DB is single-only, so Jacoby does not alter this production fixture.
const fixtureAgent = (jacoby) => new Agent({
  perspective: 'white',
  predict: () => [0.5, 0.1, 0.05, 0.2, 0.15],
}, 0, undefined, { cubeSearchDepth: 0, cubeLeafPlies: 0, jacoby });
setMoneyBearoffDatabase(database);
for (const jacoby of [true, false]) {
  const game = new Game(board, Math.random, { jacoby, unboundedMoneyCube: true });
  game.currentPlayer = BLACK;
  game.state = ROLLING;
  const agent = fixtureAgent(jacoby);
  assert.equal(agent.shouldDouble(game, null), true, `exact double/pass with Jacoby=${jacoby}`);
  assert.equal(agent.moneyBg2nLastRoot.status, 'exact');
  game.proposeDouble();
  assert.equal(agent.shouldAcceptDouble(game, null), false, 'DT > DP must pass');
}

// A miss in any child rejects the complete exact root. The caller then runs its
// pre-existing evaluator once, without retaining the partially computed ND.
const missingChildDb = {
  ...database,
  lookupNormalized: () => null,
};
assert.throws(() => evaluateMoneyBg2nRoot(board, BLACK, 1, 'center', missingChildDb),
  /strict root child DB miss/);
setMoneyBearoffDatabase(missingChildDb);
const fallbackAgent = fixtureAgent(true);
let fallbackCalls = 0;
fallbackAgent.shouldDoubleSearch = () => { fallbackCalls += 1; return false; };
const fallbackGame = new Game(board, Math.random, { unboundedMoneyCube: true });
fallbackGame.currentPlayer = BLACK;
assert.equal(fallbackAgent.shouldDouble(fallbackGame, null), false);
assert.equal(fallbackCalls, 1, 'fallback owns the full root decision');
assert.equal(fallbackAgent.moneyBg2nLastRoot.status, 'fallback');

// The legacy evaluator receives the same unbounded Money rule when the exact
// root is unsupported or a decision happens inside a recursive cube search.
const searchAgent = fixtureAgent(true);
const recursiveOptions = [];
searchAgent.cubefulSearch = (...args) => {
  recursiveOptions.push(args.at(-1));
  return 0.4;
};
const highCubeGame = new Game(board, Math.random, { unboundedMoneyCube: true });
highCubeGame.currentPlayer = BLACK;
highCubeGame.cube.value = 128;
searchAgent.shouldDoubleSearch(highCubeGame);
assert.equal(recursiveOptions.length, 2, 'ND and DT fallback branches are evaluated');
assert.ok(recursiveOptions.every((options) => options.unboundedMoney === true),
  'ND and DT fallback branches keep Money unbounded above 64');

// A malformed v4 payload and a reserved code fail validation before use.
const corrupted = buffer.slice(0);
new Uint8Array(corrupted)[corrupted.byteLength - 1] ^= 1;
await assert.rejects(MoneyBearoffDatabase.fromArrayBuffer(corrupted, webcrypto), /SHA-256 mismatch/);
const reserved = buffer.slice(0);
new Uint8Array(reserved)[96] = 0;
new Uint8Array(reserved)[97] = 0;
await assert.rejects(MoneyBearoffDatabase.fromArrayBuffer(reserved, webcrypto), /reserved uint16 code/);
const wrongVersion = buffer.slice(0);
new DataView(wrongVersion).setUint16(4, 3, true);
assert.throws(() => new MoneyBearoffDatabase(wrongVersion), /header\/version/);

// Money keeps the unbounded cube; Match/Crawford and cube OFF stay isolated.
const cube = new DoublingCube(64, null, true);
assert.equal(cube.canDouble(WHITE), true);
assert.equal(cube.clone().unboundedMoney, true);
const moneyMatch = new Match({ length: 0 });
const moneyGame = moneyMatch.startGame();
assert.equal(moneyGame.cube.unboundedMoney, true);
moneyGame.cube.value = 128;
moneyGame.state = ROLLING;
assert.equal(moneyGame.canDouble(), true);
const pointsMatch = new Match({ length: 5 });
const pointsGame = pointsMatch.startGame();
pointsGame.cube.value = 64;
assert.equal(pointsGame.cube.unboundedMoney, false);
assert.equal(pointsGame.canDouble(), false);
const crawfordMatch = new Match({ length: 5 });
crawfordMatch.scores[WHITE] = 4;
const crawfordGame = crawfordMatch.startGame();
assert.equal(crawfordGame.crawford, true);
assert.equal(crawfordGame.cube.unboundedMoney, false);

const beginner = agentFor({ perspective: 'white', predict: () => [0.5, 0.1, 0.05, 0.2, 0.15] }, 'beginner');
assert.equal(beginner.useMoneyBearoff, false, 'beginner exact DB disabled');
assert.equal(beginner.bearoff, null, 'beginner legacy BGBO DB disabled');
const moneyContext = checkerContextFor(moneyGame, moneyMatch, WHITE);
assert.equal(moneyContext.cube.unboundedMoney, true);
const matchContext = checkerContextFor(pointsGame, pointsMatch, WHITE);
assert.equal(matchContext.cube.unboundedMoney, false);

setMoneyBearoffDatabase(null);
console.log('Money BG2N v4: engine fixtures, strict-root, fallback, integrity, cube separation OK');
