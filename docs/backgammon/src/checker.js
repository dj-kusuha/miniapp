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

export function withCheckerSearchCache(agent, callback) {
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

function withCheckerNoise(agent, noiseFor, callback) {
  const previous = agent.noiseFor;
  agent.noiseFor = noiseFor;
  try {
    return callback();
  } finally {
    agent.noiseFor = previous;
  }
}

function checkerEfficiencies(agent, position, board, player, match, enabled) {
  const next = opponent(player);
  const cubeValue = position.cube.value;
  const rawOwner = position.cube.owner;
  const owner = rawOwner === 'center' ? 'center'
    : enginePlayer(rawOwner) === next ? 'me' : 'opponent';

  if (match) {
    if (!enabled || position.match.crawford) return { xNd: null, xDt: null };
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
    [xNd, xDt] = agent.cubeHeadActionEfficiencies(board, next, cubeValue, owner);
  }
  return { xNd, xDt };
}

function checkerValue(agent, position, board, player, match, enabled, depth, efficiencies = null) {
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
    const { xNd, xDt } = efficiencies ?? checkerEfficiencies(agent, position, board, player, match, enabled);
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

  const { xNd, xDt } = efficiencies ?? checkerEfficiencies(agent, position, board, player, match, enabled);
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
  const effByIndex = new Map();
  for (let index = 0; index < moves.length; index += 1) {
    const eff = checkerEfficiencies(agent, position, moves[index].resultingBoard, player, match, enabled);
    effByIndex.set(index, eff);
    values.set(index, checkerValue(agent, position, moves[index].resultingBoard,
      player, match, enabled, 0, eff));
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
        player, match, enabled, 1, effByIndex.get(index)));
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
        player, match, enabled, 2, effByIndex.get(index)));
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

/** 評価済み候補配列からヒント用の順位・差分・確率を構築する。 */
export function rankFromScoredEntries(agent, position, moves, player, scored, limit = 3) {
  // Staged candidates can have values from different plies. Hints expose a loss
  // number, so compare only candidates evaluated to the same deepest stage.
  const deepestStage = Math.max(0, ...scored.map((entry) => entry.searchStage ?? 0));
  const comparable = scored.filter((entry) => (entry.searchStage ?? 0) === deepestStage);
  const best = comparable[0]?.value ?? 0;
  const entries = comparable.slice(0, limit).map(({ move, index, value }) => {
    const resolvedMove = move ?? moves[index];
    return {
      move: resolvedMove,
      index,
      equity: value,
      loss: best - value,
      // 5-vector確率はafterstateを0-ply評価した参考値。終局だけは確定値を使う。
      probabilities: outcomeSpread(
        agent.terminalVector(resolvedMove.resultingBoard)
          ?? agent.probabilitiesFor(resolvedMove.resultingBoard, opponent(player)), player === WHITE),
    };
  });
  return {
    entries,
    unit: position.match.mode === 'match' ? 'mwc' : 'cube-units',
    evaluation: checkerCubeEnabled(position) && !position.match.crawford
      && (position.cube.value < 64 || (position.match.mode === 'money'
        && position.cube.unboundedMoney === true)) ? 'cubeful' : 'cube-disabled',
  };
}

/** ヒント候補と差分を共通checker評価から作る。 */
export function rankCheckerMoves(agent, position, moves, player, limit = 3) {
  const scored = scoreCheckerMoves(agent, position, moves, player);
  return rankFromScoredEntries(agent, position, moves, player, scored, limit);
}

/** 指定条件で段階選別3-ply（staged3ply）が有効になるか判定する。 */
export function shouldUseStaged3Ply(agent, position, movesCount, requestedMode = null) {
  validateCheckerContext(position);
  const mode = resolveCheckerSearchMode(agent, requestedMode);
  if (mode !== 'staged3ply') return false;
  if (agent.noise > 0 || agent.searchPlies !== 3 || movesCount <= 1) return false;
  return stagedMetric(position) !== null;
}

