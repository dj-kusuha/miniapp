// CPU着手とヒントで共用するchecker評価。
// engine公開JS facade.js の checkerCubeEnabled()/checkerValue()/scoreCheckerMoves()
// と同じ契約を使い、Workerとmain-thread fallbackの評価経路を揃える。

import { WHITE, BLACK, opponent } from './board.js';
import { equity, flipPerspective } from './nn.js';
import { matchWinChance, mwcWithCube, outcomeSpread } from './met.js';
import { boardKey } from './rules.js';

const CHECKER_SEARCH_CACHE_LIMIT = 100000;

function enginePlayer(player) {
  if (player === WHITE || player === 'white') return WHITE;
  if (player === BLACK || player === 'black') return BLACK;
  throw new Error(`未知のプレイヤーです: ${player}`);
}

function validateCheckerContext(position) {
  const cube = position?.cube;
  const match = position?.match;
  if (!cube || typeof cube.enabled !== 'boolean' || typeof cube.available !== 'boolean'
      || !Number.isInteger(cube.value) || !['center', WHITE, BLACK, 'white', 'black'].includes(cube.owner)) {
    throw new Error('checker contextにはcube.enabled/available/value/ownerが必要です');
  }
  if (cube.unboundedMoney !== undefined && typeof cube.unboundedMoney !== 'boolean') {
    throw new Error('cube.unboundedMoneyはbooleanで指定してください');
  }
  if (!match || !['money', 'match'].includes(match.mode)) {
    throw new Error('checker contextにはmatch.modeが必要です');
  }
  if (match.mode === 'money' && typeof match.jacoby !== 'boolean') {
    throw new Error('Money checker contextにはmatch.jacobyが必要です');
  }
  if (match.mode === 'match'
      && (!Number.isInteger(match.targetPoints) || match.targetPoints < 1
        || !Number.isInteger(match.scoreWhite) || !Number.isInteger(match.scoreBlack)
        || typeof match.crawford !== 'boolean' || typeof match.crawfordPlayed !== 'boolean')) {
    throw new Error('Match checker contextにはtarget/score/Crawfordが必要です');
  }
}

function matchContext(position, proposer) {
  const match = position.match;
  if (match.mode !== 'match') return null;
  const target = match.targetPoints;
  return {
    length: target,
    away: {
      [WHITE]: Math.max(0, target - match.scoreWhite),
      [BLACK]: Math.max(0, target - match.scoreBlack),
    },
    // Crawford局の着手後はCrawfordを消化済みとして次スコアを評価する。
    crawfordPlayed: Boolean(match.crawfordPlayed || match.crawford),
    proposer,
  };
}

function checkerCubeEnabled(position) {
  // availableは次の手番側の権利、enabledはゲーム全体でcubeを使う設定。
  // 両者を混同すると、相手がcubeを持つ局面をcubelessへ落としてしまう。
  return Boolean(position.cube.enabled);
}

function checkerCubeCanRedouble(position) {
  return checkerCubeEnabled(position) && !position.match.crawford
    && (position.cube.value < 64
      || (position.match.mode === 'money' && position.cube.unboundedMoney === true));
}

