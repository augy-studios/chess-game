// The computer thinks here, off the page's thread, so the board stays
// responsive at Master level. It rebuilds the game from the seed and the
// moves, exactly as the API does when it checks a game.

import { Position } from "./chess.js";
import { chooseMove } from "./ai.js";
import { parseSeed, moveRandom } from "./seed.js";

self.addEventListener("message", (event) => {
  const { id, seed: seedText, difficulty, moves } = event.data ?? {};
  const seed = parseSeed(seedText);
  if (!seed) {
    self.postMessage({ id, text: null });
    return;
  }
  const pos = Position.fromIndex(seed.index);
  for (const text of moves) {
    const m = pos.findMove(text);
    if (!m) {
      self.postMessage({ id, text: null });
      return;
    }
    pos.make(m);
  }
  const pick = chooseMove(pos, difficulty, moveRandom(seed, difficulty, moves.length));
  self.postMessage({ id, text: pick?.text ?? null });
});
