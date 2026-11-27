import { Board, WHITE, BLACK, opponent } from './board.js';
import { Game, ROLLING } from './game.js';
import { generateMoves, boardKey } from './rules.js';
import { Agent, agentFor, filtersFor } from './agent.js';
import { equity, flipPerspective } from './nn.js';
import { matchWinChance, mwcWithCube, outcomeSpread } from './met.js';
import {
  wasmMatchCubeActionValues,
  wasmMoneyCubeActionValues,
  wasmScoreCheckerCandidates,
} from './wasm-backend.js';

const enginePlayer = (player) => {
  if (player === WHITE || player === 'white') return WHITE;
  if (player === BLACK || player === 'black') return BLACK;
  throw new Error(`unknown player: ${player}`);
};

const boardFromDto = (board) => {
  if (board instanceof Board) return board;
  if (Array.isArray(board)) return new Board([...board]);
  const bar = Array.isArray(board.bar)
    ? board.bar
    : [board.bar?.white ?? board.bar?.WHITE ?? 0, board.bar?.black ?? board.bar?.BLACK ?? 0];
  const off = Array.isArray(board.off)
    ? board.off
    : [board.off?.white ?? board.off?.WHITE ?? 0, board.off?.black ?? board.off?.BLACK ?? 0];
  return Board.fromJson({ points: [...board.points], bar, off });
};

const boardDto = (board) => ({
  points: [...board.points],
  bar: { white: board.bar.WHITE, black: board.bar.BLACK },
  off: { white: board.off.WHITE, black: board.off.BLACK },
});

const diceOf = (position) => position.dice
  ? [position.dice.die1, position.dice.die2]
  : null;

const CHECKER_SEARCH_CACHE_LIMIT = 100_000;

function makeAgent(net, profile = {}) {
  const overrides = {};
  if (profile.checkerSearchMode !== undefined) overrides.checkerSearchMode = profile.checkerSearchMode;
  if (profile.useMoneyBearoff !== undefined) overrides.useMoneyBearoff = profile.useMoneyBearoff;
  if (profile.pruneNet !== undefined) overrides.pruneNet = profile.pruneNet;
  if (profile.leafPruneCandidates !== undefined) overrides.leafPruneCandidates = profile.leafPruneCandidates;
  if (profile.leafPruneTolerance !== undefined) overrides.leafPruneTolerance = profile.leafPruneTolerance;
  if (profile.backend !== undefined) overrides.backend = profile.backend;
  if (profile.levelId) return agentFor(net, profile.levelId, overrides);
  const plies = profile.plies ?? 0;
  return new Agent(net, plies, filtersFor(plies), {
    noise: profile.noise ?? 0,
    maxLoss: profile.maxLoss ?? Infinity,
    checkerSearchMode: profile.checkerSearchMode ?? 'full-root',
    ...(profile.useMoneyBearoff !== undefined ? { useMoneyBearoff: profile.useMoneyBearoff } : {}),
    ...(profile.pruneNet !== undefined ? { pruneNet: profile.pruneNet } : {}),
    ...(profile.leafPruneCandidates !== undefined ? { leafPruneCandidates: profile.leafPruneCandidates } : {}),
    ...(profile.leafPruneTolerance !== undefined ? { leafPruneTolerance: profile.leafPruneTolerance } : {}),
    ...(profile.backend !== undefined ? { backend: profile.backend } : {}),
    ...(profile.cube ?? {}),
  });
}

function moveDto(move, index) {
  return {
    id: boardKey(move.resultingBoard),
    index,
    notation: move.toString(),
    resultingBoard: boardDto(move.resultingBoard),
  };
}

function probabilityDto(vector, player) {
  const whiteVector = player === WHITE ? vector : flipPerspective(vector);
  const spread = outcomeSpread(whiteVector, true);
  return {
    win: spread.win1 + spread.win2 + spread.win3,
    winGammon: spread.win2 + spread.win3,
    winBackgammon: spread.win3,
    lose: spread.lose1 + spread.lose2 + spread.lose3,
    loseGammon: spread.lose2 + spread.lose3,
    loseBackgammon: spread.lose3,
  };
}

function matchContext(position, proposer) {
  const match = position.match;
  if (!match || match.mode !== 'match') return null;
  const target = match.targetPoints;
  if (!target) throw new Error('targetPoints is required for match play');
  return {
    length: target,
    away: {
      [WHITE]: Math.max(0, target - match.scoreWhite),
      [BLACK]: Math.max(0, target - match.scoreBlack),
    },
    // Crawford局の着手結果は、その局が終わる時点でCrawford消化済み。
    crawfordPlayed: Boolean(match.crawfordPlayed || match.crawford),
    proposer,
  };
}

function gameFromPosition(position) {
  const player = enginePlayer(position.turn);
  const game = new Game(boardFromDto(position.board), Math.random, {
    jacoby: Boolean(position.match?.mode === 'money' && position.match?.jacoby),
    crawford: Boolean(position.match?.crawford),
    unboundedMoneyCube: Boolean(position.match?.mode === 'money' && position.cube?.unboundedMoney),
  });
  game.currentPlayer = player;
  game.state = ROLLING;
  if (position.cube) {
    game.cube.value = position.cube.value;
    const owner = position.cube.owner;
    game.cube.owner = owner === 'center' || owner == null ? null : enginePlayer(owner);
  }
  return game;
}

export function getLegalMoves(position, { backend = null } = {}) {
  const dice = diceOf(position);
  if (!dice) return [];
  const board = boardFromDto(position.board);
  const player = enginePlayer(position.turn);
  return generateMoves(board, player, dice[0], dice[1], backend).map(moveDto);
}

/**
 * #289: 全checker API共通の着手価値。着手が終わった直後なので次は相手の
 * ROLLINGであり、次のロール前に相手がダブルできる点が重要。
 *
 * PositionDto.cube.available は「現在の手番側がダブルできる」フラグであって
 * 「キューブがゲーム全体で無効」という意味ではない。相手保持なら false でも
 * 相手は次手番で行使できる。新しい enabled が指定されている場合はこちらを優先する。
 */
function checkerCubeEnabled(position) {
  if (position.cube?.enabled !== undefined) return Boolean(position.cube.enabled);
  if (position.match?.mode === 'match' && position.match.crawford) return false;
  // 従来DTOではセンターにもかかわらずavailable=falseならcube無効。
  // 所有者がいる場合はavailable=falseでも対戦相手の行使権が残っている。
  return !(position.cube?.owner === 'center' && position.cube.available === false);
}

