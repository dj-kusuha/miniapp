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

import { WHITE, BLACK, opponent as opponentOf } from '../../docs/backgammon/src/board.js';
import { GAME_OVER } from '../../docs/backgammon/src/game.js';
import { Match, MONEY } from '../../docs/backgammon/src/match.js';
import { toMat } from '../../docs/backgammon/src/mat.js';

/** 決められた種を持つ乱数（対局を再現できるようにする）。 */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 合法手から適当に 1 つ選んで 1 局を終わりまで進める。
 *
 * `cube` を立てると、ロール前にときどきダブルを提案し、受けたり降りたりする。
 * **クロフォード局ではダブルできない**ので、`canDouble()` を必ず通す。
 */
function playGame(game, rng, cube) {
  for (let i = 0; i < 2000 && game.state !== GAME_OVER; i += 1) {
    if (cube && game.canDouble() && rng() < 0.08) {
      game.proposeDouble();
      if (rng() < 0.75) game.acceptDouble();
      else game.declineDouble();
      continue;
    }
    if (game.legalMoves.length === 0) {
      game.rollDice();
      continue;
    }
    game.applyMove(Math.floor(rng() * game.legalMoves.length));
  }
  return game;
}

/**
 * マッチ（またはアンリミテッドのセッション）を最後まで進める。
 *
 * `games` を渡すとその局数で打ち切る（アンリミテッドは終わらないので必須）。
 * ジャコビーは切る（点数の見え方を単純にするため）。
 */
function playSession(seed, { cube = false, length = MONEY, games = 40 } = {}) {
  const rng = seeded(seed);
  const match = new Match({ length, jacoby: false, useCube: cube, rng });
  for (let i = 0; i < games; i += 1) {
    const game = match.startGame();
    if (!game) break;             // マッチが終わっている
    playGame(game, rng, cube);
    match.sync();
  }
  return match;
}

/**
 * ログから「.mat に並ぶはずのセル」を作る。**レイアウトを通さずログから直接**
 * 作るので、読み込み結果とこれを突き合わせれば、どの列にどの手が入ったかまで
 * 確かめられる。
 */
function expectedCells(game) {
  const out = [];
  let roll = null;
  for (const event of game.log) {
    if (event.kind === 'open' || event.kind === 'roll') {
      roll = { player: event.player, kind: 'dance' };
      out.push(roll);
    } else if (event.kind === 'move') {
      if (roll && roll.player === event.player) roll.kind = 'move';
    } else if (event.kind === 'double') {
      out.push({ player: event.player, kind: 'double' });
      roll = null;
    } else if (event.kind === 'take') {
      out.push({ player: event.player, kind: 'take' });
      roll = null;
    } else if (event.kind === 'pass') {
      out.push({ player: event.player, kind: 'drop' });
      roll = null;
    }
  }
  if (game.state === GAME_OVER) out.push({ player: game.result.winner, kind: 'win' });
  return out;
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

  // START_STRING " Game " ごとに 1 局。マッチでは何度も現れる。
  const games = [];
  while (idx < lines.length) {
    while (idx < lines.length && !lines[idx].startsWith(' Game ')) idx += 1;
    if (idx >= lines.length) break;
    idx += 1;
    const parsed = parseGame(lines, idx, problems);
    idx = parsed.next;
    games.push(parsed.game);
  }
  if (games.length === 0) problems.push('" Game " 行が無い');

  return { problems, games, nLength };
}

/** 1 局ぶん（プレイヤー行 + 着手行）を読む。`idx` はプレイヤー行の位置。 */
function parseGame(lines, start, problems) {
  const cells = [];
  let idx = start;

  // プレイヤー行。コロンが無いと ImportGame が return 0 する。
  let players = null;
  let scores = null;
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
        const s0 = parseInt(rest, 10);
        const s1 = parseInt(tail.slice(c2 + 1), 10);
        if (Number.isNaN(s0) || Number.isNaN(s1)) problems.push('スコアが数値でない');
        else scores = [s0, s1];
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

    const leftEmpty = leftCell.trim() === '';
    for (const [raw, who] of [[leftCell, 0], [right, 1]]) {
      if (raw === null) continue;
      const sz = raw.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      const at = { who, splitBy, leftEmpty, line: idx + 1 };
      if (!sz) { cells.push({ ...at, kind: 'empty' }); continue; }
      if (/^Wins \d+ points?$/i.test(sz)) { cells.push({ ...at, kind: 'win' }); continue; }
      // キューブ。gnubg 自身の書き出しを写した形（先頭の空白は上で落ちている）
      if (/^Doubles\s*=>\s*\d+$/i.test(sz)) { cells.push({ ...at, kind: 'double' }); continue; }
      if (/^Takes$/i.test(sz)) { cells.push({ ...at, kind: 'take' }); continue; }
      if (/^Drops$/i.test(sz)) { cells.push({ ...at, kind: 'drop' }); continue; }
      // ParseMatMove:586
      const ok = sz[0] >= '1' && sz[0] <= '6' && sz[1] >= '1' && sz[1] <= '6' && sz[2] === ':';
      if (!ok) {
        problems.push(`行 ${idx + 1} 列 ${who}: 着手欄として認識できない → "${sz}"`);
        continue;
      }
      cells.push({ ...at, kind: sz.slice(3).trim() === '' ? 'dance' : 'move' });
    }
  }

  return { next: idx, game: { cells, players, scores } };
}

// ── 実行 ────────────────────────────────────

