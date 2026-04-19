# Title

筆算ドリルの iPhone 印刷 2 ページ収まり調整

## Status

completed

## Background

iPhone で印刷画面を開くと、初期倍率のままでは問題ページと解答ページが 2 枚に収まらず、手動で 83% 前後まで縮小しないと収まらない。

## Scope

- docs/hissan/index.html の印刷用レイアウト調整
- iPhone 系ブラウザで過剰に改ページされにくい安全側のサイズ調整

## Non-Scope

- 問題生成ロジックの変更
- 画面表示デザインの全面刷新

## Acceptance Criteria

- iPhone で印刷するを押した時、初期状態から問題と解答が 2 ページに収まりやすい
- デスクトップの印刷レイアウトを大きく崩さない
- 既存の画面プレビュー縮小と印刷処理が競合しない

## Steps

1. 印刷時の高さ計算と縮小レイヤーの干渉箇所を整理する
2. iPhone を含む Safari 系で安全側に収まる印刷用サイズへ調整する
3. HTML 構文と差分を確認する

## Decision Log

- 2026-04-20: 印刷時の見た目だけを縮める transform をやめ、実寸の印刷サイズを安全側に寄せる
- 2026-04-20: iPhone 系端末では root font size も下げて Safari 系の自動縮小と改ページ超過を起こしにくくする

## Validation

- docs/hissan/index.html に HTML 構文エラーがないことを確認した
- 実機印刷までは未確認のため、iPhone の印刷プレビューで最終確認を行う