function checkerCubeCanRedouble(position) {
  return checkerCubeEnabled(position) && !position.match?.crawford
    && ((position.cube?.value ?? 1) < 64
      || (position.match?.mode === 'money' && position.cube?.unboundedMoney === true));
}

function checkerSearchDepth(agent, position, mode = 'full-root') {
  const depth = Math.max(0, agent.searchPlies - 1);
  if (mode === 'full-root' || mode === 'staged3ply') return depth;
  return position.match?.mode === 'match' || checkerCubeCanRedouble(position)
    ? Math.min(depth, 1)
    : depth;
}

function withCheckerSearchCache(agent, callback) {
  const oldCubeful = agent.cubefulSearch;
  const oldMwc = agent.mwcSearch;
  const oldRollCache = agent.checkerRollCache;
  const cubefulCache = new Map();
  const mwcCache = new Map();
  if (!oldRollCache) {
    agent.checkerRollCache = new Map();
    agent.checkerSearchStats = {
      rollExpansionHits: 0,
      rollExpansionMisses: 0,
      batchCalls: 0,
      batchVectors: 0,
    };
  }

  agent.cubefulSearch = function memoizedCubeful(board, ...args) {
    if (!Array.isArray(board?.points)) return oldCubeful.call(this, board, ...args);
    const [turn, owner, depth, jacoby, leaf, cubeEfficiency, rawOptions = {}] = args;
    const options = rawOptions ?? {};
    if (options.rollIndices != null) return oldCubeful.call(this, board, ...args);
    const key = `${boardKey(board)}|${turn}|${owner}|${depth}|${jacoby ? 1 : 0}|${leaf ?? this.cubeLeafPlies}|${cubeEfficiency ?? this.cubeEfficiency}|${options.cashOption ? 1 : 0}|${options.cashAlpha ?? this.cubeCashAlpha}|${options.cashPolicy?.alpha ?? ''}|${options.cubeValue ?? 1}|${options.allowDouble === false ? 0 : 1}|${options.actionContext ?? 'post_no_double'}|${options.unboundedMoney ? 1 : 0}`;
    if (cubefulCache.has(key)) return cubefulCache.get(key);
    const value = oldCubeful.call(this, board, ...args);
    if (cubefulCache.size < CHECKER_SEARCH_CACHE_LIMIT) cubefulCache.set(key, value);
    return value;
  };

  agent.mwcSearch = function memoizedMwc(board, ...args) {
    if (!Array.isArray(board?.points)) return oldMwc.call(this, board, ...args);
    const [turn, owner, depth, cube, match, leaf, matchCubeEfficiency, allowDouble, rollIndices] = args;
    if (rollIndices != null) return oldMwc.call(this, board, ...args);
    const key = `${boardKey(board)}|${turn}|${owner}|${depth}|${cube}|${match?.away?.[turn] ?? ''}|${match?.away?.[opponent(turn)] ?? ''}|${match?.crawfordPlayed ? 1 : 0}|${leaf ?? this.cubeLeafPlies}|${matchCubeEfficiency ?? this.matchCubeEfficiency}|${allowDouble === false ? 0 : 1}`;
    if (mwcCache.has(key)) return mwcCache.get(key);
    const value = oldMwc.call(this, board, ...args);
    if (mwcCache.size < CHECKER_SEARCH_CACHE_LIMIT) mwcCache.set(key, value);
    return value;
  };

  try {
    return callback();
  } finally {
    agent.cubefulSearch = oldCubeful;
    agent.mwcSearch = oldMwc;
    agent.checkerRollCache = oldRollCache;
  }
}

function checkerProbabilityVector(agent, board, player, depth) {
  const next = opponent(player);
  return agent.terminalVector(board) ??
    (depth > 0
      ? agent.expandRollsVector(board, next, depth, 1)
      : agent.vectorFor(board, next));
}

function checkerEfficiencies(agent, position, board, player, match, enabled) {
  const next = opponent(player);
  const cubeValue = position.cube?.value ?? 1;
  const rawOwner = position.cube?.owner ?? 'center';
  const owner = rawOwner === 'center' ? 'center'
    : enginePlayer(rawOwner) === next ? 'me' : 'opponent';

  if (match) {
    if (!enabled || position.match?.crawford) return { xNd: null, xDt: null };
    let xNd = agent.matchCubeEfficiency;
    let xDt = agent.matchCubeEfficiency;
    if (agent.useCubeHead && agent.cubeHeadMatch) {
      [xNd, xDt] = agent.matchCubeHeadActionEfficiencies(
        board, next, cubeValue, owner, match);
    }
    return { xNd, xDt };
  }
  if (!enabled) return { xNd: null, xDt: null };

  let xNd = agent.cubeEfficiency;
  let xDt = agent.cubeEfficiencyDtFor(board, next);
  if (agent.useCubeHead && agent.cubeHeadMoney) {
    [xNd, xDt] = agent.cubeHeadActionEfficiencies(
      board, next, cubeValue, owner);
  }
  return { xNd, xDt };
}

function checkerValue(agent, position, board, player, match, enabled, depth,
  includeProbabilityVector = false, efficiencies = null) {
  const next = opponent(player);
  const cubeValue = position.cube?.value ?? 1;
  const rawOwner = position.cube?.owner ?? 'center';
  const owner = rawOwner === 'center' ? 'center'
    : enginePlayer(rawOwner) === next ? 'me' : 'opponent';
  const unboundedMoney = Boolean(position.match?.mode === 'money' && position.cube?.unboundedMoney === true);
  const canOffer = checkerCubeCanRedouble(position) && owner !== 'opponent';

  if (match) {
    // MWC は0〜1。Moneyの点数equityと混ぜない。
    if (!enabled || position.match?.crawford) {
      // Crawford / cube OFF ではキューブ価値は固定。future doubleも禁止。
      return 1 - agent.mwcSearch(board, next, owner, depth, cubeValue, match,
        0, null, false);
    }
    const { xNd, xDt } = efficiencies ?? checkerEfficiencies(agent, position, board, player, match, enabled);
    const nd = agent.mwcSearch(board, next, owner, depth, cubeValue, match, 0, xNd);
    if (!canOffer) return 1 - nd;
    const dt = agent.mwcSearch(board, next, 'opponent', depth, cubeValue * 2, match, 0, xDt);
    const pass = matchWinChance(match.away[next] - cubeValue,
      match.away[player], match.crawfordPlayed);
    return 1 - Math.max(nd, Math.min(dt, pass));
  }

  const jacoby = Boolean(position.match?.jacoby && cubeValue === 1 && owner === 'center');
  if (!enabled) {
    // 将来ダブルできない場合はキューブが固定。Jacobyの未ダブルG/BGは1点。
    const vector = checkerProbabilityVector(agent, board, player, depth);
    const playerVector = player === WHITE ? vector : flipPerspective(vector);
    const value = jacoby ? 2 * playerVector[0] - 1 : equity(playerVector);
    return includeProbabilityVector ? { value, probabilityVector: vector } : value;
  }

  const { xNd, xDt } = efficiencies ?? checkerEfficiencies(agent, position, board, player, match, enabled);
  const nd = agent.cubefulSearch(board, next, owner, depth, jacoby, 0, xNd,
    {
      cashPolicy: agent.cubeCashOption ? { alpha: agent.cubeCashAlpha } : null,
      cubeValue,
      unboundedMoney,
    });
  if (!canOffer) return -nd;
  const dt = 2 * agent.cubefulSearch(board, next, 'opponent', depth, false, 0, xDt,
    {
      cubeValue: cubeValue * 2,
      actionContext: 'post_double_take',
      unboundedMoney,
    });
  return -Math.max(nd, Math.min(dt, 1));
}

