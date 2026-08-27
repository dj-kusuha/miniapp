// 段の強さを gnubg に採点させる。
//
//   node tools/measure-level.mjs <level|noise=σ,maxLoss=N> [--games 30] [--seed 1]
//
// **σ を勘で決めないための道具。** 手順は:
//
//   1. その設定同士で自己対局する
//   2. 今日の `.mat` 書き出しでマネーゲームの棋譜にする
//   3. docker の gnubg に読ませて `analyse match` → ER（1 手あたりの損失）
//
// gnubg の技量帯（backgammon_engine の docs/gnubg.md）:
//
//   〜2.0 World class / 〜4.0 Expert / 〜8.0 Advanced
//   〜15.0 Intermediate / 〜25.0 Casual player / 25〜 Beginner
//
// **docker が要る**（`docker build -t backgammon-gnubg -f docker/gnubg.Dockerfile docker`
// を backgammon_engine 側で実行しておく）。CI では回さない。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const src = (name) => new URL(`../docs/backgammon/src/${name}`, import.meta.url).href;
const { NeuralNet } = await import(src('nn.js'));
const { Agent, filtersFor, levelById } = await import(src('agent.js'));
const { GAME_OVER, ROLLING } = await import(src('game.js'));
const { Match, MONEY } = await import(src('match.js'));
const { toMat } = await import(src('mat.js'));
const { WHITE } = await import(src('board.js'));

const args = process.argv.slice(2);
const spec = args[0] ?? 'mid';
const opt = (name, def) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : def;
};
const games = opt('games', 30);
const seed0 = opt('seed', 1);
//: --cube を付けるとキューブありで対局し、gnubg のキューブ解析も入れる。
//: **ジャコビーあり・ビーバー無し**（engine 側にビーバーの実装が無い）。
const useCube = args.includes('--cube');

/** `intro` のような段名でも `noise=0.1,maxLoss=0.4` でも受ける。 */
function settingsFor(text) {
  if (text.includes('=')) {
    const out = { noise: 0, maxLoss: Infinity, plies: 0 };
    for (const part of text.split(',')) {
      const [k, v] = part.split('=');
      out[k.trim()] = Number(v);
    }
    return { id: text, ...out };
  }
  return levelById(text);
}

const level = settingsFor(spec);
const modelPath = new URL('../docs/backgammon/src/model.json', import.meta.url);
const net = new NeuralNet(JSON.parse(readFileSync(modelPath)));
const agent = new Agent(net, level.plies, filtersFor(level.plies), {
  noise: level.noise, maxLoss: level.maxLoss,
});

