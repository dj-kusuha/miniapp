# Execution Plan: staged3plyの局面別品質・regretと実行時レイテンシ検証 (Issue #549)

## Title

staged3plyの実局面品質・regretおよびブラウザ実行時レイテンシ検証

## Status

completed

## Background

miniapp PR #68 で段階選別 3-ply 探索（`?checker-search=staged3ply`）と推論共有を導入したが、現在は既定 OFF のままである。`backgammon_engine` Issue #549 をトラッカーとして、多様な実局面（200件）と Money / Match の層別文脈で Legacy / staged3ply / Full-root 3-ply を比較し、既定 ON にする価値があるか（adopt / reject / more-evidence）を判断する。

## Scope

- 最新 `main`（`1e55789`）の `checker.js` / `agent.js` / `worker.js` / `nn.js` の実装・閾値・探索経路を確認し、SHA と共に記録する。
- 200件の合法で再現可能な固定 fixture セットと 27件のキューブ境界局面を作成する。
- 同一 fixture・同一モデル・同一評価設定（`champion`, `noise=0`）で Legacy / staged3ply / Full-root 3-ply（代表 60 局面）を比較計測する。
- 選択着手一致率、Full-root に対する regret（Money equity と Match MWC を別集計）、大 regret 局面の原因分析、探索段階到達率・候補削減数、代表 cube 局面の判断差を集計する。
- Headless Chrome 上で browser main thread / Worker 別の warm-up 後 p50 / p95 / max latency（および cold-start）を計測する。
- 再現用 fixture・計測スクリプト・raw 結果・日本語 RESULTS を保存し、PR を作成する。

## Non-Scope

- `staged3ply` の閾値変更や既定 ON への変更
- モデルの再学習や評価関数・通常キューブ探索ロジックの変更
- 数千〜数万局の長時間自己対局

## Acceptance Criteria

- [x] 200局面の固定 fixture セットと再現スクリプトが揃っている
- [x] Legacy / staged3ply / Full-root の品質比較（一致率・regret・段階到達率・候補削減数・大 regret 原因・cube 判断差）が取得されている
- [x] browser main thread / Worker 別の latency（p50 / p95 / max）が深掘り有無別に取得されている
- [x] モデル / evaluator / DB / fixture の SHA と再現コマンドが記録されている
- [x] 日本語 RESULTS（`repo-docs/references/issue549-staged-3ply-results.md`）に `reject` 提案と理由が記載されている
- [x] 既存の `tests/backgammon/run.mjs` がすべてパスする

## Steps

1. 既存テストとブラウザ実行環境（Windows Chrome）の動作確認（完了）
2. 固定 fixture（200局面 + 27キューブ局面）の生成（完了）
3. Node 上で Legacy / staged3ply / Full-root（60局面）の品質・regret・段階統計を計測（完了）
4. Headless Chrome 上で main thread / Worker 別の latency ベンチマークを計測（完了）
5. raw 結果・日本語 RESULTS（`repo-docs/references/issue549-staged-3ply-results.md`）を保存し、PR を作成

## Decision Log

- 2026-11-14: `main` (`1e55789`) にて `stagedMetric` が Match MWC `0.010/0.005`、Money cubeful `0.160/0.080`、候補上限 `8/4` であることをコードから確認。
- 2026-11-15: Full-root 60局面で Match 100% 一致・regret 0、Money 96% 一致・最大 regret 0.006643 と品質は高い一方、Stage 2/3 到達時のブラウザ応答が Worker p50 6.2s / p95 9.4s（main-thread 最大 12.5s ブロック）であるため、既定 ON 化は **`reject`（既定 OFF / opt-in 維持）** を提案する。

## Validation

- `node tests/backgammon/run.mjs`（全件一致）
- `node tools/eval-staged3ply.mjs`（`tests/backgammon/staged-3ply-eval-raw.json` 生成）
- `BROWSER_PATH="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" node tools/eval-staged3ply-browser.mjs`（`tests/backgammon/staged-3ply-browser-raw.json` 生成）