function stagedCandidates(values, margin, maximum) {
  const ordered = [...values.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const best = ordered[0]?.[1];
  if (best === undefined) return [];
  return ordered.filter(([, value]) => value >= best - margin)
    .slice(0, maximum).map(([index]) => index);
}

function stagedMetric(position) {
  if (position.match?.mode === 'match') {
    return { firstMargin: 0.010, secondMargin: 0.005, unit: 'mwc' };
  }
  if (checkerCubeEnabled(position) && !position.match?.crawford) {
    return { firstMargin: 0.160, secondMargin: 0.080, unit: 'equity' };
  }
  return null;
}

function scoreStagedCheckerMoves(agent, position, moves, player, match, enabled,
  captureProbabilityVectors = false) {
  const metric = stagedMetric(position);
  if (!metric || agent.searchPlies !== 3 || moves.length <= 1) {
    const depth = checkerSearchDepth(agent, position, 'staged3ply');
    return moves.map((move, index) => {
      const score = checkerValue(agent, position, move.resultingBoard,
        player, match, enabled, depth, captureProbabilityVectors);
      return captureProbabilityVectors
        ? { move, index, ...score }
        : { move, index, value: score };
    }).sort((a, b) => b.value - a.value || a.index - b.index);
  }

  const values = new Map();
  const stages = new Map();
  const effByIndex = new Map();
  for (let index = 0; index < moves.length; index += 1) {
    const eff = checkerEfficiencies(agent, position, moves[index].resultingBoard, player, match, enabled);
    effByIndex.set(index, eff);
    values.set(index, checkerValue(agent, position, moves[index].resultingBoard,
      player, match, enabled, 0, false, eff));
    stages.set(index, 1);
  }
  let candidates = stagedCandidates(values, metric.firstMargin, 8);
  agent.checkerLastStagedSearch = {
    unit: metric.unit,
    firstMargin: metric.firstMargin,
    secondMargin: metric.secondMargin,
    onePlyCandidates: moves.length,
    twoPlyCandidates: candidates.length,
    threePlyCandidates: 0,
    maxAdditionalDepth: 0,
  };

  if (candidates.length > 1) {
    for (const index of candidates) {
      values.set(index, checkerValue(agent, position, moves[index].resultingBoard,
        player, match, enabled, 1, false, effByIndex.get(index)));
      stages.set(index, 2);
    }
    agent.checkerLastStagedSearch.maxAdditionalDepth = 1;
    candidates = stagedCandidates(new Map(candidates.map((index) =>
      [index, values.get(index)])), metric.secondMargin, 4);
    agent.checkerLastStagedSearch.threePlyCandidates = candidates.length;
  } else {
    candidates = [];
  }

  if (candidates.length > 1) {
    for (const index of candidates) {
      values.set(index, checkerValue(agent, position, moves[index].resultingBoard,
        player, match, enabled, 2, false, effByIndex.get(index)));
      stages.set(index, 3);
    }
    agent.checkerLastStagedSearch.maxAdditionalDepth = 2;
  }

  return moves.map((move, index) => ({
    move,
    index,
    value: values.get(index),
    searchStage: stages.get(index),
  })).sort((a, b) => b.searchStage - a.searchStage
    || b.value - a.value || a.index - b.index);
}

function resolveCheckerSearchMode(agent, requestedMode = null) {
  const mode = requestedMode ?? agent.checkerSearchMode ?? 'full-root';
  if (!['legacy', 'full-root', 'staged3ply'].includes(mode)) {
    throw new Error(`未対応のcheckerSearchMode: ${mode}`);
  }
  return mode;
}

/** 同じ局面とprofileならCPU、ヒント、解析で同一の着手価値を使う。 */
export function scoreCheckerMoves(position, agent, moves, player, {
  reuseProbabilityVectors = false,
  mode: requestedMode = null,
} = {}) {
  const match = matchContext(position, player);
  const enabled = checkerCubeEnabled(position);
  const mode = resolveCheckerSearchMode(agent, requestedMode);
  // MWC検索・cubeful検索は別の目的関数で着手を選ぶため、再利用はMoneyのcube OFFに限る。
  const captureProbabilityVectors = reuseProbabilityVectors && !enabled && !match;

  if (moves.length > 0 && agent.noise <= 0 && agent.resolveBackend({ board: moves[0].resultingBoard }) === 'wasm') {
    const next = opponent(player);
    const cubeValue = position.cube?.value ?? 1;
    const rawOwner = position.cube?.owner ?? 'center';
    const ownerOfNext = rawOwner === 'center' ? 'center'
      : enginePlayer(rawOwner) === next ? 'me' : 'opponent';
    const unboundedMoney = Boolean(position.match?.mode === 'money' && position.cube?.unboundedMoney === true);
    const canOffer = checkerCubeCanRedouble(position) && ownerOfNext !== 'opponent';
    const effectiveEnabled = match ? (enabled && !position.match?.crawford) : enabled;
    const jacoby = Boolean(!match && position.match?.jacoby && cubeValue === 1 && ownerOfNext === 'center');
    const metric = mode === 'staged3ply' ? stagedMetric(position) : null;
    const useStaged = Boolean(mode === 'staged3ply' && metric && agent.searchPlies === 3 && moves.length > 1);
    const depth = checkerSearchDepth(agent, position, mode);
    const res = wasmScoreCheckerCandidates(agent, {
      boards: moves.map((m) => m.resultingBoard),
      player,
      match,
      cubeEnabled: effectiveEnabled,
      canOffer,
      cubeValue,
      ownerOfNext,
      jacoby,
      unboundedMoney,
      depth,
      staged: useStaged,
      stagedFirstMargin: metric?.firstMargin ?? 0.160,
      stagedSecondMargin: metric?.secondMargin ?? 0.080,
      captureProbVectors: captureProbabilityVectors && !useStaged,
    });
    if (useStaged && res.stagedStats) {
      agent.checkerLastStagedSearch = {
        unit: metric.unit,
        firstMargin: metric.firstMargin,
        secondMargin: metric.secondMargin,
        ...res.stagedStats,
      };
      return moves.map((move, index) => ({
        move,
        index,
        value: res.values[index],
        searchStage: res.stages[index],
      })).sort((a, b) => b.searchStage - a.searchStage
        || b.value - a.value || a.index - b.index);
    }
    return moves.map((move, index) => (
      res.probVectors
        ? { move, index, value: res.values[index], probabilityVector: res.probVectors[index] }
        : { move, index, value: res.values[index] }
    )).sort((a, b) => b.value - a.value || a.index - b.index);
  }

  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () => {
    if (mode === 'staged3ply') {
      return scoreStagedCheckerMoves(
        agent, position, moves, player, match, enabled, captureProbabilityVectors);
    }
    const depth = checkerSearchDepth(agent, position, mode);
    return moves.map((move, index) => {
      const score = checkerValue(
        agent, position, move.resultingBoard, player, match, enabled, depth,
        captureProbabilityVectors);
      return captureProbabilityVectors
        ? { move, index, ...score }
        : { move, index, value: score };
    }).sort((a, b) => b.value - a.value || a.index - b.index);
  }));
}

