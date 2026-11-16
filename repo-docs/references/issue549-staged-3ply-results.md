# staged3ply 実局面品質・regret・ブラウザレイテンシ検証結果（Issue #549）

- 検証トラッカー: `dj-kusuha/backgammon_engine` Issue #549
- 対象リポジトリ: `dj-kusuha/miniapp`
- 検証基準コミット: `1e55789a811c8fca9697c876e8ee9061bb3e3cd6`（PR #68 マージ後 `main`）
- 実施日: 2026-11-14〜15

---

## 1. 採否提案

**提案: `reject`（現時点での既定 ON 化は見送り、既定 OFF / `?checker-search=staged3ply` の opt-in 維持）**

### 理由

1. **品質は極めて優秀（`staged3ply` のアルゴリズム・閾値は妥当）**:
   - Full-root 3-ply を参照値とした 60 局面比較で、Match（35局面）は **35/35（100.0%）一致・regret 0**、Money 全体（25局面）は **24/25（96.0%）一致**、そのうち実際に staged 選別が動く **Money cube ON（21局面）でも 20/21（95.2%）一致・中央値/p90/p95 regret 0・最大 regret 0.006643（6.64 mEMG）** を達成した（Money cube OFF の 4 局面は 3-ply 全候補評価へバイパスされ **4/4 一致**）。
   - Legacy（実効 2-ply 上限）は Match 74.3%（最大損失 4.42 mMWC）、Money 全体 84.0% / cube ON 81.0%（最大損失 15.36 mEMG）にとどまり、全 200 局面の 20.5% で `staged3ply` が異なる手を選択した。
2. **実戦的な僅差・高分岐局面でのレイテンシがブラウザ既定値として過大**:
   - 1-ply で一意に決まる局面（N=6）では Worker p50 `151.7 ms`（Legacy `166.0 ms` より約 9% 高速）と軽快だが、実際に Stage 2/3 まで深掘りする局面（N=30）では HeadlessChrome 157 上で **Worker p50 `6,318.8 ms` / p95 `9,730.0 ms` / max `9,744.7 ms`**（Legacy 比約 11 倍）、**main-thread fallback で p50 `6,084.6 ms` / p95 `9,217.7 ms` / max `9,253.0 ms`**（Node 実測では staged 適用局面で最大 `25,643.9 ms`、cube OFF バイパスを含めると最大 `25,947.0 ms`）を要する。
   - 毎手 6〜10 秒の待ち時間および main-thread フォールバック時の UI ブロックは、ブラウザ対戦アプリの既定体験として許容し難い。
3. **次のステップ**:
   - 既定 ON にする前に、Worker 限定かつ「世界チャンピオン」段専用の明示的設定への切り出し、または 3-ply 葉計算のさらなる高速化・時間予算制御を検討すべきである。

---

## 2. 計測条件・コード確認結果（Phase 0）

### コードから確認した探索経路・閾値（`docs/backgammon/src/checker.js` / `agent.js`）

- 対象難易度: `champion`（世界チャンピオン：`plies: 3`, `noise: 0`, `maxLoss: Infinity`, `filtersFor(3)`）
- **Legacy (`checkerSearchMode = 'legacy'`)**:
  - `checkerSearchDepth` により、`match.mode === 'match'` または `checkerCubeCanRedouble(position)` が真のとき `depth = Math.min(2, 1) = 1`（実質 2-ply）に制限。
  - Money cube OFF（`cube.enabled === false`）または 64 倍到達（非 unbounded）のみ `depth = 2`（3-ply）。
- **staged3ply (`checkerSearchMode = 'staged3ply'`)**:
  - `stagedMetric(position)`:
    - Match (`match.mode === 'match'`): `firstMargin = 0.010`, `secondMargin = 0.005`（単位: MWC）、候補上限 **1→2-ply 最大 8 手 / 2→3-ply 最大 4 手**。
    - Money cubeful (`cube.enabled && !crawford`): `firstMargin = 0.160`, `secondMargin = 0.080`（単位: equity）、候補上限 **8 / 4**。
    - Money cube OFF: `stagedMetric` は `null` を返し、`depth = 2` の全候補評価にバイパスされる。
  - 1-ply / 2-ply で候補が 1 手に絞られた場合は後続段を打ち切る。root 内で `checkerRollCache`（ND/DT 間 roll 展開共有）と `predictBatch`（raw NN 葉ベクトル重複排除・バッチ推論）を使用。
- **Full-root 3-ply (`checkerSearchMode = 'full-root'`)**:
  - 全合法手を `depth = 2`（3-ply）で評価（`selectCheckerMove` ではなく `scoreCheckerMoves(..., 'full-root')`）。

### 環境・SHA-256

