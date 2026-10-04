# Execution Plan: 階層型累積確率モデルの JS 推論対応

## Status

in-progress

## Background

`backgammon_engine` の Python と C# は `hierarchical_cumulative_v1` を読み込めるが、Web miniapp の `NeuralNet` は常に5出力を独立 sigmoid として返す。階層型モデルをそのままコピーすると、ブラウザだけ誤った確率・手選びになる。

## Scope

- JS が `output_transform` を検証し、階層型5出力を累積確率へ変換する。
- 旧 JSON と `independent_sigmoid` の挙動を維持する。
- Python/C# と同じ float32 丸めを含む出力をテストする。

## Non-Scope

- 同梱 `model.json` の差し替えや訓練済みモデルのコピー。
- UI、学習コード、キューブ判断の変更。

## Acceptance Criteria

- 階層型出力が Python/C# と同じ5成分を返し、勝敗内のギャモン・バックギャモン順序を満たす。
- 変換キーのない旧モデルは現在と同じ独立 sigmoid を返す。
- 未知の変換名と5出力以外の階層型モデルを明示的に拒否する。
- 既存 Web parity suite と追加テストが通る。

## Steps

1. `nn.js` のモデル形式を確認し、既存仕様を残す作業計画を記録する。
2. output transform の検証と階層累積確率への変換を実装する。
3. 旧形式・階層形式・不正形式を対象にするテストを追加する。
4. Node parity suite を実行し、出力を確認する。

## Decision Log

- 2026-10-04: 学習済みモデルは同期せず、将来の候補が読み込める推論経路だけを追加する。
- 2026-10-04: Python/C# と同じく条件確率の最終 sigmoid 後に変換し、各積を float32 へ丸める。

## Validation

- `node tests/backgammon/hierarchical-output.mjs`
- `node tests/backgammon/run.mjs`
