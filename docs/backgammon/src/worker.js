// AI の思考を別スレッドで走らせる Web Worker。
//
// **深い読みは時間がかかる**（現行のエキスパートは 2-ply）。メインスレッドで
// 回すと画面が固まることがあるので、探索だけをここへ逃がす。
//
// やり取りは盤面の JSON と出目だけ。**合法手はこちらでも生成する**ので、
// Move オブジェクト（盤面を含む）を構造化コピーで往復させずに済む。
//
// バックエンド契約（Issue #578 Phase 4b / 4c）:
// - 新規 Worker の初期既定値は `'auto'`（WASM 優先）。
// - 同一 Worker への再 `load` で `backend` を省略した場合は直前に設定されていたバックエンド
//   （`'auto' | 'wasm' | 'js'`）を継承する（sticky 契約）。
// - 実効バックエンドが `'auto'` のとき、SIMD128 対応環境では SIMD WASM、非対応時（または
//   SIMD 読込失敗かつ Scalar 利用可能時）は Scalar WASM を選択し、失敗時は JS へ安全に
//   フォールバックして `backendStatus` に実効バックエンドと理由を返す。

import { Board } from './board.js';
import { Game, ROLLING } from './game.js';
import { NeuralNet } from './nn.js';
import {
  agentFor,
  getBearoffDatabase,
  getMoneyBearoffDatabase,
  getPruneNet,
  setBearoffDatabase,
  setMoneyBearoffDatabase,
  setPruneNet,
  validatePruneNet,
} from './agent.js';
import {
  evaluateCheckerMoveRollChunk,
  evaluateCheckerMovesSubset,
  evaluateCubeDecisionRollChunk,
  prepareCubeDecisionParallel,
  rankCheckerMoves,
  selectCheckerMove,
  withCheckerSearchCache,
} from './checker.js';
import { BearoffDatabase } from './bearoff.js';
import { MoneyBearoffDatabase } from './money-bearoff.js';
import { generateMoves, boardKey } from './rules.js';
import {
  assertValidBackend,
  checkCubeHeadCompatibility,
  checkNetCompatibility,
  commitPreparedWasmRuntime,
  discardPreparedWasmRuntime,
  disposeWasmEngine,
  getEngineBackend,
  getEngineBackendStatus,
  prepareWasmRuntime,
  releaseWasmHandle,
  setEngineBackend,
} from './wasm-backend.js';

let net = null;
let loadGeneration = 0;
let moneyBearoffUrl = null;
let moneyBearoffGeneration = 0;
let moneyBearoffLoadPromise = null;
let checkerSearchMode = 'legacy';
let defaultCubeFilterLevel = null;
const agents = new Map();   // level|mode|cubeFilterLevel -> Agent（作り直さず使い回す）

function checkLoadedAssetsForWasm(loadedNet, nextPruneNet) {
  const netCheck = checkNetCompatibility(loadedNet, { allowMoverPerspective: false });
  if (!netCheck.ok) return netCheck;
  if (loadedNet.cubeHeadMoney) {
    const chm = checkCubeHeadCompatibility(
      loadedNet.cubeHeadMoney, loadedNet, 'cubeHeadMoney', { minContextDim: 4 },
    );
    if (!chm.ok) return chm;
  }
  if (loadedNet.cubeHeadMatch) {
    const chMatch = checkCubeHeadCompatibility(
      loadedNet.cubeHeadMatch, loadedNet, 'cubeHeadMatch', { minContextDim: 6 },
    );
    if (!chMatch.ok) return chMatch;
  }
  if (nextPruneNet) {
    const pruneCheck = checkNetCompatibility(nextPruneNet, { allowMoverPerspective: true });
    if (!pruneCheck.ok) {
      return { ok: false, reason: `pruneNet incompatible: ${pruneCheck.reason}` };
    }
  }
  return { ok: true, reason: null };
}

/**
 * 2 つの BearoffDatabase / MoneyBearoffDatabase の生バイナリ内容がバイト単位で完全一致するか判定する。
 * 同一 WASM runtime 再利用時の再 `load` で 10.2 MB BG2N / 3.9 MB Bearoff の不要な破棄・再パースと
 * 線形メモリ増加を防ぐために使用する。
 */
