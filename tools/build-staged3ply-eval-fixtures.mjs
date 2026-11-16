// 固定評価用 fixture セットを生成するスクリプト（Issue #549）。
// 実行: node tools/build-staged3ply-eval-fixtures.mjs
// 生成物: tests/backgammon/staged-3ply-eval-fixtures.json
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, filtersFor } from '../docs/backgammon/src/agent.js';
import { Board, WHITE, BLACK, opponent, hasContact, homeRange } from '../docs/backgammon/src/board.js';
import { NeuralNet } from '../docs/backgammon/src/nn.js';
import { Game, MOVING, ROLLING } from '../docs/backgammon/src/game.js';
import { generateMoves, boardKey } from '../docs/backgammon/src/rules.js';
import { scoreCheckerMoves } from '../docs/backgammon/src/checker.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const model = JSON.parse(readFileSync(resolve(repoRoot, 'docs/backgammon/src/model.json'), 'utf8'));
const net = new NeuralNet(model);
const parityData = JSON.parse(readFileSync(resolve(repoRoot, 'tests/backgammon/parity.json'), 'utf8'));
const cubeParityData = JSON.parse(readFileSync(resolve(repoRoot, 'tests/backgammon/cube-parity.json'), 'utf8'));
const matchCubeParityData = JSON.parse(readFileSync(resolve(repoRoot, 'tests/backgammon/match-cube-parity.json'), 'utf8'));

const SEED = 20261114;
function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boardToDto(board) {
  return {
    points: [...board.points],
    bar: [board.bar[WHITE], board.bar[BLACK]],
    off: [board.off[WHITE], board.off[BLACK]],
  };
}

function classifyPosition(board, player, legalMovesCount, plyIndex = 99) {
  if (plyIndex <= 2 && legalMovesCount >= 8) return 'opening';
  if (board.allInHome(WHITE) || board.allInHome(BLACK)) return 'bearoff';
  if (!hasContact(board)) return 'race';

  // Check backgame: player or opponent has >=2 anchors (2+ checkers) in opponent's home board.
  const whiteHome = homeRange(WHITE);
  const blackHome = homeRange(BLACK);
  const whiteAnchors = blackHome.filter((p) => board.count(p, WHITE) >= 2).length;
  const blackAnchors = whiteHome.filter((p) => board.count(p, BLACK) >= 2).length;
  if (whiteAnchors >= 2 || blackAnchors >= 2) return 'backgame';

  // Check prime: 4+ consecutive points made by either side.
  const hasPrime = (side) => {
    let run = 0;
    for (let p = 0; p < 24; p += 1) {
      if (board.count(p, side) >= 2) {
        run += 1;
        if (run >= 4) return true;
      } else {
        run = 0;
      }
    }
    return false;
  };
  if (hasPrime(WHITE) || hasPrime(BLACK)) return 'prime';

  // Check tactical contact: bar checkers or multiple blots.
  let blots = 0;
  for (let p = 0; p < 24; p += 1) {
    if (Math.abs(board.points[p]) === 1) blots += 1;
  }
  if (board.bar[WHITE] > 0 || board.bar[BLACK] > 0 || blots >= 3) {
    return 'tactical-contact';
  }
  return 'contact';
}

