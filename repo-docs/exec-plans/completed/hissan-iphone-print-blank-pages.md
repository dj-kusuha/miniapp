# Title

筆算ドリルの iPhone Safari 印刷時の空白ページ解消

## Status

completed

## Background

iPhone の Safari で筆算ドリルを印刷すると、問題ページと解答ページの間や末尾に空白ページが入り、4 ページになってしまう。

## Scope

- docs/hissan/index.html の印刷用改ページ制御の見直し
- iPhone Safari で問題と解答がそれぞれ 1 ページずつに収まるようにする調整

## Non-Scope

- 問題生成ロジックの変更
- PC 向けの画面表示デザイン刷新

## Acceptance Criteria

- iPhone の Safari で印刷時に空白ページが増えず、問題と解答が 2 ページで出力される
- 既存の PC ブラウザ印刷レイアウトを不必要に崩さない
- 印刷ボタンからの既存フローを維持する

## Steps

1. 現在の印刷用 DOM 構造と改ページ指定の干渉箇所を整理する
2. 空白ページを生みやすい改ページ指定を見直し、必要最小限の CSS 調整を行う
3. 差分と HTML 構文を確認し、計画を更新する

## Decision Log

- 2026-04-19: 空白ページは印刷時の固定高さレイアウトと親要素側の改ページ指定の組み合わせを優先的に疑う
- 2026-04-19: 強制改ページは親ラッパーではなく実際に 1 ページを表す `.worksheet-page` 側に寄せる

## Validation

- `python3` の `html.parser` で `docs/hissan/index.html` の HTML 構文を確認した
- ローカルで `http://127.0.0.1:8123/docs/hissan/index.html` を開き、印刷ボタン押下で `window.print()` が 1 回呼ばれ、`afterprint` 後に `is-printing` が解除されることを確認した
- iPhone Safari 実機での最終印刷確認は未実施のため、PR 上で確認を依頼する