export function selectMove(position, { net, profile } = {}) {
  const dice = diceOf(position);
  if (!dice) throw new Error('dice are required');
  const board = boardFromDto(position.board);
  const player = enginePlayer(position.turn);
  const agent = makeAgent(net, profile);
  const moves = generateMoves(board, player, dice[0], dice[1], agent.resolveBackend({ board }));
  if (!moves.length) return null;
  const requestedMode = resolveCheckerSearchMode(agent);
  const mode = agent.noise > 0 && requestedMode === 'staged3ply'
    ? 'full-root'
    : requestedMode;
  const scored = scoreCheckerMoves(position, agent, moves, player, { mode });
  const best = scored[0].value;
  let selected = scored[0], selectedScore = -Infinity;
  for (const entry of scored) {
    if (entry.value < best - agent.maxLoss) continue;
    const noisyValue = entry.value + agent.noiseFor(entry.move.resultingBoard);
    if (noisyValue > selectedScore) {
      selectedScore = noisyValue;
      selected = entry;
    }
  }
  return moveDto(selected.move, selected.index);
}

export function analyzeChecker(position, {
  net,
  profile,
  topN = 5,
  userMoveId = null,
  probabilityPlies = undefined,
} = {}) {
  const dice = diceOf(position);
  if (!dice) throw new Error('dice are required');
  const board = boardFromDto(position.board);
  const player = enginePlayer(position.turn);
  const agent = makeAgent(net, profile);
  const moves = generateMoves(board, player, dice[0], dice[1], agent.resolveBackend({ board }));
  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () => {
    const scored = scoreCheckerMoves(position, agent, moves, player, {
      reuseProbabilityVectors: true,
    });
    const deepestStage = Math.max(0, ...scored.map((entry) => entry.searchStage ?? 0));
    const bestEntry = deepestStage > 0
      ? (scored.find((entry) => (entry.searchStage ?? 0) === deepestStage) ?? scored[0])
      : scored[0];
    const best = bestEntry?.value ?? 0;
    const probDepth = probabilityPlies !== undefined
      ? Math.max(0, probabilityPlies - 1)
      : Math.max(0, agent.searchPlies - 1);

    const toCandidate = (entry) => {
      const after = entry.move.resultingBoard;
      const vector = entry.probabilityVector ?? checkerProbabilityVector(
        agent, after, player, probDepth);
      return {
        move: moveDto(entry.move, entry.index),
        equity: entry.value,
        diffFromBest: best - entry.value,
        ...(entry.searchStage !== undefined ? { searchStage: entry.searchStage } : {}),
        // 5-vectorは勝敗確率の参考値。cubeful評価値とは別の指標。
        probabilities: probabilityDto(vector, player),
      };
    };
    const candidates = scored.slice(0, topN).map(toCandidate);
    const userEntry = userMoveId
      ? scored.find((e) => boardKey(e.move.resultingBoard) === userMoveId) : null;
    return {
      candidates, userMove: userEntry ? toCandidate(userEntry) : null,
      // Moneyは現在のキューブ1単位、Matchはマッチ勝率。異なる単位でlossを比較しない。
      unit: position.match?.mode === 'match' ? 'mwc' : 'cube-units',
      // Crawford局とcube 64（unbounded Moneyを除く）では、設定にかかわらずfuture doubleがない。
      evaluation: checkerCubeCanRedouble(position) ? 'cubeful' : 'cube-disabled',
    };
  }));
}

/**
 * 並列解析用: 指定した合法手サブセットを任意の深さ（0=1-ply, 1=2-ply, 2=3-ply）で評価する。
 * moveIds省略時は全合法手を対象にする。
 */
