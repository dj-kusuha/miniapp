# Execution Plan: GNU寄せ3-ply move filterの既定値同期

## Status

completed

## Background

engine側で、3-plyの応手フィルターを `3/.080` から `2/.040` に絞っても
3,000局面で有意なmEMG悪化がなく、処理時間が1.565倍になった。miniappは
段別フィルターを既に持っているため、既定値をengineと揃える。

## Scope

- `DEFAULT_FILTERS` と3-ply用 `FAST_FILTERS` を `2/.040` に更新する
- キューブ探索の説明を新しい既定値に合わせる
- 既存のパリティ・速度関連テストを実行する

## Non-Scope

- モデルファイルの更新
- UI・ルール・キューブアルゴリズムの変更
- Python/C#リポジトリへの変更

## Acceptance Criteria

- 0-ply/2-ply/3-plyの既存テストが通る
- `filtersFor(3)` とキューブ木の既定フィルターが `8/.160 → 2/.040` になる
- 既定の差分をPRで追跡できる

## Steps

1. `agent.js` の段別フィルターと関連コメントを更新する
2. product specを更新し、計画をcompletedへ移す
3. 全14本のテストをWindows Nodeから個別実行し、PRを作成する

## Decision Log

- 2026-09-17: Python/C#と同じ `2/.040` を採用する。miniappは既存の段別APIを活用し、別の抽象化は追加しない。

## Validation

- 全14本: 成功（WSL上のWindows Nodeでは、runner内部の `node` 子プロセスが
  UNCパスを二重化するため個別実行）
- `parity-cube.mjs`: キューブ探索120値・深さ2ベクトル40件とも不一致0、
  ダブル/テイク判断も不一致0
