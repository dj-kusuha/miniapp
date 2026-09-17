# Title

3-ply CPU「世界チャンピオン」の追加

## Status

completed

## Background

難易度ラダー再較正（PR #53）において、実用速度と強さのバランスからエキスパートが 2-ply となり、3-ply は同梱版の既定段から外れていた。
その後 PR #54 にて 3-ply 応手フィルターが GNU 寄せ（2 手 / 0.040）に同期され、1.565 倍の高速化が達成された。
最高峰の強さを求めるユーザー向けに、3-ply の CPU を「世界チャンピオン」として難易度ラダーに追加する。

## Scope

- `docs/backgammon/src/agent.js`:
  - `LEVELS` に `id: 'champion'`, `name: '世界チャンピオン'`, `plies: 3` を追加
  - 段の定義とコメントの更新
- `docs/backgammon/index.html`:
  - 「AI の強さ」選択肢に「世界チャンピオン」ボタンを追加
- `tests/backgammon/levels.mjs`:
  - 6 段構成への追従（段数アサーションの更新）
- `repo-docs/product-specs/backgammon.md`:
  - 難易度ラダー仕様の更新（6 段構成、世界チャンピオンの追加）

## Non-Scope

- 探索アルゴリズムやフィルター定数の変更
- キューブ探索の深さ変更
- モデルファイルの更新

## Acceptance Criteria

- `LEVELS` に `champion` が追加され、6 段構成になる
- トップ画面の AI の強さに「世界チャンピオン」が表示され、選択時に補足ノートが表示される
- 全テスト（`tests/backgammon/run.mjs`）がパスする
- Worker 経由での 3-ply 思考が正常に動作する

## Steps

1. `repo-docs/exec-plans/active/add-3ply-champion-level.md` を作成
2. `docs/backgammon/src/agent.js` に `champion` を追加
3. `docs/backgammon/index.html` に「世界チャンピオン」ボタンを追加
4. `tests/backgammon/levels.mjs` を 6 段構成に更新
5. テストスイート（`tests/backgammon/run.mjs`）を実行し検証
6. `repo-docs/product-specs/backgammon.md` を更新し、計画を completed へ移動

## Result

- `LEVELS` に `id: 'champion'`、`name: '世界チャンピオン'`、`plies: 3`、`noise: 0`、`maxLoss: Infinity`、`note: '3 手先読み・最高峰の強さ（思考に数秒）'` を追加。
- `index.html` の強さ選択 UI に「世界チャンピオン」ボタンを追加。
- 難易度ラダーは「初心者（0-ply・σ=0.10）」「カジュアル（0-ply・σ=0.05）」「中級（0-ply・σ=0.03）」「上級（0-ply・ノイズなし）」「エキスパート（2-ply）」「世界チャンピオン（3-ply）」の 6 段構成となった。

## Validation

- `tests/backgammon/run.mjs` 全 14 本のテストがすべて合格（`すべて一致しました`）:
  - `levels.mjs`: 6 段構成、単調性・決定的動作・足切り・ヒント接続のテストをすべて通過
  - `worker.mjs`: 3-ply を含む全 6 段の思考係テスト（136 件中 136 件一致 / 不一致 0、キューブ判断 80 件一致）を通過
  - `app-ui.mjs`: UI 配線・イベント制御をすべて通過
  - その他パリティ・MET・ルール等の全テストを通過