const ROUNDS = 60;
let blackFirst = 0;
let whiteFirst = 0;
const counts = { move: 0, dance: 0, double: 0, take: 0, drop: 0, win: 0 };
const failures = [];
let matchFiles = 0;
let totalGames = 0;

/** 1 本の .mat（1 局 / セッション / マッチ）を検証する。 */
function check(label, match, humanSide) {
  const text = toMat({
    games: match.matGames(),
    length: match.length,
    humanSide,
  });
  const { problems, games, nLength } = parseMat(text);
  for (const p of problems) failures.push(`${label}: ${p}`);
  if (nLength !== match.length) {
    failures.push(`${label}: ヘッダの長さが違う（${nLength} / ${match.length}）`);
  }
  if (games.length !== match.entries.length) {
    failures.push(`${label}: 局数が違う（読み込み ${games.length} / ${match.entries.length}）`);
    return;
  }

  // **列の順はファイル全体で固定**（1 局目の先手が左）。
  const leftSide = match.entries[0].game.log.find((e) => e.kind === 'open').player;
  const rightSide = opponentOf(leftSide);

  games.forEach((parsed, gi) => {
    const entry = match.entries[gi];
    const at = `${label} 第 ${gi + 1} 局`;

    // 名前が左右で入れ替わっていないか。**入れ替わるとスコアの帰属が壊れる。**
    const wantLeft = leftSide === WHITE ? 'White' : 'Black';
    if (parsed.players && !parsed.players[0].startsWith(wantLeft)) {
      failures.push(`${at}: 左の名前が違う（${parsed.players[0]} / ${wantLeft}）`);
    }
    // プレイヤー行のスコアが、その局を始めた時点の値になっているか
    if (parsed.scores) {
      const want = [entry.scores[leftSide], entry.scores[rightSide]];
      if (parsed.scores[0] !== want[0] || parsed.scores[1] !== want[1]) {
        failures.push(`${at}: スコアが違う（読み込み ${parsed.scores} / 期待 ${want}）`);
      }
    }
    // **「左列が空」を弾く判定は置かない**（2026-08-22 に外した）。
    //
    // 以前は「左列が空の行は二重空白で割られる経路に落ちて読めない」として
    // 弾いていたが、**マッチでは gnubg 自身がその形を書き出す**（先手が右の局の
    // 1 行目）。実物の gnubg で往復させて、その行がそのまま戻ることも確かめた。
    //
    // 守りたいのは「どの手がどちらの列に入ったか」であって、行の見た目ではない。
    // それは下のセル列の突き合わせが直接見ている。

    // 読み込み結果が、ログから作った並びと 1 セルずつ一致するか。
    // **どちらの列に入ったか**まで見るので、列の割り当ての誤りを捕まえられる。
    const got = parsed.cells.filter((c) => c.kind !== 'empty')
      .map((c) => ({ player: c.who === 0 ? leftSide : rightSide, kind: c.kind }));
    const want = expectedCells(entry.game);
    if (got.length !== want.length) {
      failures.push(`${at}: セル数が違う（読み込み ${got.length} / ログ ${want.length}）`);
      return;
    }
    for (let i = 0; i < want.length; i += 1) {
      if (got[i].player !== want[i].player || got[i].kind !== want[i].kind) {
        failures.push(`${at}: ${i + 1} 番目のセルが違う`
          + `（読み込み ${got[i].player}/${got[i].kind} / ログ ${want[i].player}/${want[i].kind}）`);
        break;
      }
    }
    for (const c of got) counts[c.kind] += 1;
  });
  totalGames += games.length;
}

// 1 局だけ（アンリミテッド）。キューブ無し / あり。
for (const cube of [false, true]) {
  for (let seed = 1; seed <= ROUNDS; seed += 1) {
    const match = playSession(seed, { cube, length: MONEY, games: 1 });
    const opening = match.entries[0].game.log.find((e) => e.kind === 'open');
    if (!cube) {
      if (opening.player === BLACK) blackFirst += 1; else whiteFirst += 1;
    }
    check(`seed ${seed}${cube ? '（キューブあり）' : ''}`, match, seed % 2 ? WHITE : BLACK);
  }
}

// ポイントマッチ（1〜7）。**マッチは複数局にまたがる**ので、列の固定と
// スコアの引き継ぎはここでしか確かめられない。
for (const length of [1, 2, 3, 4, 5, 6, 7]) {
  for (let seed = 1; seed <= 12; seed += 1) {
    const match = playSession(seed * 31 + length, { cube: true, length });
    check(`${length}pt seed ${seed}`, match, seed % 2 ? WHITE : BLACK);
    matchFiles += 1;
  }
}

console.log(`.mat 書き出し: ${totalGames} 局 / ${ROUNDS * 2 + matchFiles} 本`
  + `（うちマッチ ${matchFiles} 本。1 局目の先手 White ${whiteFirst} / Black ${blackFirst}）`);
console.log(`  着手欄 ${counts.move} 件 / ダンス ${counts.dance} 件`);
console.log(`  キューブ: ダブル ${counts.double} 件 / テイク ${counts.take} 件 / ドロップ ${counts.drop} 件`);

if (counts.double === 0 || counts.take === 0 || counts.drop === 0) {
  failures.push('キューブの検体が足りない（ダブル / テイク / ドロップのどれかが 0 件）');
}

if (failures.length) {
  console.error(`\n不一致 ${failures.length} 件:`);
  for (const f of failures.slice(0, 20)) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('  gnubg の import.c 相当の判定をすべて通過');
}