function sameDatabaseBuffer(prevDb, nextDb) {
  if (!prevDb || !nextDb) return false;
  if (prevDb === nextDb) return true;
  const a = prevDb.buffer;
  const b = nextDb.buffer;
  if (!(a instanceof ArrayBuffer) || !(b instanceof ArrayBuffer)) return false;
  if (a.byteLength !== b.byteLength) return false;
  const len32 = a.byteLength >>> 2;
  const u32a = new Uint32Array(a, 0, len32);
  const u32b = new Uint32Array(b, 0, len32);
  for (let i = 0; i < len32; i += 1) {
    if (u32a[i] !== u32b[i]) return false;
  }
  const remStart = len32 << 2;
  if (remStart < a.byteLength) {
    const u8a = new Uint8Array(a, remStart);
    const u8b = new Uint8Array(b, remStart);
    for (let i = 0; i < u8a.length; i += 1) {
      if (u8a[i] !== u8b[i]) return false;
    }
  }
  return true;
}

async function ensureMoneyBearoff(agent, match) {
  if (match !== null || !agent.useMoneyBearoff || moneyBearoffLoadPromise) {
    return moneyBearoffLoadPromise;
  }
  const loadGen = moneyBearoffGeneration;
  const loadUrl = moneyBearoffUrl;
  const promise = MoneyBearoffDatabase.load(loadUrl)
    .then((database) => {
      if (loadGen !== moneyBearoffGeneration || promise !== moneyBearoffLoadPromise) return;
      const prevMoneyBearoff = getMoneyBearoffDatabase();
      if (sameDatabaseBuffer(prevMoneyBearoff, database)) {
        return;
      }
      setMoneyBearoffDatabase(database);
      if (prevMoneyBearoff && prevMoneyBearoff !== database) {
        releaseWasmHandle(prevMoneyBearoff);
      }
    })
    .catch((error) => {
      if (loadGen !== moneyBearoffGeneration || promise !== moneyBearoffLoadPromise) return;
      const prevMoneyBearoff = getMoneyBearoffDatabase();
      setMoneyBearoffDatabase(null);
      if (prevMoneyBearoff) releaseWasmHandle(prevMoneyBearoff);
      console.warn('Money BG2N DB を読めませんでした。従来評価へ戻します', error);
    });
  moneyBearoffLoadPromise = promise;
  return promise;
}

/**
 * **鍵は段（level）であって先読みの深さ（plies）ではない。**
 *
 * 先読み 0 の段が 4 つある（初心者 / カジュアル / 中級 / 上級）ので、plies を鍵にすると
 * **弱い段が黙って中級のまま**になる。しかも Worker が使える環境でだけ起きるので
 * 気づきにくい。`tests/backgammon/worker.mjs` が全段で照合している。
 */
function agentForLevel(level, { mode = null, cubeFilterLevel = undefined } = {}) {
  const effectiveMode = ['legacy', 'full-root', 'staged3ply'].includes(mode)
    ? mode
    : checkerSearchMode;
  const effectiveCubeFilterLevel = cubeFilterLevel !== undefined
    ? cubeFilterLevel
    : defaultCubeFilterLevel;
  const key = `${level}|${effectiveMode}|${effectiveCubeFilterLevel ?? ''}`;
  let agent = agents.get(key);
  if (!agent) {
    const overrides = { checkerSearchMode: effectiveMode };
    if (effectiveCubeFilterLevel !== null && effectiveCubeFilterLevel !== undefined) {
      overrides.cubeFilterLevel = effectiveCubeFilterLevel;
    }
    agent = agentFor(net, level, overrides);
    agents.set(key, agent);
  }
  return agent;
}

function buildCubeGame({ board, player, cubeValue, cubeOwner, jacoby, crawford, match, ask }) {
  const game = new Game(Board.fromJson(board), Math.random, {
    jacoby,
    crawford: Boolean(crawford),
    unboundedMoneyCube: match == null,
  });
  game.currentPlayer = player;
  game.state = ROLLING;
  game.cube.value = cubeValue;
  game.cube.owner = cubeOwner;
  if (ask === 'accept') {
    // **テイク判断は「提案された状態」でしか呼べない。**
    game.proposeDouble();
  }
  return game;
}

