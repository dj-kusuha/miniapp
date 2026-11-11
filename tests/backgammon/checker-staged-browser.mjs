// Chromium benchmark: legacy vs staged, Worker vs main-thread fallback.
// Run with `node tests/backgammon/checker-staged-browser.mjs`.
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
  ? [process.env.BROWSER_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
  : [process.env.BROWSER_PATH, 'google-chrome', 'chromium', 'microsoft-edge'];
const browserPath = browserCandidates.find((candidate) => candidate
  && (candidate === process.env.BROWSER_PATH || existsSync(candidate)));
if (!browserPath) throw new Error('Chrome/Edgeが見つかりません。BROWSER_PATHを指定してください');

const page = `<!doctype html>
<meta charset="utf-8">
<title>staged 3-ply browser benchmark</title>
<script type="module">
import { Board, WHITE, BLACK } from '/src/board.js';
import { NeuralNet } from '/src/nn.js';
import { Agent, filtersFor } from '/src/agent.js';
import { generateMoves } from '/src/rules.js';
import { scoreCheckerMoves } from '/src/checker.js';
import { Game, ROLLING } from '/src/game.js';
import { MoneyBearoffDatabase } from '/src/money-bearoff.js';
import { setMoneyBearoffDatabase } from '/src/agent.js';

const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1,
    Math.ceil(sorted.length * fraction) - 1)];
  return {
    samples: values.length,
    averageMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
    p50Ms: Number(percentile(0.50).toFixed(2)),
    p95Ms: Number(percentile(0.95).toFixed(2)),
    maxMs: Number(sorted.at(-1).toFixed(2)),
  };
};
const threadMemory = async (type) =>
  (await fetch('/__thread-memory__?type=' + type)).json();

try {
  const model = await (await fetch('/src/model.json')).json();
  const net = new NeuralNet(model);
  const cubePoints = Array(24).fill(0);
  cubePoints[0] = 2; cubePoints[2] = 3; cubePoints[21] = -3; cubePoints[23] = -2;
  const cubeBoard = new Board(cubePoints,
    { [WHITE]: 0, [BLACK]: 0 }, { [WHITE]: 10, [BLACK]: 10 });
  const board = new Board();
  const player = WHITE;
  const die1 = 3; const die2 = 1;
  const moves = generateMoves(board, player, die1, die2);
  if (moves.length !== 16) throw new Error('checker fixture must have sixteen legal candidates');
  const cubeBoardDto = {
    points: cubeBoard.points, bar: [cubeBoard.bar[WHITE], cubeBoard.bar[BLACK]],
    off: [cubeBoard.off[WHITE], cubeBoard.off[BLACK]],
  };
  const scenarios = [
    {
      id: 'money-unbounded-jacoby',
      context: {
        cube: { value: 1, owner: 'center', enabled: true, available: true, unboundedMoney: true },
        match: { mode: 'money', jacoby: true },
      },
      workerCube: { cubeValue: 1, cubeOwner: null, jacoby: true, crawford: false, match: null },
    },
    {
      id: 'match-mwc-pre-crawford',
      context: {
        cube: { value: 1, owner: 'center', enabled: true, available: true, unboundedMoney: false },
        match: {
          mode: 'match', targetPoints: 5, scoreWhite: 3, scoreBlack: 3,
          crawford: false, crawfordPlayed: false,
        },
      },
      workerCube: null,
    },
  ];
  const scenarioBoards = {
    'money-unbounded-jacoby': cubeBoard,
    'match-mwc-pre-crawford': board,
  };
  const modes = ['legacy', 'staged3ply'];
  const measurements = [];
  const rootMemory = await threadMemory('page');
  await new Promise((resolve, reject) => {
    const smoke = new Worker('/__worker-smoke__.js', { type: 'module' });
    const timeout = setTimeout(() => reject(new Error('module Worker smoke timed out')), 3000);
    smoke.onmessage = ({ data }) => {
      clearTimeout(timeout);
      smoke.terminate();
      if (data !== 42) reject(new Error('module Worker smoke returned ' + data));
      else resolve();
    };
    smoke.onerror = (event) => {
      clearTimeout(timeout);
      reject(new Error('module Worker smoke failed: ' + JSON.stringify({
        message: event.message, filename: event.filename, lineno: event.lineno,
      })));
    };
    smoke.postMessage(41);
  });

  // Money DB is loaded in the Worker on the first eligible Money cube call.
  const moneyWorker = new Worker('/src/worker.js', { type: 'module' });
  let moneyId = 0;
  const moneyPending = new Map();
  moneyWorker.onmessage = ({ data }) => {
    const pending = moneyPending.get(data.id);
    if (!pending) return;
    moneyPending.delete(data.id);
    data.ok ? pending.resolve(data) : pending.reject(new Error(data.error));
  };
  moneyWorker.onerror = (event) => {
    const error = {
      type: event.type, message: event.message, filename: event.filename,
      lineno: event.lineno, colno: event.colno,
      error: event.error ? {
        name: event.error.name, message: event.error.message, stack: event.error.stack,
      } : null,
    };
    window.__workerError = error;
    const detail = JSON.stringify(error);
    for (const pending of moneyPending.values()) pending.reject(new Error(detail));
    moneyPending.clear();
  };
  const askMoney = (payload) => new Promise((resolve, reject) => {
    const id = ++moneyId;
    const timeout = setTimeout(() => {
      moneyPending.delete(id);
      reject(new Error('Money Worker ' + payload.kind + ' timed out after 120s'));
    }, 120_000);
    moneyPending.set(id, {
      resolve: (value) => { clearTimeout(timeout); resolve(value); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    moneyWorker.postMessage({ id, ...payload });
  });
  window.__benchProgress = 'Money Worker loading model';
  await askMoney({
    kind: 'load', url: new URL('/src/model.json', location.href).href,
    moneyBearoffUrl: new URL('/src/money-bg2n-6x6-v4.bin', location.href).href,
    checkerSearchMode: 'staged3ply',
  });
  window.__benchProgress = 'Money Worker model ready; loading BG2N cube fixture';
  const cubeStarted = performance.now();
  const cubeReply = await askMoney({
    kind: 'cube', ask: 'double', board: cubeBoardDto, player,
    ...scenarios[0].workerCube, level: 'champion',
  });
  const workerColdCubeMs = performance.now() - cubeStarted;
  window.__benchProgress = 'Money Worker BG2N cube fixture ready';
  const workerMoneyMemory = await threadMemory('worker');
  const mainMoneyLoadStarted = performance.now();
  let mainMoneyDb = await MoneyBearoffDatabase.load('/src/money-bg2n-6x6-v4.bin');
  const moneyDbBytes = mainMoneyDb.buffer.byteLength;
  setMoneyBearoffDatabase(mainMoneyDb);
  const mainMoneyLoadMs = performance.now() - mainMoneyLoadStarted;
  const game = new Game(cubeBoard, Math.random, { jacoby: true, unboundedMoneyCube: true });
  game.currentPlayer = player;
  game.state = ROLLING;
  const moneyAgent = new Agent(net, 3, filtersFor(3), { bearoff: null, checkerSearchMode: 'staged3ply' });
  const mainCubeAnswer = moneyAgent.shouldDouble(game, null);
  if (Boolean(cubeReply.answer) !== Boolean(mainCubeAnswer)) {
    throw new Error('Money BG2N Worker/main cube answer mismatch');
  }
  await moneyWorker.terminate();
  const mainCubeMemory = await threadMemory('page');
  setMoneyBearoffDatabase(null);
  mainMoneyDb = null;

  for (const scenario of scenarios) {
    const scenarioBoard = scenarioBoards[scenario.id];
    const scenarioMoves = generateMoves(scenarioBoard, player, die1, die2);
    const scenarioBoardDto = {
      points: scenarioBoard.points, bar: [scenarioBoard.bar[WHITE], scenarioBoard.bar[BLACK]],
      off: [scenarioBoard.off[WHITE], scenarioBoard.off[BLACK]],
    };
    for (const mode of modes) {
      let modeMoneyDb = null;
      if (scenario.context.match.mode === 'money') {
        modeMoneyDb = await MoneyBearoffDatabase.load('/src/money-bg2n-6x6-v4.bin');
        setMoneyBearoffDatabase(modeMoneyDb);
      }
      const agent = new Agent(net, 3, filtersFor(3), {
        bearoff: null,
        checkerSearchMode: mode,
      });
      const selectTimes = [];
      let mainIndex = -1;
      scoreCheckerMoves(agent, scenario.context, scenarioMoves, player); // warmup
      const sampleCount = 20;
      let mainScores = [];
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const started = performance.now();
        mainScores = scoreCheckerMoves(agent, scenario.context, scenarioMoves, player);
        mainIndex = mainScores[0].index;
        selectTimes.push(performance.now() - started);
      }
      const mainMemoryAfter = await threadMemory('page');
      const mainStats = { ...agent.checkerSearchStats, ...agent.checkerLastStagedSearch };
      let quality = null;
      if (mode === 'staged3ply' && scenario.context.match.mode === 'money') {
        const fullAgent = new Agent(net, 3, filtersFor(3), {
          bearoff: null,
          checkerSearchMode: 'full-root',
        });
        const fullRootScores = scoreCheckerMoves(
          fullAgent, scenario.context, scenarioMoves, player, 'full-root');
        const fullRootValues = new Map(fullRootScores.map(({ index, value }) => [index, value]));
        quality = {
          fullRootActionIndex: fullRootScores[0].index,
          stagedActionDiffersFromFullRoot: mainIndex !== fullRootScores[0].index,
          regret: Number((fullRootScores[0].value - fullRootValues.get(mainIndex)).toFixed(8)),
        };
      }
      if (modeMoneyDb) {
        setMoneyBearoffDatabase(null);
        modeMoneyDb = null;
      }

      const worker = new Worker('/src/worker.js', { type: 'module' });
      let nextId = 0;
      const pending = new Map();
      worker.onmessage = ({ data }) => {
        const entry = pending.get(data.id);
        if (!entry) return;
        pending.delete(data.id);
        data.ok ? entry.resolve(data) : entry.reject(new Error(data.error));
      };
      worker.onerror = (event) => {
        const error = {
          type: event.type, message: event.message, filename: event.filename,
          lineno: event.lineno, colno: event.colno,
          error: event.error ? {
            name: event.error.name, message: event.error.message, stack: event.error.stack,
          } : null,
        };
        window.__workerError = error;
        const detail = JSON.stringify(error);
        for (const entry of pending.values()) entry.reject(new Error(detail));
        pending.clear();
      };
      const ask = (payload) => new Promise((resolve, reject) => {
        const id = ++nextId;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(scenario.id + '/' + mode + ' Worker ' + payload.kind
            + ' timed out after 120s'));
        }, 120_000);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timeout); resolve(value); },
          reject: (error) => { clearTimeout(timeout); reject(error); },
        });
        worker.postMessage({ id, ...payload });
      });
      window.__benchProgress = scenario.id + '/' + mode + ' Worker loading model';
      await ask({
        kind: 'load', url: new URL('/src/model.json', location.href).href,
        moneyBearoffUrl: new URL('/src/money-bg2n-6x6-v4.bin', location.href).href,
        checkerSearchMode: mode,
      });
      window.__benchProgress = scenario.id + '/' + mode + ' Worker model ready';
      if (scenario.workerCube) {
        await ask({
          kind: 'cube', ask: 'double', board: cubeBoardDto, player,
          ...scenario.workerCube, level: 'champion',
        });
      }
      const workerMemoryBefore = await threadMemory('worker');
      await ask({ kind: 'select', board: scenarioBoardDto, player, die1, die2,
        level: 'champion', context: scenario.context }); // warmup
      const workerTimes = [];
      let workerIndex = -1;
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const started = performance.now();
        workerIndex = (await ask({ kind: 'select', board: scenarioBoardDto, player, die1, die2,
          level: 'champion', context: scenario.context })).index;
        workerTimes.push(performance.now() - started);
      }
      const workerMemoryAfter = await threadMemory('worker');
      await worker.terminate();
      if (workerIndex !== mainIndex) throw new Error(scenario.id + '/' + mode + ': Worker/main action mismatch');

      measurements.push({
        scenario: scenario.id,
        mode,
        candidates: scenarioMoves.length,
        actionIndex: workerIndex,
        quality,
        mainThread: summary(selectTimes),
        workerRoundTrip: summary(workerTimes),
        mainMemoryBefore: rootMemory,
        mainMemoryAfter: mainMemoryAfter,
        workerMemoryBefore: workerMemoryBefore,
        workerMemoryAfter: workerMemoryAfter,
        mainSearchStats: mainStats,
      });
      window.__benchProgress = scenario.id + '/' + mode + ' complete';
    }
  }
  window.__benchResult = {
    runtime: navigator.userAgent,
    crossOriginIsolated,
    position: 'Money White 3-1 on the five-checker BG2N root; Match White 3-1 on the initial board',
    memorySource: 'CDP Runtime.getHeapUsage after HeapProfiler.collectGarbage',
    bg2n: {
      bytes: moneyDbBytes,
      workerColdCubeResponseMs: Number(workerColdCubeMs.toFixed(2)),
      mainColdLoadMs: Number(mainMoneyLoadMs.toFixed(2)),
      workerMemoryAfterCube: workerMoneyMemory,
      mainMemoryAfterCube: mainCubeMemory,
      cubeAnswer: Boolean(mainCubeAnswer),
    },
    measurements,
  };
} catch (error) {
  window.__benchError = JSON.stringify({
    message: String(error?.stack || error), worker: window.__workerError ?? null,
  });
} finally {
  window.__benchDone = true;
}
</script>`;

const contentTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
};
const requestLog = [];
const workerSessions = new Map();
let pageCommand = async () => { throw new Error('Page CDP is not ready'); };
let readThreadHeap = async () => ({ source: 'CDP unavailable', bytes: null });
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    response.once('finish', () => requestLog.push([pathname, response.statusCode]));
    if (pathname === '/__worker-smoke__.js') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cross-origin-resource-policy': 'same-origin',
      });
      response.end('self.onmessage = ({ data }) => self.postMessage(data + 1);');
      return;
    }
    if (pathname === '/__thread-memory__') {
      const type = new URL(request.url, 'http://127.0.0.1').searchParams.get('type');
      let snapshot;
      try { snapshot = await readThreadHeap(type); }
      catch (error) {
        snapshot = { source: 'CDP error', detail: String(error), bytes: null };
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(snapshot));
      return;
    }
    if (pathname === '/__bench__') {
      response.writeHead(200, {
        'content-type': contentTypes['.html'],
        'cross-origin-opener-policy': 'same-origin',
      });
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
      'cross-origin-resource-policy': 'same-origin',
    });
    response.end(data);
  } catch {
    if (!response.headersSent) response.writeHead(500);
    response.end('benchmark request failed');
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
const profile = await mkdtemp(resolve(tmpdir(), 'checker-staged-browser-'));
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--enable-precise-memory-info', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

let socket;
try {
  let activePort;
  for (let attempt = 0; attempt < 200 && !activePort; attempt += 1) {
    try {
      activePort = Number((await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8'))
        .split(/\r?\n/)[0]);
    } catch {
      if (browser.exitCode !== null) throw new Error(`Browser exited: ${browser.exitCode}`);
      await delay(50);
    }
  }
  if (!activePort) throw new Error('DevToolsActivePortが作成されませんでした');
  readThreadHeap = async (type) => {
    if (type === 'worker') {
      const session = [...workerSessions.values()].at(-1);
      if (!session) return { source: 'CDP worker session unavailable', bytes: null };
      await session.ready;
      await pageCommand('HeapProfiler.enable', {}, session.sessionId);
      await pageCommand('HeapProfiler.collectGarbage', {}, session.sessionId);
      const heap = await pageCommand('Runtime.getHeapUsage', {}, session.sessionId);
      return {
        source: 'CDP Runtime.getHeapUsage',
        bytes: heap.usedSize,
        totalBytes: heap.totalSize,
        embedderHeapBytes: heap.embedderHeapUsedSize ?? null,
        backingStorageBytes: heap.backingStorageSize ?? null,
      };
    }
    const targets = await getJson(`http://127.0.0.1:${activePort}/json/list`);
    const target = targets.find((entry) => entry.type === 'page'
      && entry.url.endsWith('/__bench__'));
    if (!target) return {
      source: `CDP ${type} target unavailable`, bytes: null,
    };
    const targetSocket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      targetSocket.addEventListener('open', resolveOpen, { once: true });
      targetSocket.addEventListener('error', rejectOpen, { once: true });
    });
    let commandId = 0;
    const pending = new Map();
    targetSocket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    const command = (method) => new Promise((resolveCommand, rejectCommand) => {
      const id = ++commandId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectCommand(new Error('CDP target command timed out: ' + method));
      }, 5000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolveCommand(value); },
        reject: (error) => { clearTimeout(timeout); rejectCommand(error); },
      });
      targetSocket.send(JSON.stringify({ id, method }));
    });
    try {
      await command('Runtime.enable');
      await command('HeapProfiler.enable');
      await command('HeapProfiler.collectGarbage');
      const heap = await command('Runtime.getHeapUsage');
      return {
        source: 'CDP Runtime.getHeapUsage',
        bytes: heap.usedSize,
        totalBytes: heap.totalSize,
        embedderHeapBytes: heap.embedderHeapUsedSize ?? null,
        backingStorageBytes: heap.backingStorageSize ?? null,
      };
    } finally {
      targetSocket.close();
    }
  };
  let targets;
  for (let attempt = 0; attempt < 40 && !targets; attempt += 1) {
    try { targets = await getJson(`http://127.0.0.1:${activePort}/json/list`); }
    catch { await delay(50); }
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
    if (message.method === 'Target.attachedToTarget'
        && message.params.targetInfo.type === 'worker') {
      const { sessionId, targetInfo } = message.params;
      const session = { sessionId, targetInfo, ready: null };
      workerSessions.set(targetInfo.targetId, session);
      session.ready = pageCommand('Runtime.enable', {}, sessionId);
    } else if (message.method === 'Target.detachedFromTarget') {
      for (const [targetId, session] of workerSessions) {
        if (session.sessionId === message.params.sessionId) workerSessions.delete(targetId);
      }
    }
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  pageCommand = (method, params = {}, sessionId = undefined) =>
    new Promise((resolveCommand, rejectCommand) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectCommand(new Error('Page CDP command timed out: ' + method));
      }, 5000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolveCommand(value); },
        reject: (error) => { clearTimeout(timeout); rejectCommand(error); },
      });
      socket.send(JSON.stringify({ id, method, params,
        ...(sessionId ? { sessionId } : {}),
      }));
    });
  const command = pageCommand;
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Target.setDiscoverTargets', { discover: true });
  await command('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: 'worker', exclude: false }, { exclude: true }],
  });
  await command('Page.navigate', { url: `http://127.0.0.1:${serverPort}/__bench__` });
  let done = false;
  for (let attempt = 0; attempt < 2400 && !done; attempt += 1) {
    const state = await command('Runtime.evaluate', {
      expression: '({ done: window.__benchDone === true, error: window.__benchError || null, progress: window.__benchProgress || null })',
      returnByValue: true,
    });
    const value = state.result?.value;
    if (value?.error) {
      throw new Error(value.error + ' requests=' + JSON.stringify(requestLog));
    }
    done = Boolean(value?.done);
    if (!done) await delay(100);
  }
  if (!done) {
    const progress = await command('Runtime.evaluate', {
      expression: 'window.__benchProgress || null', returnByValue: true,
    });
    throw new Error(`Browser staged 3-ply benchmark timed out at ${progress.result.value}`);
  }
  const output = await command('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__benchResult)', returnByValue: true,
  });
  console.log(output.result.value);
} finally {
  socket?.close();
  const browserExited = browser.exitCode !== null
    ? Promise.resolve() : new Promise((resolveExit) => browser.once('exit', resolveExit));
  if (process.platform === 'win32' && browser.pid) {
    await new Promise((resolveKill) => {
      const killer = spawn('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      killer.once('error', resolveKill);
      killer.once('exit', resolveKill);
    });
  } else browser.kill();
  await Promise.race([browserExited, delay(5000)]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await rm(profile, { recursive: true, force: true }); break; }
    catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 19) throw error;
      await delay(100);
    }
  }
  await new Promise((resolveClose) => server.close(resolveClose));
}