function checkerSearchDepth(agent, position, mode = 'legacy') {
  // checker levelのpliesには今の着手が含まれる。既定のlegacyでは、Match MWCと
  // Money cubefulのafterstate探索を最大1ロールに保つ。full-root / staged3plyは
  // 計測用の明示modeで profile 本来の深さを使う。
  const depth = Math.max(0, agent.searchPlies - 1);
  if (mode === 'full-root' || mode === 'staged3ply') return depth;
  const cubeCanContinue = checkerCubeCanRedouble(position);
  return position.match.mode === 'match' || cubeCanContinue
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
    const key = JSON.stringify([
      boardKey(board), turn, owner, depth, jacoby,
      leaf ?? this.cubeLeafPlies,
      cubeEfficiency ?? this.cubeEfficiency,
      options.cashOption ?? false,
      options.cashAlpha ?? this.cubeCashAlpha,
      options.cashPolicy?.alpha ?? null,
      options.cubeValue ?? 1,
      options.allowDouble ?? true,
      options.actionContext ?? 'post_no_double',
      options.unboundedMoney ?? false,
    ]);
    if (cubefulCache.has(key)) return cubefulCache.get(key);
    const value = oldCubeful.call(this, board, ...args);
    if (cubefulCache.size < CHECKER_SEARCH_CACHE_LIMIT) cubefulCache.set(key, value);
    return value;
  };

  agent.mwcSearch = function memoizedMwc(board, ...args) {
    if (!Array.isArray(board?.points)) return oldMwc.call(this, board, ...args);
    const [turn, owner, depth, cube, match, leaf, matchCubeEfficiency, allowDouble] = args;
    const key = JSON.stringify([
      boardKey(board), turn, owner, depth, cube,
      match?.away?.[turn], match?.away?.[opponent(turn)], match?.crawfordPlayed,
      leaf ?? this.cubeLeafPlies,
      matchCubeEfficiency ?? this.matchCubeEfficiency,
      allowDouble ?? true,
    ]);
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

function withCheckerNoise(agent, noiseFor, callback) {
  const previous = agent.noiseFor;
  agent.noiseFor = noiseFor;
  try {
    return callback();
  } finally {
    agent.noiseFor = previous;
  }
}

function checkerValue(agent, position, board, player, match, enabled, depth) {
  const next = opponent(player);
  const cubeValue = position.cube.value;
  const rawOwner = position.cube.owner;
  const owner = rawOwner === 'center' ? 'center'
    : enginePlayer(rawOwner) === next ? 'me' : 'opponent';
  const canOffer = enabled && !position.match.crawford
    && (cubeValue < 64 || (position.match.mode === 'money'
      && position.cube.unboundedMoney === true))
    && owner !== 'opponent';

  if (match) {
    // MWCは0〜1。Moneyのcube-unitsと混ぜず、手番交代は1-xで反転する。
    if (!enabled || position.match.crawford) {
      return 1 - agent.mwcSearch(board, next, owner, depth, cubeValue, match,
        0, null, false);
    }
    let xNd = agent.matchCubeEfficiency;
    let xDt = agent.matchCubeEfficiency;
    if (agent.useCubeHead && agent.cubeHeadMatch) {
      [xNd, xDt] = agent.matchCubeHeadActionEfficiencies(
        board, next, cubeValue, owner, match);
    }
    const nd = agent.mwcSearch(board, next, owner, depth, cubeValue, match, 0, xNd);
    if (!canOffer) return 1 - nd;
    const dt = agent.mwcSearch(board, next, 'opponent', depth, cubeValue * 2,
      match, 0, xDt);
    const pass = matchWinChance(match.away[next] - cubeValue,
      match.away[player], match.crawfordPlayed);
    return 1 - Math.max(nd, Math.min(dt, pass));
  }

  const jacoby = Boolean(position.match.jacoby && cubeValue === 1 && owner === 'center');
  if (!enabled) {
    // cube OFFでは将来のDoubleを禁止する。未ダブルMoneyのJacobyも反映する。
    const vector = agent.terminalVector(board)
      ?? (depth > 0
        ? agent.expandRollsVector(board, next, depth, 1)
        : agent.probabilitiesFor(board, next));
    const playerVector = player === WHITE ? vector : flipPerspective(vector);
    return jacoby ? 2 * playerVector[0] - 1 : equity(playerVector);
  }

  let xNd = agent.cubeEfficiency;
  let xDt = agent.cubeEfficiencyDtFor(board, next);
  if (agent.useCubeHead && agent.cubeHeadMoney) {
    [xNd, xDt] = agent.cubeHeadActionEfficiencies(board, next, cubeValue, owner);
  }
  const nd = agent.cubefulSearch(board, next, owner, depth, jacoby, 0, xNd, {
    cashPolicy: agent.cubeCashOption ? { alpha: agent.cubeCashAlpha } : null,
    cubeValue,
    unboundedMoney: position.cube.unboundedMoney === true,
  });
  if (!canOffer) return -nd;
  const dt = 2 * agent.cubefulSearch(board, next, 'opponent', depth, false, 0, xDt, {
    cubeValue: cubeValue * 2,
    actionContext: 'post_double_take',
    unboundedMoney: position.cube.unboundedMoney === true,
  });
  return -Math.max(nd, Math.min(dt, 1));
}

const stagedCandidates = (values, margin, maximum) => {
  const ordered = [...values.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const best = ordered[0]?.[1];
  if (best === undefined) return [];
  return ordered.filter(([, value]) => value >= best - margin)
    .slice(0, maximum).map(([index]) => index);
};

function stagedMetric(position) {
  if (position.match.mode === 'match') {
    return { firstMargin: 0.010, secondMargin: 0.005, unit: 'mwc' };
  }
  if (checkerCubeEnabled(position) && !position.match.crawford) {
    return { firstMargin: 0.160, secondMargin: 0.080, unit: 'equity' };
  }
  return null;
}

function scoreStagedCheckerMoves(agent, position, moves, player, match, enabled) {
  const metric = stagedMetric(position);
  if (!metric || agent.searchPlies !== 3 || moves.length <= 1) {
    const depth = checkerSearchDepth(agent, position, 'staged3ply');
    return moves.map((move, index) => ({
      move,
      index,
      value: checkerValue(agent, position, move.resultingBoard,
        player, match, enabled, depth),
    })).sort((a, b) => b.value - a.value || a.index - b.index);
  }

  const values = new Map();
  const stages = new Map();
  for (let index = 0; index < moves.length; index += 1) {
    values.set(index, checkerValue(agent, position, moves[index].resultingBoard,
      player, match, enabled, 0));
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
        player, match, enabled, 1));
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
        player, match, enabled, 2));
      stages.set(index, 3);
    }
    agent.checkerLastStagedSearch.maxAdditionalDepth = 2;
  } else if (candidates.length === 1) {
    // 2-plyで一意になった場合、候補をさらに読む必要はない。
  }

  // Full-rootで読んだ候補を先に並べ、同段では同じ評価尺度・安定順を使う。
  // 低い段の値は参考順位であり、final 3-ply候補とのregret計算には使わない。
  return moves.map((move, index) => ({
    move,
    index,
    value: values.get(index),
    searchStage: stages.get(index),
  })).sort((a, b) => b.searchStage - a.searchStage
    || b.value - a.value || a.index - b.index);
}

