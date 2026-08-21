// 棋譜を gnubg / Jellyfish の .mat 形式で書き出す。
//
// 出力は **gnubg 自身の書き出し**（`import.c` の `OutputMove` と
// `" 0 point match"` ヘッダ）に合わせてある。読み込み側の決まりごとが厳しいので、
// 見た目のために勝手に整形しないこと。gnubg の `import.c` を読むと:
//
//   - プレイヤー行は `名前 : スコア` の**コロンが必須**。無いと `ImportGame` が
//     即 `return 0` して、その対局はまるごと読み飛ばされる（import.c:837）
//   - 手数の区切りは `1)` の**閉じ括弧**。`strchr(szLine, ')')` で左列の開始を
//     探すので、`1:` にすると列の分割がずれて壊れる（import.c:933）
//   - 着手欄は `65: ...` の形（1〜6 の 2 桁 + コロン + 空白）。ダンスは出目だけ
//     書く（import.c:586）
//   - 左列は 27 桁 + 空白 1 つ。右列との間に**必ず空白**が要る（import.c:3749）
//   - キューブ無しは `0 point match`（マネーゲーム）で正しい。弾かれるのは
//     `nLength < 0` のときだけ（import.c:1037）
//   - **キューブは着手欄に書く**。gnubg は ` Doubles => 2` / ` Takes` /
//     ` Drops` を読む（import.c の ParseMatMove）。**出目の欄は使わない**ので、
//     ダブルは 1 手番ぶんの枠を単独で消費する
//
// **先手を必ず左の列に置く。** 左列が空の行は、gnubg が「コロン 2 つ」ではなく
// 「15 桁目以降の二重空白」で列を割る経路に落ちる（import.c:930）。実機では
// これで読み込めなかったので、後手が White でも列の並びを入れ替える。
//
// 着手は**指した側から見たポイント番号**で書く（`Move.toString()` がその形）。

import { WHITE, opponent } from './board.js';

const MAT_LEFT = 27;   // 左の列幅。gnubg は "%-27s " で書く

/** ログを「1 手番 = 1 エントリ」に畳む。
 *
 * **キューブの操作は出目を持たない**ので、`roll` を null にした専用の
 * エントリにする（`cell` がそれを見て書き分ける）。
 */
function matTurns(log) {
  const turns = [];
  let current = null;
  for (const event of log) {
    if (event.kind === 'roll' || event.kind === 'open') {
      current = { player: event.player, roll: event.roll, text: '' };
      turns.push(current);
    } else if (event.kind === 'double') {
      // ダブルは 1 手番ぶんの枠を単独で使う（この後にロールが来る）
      turns.push({ player: event.player, roll: null, text: `Doubles => ${event.value}` });
      current = null;
    } else if (event.kind === 'take') {
      turns.push({ player: event.player, roll: null, text: 'Takes' });
      current = null;
    } else if (event.kind === 'pass') {
      turns.push({ player: event.player, roll: null, text: 'Drops' });
      current = null;
    } else if (current && current.player === event.player && event.kind === 'move') {
      current.text = event.text;
      // 'skip'（ダンス）は出目だけ書いて着手は空のままにする
    }
  }
  return turns;
}

/**
 * @param {object[]} log      `Game.log`
 * @param {?object} result    決着していれば `Game.result`
 * @param {string} humanSide  人間が持っている側（名前に印を付けるだけ）
 */
export function toMat({ log, result = null, humanSide = WHITE }) {
  const turns = matTurns(log);
  // 出目を持たない手番（キューブの操作）は本文だけを書く
  const cell = (turn) => {
    if (!turn) return '';
    if (turn.roll === null) return turn.text;
    return `${turn.roll.join('')}: ${turn.text}`.trimEnd();
  };

  // 先手を左に。ダンスした手番も 1 枠使う。
  const leftSide = turns.length > 0 ? turns[0].player : WHITE;
  const rightSide = opponent(leftSide);

  const rows = [];
  let row = null;
  for (const turn of turns) {
    const col = turn.player === leftSide ? 0 : 1;
    if (!row || row[col]) { row = [null, null]; rows.push(row); }
    row[col] = turn;
  }

  // 名前で色と「どちらが自分か」が分かるようにする（スコアのコロンは必須）。
  const name = (side) =>
    `${side === WHITE ? 'White' : 'Black'}_${side === humanSide ? 'you' : 'ai'}`;

  const lines = [
    '; [Site "miniapp backgammon"]',
    '; [Variation "Backgammon"]',
    '',
    ' 0 point match',
    '',
    ' Game 1',
    // gnubg の書式は " %s : %-22d %s : %d"
    ` ${name(leftSide)} : ${String(0).padEnd(22)} ${name(rightSide)} : 0`,
  ];

  rows.forEach((pair, i) => {
    // gnubg の書式は "%3d) " + "%-27s " + 右列
    const line = `${String(i + 1).padStart(3)}) ${cell(pair[0]).padEnd(MAT_LEFT)} ${cell(pair[1])}`;
    lines.push(line.trimEnd());
  });

  if (result) {
    const points = result.points;
    lines.push(`      Wins ${points} point${points === 1 ? '' : 's'}`);
  }

  return `${lines.join('\n')}\n`;
}
