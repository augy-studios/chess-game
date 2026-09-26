#!/usr/bin/env node
// The API's game check, run locally with no database: an honest game against
// the computer passes and scores, tampered ones are refused, and claims on
// the clock hold only when the server's time agrees.
//
// Run: node scripts/test-verify.mjs

import { Position } from "../main-site/js/chess.js";
import { chooseMove } from "../main-site/js/ai.js";
import { newSeed, moveRandom } from "../main-site/js/seed.js";
import { timeBonus } from "../main-site/js/score.js";
import { verify, settle } from "../main-site/api/_lib/verify.js";

const failures = [];
const MIN = 60000;

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
    if (err.code !== code) failures.push(`${label}: ${err.code} (${err.message}), want ${code}`);
  }
};
const expectOk = (label, fn) => {
  try {
    return fn();
  } catch (err) {
    failures.push(`${label}: ${err.code} (${err.message})`);
    return null;
  }
};

const seed = newSeed("960");
const game = { mode: "computer", seed: seed.text, first_side: 0, difficulty: 2, time_mode: "none", time_limit_ms: null, server_seed: true };
const started = Date.now();
const { moves, finished } = playComputerGame(seed, 2, 0);

if (finished) {
  const slow = verify(game, moves, 0, null, 0, 40 * MIN);
  console.log(`honest game: ${moves.length} plies, ${slow.outcome}, ${slow.score} points, checked in ${Date.now() - started} ms`);
  if (slow.timeBonus !== 0) failures.push(`40 minute game got a time bonus of ${slow.timeBonus}%`);
  const quick = verify(game, moves, 0, null, 0, 3 * MIN);
  if (slow.outcome !== "loss" && quick.timeBonus !== 45) failures.push(`3 minute ${quick.outcome}: bonus ${quick.timeBonus}%, want 45%`);
  if (slow.outcome !== "loss" && quick.score <= slow.score) failures.push("a quicker game did not score more");
  const pasted = verify({ ...game, server_seed: false }, moves, 0, null, 0, 3 * MIN);
  if (pasted.timeBonus !== 0) failures.push("a pasted seed got a time bonus");
  const withUndos = verify(game, moves, 0, null, 3, 40 * MIN);
  if (withUndos.score >= slow.score && slow.score > 0) failures.push(`undos did not cost points: ${slow.score} v ${withUndos.score}`);
  expectCode("resigning a finished game", () => verify(game, moves, 0, { by: "resign", side: 0 }, 0, MIN), "illegal");
} else {
  console.log("honest game did not finish in 400 plies; skipped its score checks");
}

// A computer move swapped for a different legal one. Ply 1 is the
// computer's, since the player is White.
{
  const pos = Position.fromIndex(seed.index);
  pos.make(pos.findMove(moves[0]));
  const other = pos.moves().map((m) => Position.moveText(m)).find((t) => t !== moves[1]);
  expectCode("a doctored computer move", () => verify(game, [moves[0], other], 0, { by: "resign", side: 0 }, 0, MIN), "not_computer");
}

expectCode("an illegal move", () => verify(game, ["e2e5"], 0, { by: "resign", side: 0 }, 0, MIN), "illegal");
expectCode("an unfinished game", () => verify(game, moves.slice(0, 4), 0, null, 0, MIN), "unfinished");
expectCode("the computer's side", () => verify(game, moves, 1, null, 0, MIN), "bad_side");
expectCode("the computer resigning", () => verify(game, moves.slice(0, 6), 0, { by: "resign", side: 1 }, 0, MIN), "illegal");
{
  const r = expectOk("early resignation", () => verify(game, moves.slice(0, 6), 0, { by: "resign", side: 0 }, 0, MIN));
  if (r && r.outcome !== "loss") failures.push(`early resignation: ${r.outcome}, want loss`);
  if (r && r.timeBonus !== 0) failures.push("a loss got a time bonus");
}

// Clocks. A 5 minute limit each: a flag before five minutes of server time
// is refused; after, it is a loss for whoever flagged.
const each = { ...game, time_mode: "each", time_limit_ms: 5 * MIN };
const early = moves.slice(0, 8);
expectCode("flag before the time is up", () => verify(each, early, 0, { by: "flag", side: 0 }, 0, 2 * MIN), "clock");
{
  const r = expectOk("flag after the time is up", () => verify(each, early, 0, { by: "flag", side: 0 }, 0, 5 * MIN + 1000));
  if (r && r.outcome !== "loss") failures.push(`player's flag: ${r.outcome}, want loss`);
}
expectCode("the computer flagging", () => verify(each, early, 0, { by: "flag", side: 1 }, 0, 6 * MIN), "illegal");
expectCode("a flag with no clock", () => verify(game, early, 0, { by: "flag", side: 0 }, 0, 6 * MIN), "illegal");

// A flag against a bare king is a draw, not a loss.
{
  const pos = Position.fromFEN("8/8/4k3/8/8/3K4/8/7R b - - 0 1");
  if (pos.canMate(0) !== true || pos.canMate(1) !== false) failures.push("canMate: rook side can, bare king cannot");
}

// One clock for the game: time up needs the time really up, and material
// then decides.
const total = { ...game, time_mode: "total", time_limit_ms: 10 * MIN };
expectCode("time up too soon", () => verify(total, early, 0, { by: "timeup" }, 0, 4 * MIN), "clock");
{
  const r = expectOk("time up when it is", () => settle(total, early, { by: "timeup" }, 10 * MIN));
  if (r) {
    const lead = r.record.pos.material(0) - r.record.pos.material(1);
    const want = lead === 0 ? -1 : lead > 0 ? 0 : 1;
    if (r.outcome.winner !== want) failures.push(`time up: winner ${r.outcome.winner}, material says ${want}`);
  }
}
if (finished) {
  expectCode("finished long after the game clock ran out", () => verify(total, moves, 0, null, 0, 25 * MIN), "over_time");
}

// The bonus itself.
if (timeBonus("win", 0, true) !== 50) failures.push("instant win bonus should be 50");
if (timeBonus("win", 15 * MIN, true) !== 25) failures.push("15 minute win bonus should be 25");
if (timeBonus("draw", 30 * MIN, true) !== 0) failures.push("30 minute draw bonus should be 0");
if (timeBonus("loss", 0, true) !== 0) failures.push("losses get no bonus");

if (failures.length) {
  console.error("verify test failed:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log("verify ok.");
