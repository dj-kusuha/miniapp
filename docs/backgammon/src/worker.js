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
import { Agent, filtersFor } from './agent.js';
import { generateMoves, boardKey } from './rules.js';

let net = null;
const agents = new Map();   // plies -> Agent（作り直さず使い回す）

function agentFor(plies) {
  let agent = agents.get(plies);
  if (!agent) {
    agent = new Agent(net, plies, filtersFor(plies));
    agents.set(plies, agent);
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
      const { board, player, die1, die2, plies } = event.data;
      const moves = generateMoves(Board.fromJson(board), player, die1, die2);
      const index = agentFor(plies).selectMove(moves, player);
      // メイン側と合法手の並びが同じであることは generateMoves が純関数で
      // あることから保証されるが、**鍵も返して照合できるようにする**。
      // ずれていたらメイン側が鍵で引き直す。
      self.postMessage({
        id, ok: true, index, key: boardKey(moves[index].resultingBoard),
      });
      return;
    }

    throw new Error(`未知の要求: ${kind}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message || error) });
  }
};