export function evaluateCheckerMoves(position, {
  net,
  profile,
  moveIds = null,
  depth = null,
  efficienciesByMoveId = null,
} = {}) {
  const dice = diceOf(position);
  if (!dice) throw new Error('dice are required');
  const board = boardFromDto(position.board);
  const player = enginePlayer(position.turn);
  const agent = makeAgent(net, profile);
  const moves = generateMoves(board, player, dice[0], dice[1], agent.resolveBackend({ board }));
  const match = matchContext(position, player);
  const enabled = checkerCubeEnabled(position);
  const resolvedDepth = depth ?? checkerSearchDepth(agent, position, 'full-root');
  const filterSet = moveIds ? new Set(moveIds) : null;

  const selected = [];
  for (let index = 0; index < moves.length; index += 1) {
    const move = moves[index];
    const id = boardKey(move.resultingBoard);
    if (filterSet && !filterSet.has(id)) continue;
    selected.push({ move, id, index });
  }

  if (selected.length > 0 && agent.noise <= 0 && agent.resolveBackend({ board: selected[0].move.resultingBoard }) === 'wasm') {
    const next = opponent(player);
    const cubeValue = position.cube?.value ?? 1;
    const rawOwner = position.cube?.owner ?? 'center';
    const ownerOfNext = rawOwner === 'center' ? 'center'
      : enginePlayer(rawOwner) === next ? 'me' : 'opponent';
    const unboundedMoney = Boolean(position.match?.mode === 'money' && position.cube?.unboundedMoney === true);
    const canOffer = checkerCubeCanRedouble(position) && ownerOfNext !== 'opponent';
    const effectiveEnabled = match ? (enabled && !position.match?.crawford) : enabled;
    const jacoby = Boolean(!match && position.match?.jacoby && cubeValue === 1 && ownerOfNext === 'center');
    const suppliedEffs = efficienciesByMoveId
      ? selected.map(({ id }) => efficienciesByMoveId[id] ?? null)
      : null;
    const res = wasmScoreCheckerCandidates(agent, {
      boards: selected.map(({ move }) => move.resultingBoard),
      player,
      match,
      cubeEnabled: effectiveEnabled,
      canOffer,
      cubeValue,
      ownerOfNext,
      jacoby,
      unboundedMoney,
      depth: resolvedDepth,
      staged: false,
      suppliedEffs,
      captureProbVectors: false,
    });
    return {
      entries: selected.map(({ id, index }, i) => ({
        moveId: id,
        index,
        equity: res.values[i],
        efficiencies: res.effs[i],
      })),
      unit: position.match?.mode === 'match' ? 'mwc' : 'cube-units',
      evaluation: checkerCubeCanRedouble(position) ? 'cubeful' : 'cube-disabled',
    };
  }

  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () => {
    const entries = [];
    for (const { move, id, index } of selected) {
      const providedEff = efficienciesByMoveId?.[id] ?? null;
      const eff = providedEff ?? checkerEfficiencies(agent, position, move.resultingBoard, player, match, enabled);
      const value = checkerValue(
        agent, position, move.resultingBoard, player, match, enabled, resolvedDepth, false, eff);
      entries.push({
        moveId: id,
        index,
        equity: value,
        efficiencies: eff,
      });
    }
    return {
      entries,
      unit: position.match?.mode === 'match' ? 'mwc' : 'cube-units',
      evaluation: checkerCubeCanRedouble(position) ? 'cubeful' : 'cube-disabled',
    };
  }));
}

/**
 * 並列解析用: 1つの候補手に対する21ロールのチャンク評価（depth >= 1向け）。
 * 候補数がWorker数より少ないときに1手をさらにロール並列化できる。
 */
export function evaluateCheckerMoveRollChunk(position, {
  net,
  profile,
  moveId,
  rollIndices,
  depth,
  efficiencies = null,
} = {}) {
  const dice = diceOf(position);
  if (!dice) throw new Error('dice are required');
  const board = boardFromDto(position.board);
  const player = enginePlayer(position.turn);
  const agent = makeAgent(net, profile);
  const moves = generateMoves(board, player, dice[0], dice[1], agent.resolveBackend({ board }));
  const move = moves.find((candidate) => boardKey(candidate.resultingBoard) === moveId);
  if (!move) throw new Error(`指定されたmoveIdが見つかりません: ${moveId}`);

  const match = matchContext(position, player);
  const enabled = checkerCubeEnabled(position);
  const next = opponent(player);
  const cubeValue = position.cube?.value ?? 1;
  const rawOwner = position.cube?.owner ?? 'center';
  const owner = rawOwner === 'center' ? 'center'
    : enginePlayer(rawOwner) === next ? 'me' : 'opponent';
  const unboundedMoney = Boolean(position.match?.mode === 'money' && position.cube?.unboundedMoney === true);
  const canOffer = checkerCubeCanRedouble(position) && owner !== 'opponent';
  const after = move.resultingBoard;

  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () => {
    if (match) {
      if (!enabled || position.match?.crawford) {
        const ndPart = agent.mwcSearch(after, next, owner, depth, cubeValue, match, 0, null, false, rollIndices);
        return { kind: 'match-fixed', ndPart };
      }
      const { xNd, xDt } = efficiencies ?? checkerEfficiencies(agent, position, after, player, match, enabled);
      const ndPart = agent.mwcSearch(after, next, owner, depth, cubeValue, match, 0, xNd, true, rollIndices);
      const dtPart = canOffer
        ? agent.mwcSearch(after, next, 'opponent', depth, cubeValue * 2, match, 0, xDt, true, rollIndices)
        : null;
      const pass = canOffer
        ? matchWinChance(match.away[next] - cubeValue, match.away[player], match.crawfordPlayed)
        : null;
      return { kind: 'match-cubeful', ndPart, dtPart, pass };
    }

    const jacoby = Boolean(position.match?.jacoby && cubeValue === 1 && owner === 'center');
    if (!enabled) {
      const vecPart = agent.expandRollsVector(after, next, depth, 1, rollIndices);
      return { kind: 'money-fixed', vecPart: Array.from(vecPart), jacoby };
    }

    const { xNd, xDt } = efficiencies ?? checkerEfficiencies(agent, position, after, player, match, enabled);
    const ndPart = agent.cubefulSearch(after, next, owner, depth, jacoby, 0, xNd, {
      cashPolicy: agent.cubeCashOption ? { alpha: agent.cubeCashAlpha } : null,
      cubeValue,
      unboundedMoney,
      rollIndices,
    });
    const dtPart = canOffer
      ? 2 * agent.cubefulSearch(after, next, 'opponent', depth, false, 0, xDt, {
          cubeValue: cubeValue * 2,
          actionContext: 'post_double_take',
          unboundedMoney,
          rollIndices,
        })
      : null;
    return { kind: 'money-cubeful', ndPart, dtPart };
  }));
}

/** 並列解析用: evaluateCheckerMoveRollChunk の全チャンクを合算して1手分のequityへ戻す。 */
export function combineCheckerMoveRollChunks(position, chunks) {
  if (!chunks?.length) throw new Error('chunks must not be empty');
  const first = chunks[0];
  if (first.kind === 'match-fixed') {
    const nd = chunks.reduce((sum, c) => sum + c.ndPart, 0);
    return 1 - nd;
  }
  if (first.kind === 'match-cubeful') {
    const nd = chunks.reduce((sum, c) => sum + c.ndPart, 0);
    if (first.dtPart === null) return 1 - nd;
    const dt = chunks.reduce((sum, c) => sum + c.dtPart, 0);
    return 1 - Math.max(nd, Math.min(dt, first.pass));
  }
  if (first.kind === 'money-fixed') {
    const vector = [0, 0, 0, 0, 0];
    for (const chunk of chunks) {
      for (let k = 0; k < 5; k += 1) vector[k] += chunk.vecPart[k];
    }
    const player = enginePlayer(position.turn);
    const playerVector = player === WHITE ? vector : flipPerspective(vector);
    return first.jacoby ? 2 * playerVector[0] - 1 : equity(playerVector);
  }
  const nd = chunks.reduce((sum, c) => sum + c.ndPart, 0);
  if (first.dtPart === null) return -nd;
  const dt = chunks.reduce((sum, c) => sum + c.dtPart, 0);
  return -Math.max(nd, Math.min(dt, 1));
}

