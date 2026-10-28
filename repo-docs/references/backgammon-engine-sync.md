# Backgammon engine / miniapp 同期手順

`dj-kusuha/backgammon_engine` が Money cube search とモデルの正本、`dj-kusuha/miniapp` は browser/Worker 実装です。JavaScript search core は手動同期なので、同期ごとに engine SHA、miniapp SHA、model SHA、fixture 値を記録します。

## 同期前の記録

miniapp と engine の checkout を sibling directory に置き、両方の commit と model を照合します。

```sh
git -C ../miniapp rev-parse HEAD
git -C ../backgammon_engine rev-parse HEAD
sha256sum docs/backgammon/src/model.json ../backgammon_engine/models/td_gammon.json
diff -u docs/backgammon/src/agent.js ../backgammon_engine/javascript/package/src/agent.js
```

model の SHA が異なる場合は、モデルの用途・世代を確認してから配布ファイルを同期します。学習重みは手編集しません。

## Search code の同期

1. engine JS の `javascript/package/src/agent.js` と miniapp の `docs/backgammon/src/agent.js` を差分比較する。
2. Python production の `backgammon/agent.py` で同じ action context と権利条件を確認する。
3. Cube owner、cube value、allow-double、Jacoby、Crawford、cash policy の差を分類し、意図を確認した変更だけ miniapp へ移す。
4. CubeHead や Worker 呼び出しに副作用がないことを確認する。miniapp の CPU level、hint、Worker protocol を維持する。
5. `diff` を見直し、共有 search core を同期した場合は同一内容になることを確認する。

`facade.js` の `analyzeCube()` 公開 API は engine issue #389 で別管理しているため、そこで確定していない Money CubeHead の係数・API をこの同期へ混ぜません。

## Fixture の更新

### Money cube parity

通常の Money cube oracle は engine checkout の root から出力します。

```sh
cd ../backgammon_engine
python tools/export_cube_parity.py > ../miniapp/tests/backgammon/cube-parity.json
```

盤面列を変えずに engine の数値だけ更新する場合は `--refresh` を使います。

```sh
python tools/export_cube_parity.py --refresh ../miniapp/tests/backgammon/cube-parity.json
```

`cube-cash-option-parity.json` は engine Python の `TDAgent._cubeful_search`、固定 XG 3-2 盤面、`models/td_gammon.json`、depth 2、leaf 0、Cash Option alpha 1.0 から作った数値を持ちます。owner は `opponent/me/center`、cube は `1/2/32/64`、double 権と `post_double_take` を変えて比較します。

`match-cube-parity.json` は同じ盤面・モデルで `TDAgent._mwc_search` の結果を保存します。away score、pre/post-Crawford、owner、cube、future double 権を含めます。

Money cube action の Cash Option は現行 engine 契約を維持します。`shouldDoubleSearch()` / Python の cube-action 入口は既存の `cashOption` / `cashAlpha` を渡し、この直接入口の補正は root depth 1 でのみ有効です。ND 再帰用 `cashPolicy` の内部経路とは別です。depth 2 以上の Money action に policy を新たに接続する変更は engine parity を変えるため、engine 側の契約変更と同時に扱います。テストでは実際の `shouldDoubleSearch()` の depth 1 / 2 挙動を固定しています。

どちらの fixture も engine commit と model SHA を JSON に記録します。テスト許容差は `1e-5` です。意図した数値変更の場合は fixture を更新した理由と誤差を PR の記録に含めます。

## 確認

```sh
cd ../miniapp
node tests/backgammon/run.mjs
```

`worker.mjs` は loopback HTTP server を使いモデルを読むため、sandbox が `127.0.0.1` を拒否するときは loopback を許可した環境で単体実行します。新しい worker/API 契約は test runner に登録します。
