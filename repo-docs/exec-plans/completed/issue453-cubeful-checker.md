## Title

Issue #453: CPU着手・ヒントへcubeful/MET-MWC評価を接続する

## Status

completed

## Background

miniappのキューブ判断はMatch MET/MWCを使う一方、CPU着手とヒントはcubeless equityで候補を並べている。Issue #453に従い、engine公開JS facadeのchecker評価契約を参照して実行経路を統一する。

## Scope

- Money cube ONのcubeful checker評価、MatchのMET/MWC評価、cube OFFとCrawfordの固定cube評価をCPU着手・ヒントへ接続する。
- Workerとmain-thread fallbackへ同一の盤面、手番、出目、cube enabled/available/value/owner、Match score/target/Crawford、Jacoby contextを渡す。
- MWCとMoney cube-unitのloss表示を区別し、NNの5出力確率は参考値として維持する。
- 手計算MET fixture、context parity、CPU/Hint/Worker parity、代表局面の速度測定を追加する。

## Non-Scope

- backgammon_engine、trainer、モデル重み、XG教師の変更。
- 外部GNUbg/XG評価値への一致や大規模対局の強さ主張。

## Acceptance Criteria

- MatchのCPU着手・ヒントは常にMET/MWC、Moneyでcube ONならcubefulで同じ候補値を使う。
- cube OFFとCrawfordはfuture doubleを無効にし、MatchはMWCを保つ。
- Workerとfallbackの同条件で候補値・順位が一致し、既存cubelessの呼び出し互換が保たれる。
- 5ptの手計算fixtureでシングル/ギャモン価値、対称性、cube owner/value、Crawford/post-Crawford、terminalを検証する。
- 0/2/3-plyのp50/p95測定を記録し、遅い経路をcubelessへ黙って落とさない。
- 弱い段のnoise/maxLossは候補採点へ重ねず、Match/Money cube ON/OFFそれぞれの評価値へ換算して選択する。

## Steps

1. 最新miniapp mainのAgent/Match/Worker/UIとengine同期契約を監査する。
2. 共通checker評価adapterとDTOを追加し、CPU/Hint双方をWorker/fallbackで同じ入口に接続する。
3. MWC/cubeful fixtureと回帰テストを追加し、Hintのloss単位を表示する。
4. 全Backgammonテストと0/2/3-plyの速度測定を行い、必要なら評価値を保つ小さな高速化を行う。
5. 記録をcompletedへ移し、変更をコミットしてminiapp PRを作成する。

## Decision Log

- 2026-11-03: `miniapp` origin/main `74041ba` から専用worktreeを作成。Issue #453の対象はminiappのみ。
- 2026-11-03: checker値の契約はengine公開`facade.js`（`fb194be049bdd4167c147f8d9113d59c6d92e291`）を参照し、5-vector確率と評価値を別項目に保つ。miniapp baseは`74041ba05767373e0c2a0ba95d689fac754b716d`、model SHAはengine / miniapp共通で`9543ecb1deaff716de1355726d3109f1529fe34e0ab68d94284654fd7871dd83`。
- 2026-11-03: 初期局面3-1のMoney cubeful 3-plyは1標本約122秒、Match cube OFFの3-ply固定MWCはp50約29.7秒だったため、Match MWCとMoney cubefulのafterstate探索を最大1ロールに制限する。Money cube OFFの通常checker探索はprofile深度を保つ。
- 2026-11-03: PR reviewで弱い段のnoiseがcube-aware葉評価と選択後に二重加算され、cubeless equityの`maxLoss`もMWC/cube-unitsへ直接加算される問題を確認。採点をnoise-freeにし、選択時だけnoise/maxLossを勝率ベクトルへ反映して同じ評価経路で再採点する。
- 2026-11-03: 非ブロッカーの性能指摘に応じ、ヒット候補と連続プライムを含む接触局面をWorkerで追加計測する。

## Validation

- `node tests/backgammon/run.mjs`
- `node tests/backgammon/checker-context.mjs`
- `node tests/backgammon/checker-performance.mjs`
- `node tests/backgammon/checker-performance-browser.mjs`
- PR review回帰: 弱い段のMatch/Money cube ON/OFF、maxLoss換算、Black視点
- 接触局面の候補数・ヒット候補数、3-plyと弱い段のWorker select/Hint p50/p95

### Performance result

Node v24.22.1 on Windows; initial board, White 3-1, 16 candidates; 3 samples per cell.
Values are wall-clock p50 / p95 in milliseconds. p95 uses the largest of the three samples.

| Profile | Money cubeful + Jacoby | Match MWC cube ON (5pt 3-3) | Match MWC cube OFF (5pt 3-3) |
| --- | ---: | ---: | ---: |
| 0-ply | 242 / 257 | 246 / 251 | 0.70 / 0.75 |
| 2-ply | 304 / 305 | 296 / 306 | 243 / 260 |
| 3-ply | 312 / 312 | 293 / 300 | 238 / 245 |

