// The computer opponent: an alpha-beta search over chess.js, with a static
// evaluation of material, piece placement and pawn structure.
//
// Difficulty changes three things. How far it looks ahead; how close to its
// best move a move has to be for it to consider playing it, so a weaker level
// picks among good-enough moves rather than always the best one; and, at the
// lowest level, an occasional move with no thought at all.
//
// Deterministic by design. Search stops at a node count, never a clock, and
// every roll of the dice comes from the seed and the move number. The API
// replays a finished game and asks this same code what the computer would
// have played at each of its moves; a game whose computer moves do not match
// was not played against this computer, and stays off the leaderboard.
// Nothing here may read the time, Math.random, or a floating point function.

import { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, CAPTURE, PROMOTION, typeOf, colourOf, onBoard, fileOf, rankOf, Position } from "./chess.js";

export const LEVELS = [
  null,
  // depth: plies looked ahead. quiet: search captures to the end. margin:
  // centipawns below the best a move may be and still be chosen. wild:
  // percent of moves played at random. nodes: work allowed per move.
  { name: "Beginner", depth: 1, quiet: false, margin: 250, wild: 15, nodes: 20000 },
  { name: "Casual", depth: 2, quiet: true, margin: 120, wild: 4, nodes: 40000 },
  { name: "Club", depth: 3, quiet: true, margin: 50, wild: 0, nodes: 90000 },
  { name: "Strong", depth: 4, quiet: true, margin: 15, wild: 0, nodes: 160000 },
  { name: "Master", depth: 8, quiet: true, margin: 0, wild: 0, nodes: 400000 },
];

const VALUE = [0, 100, 320, 330, 500, 900, 0];
const MATE = 30000;
const INF = 32000;
const MAX_PLY = 64;

// Piece-square tables, drawn from White's side with rank 8 at the top, as
// they are usually printed. Read through at() below.
const PST = {
  [PAWN]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  [KNIGHT]: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  [BISHOP]: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  [ROOK]: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  [QUEEN]: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  // The king has two: tucked away while there is material to attack it,
  // central once there is not.
  [KING]: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
  KING_END: [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50,
  ],
};

// A passed pawn's bonus by how far it has come, from its own side.
const PASSED = [0, 5, 10, 20, 35, 60, 100, 0];
const PHASE = [0, 0, 1, 1, 2, 4, 0];

function at(table, colour, sq) {
  const rank = rankOf(sq);
  const row = colour === WHITE ? 7 - rank : rank;
  return table[row * 8 + fileOf(sq)];
}

// Scratch space for evaluate(), reused rather than allocated per call.
// Per file: the pawn ranks at each end for each side, for passed pawns, and
// a count for doubled and isolated ones.
const whiteMax = new Int8Array(8);
const blackMin = new Int8Array(8);
const whiteMin = new Int8Array(8);
const blackMax = new Int8Array(8);
const pawnCount = [new Int8Array(8), new Int8Array(8)];
const bishops = [0, 0];
const kingSq = [-1, -1];