function makeContext(stratum, player) {
  const next = opponent(player);
  const avail = (enabled, crawford, value, owner, mode, unbounded) =>
    Boolean(enabled && !crawford && (value < 64 || (mode === 'money' && unbounded)) && owner !== player);

  switch (stratum) {
    case 'money-center-jacoby':
      return {
        cube: { value: 1, owner: 'center', enabled: true, available: true, unboundedMoney: true },
        match: { mode: 'money', jacoby: true },
      };
    case 'money-center-nojacoby':
      return {
        cube: { value: 1, owner: 'center', enabled: true, available: true, unboundedMoney: false },
        match: { mode: 'money', jacoby: false },
      };
    case 'money-owned-white':
      return {
        cube: {
          value: 2, owner: WHITE, enabled: true,
          available: avail(true, false, 2, WHITE, 'money', true),
          unboundedMoney: true,
        },
        match: { mode: 'money', jacoby: false },
      };
    case 'money-owned-black':
      return {
        cube: {
          value: 2, owner: BLACK, enabled: true,
          available: avail(true, false, 2, BLACK, 'money', false),
          unboundedMoney: false,
        },
        match: { mode: 'money', jacoby: true },
      };
    case 'money-cube-off':
      return {
        cube: { value: 1, owner: 'center', enabled: false, available: false, unboundedMoney: false },
        match: { mode: 'money', jacoby: false },
      };
    case 'match-normal-center':
      return {
        cube: { value: 1, owner: 'center', enabled: true, available: true, unboundedMoney: false },
        match: {
          mode: 'match', targetPoints: 5, scoreWhite: 1, scoreBlack: 2,
          crawford: false, crawfordPlayed: false, jacoby: false,
        },
      };
    case 'match-normal-owned':
      return {
        cube: {
          value: 2, owner: next, enabled: true,
          available: true, unboundedMoney: false,
        },
        match: {
          mode: 'match', targetPoints: 7, scoreWhite: 3, scoreBlack: 3,
          crawford: false, crawfordPlayed: false, jacoby: false,
        },
      };
    case 'match-dmp':
      return {
        cube: { value: 1, owner: 'center', enabled: true, available: true, unboundedMoney: false },
        match: {
          mode: 'match', targetPoints: 5, scoreWhite: 4, scoreBlack: 4,
          crawford: false, crawfordPlayed: false, jacoby: false,
        },
      };
    case 'match-crawford':
      return {
        cube: { value: 1, owner: 'center', enabled: true, available: false, unboundedMoney: false },
        match: {
          mode: 'match', targetPoints: 5, scoreWhite: 4, scoreBlack: 2,
          crawford: true, crawfordPlayed: false, jacoby: false,
        },
      };
    case 'match-post-crawford':
      return {
        cube: { value: 1, owner: 'center', enabled: true, available: true, unboundedMoney: false },
        match: {
          mode: 'match', targetPoints: 5, scoreWhite: 4, scoreBlack: 2,
          crawford: false, crawfordPlayed: true, jacoby: false,
        },
      };
    default:
      throw new Error(`Unknown stratum: ${stratum}`);
  }
}

const rng = createRng(SEED);
const candidatePool = [];
const seenKeys = new Set();

function addCandidate(board, player, die1, die2, source, plyIndex = 99) {
  if (board.hasWon(WHITE) || board.hasWon(BLACK)) return;
  const moves = generateMoves(board, player, die1, die2);
  if (moves.length < 2) return;
  const key = `${boardKey(board)}|${player}|${Math.min(die1, die2)}-${Math.max(die1, die2)}`;
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  const category = classifyPosition(board, player, moves.length, plyIndex);
  candidatePool.push({
    category,
    source,
    board: boardToDto(board),
    player,
    die1,
    die2,
    legalMovesCount: moves.length,
  });
}

// 1. Opening positions (initial board, diverse rolls)
const openingRolls = [
  [3, 1], [6, 1], [4, 2], [5, 3], [6, 5], [4, 4], [2, 1], [3, 2],
  [5, 4], [6, 2], [4, 1], [5, 2], [6, 3], [6, 4], [5, 1], [3, 3],
  [2, 2], [1, 1], [5, 5], [6, 6],
];
for (let i = 0; i < openingRolls.length; i += 1) {
  const [d1, d2] = openingRolls[i];
  addCandidate(new Board(), i % 2 === 0 ? WHITE : BLACK, d1, d2, 'initial', 0);
}

