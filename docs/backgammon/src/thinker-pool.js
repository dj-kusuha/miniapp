// 最大 4 本の Web Worker を遅延起動して、2-ply / 3-ply 着手・ヒント・
// 際どいキューブ判断を並列実行する思考プール。
//
// 0-ply 段（初心者〜上級）や 1 手しかない局面、BG2N / leaf=0 足切りで
// 即決できるキューブ局面では追加 Worker を起こさず 1 本目で処理する。

import { levelById } from './agent.js';
import {
  checkerDepthForMode,
  combineCheckerMoveRollChunks,
  finalizeCubeDecisionParallel,
  rankFromScoredEntries,
  selectStagedCheckerMoveIndices,
} from './checker.js';
import { boardKey } from './rules.js';

const ALL_ROLL_INDICES = Array.from({ length: 21 }, (_, i) => i);

/** 配列を均等に最大 buckets 個へラウンドロビン分配する。 */
export function partitionRoundRobin(items, buckets) {
  const count = Math.max(1, Math.min(buckets, items.length));
  const groups = Array.from({ length: count }, () => []);
  for (let i = 0; i < items.length; i += 1) {
    groups[i % count].push(items[i]);
  }
  return groups;
}

/**
 * Worker 利用時の探索モードと内部応手フィルタを決定する。
 *
 * - 明示クエリ（`?checker-search=legacy|staged3ply|full-root`）があれば最優先。
 * - 通常運用では、世界チャンピオン段（plies=3）のみ `staged3ply` + `cubeFilterLevel: 1`
 *   を既定 ON にし、他段は従来の `legacy` を維持する。
 */
export function resolveWorkerSearchOptions(levelId, explicitMode = null) {
  const level = levelById(levelId);
  if (['legacy', 'staged3ply', 'full-root'].includes(explicitMode)) {
    return {
      mode: explicitMode,
      cubeFilterLevel: explicitMode === 'staged3ply' && level.plies === 3 ? 1 : null,
    };
  }
  if (level.plies === 3) {
    return { mode: 'staged3ply', cubeFilterLevel: 1 };
  }
  return { mode: 'legacy', cubeFilterLevel: null };
}

class WorkerSlot {
  constructor(worker) {
    this.worker = worker;
    this.nextId = 1;
    this.pending = new Map();
    this.alive = true;
    this.readyPromise = null;
    this.pruneNetLoaded = false;
    this.pruneNetStatus = 'disabled';

    worker.onmessage = (event) => {
      const { id } = event.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (event.data.ok) entry.resolve(event.data);
      else entry.reject(new Error(event.data.error));
    };

    worker.onerror = (event) => {
      this.alive = false;
      const message = event?.message || 'worker error';
      for (const entry of this.pending.values()) entry.reject(new Error(message));
      this.pending.clear();
    };
  }

  ask(payload) {
    if (!this.alive) return Promise.reject(new Error('worker なし'));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...payload });
    });
  }

  terminate() {
    this.alive = false;
    for (const entry of this.pending.values()) entry.reject(new Error('worker terminated'));
    this.pending.clear();
    if (typeof this.worker.terminate === 'function') this.worker.terminate();
  }
}