self.onmessage = async (event) => {
  const { id, kind } = event.data;
  try {
    if (kind === 'load') {
      const requestedBackend = event.data.backend;
      if (requestedBackend !== undefined) {
        assertValidBackend(requestedBackend);
      }

      // 非同期 load の重複・追い越しや load 中の割り込みで半端な状態が混入しないよう、
      // 世代トークン採番 + ローカル変数への全資産読込＋互換検証 + 最新世代のみ同期一括反映を行う。
      const generation = ++loadGeneration;
      const effectiveBackend = requestedBackend ?? getEngineBackend();
      const wantsWasmInit = effectiveBackend === 'wasm'
        || effectiveBackend === 'auto'
        || Boolean(
          event.data.wasmUrl
          || event.data.wasmScalarUrl
          || event.data.wasmSimdUrl
          || event.data.wasmBytes,
        );

      let preparedWasm = null;
      let wasmInitFailureReason = null;
      let wasmInitError = null;

      try {
        if (wantsWasmInit) {
          try {
            preparedWasm = await prepareWasmRuntime({
              variant: event.data.wasmVariant ?? 'auto',
              wasmUrl: event.data.wasmUrl ?? null,
              wasmScalarUrl: event.data.wasmScalarUrl ?? null,
              wasmSimdUrl: event.data.wasmSimdUrl ?? null,
              wasmBytes: event.data.wasmBytes ?? null,
              forceReload: Boolean(event.data.forceReloadWasm),
            });
          } catch (error) {
            if (effectiveBackend === 'wasm') {
              throw error;
            }
            wasmInitError = error;
            wasmInitFailureReason = String(error && error.message || error);
            if (effectiveBackend === 'auto') {
              console.warn('WASM バックエンドの初期化に失敗したため JS へフォールバックします', error);
            } else {
              console.warn('WASM バックエンドの事前初期化に失敗しました（JS モードを維持します）', error);
            }
          }
        }

        const loadedNet = await NeuralNet.load(event.data.url);
        const nextCheckerSearchMode = ['legacy', 'full-root', 'staged3ply']
          .includes(event.data.checkerSearchMode) ? event.data.checkerSearchMode : 'legacy';
        const nextCubeFilterLevel = Number.isInteger(event.data.cubeFilterLevel)
          ? event.data.cubeFilterLevel
          : null;
        const nextMoneyBearoffUrl = event.data.moneyBearoffUrl
          || new URL('./money-bg2n-6x6-v4.bin', import.meta.url).href;

        let nextBearoff = null;
        // **ベアオフ DB もここで読む。** 無くても動く（ネットの推定に落ちる）ので、
        // 読めなかったら警告だけ出して先へ進む。再ロード時は旧 DB を引きずらない。
        if (event.data.bearoffUrl) {
          try {
            nextBearoff = await BearoffDatabase.load(event.data.bearoffUrl);
          } catch (error) {
            nextBearoff = null;
            console.warn('ベアオフ DB を読めませんでした', error);
          }
        }

        // 毎回の load で Pruning Net の組を確定する。
        // pruneNetUrl 省略 / null / 読込失敗 / 構成不適合はいずれも null へフォールバックする。
        let nextPruneNet = null;
        let pruneNetStatus = 'disabled';
        if (event.data.pruneNetUrl) {
          try {
            const candidate = await NeuralNet.load(event.data.pruneNetUrl);
            nextPruneNet = validatePruneNet(candidate);
            pruneNetStatus = nextPruneNet ? 'loaded' : 'disabled';
          } catch (error) {
            nextPruneNet = null;
            pruneNetStatus = 'fallback';
            console.warn('Pruning Net を読めませんでした', error);
          }
        }

        if (generation !== loadGeneration) {
          discardPreparedWasmRuntime(preparedWasm);
          self.postMessage({
            id,
            ok: false,
            superseded: true,
            error: '新しい load 要求に追い越されたため、このロードを破棄しました',
          });
          return;
        }

        const commitBackend = requestedBackend ?? getEngineBackend();
        if (wasmInitFailureReason !== null && commitBackend === 'wasm') {
          throw wasmInitError ?? new Error(wasmInitFailureReason);
        }

        let modelIncompatReason = null;
        if (commitBackend === 'wasm' || commitBackend === 'auto') {
          const compat = checkLoadedAssetsForWasm(loadedNet, nextPruneNet);
          if (!compat.ok) {
            modelIncompatReason = compat.reason;
          }
        }
        if (commitBackend === 'wasm' && modelIncompatReason !== null) {
          throw new Error(`WASM バックエンドで実行できないモデルです: ${modelIncompatReason}`);
        }

        const prevNet = net;
        const prevPruneNet = getPruneNet();
        const prevBearoff = getBearoffDatabase();
        const prevMoneyBearoff = getMoneyBearoffDatabase();

        if (preparedWasm) {
          commitPreparedWasmRuntime(preparedWasm, {
            backend: requestedBackend !== undefined ? requestedBackend : null,
            fallbackReason: commitBackend === 'auto' && modelIncompatReason !== null
              ? modelIncompatReason
              : undefined,
          });
        } else if (wasmInitFailureReason !== null && commitBackend === 'auto') {
          commitPreparedWasmRuntime(null, {
            backend: requestedBackend !== undefined ? requestedBackend : null,
            fallbackReason: wasmInitFailureReason,
            disposeOnNull: true,
          });
        } else if (requestedBackend !== undefined) {
          setEngineBackend(requestedBackend);
        }

        if (nextBearoff !== null && sameDatabaseBuffer(prevBearoff, nextBearoff)) {
          nextBearoff = prevBearoff;
        }

        net = loadedNet;
        checkerSearchMode = nextCheckerSearchMode;
        defaultCubeFilterLevel = nextCubeFilterLevel;
        if (nextMoneyBearoffUrl !== moneyBearoffUrl) {
          moneyBearoffGeneration += 1;
          moneyBearoffUrl = nextMoneyBearoffUrl;
          moneyBearoffLoadPromise = null;
          setMoneyBearoffDatabase(null);
          if (prevMoneyBearoff) releaseWasmHandle(prevMoneyBearoff);
        }
        setBearoffDatabase(nextBearoff);
        setPruneNet(nextPruneNet);
        agents.clear();

        if (prevNet && prevNet !== loadedNet) releaseWasmHandle(prevNet);
        if (prevPruneNet && prevPruneNet !== nextPruneNet) releaseWasmHandle(prevPruneNet);
        if (prevBearoff && prevBearoff !== nextBearoff) releaseWasmHandle(prevBearoff);

        self.postMessage({
          id,
          ok: true,
          pruneNetLoaded: nextPruneNet !== null,
          pruneNetStatus,
          backendStatus: getEngineBackendStatus(),
        });
        return;
      } catch (error) {
        discardPreparedWasmRuntime(preparedWasm);
        throw error;
      }
    }

    if (kind === 'status') {
      self.postMessage({ id, ok: true, backendStatus: getEngineBackendStatus() });
      return;
    }

    if (kind === 'dispose') {
      loadGeneration += 1;
      moneyBearoffGeneration += 1;
      moneyBearoffLoadPromise = null;
      disposeWasmEngine();
      setBearoffDatabase(null);
      setMoneyBearoffDatabase(null);
      setPruneNet(null);
      net = null;
      agents.clear();
      self.postMessage({ id, ok: true, backendStatus: getEngineBackendStatus() });
      return;
    }

    if (kind === 'select') {
      const { board, player, die1, die2, level, context, mode, cubeFilterLevel } = event.data;
      const parsedBoard = Board.fromJson(board);
      const agent = agentForLevel(level, { mode, cubeFilterLevel });
      const moves = generateMoves(parsedBoard, player, die1, die2, agent.resolveBackend({ board: parsedBoard }));
      const index = context
        ? selectCheckerMove(agent, context, moves, player)
        : agent.selectMove(moves, player);
      // メイン側と合法手の並びが同じであることは generateMoves が純関数で
      // あることから保証されるが、**鍵も返して照合できるようにする**。
      // ずれていたらメイン側が鍵で引き直す。
      self.postMessage({
        id, ok: true, index, key: boardKey(moves[index].resultingBoard),
      });
      return;
    }

    // ヒント。深い読みでも画面を止めないよう、着手と同じくここへ逃がす。
    // 返すのは index と鍵と数値だけ（Move は盤面を抱えていて重い）。
    if (kind === 'rank') {
      const { board, player, die1, die2, level, limit, context, mode, cubeFilterLevel } = event.data;
      const parsedBoard = Board.fromJson(board);
      const agent = agentForLevel(level, { mode, cubeFilterLevel });
      const moves = generateMoves(parsedBoard, player, die1, die2, agent.resolveBackend({ board: parsedBoard }));
      const result = context
        ? rankCheckerMoves(agent, context, moves, player, limit ?? 3)
        : { entries: agent.rankMoves(moves, player, limit ?? 3) };
      self.postMessage({
        id,
        ok: true,
        unit: result.unit,
        evaluation: result.evaluation,
        entries: result.entries.map((entry) => ({
          index: entry.index,
          key: boardKey(entry.move.resultingBoard),
          equity: entry.equity,
          loss: entry.loss,
          probabilities: entry.probabilities,
        })),
      });
      return;
    }

    if (kind === 'eval-checker-subset') {
      const {
        board, player, die1, die2, level, context,
        moveIndices, depth, efficienciesByIndex, mode, cubeFilterLevel,
      } = event.data;
      const parsedBoard = Board.fromJson(board);
      const agent = agentForLevel(level, { mode, cubeFilterLevel });
      const moves = generateMoves(parsedBoard, player, die1, die2, agent.resolveBackend({ board: parsedBoard }));
      const entries = evaluateCheckerMovesSubset(agent, context, moves, player, {
        moveIndices, depth, efficienciesByIndex, mode,
      });
      self.postMessage({ id, ok: true, entries });
      return;
    }

    if (kind === 'eval-checker-roll-chunk') {
      const {
        board, player, die1, die2, level, context,
        moveIndex, depth, rollIndices, efficiencies, mode, cubeFilterLevel,
      } = event.data;
      const parsedBoard = Board.fromJson(board);
      const agent = agentForLevel(level, { mode, cubeFilterLevel });
      const moves = generateMoves(parsedBoard, player, die1, die2, agent.resolveBackend({ board: parsedBoard }));
      const move = moves[moveIndex];
      if (!move) throw new Error(`合法手 index が範囲外です: ${moveIndex}`);
      const chunk = evaluateCheckerMoveRollChunk(agent, context, move, player, {
        depth, rollIndices, efficiencies,
      });
      self.postMessage({ id, ok: true, chunk });
      return;
    }

    // キューブ判断。**着手と同じくらい重い。**
    if (kind === 'cube') {
      const { level, match, ask } = event.data;
      const agent = agentForLevel(level);
      if (match == null) await ensureMoneyBearoff(agent, match ?? null);
      const game = buildCubeGame(event.data);
      const answer = agent.withCheckerVectorCache(() => withCheckerSearchCache(agent, () => (
        ask === 'accept'
          ? agent.shouldAcceptDouble(game, match ?? null)
          : agent.shouldDouble(game, match ?? null)
      )));
      self.postMessage({ id, ok: true, answer: Boolean(answer) });
      return;
    }

    if (kind === 'prepare-cube-parallel') {
      const { level, match, ask } = event.data;
      const agent = agentForLevel(level);
      if (match == null) await ensureMoneyBearoff(agent, match ?? null);
      const game = buildCubeGame(event.data);
      const prepared = prepareCubeDecisionParallel(agent, game, match ?? null, ask);
      self.postMessage({ id, ok: true, prepared });
      return;
    }

    if (kind === 'eval-cube-roll-chunk') {
      const { level, match, rollIndices, context } = event.data;
      const agent = agentForLevel(level);
      if (match == null) await ensureMoneyBearoff(agent, match ?? null);
      const game = buildCubeGame(event.data);
      const chunk = evaluateCubeDecisionRollChunk(agent, game, match ?? null, rollIndices, context);
      self.postMessage({ id, ok: true, chunk });
      return;
    }

    throw new Error(`未知の要求: ${kind}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message || error) });
  }
};