/** 指定モードでの均一評価深度（0=1-ply, 1=2-ply, 2=3-ply）を返す。 */
export function checkerDepthForMode(agent, position, requestedMode = null) {
  validateCheckerContext(position);
  const mode = resolveCheckerSearchMode(agent, requestedMode);
  return checkerSearchDepth(agent, position, mode);
}

/**
 * 並列探索用: 指定した合法手 index サブセットを指定深度で評価する。
 * moveIndices 省略時は全合法手を対象にする。
 */
export function evaluateCheckerMovesSubset(agent, position, moves, player, {
  moveIndices = null,
  depth = null,
  efficienciesByIndex = null,
  mode = null,
} = {}) {
  validateCheckerContext(position);
  const match = matchContext(position, player);
  const enabled = checkerCubeEnabled(position);
  const resolvedMode = resolveCheckerSearchMode(agent, mode);
  const resolvedDepth = depth ?? checkerSearchDepth(agent, position, resolvedMode);
  const targets = moveIndices ?? moves.map((_, index) => index);

  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () =>
    withCheckerNoise(agent, () => 0, () => {
      const entries = [];
      for (const index of targets) {
        const move = moves[index];
        if (!move) continue;
        const providedEff = efficienciesByIndex?.[index] ?? null;
        const eff = providedEff ?? checkerEfficiencies(
          agent, position, move.resultingBoard, player, match, enabled);
        const value = checkerValue(
          agent, position, move.resultingBoard, player, match, enabled, resolvedDepth, eff);
        entries.push({
          index,
          key: boardKey(move.resultingBoard),
          equity: value,
          efficiencies: eff,
        });
      }
      return entries;
    })));
}

/**
 * 並列探索用: 1 手の depth >= 1 評価を指定ロール群（rollIndices）のみで部分評価する。
 * Stage 3 で候補数が Worker 数未満になったときの並列化に使う。
 */
export function evaluateCheckerMoveRollChunk(agent, position, move, player, {
  depth,
  rollIndices,
  efficiencies = null,
} = {}) {
  validateCheckerContext(position);
  const match = matchContext(position, player);
  const enabled = checkerCubeEnabled(position);
  const next = opponent(player);
  const board = move.resultingBoard;
  const cubeValue = position.cube.value;
  const rawOwner = position.cube.owner;
  const owner = rawOwner === 'center' ? 'center'
    : enginePlayer(rawOwner) === next ? 'me' : 'opponent';
  const canOffer = enabled && !position.match.crawford
    && (cubeValue < 64 || (position.match.mode === 'money'
      && position.cube.unboundedMoney === true))
    && owner !== 'opponent';

  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () =>
    withCheckerNoise(agent, () => 0, () => {
      if (match) {
        if (!enabled || position.match.crawford) {
          const ndPart = agent.mwcSearch(
            board, next, owner, depth, cubeValue, match, 0, null, false, rollIndices);
          return { kind: 'match-fixed', ndPart };
        }
        const { xNd, xDt } = efficiencies
          ?? checkerEfficiencies(agent, position, board, player, match, enabled);
        const ndPart = agent.mwcSearch(
          board, next, owner, depth, cubeValue, match, 0, xNd, true, rollIndices);
        const dtPart = canOffer
          ? agent.mwcSearch(board, next, 'opponent', depth, cubeValue * 2, match, 0, xDt, true, rollIndices)
          : null;
        const passValue = canOffer
          ? matchWinChance(match.away[next] - cubeValue, match.away[player], match.crawfordPlayed)
          : null;
        return { kind: 'match-cubeful', ndPart, dtPart, passValue, canOffer };
      }

      const jacoby = Boolean(position.match.jacoby && cubeValue === 1 && owner === 'center');
      if (!enabled) {
        const terminal = agent.terminalVector(board);
        if (terminal !== null) {
          const playerVector = player === WHITE ? terminal : flipPerspective(terminal);
          const value = jacoby ? 2 * playerVector[0] - 1 : equity(playerVector);
          return { kind: 'terminal', value };
        }
        const vectorPart = Array.from(agent.expandRollsVector(board, next, depth, 1, rollIndices));
        return { kind: 'money-fixed', vectorPart, jacoby };
      }

      const { xNd, xDt } = efficiencies
        ?? checkerEfficiencies(agent, position, board, player, match, enabled);
      const ndPart = agent.cubefulSearch(board, next, owner, depth, jacoby, 0, xNd, {
        cashPolicy: agent.cubeCashOption ? { alpha: agent.cubeCashAlpha } : null,
        cubeValue,
        unboundedMoney: position.cube.unboundedMoney === true,
        rollIndices,
      });
      const dtPart = canOffer
        ? 2 * agent.cubefulSearch(board, next, 'opponent', depth, false, 0, xDt, {
            cubeValue: cubeValue * 2,
            actionContext: 'post_double_take',
            unboundedMoney: position.cube.unboundedMoney === true,
            rollIndices,
          })
        : null;
      return { kind: 'money-cubeful', ndPart, dtPart, canOffer };
    })));
}

