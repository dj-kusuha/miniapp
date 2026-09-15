# Title

cycle200 同梱モデル向けの難易度ラダー再較正

## Status

completed

## Background

ワイド4層の cycle200 モデルを同梱したことで、エキスパートの 3-ply は JS 版で重く、
0-ply の段も以前より強くなっている。対局で使える速度を保ちながら、5 段の強さを
段階的に分け直す。

## Scope

- エキスパートを 2-ply、上級を 0-ply に変更する
- 中級以下のノイズと足切りを再較正する
- 各段を同一条件の自己対局から gnubg の ER で測る
- 段設定の説明・テスト・仕様記録を更新する

## Non-Scope

- モデル重みや JS 推論器そのものの変更
- キューブ判断の深さや補正値の変更
- 3-ply 探索の高速化実装

## Acceptance Criteria

- 5 段の順序が保たれ、エキスパートが 2-ply、上級が 0-ply になっている
- 中級以下は決定的ノイズで単調に弱くなる
- JS テストと段設定テストが通る
- 各段の ER、局数、手数、gnubg ラベルを記録できる

## Steps

1. 現行段の ER とモデル・実行環境を確認する
2. cycle200 に合わせて候補設定を変更する
3. テストを通し、自己対局を gnubg に採点させる
4. 結果を仕様と計画へ反映し、差分を確認する

## Decision Log

- 2026-09-15: エキスパートは 3-ply の実用性を失っているため 2-ply にする
- 2026-09-15: 上級は 0-ply とし、深さではなく中級以下の決定的ノイズで下位帯を作る
- 2026-09-15: 初心者は σ=0.10 を維持し、カジュアルは σ=0.05、中級は σ=0.03 にする

## Result

現行の cycle200 wide4 モデルでは、初心者・カジュアル・中級・上級を 0-ply、
エキスパートを 2-ply とした。全段の `maxLoss` は従来どおり 0.50（ノイズなしの
上級・エキスパートは Infinity）とした。

同一条件（30局、seed 1、キューブなし、gnubg チェッカー評価 2-ply）での ER は、
初心者 34.6、カジュアル 15.3、中級 11.8、上級 5.4、エキスパート 3.0 mEMG。
White / Black は順に 31.3 / 37.9、15.4 / 15.1、11.6 / 12.0、5.3 / 5.5、
2.8 / 3.1。

## Validation

- `tests/backgammon/levels.mjs`: passed（400局面、段の性質・ヒント接続を確認）
- `tests/backgammon/worker.mjs`: passed（124/124、一致 0）
- `tests/backgammon/parity-select.mjs`: passed（0-ply 267/267、2-ply 51/51）
- `tests/backgammon/parity-game.mjs`: passed（107イベント、一致 0）
- `tests/backgammon/parity-cube.mjs`: passed（深さ・キューブ・FAST_FILTERS の一致確認）
- `tools/measure-level.mjs`: 5段を各30局で測定
