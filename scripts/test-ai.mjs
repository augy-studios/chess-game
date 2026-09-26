#!/usr/bin/env node
// The computer: that it plays the same move twice for the same seed and
// position (the API depends on this), how long a move takes at each level,
// and that stronger levels beat weaker ones.
//
// Run: node scripts/test-ai.mjs            (add --matches for level matches)

import { Position } from "../main-site/js/chess.js";
import { chooseMove, LEVELS } from "../main-site/js/ai.js";
import { newSeed, parseSeed, moveRandom } from "../main-site/js/seed.js";

const failures = [];

// A game between two levels from one seed. Returns the moves and outcome.
function play(seed, whiteLevel, blackLevel, maxPlies = 300) {
  const pos = Position.fromIndex(seed.index);
  const moves = [];
  const times = [[], []];
  while (!pos.outcome() && moves.length < maxPlies) {
    const level = pos.turn === 0 ? whiteLevel : blackLevel;
    const t = performance.now();
    const pick = chooseMove(pos, level, moveRandom(seed, level, moves.length));
    times[pos.turn].push(performance.now() - t);
    moves.push(pick.text);
    pos.make(pick.move);
  }
  return { moves, outcome: pos.outcome(), times };
}

// Same seed, same levels: the same game, move for move.
{
  const seed = parseSeed("960-BXK4-M9TR");
  const a = play(seed, 2, 4, 40);
  const b = play(seed, 2, 4, 40);
  if (a.moves.join(" ") !== b.moves.join(" ")) failures.push("the same seed played two different games");
}

// Time per move at each level, over the first moves of a few games.
console.log("level   avg ms   max ms   (first 30 plies, 3 seeds, both sides)");
for (let level = 1; level <= 5; level++) {
  const all = [];
  for (const text of ["960-BXK4-M9TR", "STD-QRST-2345", "960-ZZZZ-BBBB"]) {
    const { times } = play(parseSeed(text), level, level, 30);
    all.push(...times[0], ...times[1]);
  }
  const avg = all.reduce((s, t) => s + t, 0) / all.length;
  console.log(`${String(level).padEnd(8)}${avg.toFixed(0).padStart(6)}   ${Math.max(...all).toFixed(0).padStart(6)}   ${LEVELS[level].name}`);
}

if (process.argv.includes("--matches")) {
  for (const [strong, weak] of [[5, 1], [5, 3], [4, 2], [3, 1]]) {
    let points = 0;
    const games = 6;
    for (let g = 0; g < games; g++) {
      const seed = newSeed("960");
      const strongWhite = g % 2 === 0;
      const { outcome } = play(seed, strongWhite ? strong : weak, strongWhite ? weak : strong);
      const strongSide = strongWhite ? 0 : 1;
      if (!outcome) points += 0.5;
      else if (outcome.winner === -1) points += 0.5;
      else if (outcome.winner === strongSide) points += 1;
    }
    console.log(`level ${strong} v level ${weak}: ${points} / ${games}`);
    if (points < games / 2) failures.push(`level ${strong} scored under half against level ${weak}`);
  }
}

if (failures.length) {
  console.error("ai test failed:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log("ai ok.");
