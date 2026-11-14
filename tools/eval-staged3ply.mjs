// Node.js 評価スクリプト: Legacy / staged3ply / Full-root 3-ply の品質・regret・段階統計を計測する（Issue #549）。
// 実行: node tools/eval-staged3ply.mjs
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import {
  Agent, filtersFor, setBearoffDatabase, setMoneyBearoffDatabase,
} from '../docs/backgammon/src/agent.js';
import { Board, WHITE, BLACK } from '../docs/backgammon/src/board.js';
import { BearoffDatabase } from '../docs/backgammon/src/bearoff.js';
import { MoneyBearoffDatabase } from '../docs/backgammon/src/money-bearoff.js';
import { NeuralNet } from '../docs/backgammon/src/nn.js';
import { Game } from '../docs/backgammon/src/game.js';
import { generateMoves, boardKey } from '../docs/backgammon/src/rules.js';
import { scoreCheckerMoves, selectCheckerMove } from '../docs/backgammon/src/checker.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function loadRuntime() {
  const modelPath = resolve(repoRoot, 'docs/backgammon/src/model.json');
  const bearoffPath = resolve(repoRoot, 'docs/backgammon/src/bearoff-6x15.bin');
  const moneyBg2nPath = resolve(repoRoot, 'docs/backgammon/src/money-bg2n-6x6-v4.bin');

  const modelBytes = readFileSync(modelPath);
  const bearoffBytes = readFileSync(bearoffPath);
  const moneyBg2nBytes = readFileSync(moneyBg2nPath);

  const model = JSON.parse(modelBytes.toString('utf8'));
  const net = new NeuralNet(model);
  const bearoffDb = new BearoffDatabase(
    bearoffBytes.buffer.slice(bearoffBytes.byteOffset, bearoffBytes.byteOffset + bearoffBytes.byteLength));
  const moneyBearoffDb = await MoneyBearoffDatabase.fromArrayBuffer(
    moneyBg2nBytes.buffer.slice(moneyBg2nBytes.byteOffset, moneyBg2nBytes.byteOffset + moneyBg2nBytes.byteLength),
    webcrypto);

  setBearoffDatabase(bearoffDb);
  setMoneyBearoffDatabase(moneyBearoffDb);

  const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
  return {
    net,
    shas: {
      modelJson: sha256(modelBytes),
      bearoff6x15: sha256(bearoffBytes),
      moneyBg2nV4: sha256(moneyBg2nBytes),
      checkerJs: sha256(readFileSync(resolve(repoRoot, 'docs/backgammon/src/checker.js'))),
      agentJs: sha256(readFileSync(resolve(repoRoot, 'docs/backgammon/src/agent.js'))),
      nnJs: sha256(readFileSync(resolve(repoRoot, 'docs/backgammon/src/nn.js'))),
    },
  };
}

