// パリティのテストでベアオフ DB を読み込む共通の入口。
//
// **engine は DB を既定で有効にしている**（3 実装同時に切り替えた）ので、
// フィクスチャの着手や進行も DB 込みの値になっている。ここを呼ばないと
// JS だけ厳密解なしで指すことになり、**ベアオフ局面だけ食い違う**。
import { readFileSync } from 'node:fs';
import { setBearoffDatabase } from '../../docs/backgammon/src/agent.js';
import { BearoffDatabase } from '../../docs/backgammon/src/bearoff.js';

export function loadBearoffForTests() {
  const url = new URL('../../docs/backgammon/src/bearoff-6x15.bin', import.meta.url);
  const bytes = readFileSync(url);
  const database = new BearoffDatabase(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  setBearoffDatabase(database);
  return database;
}