function resolveCheckerSearchMode(agent, requestedMode = null) {
  const mode = requestedMode ?? agent.checkerSearchMode ?? 'legacy';
  if (!['legacy', 'full-root', 'staged3ply'].includes(mode)) {
    throw new Error(`未対応のchecker評価mode: ${mode}`);
  }
  return mode;
}

/** 全候補を評価する。full-root / staged3plyはfixture・採否計測にも使う。 */
export function scoreCheckerMoves(agent, position, moves, player, requestedMode = null) {
  validateCheckerContext(position);
  const match = matchContext(position, player);
  const enabled = checkerCubeEnabled(position);
  const mode = resolveCheckerSearchMode(agent, requestedMode);
  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () =>
    withCheckerNoise(agent, () => 0, () => {
      if (mode === 'staged3ply') {
        return scoreStagedCheckerMoves(agent, position, moves, player, match, enabled);
      }
      const depth = checkerSearchDepth(agent, position, mode);
      return moves.map((move, index) => ({
        move,
        index,
        value: checkerValue(agent, position, move.resultingBoard,
          player, match, enabled, depth),
      })).sort((a, b) => b.value - a.value || a.index - b.index);
    })));
}

function checkerMoveValueWithNoise(agent, position, move, player, noise, depth) {
  validateCheckerContext(position);
  const match = matchContext(position, player);
  const enabled = checkerCubeEnabled(position);
  const whiteNoise = player === WHITE ? noise : -noise;
  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () =>
    withCheckerNoise(agent,
      (board) => board === move.resultingBoard ? whiteNoise : 0,
      () => checkerValue(agent, position, move.resultingBoard,
        player, match, enabled, depth))));
}