| 項目 | 値 |
| --- | --- |
| Node.js | `v24.13.0` (`linux` / `x64`) |
| CPU | `AMD Ryzen 7 9700X 8-Core Processor` (16 logical cores) |
| Browser | `HeadlessChrome/157.0.0.0` (Windows 10/11 x64) |
| `docs/backgammon/src/model.json` | `9543ecb1deaff716de1355726d3109f1529fe34e0ab68d94284654fd7871dd83` |
| `docs/backgammon/src/bearoff-6x15.bin` | `5f73a69955947d4a9f96b55a38a065a991c903afbf29ba13d093e0feb512f66f` |
| `docs/backgammon/src/money-bg2n-6x6-v4.bin` | `2ddee6d0b8285c8f755e0fe027bb5c66b678269a9dc89427f8ae9921d4a7daa1` |
| `docs/backgammon/src/checker.js` | `7ea8445b6d9c7f414040258e308554970f100994b2c5a58142768463bd40636e` |
| `docs/backgammon/src/agent.js` | `76fc626755196ae46914155a5ed580404ac6428acae598a2872f8a776d582255` |
| `docs/backgammon/src/nn.js` | `f26351be996fa99f994e277e33c274aa65366a2be707d76dbc9c8287b64044df` |
| `docs/backgammon/src/board.js` | `83c139fb76da3288d3f85826317dacf892be71ffb9d3722575fbff4168104366` |
| `docs/backgammon/src/rules.js` | `cd3c987be0e783b1cbdcaa7a891bc967b5bc0c2535327d67470dbab7e8b53aa8` |
| `docs/backgammon/src/met.js` | `e982ba462134510670bd7db7a506801a936a732a140fa57bcbdc413ecea2803d` |
| `docs/backgammon/src/met-table.js` | `c156597442f173bcf14d71defce148c651c1d589e93889d74faf0faed43432db` |
| `docs/backgammon/src/bearoff.js` | `90b22620fb9aa1b32dc7a26e6a5e50ddc42780613631c7b469369d7496af83c5` |
| `docs/backgammon/src/money-bearoff.js` | `e1965efc30230b1026147c2a98569cd378eb5dd576cc9de69e1d86610202d97d` |
| `docs/backgammon/src/game.js` | `7e706beabc4b500c494e3bd66e65f46b1eeb2da27522cd1e184f305b09acd816` |
| `docs/backgammon/src/cube.js` | `d9664cad6d228a71ff76d8ea1f4518d5fbf5f8c17ff4e7013e07084b23fbac09` |
| `tools/eval-staged3ply.mjs` | `5ff113ab73f49ced8bea1b88b16870e598db490cedf949579b587f67247266e3` |
| `tests/backgammon/staged-3ply-eval-fixtures.json` | `5ee8eee432ed0ffe1f2b1fa238dc313e8b1d2019f341072a9713f7b815c1d5bb` |

---

## 3. Fixture 構成（200 局面 + 27 キューブ局面）

生成スクリプト: `tools/build-staged3ply-eval-fixtures.mjs`（PRNG seed: `20261114`）

- **カテゴリ別内訳（200 局面）**: `opening` 31 / `contact` 37 / `tactical-contact` 35 / `prime` 35 / `backgame` 20 / `race` 12 / `bearoff` 30
- **由来**: 初期盤面 20 / 自己対局 125 / `parity.json` 55
- **層別文脈（各 20 局面、計 10 層）**:
  - Money (100): `money-center-jacoby`, `money-center-nojacoby`, `money-owned-white`, `money-owned-black`, `money-cube-off`
  - Match (100): `match-normal-center`, `match-normal-owned`, `match-dmp`, `match-crawford`, `match-post-crawford`
- **Full-root 3-ply 参照サブセット（60 局面: Money 25 / Match 35）**:
  - 計算コストの制約（60 局面を 10 並列 `worker_threads` で 438.7 秒、1 局面最大 284.9 秒）により、全カテゴリ・全層から Stage 2/3 到達局面を中心に代表 60 局面を選定。未実行の 140 局面について Legacy や別深度を正解扱いしない。

---

## 4. 品質・regret・探索段階到達結果（Node 計測）

### 4.1 着手一致率・regret（Full-root 60 局面対比、手番側評価値）