if (!isMainThread) {
  const { net } = await loadRuntime();
  const agent = new Agent(net, 3, filtersFor(3), {
    checkerSearchMode: 'full-root',
  });
  parentPort.on('message', (task) => {
    try {
      const board = Board.fromJson(task.board);
      const moves = generateMoves(board, task.player, task.die1, task.die2);
      const t0 = performance.now();
      const scored = scoreCheckerMoves(agent, task.context, moves, task.player, 'full-root');
      const elapsedMs = performance.now() - t0;
      parentPort.postMessage({
        id: task.id,
        ok: true,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        bestIndex: scored[0].index,
        bestValue: scored[0].value,
        valuesByIndex: scored.map(({ index, value }) => [index, value]),
      });
    } catch (error) {
      parentPort.postMessage({ id: task.id, ok: false, error: String(error) });
    }
  });
  // Keep alive until parent terminates
} else {
  const { net, shas } = await loadRuntime();
  const fixturePath = resolve(repoRoot, 'tests/backgammon/staged-3ply-eval-fixtures.json');
  const fixtureBytes = readFileSync(fixturePath);
  const fixtures = JSON.parse(fixtureBytes.toString('utf8'));
  shas.fixturesJson = createHash('sha256').update(fixtureBytes).digest('hex');

  const agentLegacy = new Agent(net, 3, filtersFor(3), { checkerSearchMode: 'legacy' });
  const agentStaged = new Agent(net, 3, filtersFor(3), { checkerSearchMode: 'staged3ply' });

  // Warm-up on first fixture
  {
    const f0 = fixtures.positions[0];
    const b0 = Board.fromJson(f0.board);
    const m0 = generateMoves(b0, f0.player, f0.die1, f0.die2);
    scoreCheckerMoves(agentLegacy, f0.context, m0, f0.player, 'legacy');
    scoreCheckerMoves(agentStaged, f0.context, m0, f0.player, 'staged3ply');
  }

  console.error(`Phase A: Evaluating ${fixtures.positions.length} fixtures (Legacy & staged3ply)...`);
  const results = [];
  for (const pos of fixtures.positions) {
    const board = Board.fromJson(pos.board);
    const moves = generateMoves(board, pos.player, pos.die1, pos.die2);

    const tL0 = performance.now();
    const legacyScored = scoreCheckerMoves(agentLegacy, pos.context, moves, pos.player, 'legacy');
    const legacyMs = performance.now() - tL0;

    const tS0 = performance.now();
    const stagedScored = scoreCheckerMoves(agentStaged, pos.context, moves, pos.player, 'staged3ply');
    const stagedMs = performance.now() - tS0;

    const stage = agentStaged.checkerLastStagedSearch
      ? { ...agentStaged.checkerLastStagedSearch }
      : {
        unit: pos.context.match.mode === 'match' ? 'mwc' : 'equity',
        onePlyCandidates: moves.length,
        twoPlyCandidates: moves.length,
        threePlyCandidates: moves.length,
        maxAdditionalDepth: pos.context.cube.enabled ? 2 : 2,
        bypassedStaged: true,
      };
    const reuse = agentStaged.checkerSearchStats ? { ...agentStaged.checkerSearchStats } : null;

    results.push({
      id: pos.id,
      category: pos.category,
      stratum: pos.stratum,
      mode: pos.context.match.mode,
      cubeEnabled: pos.context.cube.enabled,
      crawford: Boolean(pos.context.match.crawford),
      legalMovesCount: moves.length,
      legacyAction: legacyScored[0].index,
      legacyBestValue: legacyScored[0].value,
      legacyMs: Number(legacyMs.toFixed(2)),
      stagedAction: stagedScored[0].index,
      stagedBestValue: stagedScored[0].value,
      stagedBestStage: stagedScored[0].searchStage ?? null,
      stagedMs: Number(stagedMs.toFixed(2)),
      legacyStagedMatch: legacyScored[0].index === stagedScored[0].index,
      stage,
      reuse,
      fullRoot: null,
    });
  }

  // Select representative subset (60 positions) for Full-root 3-ply reference:
  // Prioritize positions where staged3ply reached Stage 2 or Stage 3, plus Stage-1-only samples,
  // balanced across categories and Money/Match.
  const fullRootSubset = [];
  const subsetIds = new Set();
  const byCat = new Map();
  for (const r of results) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r);
  }
  const perCatTarget = 8;
  for (const [, list] of byCat) {
    const deep = list.filter((r) => !r.stage.bypassedStaged && r.stage.maxAdditionalDepth >= 1);
    const shallow = list.filter((r) => r.stage.bypassedStaged || r.stage.maxAdditionalDepth === 0);
    // Pick up to 6 deep (preferring Stage 3 and diverse Money/Match) + 2 shallow
    deep.sort((a, b) => (b.stage.maxAdditionalDepth - a.stage.maxAdditionalDepth)
      || (a.legalMovesCount - b.legalMovesCount));
    const deepPicks = [];
    const moneyDeep = deep.filter((r) => r.mode === 'money');
    const matchDeep = deep.filter((r) => r.mode === 'match');
    for (let i = 0; i < 3; i += 1) {
      if (moneyDeep[i]) deepPicks.push(moneyDeep[i]);
      if (matchDeep[i]) deepPicks.push(matchDeep[i]);
    }
    for (const r of deep) {
      if (deepPicks.length >= 6) break;
      if (!deepPicks.includes(r)) deepPicks.push(r);
    }
    for (const r of [...deepPicks, ...shallow.slice(0, Math.max(0, perCatTarget - deepPicks.length))]) {
      if (!subsetIds.has(r.id)) {
        subsetIds.add(r.id);
        fullRootSubset.push(r.id);
      }
    }
  }
  // Also include any positions where Legacy and staged3ply disagreed (up to 60 total)
  for (const r of results) {
    if (fullRootSubset.length >= 60) break;
    if (!r.legacyStagedMatch && !subsetIds.has(r.id)) {
      subsetIds.add(r.id);
      fullRootSubset.push(r.id);
    }
  }
  for (const r of results) {
    if (fullRootSubset.length >= 60) break;
    if (!subsetIds.has(r.id)) {
      subsetIds.add(r.id);
      fullRootSubset.push(r.id);
    }
  }

  console.error(`Phase B: Running Full-root 3-ply on ${fullRootSubset.length} representative fixtures using worker_threads...`);
  const posById = new Map(fixtures.positions.map((p) => [p.id, p]));
  const resById = new Map(results.map((r) => [r.id, r]));

  const workerCount = Math.min(10, Math.max(2, cpus().length - 2), fullRootSubset.length);
  const queue = [...fullRootSubset];
  const workers = Array.from({ length: workerCount }, () => new Worker(fileURLToPath(import.meta.url)));

  let completed = 0;
  const phaseBStart = performance.now();
  await Promise.all(workers.map((w) => new Promise((resolveWorker, rejectWorker) => {
    const nextTask = () => {
      const id = queue.shift();
      if (!id) {
        w.terminate().then(resolveWorker, resolveWorker);
        return;
      }
      const pos = posById.get(id);
      w.postMessage({ id, board: pos.board, player: pos.player, die1: pos.die1, die2: pos.die2, context: pos.context });
    };
    w.on('message', (msg) => {
      if (!msg.ok) {
        rejectWorker(new Error(`Worker failed on ${msg.id}: ${msg.error}`));
        return;
      }
      const res = resById.get(msg.id);
      const valMap = new Map(msg.valuesByIndex);
      const stagedValInFull = valMap.get(res.stagedAction);
      const legacyValInFull = valMap.get(res.legacyAction);
      res.fullRoot = {
        elapsedMs: msg.elapsedMs,
        action: msg.bestIndex,
        bestValue: msg.bestValue,
        stagedActionMatch: res.stagedAction === msg.bestIndex,
        legacyActionMatch: res.legacyAction === msg.bestIndex,
        stagedRegret: Number((msg.bestValue - stagedValInFull).toFixed(8)),
        legacyRegret: Number((msg.bestValue - legacyValInFull).toFixed(8)),
        stagedValueInFullRoot: stagedValInFull,
        legacyValueInFullRoot: legacyValInFull,
      };
      completed += 1;
      if (completed % 10 === 0 || completed === fullRootSubset.length) {
        console.error(`  Full-root progress: ${completed}/${fullRootSubset.length} (${((performance.now() - phaseBStart) / 1000).toFixed(1)}s)`);
      }
      nextTask();
    });
    w.on('error', rejectWorker);
    nextTask();
  })));

  // Phase C: Representative Cube Positions
  console.error(`Phase C: Evaluating ${fixtures.cubePositions.length} representative cube positions...`);
  const cubeResults = [];
  for (const cp of fixtures.cubePositions) {
    const board = Board.fromJson(cp.board);
    const game = new Game(board, () => 0.5, {
      jacoby: cp.mode === 'money' ? cp.jacoby : false,
      crawford: cp.mode === 'match' ? cp.crawford : false,
    });
    game.currentPlayer = cp.player;
    game.cube.value = cp.cubeValue;
    game.cube.owner = cp.cubeOwner === 'center' ? null : cp.cubeOwner;
    const matchObj = cp.mode === 'match' ? {
      length: 7,
      away: { [WHITE]: cp.awayWhite, [BLACK]: cp.awayBlack },
      crawfordPlayed: cp.crawfordPlayed,
      proposer: cp.player,
    } : null;

    const legacyDouble = game.canDouble() ? agentLegacy.shouldDouble(game, matchObj) : null;
    const stagedDouble = game.canDouble() ? agentStaged.shouldDouble(game, matchObj) : null;
    game.doublingProposer = cp.player;
    const legacyTake = agentLegacy.shouldAcceptDouble(game, matchObj);
    const stagedTake = agentStaged.shouldAcceptDouble(game, matchObj);

    const moves = generateMoves(board, cp.player, cp.die1, cp.die2);
    const legacyChecker = scoreCheckerMoves(agentLegacy, cp.context, moves, cp.player, 'legacy');
    const stagedChecker = scoreCheckerMoves(agentStaged, cp.context, moves, cp.player, 'staged3ply');

    cubeResults.push({
      id: cp.id,
      mode: cp.mode,
      cubeValue: cp.cubeValue,
      cubeOwner: cp.cubeOwner,
      expectedEngineShouldDouble: cp.expectedEngineShouldDouble,
      expectedEngineShouldAcceptDouble: cp.expectedEngineShouldAcceptDouble,
      legacyShouldDouble: legacyDouble,
      stagedShouldDouble: stagedDouble,
      legacyShouldTake: legacyTake,
      stagedShouldTake: stagedTake,
      cubeDecisionDiffers: legacyDouble !== stagedDouble || legacyTake !== stagedTake,
      legacyCheckerAction: legacyChecker[0].index,
      stagedCheckerAction: stagedChecker[0].index,
      checkerActionDiffers: legacyChecker[0].index !== stagedChecker[0].index,
      legacyCheckerValue: Number(legacyChecker[0].value.toFixed(6)),
      stagedCheckerValue: Number(stagedChecker[0].value.toFixed(6)),
      checkerValueDiff: Number((stagedChecker[0].value - legacyChecker[0].value).toFixed(6)),
      stagedStage: agentStaged.checkerLastStagedSearch,
    });
  }

  // Compute summary statistics
  const percentile = (arr, q) => {
    if (arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
  };
  const summarizeRegret = (items) => {
    const regrets = items.map((r) => r.fullRoot.stagedRegret);
    const legRegrets = items.map((r) => r.fullRoot.legacyRegret);
    return {
      count: items.length,
      stagedVsFullMatchRate: Number((items.filter((r) => r.fullRoot.stagedActionMatch).length / Math.max(1, items.length)).toFixed(4)),
      legacyVsFullMatchRate: Number((items.filter((r) => r.fullRoot.legacyActionMatch).length / Math.max(1, items.length)).toFixed(4)),
      stagedRegret: {
        median: percentile(regrets, 0.5),
        p90: percentile(regrets, 0.9),
        p95: percentile(regrets, 0.95),
        max: regrets.length ? Math.max(...regrets) : null,
        mean: regrets.length ? Number((regrets.reduce((a, b) => a + b, 0) / regrets.length).toFixed(8)) : null,
      },
      legacyRegret: {
        median: percentile(legRegrets, 0.5),
        p90: percentile(legRegrets, 0.9),
        p95: percentile(legRegrets, 0.95),
        max: legRegrets.length ? Math.max(...legRegrets) : null,
        mean: legRegrets.length ? Number((legRegrets.reduce((a, b) => a + b, 0) / legRegrets.length).toFixed(8)) : null,
      },
    };
  };

  const fullItems = results.filter((r) => r.fullRoot !== null);
  const stagedApplicable = results.filter((r) => !r.stage.bypassedStaged);
  const summary = {
    totalFixtures: results.length,
    legacyVsStagedMatchRate: Number((results.filter((r) => r.legacyStagedMatch).length / results.length).toFixed(4)),
    stagedApplicableCount: stagedApplicable.length,
    stageReachCounts: {
      stage1Only: stagedApplicable.filter((r) => r.stage.maxAdditionalDepth === 0).length,
      stage2Reached: stagedApplicable.filter((r) => r.stage.maxAdditionalDepth >= 1).length,
      stage2Stopped: stagedApplicable.filter((r) => r.stage.maxAdditionalDepth === 1).length,
      stage3Reached: stagedApplicable.filter((r) => r.stage.maxAdditionalDepth === 2).length,
    },
    candidateReductionMean: {
      onePly: Number((stagedApplicable.reduce((s, r) => s + r.stage.onePlyCandidates, 0) / stagedApplicable.length).toFixed(2)),
      twoPly: Number((stagedApplicable.reduce((s, r) => s + r.stage.twoPlyCandidates, 0) / stagedApplicable.length).toFixed(2)),
      threePly: Number((stagedApplicable.reduce((s, r) => s + r.stage.threePlyCandidates, 0) / stagedApplicable.length).toFixed(2)),
    },
    fullRootEvaluatedCount: fullItems.length,
    moneyFullRoot: summarizeRegret(fullItems.filter((r) => r.mode === 'money')),
    matchFullRoot: summarizeRegret(fullItems.filter((r) => r.mode === 'match')),
    cubeSummary: {
      total: cubeResults.length,
      cubeDecisionDiffs: cubeResults.filter((c) => c.cubeDecisionDiffers).length,
      checkerActionDiffs: cubeResults.filter((c) => c.checkerActionDiffers).length,
    },
  };

  const output = {
    metadata: {
      evaluatedAt: new Date().toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cpuCores: cpus().length,
      shas,
    },
    summary,
    results,
    cubeResults,
  };

  const outPath = resolve(repoRoot, 'tests/backgammon/staged-3ply-eval-raw.json');
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}
