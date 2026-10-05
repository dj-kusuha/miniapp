# cycle700 を同梱モデルへ差し替える

## 背景

cycle600 と cycle700 の最終比較では、32,000 局面の 2-ply 固定評価と 100,000 局の自己対局で明確な強さの差は確認されなかった。一方、cycle600 の独立5出力ではギャモン確率の包含順序が一部局面で逆転し、cycle700 の階層型出力はその順序を保証する。

## 目的

cycle700 の同一重みを Python engine、C# package、Web miniapp の3箇所へ配り、推論と派生 fixture を同期する。

## スコープ

- Web 推論で `hierarchical_cumulative_v1` を解釈できるようにする。
- 同梱モデルを3箇所で差し替え、SHA256 を揃える。
- Python / C# / JS の fixture を再生成・同期し、3実装でパリティを確認する。
- 固定ベンチとキューブ較正への影響を確認し、判断を engine 側 ADR に記録する。

## 非スコープ

- 追加学習や追加 seed の実行。
- モデル変更の main への merge、公開、GitHub Pages への配信。

## 受け入れ条件

- 3箇所のモデル SHA256 が cycle700 artifact と一致する。
- 3実装が階層出力および既存 fixture で一致し、該当テストが通る。
- 32,000局面 2-ply 結果、既存の paired self-play 結果、キューブ較正の扱いを ADR に記録する。
- 作業計画を completed/ へ移す。

## 実施ステップ

1. cycle700 artifact と origin/main の対応実装を確認する。
2. Web の階層型出力対応を取り込む。
3. モデル3箇所と4つの fixture を更新する。
4. 3実装のテスト、モデルハッシュ、評価値を検証する。
5. キューブ定数を再較正または据え置き根拠を測定し、engine ADR に残す。
6. 完了した計画を completed/ へ移す。

## 意思決定メモ

- 採用理由は強さの改善ではなく、確率出力の意味を常に整合させること。
- cycle700 は cycle600 からの100サイクル継続であり、再蒸留ではない。
- 既存の評価では cycle700 の優位は確認できていないため、強くなったとは主張しない。


## 実施結果

- cycle700 artifact SHA256 `9543ecb1deaff716de1355726d3109f1529fe34e0ab68d94284654fd7871dd83` を3箇所へ配布した。
- Web側に `hierarchical_cumulative_v1` の推論を反映し、終局盤面はNN予測を使わずルール上の正確な確率ベクトルを返すよう修正した。終局ギャモン局面の視点別テストを追加した。
- Pythonから出した `parity.json` と `cube-parity.json` をそれぞれC# / Webへ同期した。
- 固定値フォールバックのMoney cube efficiencyを0.80へ再較正し、cycle700の学習済みCubeHead基準値0.76は維持した。Matchは0.55、leaf depthは1-plyを維持した。
- 強さ比較では32,000局面2-plyと100,000局self-playのどちらも有意な差を検出しなかった。確率包含順序はcycle600の3,680件からcycle700の0件になった。
- 検証: Python 1,251 passed / 5 skipped、C# 30/30、Web parity runner全ケース一致で終了コード0。3箇所のモデルSHAと2組のparity fixture SHAも一致。

- 作業計画を完了し、`repo-docs/exec-plans/completed/` へ移動した。
