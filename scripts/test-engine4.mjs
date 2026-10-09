#!/usr/bin/env node
// Checks the four-player rules: move counts from the start, make and unmake,
// castling, promotion at the centre line, teams, and whole games between
// computers that must end with a result.
//
// Run: node scripts/test-engine4.mjs

import { Position4, perft4, replay4, square4, squareName4, parseSquare4, SQUARES, RED, BLUE, YELLOW, GREEN, placing } from "../main-site/js/chess4.js";
import { chooseMove4 } from "../main-site/js/ai4.js";
import { randomSource, hashString } from "../main-site/js/seed.js";
import { makePiece, KING, ROOK, PAWN, QUEEN } from "../main-site/js/chess.js";

const failures = [];
const check = (label, got, want) => {
  if (got !== want) failures.push(`${label}: got ${got}, want ${want}`);
};

check("squares", SQUARES.length, 160);
check("square names", squareName4(square4(13, 13)), "n14");
check("parse a1 is a corner", parseSquare4("a1"), -1);
check("parse d1", parseSquare4("d1"), square4(3, 0));

// From the start every army has 16 pawn moves and 4 knight moves. Blue has
// five fewer replies in all: d2d4 blocks b4's double step, and f2f3 or f2f4
// opens g1's diagonal to a7, pinning b6.
{
  const pos = Position4.start(false);
  check("perft 1", perft4(pos, 1), 20);
  check("perft 2", perft4(pos, 2), 395);
  check("perft 3", perft4(pos, 3), 7800);
  const before = pos.board.join(",");
  perft4(pos, 3);
  check("make/unmake restores", pos.board.join(","), before);
}

// Kings and queens where chess.com puts them.
{
  const pos = Position4.start(false);
  const at = (name) => pos.board[parseSquare4(name)];
  check("red king h1", at("h1"), makePiece(RED, KING));
  check("blue king a7", at("a7"), makePiece(BLUE, KING));
  check("yellow king g14", at("g14"), makePiece(YELLOW, KING));
  check("green king n8", at("n8"), makePiece(GREEN, KING));
  check("red queen g1", at("g1"), makePiece(RED, QUEEN));
}

// Castling both ways, after clearing the back rank.
{
  const pos = Position4.start(false);
  for (const n of ["e1", "f1", "g1", "i1", "j1"]) pos.board[parseSquare4(n)] = 0;
  const texts = pos.moves().map((m) => Position4.moveText(m));
  check("red O-O", texts.includes("O-O"), true);
  check("red O-O-O", texts.includes("O-O-O"), true);
  const short = pos.findMove("O-O");
  pos.make(short);
  check("O-O king", pos.board[parseSquare4("j1")], makePiece(RED, KING));
  check("O-O rook", pos.board[parseSquare4("i1")], makePiece(RED, ROOK));
}

// A red pawn promotes on the eighth rank.
{
  const pos = Position4.start(false);
  pos.board[parseSquare4("e7")] = makePiece(RED, PAWN);
  check("promotions", pos.moves().filter((m) => m.from === parseSquare4("e7")).length, 4);
}

// Teams: partners cannot take each other.
{
  const pos = Position4.start(true);
  pos.board[parseSquare4("e3")] = makePiece(YELLOW, PAWN);
  const takes = pos.moves().filter((m) => m.to === parseSquare4("e3") && m.captured);
  check("no taking a partner", takes.length, 0);
}

// Events put a player out and pass the turn.
{
  const r = replay4(false, ["e2e4", "resign:1"]);
  check("resign error", r.error, null);
  check("blue out", r.pos.isLive(BLUE), false);
  check("yellow to move", r.pos.turn, YELLOW);
  check("blue placing", placing(r, BLUE), 4);
}

// Whole games between computers.
function play(teams, level, seedText, max = 1500) {
  const entries = [];
  let r = replay4(teams, entries);
  const started = Date.now();
  while (!r.outcome && entries.length < max) {
    const random = randomSource(hashString(`ai4|${seedText}|${level}|${entries.length}`));
    const pick = chooseMove4(r.pos, level, random);
    if (!pick) throw new Error(`no move at ${entries.length}`);
    entries.push(pick.text);
    r = replay4(teams, entries);
    if (r.error) throw new Error(`illegal ${pick.text} at ${entries.length}: ${r.error.reason}`);
  }
  return { r, entries, ms: Date.now() - started };
}

for (const [teams, level] of [[false, 1], [true, 1], [false, 2], [true, 2]]) {
  const { r, entries, ms } = play(teams, level, `T-${teams}-${level}`);
  if (!r.outcome) failures.push(`${teams ? "teams" : "ffa"} level ${level}: no result after ${entries.length}`);
  console.log(`${teams ? "teams" : "ffa  "} L${level}: ${entries.length} entries, ${JSON.stringify(r.outcome)}, out ${JSON.stringify(r.out.map((o) => o.colour + o.reason))}, ${(ms / Math.max(1, entries.length)).toFixed(1)} ms a move`);
}

// Time per move by level, from a few positions into a game.
{
  const base = play(false, 1, "timing", 24).entries;
  const pos = replay4(false, base).pos;
  for (let level = 1; level <= 5; level++) {
    const t = performance.now();
    chooseMove4(pos, level, randomSource(level));
    console.log(`level ${level}: ${(performance.now() - t).toFixed(0)} ms`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("four-player engine ok.");
