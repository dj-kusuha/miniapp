# 実行計画: 実効3-ply段階選別と探索共有（Issue #544）

## Status

active

## Background

engine production `main`（参照SHA `b2bedb479876162efb48262d612530d8ffe20ad9`、PR #548取込後）にはMoney cubefulの1→2→3-ply段階選別とroot内のroll展開・NN葉ベクトル共有がある。miniappはMatch/Money cubeful checkerのafterstate探索を最大1ロールへ制限しており、実効3-plyではない。

## Purpose

全合法手の1-ply評価で候補を選別し、2-ply、3-plyへ段階的に進める。engineと同じ評価尺度・閾値を使い、full-root 3-plyとの品質差、従来構成との速度差を測って既定値を判断する。

## Scope

- Match MWCは1→2-plyで差0.010以内・最大8手、2→3-plyで差0.005以内・最大4手を評価する。
- Money cubefulは1→2-plyでequity差0.160以内・最大8手、2→3-plyで差0.080以内・最大4手を評価する。旧0.010/0.005閾値は使わない。
- Money / Matchの実効afterstate深度を最大2ロールまで許し、全root・段階選別を個別に比較する。
- ND / DTは同じafterstate・手番・cube文脈が同一の範囲でroll展開を共有する。NN葉はcube文脈に依存しない生の出力ベクトルだけを共有・batch化する。
- full-root 3-plyを基準に、着手差とregretをMatch/Money/Crawford/cube OFF/beginnerで記録する。
- Workerとmain-thread fallbackの平均/p50/p95/最大応答時間、常駐・peakメモリを測り、従来構成と3-ply構成を比較する。
- 品質・速度が十分と判断できない場合は既定OFFとし、設定から切り戻せるようにする。

## Non-Scope

- engine探索尺度・cube/METルールの変更
- BG2N v4実装（Issue #543 / PR #67）
- 未計測の環境で3-plyを既定ONにすること

## Acceptance Criteria

- Worker/main-thread両方でMoneyとMatchの実効3-plyを確認でき、探索呼出し回数・実際の深さが1-roll上限に留まらない。
- Match/Moneyの候補選別閾値・上限がengine設定と一致する。Moneyで0.010/0.005を使わない。
- ND/DT共有でcube owner/value/action/Jacoby/cash context依存の最終値を誤共有しない。
- NNバッチ出力は単発predictと許容差内で一致し、engine fixtureの最終評価・推奨手・cube判断に差がない。
- full-root/stagedの着手差・regret、Worker/main-threadの平均/p50/p95/最大時間・メモリを記録する。
- 回帰テストでMoney/Match/Crawford/cube OFF/beginner/hintsを維持する。採否を記録し、自動マージせず日本語PRを作る。

## Steps

1. engine #548のstaged selectorとMoney root reuseをJS探索構造へ対応付ける。
2. 実効3-plyと段階候補選別をfeature flag下で実装する。
3. roll expansion共有と生NN vectorの一括評価・重複排除を実装する。
4. engine値パリティ、full-root/staged品質、Worker/main fallback速度・メモリ、回帰を計測する。
5. 結果・採否・残課題・参照SHAを記録してPRを作りengine Issue #544へ報告する。

## Decision Log

- 2026-11-11: #544は#543のPR #67から分岐し、Money BG2N併用時も計測する。
- 2026-11-11: #548は「ND/DTの最終equity共有」ではなく、roll展開とraw NN葉ベクトルの再利用を参照し、キューブ文脈依存値はキャッシュしない。

## Measurements (2026-11-12)

Reference engine SHA: `b2bedb479876162efb48262d612530d8ffe20ad9`.
Browser: HeadlessChrome 157, Windows 11, `checker-staged-browser.mjs`, 20 warmed response samples per path.
Memory snapshots use CDP `Runtime.getHeapUsage` after `HeapProfiler.collectGarbage`; the BG2N byte buffer is also recorded directly.

### Full-root and staged quality

| Root/context | Legal moves | Legacy action | Full-root action | Staged action | Regret | Legacy ms | Full-root ms | Staged ms | Deepest stage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Opening, Money cubeful/Jacoby, White 3-1 | 16 | 5 | 5 | 5 | 0 | 292.11 | 81,227.25 | 237.87 | 1-ply unique |
| Opening, 5-point Match MWC, White 3-1 | 16 | 5 | 5 | 5 | 0 | 272.48 | 80,439.96 | 236.64 | 1-ply unique |
| Five-checker BG2N root, Money cubeful/Jacoby, White 3-1 | 2 | 0 | 0 | 0 | 0 | see browser table | see browser table | see browser table | 3-ply, 2 candidates |

