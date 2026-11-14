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
   - Full-root 3-ply を参照値とした 60 局面比較で、Match（35局面）は **35/35（100.0%）一致・regret 0**、Money（25局面）は **24/25（96.0%）一致・中央値/p90/p95 regret 0・最大 regret 0.006643（6.64 mEMG）** を達成した。
   - Legacy（実効 2-ply 上限）は Match 74.29%（最大損失 4.42 mMWC）、Money 84.00%（最大損失 15.36 mEMG）にとどまり、全 200 局面の 20.5% で `staged3ply` が異なる手を選択した。
2. **実戦的な僅差・高分岐局面でのレイテンシがブラウザ既定値として過大**:
   - 1-ply で一意に決まる局面では Worker p50 `153.5 ms`（Legacy `238.7 ms` より約 36% 高速）と軽快だが、実際に Stage 2/3 まで深掘りする局面では HeadlessChrome 157 上で **Worker p50 `6,218.0 ms` / p95 `9,390.7 ms` / max `9,421.6 ms`**（Legacy 比約 8 倍）、**main-thread fallback で p50 `8,033.8 ms` / max `12,472.1 ms`**（Node 実測では最大 `26,906.4 ms`）を要する。
   - 毎手 6〜12 秒の待ち時間および main-thread フォールバック時の UI ブロックは、ブラウザ対戦アプリの既定体験として許容し難い。
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
| Money equity | 25 | **96.0%** (24/25) | 84.0% (21/25) | `0` / `0` / `0` / **`0.006643`** / `0.000266` | `0` / `0.006643` / `0.012279` / **`0.015364`** / `0.001563` |
| Match MWC | 35 | **100.0%** (35/35) | 74.3% (26/35) | `0` / `0` / `0` / **`0`** / `0` | `0` / `0.001739` / `0.003658` / **`0.004424`** / `0.000432` |

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
| `opening` | 31 | 25/31 | 19/27 | 13 | 13/13 | 8/13 | 425.1 / 7,482.9 | 21,820.4 / 21,760.7 |
| `contact` | 37 | 26/37 | 22/33 | 8 | 8/8 | 6/8 | 426.4 / 4,839.0 | 12,636.5 / 15,925.9 |
| `tactical-contact` | 35 | 29/35 | 21/32 | 8 | 8/8 | 5/8 | 626.2 / 3,949.7 | 8,555.8 / 26,906.4 |
| `prime` | 35 | 26/35 | 23/32 | 8 | 8/8 | 7/8 | 274.9 / 1,968.7 | 13,728.8 / 18,858.9 |
| `backgame` | 20 | 17/20 | 13/18 | 8 | 8/8 | 7/8 | 374.0 / 5,244.1 | 25,806.6 / 32,059.8 |
| `race` | 12 | 11/12 | 10/11 | 7 | 6/7 | 6/7 | 562.4 / 10,916.4 | 25,750.9 / 25,847.1 |
| `bearoff` | 30 | 25/30 | 22/27 | 8 | 8/8 | 8/8 | 30.3 / 595.4 | 18,933.5 / 18,773.9 |

### 4.5 代表キューブ 27 局面の確認

- `cubePositions` 27 局面（Money 12 / Match 15、ND/DT/Take/Pass 境界を含む）において、`shouldDouble` / `shouldAcceptDouble` の判定差は **0 件**（キューブ判断自体は `checkerSearchMode` を使わない別経路のため同一）。
- 同じ 27 局面でのロール後チェッカー着手選択も **27/27 で Legacy と staged3ply が一致**した（評価値自体は深さの違いにより最大 `0.3648` 差が出た局面あり）。

---

## 5. ブラウザ実測レイテンシ（HeadlessChrome 157）

計測条件: 代表 12 局面 × warm-up 2 局面後 各 3 反復（計 36 サンプル/経路）。

- **Cold-start（初回 1 手）**: `main:legacy` `1,309.3 ms` / `main:staged3ply` `8,299.4 ms` / `worker:legacy` `1,861.1 ms` / `worker:staged3ply` `8,502.0 ms`

| 区分 | 経路 | Legacy (mean / p50 / p95 / max ms) | staged3ply (mean / p50 / p95 / max ms) |
| --- | --- | --- | --- |
| 全体 (N=36) | main-thread | 1,179.5 / 432.2 / 5,264.2 / 5,377.3 | 5,881.6 / 4,526.8 / 12,377.3 / 12,472.1 |
| 全体 (N=36) | Worker | 1,212.2 / 422.3 / 5,508.7 / 5,513.4 | 4,731.8 / 3,473.0 / 9,390.7 / 9,421.6 |
| 1-ply 一意終了 (`actualDepth=0`, N=6) | main-thread | 220.7 / 211.5 / 246.6 / 246.6 | 216.3 / 211.7 / 238.6 / 238.6 |
| 1-ply 一意終了 (`actualDepth=0`, N=6) | Worker | 234.9 / 238.7 / 266.1 / 266.1 | **163.8 / 153.5 / 180.0 / 180.0** |
| Stage 2/3 深掘り (`actualDepth>=1`, N=30) | main-thread | 1,371.3 / 729.4 / 5,264.2 / 5,377.3 | 7,014.6 / 8,033.8 / 12,377.3 / 12,472.1 |
| Stage 2/3 深掘り (`actualDepth>=1`, N=30) | Worker | 1,407.7 / 770.2 / 5,508.7 / 5,513.4 | 5,645.4 / **6,218.0 / 9,390.7 / 9,421.6** |

※ 初期設計時に `1ply-unique` タグを付けた `F146`（Match race）が実測では `actualDepth=2` に進んだため、表は実行時の実深さ `actualDepth` で再集計した値を示す。

---

## 6. 再現手順・成果物

- **Fixture 生成**: `node tools/build-staged3ply-eval-fixtures.mjs` → `tests/backgammon/staged-3ply-eval-fixtures.json`
- **Node 品質・regret 計測**: `node tools/eval-staged3ply.mjs` → `tests/backgammon/staged-3ply-eval-raw.json`
- **ブラウザ実測**: `BROWSER_PATH="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" node tools/eval-staged3ply-browser.mjs` → `tests/backgammon/staged-3ply-browser-raw.json`
- **既存回帰テスト**: `node tests/backgammon/run.mjs`