| 評価単位 | 対象数 | Staged vs Full-root 一致率 | Legacy vs Full-root 一致率 | Staged regret (p50 / p90 / p95 / max / mean) | Legacy regret (p50 / p90 / p95 / max / mean) |
| --- | ---: | ---: | ---: | --- | --- |
| Money equity（全体） | 25 | **96.0%** (24/25) | 84.0% (21/25) | `0` / `0` / `0` / **`0.006643`** / `0.000266` | `0` / `0.006643` / `0.012279` / **`0.015364`** / `0.001563` |
| Money equity（cube ON: staged 適用） | 21 | **95.2%** (20/21) | 81.0% (17/21) | `0` / `0` / `0` / **`0.006643`** / `0.000316` | `0` / `0.006643` / `0.012279` / **`0.015364`** / `0.001861` |
| Money equity（cube OFF: staged バイパス） | 4 | **100.0%** (4/4) | 100.0% (4/4) | `0` / `0` / `0` / **`0`** / `0` | `0` / `0` / `0` / **`0`** / `0` |
| Match MWC | 35 | **100.0%** (35/35) | 74.3% (26/35) | `0` / `0` / `0` / **`0`** / `0` | `0` / `0.001739` / `0.003658` / **`0.004424`** / `0.000432` |

- `money-cube-off` の 4 局面（`F085`, `F115`, `F135`, `F145`）は `stagedMetric() === null` により 3-ply 全候補評価（Legacy と同経路）へバイパスされる対照群であり、staged 選別自体の品質は cube ON 21 局面（一致率 95.2%、Legacy 比 +14.2pt）および Match 35 局面（一致率 100.0%、Legacy 比 +25.7pt）で評価できる。
- 全 200 局面での Legacy vs staged3ply 一致率: **79.5%（159/200）**（20.5% で着手が変化）。

### 4.2 大きな regret が出た局面と原因分析

60 局面の Full-root 参照比較で `stagedRegret > 0` となったのは **1 局面のみ（`F144`）**：

- **Fixture `F144`**: `race` / `money-owned-black` / `BLACK` 4-3 / 合法手 26 手 / `stagedRegret = 0.006643`（6.64 mEMG）
- **原因（2-ply 評価の揺れ + 2→3-ply 上限 `cap=4` による脱落）**:
  - 1-ply では Full-root 最善手 `idx=2`（0.740977）が 2 位で余裕を持って Stage 2（8 手）を通過。
  - 2-ply 評価では `idx=1`（0.762199）が 1 位、`idx=2`（0.748555、1 位差 `0.013644`）は `secondMargin = 0.080` 以内に収まっていたにもかかわらず、順位が **5 番目** だったため、**最大 4 手上限（`cap=4`）** により Stage 3 から足切りされた。
  - 3-ply では `idx=1` の評価が 0.730234 まで低下し、`idx=2`（Full-root 3-ply 値 0.736877）が逆転最善手となった。

### 4.3 各探索段階への到達率・候補削減数（staged 適用 180 局面）

※ `money-cube-off` 20 局面は `stagedMetric === null` のため 3-ply 全候補評価へバイパス。

- **Stage 1 で一意終了（`maxAdditionalDepth = 0`）**: 27 / 180（**15.0%**）
- **Stage 2 で終了（`maxAdditionalDepth = 1`）**: 23 / 180（**12.8%**）
- **Stage 3 まで到達（`maxAdditionalDepth = 2`）**: 130 / 180（**72.2%**）（Stage 2 以上到達は 85.0%）
- **平均候補数削減**: 1-ply `29.93` 手 → 2-ply `5.13` 手 → 3-ply `2.52` 手
- **Stage 3 到達局面でのキャッシュ・バッチ効果（1 局面平均）**: `rollExpansionHits` 14,391.0 / `rollExpansionMisses` 6,337.6 / `batchCalls` 216.2 / `batchVectors` 5,511.1

### 4.4 カテゴリ別サマリ（Node 計測）

