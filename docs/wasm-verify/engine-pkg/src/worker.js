// AI の思考を別スレッドで走らせる Web Worker。
//
// **深い読みは時間がかかる**（現行のエキスパートは 2-ply）。メインスレッドで
// 回すと画面が固まることがあるので、
// 再描画もクリックも効かなくなるので、探索だけをここへ逃がす。
//
// やり取りは盤面の JSON と出目だけ。**合法手はこちらでも生成する**ので、
// Move オブジェクト（盤面を含む）を構造化コピーで往復させずに済む。
//
// バックエンド契約（Issue #578 Phase 4b）:
// - 新規 Worker の初期既定値は `'auto'`（WASM 優先）。
// - 同一 Worker への再 `load` で `backend` を省略した場合は常に `'auto'` へ戻るのではなく、
//   直前に設定されていたバックエンド（`'auto' | 'wasm' | 'js'`）を継承する（sticky 契約）。
//   明示 `'js'` / `'wasm'` へ切り替えた後に `'auto'` へ戻す場合は `backend: 'auto'` を明示指定する。
// - 実効バックエンドが `'auto'` のとき、SIMD128 対応環境では SIMD WASM、非対応時（または SIMD 読込失敗かつ
//   Scalar 利用可能時）は Scalar WASM を選択し、WASM 非対応・初期化失敗・非互換モデル時は JS へフォールバックして
//   `{ ok: true, backendStatus }` で応答する。実効 `'wasm'` の失敗時は例外応答 (`ok: false`) を返す。

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
const agents = new Map();   // level id -> Agent（作り直さず使い回す）

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
 * dlmalloc 連続領域分断（+9.75 MiB/worker 増加）を防ぐために使用する。
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

/**
 * **鍵は段（level）であって先読みの深さ（plies）ではない。**
 *
 * 先読み 0 の段が 4 つある（初心者 / カジュアル / 中級 / 上級）ので、plies を鍵にすると
 * **弱い段が黙って中級のまま**になる。しかも Worker が使える環境でだけ起きるので
 * 気づきにくい。`tests/backgammon/worker.mjs` が全段で照合している。
 */
function agentForLevel(level) {
  let agent = agents.get(level);
  if (!agent) {
    agent = agentFor(net, level);
    agents.set(level, agent);
  }
  return agent;
}

