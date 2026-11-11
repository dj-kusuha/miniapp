// AI の思考を別スレッドで走らせる Web Worker。
//
// **深い読みは時間がかかる**（現行のエキスパートは 2-ply）。メインスレッドで
// 回すと画面が固まることがあるので、
// 再描画もクリックも効かなくなるので、探索だけをここへ逃がす。
//
// やり取りは盤面の JSON と出目だけ。**合法手はこちらでも生成する**ので、
// Move オブジェクト（盤面を含む）を構造化コピーで往復させずに済む。

import { Board } from './board.js';
import { Game, ROLLING } from './game.js';
import { NeuralNet } from './nn.js';
import { agentFor, setBearoffDatabase, setMoneyBearoffDatabase } from './agent.js';
import { rankCheckerMoves, selectCheckerMove } from './checker.js';
import { BearoffDatabase } from './bearoff.js';
import { MoneyBearoffDatabase } from './money-bearoff.js';
import { generateMoves, boardKey } from './rules.js';

let net = null;
let moneyBearoffUrl = null;
let moneyBearoffLoadPromise = null;
let checkerSearchMode = 'legacy';
const agents = new Map();   // level id -> Agent（作り直さず使い回す）

async function ensureMoneyBearoff(agent, match) {
  if (match !== null || !agent.useMoneyBearoff || moneyBearoffLoadPromise) {
    return moneyBearoffLoadPromise;
  }
  moneyBearoffLoadPromise = MoneyBearoffDatabase.load(moneyBearoffUrl)
    .then((database) => setMoneyBearoffDatabase(database))
    .catch((error) => {
      setMoneyBearoffDatabase(null);
      console.warn('Money BG2N DB を読めませんでした。従来評価へ戻します', error);
    });
  return moneyBearoffLoadPromise;
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
    agent = agentFor(net, level, { checkerSearchMode });
    agents.set(level, agent);
  }
  return agent;
}

self.onmessage = async (event) => {
  const { id, kind } = event.data;
  try {
    if (kind === 'load') {
      net = await NeuralNet.load(event.data.url);
      checkerSearchMode = ['legacy', 'full-root', 'staged3ply']
        .includes(event.data.checkerSearchMode) ? event.data.checkerSearchMode : 'legacy';
      agents.clear();
      moneyBearoffUrl = event.data.moneyBearoffUrl
        || new URL('./money-bg2n-6x6-v4.bin', import.meta.url).href;
      // **ベアオフ DB もここで読む。** 無くても動く（ネットの推定に落ちる）ので、
      // 読めなかったら警告だけ出して先へ進む。
      if (event.data.bearoffUrl) {
        try {
          setBearoffDatabase(await BearoffDatabase.load(event.data.bearoffUrl));
        } catch (error) {
          console.warn('ベアオフ DB を読めませんでした', error);
        }
      }
      self.postMessage({ id, ok: true });
      return;
    }

    if (kind === 'select') {
      const { board, player, die1, die2, level, context } = event.data;
      const moves = generateMoves(Board.fromJson(board), player, die1, die2);
      const agent = agentForLevel(level);
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
      const { board, player, die1, die2, level, limit, context } = event.data;
      const moves = generateMoves(Board.fromJson(board), player, die1, die2);
      const agent = agentForLevel(level);
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

    // キューブ判断。**着手と同じくらい重い。**
    // cubePlies=2 だと shouldDouble 1 回で 1〜2 秒かかる（engine の実測で
    // 0-ply の 1 万倍）。しかも**手番のたびに呼ばれる**ので、メインスレッドに
    // 置くと人が指した直後に必ず固まる。
    //
    // **Game をまるごと送らない。** キューブ判断に要るのは盤面・手番・
    // キューブの値と所有者・ジャコビーだけなので、それだけ送って
    // こちらで組み立て直す。
    if (kind === 'cube') {
      const { board, player, cubeValue, cubeOwner, jacoby, crawford, level, match, ask } = event.data;
      const agent = agentForLevel(level);
      if (match == null) await ensureMoneyBearoff(agent, match);
      const game = new Game(Board.fromJson(board), Math.random, {
        jacoby,
        crawford: Boolean(crawford),
        unboundedMoneyCube: match == null,
      });
      game.currentPlayer = player;
      game.state = ROLLING;
      game.cube.value = cubeValue;
      game.cube.owner = cubeOwner;
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
