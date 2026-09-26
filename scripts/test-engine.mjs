#!/usr/bin/env node
// Checks the rules engine against published move counts (perft), including
// Chess960 castling, then the draw rules, notation and the start positions.
//
// Run: node scripts/test-engine.mjs          (add --deep for the slow depths)

import { Position, perft, backRank960, STANDARD_INDEX } from "../main-site/js/chess.js";

const deep = process.argv.includes("--deep");
const failures = [];
const check = (label, got, want) => {
  if (got !== want) failures.push(`${label}: got ${got}, want ${want}`);
};

// [fen, counts by depth from 1]. Standard suite positions, and two from the
// Chess960 suite, where castling rights are Shredder file letters.
const SUITE = [
  ["rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", [20, 400, 8902, 197281]],
  ["r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", [48, 2039, 97862]],
  ["8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812, 43238]],
  ["r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264, 9467]],
  ["rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486, 62379]],
  ["bqnb1rkr/pp3ppp/3ppn2/2p5/5P2/P2P4/NPP1P1PP/BQ1BNRKR w HFhf - 2 9", [21, 528, 12189]],
  ["2nnrbkr/p1qppppp/8/1ppb4/6PP/3PP3/PPP2P2/BQNNRBKR w HEhe - 1 9", [21, 807, 18002]],
];
const DEEP = [
  ["r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 4, 4085603],
  ["bqnb1rkr/pp3ppp/3ppn2/2p5/5P2/P2P4/NPP1P1PP/BQ1BNRKR w HFhf - 2 9", 4, 326672],
];

const started = Date.now();
for (const [fen, counts] of SUITE) {
  counts.forEach((want, i) => check(`perft ${i + 1} ${fen}`, perft(Position.fromFEN(fen), i + 1), want));
}
if (deep) for (const [fen, depth, want] of DEEP) check(`perft ${depth} ${fen}`, perft(Position.fromFEN(fen), depth), want);

// Make and unmake leave the position exactly as it was, hash included.
{
  const pos = Position.fromFEN(SUITE[1][0]);
  const before = pos.toFEN() + pos.key();
  perft(pos, 3);
  check("make/unmake restores", pos.toFEN() + pos.key(), before);
}

// Chess960 numbering: 518 is the ordinary start, and all 960 are distinct
// and legal-looking (bishops on opposite colours, king between rooks).
check("960 index 518", backRank960(STANDARD_INDEX), "RNBQKBNR");
check("960 index 0", backRank960(0), "BBQNNRKR");
{
  const seen = new Set();
  for (let i = 0; i < 960; i++) {
    const r = backRank960(i);
    seen.add(r);
    const b = [...r].map((c, f) => (c === "B" ? f % 2 : -1)).filter((x) => x >= 0);
    const k = r.indexOf("K");
    if (b[0] === b[1] || !(r.indexOf("R") < k && r.lastIndexOf("R") > k)) failures.push(`960 index ${i}: ${r}`);
  }
  check("960 distinct", seen.size, 960);
}

// Chess960 castling where the king does not move, and where it lands on
// the rook's square.
{
  const pos = Position.fromFEN("1r4k1/8/8/8/8/8/8/R5KR w HA - 0 1");
  const short = pos.findMove("O-O");
  check("960 O-O with king already on g1 exists", Boolean(short), true);
  pos.make(short);
  check("960 O-O result", pos.toFEN().split(" ")[0], "1r4k1/8/8/8/8/8/8/R4RK1");
}
{
  const pos = Position.fromFEN("4k3/8/8/8/8/8/8/2RK4 w C - 0 1");
  pos.make(pos.findMove("O-O-O"));
  check("960 O-O-O onto the rook's square", pos.toFEN().split(" ")[0], "4k3/8/8/8/8/8/8/2KR4");
}
{
  // The rook on b1 shields a1's enemy rook from the king's landing square c1.
  const pos = Position.fromFEN("4k3/8/8/8/8/8/8/rRK5 w B - 0 1");
  check("960 castling into a check the rook was blocking", pos.findMove("O-O-O"), null);
}

// The end of a game.
{
  const pos = Position.fromIndex(STANDARD_INDEX);
  for (const t of ["f2f3", "e7e5", "g2g4", "d8h4"]) pos.make(pos.findMove(t));
  check("fool's mate", pos.outcome()?.reason, "checkmate");
  check("fool's mate result", pos.outcome()?.result, "0-1");
}
check("stalemate", Position.fromFEN("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1").outcome()?.reason, "stalemate");
check("bare kings", Position.fromFEN("8/8/4k3/8/8/3K4/8/8 w - - 0 1").outcome()?.reason, "material");
check("same colour bishops", Position.fromFEN("8/8/4k3/3b4/8/3K1B2/8/8 w - - 0 1").outcome()?.reason, "material");
check("opposite colour bishops play on", Position.fromFEN("8/8/4k3/4b3/8/3K1B2/8/8 w - - 0 1").outcome(), null);
check("fifty moves", Position.fromFEN("8/8/4k3/8/8/3K4/8/7R w - - 100 80").outcome()?.reason, "fifty");
{
  const pos = Position.fromIndex(STANDARD_INDEX);
  for (const t of ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"]) pos.make(pos.findMove(t));
  check("threefold repetition", pos.outcome()?.reason, "repetition");
}

// Notation.
{
  const pos = Position.fromFEN("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1");
  const legal = pos.moves();
  const san = (t) => pos.san(pos.findMove(t), legal);
  check("san castle", san("O-O"), "O-O");
  check("san capture", san("e5f7"), "Nxf7");
  check("san pawn capture", san("d5e6"), "dxe6");
  check("san single knight", san("c3b1"), "Nb1");
}
{
  const byFile = Position.fromFEN("k7/8/8/8/8/2N3N1/8/K7 w - - 0 1");
  check("san file disambiguation", byFile.san(byFile.findMove("c3e4")), "Nce4");
  const byRank = Position.fromFEN("k7/8/8/2N5/8/2N5/8/K7 w - - 0 1");
  check("san rank disambiguation", byRank.san(byRank.findMove("c3e4")), "N3e4");
}
{
  const pos = Position.fromFEN("7k/1P6/8/8/8/8/8/K7 w - - 0 1");
  check("san promotion check", pos.san(pos.findMove("b7b8q")), "b8=Q+");
}

const ms = Date.now() - started;
if (failures.length) {
  console.error("engine test failed:");
  failures.forEach((f) => console.error(`  - ${f}`));
  process.exit(1);
}
console.log(`engine ok in ${ms} ms${deep ? ", deep perft included" : ""}.`);