/** Match/GameからWorkerとfallback共通のafterstate contextを作る。 */
export function checkerContextFor(game, match, player) {
  if (!game || !match) throw new Error('checker contextには進行中のGameとMatchが必要です');
  const next = opponent(player);
  const cube = game.cube;
  const enabled = match.useCube;
  return {
    cube: {
      value: cube.value,
      owner: cube.owner ?? 'center',
      enabled,
      unboundedMoney: match.isMoney && cube.unboundedMoney === true,
      // 評価基点は着手後の相手ROLLING。次手番側の提示権を示す。
      available: enabled && !game.crawford
        && (cube.value < 64 || (match.isMoney && cube.unboundedMoney))
        && cube.canDouble(next),
    },
    match: match.isMoney ? {
      mode: 'money',
      jacoby: game.jacoby,
    } : {
      mode: 'match',
      targetPoints: match.length,
      scoreWhite: match.scores[WHITE],
      scoreBlack: match.scores[BLACK],
      crawford: game.crawford,
      crawfordPlayed: match.crawfordDone,
      jacoby: false,
    },
  };
}

/** 共通checker評価からCPUの手を選ぶ。 */
export function selectCheckerMove(agent, position, moves, player) {
  if (moves.length <= 1) return 0;
  const requestedMode = resolveCheckerSearchMode(agent);
  // noise > 0 / maxLoss有限の選択では全候補を同一深度で評価して足切り・ノイズ再評価する。
  // staged3plyは候補ごとに探索深度が異なるため、noise付きAgentではfull-rootへ揃える。
  const mode = agent.noise > 0 && requestedMode === 'staged3ply'
    ? 'full-root'
    : requestedMode;
  const scored = scoreCheckerMoves(agent, position, moves, player, mode);
  if (!scored.length) return 0;
  if (agent.noise <= 0) return scored[0].index;

  const depth = checkerSearchDepth(agent, position, mode);
  // noise/maxLossはcubeless equity単位。確率の勝率をずらして再評価し、
  // MWCやcubefulの値へ変換してから足切り・選択する。
  const cutoff = Number.isFinite(agent.maxLoss)
    ? checkerMoveValueWithNoise(agent, position, scored[0].move,
      player, -agent.maxLoss, depth)
    : -Infinity;
  let selected = scored[0];
  let selectedScore = -Infinity;
  for (const entry of scored) {
    if (entry.value < cutoff) continue;
    const noise = agent.noiseFor(entry.move.resultingBoard);
    const noisy = noise === 0
      ? entry.value
      : checkerMoveValueWithNoise(agent, position, entry.move, player, noise, depth);
    if (noisy > selectedScore) {
      selected = entry;
      selectedScore = noisy;
    }
  }
  return selected.index;
}

/** ヒント候補と差分を共通checker評価から作る。 */
export function rankCheckerMoves(agent, position, moves, player, limit = 3) {
  const scored = scoreCheckerMoves(agent, position, moves, player);
  // Staged candidates can have values from different plies. Hints expose a loss
  // number, so compare only candidates evaluated to the same deepest stage.
  const deepestStage = Math.max(0, ...scored.map((entry) => entry.searchStage ?? 0));
  const comparable = scored.filter((entry) => (entry.searchStage ?? 0) === deepestStage);
  const best = comparable[0]?.value ?? 0;
  const entries = comparable.slice(0, limit).map(({ move, index, value }) => ({
    move,
    index,
    equity: value,
    loss: best - value,
    // 5-vector確率はafterstateを0-ply評価した参考値。終局だけは確定値を使う。
    probabilities: outcomeSpread(
      agent.terminalVector(move.resultingBoard)
        ?? agent.probabilitiesFor(move.resultingBoard, opponent(player)), player === WHITE),
  }));
  return {
    entries,
    unit: position.match.mode === 'match' ? 'mwc' : 'cube-units',
    evaluation: checkerCubeEnabled(position) && !position.match.crawford
      && (position.cube.value < 64 || (position.match.mode === 'money'
        && position.cube.unboundedMoney === true)) ? 'cubeful' : 'cube-disabled',
  };
}