Node process CPU time p50 / p95 in milliseconds:

| Profile | Money cubeful + Jacoby | Match MWC cube ON (5pt 3-3) | Match MWC cube OFF (5pt 3-3) |
| --- | ---: | ---: | ---: |
| 0-ply | 281 / 344 | 250 / 266 | 0 / 0 |
| 2-ply | 297 / 313 | 296 / 297 | 234 / 235 |
| 3-ply | 329 / 343 | 312 / 313 | 235 / 250 |

Headless Edge 156.0.0.0 on Windows; same board and scenarios; 1 warmup and 3 samples per cell.
Values are wall-clock p50 / p95 in milliseconds.

| Profile | Money cubeful + Jacoby | Match MWC cube ON (5pt 3-3) | Match MWC cube OFF (5pt 3-3) |
| --- | ---: | ---: | ---: |
| 0-ply | 166 / 166 | 162 / 168 | 0.5 / 0.5 |
| 2-ply | 186 / 188 | 198 / 201 | 163 / 164 |
| 3-ply | 183 / 184 | 187 / 188 | 161 / 161 |

The same Edge run exercised the actual module Worker `select` and `rank` requests. At 3-ply,
the select / rank wall-clock p50 / p95 values were:

| Scenario | Worker select | Worker Hint rank |
| --- | ---: | ---: |
| Money cubeful + Jacoby | 188 / 188 | 189 / 190 |
| Match MWC cube ON (5pt 3-3) | 193 / 194 | 193 / 197 |
| Match MWC cube OFF (5pt 3-3) | 161 / 162 | 164 / 165 |

While the Worker processed 11.5 seconds of requests, a 10ms main-thread timer fired 1,145 times;
the UI event loop kept running during checker work.

The actual 5pt `Match` / `Game` Worker smoke ran CPU selection and Hint ranking at 3-3 pre-Crawford,
4-3 Crawford, and 4-4 post-Crawford. Applying terminal legal moves and calling `Match.sync()`
verified the 3-3 → 4-3 → 4-4 score transitions and cube-enabled state in each following game.

Before the depth cap, one Money cubeful 3-ply sample took about 122 seconds; fixed-cube Match MWC
3-ply took p50 about 29.7 seconds. With the cap, all Match MWC and Money cubeful 3-ply cases
finish around 0.24–0.32 seconds on this position. This is a targeted Node measurement, not a
browser-wide benchmark; the browser tables measure the checker module and actual Worker path in
headless Edge. Worker/fallback parity and UI integration are covered by `run.mjs`.

`tests/backgammon/run.mjs` passed after these changes: 136 Worker decisions matched the main-thread
reference (80 cube decisions included), the 5pt Match smoke passed, and all listed tests ended with
`すべて一致しました`.

`checker-performance-browser.mjs` also completed successfully in headless Edge, and
`git diff --check` passed before commit.

### PR review follow-up

PR #64のレビューで、弱い段のnoiseがMatch MWC / Money cubeful経路で葉評価と選択後の両方に入り、
`maxLoss`もcubeless equityからMWC / cube-unitsへ直接加算されていた点を修正した。
候補採点をnoise-freeにし、選択時のnoise/maxLossを候補の5-vector勝率へ適用して
同じchecker目的関数で再評価する。テストではMatch/Money cube ON/OFFとBlack視点を確認する。

Headless Edge 156の実Workerで、連続プライムとブロットを含む接触局面（White 3-1、23候補、
うち10候補がhit）を各3回測定した。p50 / p95 wall-clock milliseconds:

| Level | Scenario | Worker select | Worker Hint rank |
| --- | --- | ---: | ---: |
| Beginner 0-ply | Money cubeful + Jacoby | 1207.4 / 1220.7 | 700.6 / 702.2 |
| Beginner 0-ply | Match MWC cube ON | 1204.8 / 1207.0 | 700.4 / 774.9 |
| Beginner 0-ply | Match MWC cube OFF | 1.0 / 1.0 | 0.6 / 0.7 |
| Champion 3-ply | Money cubeful + Jacoby | 871.1 / 874.9 | 872.7 / 889.2 |
| Champion 3-ply | Match MWC cube ON | 874.6 / 876.1 | 872.6 / 873.9 |
| Champion 3-ply | Match MWC cube OFF | 700.6 / 707.3 | 702.9 / 755.1 |

The full browser benchmark processed Worker requests for 46.5 seconds while the 10ms main-thread timer
fired 4,642 times. The UI event loop remained responsive. `node tests/backgammon/run.mjs` passed;
Worker decisions matched 136/136 (80 cube decisions), and `checker-context.mjs` passed 12/12.

## Delivery

- miniapp PR: https://github.com/dj-kusuha/miniapp/pull/64
- implementation commit: `eb7ed1daff98866f44da1defdf88eec882b0b65a`
- backgammon_engine #453にPR URLと実測・テスト結果をコメント済み。
