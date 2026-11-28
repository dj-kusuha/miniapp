# 実行計画: Issue #578 Phase 4c — miniapp バックギャモン WASM エンジン本番移行

- 関連: `dj-kusuha/backgammon_engine#578`, `#586` (マージ済み `a1ec1da`), `#587` (iPhone Safari 実機検証完了), ADR-0183
- 前提: 検証用 Draft PR #72 + 隔離プレビュー `miniapp-wasm-preview` にて実機 iPhone Safari（iOS 18.7 / Safari 27.2・通常＆プライベート双方）で全自動スイート・`ThinkerPool` 4-Worker 実経路・4w BG2N 持続セッション（24〜48 秒バックグラウンド復帰 4 点生存確認含む）の全 PASS を確認済み。

## 目的とスコープ

1. `docs/backgammon/assets/` に `0.2.8` の `bg_engine_scalar.wasm` / `bg_engine_simd.wasm` / `metadata.json` を配置し、`docs/backgammon/src/` と `app.js` を既定 `'auto'`（WASM 優先・SIMD128 → Scalar → 純 JS 自動フォールバック）へ移行する。
2. 切り戻し手段（`?backend=js` クエリ指定・純 JS エンジン実装）を維持し、Phase 4d（純 JS 削除）は本 PR のスコープ外とする。
   - **URL クエリ契約（`?backend=auto|wasm|js`）**:
     - 未指定 / `auto`: Worker プールは WASM 優先（失敗時 JS 自動フォールバック）、Worker 稼働中はメモリ節約のためメインスレッドで WASM を別途ロードせず UI 合法手生成は未初期化 JS 透過フォールバック。Worker 非稼働時のみメインスレッド WASM 初期化（失敗時 JS 継続）を試みる。
     - `js`: Worker・メインスレッド双方を純 JS に固定する。
     - `wasm`: 思考エンジン（探索本体）として WASM 稼働を必須（fail-closed）とする。Worker 起動成功時は Worker を明示 `wasm` で稼働させつつメインスレッドはメモリ節約のため `'js'` とする（合法手 1 件の非探索処理・UI 合法手生成・並列ヒント結果の 0-ply 参考確率表示は対象外）。Worker 起動失敗時はメインスレッドで明示 `wasm` 初期化を試み、失敗した場合は開始ボタンを無効化したままエラー表示する。対局中に Worker 停止・RPC 失敗・合法手不一致が起きた場合もメインスレッド JS 探索へフォールバックせず、UI（`#hint.error`・同一局面とマッチ/クロフォード状態を保持した「WASM を再初期化して再試行」ボタン）と診断（`__BG_BACKEND_DIAG__.runtimeError`）へ明示して安全に中断・再初期化復旧する。
3. 検証専用の `docs/wasm-verify/` は本番公開対象から除外する。
4. `tests/backgammon/wasm-backend.mjs` / `tests/backgammon/app-wasm-failclosed.mjs` を追加・`run.mjs` へ登録し、Node テストおよび Playwright（Chromium / WebKit）で `auto` / `js` / `wasm`（実対局開始→ロール→着手、WASM URL 失敗時、および対局中 Worker RPC 失敗・停止時の fail-closed / 同一局面・クロフォード局保持での WASM 再初期化復旧 / `auto` 継続）を確認する。

## 完了条件

- [x] `docs/backgammon/` への WASM 資産・ソース同期（`miniapp` 固有の初心者設定・`checkerSearchMode='legacy'` 既定維持）
- [x] `tests/backgammon/wasm-backend.mjs` / `tests/backgammon/app-wasm-failclosed.mjs` 追加・既存テスト全件 PASS（遅延起動 1→4 Worker 診断追従・JS/SIMD/Scalar 混在チャンク結合パリティ・対局中 Worker 失敗時の `?backend=wasm` fail-closed / クロフォード局保持での WASM 再初期化復旧 / `?backend=auto` JS 継続含む）
- [x] ローカル HTTP 配信での Playwright（Chromium / WebKit）`auto` / `js` / `wasm` 実対局開始→ロール→着手・WASM URL 失敗時の挙動・コンソールエラー 0 確認
- [ ] PR マージ後、一時公開プレビューリポジトリ `dj-kusuha/miniapp-wasm-preview` を削除する
