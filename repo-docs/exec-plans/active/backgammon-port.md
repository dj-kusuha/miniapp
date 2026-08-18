# Execution Plan: Backgammon を JS に移植して配信する

## Status

planned

## Background

[仕様](../../product-specs/backgammon.md)のとおり、AI とルールエンジンは
[backgammon_engine](https://github.com/dj-kusuha/backgammon_engine) にあるが
**Python でサーバ実行前提**なので、english-typing のように成果物を置くだけでは
配信できない。**JS への移植が要る。**

移植の山は AI ではなくルールエンジン。**AI は 198→80→5 の MLP なので
行列積 2 回**で済む。一方ルールは合法手生成・ベアオフ・バー・
ギャモン判定を含み、engine 側も「特に間違えやすい点」として
**向きと座標系**（White は index 23→0、Black は 0→23）を筆頭に挙げている。

**同じ移植を C# で一度やっており、Python との一致を検証するパリティテストが
ある。** 同じ仕組みを使う。

## Scope

- `docs/backgammon/` に、素の HTML/CSS/JS で動く 1 局完結のアプリを置く
- engine の同梱モデル（`models/td_gammon.json`）をそのまま読んで推論する
- engine が出力する固定局面で、**合法手集合と AI の着手が Python と一致**
  することを検証する
- トップページ（`docs/index.html`）に入口を追加する

## Non-Scope

- ダブリングキューブ
- 3-ply 以上の先読み（1 手 5.6 秒で重すぎる）
- 対人戦・棋譜保存・アカウント
- **モデル同期の自動化**（初版は english-typing と同じ手動コピー）

## Acceptance Criteria

- https://miniapp.kusuha.com/backgammon/ で 1 局を最後まで遊べ、
  コンソールエラーが出ない
- **パリティ検証が通る**（下記 Validation）
- 360px 幅とデスクトップ幅で盤面が破綻しない
- キーボードだけで着手できる
- AI の 1 手が 2-ply で 200ms 以内（超えるなら 0-ply に落とす）

## Steps

1. **パリティ用の固定局面を engine 側で出力する。**
   `csharp/tools/export_parity_fixtures.py` が同じことをやっているので、
   出力先を増やすか同等のものを用意する。局面・出目・合法手集合・
   AI の着手・評価値を JSON にする
2. **AI 推論を JS で書く**（`nn.js`）。198→80→5、シグモイド 2 回。
   固定局面の評価値が Python と一致することを最初に確認する
3. **ルールエンジンを JS で書く**（`rules.js`）。合法手生成が山。
   **両プレイヤーでテストを書く**（engine の AGENTS.md の 1 番）
4. **パリティ検証を通す。** 1 の固定局面で合法手集合と着手が一致するまで直す
5. **0-ply で 1 局遊べるようにする**（`app.js` + `index.html` + `style.css`）。
   engine 側の `backgammon/web/static/app.js`（405 行）が UI の参考になる
6. **2-ply の所要時間を実測し、200ms 以内なら有効にする**
7. `docs/index.html` に入口を追加し、`docs/backgammon/` へ配置する

## Decision Log

- 2026-08-18: 素の HTML/CSS/JS で書く。単一ページで完結するため
  （[FRONTEND.md](../../../FRONTEND.md)）。Vite / TS は入れない
- 2026-08-18: モデルは JSON をそのまま fetch する。348KB で、
  変換すると engine 側の更新と同期が取りにくくなるため
- 2026-08-18: **先に 0-ply を動かしてから 2-ply を測る。** 見積り
  （評価 2,103 回/手・3,400 万積和・数十 ms）が外れたときに、
  重くて遊べないものを配信しないため
- 2026-08-18: モデル同期は手動から始める。english-typing と同じ運用に
  揃え、自動化は必要が見えてから

## Validation

**パリティ検証を受け入れ条件に入れるのが、この計画の肝。**

engine 側は Python が正本で、C# 移植でも同じ検証をしている。JS でも:

```
engine が出力した固定局面 N 件について
  ├─ 合法手集合が Python と完全一致する（順序は問わない）
  ├─ AI が選ぶ手が一致する
  └─ 評価値が 1e-5 以内で一致する
```

**「動いているように見える」で済ませない。** ルールの移植は、向きを
間違えても片側だけ正しく動いてしまうため、**両プレイヤーで検証する。**

所要時間も測って記録する（0-ply / 2-ply）。
