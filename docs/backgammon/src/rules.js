// 合法手の生成。backgammon_engine の `backgammon/moves.py` の移植。
//
// **ここが移植の山。** 向きを間違えても片方のプレイヤーでだけ静かに壊れるので、
// 目視では気づけない。`test/parity-moves.mjs` で engine の出力と突き合わせること。
//
// ルール:
//   1. バーに駒があれば必ず先に復帰させる
//   2. 使える出目は**できるだけ多く**使う
//   3. 片方しか使えないなら**大きい方**を使う
//   4. 何も動かせなければ手番を飛ばす（空配列）
//   5. ベアオフは全駒が自陣に入ってから
//   6. ちょうどの目、または「その目より遠い駒が無ければ最も遠い駒」から上がれる

import { Board, WHITE, BLACK, opponent, direction } from './board.js';

/** 出目 1 つぶんの着手。`from`/`to` が null ならバー復帰／ベアオフ。 */
export class SingleMove {
  constructor(from, to, die, hit) {
    this.from = from;   // null = バーから
    this.to = to;       // null = ベアオフ
    this.die = die;
    this.hit = hit;
  }
}

/** 1 ターンぶんの着手（出目の数だけ SingleMove を含む）。 */
export class Move {
  constructor(singles, resultingBoard, player) {
    this.singles = singles;
    this.resultingBoard = resultingBoard;
    this.player = player;
  }

  /** 棋譜表記。engine の `Move.__str__` と同じで、着手側視点のポイント番号。 */
  toString() {
    return this.singles.map((s) => {
      const src = s.from === null ? 'bar' : String(pointNumber(this.player, s.from));
      const dst = s.to === null ? 'off' : String(pointNumber(this.player, s.to));
      return `${src}/${dst}${s.hit ? '*' : ''}`;
    }).join(' ');
  }
}

/** index を着手側視点のポイント番号（1〜24）に直す。 */
export function pointNumber(player, index) {
  return player === WHITE ? index + 1 : 24 - index;
}

/** ダイスの出目。ゾロ目なら 4 つ使える。 */
export function diceValues(die1, die2) {
  return die1 === die2 ? [die1, die1, die1, die1] : [die1, die2];
}

function singleMovesFor(board, player, die) {
  const moves = [];
  const isWhite = player === WHITE;
  const points = board.points;

  // バーからの復帰が最優先。White は 24 番側（index 23）から入る。
  if (board.bar[player] > 0) {
    const target = isWhite ? 24 - die : die - 1;
    const value = points[target];
    const open = isWhite ? value > -2 : value < 2;
    if (open) {
      const hit = isWhite ? value === -1 : value === 1;
      moves.push(new SingleMove(null, target, die, hit));
    }
    return moves;   // バーがある間は他の駒を動かせない
  }

  const canBearOff = board.allInHome(player);
  const farthest = canBearOff ? board.farthestChecker(player) : -1;
  const dir = direction(player);

  for (let i = 0; i < 24; i += 1) {
    const value = points[i];
    if (isWhite ? value <= 0 : value >= 0) continue;   // 自分の駒がない

    const target = i + dir * die;
    if (target < 0 || target >= 24) {
      // 盤外 = ベアオフ。ちょうどの目（-1 / 24）か、最も遠い駒からのみ。
      if (canBearOff && (target === -1 || target === 24 || i === farthest)) {
        moves.push(new SingleMove(i, null, die, false));
      }
      continue;
    }

    const targetValue = points[target];
    const open = isWhite ? targetValue > -2 : targetValue < 2;
    if (open) {
      const hit = isWhite ? targetValue === -1 : targetValue === 1;
      moves.push(new SingleMove(i, target, die, hit));
    }
  }
  return moves;
}

export function applySingle(board, player, single) {
  const sign = player === WHITE ? 1 : -1;
  if (single.from === null) board.bar[player] -= 1;
  else board.points[single.from] -= sign;

  if (single.to === null) {
    board.off[player] += 1;
  } else {
    if (single.hit) {
      board.points[single.to] = 0;
      board.bar[opponent(player)] += 1;
    }
    board.points[single.to] += sign;
  }
}

function undoSingle(board, player, single) {
  const sign = player === WHITE ? 1 : -1;
  if (single.to === null) {
    board.off[player] -= 1;
  } else {
    board.points[single.to] -= sign;
    if (single.hit) {
      board.bar[opponent(player)] -= 1;
      board.points[single.to] = -sign;
    }
  }
  if (single.from === null) board.bar[player] += 1;
  else board.points[single.from] += sign;
}

