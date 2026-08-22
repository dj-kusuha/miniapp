// マッチ進行（スコア / クロフォード / 終了）の検証。
//
// **engine（Python）側にマッチプレイは無い**ので、ここにパリティの相手はいない。
// 規則そのものを主張として書き下し、乱数で回した多数のマッチが破らないことを
// 確かめる形にしてある。

import { WHITE, BLACK } from '../../docs/backgammon/src/board.js';
import { GAME_OVER } from '../../docs/backgammon/src/game.js';
import { Match, MONEY } from '../../docs/backgammon/src/match.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 1 局を最後まで。ダブルは `canDouble()` を通してしか出さない。 */
function playGame(game, rng) {
  for (let i = 0; i < 2000 && game.state !== GAME_OVER; i += 1) {
    if (game.canDouble() && rng() < 0.12) {
      game.proposeDouble();
      if (rng() < 0.7) game.acceptDouble();
      else game.declineDouble();
      continue;
    }
    if (game.legalMoves.length === 0) {
      game.rollDice();
      continue;
    }
    game.applyMove(Math.floor(rng() * game.legalMoves.length));
  }
}

const failures = [];
const fail = (label, message) => failures.push(`${label}: ${message}`);

// ── 1. マッチを回して、規則が破られないことを見る ──────────

let matches = 0;
let games = 0;
let crawfordGames = 0;
let postCrawfordDoubles = 0;
let cappedWins = 0;

for (const length of [1, 2, 3, 5, 7]) {
  for (let seed = 1; seed <= 25; seed += 1) {
    const label = `${length}pt seed ${seed}`;
    const rng = seeded(seed * 7919 + length);
    const match = new Match({ length, jacoby: true, useCube: true, rng });
    matches += 1;

    // ジャコビーはアンリミテッド専用。マッチでは設定に関わらず切れていること
    if (match.jacoby) fail(label, 'マッチなのにジャコビーが有効');

    let seenCrawford = 0;
    let guard = 0;
    while (!match.isOver && guard < 200) {
      guard += 1;
      const before = { ...match.scores };
      const leaderBefore = match.matchPointSide();
      const expectCrawford = leaderBefore !== null && seenCrawford === 0;

      const game = match.startGame();
      if (!game) { fail(label, 'マッチが終わっていないのに局を始められない'); break; }
      games += 1;

      if (game.crawford !== expectCrawford) {
        fail(label, `クロフォード判定が違う（局=${game.crawford} / 期待=${expectCrawford}）`);
      }
      if (game.crawford) {
        seenCrawford += 1;
        crawfordGames += 1;
        // **クロフォード局はどちらもダブルできない。** 両手番で確かめる。
        if (game.canDouble()) fail(label, 'クロフォード局なのにダブルできる');
      }

      playGame(game, rng);
      if (game.state !== GAME_OVER) { fail(label, '局が終わらなかった'); break; }

      // クロフォード局にダブルの記録が残っていないこと
      if (game.crawford && game.log.some((e) => e.kind === 'double')) {
        fail(label, 'クロフォード局でダブルが記録されている');
      }
      if (!game.crawford && match.crawfordDone && game.log.some((e) => e.kind === 'double')) {
        postCrawfordDoubles += 1;
      }

      match.sync();

      // スコアは勝った側にだけ、素の点ぶん（上限で頭打ち）加算される
      const winner = game.result.winner;
      const loser = winner === WHITE ? BLACK : WHITE;
      if (match.scores[loser] !== before[loser]) fail(label, '負けた側のスコアが動いた');
      const want = Math.min(before[winner] + game.result.points, length);
      if (match.scores[winner] !== want) {
        fail(label, `スコアが違う（${match.scores[winner]} / 期待 ${want}）`);
      }
      if (before[winner] + game.result.points > length) cappedWins += 1;
      if (match.scores[winner] > length) fail(label, 'スコアがマッチの長さを超えた');
    }

    if (!match.isOver) fail(label, 'マッチが終わらなかった');
    // **クロフォード局が 1 度も来ないマッチはある。** 0-0 からギャモンや
    // キューブで一気に取り切ると、誰もマッチポイント（あと 1 点）を通らない。
    // 「必ず 1 回」ではなく「多くても 1 回」が正しい主張。
    if (seenCrawford > 1) fail(label, `クロフォード局が ${seenCrawford} 回（多くても 1 回）`);
    if (match.winner === null) fail(label, '勝者が決まっていない');
    else if (match.scores[match.winner] !== length) {
      fail(label, `勝者のスコアが ${match.scores[match.winner]}（${length} のはず）`);
    }
    // 終わったマッチではもう局を始められない
    if (match.startGame() !== null) fail(label, '終わったマッチで局を始められてしまう');
  }
}

// ── 2. 1 ポイントマッチは最初からクロフォード ────────────

{
  const match = new Match({ length: 1, rng: seeded(1) });
  const game = match.startGame();
  if (!game.crawford) fail('1pt', '最初の局がクロフォードになっていない');
  if (game.canDouble()) fail('1pt', '1 ポイントマッチでダブルできる');
}

// ── 3. アンリミテッドは終わらず、クロフォードも無い ──────────

{
  const rng = seeded(42);
  const match = new Match({ length: MONEY, jacoby: true, rng });
  if (!match.jacoby) fail('money', 'アンリミテッドなのにジャコビーが切れている');
  for (let i = 0; i < 5; i += 1) {
    const game = match.startGame();
    if (game.crawford) fail('money', 'アンリミテッドにクロフォード局が出た');
    if (!game.jacoby) fail('money', 'アンリミテッドの局でジャコビーが切れている');
    playGame(game, rng);
    match.sync();
  }
  if (match.isOver) fail('money', 'アンリミテッドが終わってしまった');
  if (match.entries.length !== 5) fail('money', `局数が ${match.entries.length}`);
  if (match.awayFor(WHITE) !== null) fail('money', 'アンリミテッドで away が出ている');
}

// ── 4. `sync()` は何度呼んでもスコアが増えない ────────────

{
  const rng = seeded(7);
  const match = new Match({ length: 5, rng });
  const game = match.startGame();
  playGame(game, rng);
  match.sync();
  const once = { ...match.scores };
  match.sync();
  match.sync();
  if (match.scores[WHITE] !== once[WHITE] || match.scores[BLACK] !== once[BLACK]) {
    fail('sync', '2 回目以降の sync() でスコアが動いた');
  }
}

// ── 結果 ────────────────────────────────────

console.log(`マッチ進行: ${matches} マッチ / ${games} 局`);
console.log(`  クロフォード局 ${crawfordGames} / ポストクロフォードのダブル ${postCrawfordDoubles} 局`);
console.log(`  必要点を超えて勝った局 ${cappedWins}（スコアは上限で頭打ち）`);

if (crawfordGames === 0) {
  failures.push('クロフォード局が 1 度も出ていない（検体不足）');
}
if (postCrawfordDoubles === 0) {
  failures.push('ポストクロフォードでダブルが 1 度も出ていない（検体不足）');
}

if (failures.length) {
  console.error(`\n不一致 ${failures.length} 件:`);
  for (const f of failures.slice(0, 20)) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('  マッチの規則をすべて満たした');
}