// 2. Parity boards with deterministic rolls
for (let i = 0; i < parityData.boards.length; i += 1) {
  const b = Board.fromJson(parityData.boards[i]);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const d1 = Math.floor(rng() * 6) + 1;
    const d2 = Math.floor(rng() * 6) + 1;
    const p = (i + attempt) % 2 === 0 ? WHITE : BLACK;
    addCandidate(b, p, d1, d2, 'parity', 10);
  }
}

// 3. Self-play with fast 0-ply agent to collect diverse legal mid/endgame positions
const simAgent = new Agent(net, 0, filtersFor(0), { bearoff: null, useCubeHead: false });
for (let g = 0; g < 18; g += 1) {
  const game = new Game(null, rng);
  game.start();
  let ply = 0;
  while (game.state !== 'GAME_OVER' && ply < 160) {
    if (game.state === ROLLING) {
      game.rollDice();
    }
    if (game.state === MOVING) {
      const { currentPlayer, roll, legalMoves } = game;
      if (legalMoves.length >= 2) {
        addCandidate(game.board, currentPlayer, roll.die1, roll.die2, 'self-play', ply);
      }
      const idx = simAgent.selectMove(legalMoves, currentPlayer);
      game.applyMove(idx);
      ply += 1;
    }
  }
}

// Probe Stage-1 (depth=0) candidate spread quickly to identify close-margin candidates
const probeAgent = new Agent(net, 1, filtersFor(1), { bearoff: null, useCubeHead: false });
const probeMoneyCtx = makeContext('money-center-jacoby', WHITE);
const probeMatchCtx = makeContext('match-normal-center', WHITE);

const countWithin = (scored, margin, cap) => {
  const best = scored[0]?.value ?? 0;
  return Math.min(cap, scored.filter((e) => e.value >= best - margin).length);
};

// Sample up to 70 candidates per category (balanced) before probing for speed
const byCatPool = new Map();
for (const c of candidatePool) {
  if (!byCatPool.has(c.category)) byCatPool.set(c.category, []);
  if (byCatPool.get(c.category).length < 70) byCatPool.get(c.category).push(c);
}
const probeCandidates = [...byCatPool.values()].flat();
for (const item of probeCandidates) {
  const b = Board.fromJson(item.board);
  const moves = generateMoves(b, item.player, item.die1, item.die2);
  const mScored = scoreCheckerMoves(probeAgent, probeMoneyCtx, moves, item.player, 'legacy');
  item.probeMoneyTwoPly = countWithin(mScored, 0.160, 8);
  item.probeMoneyThreePly = countWithin(mScored, 0.080, 4);
  const tScored = scoreCheckerMoves(probeAgent, probeMatchCtx, moves, item.player, 'legacy');
  item.probeMatchTwoPly = countWithin(tScored, 0.010, 8);
  item.probeMatchThreePly = countWithin(tScored, 0.005, 4);
}

// Select 200 balanced fixtures across categories, prioritizing positions that exercise Stage 2/3
const categoryTargets = {
  opening: 20,
  contact: 35,
  'tactical-contact': 35,
  prime: 30,
  backgame: 20,
  race: 30,
  bearoff: 30,
};

const selected = [];
const selectedKeys = new Set();

