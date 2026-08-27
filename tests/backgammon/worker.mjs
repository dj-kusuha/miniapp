// AI の思考係（Web Worker）の受け答えを検証する。
//
// ブラウザが要らないように `self` を偽装して worker.js をそのまま読み込む。
// **Worker が返す手が、メインスレッドで直接選んだ手と一致すること**を確かめる。
// ここがずれると、盤面の JSON 化か合法手の並びのどちらかが壊れている。
//
// モジュール自体は file:// から読む（Node は http から import できない）。
// モデルだけは `fetch` で読むので、テスト中だけ静的サーバを立てる
// （Node の fetch は file:// を扱えないため）。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../docs/backgammon');

const types = { '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const body = await readFile(join(ROOT, rel));
    const ext = rel.slice(rel.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

// ── self を偽装して worker.js を読み込む ──────────────
const inbox = [];
globalThis.self = {
  set onmessage(fn) { this._handler = fn; },
  get onmessage() { return this._handler; },
  postMessage(data) { inbox.push(data); },
};
await import(new URL('../../docs/backgammon/src/worker.js', import.meta.url).href);

let nextId = 1;
async function ask(payload) {
  const id = nextId;
  nextId += 1;
  await globalThis.self.onmessage({ data: { id, ...payload } });
  const reply = inbox.find((m) => m.id === id);
  if (!reply) throw new Error(`返事がありません: ${JSON.stringify(payload)}`);
  if (!reply.ok) throw new Error(reply.error);
  return reply;
}

// ── メインスレッド側の参照実装 ──────────────────────
const src = (name) => new URL(`../../docs/backgammon/src/${name}`, import.meta.url).href;
const { Board, WHITE, opponent } = await import(src('board.js'));
const { NeuralNet } = await import(src('nn.js'));
const { agentFor, LEVELS } = await import(src('agent.js'));
const { generateMoves, boardKey } = await import(src('rules.js'));
const { Game, ROLLING } = await import(src('game.js'));

await ask({ kind: 'load', url: `${base}src/model.json` });
const net = await NeuralNet.load(`${base}src/model.json`);

// 決定的な局面列を作る（毎回同じものを検証する）
let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const die = () => 1 + (rnd() * 6 | 0);

let bad = 0;
let checked = 0;
// **全段で照合する。** 先読み 0 の段が 3 つあるので、Worker が plies を鍵に
// 使い回すと弱い段が黙って中級のままになる。ここが唯一の防波堤。
for (const level of LEVELS) {
  const plies = level.plies;
  const agent = agentFor(net, level.id);
  let board = new Board();
  let turn = WHITE;
  let done = 0;
  // 3-ply は 1 手ずつが重いので回数を絞る
  const want = plies === 3 ? 4 : 12;
  while (done < want) {
    const d1 = die(); const d2 = die();
    const moves = generateMoves(board, turn, d1, d2);
    if (moves.length > 1) {
      const reply = await ask({
        kind: 'select',
        board: {
          points: board.points,
          bar: [board.bar[WHITE], board.bar[opponent(WHITE)]],
          off: [board.off[WHITE], board.off[opponent(WHITE)]],
        },
        player: turn, die1: d1, die2: d2, level: level.id,
      });
      const want_ = agent.selectMove(moves, turn);
      checked += 1;
      if (reply.index !== want_) {
        bad += 1;
        if (bad <= 3) console.log(`  ${level.id}: worker=${reply.index} main=${want_}`);
      }
      if (boardKey(moves[reply.index].resultingBoard) !== reply.key) {
        bad += 1;
        console.log(`  ${level.id}: 鍵が一致しません`);
      }
      done += 1;
    }
    if (moves.length) board = moves[agent.selectMove(moves, turn)].resultingBoard;
    turn = opponent(turn);
    if (board.hasWon(WHITE) || board.hasWon(opponent(WHITE))) { board = new Board(); turn = WHITE; }
  }
}

// **キューブ判断も Worker とメインで一致すること。**
// cubePlies=2 の段は 1 回 1〜2 秒かかるのでメインスレッドから追い出したが、
// **ずれると「Web だけダブルのタイミングが違う」という気づきにくい壊れ方**に
// なる。段ごと・キューブの所在ごとに照合する。
let cubeChecked = 0;
for (const level of LEVELS) {
  const agent = agentFor(net, level.id);
  let board = new Board();
  let turn = WHITE;
  let done = 0;
  const want = level.plies >= 2 ? 2 : 4;
  while (done < want) {
    const d1 = die(); const d2 = die();
    const moves = generateMoves(board, turn, d1, d2);
    if (moves.length) board = moves[agent.selectMove(moves, turn)].resultingBoard;
    turn = opponent(turn);
    if (board.hasWon(WHITE) || board.hasWon(opponent(WHITE))) {
      board = new Board(); turn = WHITE; continue;
    }
    for (const [value, owner] of [[1, null], [2, turn]]) {
      const payload = {
        kind: 'cube',
        board: {
          points: board.points,
          bar: [board.bar[WHITE], board.bar[opponent(WHITE)]],
          off: [board.off[WHITE], board.off[opponent(WHITE)]],
        },
        player: turn, cubeValue: value, cubeOwner: owner, jacoby: true,
        level: level.id, match: null,
      };
      for (const kind of ['double', 'accept']) {
        const reply = await ask({ ...payload, ask: kind });
        const game = new Game(new Board([...board.points],
          { WHITE: board.bar[WHITE], BLACK: board.bar[opponent(WHITE)] },
          { WHITE: board.off[WHITE], BLACK: board.off[opponent(WHITE)] }),
        Math.random, { jacoby: true });
        game.currentPlayer = turn;
        game.state = ROLLING;
        game.cube.value = value;
        game.cube.owner = owner;
        let mine;
        if (kind === 'accept') { game.proposeDouble(); mine = agent.shouldAcceptDouble(game, null); }
        else { mine = agent.shouldDouble(game, null); }
        checked += 1;
        cubeChecked += 1;
        if (reply.answer !== Boolean(mine)) {
          bad += 1;
          if (bad <= 6) {
            console.log(`  ${level.id} キューブ(${kind} cube=${value}/${owner}): `
              + `worker=${reply.answer} main=${Boolean(mine)}`);
          }
        }
      }
    }
    done += 1;
  }
}

// 異常系: 知らない要求は ok:false で返る
let rejected = false;
try { await ask({ kind: 'なにこれ' }); } catch { rejected = true; }

server.close();
console.log(`思考係: ${checked} 件中 ${checked - bad} 件がメインスレッドと一致 / 不一致 ${bad}`
  + `（うちキューブ判断 ${cubeChecked} 件）`);
console.log(`  未知の要求を拒否: ${rejected ? 'OK' : 'NG'}`);
process.exit(bad || !rejected ? 1 : 0);
