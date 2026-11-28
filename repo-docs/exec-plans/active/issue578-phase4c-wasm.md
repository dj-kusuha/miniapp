# 実行計画: Issue #578 Phase 4c — miniapp バックギャモン WASM エンジン本番移行

- 関連: `dj-kusuha/backgammon_engine#578`, `#586` (マージ済み `a1ec1da`), `#587` (iPhone Safari 実機検証完了), ADR-0183
- 前提: 検証用 Draft PR #72 + 隔離プレビュー `miniapp-wasm-preview` にて実機 iPhone Safari（iOS 18.7 / Safari 27.2・通常＆プライベート双方）で全自動スイート・`ThinkerPool` 4-Worker 実経路・4w BG2N 持続セッション（24〜48 秒バックグラウンド復帰 4 点生存確認含む）の全 PASS を確認済み。

## 目的とスコープ

1. `docs/backgammon/assets/` に `0.2.8` の `bg_engine_scalar.wasm` / `bg_engine_simd.wasm` / `metadata.json` を配置し、`docs/backgammon/src/` と `app.js` を既定 `'auto'`（WASM 優先・SIMD128 → Scalar → 純 JS 自動フォールバック）へ移行する。
2. 切り戻し手段（`?backend=js` クエリ指定・純 JS エンジン実装）を維持し、Phase 4d（純 JS 削除）は本 PR のスコープ外とする。
3. 検証専用の `docs/wasm-verify/` は本番公開対象から除外する。
4. `tests/backgammon/wasm-backend.mjs` を追加・`run.mjs` へ登録し、Node テストおよび Playwright（Chromium / WebKit）で通常起動・`?backend=js` 切り戻し・コンソールエラー 0 を確認する。

## 完了条件

- [x] `docs/backgammon/` への WASM 資産・ソース同期（`miniapp` 固有の初心者設定・`checkerSearchMode='legacy'` 既定維持）
- [x] `tests/backgammon/wasm-backend.mjs` 追加・既存テスト全件 PASS
- [x] ローカル HTTP 配信での Playwright（Chromium / WebKit）起動・既定 WASM・`?backend=js` 切り戻し・コンソールエラー 0 確認
- [ ] PR マージ後、一時公開プレビューリポジトリ `dj-kusuha/miniapp-wasm-preview` を削除する