/**
 * 並列解析用: staged3ply の次段候補 moveId を engine 固有の閾値・上限規則で選別する。
 * 対象外局面（Money cube OFF等）は null を返す。
 */
export function selectStagedCheckerMoveIds(position, scoredEntries, stage) {
  const metric = stagedMetric(position);
  if (!metric) return null;
  const margin = stage === 1 ? metric.firstMargin : metric.secondMargin;
  const maximum = stage === 1 ? 8 : 4;
  const valueByIndex = new Map();
  const idByIndex = new Map();
  for (const entry of scoredEntries) {
    valueByIndex.set(entry.index, entry.equity);
    idByIndex.set(entry.index, entry.moveId);
  }
  const selectedIndices = stagedCandidates(valueByIndex, margin, maximum);
  return {
    moveIds: selectedIndices.map((idx) => idByIndex.get(idx)),
    metric,
  };
}

/**
 * 並列解析用: 複数Workerで収集した評価済み候補から最終の CheckerAnalysis を組み立てる。
 */
export function finalizeCheckerAnalysis(position, {
  net,
  profile,
  entries,
  topN = 5,
  userMoveId = null,
  probabilityPlies = undefined,
} = {}) {
  const dice = diceOf(position);
  if (!dice) throw new Error('dice are required');
  const board = boardFromDto(position.board);
  const player = enginePlayer(position.turn);
  const agent = makeAgent(net, profile);
  const moves = generateMoves(board, player, dice[0], dice[1], agent.resolveBackend({ board }));
  const moveById = new Map(moves.map((move, index) => [boardKey(move.resultingBoard), { move, index }]));

  const scored = [];
  for (const entry of entries) {
    const resolved = moveById.get(entry.moveId);
    if (!resolved) continue;
    scored.push({
      move: resolved.move,
      index: resolved.index,
      value: entry.equity,
      ...(entry.searchStage !== undefined ? { searchStage: entry.searchStage } : {}),
    });
  }
  scored.sort((a, b) => (b.searchStage ?? 0) - (a.searchStage ?? 0)
    || b.value - a.value || a.index - b.index);

  const deepestStage = Math.max(0, ...scored.map((entry) => entry.searchStage ?? 0));
  const bestEntry = deepestStage > 0
    ? (scored.find((entry) => (entry.searchStage ?? 0) === deepestStage) ?? scored[0])
    : scored[0];
  const best = bestEntry?.value ?? 0;
  const probDepth = probabilityPlies !== undefined
    ? Math.max(0, probabilityPlies - 1)
    : Math.max(0, agent.searchPlies - 1);

  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () => {
    const toCandidate = (entry) => {
      const after = entry.move.resultingBoard;
      const vector = checkerProbabilityVector(agent, after, player, probDepth);
      return {
        move: moveDto(entry.move, entry.index),
        equity: entry.value,
        diffFromBest: best - entry.value,
        ...(entry.searchStage !== undefined ? { searchStage: entry.searchStage } : {}),
        probabilities: probabilityDto(vector, player),
      };
    };
    const candidates = scored.slice(0, topN).map(toCandidate);
    const userEntry = userMoveId
      ? scored.find((e) => boardKey(e.move.resultingBoard) === userMoveId) : null;
    return {
      candidates,
      userMove: userEntry ? toCandidate(userEntry) : null,
      unit: position.match?.mode === 'match' ? 'mwc' : 'cube-units',
      evaluation: checkerCubeCanRedouble(position) ? 'cubeful' : 'cube-disabled',
    };
  }));
}

function buildCubeAnalysisResult(rows, canDouble) {
  // Doubleの価値は相手の応答（Take / Pass）のうち提案者に不利な方。
  // 違法なDouble枝の値は診断用に残すが、推奨アクションの比較には使わない。
  const noDouble = rows[0].equity;
  const take = rows[1].equity;
  const pass = rows[2].equity;
  const doubleEquity = canDouble ? Math.min(take, pass) : null;
  const best = doubleEquity === null ? noDouble : Math.max(noDouble, doubleEquity);
  const recommendedAction = doubleEquity !== null && doubleEquity > noDouble
    ? 'double' : 'no-double';

  return {
    candidates: rows.map((row, index) => ({
      ...row,
      legal: index === 0 || canDouble,
      // Take / PassはDoubleという一つの選択肢を構成するため、差分も実効値で比べる。
      diffFromBest: index === 0
        ? best - noDouble
        : (canDouble ? best - doubleEquity : null),
    })),
    recommendedAction,
    doubleEquity,
  };
}

function resolveCubeProbabilityPlies(agent, cubeEnabled, probabilityPlies) {
  const canOverrideProbPlies = probabilityPlies !== undefined
    && agent.cubeDecision === 'search'
    && cubeEnabled;
  return canOverrideProbPlies ? probabilityPlies : agent.cubePlies;
}

/**
 * Cube分析は診断用にND/DT各枝を最後まで評価する。CPUのshouldDoubleSearchは
 * cubeScreenMarginで葉0の値を先に採用する場合があり、推奨行動が異なることがある。
 */