for (const [category, target] of Object.entries(categoryTargets)) {
  const group = probeCandidates.filter((c) => c.category === category);
  // Sort so positions reaching 3-ply / 2-ply with high legal move counts come first, with deterministic tie-break
  group.sort((a, b) => {
    const aDeep = (a.probeMoneyThreePly >= 2 || a.probeMatchThreePly >= 2) ? 2
      : (a.probeMoneyTwoPly >= 2 || a.probeMatchTwoPly >= 2) ? 1 : 0;
    const bDeep = (b.probeMoneyThreePly >= 2 || b.probeMatchThreePly >= 2) ? 2
      : (b.probeMoneyTwoPly >= 2 || b.probeMatchTwoPly >= 2) ? 1 : 0;
    if (bDeep !== aDeep) return bDeep - aDeep;
    return b.legalMovesCount - a.legalMovesCount;
  });
  // Take up to 75% from deep/high-branching and 25% spread across the rest
  const deepCount = Math.min(group.length, Math.ceil(target * 0.75));
  const picks = group.slice(0, deepCount);
  const rest = group.slice(deepCount);
  if (picks.length < target && rest.length > 0) {
    const step = Math.max(1, Math.floor(rest.length / (target - picks.length)));
    for (let i = 0; i < rest.length && picks.length < target; i += step) {
      picks.push(rest[i]);
    }
  }
  for (const p of picks) {
    const k = `${boardKey(Board.fromJson(p.board))}|${p.player}|${p.die1}-${p.die2}`;
    if (!selectedKeys.has(k)) {
      selectedKeys.add(k);
      selected.push(p);
    }
  }
}

// Top up to 200 if any category had fewer than target
if (selected.length < 200) {
  for (const p of candidatePool) {
    if (selected.length >= 200) break;
    const k = `${boardKey(Board.fromJson(p.board))}|${p.player}|${p.die1}-${p.die2}`;
    if (!selectedKeys.has(k)) {
      selectedKeys.add(k);
      selected.push(p);
    }
  }
}

const strata = [
  'money-center-jacoby',
  'money-center-nojacoby',
  'money-owned-white',
  'money-owned-black',
  'money-cube-off',
  'match-normal-center',
  'match-normal-owned',
  'match-dmp',
  'match-crawford',
  'match-post-crawford',
];

const positions = selected.slice(0, 200).map((item, idx) => {
  const stratum = strata[idx % strata.length];
  return {
    id: `F${String(idx + 1).padStart(3, '0')}`,
    category: item.category,
    source: item.source,
    board: item.board,
    player: item.player,
    die1: item.die1,
    die2: item.die2,
    legalMovesCount: item.legalMovesCount,
    stratum,
    context: makeContext(stratum, item.player),
    probe: {
      moneyTwoPly: item.probeMoneyTwoPly,
      moneyThreePly: item.probeMoneyThreePly,
      matchTwoPly: item.probeMatchTwoPly,
      matchThreePly: item.probeMatchThreePly,
    },
  };
});

// Build representative cube boundary fixtures (Money + Match)
const cubePositions = [];
const cubeRolls = [[3, 1], [6, 2], [5, 4], [4, 2], [6, 5]];
for (let i = 0; i < Math.min(15, cubeParityData.positions.length); i += 1) {
  const p = cubeParityData.positions[i * 3] ?? cubeParityData.positions[i];
  const [d1, d2] = cubeRolls[i % cubeRolls.length];
  const board = Board.fromJson({ points: p.points, bar: p.bar, off: p.off });
  const moves = generateMoves(board, p.turn, d1, d2);
  if (moves.length < 2) continue;
  cubePositions.push({
    id: `C-MON-${String(cubePositions.length + 1).padStart(2, '0')}`,
    mode: 'money',
    board: { points: p.points, bar: p.bar, off: p.off },
    player: p.turn,
    die1: d1,
    die2: d2,
    cubeValue: p.cube_value,
    cubeOwner: p.cube_owner ?? 'center',
    jacoby: p.jacoby,
    expectedEngineShouldDouble: p.should_double,
    expectedEngineShouldAcceptDouble: p.should_accept_double,
    context: {
      cube: {
        value: p.cube_value,
        owner: p.cube_owner ?? 'center',
        enabled: true,
        available: (p.cube_owner === null || p.cube_owner === p.turn) && p.cube_value < 64,
        unboundedMoney: false,
      },
      match: { mode: 'money', jacoby: p.jacoby },
    },
  });
}

