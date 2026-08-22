# THIRD-PARTY-NOTICES

このリポジトリが同梱している第三者の成果物と、その許諾条件。

## Kazaross XG2 マッチエクイティ表

- **使っている場所**: [`docs/backgammon/src/met-table.js`](docs/backgammon/src/met-table.js)
  （生成物。[`tools/build-met.mjs`](tools/build-met.mjs) が作る）
- **取得元**: <https://raw.githubusercontent.com/mormegil-cz/gnubg/master/met/Kazaross-XG2.xml>
  （GNU Backgammon の GitHub ミラー）
- **照合先**: <https://git.savannah.gnu.org/cgit/gnubg.git/plain/met/Kazaross-XG2.xml>
  （GNU Savannah の本家。**数値の一致を生成のたびに検査している**）

XML から JavaScript の配列へ**書式だけを変換**して同梱している。数値は 1 つも
変えていない。

許諾は GPL ではなく permissive で、**著作権表示とこの許諾文を残せば**改変込みで
自由に配布してよい。原文をそのまま写す:

```
Copyright (C) 2011 Neil Kazaross

Table rolled up to 9 point match by eXtreme Gammon. Then uses
R/K MET which was rolled up to 15 and extrapolated to 25 points

Transcribed for use by GNUbg by Michael Petch  <mpetch@capp-sysware.com>

This file is distributed as a part of the GNU Backgammon program.

Copying and distribution of this file, with or without modification,
are permitted in any medium without royalty provided the copyright
notice and this notice are preserved.  This file is offered as-is,
without any warranty.
```

同じ文を `met-table.js` の先頭にも置いてある。**許諾の条件が掛かるのはそちら。**
条件は「**その表を含むファイル**の複製に、著作権表示と許諾文を残すこと」なので、
表を持たない HTML や CSS には掛からない。

> `docs/backgammon/index.html` のフッターにも 1 行クレジットを出しているが、
> **あれは許諾の条件ではない**（JS を開かない人向けの表示）。条件が求めているのは
> 上の「Copyright ...」の行と許諾文の段落で、転記者の記載はどちらでもない。
> ただし `met-table.js` には**原文のコメントを丸ごと写している**（「preserved」の
> いちばん安全な読み方）ので、転記者の行もそこには残る。

> **ミラーと本家で文言が違う。** ミラーは古い版で、許諾の内容は同じだが
> 表現が異なり、転記者の記載が無い。**現行の本家（上の文）を写している。**

GNU Backgammon 自体（GPL）のコードは一切取り込んでいない。持ってきたのは
上記の**データ表 1 つだけ**。
