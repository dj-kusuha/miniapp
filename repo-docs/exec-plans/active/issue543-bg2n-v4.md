# 実行計画: Money BG2N v4 をWeb版へ移植する（Issue #543）

## Status

active

## Background

engine production `main`（参照SHA `b2bedb479876162efb48262d612530d8ffe20ad9`）は、Money cubeful strict-rootでBG2N v4 / uint16 DBを使う。miniappは片側BGBO float16 readerのみで、Money strict-rootは未実装。

## Purpose

既存BGBOを残したまま、Money cube判断でengineのBG2N v4 strict-rootと同じND / DT / DP値を使う。対象外root、読込/検証異常、子lookup missでは判断root全体を従来探索へ戻す。

## Scope

- `docs/backgammon/src/money-bearoff.js` にBG2N v4専用readerとsingle-only strict-root評価を実装する。
- engine production DB（10,223,244 bytes、SHA-256 `2ddee6d0b8285c8f755e0fe027bb5c66b678269a9dc89427f8ae9921d4a7daa1`）を別ファイルで同梱する。
- Money cube時だけ遅延ロードし、Worker / main-thread両経路でDB readerを共有する。初心者段は既存設定どおりreaderを無効にする。
- Money unbounded cube、Jacoby、cube owner、cube OFF、Match / Crawfordをengineと既存ゲームルールに合わせる。
- engine production固定局面を追加し、reader・root値・推奨判断・fallbackを検証する。
- DB形式、参照SHA、計測値、既知の制約を仕様・計画に記録する。

## Non-Scope

- 既存BGBOの置換や生成形式変更
- Match / CrawfordへのMoney exact値適用
- 3-ply段階選別（Issue #544で別PR）

## Acceptance Criteria

- header/version/flags/record数/size/payload SHA/予約codeを検証し、v4以外や破損DBを拒否する。
- Money対象rootでは同一DBからND / DT / DPを算出し、engine固定fixtureの値と判断がuint16許容差内で一致する。
- root対象外・child miss・DB異常では一部exact枝を残さず、従来評価へfallbackする。
- Match / Crawford、初心者のベアオフDB無効、cube OFF、既存BGBOとWorker/main-thread fallbackを維持する。
- 読込遅延、常駐メモリ、応答時間を測り、結果を記録する。

## Steps

1. engine production reader / exact-root / 固定fixtureとminiapp現行実装を照合する。
2. BG2N v4 DB readerとexact-root経路を実装する。
3. lazy load、unbounded Money cube、Worker/main fallbackを接続する。
4. engine fixture・破損/対象外fallback・ルール分離・既存回帰を検証する。
5. 計測とSHAを記録し、日本語PRを作成してengine Issue #543へリンクする。

## Implementation Progress

- `docs/backgammon/src/money-bearoff.js` にBG2N v4専用readerとsingle-only strict-root評価を追加した。
- engine production fileを同じSHAのまま `docs/backgammon/src/money-bg2n-6x6-v4.bin` へ配置した。
- Money cube、Checker afterstate、Worker/main fallbackへunbounded設定を伝播し、Match/Crawfordは64倍上限を維持する。
- `money-bg2n-parity.json` にengine `bg2n_exact.py`から出した固定lookup/root値を記録した。
- Worker初期化時とchecker/hintではDBを読まず、Money cube rootでlazy loadして同じreaderを再利用するfixtureを追加した。
- WSLからWindows Nodeを直接呼ぶとUNC path importが失敗するため、Windows Nodeの作業用コピーでテストを実行している。
- 残り: 既存全テスト、Worker fetch/lazy load、ブラウザでの応答/メモリ測定、差分レビュー、PR/Issue記録。

## Decision Log

- 2026-11-11: engine `main` は `b2bedb479876162efb48262d612530d8ffe20ad9`（PR #548 merge後）を参照する。
- 2026-11-11: ユーザーの既存作業ツリーにある未コミット変更を保つため、`origin/main` 起点の別worktreeで実施する。
