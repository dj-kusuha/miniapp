// マッチエクイティ表（MET）を取ってきて `docs/backgammon/src/met-table.js` を作る。
//
//   node tools/build-met.mjs
//
// **出力はコミットする。** 実行時にネットワークへ出ないようにするため、
// 表は JS モジュールとして同梱する。このツールは「どこから取ったか」と
// 「どう変換したか」を再現できるようにするために置いてある。
//
// ## 出どころ
//
// GNU Backgammon 同梱の **Kazaross XG2**（25 ポイントまで）。取得元は
// gnubg の GitHub ミラー。**正典（GNU Savannah）と数値が一致することを
// 毎回確かめてから**書き出す。
//
// ## ライセンス
//
// GPL ではなく permissive で、**著作権表示とその許諾文を残せば**改変込みで
// 自由に配布してよい。出力ファイルの先頭にその文を丸ごと写している
// （[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)）。

import { writeFileSync } from 'node:fs';

/** 取得元。**ユーザーの指定で GitHub のミラーを一次の取得元にしている。** */
const SOURCE = 'https://raw.githubusercontent.com/mormegil-cz/gnubg/master/met/Kazaross-XG2.xml';
/** 照合先。GNU Savannah の gnubg 本家。 */
const CANONICAL = 'https://git.savannah.gnu.org/cgit/gnubg.git/plain/met/Kazaross-XG2.xml';

const OUT = new URL('../docs/backgammon/src/met-table.js', import.meta.url);

/**
 * 許諾文。**Savannah（現行の本家）の文言を写す。**
 *
 * ミラー側は古い版で文言が違うが、数値は同一であることを毎回確かめている。
 * 権利者と許諾の内容は同じで、本家の方が転記者の記載まで含んでいる。
 */
const NOTICE = `Copyright (C) 2011 Neil Kazaross

Table rolled up to 9 point match by eXtreme Gammon. Then uses
R/K MET which was rolled up to 15 and extrapolated to 25 points

Transcribed for use by GNUbg by Michael Petch  <mpetch@capp-sysware.com>

This file is distributed as a part of the GNU Backgammon program.

Copying and distribution of this file, with or without modification,
are permitted in any medium without royalty provided the copyright
notice and this notice are preserved.  This file is offered as-is,
without any warranty.`;

function parseMet(text) {
  const block = (tag) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(text);
    if (!m) throw new Error(`<${tag}> が見つかりません`);
    return m[1];
  };
  const rows = (body) => [...body.matchAll(/<row>([\s\S]*?)<\/row>/g)]
    .map((m) => [...m[1].matchAll(/<me>([^<]+)<\/me>/g)].map((x) => Number(x[1])));
  const info = block('info');
  return {
    name: /<name>([^<]*)<\/name>/.exec(info)[1],
    length: Number(/<length>([^<]*)<\/length>/.exec(info)[1]),
    pre: rows(block('pre-crawford-table')),
    post: rows(block('post-crawford-table')),
  };
}

/** 表として成立しているか。**壊れた表を黙って書き出さない。** */
function verify(met) {
  const n = met.length;
  if (!Number.isInteger(n) || n < 1) throw new Error(`length が不正: ${n}`);
  if (met.pre.length !== n) throw new Error(`pre の行数が ${met.pre.length}（${n} のはず）`);
  for (const [i, row] of met.pre.entries()) {
    if (row.length !== n) throw new Error(`pre 第 ${i + 1} 行の列数が ${row.length}`);
    for (const v of row) {
      if (!(v > 0 && v < 1)) throw new Error(`pre 第 ${i + 1} 行に範囲外の値: ${v}`);
    }
  }
  if (met.post.length !== 1) throw new Error(`post の行数が ${met.post.length}（1 のはず）`);
  if (met.post[0].length !== n) throw new Error(`post の列数が ${met.post[0].length}`);
  for (const v of met.post[0]) {
    if (!(v > 0 && v < 1)) throw new Error(`post に範囲外の値: ${v}`);
  }
  // **対称でなければ表の読み方を間違えている。** MET は手番の有利を含まない
  // （局の開始時点の値）ので、MET(i,j) + MET(j,i) は必ず 1 になる。
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const d = Math.abs(met.pre[i][j] + met.pre[j][i] - 1);
      if (d > 1e-9) throw new Error(`対称でない: ${i + 1}-away vs ${j + 1}-away で ${d}`);
    }
  }
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} が ${res.status}`);
  return res.text();
}

const source = parseMet(await get(SOURCE));
verify(source);

// **正典と数値が一致するか。** ミラーは古い版なので、表そのものがずれていない
// ことを毎回確かめてから採用する。
const canonical = parseMet(await get(CANONICAL));
verify(canonical);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!same(source.pre, canonical.pre) || !same(source.post, canonical.post)) {
  throw new Error('ミラーと Savannah で数値が食い違っています。取得元を確かめること');
}

const fmt = (row) => `  [${row.join(', ')}],`;
const lines = [
  '// **このファイルは生成物。** 直接編集せず `node tools/build-met.mjs` で作り直す。',
  '//',
  `// ${source.name}（GNU Backgammon 同梱の MET）。`,
  '// 取得元: ' + SOURCE,
  '// 照合先: ' + CANONICAL + '（数値の一致を確認済み）',
  '//',
  '// ── 以下は原典の著作権表示と許諾文。**消さないこと**（許諾の条件） ──',
  '//',
  ...NOTICE.split('\n').map((l) => (l ? `//   ${l}` : '//')),
  '',
  `export const MET_NAME = ${JSON.stringify(source.name)};`,
  `export const MET_LENGTH = ${source.length};`,
  '',
  '/** `PRE_CRAWFORD[i][j]` = (i+1)-away の側が、相手 (j+1)-away のときにマッチを勝つ確率。 */',
  'export const PRE_CRAWFORD = [',
  ...source.pre.map(fmt),
  '];',
  '',
  '/** `POST_CRAWFORD[k]` = (k+1)-away の側が、相手 1-away・クロフォード消化済みのときの勝率。 */',
  `export const POST_CRAWFORD = [${source.post[0].join(', ')}];`,
  '',
];
writeFileSync(OUT, lines.join('\n'));
console.log(`${source.name}: pre ${source.pre.length}x${source.pre[0].length}`
  + ` / post ${source.post[0].length} → ${OUT.pathname}`);
