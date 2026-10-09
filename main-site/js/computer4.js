// The four-player computer's move for a game so far, wherever it runs: in
// the worker, or on the page where module workers are missing. Its dice come
// from the game's seed and the entry number, so a game plays the same twice.

import { replay4 } from "./chess4.js";
import { chooseMove4 } from "./ai4.js";
import { hashString, randomSource } from "./seed.js";

export function pickFour(seedText, difficulty, teams, entries) {
  const record = replay4(Boolean(teams), entries);
  if (record.error || record.outcome) return null;
  const random = randomSource(hashString(`ai4|${seedText}|${difficulty}|${entries.length}`));
  return chooseMove4(record.pos, difficulty, random)?.text ?? null;
}
