// BG2N v4 Money cube database reader and strict exact-root evaluator.
//
// Keep this format separate from bearoff.js: BGBO stores probability windows in
// float16, while BG2N stores normalized Money equity in little-endian uint16.

import { WHITE, BLACK, opponent } from './board.js';
import { boardKey, generateMoves } from './rules.js';

const MAGIC = 'BG2N';
const VERSION = 4;
const HEADER_BYTES = 96;
const MAX_CHECKERS = 6;
const CONTEXTS = 3;
const SIDE_COUNT = 923;
const RECORD_COUNT = 5_111_574;
const FILE_BYTES = 10_223_244;
const UINT16_SCALE = 32_767;

export const MONEY_BG2N_FILE_SHA256 =
  '2ddee6d0b8285c8f755e0fe027bb5c66b678269a9dc89427f8ae9921d4a7daa1';
export const MONEY_BG2N_PAYLOAD_SHA256 =
  'e03d9e57b641ab4854ab0021fa6ef8fc2945ee2bf4d47c76b026e82f2a0ef01d';
export const MONEY_BG2N_SOURCE_SHA256 =
  'b594caed010b59d7b91b0b3e99201e8da553c325423385bd6b01f4bba3acd658';

const OWNER_INDEX = new Map([['center', 0], ['me', 1], ['opponent', 2]]);
const TURN_INDEX = new Map([[WHITE, 0], [BLACK, 1]]);
const MONEY_ROLLS = (() => {
  const rolls = [];
  for (let die1 = 1; die1 <= 6; die1 += 1) {
    for (let die2 = die1; die2 <= 6; die2 += 1) {
      rolls.push({ die1, die2, weight: die1 === die2 ? 1 / 36 : 2 / 36 });
    }
  }
  return rolls;
})();

export class Bg2nRootUnavailable extends Error {
  constructor(message, category = 'unsupported_root') {
    super(message);
    this.name = 'Bg2nRootUnavailable';
    this.category = category;
  }
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function packCounts(counts) {
  let key = 0;
  for (let index = 0; index < 6; index += 1) key |= counts[index] << (index * 4);
  return key;
}

function distributions(maximum) {
  const states = [];
  const visit = (prefix, left) => {
    if (prefix.length === 6) {
      if (left === 0) states.push(prefix);
      return;
    }
    for (let count = 0; count <= left; count += 1) visit([...prefix, count], left - count);
  };
  for (let total = 0; total <= maximum; total += 1) visit([], total);
  return states;
}

function decodeCounts(board, player) {
  if (board.bar[player] > 0) return null;
  const counts = [0, 0, 0, 0, 0, 0];
  for (let point = 0; point < 24; point += 1) {
    const count = board.count(point, player);
    if (count <= 0) continue;
    const distance = player === WHITE ? point : 23 - point;
    if (distance >= 6) return null;
    counts[distance] = count;
  }
  return counts;
}

function flipOwner(owner) {
  if (owner === 'center') return 'center';
  if (owner === 'me') return 'opponent';
  if (owner === 'opponent') return 'me';
  throw new Bg2nRootUnavailable(`未知のcube owner: ${owner}`);
}

function validateCounts(counts, maximum) {
  return Array.isArray(counts) && counts.length === 6
    && counts.every((count) => Number.isInteger(count) && count >= 0)
    && counts.reduce((sum, count) => sum + count, 0) <= maximum;
}

/**
 * Read-only BG2N v4 reader. It holds the fetched buffer and a 923-entry rank
 * index; it never expands the 5.1M values into a JS array or Map.
 */
export class MoneyBearoffDatabase {
  constructor(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== FILE_BYTES) {
      throw new Error(`BG2N v4 file size mismatch: ${buffer?.byteLength ?? 'unknown'}`);
    }
    this.buffer = buffer;
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.#readHeader();
    this.ranks = new Map();
    let rank = 0;
    for (const state of distributions(MAX_CHECKERS)) {
      if (state.some((count) => count > 0)) this.ranks.set(packCounts(state), rank++);
    }
  }