/** 並列ロールチャンク評価の結果を合算し、1 手の正確な equity を復元する。 */
export function combineCheckerMoveRollChunks(player, chunks) {
  const first = chunks[0];
  if (!first) throw new Error('chunks must not be empty');
  if (first.kind === 'terminal') return first.value;
  if (first.kind === 'match-fixed') {
    const nd = chunks.reduce((sum, c) => sum + c.ndPart, 0);
    return 1 - nd;
  }
  if (first.kind === 'match-cubeful') {
    const nd = chunks.reduce((sum, c) => sum + c.ndPart, 0);
    if (!first.canOffer) return 1 - nd;
    const dt = chunks.reduce((sum, c) => sum + c.dtPart, 0);
    return 1 - Math.max(nd, Math.min(dt, first.passValue));
  }
  if (first.kind === 'money-fixed') {
    const vector = [0, 0, 0, 0, 0];
    for (const chunk of chunks) {
      for (let k = 0; k < 5; k += 1) vector[k] += chunk.vectorPart[k];
    }
    const playerVector = player === WHITE ? vector : flipPerspective(vector);
    return first.jacoby ? 2 * playerVector[0] - 1 : equity(playerVector);
  }
  const nd = chunks.reduce((sum, c) => sum + c.ndPart, 0);
  if (!first.canOffer) return -nd;
  const dt = chunks.reduce((sum, c) => sum + c.dtPart, 0);
  return -Math.max(nd, Math.min(dt, 1));
}

/** 並列段階選別用: stage 1 (cap 8) / stage 2 (cap 4) の生き残り index を返す。 */
export function selectStagedCheckerMoveIndices(position, entries, stage) {
  const metric = stagedMetric(position);
  if (!metric) return [];
  const values = new Map(entries.map((entry) => [entry.index, entry.equity]));
  const margin = stage === 1 ? metric.firstMargin : metric.secondMargin;
  const cap = stage === 1 ? 8 : 4;
  return stagedCandidates(values, margin, cap);
}

function matchDoubleCompare(game, proposer, match, matchDoubleMargin, s) {
  const opponentTakes = s.take <= s.drop;
  const awayThem = match.away[opponent(proposer)];
  const holdMargin = (!match.crawfordPlayed && opponentTakes && game.cube.value === 1)
    ? (awayThem <= 2 ? 0.045 : 0.020)
    : 0.0;
  return [s.noDouble + holdMargin + matchDoubleMargin, Math.min(s.take, s.drop)];
}

/**
 * 並列キューブ判断用: BG2N厳密解・leaf=0足切り・0-ply等を先に判定し、
 * 2-ply探索が本当に必要な際どい局面だけ 21 ロール分割の共有コンテキストを返す。
 */
