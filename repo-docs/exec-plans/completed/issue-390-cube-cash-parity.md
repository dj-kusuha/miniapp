# Issue #390: キューブ探索と Cash Option の同期

## 背景

miniapp の `agent.js` は engine JS package より古く、ND 再帰の Cash Option 権利状態、cube 値、double/take 文脈を伝播していない。

## 目的・範囲

engine JS package と Python production の現行 cube search 状態伝播を miniapp に同期し、Money の生値と判断、Match の規則上の制約を再現可能な fixture/test で固定する。モデル、engine production、学習データ、sealed holdout は変更しない。engine #389 の公開 API 疑義は対象外。

## 受け入れ条件

- 実装差分・engine/miniapp commit・model SHA・fixture と実測の記録
- Cash Option 再帰、Jacoby、owner、cube cap、post-double-take のテスト
- miniapp の cube parity と関連 UI/Worker/CPU level tests が通る
- miniapp に PR を作成し、この engine issue から参照

## 手順

1. miniapp と engine の現状差分および fixture を調べる。
2. Cash Option / cube state の差分と回帰テストを miniapp に追加する。
3. cube parity、Worker、levels、UI を確認し、差分表と実測を記録する。
4. branch を push して miniapp PR を作成し、engine issue にリンクする。

## 意思決定メモ

- 2026-10-27: 同一の学習済みモデル SHA を確認。issue #389 の `analyzeCube()` API は変更対象外とする。
- 2026-10-28: Miniapp `agent.js` を engine JS package の状態伝播へ同期。productionモデル、production engine、学習重み、sealed holdoutは変更しない。

## 比較記録

対象コミットは miniapp `236cb5a9847e632be78e1d2e4dc4e9c20a68dea9`、engine JS/Python `7a59b25aba785113ab0118ff66de8140c7d0c544`。モデル `docs/backgammon/src/model.json` と `models/td_gammon.json` の SHA-256 はどちらも `9543ecb1deaff716de1355726d3109f1529fe34e0ab68d94284654fd7871dd83`。

将来の手動同期・fixture 更新手順は [backgammon-engine-sync.md](../../references/backgammon-engine-sync.md) に記録。

| 領域 | 作業前 miniapp | engine 現行実装 | 対応・確認 |
| --- | --- | --- | --- |
| Money Cash Option | `cashOption && depth === 1` の直接呼び出しに依存 | ND 経路で `cashPolicy` を渡し、owner / cube 値 / double 権 / action context に基づき深さ1の葉で適用。double-take後はpolicyを破棄 | 実装を同期し、ND再帰・take経路を新規テスト |
| Money cube状態 | 再帰内のcube値・double権を渡さず、cube64でも一部の枝を通常cubeとして扱う | `cubeValue`・`allowDouble` を再帰伝播し、64上限でtake/再doubleを抑制 | 実装を同期し、32→64 takeと64上限をテスト |
| Jacoby terminal | 終局で通常の gammon/backgammon 点数を返す | 未ダブル中央cubeでは terminal vector を単一点に補正 | 同一盤面で旧値3、新値1を確認する回帰テスト |
| Match MWC | Crawford/64/allow-double状態が再帰ノードへ伝わらない | `mwcSearch` / `mwcNode` に `allowDouble` を追加し、cube64の葉も固定cubeで評価 | 実装を同期し、engine Pythonから作ったpre/post-Crawford実盤面値7件で照合。再帰伝播・64・ダブル禁止もテスト |
| CubeHead | 共有 `lastHidden` を volatility 計算より前に保存 | volatility用NN呼び出し後に hidden state を取得 | 3箇所の順序を同期 |
| Worker | select/rank はminiappのCPUレベル用cubeless protocol | 同一protocol。差は cube/match 状態なしの意図を補足するコメントのみ | 既存Worker protocolを維持。cube要求を含む136件で本スレッドとworkerの応答一致を確認 |

Money oracle は `tests/backgammon/cube-parity.json`（60局面、take境界19件、Janowski境界28件、深さ2ベクトル40件）。生値の許容差は既存契約どおり `1e-5`。

実測（`node tests/backgammon/parity-cube.mjs`）:

- Cube search: 120値、不一致0、最大誤差 `1.82e-7`。FAST_FILTERS でも不一致0、最大誤差 `1.82e-7`。
- Double/Take: 各60判断、不一致0。
- Take threshold: 定数19件、Janowski28件とも不一致0。既定値6項目も不一致0。
- 深さ2ベクトル40件、不一致0、最大誤差 `7.66e-8`。
- Policy の制御fixture（固定fake net、相手cube equityを0.6に固定）: 深さ2 equityはpolicyなし `0.600000`、Cash Option policyあり `-0.340000`。数式経路を4,879回通過。これは経路回帰テストであり、engine oracle の実盤面値とは区別する。
- 終局Jacoby fixture: 白のギャモン勝ち・未ダブル中央cubeは旧経路 `+3` から新経路 `+1` へ補正。
- 新規Cash Option parity fixture `cube-cash-option-parity.json`: engine Pythonの同一モデル・同一盤面で、owner opponent / me / center、cube 1 / 2 / 32 / 64、double権の有無、post-double-takeを含む6値を照合、不一致0。cube=1 opponent ownerの再帰値は policyなし `0.020418027`、あり `0.011953691`。center cube32は `0.251158947` から `0.193308458`。
- 新規Match parity fixture `match-cube-parity.json`: pre-Crawfordのcenter/owner/cube1/2/32/64、1-awayで将来double禁止、post-Crawfordを含む7つの MWC 値を照合、不一致0。許容差は `1e-5`。
- Worker と Match の対照: Workerのminiapp/engine JS差はコメント2行のみ。engine側 Match 実装の money/MWC を混ぜない contract を保持し、miniapp側は `allowDouble` 再帰をPython MWC oracleと照合。
- Worker: 全段136要求がメインスレッドと一致、cube判断80件、不一致0。
- CPU level: 400局面で段の性質を確認。Match規則: 125 match / 254 game、Crawford61局、post-Crawford double15局で合格。

再実行コマンド: `node tests/backgammon/cube-search-context.mjs`、`node tests/backgammon/cube-cash-option-parity.mjs`、`node tests/backgammon/match-cube-parity.mjs`、`node tests/backgammon/parity-cube.mjs`、`node tests/backgammon/worker.mjs`、`node tests/backgammon/levels.mjs`、`node tests/backgammon/match.mjs`。Worker は sandbox で loopback bind が拒否されたため、`network: enabled` のテスト実行環境で通した。

2026-10-28に `tests/backgammon/run.mjs` の全 spec を個別実行し、すべて成功。Worker だけ loopback bind を許可した環境で実行した。UI smoke test は Worker が無い場合と壊れたmock bearoff fetchの警告を出すが、fallback を含む UI assertion は成功。