The opening comparisons run in Node v24 on this Windows host. For both opening roots, the 1-ply shortlist was already unique, so those timings do not exercise the deeper stages. The five-checker Money root uses the #543 BG2N database, runs both candidates to 3-ply, matches full-root exactly, and has zero regret. A separate flat-output probe forces both Money and Match through two afterstate rolls and asserts the 8/4 candidate caps, ND/DT roll hits, and batched raw vectors.

### Browser response time

Money is measured on the five-checker BG2N root; Match is measured on the initial board. Each cell is mean / p50 / p95 / max milliseconds.

| Context | Path | Legacy | Staged 3-ply |
| --- | --- | ---: | ---: |
| Money BG2N, main thread | main-thread fallback | 1.46 / 1.40 / 1.70 / 3.20 | 6.90 / 6.30 / 10.70 / 12.90 |
| Money BG2N, Worker | Worker round-trip | 1.23 / 1.20 / 1.50 / 1.50 | 7.14 / 7.10 / 7.60 / 8.10 |
| Match MWC, main thread | main-thread fallback | 180.49 / 180.00 / 183.80 / 189.60 | 166.70 / 165.50 / 182.70 / 188.40 |
| Match MWC, Worker | Worker round-trip | 193.94 / 188.90 / 211.80 / 254.10 | 175.49 / 168.60 / 198.60 / 259.80 |

Worker and fallback selected the same move in all four paths. The Money 3-ply run used the exact 0.160/0.080 equity stages and reached `maxAdditionalDepth: 2`; the Match opening selected one candidate at 1-ply and did not deepen. The BG2N cube decision was `true` in both Worker and main-thread checks.

### Memory after forced GC

Used V8 heap / ArrayBuffer backing storage in bytes, after the 20-sample checker runs. The BG2N file is 10,223,244 bytes; its backing storage remains about 10.69 MB in both Worker and main-thread paths.

| Context | Path | Legacy | Staged 3-ply |
| --- | --- | ---: | ---: |
| Money BG2N | main thread | 1,788,488 / 10,693,983 | 1,848,052 / 10,693,983 |
| Money BG2N | Worker | 827,252 / 10,693,261 | 953,216 / 10,693,261 |
| Match MWC | main thread | 1,895,896 / 470,739 | 1,890,888 / 470,739 |
| Match MWC | Worker | 765,012 / 470,010 | 728,932 / 470,266 |

### Validation and remaining work

- `node tests/backgammon/checker-staged-3ply.mjs`: full-root/staged action and regret comparisons plus a deterministic real-depth probe passed. The probe confirms two afterstate rolls for Match/Money and asserts ND/DT expansion hits and `predictBatch` leaf vectors.
- `node tests/backgammon/checker-staged-browser.mjs`: Worker and main-thread fallback agree on moves in both Money and Match; Worker/main Money BG2N cube decisions agree. Twenty warmed samples per path produced the response-time and forced-GC memory results above.
- `node tests/backgammon/run.mjs`: **all tests passed**, including 64 NN fixtures, cube/MWC parity, 63 bearoff cases, 140 Worker/main checks, Money BG2N engine fixtures and lazy Worker loading, Crawford, cube OFF, beginner levels, hint rankings, and UI wiring.
- `git diff --check`: passed.
- `predictBatch` matched `predict` on all 64 fixture vectors; the reported maximum included fixture comparison was `5.70e-7` and the batch parity tolerance test passed.
- Engine Money root and cube fixtures from #543 are retained; BG2N + staged 3-ply also matched full-root on the five-checker Money position.
- Remaining quality work is to add a wider set of contact, race, Crawford, cube-OFF, and high-candidate positions before considering default-on. Current measurements justify keeping the mode opt-in.

### Adoption decision

Keep staged 3-ply **opt-in and default OFF**. The measured Match position improves mean response time by about 7–10% while preserving the selected move, but the Money endgame root that genuinely reaches 3-ply is about 5–6 times slower than the 1-ply legacy path. The opening fixtures also show that the 82-second full-root path is not viable in this browser-oriented app. These are useful parity and performance fixtures, not a broad world-champion quality set; do not enable staged mode by default until more contact, race, Crawford, cube-OFF, and high-candidate positions are measured.

Implementation and verification are complete. The #544 change will be a separate stacked PR based on #543 and will remain open for review; neither PR is auto-merged.

- 2026-11-12: 開局の全候補full-rootは約80秒かかり、Money BG2Nの3-ply終盤fixtureはlegacyより約5–6倍遅かったため、段階選別は既定OFF・URL opt-inで提出する。
