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

function checkerSearchDepth(agent, position) {
  // checker levelのpliesには今の着手が含まれる。Match MWCとMoney cubefulは
  // afterstate探索を次の1ロールまでに制限し、3-plyで探索が急増するのを防ぐ。
  // Money cube OFFは通常のchecker探索なのでprofile本来の深さを保つ。
  const depth = Math.max(0, agent.searchPlies - 1);
  const cubeCanContinue = checkerCubeEnabled(position)
    && !position.match.crawford && position.cube.value < 64;
  return position.match.mode === 'match' || cubeCanContinue
    ? Math.min(depth, 1)
    : depth;
}

function withCheckerSearchCache(agent, callback) {
  const oldCubeful = agent.cubefulSearch;
  const oldMwc = agent.mwcSearch;
  const cubefulCache = new Map();
  const mwcCache = new Map();

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
  }
}

function checkerValue(agent, position, board, player, match, enabled, depth) {
  const next = opponent(player);
  const cubeValue = position.cube.value;
  const rawOwner = position.cube.owner;
  const owner = rawOwner === 'center' ? 'center'
    : enginePlayer(rawOwner) === next ? 'me' : 'opponent';
  const canOffer = enabled && !position.match.crawford && cubeValue < 64
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
        : agent.vectorFor(board, next));
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
  });
  if (!canOffer) return -nd;
  const dt = 2 * agent.cubefulSearch(board, next, 'opponent', depth, false, 0, xDt, {
    cubeValue: cubeValue * 2,
    actionContext: 'post_double_take',
  });
  return -Math.max(nd, Math.min(dt, 1));
}

/** 全候補のchecker値を一度だけ求め、CPU選択とヒントで共有する。 */
export function scoreCheckerMoves(agent, position, moves, player) {
  validateCheckerContext(position);
  const match = matchContext(position, player);
  const enabled = checkerCubeEnabled(position);
  const depth = checkerSearchDepth(agent, position);
  return agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () =>
    moves.map((move, index) => ({
      move,
      index,
      value: checkerValue(agent, position, move.resultingBoard, player, match, enabled, depth),
    })).sort((a, b) => b.value - a.value || a.index - b.index)));
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
      // 評価基点は着手後の相手ROLLING。次手番側の提示権を示す。
      available: enabled && !game.crawford && cube.value < 64 && cube.canDouble(next),
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
  const scored = scoreCheckerMoves(agent, position, moves, player);
  if (!scored.length) return 0;
  const best = scored[0].value;
  let selected = scored[0];
  let selectedScore = -Infinity;
  for (const entry of scored) {
    if (entry.value < best - agent.maxLoss) continue;
    const noisy = entry.value + agent.noiseFor(entry.move.resultingBoard);
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
  const best = scored[0]?.value ?? 0;
  const entries = scored.slice(0, limit).map(({ move, index, value }) => ({
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
      && position.cube.value < 64 ? 'cubeful' : 'cube-disabled',
  };
}