self.onmessage = async (event) => {
  const { id, kind } = event.data;
  try {
    if (kind === 'load') {
      // 不正な backend 指定は世代更新・fetch・WASM 準備のどれより先に入口で拒否し、
      // 既存の確定済み runtime / net / agents / loadGeneration を一切変更しない。
      const requestedBackend = event.data.backend;
      if (requestedBackend !== undefined) {
        assertValidBackend(requestedBackend);
      }

      // 非同期 load の重複・追い越しや load 中の select/rank/cube/dispose 割り込みで
      // 半端な (net, pruneNet, wasmRuntime) 状態や旧世代資産が混入しないよう、
      // 1) 世代トークンを採番し、
      // 2) WASM runtime・モデル・DB をすべてローカル変数へ準備・検証してから、
      // 3) 最新世代のときだけ同期的に runtime・backend・モデル・agents を一括確定する。
      // load 完了前に届いた select/rank/cube は直前の確定スナップショットで実行される。
      const generation = ++loadGeneration;
      const effectiveBackend = requestedBackend ?? getEngineBackend();
      const wantsWasmInit = effectiveBackend === 'wasm'
        || effectiveBackend === 'auto'
        || Boolean(event.data.wasmUrl || event.data.wasmScalarUrl || event.data.wasmSimdUrl || event.data.wasmBytes);

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
            // 明示 wasm（省略時に現在の wasm 設定を継承した場合も含む）では
            // 失敗を握りつぶさず例外で中断し、既存の確定済みスナップショットを守る。
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

        let nextBearoff;
        // **ベアオフ DB もここで読む。** 無くても動く（ネットの推定に落ちる）ので、
        // 読めなかったら警告だけ出して先へ進む。
        if (event.data.bearoffUrl) {
          try {
            nextBearoff = await BearoffDatabase.load(event.data.bearoffUrl);
          } catch (error) {
            console.warn('ベアオフ DB を読めませんでした', error);
          }
        }

        let nextMoneyBearoff;
        if (event.data.moneyBearoffUrl) {
          try {
            nextMoneyBearoff = await MoneyBearoffDatabase.load(event.data.moneyBearoffUrl);
          } catch (error) {
            console.warn('Money ベアオフ DB を読めませんでした', error);
          }
        }

        // 毎回の load で Pruning Net の組を確定する。
        // pruneNetUrl 省略 / null / 読込失敗 / 構成不適合はいずれも null へ安全フォールバックする。
        let nextPruneNet = null;
        if (event.data.pruneNetUrl) {
          try {
            const candidate = await NeuralNet.load(event.data.pruneNetUrl);
            nextPruneNet = validatePruneNet(candidate);
          } catch (error) {
            nextPruneNet = null;
            console.warn('Pruning Net を読めませんでした', error);
          }
        }

        // 後続の load や dispose がすでに走っている場合、古い load 結果で最新状態を上書きしない。
        if (generation !== loadGeneration) {
          discardPreparedWasmRuntime(preparedWasm);
          self.postMessage({ id, ok: true, superseded: true });
          return;
        }

        // commit 時点の実効 backend でも明示 wasm なら失敗を許容しない（防御的検証）
        const commitBackend = requestedBackend ?? getEngineBackend();
        if (wasmInitFailureReason !== null && commitBackend === 'wasm') {
          throw wasmInitError ?? new Error(wasmInitFailureReason);
        }

        // 読み込んだモデル・CubeHead・Pruning Net が WASM と互換か commit 前に検証する。
        // - 明示 wasm では既存スナップショットを一切書き換えずに例外終了する。
        // - auto ではロード自体は完了させ、backendStatus に即座に JS フォールバック理由を反映する。
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

        // ここから下は同期処理のみ: WASM runtime・backend・モデル・補助資産・Agent キャッシュを不可分に更新する。
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
          // auto で WASM 初期化に失敗した場合のみ旧 runtime を解放して確実に JS フォールバック状態へ揃え、
          // getEngineBackendStatus().fallbackReason に実際の失敗理由を記録する。
          commitPreparedWasmRuntime(null, {
            backend: requestedBackend !== undefined ? requestedBackend : null,
            fallbackReason: wasmInitFailureReason,
            disposeOnNull: true,
          });
        } else if (requestedBackend !== undefined) {
          setEngineBackend(requestedBackend);
        }

        // バイナリ内容が完全一致する Bearoff / Money BG2N は既存インスタンス（および WASM ハンドル）を
        // そのまま再利用し、同一 runtime 再利用リロード時の不要な再パースと線形メモリ増加を防ぐ。
        if (nextBearoff !== undefined && sameDatabaseBuffer(prevBearoff, nextBearoff)) {
          nextBearoff = prevBearoff;
        }
        if (nextMoneyBearoff !== undefined && sameDatabaseBuffer(prevMoneyBearoff, nextMoneyBearoff)) {
          nextMoneyBearoff = prevMoneyBearoff;
        }

        net = loadedNet;
        if (nextBearoff !== undefined) setBearoffDatabase(nextBearoff);
        if (nextMoneyBearoff !== undefined) setMoneyBearoffDatabase(nextMoneyBearoff);
        setPruneNet(nextPruneNet);
        agents.clear();

        // 旧世代アセットの WASM ハンドルを明示解放してリロード時のメモリ残存を防ぐ
        if (prevNet && prevNet !== loadedNet) releaseWasmHandle(prevNet);
        if (prevPruneNet && prevPruneNet !== nextPruneNet) releaseWasmHandle(prevPruneNet);
        if (nextBearoff !== undefined && prevBearoff && prevBearoff !== nextBearoff) {
          releaseWasmHandle(prevBearoff);
        }
        if (nextMoneyBearoff !== undefined && prevMoneyBearoff && prevMoneyBearoff !== nextMoneyBearoff) {
          releaseWasmHandle(prevMoneyBearoff);
        }

        self.postMessage({ id, ok: true, backendStatus: getEngineBackendStatus() });
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
      // 進行中の load 世代を無効化し、後着完了で runtime や net が復活するのを防ぐ。
      loadGeneration += 1;
      disposeWasmEngine();
      agents.clear();
      self.postMessage({ id, ok: true, backendStatus: getEngineBackendStatus() });
      return;
    }

    if (kind === 'select') {
      const { board, player, die1, die2, level } = event.data;
      const agent = agentForLevel(level);
      const parsedBoard = Board.fromJson(board);
      const moves = generateMoves(parsedBoard, player, die1, die2, agent.resolveBackend({ board: parsedBoard }));
      // この既存select/rank protocolはcubeless専用。cube-aware評価はfacadeを正本とする。
      const index = agent.selectMove(moves, player);
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
      const { board, player, die1, die2, level, limit } = event.data;
      const agent = agentForLevel(level);
      const parsedBoard = Board.fromJson(board);
      const moves = generateMoves(parsedBoard, player, die1, die2, agent.resolveBackend({ board: parsedBoard }));
      // cube/match状態を受け取らないcubeless順位付け。cube-aware分析はfacadeを使う。
      const ranked = agent.rankMoves(moves, player, limit ?? 3);
      self.postMessage({
        id,
        ok: true,
        entries: ranked.map((entry) => ({
          index: entry.index,
          key: boardKey(entry.move.resultingBoard),
          equity: entry.equity,
          loss: entry.loss,
          probabilities: entry.probabilities,
        })),
      });
      return;
    }

    // キューブ判断。**着手と同じくらい重い。**
    // cubePlies=2 だと shouldDouble 1 回で 1〜2 秒かかる（engine の実測で
    // 0-ply の 1 万倍）。しかも**手番のたびに呼ばれる**ので、メインスレッドに
    // 置くと人が指した直後に必ず固まる。
    //
    // **Game をまるごと送らない。** キューブ判断に要るのは盤面・手番・
    // キューブの値と所有者・ジャコビーだけなので、それだけ送って
    // こちらで組み立て直す。
    if (kind === 'cube') {
      const {
        board, player, cubeValue, cubeOwner, jacoby, level, match, ask, unboundedMoney = false,
      } = event.data;
      const game = new Game(Board.fromJson(board), Math.random, {
        jacoby,
        unboundedMoneyCube: Boolean(!match && unboundedMoney),
      });
      game.currentPlayer = player;
      game.state = ROLLING;
      game.cube.value = cubeValue;
      game.cube.owner = cubeOwner;
      const agent = agentForLevel(level);
      let answer;
      if (ask === 'accept') {
        // **テイク判断は「提案された状態」でしか呼べない。**
        game.proposeDouble();
        answer = agent.shouldAcceptDouble(game, match ?? null);
      } else {
        answer = agent.shouldDouble(game, match ?? null);
      }
      self.postMessage({ id, ok: true, answer: Boolean(answer) });
      return;
    }

    throw new Error(`未知の要求: ${kind}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message || error) });
  }
};
