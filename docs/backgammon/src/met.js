// マッチエクイティ表（MET）の引き当て。
//
// **MET は「あと何点で勝つか」からマッチに勝つ確率（MWC）を出す表。**
// マッチでは 1 局の得点がそのまま積み上がらないので、キューブの判断を
// 「1 局あたりの期待得点（equity）」でやると必ず外れる。スコアごとに
// **マッチに勝つ確率**へ換算し直す必要がある。
//
// 表そのものは `met-table.js`（生成物。`tools/build-met.mjs` が作る）。
// 著作権表示と許諾文はそちらの先頭にある。**消さないこと。**
//
// ## 表の読み方
//
// `PRE_CRAWFORD[i][j]` は **(i+1)-away の側がマッチに勝つ確率**。手番の有利は
// 含まない（局の開始時点の値）ので `MET(i,j) + MET(j,i) = 1` がぴったり成り立つ
// （生成時に検査している）。
//
// `POST_CRAWFORD[k]` は **相手が 1-away でクロフォードを消化済み**のときの、
// (k+1)-away 側の勝率。クロフォード局が終わるとキューブが復活するので、
// 同じスコアでも表が別になる。

import { MET_LENGTH, PRE_CRAWFORD, POST_CRAWFORD } from './met-table.js';

export { MET_NAME, MET_LENGTH } from './met-table.js';

/**
 * マッチに勝つ確率。
 *
 * @param {number} awayUs    こちらがあと何点で勝つか（0 以下なら勝ち確定）
 * @param {number} awayThem  相手があと何点で勝つか
 * @param {boolean} crawfordPlayed クロフォード局を**消化済みか**
 *
 * `awayUs` / `awayThem` が表の長さ（25）を超えることは 7 ポイントまでの
 * マッチでは起きないが、念のため頭打ちにしてある。
 */
export function matchWinChance(awayUs, awayThem, crawfordPlayed) {
  if (awayUs <= 0) return 1;
  if (awayThem <= 0) return 0;
  const us = Math.min(awayUs, MET_LENGTH);
  const them = Math.min(awayThem, MET_LENGTH);
  if (crawfordPlayed) {
    // クロフォードが済んでいて相手が 1-away なら、ポストクロフォードの表
    if (them === 1) return POST_CRAWFORD[us - 1];
    if (us === 1) return 1 - POST_CRAWFORD[them - 1];
  }
  return PRE_CRAWFORD[us - 1][them - 1];
}

/**
 * 5 出力を「ちょうど N 点勝つ / 負ける」の確率に開く。
 *
 * モデルの出力は **累積**（`P(win)` ⊇ `P(win gammon)` ⊇ `P(win bg)`）で、
 * 出力ごとに独立なシグモイドなので**包含関係が崩れることがある**。
 * 単調になるように押さえてから差を取る。
 *
 * @param {number[]} probs White 視点の 5 要素
 * @param {boolean} forWhite その 5 要素の視点のまま使うか（false なら反転）
 */
export function outcomeSpread(probs, forWhite) {
  const [w, wg, wbg, lg, lbg] = probs;
  // 視点を入れ替えると「勝ち」と「負け」が丸ごと入れ替わる
  let pw = forWhite ? w : 1 - w;
  let pwg = forWhite ? wg : lg;
  let pwbg = forWhite ? wbg : lbg;
  let plg = forWhite ? lg : wg;
  let plbg = forWhite ? lbg : wbg;

  pwg = Math.min(pwg, pw);
  pwbg = Math.min(pwbg, pwg);
  const pl = 1 - pw;
  plg = Math.min(plg, pl);
  plbg = Math.min(plbg, plg);

  return {
    win1: pw - pwg, win2: pwg - pwbg, win3: pwbg,
    lose1: pl - plg, lose2: plg - plbg, lose3: plbg,
  };
}

/**
 * そのキューブ値で最後まで打ったときのマッチ勝率。
 *
 * **キューブが以後動かない前提**（いわゆる死んだキューブ）で数えている。
 * 実際にはテイクした側が振り直せる価値があるので、この値は
 * **テイク側をわずかに低く見積もる**。同じ近似は元のマネーゲーム側
 * （`cubeOwnership = 0`）でも使っており、方針は揃えてある。
 */
export function mwcWithCube(spread, cubeValue, awayUs, awayThem, crawfordPlayed) {
  const win = (points) => matchWinChance(awayUs - points, awayThem, crawfordPlayed);
  const lose = (points) => matchWinChance(awayUs, awayThem - points, crawfordPlayed);
  return spread.win1 * win(cubeValue)
    + spread.win2 * win(cubeValue * 2)
    + spread.win3 * win(cubeValue * 3)
    + spread.lose1 * lose(cubeValue)
    + spread.lose2 * lose(cubeValue * 2)
    + spread.lose3 * lose(cubeValue * 3);
}

/**
 * 相手がリダブルする権利・余地の強さ（0.0: 死んだキューブ 〜 1.0: 生きたキューブ）。
 *
 * @param {number} awayUs    提案者の残り点数
 * @param {number} awayThem  受け手（相手）の残り点数
 * @param {number} nextCube  ダブル後のキューブ値
 */
export function redoublePower(awayUs, awayThem, nextCube) {
  // 受け手が勝てばマッチ終了なら、受け手はリダブル不要（死んだキューブ）
  if (awayThem <= nextCube) return 0.0;
  // 提案者がリーチなら、受け手のリダブル価値は限定的
  if (awayUs <= nextCube) return 0.5;
  // 両者ともまだ点数が必要なら、完全な生きたキューブ
  return 1.0;
}