  #readHeader() {
    const magic = String.fromCharCode(...this.bytes.subarray(0, 4));
    const version = this.view.getUint16(4, true);
    const flags = this.view.getUint16(6, true);
    const maximum = this.view.getUint32(8, true);
    const contexts = this.view.getUint32(12, true);
    const sideCount = Number(this.view.getBigUint64(16, true));
    const recordCount = Number(this.view.getBigUint64(24, true));
    this.sourceSha256 = hex(this.bytes.subarray(32, 64));
    this.payloadSha256 = hex(this.bytes.subarray(64, 96));

    if (magic !== MAGIC || version !== VERSION || flags !== 0
        || maximum !== MAX_CHECKERS || contexts !== CONTEXTS
        || sideCount !== SIDE_COUNT || recordCount !== RECORD_COUNT) {
      throw new Error('BG2N v4 header/version/record count is invalid');
    }
    if (this.sourceSha256 !== MONEY_BG2N_SOURCE_SHA256
        || this.payloadSha256 !== MONEY_BG2N_PAYLOAD_SHA256) {
      throw new Error('BG2N v4 source/payload SHA-256 does not match production data');
    }
    this.version = version;
    this.maximum = maximum;
    this.sideCount = sideCount;
    this.recordCount = recordCount;
    this.valueFormat = 'uint16-symmetric-q32767';
  }

  static async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Money BG2N DB fetch failed: ${response.status}`);
    return MoneyBearoffDatabase.fromArrayBuffer(await response.arrayBuffer());
  }

  static async fromArrayBuffer(buffer, cryptoProvider = globalThis.crypto) {
    const database = new MoneyBearoffDatabase(buffer);
    if (!cryptoProvider?.subtle?.digest) throw new Error('SHA-256 digest is unavailable');
    // Code zero is reserved and invalid in the production writer. Check bytes
    // directly to avoid allocating or decoding a second 10 MB value array.
    for (let offset = HEADER_BYTES; offset < buffer.byteLength; offset += 2) {
      if (database.bytes[offset] === 0 && database.bytes[offset + 1] === 0) {
        throw new Error('BG2N v4 payload contains reserved uint16 code 0');
      }
    }
    const payload = new Uint8Array(buffer, HEADER_BYTES);
    const digest = new Uint8Array(await cryptoProvider.subtle.digest('SHA-256', payload));
    if (hex(digest) !== database.payloadSha256) {
      throw new Error('BG2N v4 payload SHA-256 mismatch');
    }
    return database;
  }

  lookupNormalizedCounts(white, black, turn, owner) {
    if (!validateCounts(white, this.maximum) || !validateCounts(black, this.maximum)) return null;
    const turnIndex = TURN_INDEX.get(turn);
    const ownerIndex = OWNER_INDEX.get(owner);
    if (turnIndex === undefined || ownerIndex === undefined) return null;
    const whiteCount = white.reduce((sum, count) => sum + count, 0);
    const blackCount = black.reduce((sum, count) => sum + count, 0);
    if (whiteCount === 0 && blackCount === 0) return null;
    if (whiteCount === 0) return turn === WHITE ? 1 : -1;
    if (blackCount === 0) return turn === BLACK ? 1 : -1;

    const whiteRank = this.ranks.get(packCounts(white));
    const blackRank = this.ranks.get(packCounts(black));
    if (whiteRank === undefined || blackRank === undefined) return null;
    const slot = (((whiteRank * this.sideCount + blackRank) * 2 + turnIndex)
      * CONTEXTS + ownerIndex);
    const code = this.view.getUint16(HEADER_BYTES + slot * 2, true);
    if (code === 0) throw new Error('BG2N v4 lookup found reserved uint16 code 0');
    const value = (code - 32768) / UINT16_SCALE;
    if (!Number.isFinite(value) || Math.abs(value) > 1 + 1e-10) {
      throw new Error(`BG2N normalized equity is out of range: ${value}`);
    }
    return value;
  }

  lookupNormalized(board, turn, owner) {
    if (board.bar[WHITE] || board.bar[BLACK]) return null;
    const white = decodeCounts(board, WHITE);
    const black = decodeCounts(board, BLACK);
    if (white === null || black === null) return null;
    return this.lookupNormalizedCounts(white, black, turn, owner);
  }
}

function validateRoot(board, turn, cube, owner, database) {
  if (turn !== WHITE && turn !== BLACK) throw new Bg2nRootUnavailable('unknown turn');
  if (!Number.isSafeInteger(cube) || cube <= 0 || !Number.isInteger(Math.log2(cube))) {
    throw new Bg2nRootUnavailable('cube value must be a positive power of two');
  }
  if ((cube === 1 && owner !== 'center')
      || (cube > 1 && owner !== 'me' && owner !== 'opponent')) {
    throw new Bg2nRootUnavailable(`invalid Money cube context: ${cube}/${owner}`);
  }
  if (board.bar[WHITE] || board.bar[BLACK]) throw new Bg2nRootUnavailable('bar checkers are unsupported');
  if (board.hasWon(WHITE) || board.hasWon(BLACK)) throw new Bg2nRootUnavailable('terminal root is unsupported');
  for (const player of [WHITE, BLACK]) {
    const counts = decodeCounts(board, player);
    if (counts === null) throw new Bg2nRootUnavailable(`${player} is not fully in its home board`);
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total === 0) throw new Bg2nRootUnavailable('terminal root is unsupported');
    if (total > database.maximum) throw new Bg2nRootUnavailable(`${player} exceeds DB checker limit`);
  }
}

function evaluateRollBranch(board, turn, cube, owner, database) {
  const nextTurn = opponent(turn);
  const nextOwner = flipOwner(owner);
  let weightedPoints = 0;
  for (const { die1, die2, weight } of MONEY_ROLLS) {
    const moves = generateMoves(board, turn, die1, die2);
    const successors = new Map();
    if (moves.length === 0) successors.set(boardKey(board), board);
    else for (const move of moves) successors.set(boardKey(move.resultingBoard), move.resultingBoard);

    let best = -Infinity;
    for (const successor of successors.values()) {
      const normalized = database.lookupNormalized(successor, nextTurn, nextOwner);
      if (normalized === null) {
        throw new Bg2nRootUnavailable(
          `strict root child DB miss: turn=${nextTurn}, cube=${cube}, owner=${nextOwner}`,
          'child_miss',
        );
      }
      if (!Number.isFinite(normalized) || Math.abs(normalized) > 1 + 1e-10) {
        throw new Bg2nRootUnavailable(`invalid BG2N child value: ${normalized}`, 'runtime_error');
      }
      best = Math.max(best, -cube * normalized);
    }
    weightedPoints += weight * best;
  }
  return weightedPoints;
}

/** Evaluate the complete Money root from one BG2N DB; throws on any miss. */
export function evaluateMoneyBg2nRoot(board, turn, cube, owner, database, allowDouble = true) {
  validateRoot(board, turn, cube, owner, database);
  const noDoublePoints = evaluateRollBranch(board, turn, cube, owner, database);
  const offerable = allowDouble && owner !== 'opponent';
  if (!offerable) {
    return {
      status: 'exact', action: 'no_double', cube, owner,
      ND_points: noDoublePoints, DT_points: null, DP_points: null,
      no_double: noDoublePoints / cube,
      double_take: Number.NaN, double_pass: Number.NaN,
      double: -Infinity, margin: -Infinity,
    };
  }

  const doubleTakePoints = evaluateRollBranch(board, turn, cube * 2, 'opponent', database);
  const doublePassPoints = cube;
  const offerPoints = Math.min(doubleTakePoints, doublePassPoints);
  const action = noDoublePoints >= offerPoints
    ? 'no_double'
    : (doubleTakePoints < doublePassPoints ? 'double_take' : 'double_pass');
  const noDouble = noDoublePoints / cube;
  const doubleTake = doubleTakePoints / cube;
  const doublePass = doublePassPoints / cube;
  const double = Math.min(doubleTake, doublePass);
  return {
    status: 'exact', action, cube, owner,
    ND_points: noDoublePoints, DT_points: doubleTakePoints, DP_points: doublePassPoints,
    no_double: noDouble, double_take: doubleTake, double_pass: doublePass,
    double, margin: double - noDouble,
  };
}
