// パリティ検証をまとめて走らせる。
//   node apps/backgammon/test/run.mjs
//
// **engine（Python）が正本。** ここが落ちたら JS 側を直す。engine 側の
// ルールやモデルを変えたときは、engine で
// `python csharp/tools/export_parity_fixtures.py` を実行して parity.json を
// 作り直してからここへコピーする。
import { execFileSync } from 'node:child_process';

const specs = ['parity-encode.mjs', 'parity-nn.mjs', 'parity-moves.mjs', 'parity-select.mjs'];
let failed = 0;
for (const spec of specs) {
  try {
    const out = execFileSync('node', [new URL(`./${spec}`, import.meta.url).pathname],
      { encoding: 'utf8' });
    process.stdout.write(out);
  } catch (error) {
    failed += 1;
    process.stdout.write(error.stdout ?? '');
    process.stderr.write(error.stderr ?? '');
  }
}
console.log(failed ? `\n${failed} 件のテストが失敗しました` : '\nすべて一致しました');
process.exit(failed ? 1 : 0);
