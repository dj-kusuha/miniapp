// CPU着手・ヒントchecker評価のNode性能測定。例: node tests/backgammon/checker-performance.mjs --samples=3
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Board, WHITE } from '../../docs/backgammon/src/board.js';
import { NeuralNet } from '../../docs/backgammon/src/nn.js';
import { Agent, filtersFor } from '../../docs/backgammon/src/agent.js';
import { generateMoves } from '../../docs/backgammon/src/rules.js';
import { rankCheckerMoves } from '../../docs/backgammon/src/checker.js';

function option(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? Number(arg.slice(prefix.length)) : fallback;
}

function listOption(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length).split(',') : fallback;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

const samples = option('samples', 3);
if (!Number.isInteger(samples) || samples < 1) throw new Error('--samples must be a positive integer');
const selectedPlies = new Set(listOption('plies', ['0', '2', '3']).map(Number));
const selectedScenarios = new Set(listOption('scenarios', [
  'money-cubeful-jacoby', 'match-mwc-cube-on-5pt-3-3', 'match-mwc-cube-off-5pt-3-3',
]));
const model = JSON.parse(await readFile(
  new URL('../../docs/backgammon/src/model.json', import.meta.url), 'utf8'));
const net = new NeuralNet(model);
const board = new Board();
const player = WHITE;
const dice = { die1: 3, die2: 1 };
const moves = generateMoves(board, player, dice.die1, dice.die2);
const cases = [
  {
    id: 'money-cubeful-jacoby',
    context: {
      cube: { value: 1, owner: 'center', enabled: true, available: true },
      match: { mode: 'money', jacoby: true },
    },
  },
  {
    id: 'match-mwc-cube-on-5pt-3-3',
    context: {
      cube: { value: 1, owner: 'center', enabled: true, available: true },
      match: {
        mode: 'match', targetPoints: 5, scoreWhite: 3, scoreBlack: 3,
        crawford: false, crawfordPlayed: false, jacoby: false,
      },
    },
  },
  {
    id: 'match-mwc-cube-off-5pt-3-3',
    context: {
      cube: { value: 1, owner: 'center', enabled: false, available: false },
      match: {
        mode: 'match', targetPoints: 5, scoreWhite: 3, scoreBlack: 3,
        crawford: false, crawfordPlayed: false, jacoby: false,
      },
    },
  },
];

console.log(JSON.stringify({
  runtime: process.version,
  platform: process.platform,
  position: 'initial board, White 3-1',
  candidates: moves.length,
  samples,
}));

for (const level of [
  { id: 'advanced', plies: 0 },
  { id: 'expert', plies: 2 },
  { id: 'champion', plies: 3 },
].filter(({ plies }) => selectedPlies.has(plies))) {
  const agent = new Agent(net, level.plies, filtersFor(level.plies), { bearoff: null });
  for (const scenario of cases.filter(({ id }) => selectedScenarios.has(id))) {
    const wall = [];
    const cpu = [];
    let best = null;
    for (let i = 0; i < samples; i += 1) {
      const cpuStart = process.cpuUsage();
      const start = performance.now();
      const result = rankCheckerMoves(agent, scenario.context, moves, player, 3);
      wall.push(performance.now() - start);
      const usage = process.cpuUsage(cpuStart);
      cpu.push((usage.user + usage.system) / 1000);
      best = result.entries[0]?.index ?? null;
    }
    console.log(JSON.stringify({
      level: level.id,
      plies: level.plies,
      scenario: scenario.id,
      candidates: moves.length,
      best_index: best,
      wall_ms_p50: Number(percentile(wall, 0.50).toFixed(2)),
      wall_ms_p95: Number(percentile(wall, 0.95).toFixed(2)),
      cpu_ms_p50: Number(percentile(cpu, 0.50).toFixed(2)),
      cpu_ms_p95: Number(percentile(cpu, 0.95).toFixed(2)),
      samples,
    }));
  }
}