export class ThinkerPool {
  constructor({
    maxWorkers = Math.min(4, Math.max(1, globalThis.navigator?.hardwareConcurrency || 4)),
    createWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }),
    explicitCheckerSearchMode = null,
  } = {}) {
    this.maxWorkers = Math.max(1, maxWorkers);
    this.createWorker = createWorker;
    this.explicitCheckerSearchMode = ['legacy', 'staged3ply', 'full-root']
      .includes(explicitCheckerSearchMode) ? explicitCheckerSearchMode : null;
    this.loadPayload = null;
    this.slots = [];
  }

  get available() {
    return this.slots.some((slot) => slot.alive);
  }

  /**
   * プール内 Worker の Pruning Net 読込状態を返す。
   * 一部 Worker のみ読込失敗（404 / 互換不適合）した場合は `state: 'partial'` を返し、
   * 並列タスクでは primary Worker と同一状態の Worker のみを使用して解析単位で揃える。
   */
  get pruneNetStatus() {
    const alive = this.slots.filter((slot) => slot.alive);
    const totalWorkers = alive.length;
    const loadedWorkers = alive.filter((slot) => slot.pruneNetLoaded).length;
    const consistent = loadedWorkers === 0 || loadedWorkers === totalWorkers;
    const state = loadedWorkers === 0
      ? 'disabled'
      : loadedWorkers === totalWorkers ? 'loaded' : 'partial';
    return { state, loadedWorkers, totalWorkers, consistent };
  }

  _createSlot() {
    let rawWorker;
    try {
      rawWorker = this.createWorker();
    } catch (error) {
      console.warn('Worker の起動に失敗しました', error);
      return null;
    }
    const slot = new WorkerSlot(rawWorker);
    slot.readyPromise = slot.ask({ kind: 'load', ...this.loadPayload })
      .then((reply) => {
        slot.pruneNetLoaded = Boolean(reply?.pruneNetLoaded);
        slot.pruneNetStatus = reply?.pruneNetStatus ?? (slot.pruneNetLoaded ? 'loaded' : 'disabled');
        return slot;
      })
      .catch((error) => {
        slot.terminate();
        console.warn('Worker の初期化に失敗しました', error);
        return null;
      });
    this.slots.push(slot);
    return slot;
  }

  /** 初回起動。まずは 1 本目だけ立ち上げて起動負荷を抑える。 */
  async start(loadPayload) {
    this.terminate();
    this.loadPayload = {
      ...loadPayload,
      checkerSearchMode: this.explicitCheckerSearchMode ?? 'legacy',
    };
    const slot = this._createSlot();
    if (!slot) return false;
    const primary = await slot.readyPromise;
    this.slots = this.slots.filter((entry) => entry.alive);
    return Boolean(primary && primary.alive);
  }

  /** 並列実行が必要なタイミングで最大 maxWorkers 本まで遅延起動して返す。 */
  async _acquireWorkers(desiredCount) {
    const target = Math.max(1, Math.min(this.maxWorkers, desiredCount));
    this.slots = this.slots.filter((slot) => slot.alive);
    if (this.loadPayload) {
      const missing = target - this.slots.length;
      for (let i = 0; i < missing; i += 1) {
        if (!this._createSlot()) break;
      }
    }
    await Promise.all(this.slots.map((slot) => slot.readyPromise));
    this.slots = this.slots.filter((slot) => slot.alive);
    return this.slots;
  }

  async _primaryWorker() {
    const workers = await this._acquireWorkers(1);
    if (!workers.length) throw new Error('worker なし');
    return workers[0];
  }

  /**
   * 同一解析内のチャンク / サブセット間で Pruning Net の ON / OFF が混在しないよう、
   * primary Worker と同一 `pruneNetLoaded` 状態の Worker 群のみに揃える。
   */
  _consistentWorkers(workers) {
    if (workers.length <= 1) return workers;
    const expected = workers[0].pruneNetLoaded;
    return workers.filter((slot) => slot.pruneNetLoaded === expected);
  }

  async _evaluateDepthParallel({
    workers, boardDto, player, die1, die2, level, context,
    moveIndices, depth, efficienciesByIndex, mode, cubeFilterLevel,
  }) {
    if (moveIndices.length === 0) return [];

    // 候補数が Worker 数より少ない depth >= 1 は、各候補を 21 ロール分割して全 Worker を使う。
    if (depth >= 1 && workers.length > 1 && moveIndices.length < workers.length) {
      const rollGroups = partitionRoundRobin(ALL_ROLL_INDICES, workers.length);
      const results = [];
      for (const moveIndex of moveIndices) {
        const efficiencies = efficienciesByIndex?.[moveIndex] ?? null;
        const replies = await Promise.all(
          rollGroups.map((rollIndices, workerIdx) => workers[workerIdx].ask({
            kind: 'eval-checker-roll-chunk',
            board: boardDto,
            player,
            die1,
            die2,
            level,
            context,
            moveIndex,
            depth,
            rollIndices,
            efficiencies,
            mode,
            cubeFilterLevel,
          })),
        );
        const equityValue = combineCheckerMoveRollChunks(
          player, replies.map((reply) => reply.chunk));
        results.push({ index: moveIndex, equity: equityValue, efficiencies });
      }
      return results;
    }

    const indexGroups = partitionRoundRobin(moveIndices, workers.length);
    const replies = await Promise.all(
      indexGroups.map((group, workerIdx) => {
        const subsetEff = efficienciesByIndex
          ? Object.fromEntries(group.map((idx) => [idx, efficienciesByIndex[idx]]).filter(([, v]) => v))
          : null;
        return workers[workerIdx].ask({
          kind: 'eval-checker-subset',
          board: boardDto,
          player,
          die1,
          die2,
          level,
          context,
          moveIndices: group,
          depth,
          efficienciesByIndex: subsetEff,
          mode,
          cubeFilterLevel,
        });
      }),
    );
    return replies.flatMap((reply) => reply.entries);
  }

  async _scoreMovesParallel({ boardDto, player, die1, die2, level, moves, context, mode, cubeFilterLevel }) {
    const levelInfo = levelById(level);
    const workers = this._consistentWorkers(
      await this._acquireWorkers(Math.min(this.maxWorkers, Math.max(2, moves.length))),
    );
    if (!workers.length) throw new Error('worker なし');
    const allIndices = moves.map((_, index) => index);

    const canStage = mode === 'staged3ply'
      && levelInfo.plies === 3
      && levelInfo.noise <= 0
      && moves.length > 1
      && (context.match.mode === 'match' || (context.cube.enabled && !context.match.crawford));

    if (canStage) {
      const values = new Map();
      const stages = new Map();
      const effByIndex = {};

      const stage1 = await this._evaluateDepthParallel({
        workers, boardDto, player, die1, die2, level, context,
        moveIndices: allIndices, depth: 0, efficienciesByIndex: null, mode, cubeFilterLevel,
      });
      for (const entry of stage1) {
        values.set(entry.index, entry.equity);
        stages.set(entry.index, 1);
        if (entry.efficiencies) effByIndex[entry.index] = entry.efficiencies;
      }

      let surviving = selectStagedCheckerMoveIndices(context, stage1, 1);
      if (surviving.length > 1) {
        const stage2 = await this._evaluateDepthParallel({
          workers, boardDto, player, die1, die2, level, context,
          moveIndices: surviving, depth: 1, efficienciesByIndex: effByIndex, mode, cubeFilterLevel,
        });
        for (const entry of stage2) {
          values.set(entry.index, entry.equity);
          stages.set(entry.index, 2);
        }
        surviving = selectStagedCheckerMoveIndices(context, stage2, 2);
      } else {
        surviving = [];
      }

      if (surviving.length > 1) {
        const stage3 = await this._evaluateDepthParallel({
          workers, boardDto, player, die1, die2, level, context,
          moveIndices: surviving, depth: 2, efficienciesByIndex: effByIndex, mode, cubeFilterLevel,
        });
        for (const entry of stage3) {
          values.set(entry.index, entry.equity);
          stages.set(entry.index, 3);
        }
      }

      return moves.map((move, index) => ({
        move,
        index,
        value: values.get(index),
        searchStage: stages.get(index) ?? 1,
      })).sort((a, b) => b.searchStage - a.searchStage || b.value - a.value || a.index - b.index);
    }

    const depth = checkerDepthForMode(
      { searchPlies: levelInfo.plies, checkerSearchMode: mode },
      context,
      mode,
    );
    const entries = await this._evaluateDepthParallel({
      workers, boardDto, player, die1, die2, level, context,
      moveIndices: allIndices, depth, efficienciesByIndex: null, mode, cubeFilterLevel,
    });
    const byIndex = new Map(entries.map((entry) => [entry.index, entry.equity]));
    return moves.map((move, index) => ({
      move,
      index,
      value: byIndex.get(index),
    })).sort((a, b) => b.value - a.value || a.index - b.index);
  }

  /** CPU 着手を選ぶ。2-ply / 3-ply のノイズ無し段は複数 Worker で並列実行する。 */
  async chooseMove({ boardDto, player, die1, die2, level, moves, context }) {
    const levelInfo = levelById(level);
    const { mode, cubeFilterLevel } = resolveWorkerSearchOptions(level, this.explicitCheckerSearchMode);

    if (levelInfo.plies < 2 || levelInfo.noise > 0 || moves.length <= 1 || this.maxWorkers <= 1) {
      const primary = await this._primaryWorker();
      return primary.ask({
        kind: 'select',
        board: boardDto,
        player,
        die1,
        die2,
        level,
        context,
        mode,
        cubeFilterLevel,
      });
    }

    const scored = await this._scoreMovesParallel({
      boardDto, player, die1, die2, level, moves, context, mode, cubeFilterLevel,
    });
    const best = scored[0];
    return {
      ok: true,
      index: best.index,
      key: boardKey(moves[best.index].resultingBoard),
      scored,
    };
  }

  /** ヒント候補を順位付けする。2-ply 以上は複数 Worker で並列実行する。 */
  async rankMoves({ boardDto, player, die1, die2, level, moves, context, limit = 3, adviceAgent = null }) {
    const levelInfo = levelById(level);
    const { mode, cubeFilterLevel } = resolveWorkerSearchOptions(level, this.explicitCheckerSearchMode);

    if (levelInfo.plies < 2 || !adviceAgent || moves.length <= 1 || this.maxWorkers <= 1) {
      const primary = await this._primaryWorker();
      return primary.ask({
        kind: 'rank',
        board: boardDto,
        player,
        die1,
        die2,
        level,
        limit,
        context,
        mode,
        cubeFilterLevel,
      });
    }

    const scored = await this._scoreMovesParallel({
      boardDto, player, die1, die2, level, moves, context, mode, cubeFilterLevel,
    });
    const result = rankFromScoredEntries(adviceAgent, context, moves, player, scored, limit);
    return {
      ok: true,
      unit: result.unit,
      evaluation: result.evaluation,
      entries: result.entries.map((entry) => ({
        ...entry,
        key: boardKey(entry.move.resultingBoard),
      })),
    };
  }

  /** キューブ判断（ダブル / テイク）。際どい 2-ply 探索だけ 21 ロール分割で並列化する。 */
  async decideCube({ boardDto, player, cubeValue, cubeOwner, jacoby, crawford, level, match, ask, game }) {
    const primary = await this._primaryWorker();
    const basePayload = {
      board: boardDto,
      player,
      cubeValue,
      cubeOwner,
      jacoby,
      crawford,
      level,
      match,
      ask,
    };

    if (this.maxWorkers <= 1 || !game) {
      const reply = await primary.ask({ kind: 'cube', ...basePayload });
      return Boolean(reply.answer);
    }

    const prepReply = await primary.ask({ kind: 'prepare-cube-parallel', ...basePayload });
    const prepared = prepReply.prepared;
    if (prepared.kind === 'complete') {
      return Boolean(prepared.answer);
    }

    const workers = this._consistentWorkers(await this._acquireWorkers(this.maxWorkers));
    if (!workers.length) throw new Error('worker なし');
    const rollGroups = partitionRoundRobin(ALL_ROLL_INDICES, workers.length);
    const chunkReplies = await Promise.all(
      rollGroups.map((rollIndices, workerIdx) => workers[workerIdx].ask({
        kind: 'eval-cube-roll-chunk',
        ...basePayload,
        rollIndices,
        context: prepared.context,
      })),
    );
    return finalizeCubeDecisionParallel(
      game,
      match ?? null,
      chunkReplies.map((reply) => reply.chunk),
      prepared.context,
    );
  }

  terminate() {
    for (const slot of this.slots) slot.terminate();
    this.slots = [];
  }
}