export function prepareCubeDecisionParallel(agent, game, match, ask) {
  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () => {
    if (ask === 'accept') {
      if (
        agent.cubeDecision !== 'search'
        || agent.cubeSearchDepth <= 0
        || agent.terminalVector(game.board) !== null
      ) {
        return { kind: 'complete', answer: Boolean(agent.shouldAcceptDouble(game, match ?? null)) };
      }
      const proposer = game.doublingProposer;
      if (match) {
        const owner = agent.cubeOwnerKind(game, proposer);
        let xDt = agent.matchCubeEfficiency;
        if (agent.useCubeHead && agent.cubeHeadMatch) {
          [, xDt] = agent.matchCubeHeadActionEfficiencies(
            game.board, proposer, game.cube.value, owner, match);
        }
        return {
          kind: 'roll-chunks',
          rollCount: 21,
          context: {
            ask: 'accept',
            isMatch: true,
            proposer,
            cubeValue: game.cube.value,
            xDt,
            matchTakeMargin: agent.matchTakeMargin,
          },
        };
      }
      const exact = agent.tryMoneyBg2nRoot(game, null, 'should_accept_double');
      if (exact !== null && exact.DT_points !== null) {
        return { kind: 'complete', answer: exact.double_take < exact.double_pass };
      }
      const xDt = (agent.useCubeHead && agent.cubeHeadMoney)
        ? agent.cubeHeadFor(game.board, proposer, game.cube.value * 2, 'opponent')
        : agent.cubeEfficiencyDtFor(game.board, proposer);
      return {
        kind: 'roll-chunks',
        rollCount: 21,
        context: {
          ask: 'accept',
          isMatch: false,
          proposer,
          cubeValue: game.cube.value,
          unboundedMoney: game.cube.unboundedMoney === true,
          xDt,
          takeMargin: agent.takeMargin,
        },
      };
    }

    if (!game.canDouble()) return { kind: 'complete', answer: false };
    if (
      agent.cubeDecision !== 'search'
      || agent.cubeSearchDepth <= 0
      || agent.terminalVector(game.board) !== null
    ) {
      return { kind: 'complete', answer: Boolean(agent.shouldDouble(game, match ?? null)) };
    }

    const proposer = game.currentPlayer;
    const owner = agent.cubeOwnerKind(game, proposer);

    if (match) {
      let xNd = agent.matchCubeEfficiency;
      let xDt = agent.matchCubeEfficiency;
      if (agent.useCubeHead && agent.cubeHeadMatch) {
        [xNd, xDt] = agent.matchCubeHeadActionEfficiencies(
          game.board, proposer, game.cube.value, owner, match);
      }
      if (agent.matchCubeScreenMargin > 0 && agent.cubeLeafPlies > 0) {
        const nd0 = agent.mwcSearch(
          game.board, proposer, owner, agent.cubeSearchDepth, game.cube.value, match, 0, xNd);
        const take0 = agent.mwcSearch(
          game.board, proposer, 'opponent', agent.cubeSearchDepth, game.cube.value * 2, match, 0, xDt);
        const drop = matchWinChance(
          match.away[proposer] - game.cube.value, match.away[opponent(proposer)], match.crawfordPlayed);
        const [nd, best] = matchDoubleCompare(
          game, proposer, match, agent.matchDoubleMargin, { noDouble: nd0, take: take0, drop });
        if (Math.abs(best - nd) > agent.matchCubeScreenMargin) {
          return { kind: 'complete', answer: best > nd };
        }
      }
      return {
        kind: 'roll-chunks',
        rollCount: 21,
        context: {
          ask: 'double',
          isMatch: true,
          proposer,
          owner,
          cubeValue: game.cube.value,
          xNd,
          xDt,
          matchDoubleMargin: agent.matchDoubleMargin,
        },
      };
    }

    const exact = agent.tryMoneyBg2nRoot(game, null, 'should_double');
    if (exact !== null) return { kind: 'complete', answer: exact.action !== 'no_double' };

    const jacoby = (agent.jacoby ?? true) && game.jacoby && agent.cubeUntouched(game);
    const unboundedMoney = game.cube.unboundedMoney === true;
    let xNd = agent.cubeEfficiency;
    let xDt = agent.cubeEfficiencyDtFor(game.board, proposer);
    if (agent.useCubeHead && agent.cubeHeadMoney) {
      [xNd, xDt] = agent.cubeHeadActionEfficiencies(game.board, proposer, game.cube.value, owner);
    }

    if (agent.cubeScreenMargin > 0 && agent.cubeLeafPlies > 0) {
      const ndOptions = {
        cubeValue: game.cube.value,
        actionContext: 'post_no_double',
        unboundedMoney,
        ...(agent.cubeCashOption ? { cashOption: true, cashAlpha: agent.cubeCashAlpha } : {}),
      };
      const nd0 = agent.cubefulSearch(
        game.board, proposer, owner, agent.cubeSearchDepth, jacoby, 0, xNd, ndOptions);
      const tk0 = 2.0 * agent.cubefulSearch(
        game.board, proposer, 'opponent', agent.cubeSearchDepth, false, 0, xDt, {
          cubeValue: 2 * game.cube.value,
          actionContext: 'post_double_take',
          unboundedMoney,
        });
      const advantage = Math.min(tk0, 1.0) - nd0 - agent.doubleMargin;
      if (Math.abs(advantage) > agent.cubeScreenMargin) {
        return { kind: 'complete', answer: advantage > 0 };
      }
    }

    return {
      kind: 'roll-chunks',
      rollCount: 21,
      context: {
        ask: 'double',
        isMatch: false,
        proposer,
        owner,
        jacoby,
        cubeValue: game.cube.value,
        unboundedMoney,
        xNd,
        xDt,
        doubleMargin: agent.doubleMargin,
      },
    };
  }));
}

