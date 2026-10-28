// Check the miniapp cube search against money-cube values exported from engine Python.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Agent } from '../../docs/backgammon/src/agent.js';
import { Board, WHITE } from '../../docs/backgammon/src/board.js';
import { NeuralNet } from '../../docs/backgammon/src/nn.js';

const fixture = JSON.parse(await readFile(
  new URL('./cube-cash-option-parity.json', import.meta.url), 'utf8'));
const modelBytes = await readFile(
  new URL('../../docs/backgammon/src/model.json', import.meta.url));
assert.equal(createHash('sha256').update(modelBytes).digest('hex'),
  fixture.reference.model_sha256);
const net = new NeuralNet(JSON.parse(modelBytes.toString('utf8')));
const source = fixture.board;
const board = new Board([...source.points],
  { WHITE: source.bar[0], BLACK: source.bar[1] },
  { WHITE: source.off[0], BLACK: source.off[1] });
const agent = new Agent(net, 0, undefined, {
  cubeSearchDepth: fixture.reference.cube_search_depth,
  cubeLeafPlies: fixture.reference.cube_leaf_plies,
  cubeCashOption: false,
  useCubeHead: false,
  bearoff: null,
});
const tolerance = fixture.reference.absolute_tolerance;

for (const scenario of fixture.cases) {
  test(`engine Money Cash Option parity: ${scenario.id}`, () => {
    const shared = {
      cubeValue: scenario.cube_value,
      allowDouble: scenario.allow_double,
      actionContext: scenario.action_context,
    };
    const base = agent.cubefulSearch(board, WHITE, scenario.owner, 2, false, 0, null, shared);
    const withPolicy = agent.cubefulSearch(board, WHITE, scenario.owner, 2, false, 0, null,
      { ...shared, cashPolicy: { alpha: fixture.reference.cash_alpha } });
    assert.ok(Math.abs(base - scenario.without_policy) <= tolerance,
      `without policy: JS ${base} vs engine ${scenario.without_policy}`);
    assert.ok(Math.abs(withPolicy - scenario.with_policy) <= tolerance,
      `with policy: JS ${withPolicy} vs engine ${scenario.with_policy}`);
  });
}
