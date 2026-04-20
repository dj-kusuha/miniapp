# Title

公開トップに miniapp 一覧を追加

## Status

completed

## Background

docs/ 配下には公開中の miniapp が増えていく予定だが、現状はルートの入口がなく、一覧で把握しづらい。
最初の miniapp として公開済みの筆算ドリルメーカーへ遷移できるトップページを追加し、今後の拡張先も揃えておきたい。

## Scope

- docs/index.html を新規作成する
- 公開中 miniapp のタイトルと概要をカードで列挙する
- 既存の hissan へ遷移できる導線を置く
- 必要最小限の README 導線を追加する

## Non-Scope

- miniapp 一覧の自動生成
- 各 miniapp ページへの共通ヘッダー追加
- 検索、タグ、カテゴリ分け

## Acceptance Criteria

- docs/index.html で miniapp 一覧が読める
- 筆算ドリルメーカーのタイトル、概要、リンクが表示される
- 360px 幅とデスクトップ幅でレイアウトが破綻しない
- HTML に明白な構文エラーがない

## Steps

1. 公開トップの構成と文言を決める
2. docs/index.html を追加する
3. 必要なら README に公開トップの案内を足す
4. HTML 構文と表示を確認する

## Decision Log

- 2026-04-20: 一覧は当面 docs/index.html の手動更新で管理する
- 2026-04-20: 一覧ページはカード型で実装し、各カードに概要を含める

## Validation

- python3 -m html.parser docs/index.html で構文チェックを実施し、問題がないことを確認した
- docs/index.html に ./hissan/ へのリンクがあることを確認した
- docs/hissan/index.html が存在することを確認した