/** 並列キューブ判断用: 指定ロール群の ND / DT 部分和を返す。 */
export function evaluateCubeDecisionRollChunk(agent, game, match, rollIndices, context) {
  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () => {
    const depth = agent.cubeSearchDepth;
    if (context.isMatch) {
      const ndPart = context.ask === 'double'
        ? agent.mwcSearch(
            game.board, context.proposer, context.owner, depth,
            context.cubeValue, match, null, context.xNd, true, rollIndices)
        : 0;
      const dtPart = agent.mwcSearch(
        game.board, context.proposer, 'opponent', depth,
        context.cubeValue * 2, match, null, context.xDt, true, rollIndices);
      return { ndPart, dtPart };
    }

    const ndPart = context.ask === 'double'
      ? agent.cubefulSearch(
          game.board, context.proposer, context.owner, depth, context.jacoby, null, context.xNd, {
            cubeValue: context.cubeValue,
            actionContext: 'post_no_double',
            unboundedMoney: context.unboundedMoney,
            ...(agent.cubeCashOption ? { cashOption: true, cashAlpha: agent.cubeCashAlpha } : {}),
            rollIndices,
          })
      : 0;
    const dtPart = 2.0 * agent.cubefulSearch(
      game.board, context.proposer, 'opponent', depth, false, null, context.xDt, {
        cubeValue: 2 * context.cubeValue,
        actionContext: 'post_double_take',
        unboundedMoney: context.unboundedMoney,
        rollIndices,
      });
    return { ndPart, dtPart };
  }));
}

/** 並列キューブ判断用: 全チャンクの結果を合算してダブル/テイク判定（boolean）を返す。 */
export function finalizeCubeDecisionParallel(game, match, chunks, context) {
  const noDouble = chunks.reduce((sum, c) => sum + c.ndPart, 0);
  const take = chunks.reduce((sum, c) => sum + c.dtPart, 0);

  if (context.isMatch) {
    const drop = matchWinChance(
      match.away[context.proposer] - context.cubeValue,
      match.away[opponent(context.proposer)],
      match.crawfordPlayed,
    );
    if (context.ask === 'accept') {
      return take < drop - context.matchTakeMargin;
    }
    const [nd, best] = matchDoubleCompare(
      game, context.proposer, match, context.matchDoubleMargin, { noDouble, take, drop });
    return best > nd;
  }

  if (context.ask === 'accept') {
    return take < 1.0 - context.takeMargin;
  }
  return Math.min(take, 1.0) > noDouble + context.doubleMargin;
}