// From the side to move's point of view, in centipawns.
export function evaluate(pos) {
  const b = pos.board;
  let mg = 0;
  let eg = 0;
  let phase = 0;
  whiteMax.fill(-1);
  blackMax.fill(-1);
  whiteMin.fill(8);
  blackMin.fill(8);
  pawnCount[0].fill(0);
  pawnCount[1].fill(0);
  bishops[0] = bishops[1] = 0;
  kingSq[0] = kingSq[1] = -1;

  for (let sq = 0; sq < 128; sq++) {
    if (!onBoard(sq)) {
      sq += 7;
      continue;
    }
    const p = b[sq];
    if (!p) continue;
    const type = typeOf(p);
    const colour = colourOf(p);
    const sign = colour === WHITE ? 1 : -1;
    phase += PHASE[type];
    if (type === KING) {
      kingSq[colour] = sq;
      continue;
    }
    const v = VALUE[type] + at(PST[type], colour, sq);
    mg += sign * v;
    eg += sign * v;
    if (type === BISHOP) bishops[colour]++;
    if (type === PAWN) {
      const f = fileOf(sq);
      const r = rankOf(sq);
      pawnCount[colour][f]++;
      if (colour === WHITE) {
        if (r > whiteMax[f]) whiteMax[f] = r;
        if (r < whiteMin[f]) whiteMin[f] = r;
      } else {
        if (r < blackMin[f]) blackMin[f] = r;
        if (r > blackMax[f]) blackMax[f] = r;
      }
    }
  }

  // Pawn structure.
  for (let f = 0; f < 8; f++) {
    for (const colour of [0, 1]) {
      const n = pawnCount[colour][f];
      if (!n) continue;
      const sign = colour === WHITE ? 1 : -1;
      if (n > 1) {
        mg -= sign * 12 * (n - 1);
        eg -= sign * 20 * (n - 1);
      }
      const left = f > 0 ? pawnCount[colour][f - 1] : 0;
      const right = f < 7 ? pawnCount[colour][f + 1] : 0;
      if (!left && !right) {
        mg -= sign * 10;
        eg -= sign * 15;
      }
    }
    // Passed: no enemy pawn ahead on this file or either neighbour.
    if (whiteMax[f] >= 0) {
      const r = whiteMax[f];
      let passed = true;
      for (let g = Math.max(0, f - 1); g <= Math.min(7, f + 1); g++) if (blackMax[g] > r) passed = false;
      if (passed) {
        mg += PASSED[r] >> 1;
        eg += PASSED[r];
      }
    }
    if (blackMin[f] < 8) {
      const r = blackMin[f];
      let passed = true;
      for (let g = Math.max(0, f - 1); g <= Math.min(7, f + 1); g++) if (whiteMin[g] < r) passed = false;
      if (passed) {
        mg -= PASSED[7 - r] >> 1;
        eg -= PASSED[7 - r];
      }
    }
  }

  if (bishops[0] >= 2) {
    mg += 30;
    eg += 40;
  }
  if (bishops[1] >= 2) {
    mg -= 30;
    eg -= 40;
  }

  for (const colour of [0, 1]) {
    const sq = kingSq[colour];
    if (sq < 0) continue;
    const sign = colour === WHITE ? 1 : -1;
    mg += sign * at(PST[KING], colour, sq);
    eg += sign * at(PST.KING_END, colour, sq);
  }

  // Blend by how much material is left. Integer division is exact enough
  // and, unlike floating point maths functions, identical everywhere.
  if (phase > 24) phase = 24;
  const score = Math.trunc((mg * phase + eg * (24 - phase)) / 24) + 10;
  return pos.turn === WHITE ? score : -score;
}

function hasPieces(pos, colour) {
  for (let sq = 0; sq < 128; sq++) {
    if (!onBoard(sq)) {
      sq += 7;
      continue;
    }
    const p = pos.board[sq];
    if (p && colourOf(p) === colour) {
      const t = typeOf(p);
      if (t !== PAWN && t !== KING) return true;
    }
  }
  return false;
}

const moveKey = (m) => (m.from << 8) | m.to | (m.promo << 16);

class Search {
  constructor(pos, level) {
    this.pos = pos;
    this.level = level;
    this.nodes = 0;
    this.stopped = false;
    this.killers = [];
    for (let i = 0; i < MAX_PLY + 8; i++) this.killers.push([0, 0]);
    this.history = new Int32Array(16 * 128);
    // Best move found per position, only ever used to order moves, never to
    // cut a search short, so a key collision costs speed and nothing else.
    this.bestMoves = new Map();
  }

  tick() {
    if (++this.nodes > this.level.nodes) this.stopped = true;
    return this.stopped;
  }

  order(moves, ply, key) {
    const hint = this.bestMoves.get(key);
    const killers = this.killers[ply];
    for (const m of moves) {
      const k = moveKey(m);
      let s;
      if (k === hint) s = 1 << 30;
      else if (m.flags & (CAPTURE | PROMOTION)) {
        // Most valuable victim, least valuable attacker.
        s = (1 << 24) + VALUE[typeOf(m.captured)] * 16 - typeOf(m.piece) + (m.promo ? VALUE[typeOf(m.promo)] : 0);
      } else if (k === killers[0]) s = 1 << 22;
      else if (k === killers[1]) s = (1 << 22) - 1;
      else s = this.history[m.piece * 128 + m.to];
      m.order = s;
    }
    // Stable sort, so equal scores keep generation order everywhere.
    moves.sort((a, b) => b.order - a.order);
  }

