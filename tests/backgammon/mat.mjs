// 書き出した .mat を gnubg が読めるかを、`import.c` の判定を再現して確かめる。
//
// gnubg 本体を CI で動かせないので、**読み込み側のコードを写した検証器**を持つ。
// 参照した実装（GNU Backgammon, import.c）:
//   ImportMatVariation:1034  ヘッダ "N point match"
//   ImportGame:832-944       プレイヤー行と列の分割
//   ParseMatMove:570-604     着手欄の判定
//
// 特に**先手が左の列**であることを確かめる。左列が空の行は列の分割が
// 「15 桁目以降の二重空白」に頼る経路へ落ち、実機で読み込めなかった。

import { WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import { Game, GAME_OVER } from '../../docs/backgammon/src/game.js';
import { toMat } from '../../docs/backgammon/src/mat.js';

/** 決められた種を持つ乱数（対局を再現できるようにする）。 */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 合法手から適当に 1 つ選んで 1 局を終わりまで進める。 */
function playGame(seed) {
  const rng = seeded(seed);
  const game = new Game(null, rng);
  game.start();
  for (let i = 0; i < 2000 && game.state !== GAME_OVER; i += 1) {
    if (game.legalMoves.length === 0) {
      game.rollDice();
      continue;
    }
    game.applyMove(Math.floor(rng() * game.legalMoves.length));
  }
  return game;
}

// ── gnubg の import.c を写した検証器 ──────────────

const isSpace = (c) => c === ' ' || c === '\t';

function parseMat(text) {
  const problems = [];
  const cells = [];
  // GetMatLine: 空白だけの行は読み飛ばす
  const lines = text.split('\n').filter((l) => l.trim() !== '');

  // ヘッダ: sscanf(szLine, "%d %*1[Pp]oint %*1[Mm]atch%c", &nLength, &ch)
  let idx = 0;
  let nLength = null;
  for (; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^\s*(\d+)\s+[Pp]oint\s+[Mm]atch/.exec(line);
    if (m) { nLength = Number(m[1]); idx += 1; break; }
  }
  if (nLength === null) problems.push('ヘッダ "N point match" が無い');
  else if (nLength < 0) problems.push(`不正な match length: ${nLength}`);

  // START_STRING " Game "
  while (idx < lines.length && !lines[idx].startsWith(' Game ')) idx += 1;
  if (idx >= lines.length) problems.push('" Game " 行が無い');
  idx += 1;

  // プレイヤー行。コロンが無いと ImportGame が return 0 する。
  let players = null;
  if (idx < lines.length) {
    const psz = lines[idx].replace(/^\s+/, '');
    idx += 1;
    const c1 = psz.indexOf(':');
    if (c1 < 0) {
      problems.push('プレイヤー行に 1 人目のコロンが無い → ImportGame が return 0');
    } else {
      const name0 = psz.slice(0, c1).trimEnd();
      const rest = psz.slice(c1 + 1).replace(/^\s+/, '');
      let j = 0;
      while (j < rest.length && !isSpace(rest[j])) j += 1;
      while (j < rest.length && isSpace(rest[j])) j += 1;
      const tail = rest.slice(j);
      const c2 = tail.indexOf(':');
      if (c2 < 0) {
        problems.push('プレイヤー行に 2 人目のコロンが無い → ImportGame が return 0');
      } else {
        players = [name0, tail.slice(0, c2).trimEnd()];
        if (Number.isNaN(parseInt(rest, 10))
            || Number.isNaN(parseInt(tail.slice(c2 + 1), 10))) {
          problems.push('スコアが数値でない');
        }
      }
    }
  }

  // 着手行
  for (; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (line.startsWith(' Game ')) break;

    // 列の分割（import.c:928-931）
    let left = null;
    let right = null;
    const p1 = line.indexOf(':');
    const p2 = p1 >= 0 ? line.indexOf(':', p1 + 1) : -1;
    let splitBy;
    if (p1 >= 0 && p2 >= 0 && p2 > 3) {
      const cut = p2 - 3;                    // *((pchRight -= 2) - 1) = 0
      left = line.slice(0, cut);
      right = line.slice(cut + 1);
      splitBy = 'colon';
    } else if (line.length > 15) {
      const dbl = line.indexOf('  ', 15);
      if (dbl >= 0) { left = line.slice(0, dbl); right = line.slice(dbl + 1); splitBy = 'spaces'; }
      else { left = line; splitBy = 'none'; }
    } else { left = line; splitBy = 'none'; }

    // 左列は ')' の次から（import.c:933-936）
    const paren = left.indexOf(')');
    const leftCell = paren >= 0 ? left.slice(paren + 1) : left;

    for (const [raw, who] of [[leftCell, 0], [right, 1]]) {
      if (raw === null) continue;
      const sz = raw.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      if (!sz) { cells.push({ who, kind: 'empty', splitBy, line: idx + 1 }); continue; }
      if (/^Wins \d+ points?$/i.test(sz)) { cells.push({ who, kind: 'win', line: idx + 1 }); continue; }
      // ParseMatMove:586
      const ok = sz[0] >= '1' && sz[0] <= '6' && sz[1] >= '1' && sz[1] <= '6' && sz[2] === ':';
      if (!ok) {
        problems.push(`行 ${idx + 1} 列 ${who}: 着手欄として認識できない → "${sz}"`);
        continue;
      }
      cells.push({ who, kind: sz.slice(3).trim() === '' ? 'dance' : 'move', splitBy, line: idx + 1 });
    }
  }

  return { problems, cells, players, nLength };
}

// ── 実行 ────────────────────────────────────

const GAMES = 60;
let blackFirst = 0;
let whiteFirst = 0;
let totalMoves = 0;
let totalDances = 0;
const failures = [];

for (let seed = 1; seed <= GAMES; seed += 1) {
  const game = playGame(seed);
  const humanSide = seed % 2 ? WHITE : BLACK;
  const text = toMat({
    log: game.log,
    result: game.state === GAME_OVER ? game.result : null,
    humanSide,
  });

  const opening = game.log.find((e) => e.kind === 'open');
  if (opening.player === BLACK) blackFirst += 1; else whiteFirst += 1;

  const { problems, cells, players } = parseMat(text);
  for (const p of problems) failures.push(`seed ${seed}: ${p}`);

  // 先手が左の列に来ているか
  const firstCell = cells.find((c) => c.kind === 'move' || c.kind === 'dance');
  if (!firstCell || firstCell.who !== 0) {
    failures.push(`seed ${seed}: 先手が左の列にいない（who=${firstCell ? firstCell.who : 'なし'}）`);
  }
  // 先手の色が左のプレイヤー名と一致しているか
  const expected = opening.player === WHITE ? 'White' : 'Black';
  if (players && !players[0].startsWith(expected)) {
    failures.push(`seed ${seed}: 左の名前が先手と違う（${players[0]} / 先手は ${expected}）`);
  }
  // 空の左列に頼る分割が起きていないか
  for (const c of cells) {
    if (c.who === 1 && c.splitBy === 'spaces') {
      failures.push(`seed ${seed}: 行 ${c.line} が二重空白で分割されている（左列が空）`);
    }
  }

  totalMoves += cells.filter((c) => c.kind === 'move').length;
  totalDances += cells.filter((c) => c.kind === 'dance').length;
}

console.log(`.mat 書き出し: ${GAMES} 局（先手 White ${whiteFirst} / Black ${blackFirst}）`);
console.log(`  着手欄 ${totalMoves} 件 / ダンス ${totalDances} 件`);

if (failures.length) {
  console.error(`\n不一致 ${failures.length} 件:`);
  for (const f of failures.slice(0, 20)) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('  gnubg の import.c 相当の判定をすべて通過');
}