function seeded(s0) {
  let s = s0 >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// **既定ではキューブを切って測る。** ER は着手の損失を見るための指標で、
// キューブが入ると局が早く終わって手数が減り、比較しづらくなる。
// `--cube` を付けると実戦に近い形（ジャコビーあり）で測る。
const rng = seeded(seed0 * 7919 + 13);
const match = new Match({ length: MONEY, jacoby: useCube, useCube, rng });
let plies = 0;
for (let i = 0; i < games; i += 1) {
  const game = match.startGame();
  let steps = 0;
  while (game.state !== GAME_OVER && steps < 4000) {
    steps += 1;
    // **ロール前にダブルを検討する。** マネーゲームなので cubeContext() は
    // null を返し、ジャコビー込みのマネーの経路が使われる。
    // **ビーバーは engine 側に実装が無いので出さない。**
    if (useCube && game.state === ROLLING && game.canDouble()
        && agent.shouldDouble(game, match.cubeContext())) {
      game.proposeDouble();
      if (agent.shouldAcceptDouble(game, match.cubeContext())) game.acceptDouble();
      else { game.declineDouble(); break; }
      continue;
    }
    if (game.legalMoves.length === 0) { game.rollDice(); continue; }
    game.applyMove(agent.selectMove(game.legalMoves, game.currentPlayer));
    plies += 1;
  }
  match.sync();
}

const dir = mkdtempSync(join(tmpdir(), 'bg-er-'));
const matPath = join(dir, 'games.mat');
writeFileSync(matPath, toMat({ games: match.matGames(), length: MONEY, humanSide: WHITE }));

const script = [
  'set sound enable off',
  'set sound system none',
  'set automatic game off',
  // **着手だけを見る。** キューブ解析は既定で切る（棋譜にキューブが無いので無意味）。
  // --cube のときは入れる。**ジャコビーあり・ビーバー無し**で engine と揃える。
  ...(useCube
    ? ['set analysis cube on', 'set jacoby on', 'set beavers 0']
    : ['set analysis cube off']),
  'set analysis chequerplay on',
  'set analysis moves on',
  'set analysis chequer eval plies 2',
  'import mat /work/games.mat',
  'analyse match',
  'show statistics match',
  'quit',
].join('\n');

const out = execFileSync('docker',
  ['run', '--rm', '-i', '-v', `${dir}:/work`, 'backgammon-gnubg', 'gnubg', '-t', '-q'],
  { input: `${script}\n`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'] });

/**
 * `Chequerplay statistics` の節から ER と gnubg 自身の技量判定を拾う。
 *
 * 出力はこの形（値は既に mEMG で、損失なので負で出る）:
 *
 *   Error rate mEMG (Points)     -10.1   ( -0.010)   -15.0   ( -0.015)
 *   Chequerplay rating           Advanced            Intermediate
 */
function chequerStats(text) {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => l.includes('Chequerplay statistics'));
  if (from < 0) return null;
  const cell = (line) => line.trim().split(/\s{2,}/);
  let er = null;
  let rating = null;
  let unforced = null;
  for (const line of lines.slice(from, from + 20)) {
    if (er === null && line.trim().startsWith('Error rate mEMG')) {
      const m = [...line.matchAll(/(-?\d+\.\d+)\s+\(/g)].map((x) => Number(x[1]));
      if (m.length >= 2) er = [Math.abs(m[0]), Math.abs(m[1])];
    }
    if (rating === null && line.trim().startsWith('Chequerplay rating')) {
      const parts = cell(line);
      if (parts.length >= 3) rating = [parts[1], parts[2]];
    }
    if (unforced === null && line.trim().startsWith('Unforced moves')) {
      const parts = cell(line);
      if (parts.length >= 3) unforced = [Number(parts[1]), Number(parts[2])];
    }
  }
  return er ? { er, rating, unforced } : null;
}

/**
 * 任意の節から「Error rate mEMG」と rating を拾う（キューブ / 全体用）。
 *
 * gnubg は `Cube statistics` に `Error rate mEMG` と `Cube decision rating`、
 * `Overall statistics` に `Error rate mEMG` と `Overall rating` を出す。
 */
function sectionStats(text, heading, ratingLabel) {
  const lines = text.split('\n');
  const from = lines.findIndex((l) => l.includes(heading));
  if (from < 0) return null;
  const cell = (line) => line.trim().split(/\s{2,}/);
  let er = null;
  let rating = null;
  for (const line of lines.slice(from, from + 24)) {
    if (er === null && line.trim().startsWith('Error rate mEMG')) {
      const m = [...line.matchAll(/(-?\d+\.\d+)\s+\(/g)].map((x) => Number(x[1]));
      if (m.length >= 2) er = [Math.abs(m[0]), Math.abs(m[1])];
    }
    if (rating === null && line.trim().startsWith(ratingLabel)) {
      const parts = cell(line);
      if (parts.length >= 3) rating = [parts[1], parts[2]];
    }
  }
  return er ? { er, rating } : null;
}

const stats = chequerStats(out);
console.log(`段 ${level.id}: noise=${level.noise} maxLoss=${level.maxLoss} plies=${level.plies}`);
console.log(`  ${games} 局 / ${plies} 手`);
if (!stats) {
  console.log('  ER を読み取れませんでした。gnubg の出力（抜粋）:');
  console.log(out.split('\n').filter((l) => /error rate|Chequer|Unforced/i.test(l))
    .slice(0, 12).join('\n'));
  process.exitCode = 1;
} else {
  const [a, b] = stats.er;
  const mean = (a + b) / 2;
  const [ra, rb] = stats.rating ?? ['?', '?'];
  if (stats.unforced) console.log(`  強制でない手 ${stats.unforced[0]} / ${stats.unforced[1]}`);
  console.log(`  White ${a.toFixed(1)} mEMG（${ra}） / Black ${b.toFixed(1)} mEMG（${rb}）`);
  console.log(`  チェッカー 平均 ${mean.toFixed(1)} mEMG（White ${a.toFixed(1)} / Black ${b.toFixed(1)}）`);
}

// **キューブありのときは 3 つ揃えて出す。** どこが足を引っ張っているかは
// チェッカーとキューブを分けないと分からない（gnubg 自身もそう報告する）。
if (useCube) {
  for (const [heading, label, name] of [
    ['Cube statistics', 'Cube decision rating', 'キューブ'],
    ['Overall statistics', 'Overall rating', '全体    '],
  ]) {
    const sec = sectionStats(out, heading, label);
    // **判断回数を一緒に出す。** キューブは 1 局に数回しか起きないので、
    // ER が大きくても「2〜3 回のミス」なのか「毎回外している」のかは
    // 回数を見ないと分からない。
    if (heading === 'Cube statistics') {
      const counts = out.split('\n').filter((l) => /Total cube decisions|Actual or close cube/i.test(l));
      for (const c of counts.slice(0, 2)) console.log(`    ${c.trim()}`);
    }
    if (!sec) { console.log(`  ${name}: 読み取れませんでした`); continue; }
    const [x, y] = sec.er;
    const [rx, ry] = sec.rating ?? ['?', '?'];
    console.log(`  ${name} 平均 ${((x + y) / 2).toFixed(1)} mEMG`
      + `（White ${x.toFixed(1)}・${rx} / Black ${y.toFixed(1)}・${ry}）`);
  }
}
rmSync(dir, { recursive: true, force: true });
