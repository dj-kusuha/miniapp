// マッチ（複数局のまとまり）の進行。**engine 側には無い**ので、ここが正本。
//
// アンリミテッド（マネーゲーム）とポイントマッチの両方をこの 1 つで扱う。
// 長さ 0 がアンリミテッドで、gnubg の `0 point match` と同じ表し方。
//
// ## クロフォードルール
//
// **片方がマッチポイント（あと 1 点）に達した直後の 1 局はキューブ禁止。**
// その 1 局が終われば、以降（ポストクロフォード）は再びダブルできる。
// リードした側が最後の 1 点を安く取れてしまうのを防ぐための規則で、
// **マッチ専用**（アンリミテッドには無い）。
//
// 1 ポイントマッチは、開始時点で両者ともマッチポイントなので**最初の 1 局が
// そのままクロフォード局**になる。結果としてキューブが一度も使えないが、
// これは規則どおり（1 点しか動かないのでキューブに意味が無い）。
//
// ## ジャコビーとの関係
//
// ジャコビーは**アンリミテッド専用**なので、マッチでは常に切る。
// 混ぜると「キューブが回っていないギャモンが 1 点」になり、マッチの
// 点数計算が壊れる。

import { WHITE, BLACK } from './board.js';
import { Game, GAME_OVER } from './game.js';

/** アンリミテッド（マネーゲーム）を表す長さ。 */
export const MONEY = 0;

export class Match {
  /**
   * @param {object} options
   * @param {number} options.length マッチの長さ。`MONEY`(0) でアンリミテッド
   * @param {boolean} options.jacoby ジャコビールール。**マッチでは無視して常に false**
   * @param {boolean} options.useCube キューブを使うか
   * @param {function} options.rng
   */
  constructor({ length = MONEY, jacoby = true, useCube = true, rng = Math.random } = {}) {
    this.length = length;
    this.useCube = useCube;
    // ジャコビーはアンリミテッド専用
    this.jacoby = length === MONEY ? jacoby : false;
    this.rng = rng;
    this.scores = { [WHITE]: 0, [BLACK]: 0 };
    /** 局の記録。`{ game, scores(局の開始時), crawford }` を古い順に持つ。 */
    this.entries = [];
    this.game = null;
    this.crawfordDone = false;
    this.recorded = false;   // 進行中の局の結果をスコアへ入れたか
  }

  get isMoney() {
    return this.length === MONEY;
  }

  /** マッチポイント（あと 1 点）に達している側。いなければ null。 */
  matchPointSide() {
    if (this.isMoney) return null;
    for (const player of [WHITE, BLACK]) {
      if (this.scores[player] === this.length - 1) return player;
    }
    return null;
  }

  /** 次に始める局がクロフォード局か。 */
  get crawfordPending() {
    if (this.isMoney || this.crawfordDone) return false;
    return this.matchPointSide() !== null;
  }

  /** クロフォード局を消化済みで、まだマッチが続いているか（＝ポストクロフォード）。 */
  get postCrawford() {
    return !this.isMoney && this.crawfordDone && !this.isOver;
  }

  get isOver() {
    if (this.isMoney) return false;
    return this.scores[WHITE] >= this.length || this.scores[BLACK] >= this.length;
  }

  /** マッチの勝者。まだ決まっていなければ null。 */
  get winner() {
    if (!this.isOver) return null;
    return this.scores[WHITE] >= this.length ? WHITE : BLACK;
  }

  /** あと何点で勝てるか（away）。アンリミテッドでは null。 */
  awayFor(player) {
    if (this.isMoney) return null;
    return Math.max(0, this.length - this.scores[player]);
  }

  /**
   * 次の局を始める。**マッチが終わっていたら始めない**（null を返す）。
   *
   * クロフォード局かどうかは**始める時点のスコア**で決まる。始めた時点で
   * 消化済みにするので、途中でやめても次はポストクロフォードになる。
   */
  startGame() {
    if (this.isOver) return null;
    const crawford = this.crawfordPending;
    if (crawford) this.crawfordDone = true;
    const game = new Game(null, this.rng, { jacoby: this.jacoby, crawford });
    this.entries.push({ game, scores: { ...this.scores }, crawford });
    this.game = game;
    this.recorded = false;
    game.start();
    return game;
  }

  /**
   * 進行中の局が決着していたらスコアへ入れる。**何度呼んでもよい。**
   *
   * 局が終わる経路が複数ある（着手で上がる / ダブルを断る）ので、呼び出し側で
   * 取りこぼさないよう、描画のたびに通す前提で冪等にしてある。
   */
  sync() {
    const game = this.game;
    if (!game || game.state !== GAME_OVER || this.recorded) return;
    this.recorded = true;
    const { winner, points } = game.result;
    // **点は上限で頭打ちにする。** キューブが伸びた局は必要点を超えて勝つが
    // （gnubg も棋譜には素の値を書く）、スコアはマッチの長さで止まる。
    const next = this.scores[winner] + points;
    this.scores[winner] = this.isMoney ? next : Math.min(next, this.length);
  }

  /** `.mat` 書き出し用。局ごとの `{ log, result, scores }`。 */
  matGames() {
    return this.entries.map(({ game, scores }) => ({
      log: game.log,
      result: game.state === GAME_OVER ? game.result : null,
      scores,
    }));
  }
}
