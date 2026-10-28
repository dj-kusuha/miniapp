// Check miniapp MWC cube search against engine Python values (pre/post Crawford).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Agent } from '../../docs/backgammon/src/agent.js';
import { Board, WHITE } from '../../docs/backgammon/src/board.js';
import { NeuralNet } from '../../docs/backgammon/src/nn.js';

const fixture = JSON.parse(await readFile(
  new URL('./match-cube-parity.json', import.meta.url), 'utf8'));
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
  matchCubeEfficiency: fixture.reference.match_cube_efficiency,
  useCubeHead: false,
  bearoff: null,
});

for (const scenario of fixture.cases) {
  test(`engine Match MWC parity: ${scenario.id}`, () => {
    const match = {
      away: { WHITE: scenario.away_white, BLACK: scenario.away_black },
      crawfordPlayed: scenario.crawford_played,
    };
    const got = agent.mwcSearch(board, WHITE, scenario.owner,
      fixture.reference.cube_search_depth, scenario.cube_value, match, 0,
      fixture.reference.match_cube_efficiency, scenario.allow_double);
    assert.ok(Math.abs(got - scenario.expected) <= fixture.reference.absolute_tolerance,
      `JS ${got} vs engine ${scenario.expected}`);
  });
}
