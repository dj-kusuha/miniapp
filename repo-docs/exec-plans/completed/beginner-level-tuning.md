# Title

初心者段の体感調整（ノイズ拡大・キューブ慎重化・ベアオフDB不使用）

## Status

completed

## Background

公開中の対戦アプリで、初心者設定でも強すぎるという体感があった（2026-11-04 の
テストプレイでギャモン負け。序盤の的確なダブル、プライム作り、終盤の正確さ）。
現行の初心者は σ=0.10 / maxLoss 0.50 で ER 34.6 mEMG と gnubg 区分では
Beginner に入ったばかりであり、土台の 0-ply モデル自体が Expert 級のため、
際どい手以外は正解が残り、大きなミスは足切りで起きず、ベアオフは厳密解DBで
完璧になる。

## Scope

- 初心者だけ σ 0.10 → 0.20、maxLoss 0.50 → 1.00 にする
- 初心者だけダブル判断に上乗せマージンを入れる（マネー 0.15 / マッチ 0.03 MWC）
- 初心者だけベアオフDBを使わない（`agentFor()` で `bearoff: null` を渡す）
- 段テストに初心者のキューブマージンとベアオフ不使用の固定を追加する
- 仕様（product-specs/backgammon.md）と agent.js の段コメントへ記録する

## Non-Scope

- カジュアル以上の段の値の変更
- モデル重み・推論器・探索そのものの変更
- テイク／ドロップ判断へのマージン追加（ノイズ拡大で誤りは増える。別途測る）
- engine（Python）側の段定義の変更

## Acceptance Criteria

- `tests/backgammon/levels.mjs` が通る（決定的・足切り・単調性に加え、
  初心者のマージンとベアオフ不使用を確認）
- `tests/backgammon/run.mjs` と `worker.mjs` が通り、他段とパリティに影響しない
- 初心者以外の段の Agent 設定が従来と同一（マージン 0・ベアオフDB使用）

## Steps

1. 現行段の定義と、ダブル判断の実経路を確認する
2. 実行計画を作成する（本ファイル）
3. agent.js の LEVELS と Agent にマージン／ベアオフ不使用を実装する
4. テストを追加し、全テストを実行する
5. 結果を仕様と計画へ反映する

## Decision Log

- 2026-11-09: 当初案の「doublePoint 0.45 → 0.65」は不採用。現行の
  `DEFAULT_CUBE_DECISION = 'search'` では `doublePoint` は閾値フォールバック
  経路でしか使われず、実戦のダブル判断に効かないことを確認したため。
  代わりに search / cubeful / マッチの各判断へ効く専用マージン
  （`doubleMargin` / `matchDoubleMargin`、既定 0）を新設し、初心者だけに付ける。
- 2026-11-09: σ と maxLoss の新値は体感起点の実験値。gnubg の ER 再測定
  （docker が必要）は未実施で、測定後に見直す前提で記録する。

## Result

初心者だけ σ=0.20 / maxLoss 1.00、`doubleMargin` 0.15 / `matchDoubleMargin`
0.03（既定 0 の専用マージンを新設し、search / cubeful / マッチの各ダブル判断と
閾値フォールバックへ適用）、ベアオフDB不使用（`useBearoff: false` を
`agentFor()` で `bearoff: null` に変換）にした。他段は無変更。

`levels.mjs` の 400 局面では初心者の最善一致 32.5% / 平均損失 62.8 mEMG /
最悪 703 mEMG（カジュアルは 56.5% / 12.7 mEMG）で、段差と足切りを確認した。
これは内部指標であり、gnubg の ER 再測定は未実施（docker が必要）。

## Validation

- `tests/backgammon/levels.mjs`: passed（段の性質に加え、初心者のマージンと
  ベアオフ不使用を確認）
- `tests/backgammon/run.mjs`: passed（全19ファイル「すべて一致しました」。
  app-ui 内のベアオフDB読み込みと Worker 生成の失敗表示は、テスト環境向けの
  フォールバック経路のログで、検証条件はすべて満たした）
