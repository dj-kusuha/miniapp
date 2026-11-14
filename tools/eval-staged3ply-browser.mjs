// ブラウザ（Headless Chrome）実測スクリプト: main thread / Worker 別の Legacy vs staged3ply レイテンシ計測（Issue #549）。
// 実行: BROWSER_PATH="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" node tools/eval-staged3ply-browser.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const docsRoot = resolve(repoRoot, 'docs/backgammon');

const browserCandidates = process.platform === 'win32'
  ? [process.env.BROWSER_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
  : [
    process.env.BROWSER_PATH,
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    'google-chrome',
    'chromium',
    'microsoft-edge',
  ];

const browserPath = browserCandidates.find((candidate) => candidate
  && (candidate === process.env.BROWSER_PATH || existsSync(candidate)));
if (!browserPath) {
  throw new Error('Chrome/Edgeが見つかりません。BROWSER_PATHを指定してください');
}

const isWindowsBrowser = process.platform === 'win32'
  || browserPath.startsWith('/mnt/')
  || browserPath.endsWith('.exe');

// Select 12 representative positions covering categories, Money/Match, and deep vs 1-ply-unique
const fixtures = JSON.parse(readFileSync(resolve(repoRoot, 'tests/backgammon/staged-3ply-eval-fixtures.json'), 'utf8'));
const rawEvalPath = resolve(repoRoot, 'tests/backgammon/staged-3ply-eval-raw.json');
const rawEval = existsSync(rawEvalPath) ? JSON.parse(readFileSync(rawEvalPath, 'utf8')) : null;
const rawById = new Map((rawEval?.results ?? []).map((r) => [r.id, r]));

const pickPositions = () => {
  const picked = [];
  const used = new Set();
  const add = (pos, tag) => {
    if (!pos || used.has(pos.id)) return;
    used.add(pos.id);
    const r = rawById.get(pos.id);
    picked.push({
      id: pos.id,
      category: pos.category,
      stratum: pos.stratum,
      mode: pos.context.match.mode,
      cubeEnabled: pos.context.cube.enabled,
      legalMovesCount: pos.legalMovesCount,
      deepTag: tag,
      maxAdditionalDepth: r?.stage?.maxAdditionalDepth ?? null,
      board: pos.board,
      player: pos.player,
      die1: pos.die1,
      die2: pos.die2,
      context: pos.context,
    });
  };

  const isDeep = (pos) => {
    const r = rawById.get(pos.id);
    if (r) return !r.stage.bypassedStaged && r.stage.maxAdditionalDepth >= 1;
    return pos.probe?.moneyTwoPly >= 2 || pos.probe?.matchTwoPly >= 2;
  };
  const isStage3 = (pos) => {
    const r = rawById.get(pos.id);
    if (r) return !r.stage.bypassedStaged && r.stage.maxAdditionalDepth === 2;
    return pos.probe?.moneyThreePly >= 2 || pos.probe?.matchThreePly >= 2;
  };

  const targets = [
    ['money', 'contact', true, 'deep'],
    ['money', 'tactical-contact', true, 'deep'],
    ['money', 'prime', true, 'deep'],
    ['money', 'backgame', true, 'deep'],
    ['money', 'bearoff', true, 'deep'],
    ['money', 'opening', false, '1ply-unique'],
    ['match', 'contact', true, 'deep'],
    ['match', 'tactical-contact', true, 'deep'],
    ['match', 'prime', true, 'deep'],
    ['match', 'backgame', true, 'deep'],
    ['match', 'race', false, '1ply-unique'],
    ['match', 'opening', false, '1ply-unique'],
  ];

  for (const [mode, category, wantDeep, tag] of targets) {
    const pool = fixtures.positions.filter((p) => p.context.match.mode === mode
      && p.category === category && p.context.cube.enabled);
    const match = (wantDeep
      ? (pool.find((p) => isStage3(p)) ?? pool.find((p) => isDeep(p)))
      : pool.find((p) => !isDeep(p))) ?? pool[0];
    add(match, tag);
  }
  return picked;
};

const benchPositions = pickPositions();
const REPEATS = 3;

const pageHtml = `<!doctype html>
<meta charset="utf-8">
<title>Issue #549 Browser Benchmark</title>
<script type="module">
import { Board } from '/src/board.js';
import { NeuralNet } from '/src/nn.js';
import { Agent, filtersFor, setBearoffDatabase, setMoneyBearoffDatabase } from '/src/agent.js';
import { BearoffDatabase } from '/src/bearoff.js';
import { MoneyBearoffDatabase } from '/src/money-bearoff.js';
import { generateMoves } from '/src/rules.js';
import { selectCheckerMove } from '/src/checker.js';

const positions = ${JSON.stringify(benchPositions)};
const repeats = ${REPEATS};

const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
  return {
    samples: values.length,
    meanMs: Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)),
    p50Ms: Number(pct(0.50).toFixed(2)),
    p95Ms: Number(pct(0.95).toFixed(2)),
    maxMs: Number(sorted.at(-1).toFixed(2)),
  };
};

function createWorkerClient(mode) {
  const w = new Worker('/src/worker.js', { type: 'module' });
  let nextId = 0;
  const pending = new Map();
  w.onmessage = ({ data }) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    data.ok ? entry.resolve(data) : entry.reject(new Error(data.error));
  };
  w.onerror = (ev) => {
    const err = new Error('Worker error: ' + (ev.message || 'unknown'));
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  const ask = (payload) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, ...payload });
  });
  return {
    ask,
    async init() {
      await ask({
        kind: 'load',
        url: new URL('/src/model.json', location.href).href,
        bearoffUrl: new URL('/src/bearoff-6x15.bin', location.href).href,
        moneyBearoffUrl: new URL('/src/money-bg2n-6x6-v4.bin', location.href).href,
        checkerSearchMode: mode,
      });
    },
    terminate() { w.terminate(); },
  };
}

try {
  window.__benchProgress = 'loading assets';
  const model = await (await fetch('/src/model.json')).json();
  const net = new NeuralNet(model);
  setBearoffDatabase(await BearoffDatabase.load('/src/bearoff-6x15.bin'));
  setMoneyBearoffDatabase(await MoneyBearoffDatabase.load('/src/money-bg2n-6x6-v4.bin'));

  const records = [];
  const coldStarts = {};

  for (const mode of ['legacy', 'staged3ply']) {
    window.__benchProgress = 'main-thread ' + mode;
    const agent = new Agent(net, 3, filtersFor(3), { checkerSearchMode: mode });

    // Cold-start on first position
    const pCold = positions[0];
    const mCold = generateMoves(Board.fromJson(pCold.board), pCold.player, pCold.die1, pCold.die2);
    const tCold0 = performance.now();
    selectCheckerMove(agent, pCold.context, mCold, pCold.player);
    coldStarts['main:' + mode] = Number((performance.now() - tCold0).toFixed(2));

    // Warm-up on 2 positions
    for (let i = 0; i < Math.min(2, positions.length); i += 1) {
      const pw = positions[i];
      const mw = generateMoves(Board.fromJson(pw.board), pw.player, pw.die1, pw.die2);
      selectCheckerMove(agent, pw.context, mw, pw.player);
    }

    for (const pos of positions) {
      const moves = generateMoves(Board.fromJson(pos.board), pos.player, pos.die1, pos.die2);
      const samples = [];
      let action = 0;
      for (let r = 0; r < repeats; r += 1) {
        await new Promise((resolveTick) => setTimeout(resolveTick, 0));
        const t0 = performance.now();
        action = selectCheckerMove(agent, pos.context, moves, pos.player);
        samples.push(performance.now() - t0);
      }
      records.push({
        path: 'main-thread',
        mode,
        id: pos.id,
        category: pos.category,
        searchMode: pos.mode,
        deepTag: pos.deepTag,
        maxAdditionalDepth: agent.checkerLastStagedSearch?.maxAdditionalDepth ?? null,
        action,
        samplesMs: samples.map((x) => Number(x.toFixed(2))),
        stats: summary(samples),
      });
    }
  }

  for (const mode of ['legacy', 'staged3ply']) {
    window.__benchProgress = 'worker ' + mode;
    const client = createWorkerClient(mode);
    await client.init();

    // Cold-start
    const pCold = positions[0];
    const tCold0 = performance.now();
    await client.ask({
      kind: 'select',
      board: pCold.board,
      player: pCold.player,
      die1: pCold.die1,
      die2: pCold.die2,
      level: 'champion',
      context: pCold.context,
    });
    coldStarts['worker:' + mode] = Number((performance.now() - tCold0).toFixed(2));

    // Warm-up
    for (let i = 0; i < Math.min(2, positions.length); i += 1) {
      const pw = positions[i];
      await client.ask({
        kind: 'select',
        board: pw.board,
        player: pw.player,
        die1: pw.die1,
        die2: pw.die2,
        level: 'champion',
        context: pw.context,
      });
    }

    for (const pos of positions) {
      const samples = [];
      let action = 0;
      for (let r = 0; r < repeats; r += 1) {
        const t0 = performance.now();
        const res = await client.ask({
          kind: 'select',
          board: pos.board,
          player: pos.player,
          die1: pos.die1,
          die2: pos.die2,
          level: 'champion',
          context: pos.context,
        });
        samples.push(performance.now() - t0);
        action = res.index;
      }
      records.push({
        path: 'worker',
        mode,
        id: pos.id,
        category: pos.category,
        searchMode: pos.mode,
        deepTag: pos.deepTag,
        maxAdditionalDepth: null,
        action,
        samplesMs: samples.map((x) => Number(x.toFixed(2))),
        stats: summary(samples),
      });
    }
    client.terminate();
  }

  window.__benchResult = {
    userAgent: navigator.userAgent,
    positionsCount: positions.length,
    repeatsPerPosition: repeats,
    coldStarts,
    records,
  };
  window.__benchDone = true;
} catch (error) {
  window.__benchError = String(error?.stack || error);
}
</script>`;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__bench__') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
    return;
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const filePath = resolve(docsRoot, rel);
  if (filePath !== docsRoot && !filePath.startsWith(`${docsRoot}${sep}`)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404).end();
  }
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const serverPort = server.address().port;