| カテゴリ | N | Legacy=Staged | Stage3 到達 / 適用 | Full-root N | Staged=FR | Legacy=FR | Node p50 (Legacy / Staged ms) | Node max (Legacy / Staged ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `opening` | 31 | 25/31 | 19/27 | 13 | 13/13 | 8/13 | 374.6 / 6,924.6 | 22,872.3 / 23,892.3 |
| `contact` | 37 | 26/37 | 22/33 | 8 | 8/8 | 6/8 | 422.6 / 4,672.5 | 12,567.6 / 15,633.0 |
| `tactical-contact` | 35 | 29/35 | 21/32 | 8 | 8/8 | 5/8 | 575.4 / 3,978.4 | 8,572.5 / 18,721.6 |
| `prime` | 35 | 26/35 | 23/32 | 8 | 8/8 | 7/8 | 276.1 / 1,883.9 | 13,707.1 / 18,880.0 |
| `backgame` | 20 | 17/20 | 13/18 | 8 | 8/8 | 7/8 | 343.1 / 4,401.5 | 25,759.5 / 25,947.0 |
| `race` | 12 | 11/12 | 10/11 | 7 | 6/7 | 6/7 | 513.0 / 9,156.8 | 25,598.0 / 25,643.9 |
| `bearoff` | 30 | 25/30 | 22/27 | 8 | 8/8 | 8/8 | 23.9 / 499.7 | 18,626.4 / 18,519.6 |

### 4.5 代表キューブ 27 局面の確認

- `cubePositions` 27 局面（Money 12 / Match 15、ND/DT/Take/Pass 境界を含む）において、`shouldDouble` / `shouldAcceptDouble` の判定差は **0 件**（キューブ判断自体は `checkerSearchMode` を使わない別経路のため同一）。
- 同じ 27 局面でのロール後チェッカー着手選択も **27/27 で Legacy と staged3ply が一致**した（評価値自体は深さの違いにより最大 `0.3648` 差が出た局面あり）。

---

## 5. ブラウザ実測レイテンシ（HeadlessChrome 157）

計測条件: 代表 12 局面 × warm-up 2 局面後 各 3 反復（計 36 サンプル/経路）。`main-thread`・`worker` の両方で各局面実行前に `checkerLastStagedSearch` を初期化して Worker からも実到達深度を返却させ、全 12 局面で両経路の `maxAdditionalDepth` と選択着手が完全一致することを確認した。

- **Cold-start（初回 1 手）**: `main:legacy` `1,285.1 ms` / `main:staged3ply` `6,032.0 ms` / `worker:legacy` `1,299.5 ms` / `worker:staged3ply` `6,465.0 ms`

| 区分 | 経路 | Legacy (mean / p50 / p95 / max ms) | staged3ply (mean / p50 / p95 / max ms) |
| --- | --- | --- | --- |
| 全体 (N=36) | main-thread | 850.7 / 304.8 / 3,847.0 / 3,867.2 | 4,425.1 / 3,401.1 / 9,217.7 / 9,253.0 |
| 全体 (N=36) | Worker | 910.4 / 322.7 / 4,090.7 / 4,164.0 | 4,610.9 / 3,591.5 / 9,730.0 / 9,744.7 |
| 1-ply 一意終了 (`actualDepth=0`, N=6) | main-thread | 165.3 / 157.2 / 176.4 / 176.4 | 159.9 / 147.6 / 175.9 / 175.9 |
| 1-ply 一意終了 (`actualDepth=0`, N=6) | Worker | 174.0 / 166.0 / 188.7 / 188.7 | **162.5 / 151.7 / 176.8 / 176.8** |
| Stage 2/3 深掘り全体 (`actualDepth>=1`, N=30) | main-thread | 987.8 / 518.3 / 3,847.0 / 3,867.2 | 5,278.1 / 6,084.6 / 9,217.7 / 9,253.0 |
| Stage 2/3 深掘り全体 (`actualDepth>=1`, N=30) | Worker | 1,057.6 / 578.9 / 4,090.7 / 4,164.0 | 5,500.6 / **6,318.8 / 9,730.0 / 9,744.7** |
| Money 深掘り (`actualDepth>=1`, N=15) | main-thread | 1,692.5 / 1,227.3 / 3,867.2 / 3,867.2 | 6,929.1 / 6,838.8 / 9,253.0 / 9,253.0 |
| Money 深掘り (`actualDepth>=1`, N=15) | Worker | 1,810.6 / 1,311.6 / 4,164.0 / 4,164.0 | 7,287.0 / 7,127.5 / 9,744.7 / 9,744.7 |
| Match 深掘り (`actualDepth>=1`, N=15) | main-thread | 283.2 / 232.6 / 597.8 / 597.8 | 3,627.1 / 1,677.6 / 8,812.8 / 8,812.8 |
| Match 深掘り (`actualDepth>=1`, N=15) | Worker | 304.6 / 248.9 / 678.3 / 678.3 | 3,714.2 / 1,742.7 / 8,881.5 / 8,881.5 |

※ Fixture 選定時の簡易 0-ply プローブ（`useCubeHead: false`）で `1ply-unique` タグを付けた `F146`（Match race）が、実探索（Match MWC）では `actualDepth=2` に進んだため、表は `main-thread`・`worker` ともに実行時の実到達深度 `actualMaxAdditionalDepth`（`1ply-unique`: `F183, F020` の 2 局面 N=6、`Match 深掘り`: `F146` を含む 5 局面 N=15）で分類・集計している。

---

## 6. 再現手順・成果物

- **Fixture 生成**: `node tools/build-staged3ply-eval-fixtures.mjs` → `tests/backgammon/staged-3ply-eval-fixtures.json`
- **Node 品質・regret 計測**: `node tools/eval-staged3ply.mjs` → `tests/backgammon/staged-3ply-eval-raw.json`
- **ブラウザ実測**: `BROWSER_PATH="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" node tools/eval-staged3ply-browser.mjs` → `tests/backgammon/staged-3ply-browser-raw.json`
- **既存回帰テスト**: `node tests/backgammon/run.mjs`
