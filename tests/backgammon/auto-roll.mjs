// 自動ダイスロール・クローズアウト・ダブル可否判定の検証。
import { Board, WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import { Game, ROLLING, MOVING, GAME_OVER } from '../../docs/backgammon/src/game.js';
import { Match, MONEY } from '../../docs/backgammon/src/match.js';

const failures = [];
const fail = (label, message) => failures.push(`${label}: ${message}`);

function canDoubleCheck(match, game, humanSide) {
  return Boolean(match && match.useCube && game
    && game.state === ROLLING && game.canDouble() && game.currentPlayer === humanSide);
}

// ── 1. ダブル可否（自動ロール対象）判定のテスト ──────────

// (1) キューブ不使用
{
  const match = new Match({ length: MONEY, useCube: false });
  const game = new Game();
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  if (canDoubleCheck(match, game, WHITE)) {
    fail('no-cube', 'キューブ不使用なのにダブル可能判定になった');
  }
}

// (2) クロフォード局
{
  const match = new Match({ length: 3, useCube: true });
  const game = new Game(null, Math.random, { crawford: true });
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  if (canDoubleCheck(match, game, WHITE)) {
    fail('crawford', 'クロフォード局なのにダブル可能判定になった');
  }
}

// (3) センターキューブ（初期状態）
{
  const match = new Match({ length: MONEY, useCube: true });
  const game = new Game();
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  if (!canDoubleCheck(match, game, WHITE)) {
    fail('center-cube', 'センターキューブなのにダブル不可判定になった');
  }
}

// (4) 相手（BLACK）がキューブ所有
{
  const match = new Match({ length: MONEY, useCube: true });
  const game = new Game();
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  game.cube.owner = BLACK;
  if (canDoubleCheck(match, game, WHITE)) {
    fail('opponent-cube', '相手がキューブを持っているのにダブル可能判定になった');
  }
}

// (5) 自分（WHITE）がキューブ所有
{
  const match = new Match({ length: MONEY, useCube: true });
  const game = new Game();
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  game.cube.owner = WHITE;
  if (!canDoubleCheck(match, game, WHITE)) {
    fail('own-cube', '自分がキューブを持っているのにダブル不可判定になった');
  }
}

// ── 2. クローズアウト局面の動作テスト ──────────

{
  // White が Black をクローズアウトした盤面を作成
  // White は 1pt..6pt (index 0..5) に 2個ずつ配置（フルプライム）
  // Black はバーに 1個配置
  const board = new Board();
  for (let i = 0; i < 24; i += 1) board.points[i] = 0;
  board.bar[WHITE] = 0;
  board.bar[BLACK] = 1;
  board.off[WHITE] = 0;
  board.off[BLACK] = 0;

  // White のインナーボード 6点 (index 0..5) をブロック
  for (let i = 0; i < 6; i += 1) {
    board.points[i] = 2; // White 2個
  }
  // 残り 3個を 7pt (index 6) に配置
  board.points[6] = 3;

  // Black の残り 14個を 24pt (index 23) に配置
  board.points[23] = -14;

  const game = new Game(board);
  game.currentPlayer = BLACK;
  game.state = ROLLING;

  // Black がロール → どの目が出ても入れずにスキップ（手番が White に移る）
  game.rollDice();
  if (game.currentPlayer !== WHITE) {
    fail('closeout-dance', `Black がクローズアウト中にダンスせず手番=${game.currentPlayer}`);
  }
  if (game.state !== ROLLING) {
    fail('closeout-dance-state', `White の手番開始時の状態が ${game.state}（ROLLING のはず）`);
  }

  // キューブが相手持ちの場合、White はダブルできないので自動ロール対象
  game.cube.owner = BLACK;
  const match = new Match({ length: MONEY, useCube: true });
  if (canDoubleCheck(match, game, WHITE)) {
    fail('closeout-auto-roll', 'クローズアウトで相手キューブなのにダブル可能判定になった');
  }

  // White がロール
  game.rollDice();
  if (game.state !== MOVING || game.legalMoves.length === 0) {
    fail('closeout-white-move', 'White がクローズアウト後に着手可能にならなかった');
  }
}

// ── 3. ポイントメイク判定（両方の出目を使う場合のみ対象） ──

function isMovePureMakePoint(move, targetIndex) {
  if (move.singles.length === 2) {
    return move.singles.every((s) => s.to === targetIndex);
  }
  const pieces = [];
  for (const s of move.singles) {
    const idx = pieces.findIndex((p) => p.current === s.from);
    if (idx >= 0) pieces[idx].current = s.to;
    else pieces.push({ current: s.to });
  }
  return pieces.length > 0 && pieces.every((p) => p.current === targetIndex);
}

function findMakePointMoveTest(board, legalMoves, player, targetIndex) {
  if (!legalMoves || legalMoves.length === 0) return null;
  const initialCount = board.count(targetIndex, player);
  if (initialCount !== 0) return null;
  const candidates = legalMoves.filter((move) => {
    const endCount = move.resultingBoard.count(targetIndex, player);
    if (endCount < 2) return false;
    return isMovePureMakePoint(move, targetIndex);
  });
  return candidates.length > 0 ? candidates[0] : null;
}

// (1) 初期配置 6-1 -> 7pt (index 6) のみメイク対象
{
  const board = new Board();
  const game = new Game(board);
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  game.rollDice = () => ({ die1: 6, die2: 1 });
  const { generateMoves } = await import('../../docs/backgammon/src/rules.js');
  const moves = generateMoves(board, WHITE, 6, 1);

  const res7 = findMakePointMoveTest(board, moves, WHITE, 6);
  if (!res7 || res7.toString() !== '13/7 8/7') {
    fail('make-point-61-7pt', `初期配置 6-1 で 7pt メイクが見つからない (${res7?.toString()})`);
  }

  // 7pt 以外はすべて null になること
  for (let i = 0; i < 24; i += 1) {
    if (i !== 6 && findMakePointMoveTest(board, moves, WHITE, i)) {
      fail('make-point-61-other', `初期配置 6-1 で 7pt 以外 (${i + 1}pt) がメイク対象になった`);
    }
  }
}

// (2) バーに駒がある時（on the bar）は、片目カバリング等があってもポイントメイク対象にならないこと
{
  const board = new Board();
  board.bar[WHITE] = 1;
  board.points[12] -= 1;
  board.points[19] = 1;  // 20pt (index 19) にブロット
  board.points[23] -= 1;
  const { generateMoves } = await import('../../docs/backgammon/src/rules.js');
  const moves = generateMoves(board, WHITE, 4, 2);

  for (let i = 0; i < 24; i += 1) {
    if (findMakePointMoveTest(board, moves, WHITE, i)) {
      fail('make-point-bar', `バーに駒がある時に ${i + 1}pt がメイク対象になった`);
    }
  }
}
// (3) ゾロ目の場合（2-2）: 4pt (index 3), 11pt (index 10), 22pt (index 21) が対象になり、
// 4pt をメイクした後は 2 回分消費（isFullTurn = false）となり残り 2 回が残ること
{
  const board = new Board();
  const { generateMoves, SingleMove, applySingle, diceValues, boardKey, canReach } =
    await import('../../docs/backgammon/src/rules.js');
  const moves = generateMoves(board, WHITE, 2, 2);
  const allowedKeys = new Set(moves.map((m) => boardKey(m.resultingBoard)));

  function findDoublesTest(curBoard, rest, targetIndex) {
    const die = 2;
    const sourceIndex = targetIndex + die;
    if (sourceIndex < 0 || sourceIndex >= 24) return null;
    if (curBoard.bar[WHITE] > 0) return null;
    if (curBoard.count(sourceIndex, WHITE) < 2) return null;
    if (curBoard.count(targetIndex, WHITE) !== 0) return null;
    if (curBoard.points[targetIndex] < -1) return null;

    const hit = curBoard.points[targetIndex] === -1;
    const s1 = new SingleMove(sourceIndex, targetIndex, die, hit);
    const s2 = new SingleMove(sourceIndex, targetIndex, die, false);
    const work = curBoard.clone();
    applySingle(work, WHITE, s1);
    applySingle(work, WHITE, s2);

    const remAfter = rest.slice(2);
    if (!canReach(work, WHITE, remAfter, allowedKeys)) return null;
    return { singles: [s1, s2], isFullTurn: remAfter.length === 0, resultingBoard: work };
  }

  // 初期配置 2-2
  const targets = [];
  for (let i = 0; i < 24; i += 1) {
    if (findDoublesTest(board, [2, 2, 2, 2], i)) targets.push(i + 1);
  }
  // 4pt, 11pt, 22pt (1-based) が検出されること
  if (targets.join(',') !== '4,11,22') {
    fail('make-point-doubles-targets', `初期 2-2 のメイク対象が違う: ${targets.join(',')}`);
  }

  // 4pt をメイク
  const act4 = findDoublesTest(board, [2, 2, 2, 2], 3);
  if (!act4 || act4.isFullTurn !== false) {
    fail('make-point-doubles-partial', 'ゾロ目で 2 回分消費時に isFullTurn が false になっていない');
  }

  // 4pt メイク後の盤面から 11pt をメイク -> 今度は 4 回使い切って isFullTurn = true
  const act11 = findDoublesTest(act4.resultingBoard, [2, 2], 10);
  if (!act11 || act11.isFullTurn !== true) {
    fail('make-point-doubles-final', 'ゾロ目で 4 回使い切った時に isFullTurn が true になっていない');
  }
}

// ── 4. ベアオフ判定（出目を 2 つ使って 2 駒ベアオフできる場合のみ対象） ──
{
  const { generateMoves, SingleMove, applySingle, diceValues, boardKey, canReach, nextSingles } =
    await import('../../docs/backgammon/src/rules.js');

  function findBearOffTest(curBoard, legalMoves, roll, applied) {
    const allowedKeys = new Set(legalMoves.map((m) => boardKey(m.resultingBoard)));
    const player = WHITE;
    if (!curBoard.allInHome(player)) return null;

    const rest = diceValues(roll.die1, roll.die2);
    for (const s of applied) {
      const at = rest.indexOf(s.die);
      if (at >= 0) rest.splice(at, 1);
    }
    if (rest.length < 2) return null;

    const { die1, die2 } = roll;
    if (die1 !== die2) {
      if (applied.length > 0) return null;
      const candidates = legalMoves.filter((move) => {
        return move.singles.length === 2 && move.singles.every((s) => s.to === null);
      });
      if (candidates.length === 0) return null;
      return { singles: candidates[0].singles, isFullTurn: true, move: candidates[0] };
    }

    const availableSingles = nextSingles(curBoard, player, rest, allowedKeys).filter((s) => s.to === null);
    if (availableSingles.length === 0) return null;

    for (const s1 of availableSingles) {
      const b1 = curBoard.clone();
      applySingle(b1, player, s1);
      const secondSingles = nextSingles(b1, player, rest.slice(1), allowedKeys).filter((s) => s.to === null);
      for (const s2 of secondSingles) {
        const b2 = b1.clone();
        applySingle(b2, player, s2);
        const remainingAfter = rest.slice(2);
        if (canReach(b2, player, remainingAfter, allowedKeys)) {
          return { singles: [s1, s2], isFullTurn: remainingAfter.length === 0, resultingBoard: b2 };
        }
      }
    }
    return null;
  }

  // (1) 6-5 で 6pt に 1枚、5pt に 1枚 -> 2 駒ベアオフ可能
  const b1 = new Board();
  for (let i = 0; i < 24; i += 1) b1.points[i] = 0;
  b1.points[5] = 1;
  b1.points[4] = 1;
  b1.off[WHITE] = 13;
  b1.points[23] = -15;
  const moves65 = generateMoves(b1, WHITE, 6, 5);
  const res65 = findBearOffTest(b1, moves65, { die1: 6, die2: 5 }, []);
  if (!res65 || res65.isFullTurn !== true) {
    fail('bear-off-65-full', 'ベアオフ 6-5 で 2 駒ベアオフが認識されない');
  }

  // (2) 6-1 で 6pt に 1枚、2pt に 1枚（1pt は空） -> 1 の目で 2pt を上がれないので 2 駒ベアオフ不可 (null)
  const b2 = new Board();
  for (let i = 0; i < 24; i += 1) b2.points[i] = 0;
  b2.points[5] = 1;
  b2.points[1] = 1;
  b2.off[WHITE] = 13;
  b2.points[23] = -15;
  const moves61 = generateMoves(b2, WHITE, 6, 1);
  const res61 = findBearOffTest(b2, moves61, { die1: 6, die2: 1 }, []);
  if (res61 !== null) {
    fail('bear-off-61-partial', '6-1 で 2 駒ベアオフできないのに有効判定された');
  }

  // (3) 2-2 で 2pt に 4枚 -> 2 駒ベアオフで 2 回分消費 (isFullTurn = false)
  const b3 = new Board();
  for (let i = 0; i < 24; i += 1) b3.points[i] = 0;
  b3.points[1] = 4;
  b3.off[WHITE] = 11;
  b3.points[23] = -15;
  const moves22 = generateMoves(b3, WHITE, 2, 2);
  const res22 = findBearOffTest(b3, moves22, { die1: 2, die2: 2 }, []);
  if (!res22 || res22.isFullTurn !== false) {
    fail('bear-off-22-partial', '2-2 で 2 駒ベアオフ時に isFullTurn が false になっていない');
  }
}

console.log('自動ロール・クローズアウト・ダブル可否・ポイントメイク・ベアオフ:');
if (failures.length) {
  console.error(`  不一致 ${failures.length} 件:`);
  for (const f of failures) console.error(`    - ${f}`);
  process.exitCode = 1;
} else {
  console.log('  すべての自動ロール・ダブル可否・ポイントメイク・ベアオフ条件を満たした');
}