function generateRecursive(board, player, remaining, current, out) {
  if (remaining.length === 0) {
    out.push({ singles: [...current], board: board.clone() });
    return;
  }

  let found = false;
  const tried = new Set();
  for (let i = 0; i < remaining.length; i += 1) {
    const die = remaining[i];
    if (tried.has(die)) continue;   // 同じ出目を二度試さない
    tried.add(die);

    const rest = remaining.slice(0, i).concat(remaining.slice(i + 1));
    for (const single of singleMovesFor(board, player, die)) {
      found = true;
      applySingle(board, player, single);
      current.push(single);
      generateRecursive(board, player, rest, current, out);
      current.pop();
      undoSingle(board, player, single);
    }
  }

  if (!found) {
    // 残りの出目では何も動かせない。ここまでを 1 つの手順として記録する。
    out.push({ singles: [...current], board: board.clone() });
  }
}

/** 盤面の同一性を判定する鍵（重複除去に使う）。 */
export function boardKey(board) {
  return `${board.points.join(',')}|${board.bar.WHITE},${board.bar.BLACK}`
    + `|${board.off.WHITE},${board.off.BLACK}`;
}

/**
 * 合法手をすべて生成する。
 * @returns {Move[]} 動かせなければ空配列（手番が飛ぶ）
 */
export function generateMoves(board, player, die1, die2) {
  const sequences = [];
  generateRecursive(board.clone(), player, diceValues(die1, die2), [], sequences);
  if (sequences.length === 0) return [];

  const maxUsed = Math.max(...sequences.map((s) => s.singles.length));
  if (maxUsed === 0) return [];

  let filtered = sequences.filter((s) => s.singles.length === maxUsed);

  // 片方しか使えないなら大きい方の目を使う
  if (maxUsed === 1 && die1 !== die2) {
    const higher = Math.max(die1, die2);
    const higherMoves = filtered.filter((s) => s.singles[0].die === higher);
    if (higherMoves.length > 0) filtered = higherMoves;
  }

  // 着手後の盤面が同じものは 1 つに畳む
  const seen = new Set();
  const moves = [];
  for (const seq of filtered) {
    const key = boardKey(seq.board);
    if (seen.has(key)) continue;
    seen.add(key);
    moves.push(new Move(seq.singles, seq.board, player));
  }
  return moves;
}

/**
 * `remaining` の出目を使って `allowedKeys` のどれかに到達できるか。
 * 出目を使い切る必要はない（使えなくなった時点で終わる手順も合法）。
 */
export function canReach(board, player, remaining, allowedKeys) {
  if (allowedKeys.has(boardKey(board))) return true;
  if (remaining.length === 0) return false;

  const tried = new Set();
  for (let i = 0; i < remaining.length; i += 1) {
    const die = remaining[i];
    if (tried.has(die)) continue;
    tried.add(die);

    const rest = remaining.slice(0, i).concat(remaining.slice(i + 1));
    for (const single of singleMovesFor(board, player, die)) {
      applySingle(board, player, single);
      const ok = canReach(board, player, rest, allowedKeys);
      undoSingle(board, player, single);
      if (ok) return true;
    }
  }
  return false;
}

/**
 * 途中まで指した局面から、次に選べる 1 手を返す。
 *
 * **`Move.singles` の並びを操作順として使ってはいけない。** `generateMoves` は
 * 同じ最終盤面になる手順を 1 つに畳むので、残った 1 つの並びだけを見ると
 * 「順番が違うだけの合法な手」がクリックできなくなる。ここでは並びに依存せず、
 * 残りの出目で合法な最終盤面（`allowedKeys`）に到達できるかで判定する。
 *
 * @param {Set<string>} allowedKeys ターン開始時の合法手の最終盤面の鍵。
 *   最大消費・大きい目優先の規則は `generateMoves` が適用済み。
 */
export function nextSingles(board, player, remaining, allowedKeys) {
  const work = board.clone();
  const out = [];
  const seen = new Set();
  const tried = new Set();

  for (let i = 0; i < remaining.length; i += 1) {
    const die = remaining[i];
    if (tried.has(die)) continue;
    tried.add(die);

    const rest = remaining.slice(0, i).concat(remaining.slice(i + 1));
    for (const single of singleMovesFor(work, player, die)) {
      applySingle(work, player, single);
      const reachable = canReach(work, player, rest, allowedKeys);
      undoSingle(work, player, single);
      if (!reachable) continue;

      const key = `${single.from}|${single.to}|${single.die}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(single);
    }
  }
  return out;
}
