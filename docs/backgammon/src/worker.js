// AI の思考を別スレッドで走らせる Web Worker。
//
// **3-ply は 1 手あたり 1〜3 秒かかる**（このマシンで中央値 788 ms、
// 最悪 3.3 秒）。メインスレッドで回すとその間ずっと画面が固まり、
// 再描画もクリックも効かなくなるので、探索だけをここへ逃がす。
//
// やり取りは盤面の JSON と出目だけ。**合法手はこちらでも生成する**ので、
// Move オブジェクト（盤面を含む）を構造化コピーで往復させずに済む。

import { Board } from './board.js';
import { NeuralNet } from './nn.js';
import { agentFor } from './agent.js';
import { generateMoves, boardKey } from './rules.js';

let net = null;
const agents = new Map();   // level id -> Agent（作り直さず使い回す）

/**
 * **鍵は段（level）であって先読みの深さ（plies）ではない。**
 *
 * 先読み 0 の段が 3 つある（入門 / 初級 / 中級）ので、plies を鍵にすると
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
      net = await NeuralNet.load(event.data.url);
      self.postMessage({ id, ok: true });
      return;
    }

    if (kind === 'select') {
      const { board, player, die1, die2, level } = event.data;
      const moves = generateMoves(Board.fromJson(board), player, die1, die2);
      const index = agentForLevel(level).selectMove(moves, player);
      // メイン側と合法手の並びが同じであることは generateMoves が純関数で
      // あることから保証されるが、**鍵も返して照合できるようにする**。
      // ずれていたらメイン側が鍵で引き直す。
      self.postMessage({
        id, ok: true, index, key: boardKey(moves[index].resultingBoard),
      });
      return;
    }

    // ヒント。**3-ply だと 1〜3 秒かかる**ので、着手と同じくここへ逃がす。
    // 返すのは index と鍵と数値だけ（Move は盤面を抱えていて重い）。
    if (kind === 'rank') {
      const { board, player, die1, die2, level, limit } = event.data;
      const moves = generateMoves(Board.fromJson(board), player, die1, die2);
      const ranked = agentForLevel(level).rankMoves(moves, player, limit ?? 3);
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

    throw new Error(`未知の要求: ${kind}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message || error) });
  }
};
