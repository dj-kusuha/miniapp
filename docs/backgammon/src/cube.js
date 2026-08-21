// ダブリングキューブ。backgammon_engine の `backgammon/cube.py` の移植。
//
// キューブの値は 1, 2, 4, ... 64。所有者が null ならセンター（どちらも
// ダブルを提案できる）。ダブルを受けた側がキューブを取る。

import { WHITE, BLACK } from './board.js';

/** キューブの上限。ここまで来たらもうダブルできない。 */
export const MAX_CUBE_VALUE = 64;

export class DoublingCube {
  constructor(value = 1, owner = null) {
    this.value = value;
    this.owner = owner;   // null = センター
  }

  /**
   * そのプレイヤーがダブルを提案できるか。
   * センターか、自分が持っているときだけ提案できる（相手が持っていたら不可）。
   */
  canDouble(player) {
    if (this.value >= MAX_CUBE_VALUE) return false;
    return this.owner === null || this.owner === player;
  }

  /** ダブルが受け入れられた。値が倍になり、受けた側が所有する。 */
  accept(acceptingPlayer) {
    this.value *= 2;
    this.owner = acceptingPlayer;
  }

  /** ドロップしたときに払う点数（＝いまのキューブの値）。 */
  get declineCost() {
    return this.value;
  }

  /** 決着したときの総得点。 */
  gameValue(winMultiplier) {
    return this.value * winMultiplier;
  }

  /**
   * **ジャコビールールの適用条件。**
   *
   * キューブが一度も回されていない（センターかつ値が 1）なら、
   * ギャモン・バックギャモンも 1 点として数える。
   * マネーゲーム（アンリミテッド）専用のルールで、マッチプレイには無い。
   */
  get untouched() {
    return this.value === 1 && this.owner === null;
  }

  clone() {
    return new DoublingCube(this.value, this.owner);
  }

  toString() {
    const who = this.owner === null ? 'センター'
      : (this.owner === WHITE ? 'あなた' : 'AI');
    return `キューブ ${this.value}（${who}）`;
  }
}

/** 表示用: 勝ちの種別。 */
export const WIN_TYPE_LABEL = { 1: 'シングル', 2: 'ギャモン', 3: 'バックギャモン' };

export { WHITE, BLACK };
