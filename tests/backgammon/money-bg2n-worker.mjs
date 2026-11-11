// Money BG2NはWorker初期化/着手・ヒントでは読まず、対象cube rootで一度だけ読む。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../docs/backgammon');
let moneyDbRequests = 0;
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const rel = normalize(decodeURIComponent(pathname)).replace(/^[\/\\]+/, '');
    if (rel.endsWith('money-bg2n-6x6-v4.bin')) moneyDbRequests += 1;
    const body = await readFile(join(root, rel));
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
const inbox = [];
globalThis.self = {
  set onmessage(handler) { this.handler = handler; },
  get onmessage() { return this.handler; },
  postMessage(message) { inbox.push(message); },
};

try {
  await import(new URL('../../docs/backgammon/src/worker.js', import.meta.url).href);
  let id = 0;
  const ask = async (payload) => {
    id += 1;
    await self.onmessage({ data: { id, ...payload } });
    const reply = inbox.find((message) => message.id === id);
    if (!reply?.ok) throw new Error(reply?.error ?? 'Worker reply missing');
    return reply;
  };

  await ask({
    kind: 'load',
    url: `${base}src/model.json`,
    moneyBearoffUrl: `${base}src/money-bg2n-6x6-v4.bin`,
  });
  assert.equal(moneyDbRequests, 0, 'worker startup does not load Money BG2N');

  const points = Array(24).fill(0);
  points[0] = 2;
  points[1] = 1;
  points[18] = -1;
  points[23] = -1;
  const request = {
    kind: 'cube',
    board: { points, bar: [0, 0], off: [0, 0] },
    player: 'BLACK', cubeValue: 1, cubeOwner: null,
    jacoby: true, crawford: false, level: 'casual', match: null,
  };
  assert.equal((await ask({ ...request, ask: 'double' })).answer, true);
  assert.equal(moneyDbRequests, 1, 'eligible Money cube root loads one DB');
  assert.equal((await ask({ ...request, ask: 'accept' })).answer, false);
  assert.equal(moneyDbRequests, 1, 'subsequent cube roots reuse the reader');
  console.log('Money BG2N Worker: lazy load, reuse, ND action, DT response OK');
} finally {
  server.close();
}