  quiesce(alpha, beta, ply) {
    if (this.tick()) return 0;
    const pos = this.pos;
    const stand = evaluate(pos);
    if (ply >= MAX_PLY) return stand;
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;

    // Pseudo-legal, with illegal ones skipped once made: cheaper than
    // pos.moves(), which makes every move once just to test it.
    const us = pos.turn;
    const moves = pos.pseudoMoves(true);
    this.order(moves, Math.min(ply, MAX_PLY), -1);
    for (const m of moves) {
      pos.make(m);
      if (pos.isAttacked(pos.kings[us], us ^ 1)) {
        pos.unmake();
        continue;
      }
      const score = -this.quiesce(-beta, -alpha, ply + 1);
      pos.unmake();
      if (this.stopped) return 0;
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  search(depth, alpha, beta, ply, allowNull) {
    const pos = this.pos;
    if (ply > 0) {
      // A repeated position is scored as a draw, as is the fifty-move limit.
      if (pos.halfmove >= 100 || pos.repetitions() >= 2) return 0;
    }
    const inCheck = pos.inCheck();
    if (inCheck && ply < MAX_PLY) depth++;
    if (depth <= 0) return this.level.quiet ? this.quiesce(alpha, beta, ply) : (this.tick(), evaluate(pos));
    if (this.tick()) return 0;

    // Give the opponent a free move; if they still cannot reach beta, this
    // line is good enough to stop looking at.
    if (allowNull && !inCheck && depth >= 3 && ply > 0 && hasPieces(pos, pos.turn)) {
      pos.makeNull();
      const score = -this.search(depth - 3, -beta, -beta + 1, ply + 1, false);
      pos.unmakeNull();
      if (this.stopped) return 0;
      if (score >= beta) return beta;
    }

    const us = pos.turn;
    const moves = pos.pseudoMoves();
    const key = pos.key();
    this.order(moves, Math.min(ply, MAX_PLY), key);
    let best = null;
    let legal = 0;
    for (const m of moves) {
      pos.make(m);
      if (pos.isAttacked(pos.kings[us], us ^ 1)) {
        pos.unmake();
        continue;
      }
      legal++;
      const score = -this.search(depth - 1, -beta, -alpha, ply + 1, true);
      pos.unmake();
      if (this.stopped) return 0;
      if (score > alpha) {
        alpha = score;
        best = m;
        if (score >= beta) {
          if (!(m.flags & (CAPTURE | PROMOTION))) {
            const killers = this.killers[Math.min(ply, MAX_PLY)];
            const k = moveKey(m);
            if (killers[0] !== k) {
              killers[1] = killers[0];
              killers[0] = k;
            }
            this.history[m.piece * 128 + m.to] += depth * depth;
          }
          this.bestMoves.set(key, moveKey(m));
          return beta;
        }
      }
    }
    if (!legal) return inCheck ? -MATE + ply : 0;
    if (best) this.bestMoves.set(key, moveKey(best));
    return alpha;
  }

  // Deepening one ply at a time. Each round scores every root move that
  // comes within `margin` of the best so far, which is what lets a weaker
  // level choose among good moves. A round cut short by the node limit is
  // thrown away and the last complete one stands.
  root(moves) {
    const pos = this.pos;
    const { depth: maxDepth, margin } = this.level;
    let done = null;
    let ordered = moves.slice();

    for (let depth = 1; depth <= maxDepth; depth++) {
      const scored = [];
      let best = -INF;
      for (const m of ordered) {
        const floor = best === -INF ? -INF : best - margin - 1;
        pos.make(m);
        const score = -this.search(depth - 1, -INF, -floor, 1, true);
        pos.unmake();
        if (this.stopped) break;
        scored.push({ m, score: score > floor ? score : -INF });
        if (score > best) best = score;
      }
      if (this.stopped) break;
      // Stable sort: best first, ties in the order they were searched.
      scored.sort((a, b) => b.score - a.score);
      done = { depth, scored, best };
      ordered = scored.map((s) => s.m);
      // A forced mate needs no deeper look.
      if (best > MATE - 100 || best < -MATE + 100) break;
    }
    return done;
  }
}

// The computer's move in `pos`, which must hold the game so far (its
// repetition history comes from it). `random` is moveRandom() for this move.
// Returns { move, text, score, depth, nodes }.
export function chooseMove(pos, difficulty, random) {
  const level = LEVELS[difficulty] ?? LEVELS[3];
  const moves = pos.moves();
  if (!moves.length) return null;

  // Drawn first and always, so the number of draws does not depend on the
  // position and every move's dice line up.
  const wildRoll = random() % 100;
  const pickRoll = random();

  if (wildRoll < level.wild) {
    const m = moves[pickRoll % moves.length];
    return { move: m, text: Position.moveText(m), score: 0, depth: 0, nodes: 0 };
  }

  const search = new Search(pos, level);
  const result = search.root(moves);
  if (!result) {
    return { move: moves[0], text: Position.moveText(moves[0]), score: 0, depth: 0, nodes: search.nodes };
  }

  const { scored, best, depth } = result;
  // Within the margin, closer to the best is likelier.
  const pool = scored.filter((s) => s.score > -INF && s.score >= best - level.margin);
  let total = 0;
  for (const s of pool) total += level.margin + 1 - (best - s.score);
  let roll = pickRoll % total;
  let chosen = pool[0];
  for (const s of pool) {
    roll -= level.margin + 1 - (best - s.score);
    if (roll < 0) {
      chosen = s;
      break;
    }
  }
  return { move: chosen.m, text: Position.moveText(chosen.m), score: chosen.score, depth, nodes: search.nodes };
}