export function analyzeCube(position, { net, profile, probabilityPlies = undefined } = {}) {
  const game = gameFromPosition(position);
  const proposer = game.currentPlayer;
  const agent = makeAgent(net, profile);
  const match = matchContext(position, proposer);
  const owner = agent.cubeOwnerKind(game, proposer);
  const cubeEnabled = checkerCubeEnabled(position) && !position.match?.crawford;
  // `available`はcube権の条件。ロール後は、cube権があっても提案できない。
  const canDouble = cubeEnabled
    && position.dice === null
    && (game.cube.value < 64 || game.cube.unboundedMoney === true)
    && owner !== 'opponent'
    && position.cube?.available !== false;

  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () => {
    const vectorPlies = resolveCubeProbabilityPlies(agent, cubeEnabled, probabilityPlies);
    const vector = agent.searchedVectorFor(game.board, proposer, WHITE, vectorPlies);
    const probabilities = probabilityDto(vector, proposer);

    let rows;
    if (match) {
      const e = agent.cubeDecision === 'search'
        ? agent.matchCubeSearch(game, proposer, match, null, cubeEnabled)
        : (() => {
            const m = agent.matchCubeEquities(game.board, proposer, game.cube.value, match);
            return { noDouble: m.noDouble, take: m.take, drop: m.pass };
          })();
      rows = [
        { action: 'no-double', equity: e.noDouble, probabilities },
        { action: 'double-take', equity: e.take, probabilities },
        { action: 'double-pass', equity: e.drop, probabilities: {
          win: 1, winGammon: 0, winBackgammon: 0, lose: 0, loseGammon: 0, loseBackgammon: 0,
        }},
      ];
    } else {
      const exact = cubeEnabled && owner !== 'opponent' && agent.cubeDecision === 'search'
        ? agent.tryMoneyBg2nRoot(game, null, 'analyze_cube')
        : null;
      if (exact !== null) {
        rows = [
          { action: 'no-double', equity: exact.no_double, probabilities },
          { action: 'double-take', equity: exact.double_take, probabilities },
          { action: 'double-pass', equity: exact.double_pass, probabilities: {
            win: 1, winGammon: 0, winBackgammon: 0, lose: 0, loseGammon: 0, loseBackgammon: 0,
          }},
        ];
      } else {
        const jacoby = Boolean(game.jacoby && agent.cubeUntouched(game));
        const proposerVector = proposer === WHITE ? vector : flipPerspective(vector);
        const unboundedMoney = game.cube.unboundedMoney === true;
        // Head無効時は従来どおりnullを渡し、cubefulEquityの既定係数へフォールバックする。
        let xNd = null;
        let xDt = null;
        if (cubeEnabled && agent.useCubeHead && agent.cubeHeadMoney) {
          [xNd, xDt] = agent.cubeHeadActionEfficiencies(
            game.board, proposer, game.cube.value, owner);
        }
        // Cube OFF / Crawfordではcube所有価値や将来の提案機会を含めない固定cube評価。
        let noDouble;
        let take;
        if (
          cubeEnabled
          && !(agent.noise > 0 && agent.cubeLeafPlies === 0)
          && agent.resolveBackend({ board: game.board }) === 'wasm'
        ) {
          const res = wasmMoneyCubeActionValues(
            agent,
            game.board,
            proposer,
            owner,
            agent.cubeSearchDepth,
            jacoby,
            null,
            xNd ?? agent.cubeEfficiency,
            xDt ?? agent.cubeEfficiency,
            true,
            {
              cashOption: agent.cubeCashOption,
              cashAlpha: agent.cubeCashAlpha,
              cubeValue: game.cube.value,
              unboundedMoney,
            },
            true,
          );
          noDouble = res.noDouble;
          take = res.doubleTake;
        } else {
          noDouble = cubeEnabled
            ? agent.cubefulSearch(
                game.board, proposer, owner, agent.cubeSearchDepth, jacoby, null, xNd,
                {
                  cashOption: agent.cubeCashOption,
                  cashAlpha: agent.cubeCashAlpha,
                  cubeValue: game.cube.value,
                  actionContext: 'post_no_double',
                  unboundedMoney,
                })
            : jacoby ? 2 * proposerVector[0] - 1 : equity(proposerVector);
          take = 2 * agent.cubefulSearch(
            game.board, proposer, 'opponent', agent.cubeSearchDepth, false, null, xDt,
            {
              cubeValue: 2 * game.cube.value,
              actionContext: 'post_double_take',
              unboundedMoney,
            });
        }
        rows = [
          { action: 'no-double', equity: noDouble, probabilities },
          { action: 'double-take', equity: take, probabilities },
          { action: 'double-pass', equity: 1, probabilities: {
            win: 1, winGammon: 0, winBackgammon: 0, lose: 0, loseGammon: 0, loseBackgammon: 0,
          }},
        ];
      }
    }

    return buildCubeAnalysisResult(rows, canDouble);
  }));
}

/**
 * 並列キューブ解析用: ロール分割が必要か判定し、共有する効率係数(xNd/xDt)等を事前計算する。
 */
export function prepareCubeParallel(position, { net, profile, probabilityPlies = undefined } = {}) {
  const game = gameFromPosition(position);
  const proposer = game.currentPlayer;
  const agent = makeAgent(net, profile);
  const match = matchContext(position, proposer);
  const owner = agent.cubeOwnerKind(game, proposer);
  const cubeEnabled = checkerCubeEnabled(position) && !position.match?.crawford;
  const canDouble = cubeEnabled
    && position.dice === null
    && (game.cube.value < 64 || game.cube.unboundedMoney === true)
    && owner !== 'opponent'
    && position.cube?.available !== false;

  if (
    agent.cubeDecision !== 'search'
    || agent.cubeSearchDepth <= 0
    || (!match && !cubeEnabled)
    || agent.terminalVector(game.board) !== null
  ) {
    return { kind: 'complete', analysis: analyzeCube(position, { net, profile, probabilityPlies }) };
  }

  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () => {
    if (!match && cubeEnabled && owner !== 'opponent') {
      const exact = agent.tryMoneyBg2nRoot(game, null, 'analyze_cube');
      if (exact !== null) {
        const vectorPlies = resolveCubeProbabilityPlies(agent, cubeEnabled, probabilityPlies);
        const vector = agent.searchedVectorFor(game.board, proposer, WHITE, vectorPlies);
        const probabilities = probabilityDto(vector, proposer);
        const rows = [
          { action: 'no-double', equity: exact.no_double, probabilities },
          { action: 'double-take', equity: exact.double_take, probabilities },
          { action: 'double-pass', equity: exact.double_pass, probabilities: {
            win: 1, winGammon: 0, winBackgammon: 0, lose: 0, loseGammon: 0, loseBackgammon: 0,
          }},
        ];
        return { kind: 'complete', analysis: buildCubeAnalysisResult(rows, canDouble) };
      }
    }

    let xNd = null;
    let xDt = null;
    if (match) {
      xNd = agent.matchCubeEfficiency;
      xDt = agent.matchCubeEfficiency;
      if (agent.useCubeHead && agent.cubeHeadMatch) {
        [xNd, xDt] = agent.matchCubeHeadActionEfficiencies(game.board, proposer, game.cube.value, owner, match);
      }
    } else if (cubeEnabled && agent.useCubeHead && agent.cubeHeadMoney) {
      [xNd, xDt] = agent.cubeHeadActionEfficiencies(game.board, proposer, game.cube.value, owner);
    }

    const probDepth = resolveCubeProbabilityPlies(agent, cubeEnabled, probabilityPlies);
    return {
      kind: 'roll-chunks',
      rollCount: 21,
      context: {
        isMatch: Boolean(match),
        xNd,
        xDt,
        cubeEnabled,
        owner,
        canDouble,
        jacoby: Boolean(!match && game.jacoby && agent.cubeUntouched(game)),
        unboundedMoney: Boolean(!match && game.cube.unboundedMoney === true),
        probDepth,
      },
    };
  }));
}

