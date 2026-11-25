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

## Issue #453: checker facade adapter（2026-11-03）

Issue #453の実装対象はminiapp。`backgammon_engine` の公開JS facadeを評価式の参照正本として、
miniappの `docs/backgammon/src/checker.js` にCPU着手・Hint共通のadapterを追加した。

- 参照engine SHA: `fb194be049bdd4167c147f8d9113d59c6d92e291`
- 実装元miniapp SHA: `74041ba05767373e0c2a0ba95d689fac754b716d`
- モデルSHA（engine / miniapp一致）: `9543ecb1deaff716de1355726d3109f1529fe34e0ab68d94284654fd7871dd83`
- 検索重み・Agentの共有search core・trainer・XG教師は変更していない。Workerとfallbackは同じchecker adapterを呼ぶ。
- Money cubefulとMatch MWCは、初期局面16候補の3-plyがそれぞれ約122秒、約29.7秒だったため、
  checker afterstate探索を最大1ロールに制限。Money cube OFFはprofileのchecker深度を維持する。
- 0/2/3-plyのNode / headless Edge測定、CPU/Hint、Crawford前後のWorker smokeは
  `repo-docs/exec-plans/completed/issue453-cubeful-checker.md` を参照。

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

## Engine 0.2.5 高速化同期・マルチ Worker 並列化（2026-11-23）

`@dj-kusuha/backgammon-engine@0.2.5`（`backgammon_engine` PR #552）の純 JS 推論・キャッシュ高速化とロール分割評価を `miniapp` へ同期し、最大 4 Worker 並列プール（`docs/backgammon/src/thinker-pool.js`）を導入した。

- 参照 engine SHA: `d43553b0e82167f58b475e487c7c36c2557fa0d3`
- 同期元 miniapp SHA: `33fb4e8e2ee742697fc7ff39f34177b022e806d8`
- モデル SHA（engine / miniapp 一致）: `9543ecb1deaff716de1355726d3109f1529fe34e0ab68d94284654fd7871dd83`
- 同期内容:
  - `nn.js`, `board.js`, `rules.js`: engine `0.2.5` と完全一致同期（連続フラット `Float32Array`＋IEEE 754 逐次加算順 4-way アンロール＋SiLU 同一式、`Float64Array(198)` アンロール `encodeBoard`、ゾロ目中間状態枝刈り）。
  - `agent.js`: `checkerVectorCache`（250k）/ `checkerRollCache`（65k）上限引き上げ、`rollShortlistBoards` 共有、`mwcSearch` / `cubefulSearch` / `expectedVectorAfterMove` / `expandRollsVector` の任意 `rollIndices` 分割対応（miniapp 固有の `LEVELS` / `blotPenalty` / `doubleMargin` / `takeMargin` は維持）。
  - `checker.js` / `worker.js` / `thinker-pool.js` / `app.js`: 高速文字列キャッシュキー、`checkerEfficiencies` 再利用、キューブ判断のキャッシュ適用、最大 4 Worker 遅延起動プールによる 2-ply / 3-ply 着手・ヒント・際どいキューブ判断の並列化。
  - 世界チャンピオン段（`champion`）の既定設定: Worker 利用時のみ `staged3ply` + `cubeFilterLevel: 1` を既定 ON とし、メインスレッド fallback は `legacy` を維持。`?checker-search=legacy|staged3ply|full-root` の明示クエリ指定を尊重する。

## Engine 0.2.6 Pruning Net（2 段葉プルーニング）同期（2026-11-26）

`@dj-kusuha/backgammon-engine@0.2.6`（`backgammon_engine` PR #568 / ADR-0178）の同梱蒸留 Pruning Net（`models/prune_net.json`, `198-64-32-5`, `317,382` bytes）と 2 段葉プルーニングを `miniapp` へ同期した。

- 参照 engine SHA: `0a7f7abf54de47e1681269997bfb7ed5568d0332`
- 同期元 miniapp SHA: `6ba51f84a10c9cddef24ffcc212fd9141a711721`
- 本体モデル SHA（engine / miniapp 一致）: `9543ecb1deaff716de1355726d3109f1529fe34e0ab68d94284654fd7871dd83`
- Pruning Net SHA（engine / miniapp 一致）: `2c75561140f7532f452c2c83a8e557467d366e1591df1328f087432436dc3dff`
- 同期内容:
  - `docs/backgammon/src/prune_net.json`: 正本 `models/prune_net.json` と byte-identical 配置。
  - `docs/backgammon/src/agent.js`: `DEFAULT_LEAF_PRUNE_CANDIDATES = 7` / `DEFAULT_LEAF_PRUNE_TOLERANCE = 0.200`、`validatePruneNet()`、`setPruneNet()` / `getPruneNet()`、`equitiesWithNet()`（`white` / `mover` 視点吸収）、`vectorsForBoards()`、`expandRollsDedup()`、`selectLeafReEvalCandidates()`、および `expectedEquityAfterMove()` / `expectedVectorAfterMove()` の 2 段葉プルーニングを同期（`pruneNet === null` 既定経路および `miniapp` 固有の `LEVELS` / `blotPenalty` / マージン設定は維持）。
  - `docs/backgammon/src/worker.js`: `loadGeneration` による非同期 `load` アトミック確定と `pruneNetUrl` 読込＋`validatePruneNet()` 検証（省略 / `null` / 失敗 / 構成不適合時は `null` へ安全フォールバック）。
  - `docs/backgammon/app.js`: 起動時に `src/prune_net.json` を読み込み、全 4 Worker（`ThinkerPool`）およびメインスレッドフォールバックへ適用。
  - `tests/backgammon/prune-net.mjs` / `tests/backgammon/prune-parity.json`: SHA-256・`pruneNet === net` 不変条件・Rust 24 局面（White 12 / Black 12）パリティ・`mover` 視点・Worker 非同期 `load` アトミック性を検証。
