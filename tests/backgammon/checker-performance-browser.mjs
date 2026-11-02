// Edge/Chromeでchecker評価を測る任意ベンチ。Node標準APIのみを使用する。
//   node tests/backgammon/checker-performance-browser.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docsRoot = resolve(repoRoot, 'docs/backgammon');
const browserCandidates = process.platform === 'win32'
  ? [
    process.env.BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ]
  : [process.env.BROWSER_PATH, 'google-chrome', 'chromium', 'microsoft-edge'];
const browserPath = browserCandidates.find((candidate) => candidate
  && (candidate === process.env.BROWSER_PATH || existsSync(candidate)));
if (!browserPath) throw new Error('Edge/Chromeが見つかりません。BROWSER_PATHを指定してください');

const page = `<!doctype html>
<meta charset="utf-8">
<title>checker benchmark</title>
<script type="module">
import { Board, WHITE, BLACK } from '/src/board.js';
import { NeuralNet } from '/src/nn.js';
import { Agent, filtersFor } from '/src/agent.js';
import { generateMoves } from '/src/rules.js';
import { rankCheckerMoves } from '/src/checker.js';

const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
};
try {
  const model = await (await fetch('/src/model.json')).json();
  const net = new NeuralNet(model);
  const board = new Board();
  const player = WHITE;
  const moves = generateMoves(board, player, 3, 1);
  const scenarios = [
    {
      id: 'money-cubeful-jacoby',
      context: {
        cube: { value: 1, owner: 'center', enabled: true, available: true },
        match: { mode: 'money', jacoby: true },
      },
    },
    {
      id: 'match-mwc-cube-on-5pt-3-3',
      context: {
        cube: { value: 1, owner: 'center', enabled: true, available: true },
        match: {
          mode: 'match', targetPoints: 5, scoreWhite: 3, scoreBlack: 3,
          crawford: false, crawfordPlayed: false, jacoby: false,
        },
      },
    },
    {
      id: 'match-mwc-cube-off-5pt-3-3',
      context: {
        cube: { value: 1, owner: 'center', enabled: false, available: false },
        match: {
          mode: 'match', targetPoints: 5, scoreWhite: 3, scoreBlack: 3,
          crawford: false, crawfordPlayed: false, jacoby: false,
        },
      },
    },
  ];
  const results = [];
  for (const level of [
    { id: 'advanced', plies: 0 },
    { id: 'expert', plies: 2 },
    { id: 'champion', plies: 3 },
  ]) {
    const agent = new Agent(net, level.plies, filtersFor(level.plies), { bearoff: null });
    for (const scenario of scenarios) {
      rankCheckerMoves(agent, scenario.context, moves, player, 3); // warmup
      const times = [];
      for (let i = 0; i < 3; i += 1) {
        const start = performance.now();
        rankCheckerMoves(agent, scenario.context, moves, player, 3);
        times.push(performance.now() - start);
      }
      results.push({
        level: level.id,
        plies: level.plies,
        scenario: scenario.id,
        candidates: moves.length,
        wall_ms_p50: Number(percentile(times, 0.50).toFixed(2)),
        wall_ms_p95: Number(percentile(times, 0.95).toFixed(2)),
        samples: times.length,
      });
    }
  }
  const worker = new Worker('/src/worker.js', { type: 'module' });
  let nextWorkerId = 0;
  const pending = new Map();
  worker.onmessage = ({ data }) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.ok) entry.resolve(data);
    else entry.reject(new Error(data.error));
  };
  worker.onerror = (event) => {
    for (const entry of pending.values()) entry.reject(new Error(event.message));
    pending.clear();
  };
  const askWorker = (payload) => new Promise((resolveWorker, rejectWorker) => {
    const id = ++nextWorkerId;
    pending.set(id, { resolve: resolveWorker, reject: rejectWorker });
    worker.postMessage({ id, ...payload });
  });
  const workerStarted = performance.now();
  await askWorker({ kind: 'load', url: new URL('/src/model.json', location.href).href });
  const boardDto = {
    points: board.points,
    bar: [board.bar[WHITE], board.bar[BLACK]],
    off: [board.off[WHITE], board.off[BLACK]],
  };
  const workerResults = [];
  let uiTicksDuringWorker = 0;
  const uiTimer = setInterval(() => { uiTicksDuringWorker += 1; }, 10);
  for (const level of [
    { id: 'advanced', plies: 0 },
    { id: 'expert', plies: 2 },
    { id: 'champion', plies: 3 },
  ]) {
    for (const scenario of scenarios) {
      const common = {
        board: boardDto,
        player,
        die1: 3,
        die2: 1,
        level: level.id,
        context: scenario.context,
      };
      await askWorker({ kind: 'select', ...common }); // warmup
      const selectTimes = [];
      for (let i = 0; i < 3; i += 1) {
        const start = performance.now();
        await askWorker({ kind: 'select', ...common });
        selectTimes.push(performance.now() - start);
      }
      await askWorker({ kind: 'rank', ...common, limit: 3 }); // warmup
      const rankTimes = [];
      for (let i = 0; i < 3; i += 1) {
        const start = performance.now();
        await askWorker({ kind: 'rank', ...common, limit: 3 });
        rankTimes.push(performance.now() - start);
      }
      workerResults.push({
        level: level.id,
        plies: level.plies,
        scenario: scenario.id,
        candidates: moves.length,
        select_ms_p50: Number(percentile(selectTimes, 0.50).toFixed(2)),
        select_ms_p95: Number(percentile(selectTimes, 0.95).toFixed(2)),
        rank_ms_p50: Number(percentile(rankTimes, 0.50).toFixed(2)),
        rank_ms_p95: Number(percentile(rankTimes, 0.95).toFixed(2)),
        samples: selectTimes.length,
      });
    }
  }
  clearInterval(uiTimer);
  const workerWallMs = performance.now() - workerStarted;
  await worker.terminate();
  window.__benchResult = {
    runtime: navigator.userAgent,
    position: 'initial board, White 3-1',
    candidates: moves.length,
    warmup: 1,
    results,
    worker: {
      warmup: 1,
      results: workerResults,
      total_ms: Number(workerWallMs.toFixed(2)),
      ui_ticks_while_processing: uiTicksDuringWorker,
      ui_tick_interval_ms: 10,
    },
  };
} catch (error) {
  window.__benchError = String(error?.stack || error);
} finally {
  window.__benchDone = true;
}
</script>`;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/__bench__') {
      response.writeHead(200, { 'content-type': contentTypes['.html'] });
      response.end(page);
      return;
    }
    const filePath = resolve(docsRoot, `.${decodeURIComponent(pathname)}`);
    if (!filePath.startsWith(`${docsRoot}${sep}`)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    const data = await readFile(filePath);
    response.writeHead(200, {
      'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(data);
  } catch {
    response.writeHead(404).end('not found');
  }
});

