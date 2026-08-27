// 自動ダイスロール・クローズアウト・ダブル可否・ポイントメイク・ベアオフ判定の検証。
// 本番コード（src/rules.js, src/game.js, src/match.js）から直接関数を import して検証する。
import { Board, WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import { Game, ROLLING, MOVING, GAME_OVER } from '../../docs/backgammon/src/game.js';
import { Match, MONEY } from '../../docs/backgammon/src/match.js';
import {
  generateMoves,
  boardKey,
  canPlayerDouble,
  findPointMakeAction,
  findBearOffAction,
} from '../../docs/backgammon/src/rules.js';

const failures = [];
const fail = (label, message) => failures.push(`${label}: ${message}`);

// ── 1. ダブル可否（canPlayerDouble）のテスト ──────────

// (1) キューブ不使用
{
  const match = new Match({ length: MONEY, useCube: false });
  const game = new Game();
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  if (canPlayerDouble(game, match, WHITE)) {
    fail('no-cube', 'キューブ不使用なのにダブル可能判定になった');
  }
}

// (2) クロフォード局
{
  const match = new Match({ length: 3, useCube: true });
  const game = new Game(null, Math.random, { crawford: true });
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  if (canPlayerDouble(game, match, WHITE)) {
    fail('crawford', 'クロフォード局なのにダブル可能判定になった');
  }
}

// (3) センターキューブ（手番側 WHITE）
{
  const match = new Match({ length: MONEY, useCube: true });
  const game = new Game();
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  if (!canPlayerDouble(game, match, WHITE)) {
    fail('center-cube-turn', 'センターキューブの手番なのにダブル不可判定になった');
  }
}

// (4) センターキューブだが手番でない側（BLACK）
{
  const match = new Match({ length: MONEY, useCube: true });
  const game = new Game();
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  if (canPlayerDouble(game, match, BLACK)) {
    fail('center-cube-not-turn', '手番でないプレイヤーがダブル可能判定になった');
  }
}

// (5) 相手（BLACK）がキューブ所有
{
  const match = new Match({ length: MONEY, useCube: true });
  const game = new Game();
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  game.cube.owner = BLACK;
  if (canPlayerDouble(game, match, WHITE)) {
    fail('opponent-cube', '相手がキューブを持っているのにダブル可能判定になった');
  }
}

// (6) 自分（WHITE）がキューブ所有
{
  const match = new Match({ length: MONEY, useCube: true });
  const game = new Game();
  game.currentPlayer = WHITE;
  game.state = ROLLING;
  game.cube.owner = WHITE;
  if (!canPlayerDouble(game, match, WHITE)) {
    fail('own-cube', '自分がキューブを持っているのにダブル不可判定になった');
  }
}

// (7) MOVING 状態（ロール後）
{
  const match = new Match({ length: MONEY, useCube: true });
  const game = new Game();
  game.currentPlayer = WHITE;
  game.state = MOVING;
  if (canPlayerDouble(game, match, WHITE)) {
    fail('moving-state', 'MOVING 状態なのにダブル可能判定になった');
  }
}

// ── 2. クローズアウト局面の動作テスト ──────────

{
  const board = new Board();
  for (let i = 0; i < 24; i += 1) board.points[i] = 0;
  board.bar[WHITE] = 0;
  board.bar[BLACK] = 1;
  board.off[WHITE] = 0;
  board.off[BLACK] = 0;

  // White のインナーボード 6点 (index 0..5) をブロック
  for (let i = 0; i < 6; i += 1) board.points[i] = 2;
  board.points[6] = 3;
  board.points[23] = -14;

  const game = new Game(board);
  game.currentPlayer = BLACK;
  game.state = ROLLING;

  // Black がロール → ダンスして White へ
  game.rollDice();
  if (game.currentPlayer !== WHITE) {
    fail('closeout-dance', `Black がクローズアウト中にダンスせず手番=${game.currentPlayer}`);
  }
  if (game.state !== ROLLING) {
    fail('closeout-dance-state', `White の手番開始時の状態が ${game.state}（ROLLING のはず）`);
  }

  // 相手キューブ時のダブル不可
  game.cube.owner = BLACK;
  const match = new Match({ length: MONEY, useCube: true });
  if (canPlayerDouble(game, match, WHITE)) {
    fail('closeout-auto-roll', 'クローズアウトで相手キューブなのにダブル可能判定になった');
  }

  // White がロール
  game.rollDice();
  if (game.state !== MOVING || game.legalMoves.length === 0) {
    fail('closeout-white-move', 'White がクローズアウト後に着手可能にならなかった');
  }
}

// ── 3. ポイントメイク判定（findPointMakeAction）のテスト ──

// (1) White 視点: 初期配置 6-1 -> 7pt (index 6) のみメイク対象
{
  const board = new Board();
  const moves = generateMoves(board, WHITE, 6, 1);
  const roll = { die1: 6, die2: 1 };

  const res7 = findPointMakeAction(board, moves, WHITE, roll, [], 6);
  if (!res7 || res7.move?.toString() !== '13/7 8/7') {
    fail('make-point-white-61-7pt', `White 初期配置 6-1 で 7pt メイクが見つからない (${res7?.move?.toString()})`);
  }

  // 7pt (index 6) 以外はすべて null
  for (let i = 0; i < 24; i += 1) {
    if (i !== 6 && findPointMakeAction(board, moves, WHITE, roll, [], i)) {
      fail('make-point-white-61-other', `White 初期配置 6-1 で 7pt 以外 (${i + 1}pt) がメイク対象になった`);
    }
  }
}

// (2) Black 視点: 初期配置 6-1 -> Black の 7pt (index 17) のみメイク対象
{
  const board = new Board();
  const moves = generateMoves(board, BLACK, 6, 1);
  const roll = { die1: 6, die2: 1 };

  const res7 = findPointMakeAction(board, moves, BLACK, roll, [], 17);
  if (!res7 || res7.move?.toString() !== '13/7 8/7') {
    fail('make-point-black-61-7pt', `Black 初期配置 6-1 で 7pt メイクが見つからない (${res7?.move?.toString()})`);
  }

  for (let i = 0; i < 24; i += 1) {
    if (i !== 17 && findPointMakeAction(board, moves, BLACK, roll, [], i)) {
      fail('make-point-black-61-other', `Black 初期配置 6-1 で 7pt 以外 (${i} index) がメイク対象になった`);
    }
  }
}

// (3) White 視点: ゾロ目 2-2 -> 4pt, 11pt, 22pt が対象
{
  const board = new Board();
  const moves = generateMoves(board, WHITE, 2, 2);
  const roll = { die1: 2, die2: 2 };

  const targets = [];
  for (let i = 0; i < 24; i += 1) {
    if (findPointMakeAction(board, moves, WHITE, roll, [], i)) targets.push(i + 1);
  }
  if (targets.join(',') !== '4,11,22') {
    fail('make-point-white-22-targets', `White 初期 2-2 のメイク対象が違う: ${targets.join(',')}`);
  }

  const allowedKeys = new Set(moves.map((m) => boardKey(m.resultingBoard)));

  // (a) 正しい allowedKeys を渡した場合はメイク可能
  const act4 = findPointMakeAction(board, moves, WHITE, roll, [], 3, allowedKeys);
  if (!act4 || act4.isFullTurn !== false) {
    fail('make-point-white-22-partial', 'ゾロ目で 2 回分消費時に isFullTurn が false になっていない');
  }

  // (b) 空の allowedKeys を渡した場合は到達不能として null が返ること（allowedKeys 引数が実際に使われていることの証明）
  const act4Restricted = findPointMakeAction(board, moves, WHITE, roll, [], 3, new Set());
  if (act4Restricted !== null) {
    fail('make-point-white-22-restricted', '制限された allowedKeys を渡したのにアクションが返された');
  }

  // 4pt メイク後の盤面から 11pt (index 10) をメイク -> 4 回消費完了 (isFullTurn = true)
  if (act4 && act4.resultingBoard && act4.singles) {
    const act11 = findPointMakeAction(act4.resultingBoard, moves, WHITE, roll, act4.singles, 10, allowedKeys);
    if (!act11 || act11.isFullTurn !== true) {
      fail('make-point-white-22-final', 'ゾロ目で 4 回使い切った時に isFullTurn が true になっていない');
    }
  } else {
    fail('make-point-white-22-step1-missing', 'ステップ1 (act4) の resultingBoard が取得できなかった');
  }
}

// (4) Black 視点: ゾロ目 2-2 -> Black の 4pt (index 20), 11pt (index 13), 22pt (index 2) が対象
{
  const board = new Board();
  const moves = generateMoves(board, BLACK, 2, 2);
  const roll = { die1: 2, die2: 2 };

  const targets = [];
  for (let i = 0; i < 24; i += 1) {
    if (findPointMakeAction(board, moves, BLACK, roll, [], i)) targets.push(24 - i);
  }
  if (targets.join(',') !== '22,11,4') {
    fail('make-point-black-22-targets', `Black 初期 2-2 のメイク対象が違う: ${targets.join(',')}`);
  }
}

// (5) バーに駒がある時 -> ポイントメイク不可
{
  const board = new Board();
  board.bar[WHITE] = 1;
  board.points[12] -= 1;
  board.points[19] = 1;
  board.points[23] -= 1;
  const moves = generateMoves(board, WHITE, 4, 2);
  const roll = { die1: 4, die2: 2 };

  for (let i = 0; i < 24; i += 1) {
    if (findPointMakeAction(board, moves, WHITE, roll, [], i)) {
      fail('make-point-bar', `バーに駒がある時に ${i + 1}pt がメイク対象になった`);
    }
  }
}

// (6) すでに自駒が 1 枚以上あるマス（カバーやスタック） -> ポイントメイク不可
{
  const board = new Board();
  // 1pt (index 0) に自駒が 2枚ある状態
  board.points[0] = 2;
  const moves = generateMoves(board, WHITE, 6, 5);
  const roll = { die1: 6, die2: 5 };

  if (findPointMakeAction(board, moves, WHITE, roll, [], 0)) {
    fail('make-point-existing', 'すでに駒があるマス (1pt) がメイク対象になった');
  }
}

// ── 4. ベアオフ判定（findBearOffAction）のテスト ──────────

// (1) White 視点: 6-5 で 6pt に 1枚、5pt に 1枚 -> 2 駒ベアオフ可能 (isFullTurn = true)
{
  const board = new Board();
  for (let i = 0; i < 24; i += 1) board.points[i] = 0;
  board.points[5] = 1;
  board.points[4] = 1;
  board.off[WHITE] = 13;
  board.points[23] = -15;
  const moves = generateMoves(board, WHITE, 6, 5);
  const roll = { die1: 6, die2: 5 };

  const res = findBearOffAction(board, moves, WHITE, roll, []);
  if (!res || res.isFullTurn !== true) {
    fail('bear-off-white-65-full', 'White 6-5 で 2 駒ベアオフが認識されない');
  }
}

// (2) Black 視点: 6-5 で Black の 6pt (index 18) に 1枚、5pt (index 19) に 1枚 -> 2 駒ベアオフ可能
{
  const board = new Board();
  for (let i = 0; i < 24; i += 1) board.points[i] = 0;
  board.points[18] = -1;
  board.points[19] = -1;
  board.off[BLACK] = 13;
  board.points[0] = 15;
  const moves = generateMoves(board, BLACK, 6, 5);
  const roll = { die1: 6, die2: 5 };

  const res = findBearOffAction(board, moves, BLACK, roll, []);
  if (!res || res.isFullTurn !== true) {
    fail('bear-off-black-65-full', 'Black 6-5 で 2 駒ベアオフが認識されない');
  }
}

// (3) 6-1 で 6pt に 1枚、2pt に 1枚（1pt空） -> 2 駒ベアオフ不可 (null)
{
  const board = new Board();
  for (let i = 0; i < 24; i += 1) board.points[i] = 0;
  board.points[5] = 1;
  board.points[1] = 1;
  board.off[WHITE] = 13;
  board.points[23] = -15;
  const moves = generateMoves(board, WHITE, 6, 1);
  const roll = { die1: 6, die2: 1 };

  const res = findBearOffAction(board, moves, WHITE, roll, []);
  if (res !== null) {
    fail('bear-off-61-invalid', '6-1 で 2 駒ベアオフできないのに有効判定された');
  }
}

// (4) ゾロ目 2-2 で 2pt に 4枚 -> 2 駒ベアオフで 2 回分消費 (isFullTurn = false)
{
  const board = new Board();
  for (let i = 0; i < 24; i += 1) board.points[i] = 0;
  board.points[1] = 4;
  board.off[WHITE] = 11;
  board.points[23] = -15;
  const moves = generateMoves(board, WHITE, 2, 2);
  const roll = { die1: 2, die2: 2 };

  const res1 = findBearOffAction(board, moves, WHITE, roll, []);
  if (!res1 || res1.isFullTurn !== false) {
    fail('bear-off-22-partial', '2-2 で 2 駒ベアオフ時に isFullTurn が false になっていない');
  }

  // 続けて残り 2 駒もベアオフ -> 4 回消費完了 (isFullTurn = true)
  const res2 = findBearOffAction(res1.resultingBoard, moves, WHITE, roll, res1.singles);
  if (!res2 || res2.isFullTurn !== true) {
    fail('bear-off-22-final', '2-2 で 4 回使い切った時に isFullTurn が true になっていない');
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
