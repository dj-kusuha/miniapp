# Backgammon 0.2.5 高速化同期 & マルチ Worker 並列化

## 背景

`dj-kusuha/backgammon_engine` (`@dj-kusuha/backgammon-engine@0.2.5`, commit `d43553b`) および `backgammon-trainer` で導入した純 JS 推論・キャッシュ高速化とマルチ Worker 並列化により、2-ply / 3-ply チェッカー評価およびキューブ判断の待ち時間が大幅に短縮された。一方、`miniapp`（`docs/backgammon/`）は単一 Worker かつ `0.2.4` 相当の手動同期のままだった。

## 目的

1. `engine 0.2.5` の単体高速化（パリティ維持・0 ビット差）を `miniapp` へ同期する。
2. 最大 4 Worker の遅延起動並列プール（`ThinkerPool`）を導入し、CPU 着手（2-ply / 3-ply）・ヒント・際どいキューブ判断を高速化する。
3. Worker 利用時の世界チャンピオン段（`champion`）で `staged3ply` + `cubeFilterLevel: 1` を既定 ON にし、実用速度で本物の 3-ply 対局を可能にする。

## スコープ

- `docs/backgammon/src/nn.js`, `board.js`, `rules.js`, `agent.js` の `0.2.5` 同期
- `docs/backgammon/src/checker.js` のキャッシュ高速化・並列チェッカー/キューブ判断ヘルパー追加
- `docs/backgammon/src/worker.js` の並列チャンク処理対応と単一経路キューブキャッシュ適用
- `docs/backgammon/src/thinker-pool.js` の新設と `docs/backgammon/app.js` への接続
- 並列パリティ・遅延起動・IEEE 754 逐次加算順テスト（`tests/backgammon/parallel-pool.mjs`）の追加と `run.mjs` 登録
- `repo-docs/references/backgammon-engine-sync.md`・`repo-docs/product-specs/backgammon.md` の同期記録・仕様更新

## 非スコープ

- `docs/backgammon/src/model.json` やベアオフ DB（`bearoff-6x15.bin`, `money-bg2n-6x6-v4.bin`）の差し替え
- 初心者〜上級の段パラメータ（ノイズ・ブロット罰則・キューブマージン）や UI レイアウトの変更
- WASM SIMD 化（将来の別計画）

## 受け入れ条件

- `tests/backgammon/` の全 23 テストスイート（新規 `parallel-pool.mjs` 含む）が全件 PASS する。
- 既存の `worker.js` 単体プロトコル・`Agent` 既定挙動・Python パリティフィクスチャを破壊しない。
- Worker 非対応環境（メインスレッド fallback）および `?checker-search=legacy` 指定では従来の安全設定を維持する。

## 実施ステップ

1. `nn.js`, `board.js`, `rules.js`, `agent.js` を `backgammon_engine@d43553b`（0.2.5）と同期。
2. `checker.js` に高速文字列キャッシュキー、`checkerEfficiencies` 再利用、並列チェッカー/キューブ判断ヘルパーを追加。
3. `worker.js` に並列チャンクハンドラとキャッシュ付き単一キューブ経路を追加。
4. `thinker-pool.js`（最大 4 Worker 遅延起動）を実装し `app.js` へ接続。
5. `tests/backgammon/parallel-pool.mjs` を追加し、全 23 テストスイートの PASS を確認。
6. `repo-docs/references/backgammon-engine-sync.md` を更新し、本計画を `completed/` へ移動。

## 意思決定メモ

- **世界チャンピオン段の既定探索モード**: Worker 利用時のみ `staged3ply` を既定 ON とする（メインスレッド fallback は UI ブロック防止のため `legacy` 維持）。`?checker-search=legacy|staged3ply|full-root` の明示クエリ指定は尊重する。
- **3-ply（`staged3ply`）時の内部応手フィルタ**: `cubeFilterLevel: 1`（2 手 / 0.040 絞り込み、`backgammon-trainer` の 3-ply と統一）を Worker 実行時に適用し、`Agent` 既定値は変更しない。