for (let i = 0; i < matchCubeParityData.cases.length; i += 1) {
  const c = matchCubeParityData.cases[i];
  const boardDto = matchCubeParityData.board;
  const [d1, d2] = cubeRolls[i % cubeRolls.length];
  const board = Board.fromJson(boardDto);
  const moves = generateMoves(board, WHITE, d1, d2);
  if (moves.length < 2) continue;
  const cubeOwner = c.owner === 'me' ? WHITE : c.owner === 'opponent' ? BLACK : 'center';
  cubePositions.push({
    id: `C-MAT-${String(i + 1).padStart(2, '0')}`,
    mode: 'match',
    board: boardDto,
    player: WHITE,
    die1: d1,
    die2: d2,
    cubeValue: c.cube_value,
    cubeOwner,
    awayWhite: c.away_white,
    awayBlack: c.away_black,
    crawford: false,
    crawfordPlayed: c.crawford_played,
    expectedEngineShouldDouble: null,
    expectedEngineShouldAcceptDouble: null,
    context: {
      cube: {
        value: c.cube_value,
        owner: cubeOwner,
        enabled: true,
        available: c.cube_value < 64 && (cubeOwner === 'center' || cubeOwner === WHITE),
        unboundedMoney: false,
      },
      match: {
        mode: 'match',
        targetPoints: 7,
        scoreWhite: 7 - c.away_white,
        scoreBlack: 7 - c.away_black,
        crawford: false,
        crawfordPlayed: c.crawford_played,
        jacoby: false,
      },
    },
  });
}
// Also add Match cube boundary positions from cubeParityData (diverse boards)
for (let i = 0; i < 8 && i * 6 < cubeParityData.positions.length; i += 1) {
  const p = cubeParityData.positions[i * 6];
  const [d1, d2] = cubeRolls[(i + 2) % cubeRolls.length];
  const board = Board.fromJson({ points: p.points, bar: p.bar, off: p.off });
  const moves = generateMoves(board, p.turn, d1, d2);
  if (moves.length < 2) continue;
  const awayWhite = i % 3 === 0 ? 2 : i % 3 === 1 ? 4 : 5;
  const awayBlack = i % 2 === 0 ? 3 : 4;
  cubePositions.push({
    id: `C-MAT-${String(cubePositions.filter((x) => x.mode === 'match').length + 1).padStart(2, '0')}`,
    mode: 'match',
    board: { points: p.points, bar: p.bar, off: p.off },
    player: p.turn,
    die1: d1,
    die2: d2,
    cubeValue: p.cube_value,
    cubeOwner: p.cube_owner ?? 'center',
    awayWhite,
    awayBlack,
    crawford: false,
    crawfordPlayed: i === 7,
    expectedEngineShouldDouble: null,
    expectedEngineShouldAcceptDouble: null,
    context: {
      cube: {
        value: p.cube_value,
        owner: p.cube_owner ?? 'center',
        enabled: true,
        available: p.cube_value < 64 && (p.cube_owner === null || p.cube_owner === p.turn),
        unboundedMoney: false,
      },
      match: {
        mode: 'match',
        targetPoints: 7,
        scoreWhite: 7 - awayWhite,
        scoreBlack: 7 - awayBlack,
        crawford: false,
        crawfordPlayed: i === 7,
        jacoby: false,
      },
    },
  });
}

const countBy = (arr, fn) => arr.reduce((acc, x) => {
  const k = fn(x);
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});

const output = {
  metadata: {
    description: 'Fixed evaluation fixtures for Issue #549 (staged3ply vs Legacy vs Full-root)',
    seed: SEED,
    generator: 'tools/build-staged3ply-eval-fixtures.mjs',
    totalPositions: positions.length,
    totalCubePositions: cubePositions.length,
    countsByCategory: countBy(positions, (p) => p.category),
    countsByStratum: countBy(positions, (p) => p.stratum),
    countsBySource: countBy(positions, (p) => p.source),
  },
  positions,
  cubePositions,
};

const outPath = resolve(repoRoot, 'tests/backgammon/staged-3ply-eval-fixtures.json');
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output.metadata, null, 2));
