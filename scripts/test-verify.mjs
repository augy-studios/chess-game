#!/usr/bin/env node
// The API's game check, run locally with no database: an honest game against
// the computer passes and scores, and tampered ones are refused.
//
// Run: node scripts/test-verify.mjs

import { Position } from "../main-site/js/chess.js";
import { chooseMove } from "../main-site/js/ai.js";
import { newSeed, moveRandom } from "../main-site/js/seed.js";
import { verify } from "../main-site/api/_lib/verify.js";

const failures = [];

// The player's moves come from level 3 standing in for a person; the
// computer's from `difficulty`, exactly as the browser's worker plays them.
function playComputerGame(seed, difficulty, humanSide, maxPlies = 400) {
  const pos = Position.fromIndex(seed.index);
  const moves = [];
  while (!pos.outcome() && moves.length < maxPlies) {
    const human = pos.turn === humanSide;
    const level = human ? 3 : difficulty;
    const random = human ? moveRandom(seed, 99, moves.length) : moveRandom(seed, difficulty, moves.length);
    const pick = chooseMove(pos, level, random);
    moves.push(pick.text);
    pos.make(pick.move);
  }
  return { moves, finished: Boolean(pos.outcome()) };
}

const expectCode = (label, fn, code) => {
  try {
    fn();
    failures.push(`${label}: passed, want ${code}`);
  } catch (err) {
    if (err.code !== code) failures.push(`${label}: ${err.code}, want ${code}`);
  }
};

const seed = newSeed("960");
const game = { mode: "computer", seed: seed.text, first_side: 0, difficulty: 2 };
const started = Date.now();
const { moves, finished } = playComputerGame(seed, 2, 0);

if (finished) {
  const result = verify(game, moves, 0, null, 0);
  console.log(`honest game: ${moves.length} plies, ${result.outcome}, ${result.score} points, checked in ${Date.now() - started} ms`);
  const withUndos = verify(game, moves, 0, null, 3);
  if (withUndos.score !== Math.max(0, result.score - Math.floor((3 * 40 * 80) / 100)) && withUndos.score !== 0) {
    failures.push(`undo penalty: ${result.score} with none, ${withUndos.score} with three`);
  }
  expectCode("resigning a finished game", () => verify(game, moves, 0, 0, 0), "illegal");
} else {
  console.log("honest game did not finish in 400 plies; skipped its score check");
}

// A computer move swapped for a different legal one.
{
  // Ply 1 is the computer's, since the player is White.
  const pos = Position.fromIndex(seed.index);
  pos.make(pos.findMove(moves[0]));
  const other = pos.moves().map((m) => Position.moveText(m)).find((t) => t !== moves[1]);
  expectCode("a doctored computer move", () => verify(game, [moves[0], other], 0, 0, 0), "not_computer");
}

expectCode("an illegal move", () => verify(game, ["e2e5"], 0, 0, 0), "illegal");
expectCode("an unfinished game", () => verify(game, moves.slice(0, 4), 0, null, 0), "unfinished");
expectCode("the computer's side", () => verify(game, moves, 1, null, 0), "bad_side");
{
  // Resigning partway through is a finished game and a loss.
  const early = moves.slice(0, 6);
  const r = verify(game, early, 0, 0, 0);
  if (r.outcome !== "loss") failures.push(`early resignation: ${r.outcome}, want loss`);
}

if (failures.length) {
  console.error("verify test failed:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log("verify ok.");
