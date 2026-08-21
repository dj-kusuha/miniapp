// 1 局の進行。backgammon_engine の `backgammon/game.py` の移植。
//
// engine の Web フロントはこの部分をサーバに置いているが、GitHub Pages では
// Python を動かせないのでブラウザ側に持つ。

import { Board, WHITE, BLACK, opponent } from './board.js';
import { DoublingCube } from './cube.js';
import { generateMoves } from './rules.js';

export const ROLLING = 'ROLLING';
export const MOVING = 'MOVING';
/** ダブルを提案して、相手の返事を待っている。 */
export const DOUBLING_PROPOSED = 'DOUBLING_PROPOSED';
export const GAME_OVER = 'GAME_OVER';

/** 双方が着手不能なまま進まなくなる理論上のデッドロックを避ける上限。 */
const MAX_CONSECUTIVE_SKIPS = 200;

export class Game {
  /**
   * @param {?Board} board
   * @param {function} rng
   * @param {object} options
   * @param {boolean} options.jacoby ジャコビールール。**マネーゲーム専用**で、
   *   キューブが一度も回されていない局はギャモンも 1 点として数える。
   *   マッチプレイには無いルールなので、マッチを実装するときは false にする。
   */
  constructor(board = null, rng = Math.random, { jacoby = true } = {}) {
    this.board = board ?? new Board();
    this.rng = rng;
    this.jacoby = jacoby;
    this.cube = new DoublingCube();
    /** ダブルを提案した側（返事待ちの間だけ入る）。 */
    this.doublingProposer = null;
    this.currentPlayer = null;
    this.roll = null;
    this.legalMoves = [];
    this.state = ROLLING;
    this.result = null;      // { winner, winType, points }
    this.log = [];           // 画面に出す出来事
  }

  die() {
    return Math.floor(this.rng() * 6) + 1;
  }

  /**
   * オープニングロール。**引き分けたら振り直す**（engine と同じ）。
   * 大きい目を出した側が先手で、その 2 つの目をそのまま使う。
   */
  start() {
    let a = this.die();
    let b = this.die();
    while (a === b) {
      a = this.die();
      b = this.die();
    }
    this.currentPlayer = a > b ? WHITE : BLACK;
    this.roll = { die1: a, die2: b };
    this.legalMoves = generateMoves(this.board, this.currentPlayer, a, b);
    this.state = MOVING;
    this.log.push({ kind: 'open', player: this.currentPlayer, roll: [a, b] });
    if (this.legalMoves.length === 0) this.skipTurn();
    return this.roll;
  }

  rollDice() {
    if (this.state !== ROLLING) throw new Error(`ロールできない状態です: ${this.state}`);
    const die1 = this.die();
    const die2 = this.die();
    this.roll = { die1, die2 };
    this.legalMoves = generateMoves(this.board, this.currentPlayer, die1, die2);
    this.state = MOVING;
    this.log.push({ kind: 'roll', player: this.currentPlayer, roll: [die1, die2] });
    if (this.legalMoves.length === 0) this.skipTurn();
    return this.roll;
  }

  skipTurn() {
    this.log.push({ kind: 'skip', player: this.currentPlayer, roll: [this.roll.die1, this.roll.die2] });
    this.currentPlayer = opponent(this.currentPlayer);
    this.legalMoves = [];
    this.state = ROLLING;
  }

  /** 着手を適用する。決着したら result が入る。 */
  applyMove(index) {
    if (this.state !== MOVING) throw new Error(`着手できない状態です: ${this.state}`);
    const move = this.legalMoves[index];
    if (!move) throw new Error(`合法手の範囲外です: ${index}`);

    this.board = move.resultingBoard;
    this.log.push({ kind: 'move', player: this.currentPlayer, text: move.toString() });

    if (this.board.hasWon(this.currentPlayer)) {
      const winType = this.board.winType(opponent(this.currentPlayer));
      // **ジャコビー: キューブが一度も回されていない局はギャモンも 1 点。**
      // マネーゲーム専用のルールなので、マッチでは jacoby を false にする。
      const counted = (this.jacoby && this.cube.untouched) ? 1 : winType;
      this.result = {
        winner: this.currentPlayer,
        winType,
        counted,
        points: this.cube.gameValue(counted),
        cubeValue: this.cube.value,
        jacobyApplied: this.jacoby && this.cube.untouched && winType > 1,
      };
      this.state = GAME_OVER;
      this.log.push({ kind: 'end', player: this.currentPlayer, winType,
                      points: this.result.points, jacoby: this.result.jacobyApplied });
      return this.result;
    }

    this.currentPlayer = opponent(this.currentPlayer);
    this.legalMoves = [];
    this.state = ROLLING;
    return null;
  }

  // ── ダブリングキューブ ────────────────────────────────

  /** いま手番側がダブルを提案できるか。ロール前だけ。 */
  canDouble() {
    return this.state === ROLLING && this.cube.canDouble(this.currentPlayer);
  }

  /** ダブルを提案する。相手の返事待ちになる。 */
  proposeDouble() {
    if (!this.canDouble()) {
      throw new Error(`${this.currentPlayer} はいまダブルできません (${this.state})`);
    }
    this.doublingProposer = this.currentPlayer;
    this.state = DOUBLING_PROPOSED;
    this.log.push({ kind: 'double', player: this.currentPlayer, value: this.cube.value * 2 });
  }

  /** ダブルを受ける。キューブが倍になり、受けた側が所有する。提案者がロールへ。 */
  acceptDouble() {
    if (this.state !== DOUBLING_PROPOSED) {
      throw new Error(`ダブルが提案されていません (${this.state})`);
    }
    const taker = opponent(this.doublingProposer);
    this.cube.accept(taker);
    this.log.push({ kind: 'take', player: taker, value: this.cube.value });
    this.doublingProposer = null;
    this.state = ROLLING;   // 提案者がそのまま振る
  }

  /** ダブルを断る。提案者が**倍にする前の**キューブの値で勝つ。 */
  declineDouble() {
    if (this.state !== DOUBLING_PROPOSED) {
      throw new Error(`ダブルが提案されていません (${this.state})`);
    }
    const winner = this.doublingProposer;
    this.log.push({ kind: 'pass', player: opponent(winner), value: this.cube.value });
    this.result = {
      winner,
      winType: 1,
      counted: 1,
      points: this.cube.declineCost,
      cubeValue: this.cube.value,
      jacobyApplied: false,
      declined: true,
    };
    this.doublingProposer = null;
    this.state = GAME_OVER;
    return this.result;
  }

  /**
   * 着手できる状態まで進める。合法手が無いターンは自動で飛ばす。
   * @returns {?object} 使うロール。決着していれば null。
   */
  prepareTurn() {
    for (let i = 0; i < MAX_CONSECUTIVE_SKIPS; i += 1) {
      if (this.state === GAME_OVER) return null;
      if (this.state === DOUBLING_PROPOSED) return null;
      if (this.state === MOVING) return this.roll;
      this.rollDice();
    }
    throw new Error('双方が着手不能な状態が続いたため対局を継続できません');
  }

  /** 出目の左右を入れ替えて合法手を作り直す（どちらの目を先に使うかの指定）。 */
  flipDice() {
    if (this.state !== MOVING) return false;
    const { die1, die2 } = this.roll;
    if (die1 === die2) return false;
    this.roll = { die1: die2, die2: die1 };
    this.legalMoves = generateMoves(this.board, this.currentPlayer, die2, die1);
    return true;
  }
}