const profileTag = `staged3ply-eval-${Date.now()}`;
const linuxProfile = isWindowsBrowser
  ? `/mnt/c/Windows/Temp/${profileTag}`
  : await mkdtemp(resolve(tmpdir(), 'staged3ply-eval-'));
const browserProfileArg = isWindowsBrowser
  ? `C:\\Windows\\Temp\\${profileTag}`
  : linuxProfile;

const browser = spawn(browserPath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=0',
  `--user-data-dir=${browserProfileArg}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderrBuf = '';
const portPromise = new Promise((resolvePort, rejectPort) => {
  const timer = setTimeout(() => rejectPort(new Error(`CDP port timeout: ${stderrBuf}`)), 15000);
  browser.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    const m = stderrBuf.match(/ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) {
      clearTimeout(timer);
      resolvePort(Number(m[1]));
    }
  });
});

let socket;
try {
  const cdpPort = await portPromise;
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const pageTarget = targets.find((t) => t.type === 'page');
  if (!pageTarget) throw new Error('Page target not found');

  socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((r, rej) => {
    socket.addEventListener('open', r, { once: true });
    socket.addEventListener('error', rej, { once: true });
  });

  let msgId = 0;
  const pending = new Map();
  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });

  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = ++msgId;
    const t = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`CDP timeout: ${method}`));
    }, 60000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(t); res(v); },
      reject: (e) => { clearTimeout(t); rej(e); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${serverPort}/__bench__` });

  let result = null;
  for (let i = 0; i < 3600; i += 1) {
    const ev = await cdp('Runtime.evaluate', {
      expression: '({ done: !!window.__benchDone, err: window.__benchError || null, prog: window.__benchProgress || null })',
      returnByValue: true,
    });
    const val = ev.result?.value;
    if (val?.err) throw new Error(val.err);
    if (val?.done) {
      const out = await cdp('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__benchResult)',
        returnByValue: true,
      });
      result = JSON.parse(out.result.value);
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!result) throw new Error('Browser benchmark timed out');

  // Aggregate summary by path, mode, searchMode, deepTag
  const allSamples = (filterFn) => result.records.filter(filterFn).flatMap((r) => r.samplesMs);
  const summarizeArr = (arr) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const pct = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
    return {
      samples: arr.length,
      meanMs: Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)),
      p50Ms: Number(pct(0.50).toFixed(2)),
      p95Ms: Number(pct(0.95).toFixed(2)),
      maxMs: Number(sorted.at(-1).toFixed(2)),
    };
  };

  const summary = {
    overall: {
      mainLegacy: summarizeArr(allSamples((r) => r.path === 'main-thread' && r.mode === 'legacy')),
      mainStaged: summarizeArr(allSamples((r) => r.path === 'main-thread' && r.mode === 'staged3ply')),
      workerLegacy: summarizeArr(allSamples((r) => r.path === 'worker' && r.mode === 'legacy')),
      workerStaged: summarizeArr(allSamples((r) => r.path === 'worker' && r.mode === 'staged3ply')),
    },
    byModeAndDepth: {
      moneyDeep: {
        mainLegacy: summarizeArr(allSamples((r) => r.path === 'main-thread' && r.mode === 'legacy' && r.searchMode === 'money' && r.deepTag === 'deep')),
        mainStaged: summarizeArr(allSamples((r) => r.path === 'main-thread' && r.mode === 'staged3ply' && r.searchMode === 'money' && r.deepTag === 'deep')),
        workerLegacy: summarizeArr(allSamples((r) => r.path === 'worker' && r.mode === 'legacy' && r.searchMode === 'money' && r.deepTag === 'deep')),
        workerStaged: summarizeArr(allSamples((r) => r.path === 'worker' && r.mode === 'staged3ply' && r.searchMode === 'money' && r.deepTag === 'deep')),
      },
      matchDeep: {
        mainLegacy: summarizeArr(allSamples((r) => r.path === 'main-thread' && r.mode === 'legacy' && r.searchMode === 'match' && r.deepTag === 'deep')),
        mainStaged: summarizeArr(allSamples((r) => r.path === 'main-thread' && r.mode === 'staged3ply' && r.searchMode === 'match' && r.deepTag === 'deep')),
        workerLegacy: summarizeArr(allSamples((r) => r.path === 'worker' && r.mode === 'legacy' && r.searchMode === 'match' && r.deepTag === 'deep')),
        workerStaged: summarizeArr(allSamples((r) => r.path === 'worker' && r.mode === 'staged3ply' && r.searchMode === 'match' && r.deepTag === 'deep')),
      },
      onePlyUnique: {
        mainLegacy: summarizeArr(allSamples((r) => r.path === 'main-thread' && r.mode === 'legacy' && r.deepTag === '1ply-unique')),
        mainStaged: summarizeArr(allSamples((r) => r.path === 'main-thread' && r.mode === 'staged3ply' && r.deepTag === '1ply-unique')),
        workerLegacy: summarizeArr(allSamples((r) => r.path === 'worker' && r.mode === 'legacy' && r.deepTag === '1ply-unique')),
        workerStaged: summarizeArr(allSamples((r) => r.path === 'worker' && r.mode === 'staged3ply' && r.deepTag === '1ply-unique')),
      },
    },
  };

  const out = { ...result, benchPositions, summary };
  const outPath = resolve(repoRoot, 'tests/backgammon/staged-3ply-browser-raw.json');
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ coldStarts: result.coldStarts, summary }, null, 2));
} finally {
  socket?.close();
  if (isWindowsBrowser && browser.pid) {
    await new Promise((r) => {
      const k = spawn('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' });
      k.once('exit', r);
      k.once('error', r);
    });
  } else {
    browser.kill();
  }
  await rm(linuxProfile, { recursive: true, force: true }).catch(() => {});
  await new Promise((r) => server.close(r));
}
