# Issue #587: WASM エンジン先行適用（HTTPS プレビュー実機検証）

- 追跡 Issue: `dj-kusuha/backgammon_engine#587`（Refs `#578`, PR `#586`, ADR-0183）
- 参照 engine SHA: `727ae5559be62b2f8992a37e2fa469fc16123997`
- 固定検証パッケージ版: `@dj-kusuha/backgammon-engine@0.2.8-wasm-preview.727ae55`
- 状態: **検証用 PR（本番 `main` / `miniapp.kusuha.com` へのマージ・デプロイ保留）**

## 目的

Phase 4b のレビュー済み候補（PR `#586` head `727ae55`）を、`miniapp` の独立した検証用ブランチ／本番と分離された HTTPS プレビュー環境へ先行適用し、iPhone Safari 等の実機から証明書設定や LAN 転送なしで通常対局・解析と既存 Phase 4b ハーネスの実機検証を実施できる状態にする。

## スコープと制約

- 本番 URL（`https://miniapp.kusuha.com/`）・`main` ブランチ・公開 `latest` は変更しない。
- 純 JS エンジン実装は削除しない（`?backend=js` でいつでも切り戻し・比較可能）。
- 既存の SHA-256 整合検証（BG2N v4 / Pruning Net / Model）は一切緩めない。
- 既存の Phase 4b 実機検証ハーネス（`browser-harness.mjs` / `harness-worker.mjs`）を `docs/wasm-verify/` へ再利用し、専用ハーネスと `miniapp` 実経路（`ThinkerPool`）の両方を別々に記録する。

## 変更内容

1. `docs/backgammon/assets/`:
   - `bg_engine_scalar.wasm`（272,727 bytes, SHA-256: `2e0a4e5a249ee3d1d4d26ec4045d3dcf6d83f0285aa594521359e7e7edbabfb1`）
   - `bg_engine_simd.wasm`（282,779 bytes, SHA-256: `9b6a43b0bfa1e5ecd22c626277eccdd721ef4b7929251395ce4f895f485929b9`）
   - `metadata.json`（固定 SHA・検証版・全アセット SHA-256）
2. `docs/backgammon/src/`:
   - `wasm-backend.js` を `727ae55` から無改変同期（既定 `'auto'` = WASM 優先、SIMD128 → Scalar → JS フォールバック）。
   - `bearoff.js`, `money-bearoff.js`, `rules.js`, `match.js`, `cube.js`, `game.js`, `agent.js` を `727ae55` へ同期（`miniapp` 固有の `LEVELS` / `blotCount` / `blotPenalty` / `doubleMargin` / `takeMargin` / `checkerSearchMode='legacy'` 既定は維持）。
   - `worker.js` / `thinker-pool.js` / `app.js`: Worker 既定 `'auto'` WASM 起動・`backendStatus` 集約・`?backend=auto|wasm|js` 切替・`dispose()`・`window.__BG_PREVIEW_DIAG__` 診断公開を追加。
3. `docs/wasm-verify/`:
   - 既存 Phase 4b ハーネス（`browser-harness.mjs`, `harness-worker.mjs`, `harness-worker-hooks.mjs`, `fallback-mime/bg_engine_scalar.wasm.bin`, `fixtures/positions.json`）を再利用。
   - `app-route-check.mjs` で `miniapp` 実経路（`ThinkerPool` 4-Worker 並列 `champion` staged3ply・ヒント 2-ply・BG2N 6x6・Match キューブ）を別枠で検証・JSON 記録。
4. `tests/backgammon/wasm-preview.mjs`:
   - 固定 SHA-256・White/Black パリティ・初心者チューニング維持・BG2N キューブの自動回帰テストを追加。

## 完了・本番反映条件

- 本 PR は実機検証ゲート通過とメンテナー承認までマージしない（Draft / 検証限定）。
- iPhone Safari（通常／プライベート）、利用可能な macOS Safari / Android Chrome・Firefox の実機結果およびリモートインスペクタ確認結果を `backgammon_engine#587` / `#586` へ記録した後に正式移行を判断する。
