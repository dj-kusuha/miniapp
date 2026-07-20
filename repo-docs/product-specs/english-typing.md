# English Typing

## Summary

英語学習とタイピング練習を同時に行える SPA。英単語・例文をタイピングしながら意味を覚える。
**本体は外部リポジトリ [dj-kusuha/english_typing](https://github.com/dj-kusuha/english_typing)(private)で開発しており、この miniapp にはビルド成果物のみを `docs/english-typing/` に配置する。** 詳細な要件・設計・開発計画はそちらの `docs/` を参照。

## Users

- タイピングも英語も初めて習う小学生(入門セット+カタカナ読み+キーボードガイド)
- 英語を学習中の中高生〜社会人(基礎・TOEIC・例文モード)

## Problem

タイピング練習の題材が無意味な文字列でもったいない/単語帳での暗記が続かない。ゲーム感覚のタイピングで英単語を反復する。

## Goals

- 単語・例文のタイピング練習(WPM・正確率のリアルタイム計測、効果音、音声読み上げ)
- 忘却曲線ベースの出題(SRS)と苦手単語の復習モード
- 統計ダッシュボード、カスタム単語帳、ダークモード

## Non-Goals

- アカウント・サーバーサイド永続化(データは localStorage。キーは `english-typing:v1:*` で他アプリと衝突しない)
- スマホのソフトウェアキーボード対応

## Core Flow

1. ホームで単語セット(入門 50 / 基礎 100 / TOEIC 100 / カスタム)を選ぶ
2. 3・2・1 カウントダウン後、10 問をタイピング(意味・読み・ガイド表示)
3. リザルト(WPM・正確率・ミス単語)→ 履歴・統計に蓄積

## Technical Notes

- React + TypeScript + Vite の静的 SPA(ビルド済み。`base: "./"` でサブパス配信対応)
- 外部 API なし。音は Web Audio API / Web Speech API 合成
- 更新手順: english_typing 側で `npm run build` → `dist/` を `docs/english-typing/` へ同期してコミット

## Acceptance Criteria

- https://miniapp.kusuha.com/english-typing/ で一連のフロー(プレイ→リザルト→履歴)がコンソールエラーなく動く
- トップページ(docs/index.html)の一覧からアプリへ遷移できる

## Open Questions

- 自動デプロイ(CI)への移行時期(当面は手動同期)
