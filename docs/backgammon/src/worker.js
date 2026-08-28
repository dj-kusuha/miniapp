// AI の思考を別スレッドで走らせる Web Worker。
//
// **3-ply は 1 手あたり 1〜3 秒かかる**（このマシンで中央値 788 ms、
// 最悪 3.3 秒）。メインスレッドで回すとその間ずっと画面が固まり、
// 再描画もクリックも効かなくなるので、探索だけをここへ逃がす。
//
// やり取りは盤面の JSON と出目だけ。**合法手はこちらでも生成する**ので、
// Move オブジェクト（盤面を含む）を構造化コピーで往復させずに済む。

import { Board } from './board.js';
import { Game, ROLLING } from './game.js';
import { NeuralNet } from './nn.js';
import { agentFor, setBearoffDatabase } from './agent.js';
import { BearoffDatabase } from './bearoff.js';
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

    // キューブ判断。**着手と同じくらい重い。**
    // cubePlies=2 だと shouldDouble 1 回で 1〜2 秒かかる（engine の実測で
    // 0-ply の 1 万倍）。しかも**手番のたびに呼ばれる**ので、メインスレッドに
    // 置くと人が指した直後に必ず固まる。
    //
    // **Game をまるごと送らない。** キューブ判断に要るのは盤面・手番・
    // キューブの値と所有者・ジャコビーだけなので、それだけ送って
    // こちらで組み立て直す。
    if (kind === 'cube') {
      const { board, player, cubeValue, cubeOwner, jacoby, level, match, ask } = event.data;
      const game = new Game(Board.fromJson(board), Math.random, { jacoby });
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