/** 並列キューブ解析用: 指定ロール群の ND / DT / 参考確率ベクトルの重み付き部分和を返す。 */
export function evaluateCubeRollChunk(position, { net, profile, rollIndices, context } = {}) {
  const game = gameFromPosition(position);
  const proposer = game.currentPlayer;
  const agent = makeAgent(net, profile);
  const match = matchContext(position, proposer);

  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () => {
    const probVectorPart = context.probDepth >= 1
      ? Array.from(agent.expandRollsVector(game.board, proposer, context.probDepth, 0, rollIndices))
      : null;

    if (match) {
      if (!(agent.noise > 0 && agent.cubeLeafPlies === 0) && agent.resolveBackend({ board: game.board }) === 'wasm') {
        const res = wasmMatchCubeActionValues(
          agent,
          game.board,
          proposer,
          context.owner,
          agent.cubeSearchDepth,
          game.cube.value,
          match,
          null,
          context.xNd,
          context.xDt,
          true,
          context.cubeEnabled,
          rollIndices,
          true,
        );
        return { noDoublePart: res.noDouble, doubleTakePart: res.doubleTake, probVectorPart };
      }
      const noDoublePart = agent.mwcSearch(
        game.board, proposer, context.owner, agent.cubeSearchDepth,
        game.cube.value, match, null, context.xNd, context.cubeEnabled, rollIndices);
      const doubleTakePart = agent.mwcSearch(
        game.board, proposer, 'opponent', agent.cubeSearchDepth,
        game.cube.value * 2, match, null, context.xDt, context.cubeEnabled, rollIndices);
      return { noDoublePart, doubleTakePart, probVectorPart };
    }

    if (!(agent.noise > 0 && agent.cubeLeafPlies === 0) && agent.resolveBackend({ board: game.board }) === 'wasm') {
      const res = wasmMoneyCubeActionValues(
        agent,
        game.board,
        proposer,
        context.owner,
        agent.cubeSearchDepth,
        context.jacoby,
        null,
        context.xNd ?? agent.cubeEfficiency,
        context.xDt ?? agent.cubeEfficiency,
        true,
        {
          cashOption: agent.cubeCashOption,
          cashAlpha: agent.cubeCashAlpha,
          cubeValue: game.cube.value,
          unboundedMoney: context.unboundedMoney,
          rollIndices,
        },
        true,
      );
      return { noDoublePart: res.noDouble, doubleTakePart: res.doubleTake, probVectorPart };
    }

    const noDoublePart = agent.cubefulSearch(
      game.board, proposer, context.owner, agent.cubeSearchDepth, context.jacoby, null, context.xNd,
      {
        cashOption: agent.cubeCashOption,
        cashAlpha: agent.cubeCashAlpha,
        cubeValue: game.cube.value,
        actionContext: 'post_no_double',
        unboundedMoney: context.unboundedMoney,
        rollIndices,
      });
    const doubleTakePart = 2 * agent.cubefulSearch(
      game.board, proposer, 'opponent', agent.cubeSearchDepth, false, null, context.xDt,
      {
        cubeValue: 2 * game.cube.value,
        actionContext: 'post_double_take',
        unboundedMoney: context.unboundedMoney,
        rollIndices,
      });
    return { noDoublePart, doubleTakePart, probVectorPart };
  }));
}

/** 並列キューブ解析用: 全チャンクの結果を合算して CubeAnalysis を返す。 */
export function finalizeCubeParallel(position, { net, profile, chunks, context } = {}) {
  const game = gameFromPosition(position);
  const proposer = game.currentPlayer;
  const agent = makeAgent(net, profile);
  const match = matchContext(position, proposer);

  let vector;
  if (context.probDepth >= 1) {
    vector = [0, 0, 0, 0, 0];
    for (const chunk of chunks) {
      for (let k = 0; k < 5; k += 1) vector[k] += chunk.probVectorPart[k];
    }
  } else {
    vector = agent.searchedVectorFor(game.board, proposer, WHITE, 0);
  }
  const probabilities = probabilityDto(vector, proposer);
  const noDouble = chunks.reduce((sum, c) => sum + c.noDoublePart, 0);
  const take = chunks.reduce((sum, c) => sum + c.doubleTakePart, 0);
  const drop = match
    ? matchWinChance(match.away[proposer] - game.cube.value, match.away[opponent(proposer)], match.crawfordPlayed)
    : 1;

  const rows = [
    { action: 'no-double', equity: noDouble, probabilities },
    { action: 'double-take', equity: take, probabilities },
    { action: 'double-pass', equity: drop, probabilities: {
      win: 1, winGammon: 0, winBackgammon: 0, lose: 0, loseGammon: 0, loseBackgammon: 0,
    }},
  ];
  return buildCubeAnalysisResult(rows, context.canDouble);
}

export function analyzeResignation(position, resignationValue, { net, profile } = {}) {
  if (![1, 2, 3].includes(resignationValue)) throw new Error('resignationValue must be 1, 2, or 3');
  const game = gameFromPosition(position);
  const player = game.currentPlayer;
  const agent = makeAgent(net, profile);
  const match = matchContext(position, player);

  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () => {
    if (match) {
      const cont = agent.cubeDecision === 'search'
        ? agent.matchCubeSearch(game, player, match).noDouble
        : agent.matchCubeEquities(game.board, player, game.cube.value, match).noDouble;
      const resign = matchWinChance(
        match.away[player],
        match.away[opponent(player)] - resignationValue * game.cube.value,
        match.crawfordPlayed);
      return {
        continueEquity: cont,
        resignEquity: resign,
        loss: Math.max(0, cont - resign),
        unit: 'mwc',
      };
    }

    const owner = agent.cubeOwnerKind(game, player);
    const jacoby = Boolean(game.jacoby && agent.cubeUntouched(game));
    const normalized = agent.cubefulSearch(
      game.board, player, owner, agent.cubeSearchDepth, jacoby, null, null,
      {
        cashOption: agent.cubeCashOption,
        cashAlpha: agent.cubeCashAlpha,
        cubeValue: game.cube.value,
        actionContext: 'post_no_double',
        unboundedMoney: game.cube.unboundedMoney === true,
      });
    const cont = game.cube.value * normalized;
    const resign = -game.cube.value * resignationValue;
    return {
      continueEquity: cont,
      resignEquity: resign,
      loss: Math.max(0, cont - resign),
      unit: 'points',
    };
  }));
}