const listen = (target) => new Promise((resolveListen, reject) => {
  target.once('error', reject);
  target.listen(0, '127.0.0.1', () => resolveListen(target.address().port));
});
const getJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response.json();
};
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const serverPort = await listen(server);
const profile = await mkdtemp(resolve(tmpdir(), 'checker-browser-bench-'));
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true });

let socket;
try {
  let activePort;
  for (let attempt = 0; attempt < 200 && !activePort; attempt += 1) {
    try {
      const contents = await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8');
      activePort = Number(contents.split(/\r?\n/)[0]);
    } catch {
      if (browser.exitCode !== null) throw new Error(`Browser exited: ${browser.exitCode}`);
      await delay(50);
    }
  }
  if (!activePort) throw new Error('DevToolsActivePortが作成されませんでした');

  let targets;
  for (let attempt = 0; attempt < 40 && !targets; attempt += 1) {
    try {
      targets = await getJson(`http://127.0.0.1:${activePort}/json/list`);
    } catch {
      await delay(50);
    }
  }
  const target = targets?.find((entry) => entry.type === 'page');
  if (!target) throw new Error('Browserのpage targetが見つかりません');

  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolveCommand, rejectCommand) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await command('Runtime.enable');
  await command('Page.enable');
  await command('Page.navigate', { url: `http://127.0.0.1:${serverPort}/__bench__` });
  let done = false;
  for (let attempt = 0; attempt < 1200 && !done; attempt += 1) {
    const state = await command('Runtime.evaluate', {
      expression: '({ done: window.__benchDone === true, error: window.__benchError || null })',
      returnByValue: true,
    });
    const value = state.result?.value;
    if (value?.error) throw new Error(value.error);
    done = Boolean(value?.done);
    if (!done) await delay(100);
  }
  if (!done) throw new Error('Browser performance benchmark timed out');
  const output = await command('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__benchResult)',
    returnByValue: true,
  });
  console.log(output.result.value);
} finally {
  socket?.close();
  const browserExited = browser.exitCode !== null
    ? Promise.resolve()
    : new Promise((resolveExit) => browser.once('exit', resolveExit));
  if (process.platform === 'win32' && browser.pid) {
    await new Promise((resolveKill) => {
      const killer = spawn('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      killer.once('error', resolveKill);
      killer.once('exit', resolveKill);
    });
  } else {
    browser.kill();
  }
  await Promise.race([browserExited, delay(5000)]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 19) throw error;
      await delay(100);
    }
  }
  await new Promise((resolveClose) => server.close(resolveClose));
}
