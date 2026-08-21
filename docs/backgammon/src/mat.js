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
//   - マネーゲームは `0 point match` で正しい。弾かれるのは
//     `nLength < 0` のときだけ（import.c:1037）
//
// **先手を必ず左の列に置く。** 左列が空の行は、gnubg が「コロン 2 つ」ではなく
// 「15 桁目以降の二重空白」で列を割る経路に落ちる（import.c:930）。実機では
// これで読み込めなかったので、後手が White でも列の並びを入れ替える。
//
// 着手は**指した側から見たポイント番号**で書く（`Move.toString()` がその形）。
//
// ## キューブ
//
// 書式は推測せず、**gnubg 1.07 に自己対局させて `export match mat` させたもの**
// を写した。要点:
//
//   - セルは `" Doubles => 4"` / `" Takes"` / `" Drops"`。**先頭に空白が 1 つ
//     入る**（着手欄は入らない）
//   - キューブも**着手と同じく 1 セルを使う**。ダブルを出した側はテイクされた
//     あと、次のセルで改めて振る
//   - `Wins N points` は**勝った側の列**に置く。その列が埋まっていれば行を
//     足すが、**足した行には番号を振らない**
//   - これらの行にはコロンが無いので、gnubg は「15 桁目以降の二重空白」で列を
//     割る。gnubg 自身の書き出しがそうなっているので、この経路自体は正常

import { WHITE, opponent } from './board.js';

const MAT_LEFT = 27;   // 左の列幅。gnubg は "%-27s " で書く

/**
 * ログを .mat の「1 セル = 1 アクション」に畳む。
 *
 * 着手は「ロールで枠を作り、着手が来たら書き足す」（ダンスは出目だけの枠が
 * 残る）。キューブは 1 件で 1 セル。
 */
function matCells(log) {
  const cells = [];
  let roll = null;   // 直前のロールで作った枠
  for (const event of log) {
    switch (event.kind) {
      case 'open':
      case 'roll':
        roll = { player: event.player, text: `${event.roll.join('')}:` };
        cells.push(roll);
        break;
      case 'move':
        if (roll && roll.player === event.player) roll.text += ` ${event.text}`;
        break;
      // 'skip'（ダンス）は出目だけの枠をそのまま残す
      case 'double':
        cells.push({ player: event.player, text: ` Doubles => ${event.value}` });
        roll = null;
        break;
      case 'take':
        cells.push({ player: event.player, text: ' Takes' });
        roll = null;
        break;
      case 'pass':
        cells.push({ player: event.player, text: ' Drops' });
        roll = null;
        break;
      default:
        break;
    }
  }
  return cells;
}

/**
 * @param {object[]} log      `Game.log`
 * @param {?object} result    決着していれば `Game.result`
 * @param {string} humanSide  人間が持っている側（名前に印を付けるだけ）
 */
export function toMat({ log, result = null, humanSide = WHITE }) {
  const cells = matCells(log);
  const text = (cell) => (cell ? cell.text.trimEnd() : '');

  // 先手を左に。ダンスした手番も 1 枠使う。
  const leftSide = cells.length > 0 ? cells[0].player : WHITE;
  const rightSide = opponent(leftSide);

  const rows = [];
  let row = null;
  for (const cell of cells) {
    const col = cell.player === leftSide ? 0 : 1;
    if (!row || row[col]) { row = [null, null]; rows.push(row); }
    row[col] = cell;
  }

  // 「Wins」は勝った側の列。その列が空いていなければ行を足し、**足した行には
  // 番号を振らない**（gnubg の書き出しに合わせる）。
  let extraWinsRow = false;
  if (result) {
    const points = result.points;
    const col = result.winner === leftSide ? 0 : 1;
    if (!row || row[col]) { row = [null, null]; rows.push(row); extraWinsRow = true; }
    row[col] = { text: ` Wins ${points} point${points === 1 ? '' : 's'}` };
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
    // gnubg の書式は "%3d) " + "%-27s " + 右列。番号を振らない行は同じ幅の空白
    const head = extraWinsRow && i === rows.length - 1 ? '     ' : `${String(i + 1).padStart(3)}) `;
    const line = `${head}${text(pair[0]).padEnd(MAT_LEFT)} ${text(pair[1])}`;
    lines.push(line.trimEnd());
  });

  return `${lines.join('\n')}\n`;
}
