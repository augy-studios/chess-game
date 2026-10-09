// The computer for four-player chess. Best-reply search: the computer's own
// moves alternate with the single best reply any opponent has, as if all of
// them were one player who always found the most annoying move. That keeps a
// search a few moves deep affordable with three opponents, and it plays
// sensibly: it watches every one of them, not only the next in turn.
//
// Difficulty works as in ai.js: how far it looks, how close to its best a
// move must be to be considered, and at Beginner an occasional move with no
// thought. It stops on a count of positions, never a clock. Four-player games
// are not scored, so nothing checks its moves, but it keeps ai.js's rule of
// drawing its dice from the seed, so a game plays the same way twice.

import { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, CAPTURE, PROMOTION, colourOf, typeOf } from "./chess.js";
import { Position4, SQUARES, fileOf4, rankOf4, partnerOf } from "./chess4.js";

export const LEVELS4 = [
  null,
  { name: "Beginner", depth: 1, quiet: 0, margin: 250, wild: 15, nodes: 6000 },
  { name: "Casual", depth: 2, quiet: 0, margin: 120, wild: 4, nodes: 20000 },
  { name: "Club", depth: 2, quiet: 2, margin: 50, wild: 0, nodes: 40000 },
  { name: "Strong", depth: 3, quiet: 2, margin: 15, wild: 0, nodes: 80000 },
  { name: "Master", depth: 4, quiet: 3, margin: 0, wild: 0, nodes: 160000 },
];

const VALUE = [0, 100, 300, 320, 500, 900, 0];
const KING_PRIZE = 4000;
const MATE = 30000;
const INF = 32000;

// A piece's worth to its owner where it stands: material, a little for the
// centre, and for a pawn, how close it is to promoting.
function standing(pos, colour) {
  let total = 0;
  for (const sq of SQUARES) {
    const p = pos.board[sq];
    if (!p || colourOf(p) !== colour) continue;
    const t = typeOf(p);
    if (t === KING) continue;
    total += VALUE[t];
    // 1 in the middle four squares, 13 at the edge.
    const d = Math.max(Math.abs(2 * fileOf4(sq) - 13), Math.abs(2 * rankOf4(sq) - 13));
    if (t === KNIGHT) total += (13 - d) * 3;
    else if (t === BISHOP || t === QUEEN) total += 13 - d;
    else if (t === PAWN) total += pawnProgress(colour, sq) * 8;
  }
  if (pos.kingAttacked(colour)) total -= 40;
  return total;
}

function pawnProgress(colour, sq) {
  const f = fileOf4(sq);
  const r = rankOf4(sq);
  return [r, f, 13 - r, 13 - f][colour];
}

// From `me`'s side. Free-for-all: its own standing against the average of
// the others still in. Teams: the two partners against the other two.
export function evaluate4(pos, me) {
  if (!pos.isLive(me)) return -MATE;
  if (pos.teams) {
    const mine = standing(pos, me) + (pos.isLive(partnerOf(me)) ? standing(pos, partnerOf(me)) : 0);
    let theirs = 0;
    for (const c of [me ^ 1, me ^ 3]) if (pos.isLive(c)) theirs += standing(pos, c);
    return mine - theirs;
  }
  const others = pos.opponents(me);
  if (!others.length) return MATE;
  let sum = 0;
  for (const c of others) sum += standing(pos, c);
  return standing(pos, me) - Math.trunc(sum / others.length);
}

function orderScore(m) {
  if (m.captured && typeOf(m.captured) === KING && colourOf(m.captured) < 4) return 1 << 28;
  if (m.flags & (CAPTURE | PROMOTION)) {
    return (1 << 20) + VALUE[typeOf(m.captured)] * 16 - typeOf(m.piece) + (m.promo ? VALUE[typeOf(m.promo)] : 0);
  }
  return 0;
}

function order(moves) {
  for (const m of moves) m.order = orderScore(m);
  // Stable, so equal scores keep generation order everywhere.
  moves.sort((a, b) => b.order - a.order);
}

class Search4 {
  constructor(pos, me, level) {
    this.pos = pos;
    this.me = me;
    this.level = level;
    this.nodes = 0;
    this.stopped = false;
  }

  tick() {
    if (++this.nodes > this.level.nodes) this.stopped = true;
    return this.stopped;
  }

  // Legal moves for each of `colours`, together.
  movesFor(colours, capturesOnly) {
    const pos = this.pos;
    const out = [];
    for (const c of colours) {
      for (const m of pos.pseudoMoves(capturesOnly, c)) {
        pos.make(m);
        const ok = !pos.kingAttacked(c);
        pos.unmake();
        if (ok) out.push(m);
      }
    }
    order(out);
    return out;
  }

  // The computer to move.
  max(depth, alpha, beta, ply) {
    const pos = this.pos;
    if (!pos.isLive(this.me)) return -MATE + ply;
    if (depth <= 0) return this.quiet(true, alpha, beta, this.level.quiet);
    if (this.tick()) return 0;
    const moves = this.movesFor([this.me], false);
    if (!moves.length) {
      // Mated is out; so is stalemated, unless it is a team game's draw.
      if (pos.kingAttacked(this.me)) return -MATE + ply;
      return pos.teams ? 0 : -MATE / 2;
    }
    for (const m of moves) {
      pos.make(m);
      const score = this.min(depth - 1, alpha, beta, ply + 1);
      pos.unmake();
      if (this.stopped) return 0;
      if (score > alpha) {
        alpha = score;
        if (alpha >= beta) return alpha;
      }
    }
    return alpha;
  }

  // Every opponent's best reply.
  min(depth, alpha, beta, ply) {
    const pos = this.pos;
    const opponents = pos.opponents(this.me);
    if (!opponents.length) return MATE - ply;
    if (depth <= 0) return this.quiet(false, alpha, beta, this.level.quiet);
    if (this.tick()) return 0;
    const moves = this.movesFor(opponents, false);
    // Nobody has a move: as good as a pass.
    if (!moves.length) return this.max(depth - 1, alpha, beta, ply + 1);
    for (const m of moves) {
      pos.make(m);
      const score = this.max(depth - 1, alpha, beta, ply + 1);
      pos.unmake();
      if (this.stopped) return 0;
      if (score < beta) {
        beta = score;
        if (alpha >= beta) return beta;
      }
    }
    return beta;
  }

  // Captures only, a few deep, so a search does not stop in the middle of
  // an exchange.
  quiet(mine, alpha, beta, left) {
    this.tick();
    const stand = evaluate4(this.pos, this.me);
    if (!left || this.stopped) return stand;
    const pos = this.pos;
    if (mine) {
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      for (const m of this.movesFor([this.me], true)) {
        pos.make(m);
        const score = this.quiet(false, alpha, beta, left - 1);
        pos.unmake();
        if (this.stopped) return alpha;
        if (score > alpha) alpha = score;
        if (alpha >= beta) break;
      }
      return alpha;
    }
    if (stand <= alpha) return stand;
    if (stand < beta) beta = stand;
    for (const m of this.movesFor(pos.opponents(this.me), true)) {
      pos.make(m);
      const score = this.quiet(true, alpha, beta, left - 1);
      pos.unmake();
      if (this.stopped) return beta;
      if (score < beta) beta = score;
      if (alpha >= beta) break;
    }
    return beta;
  }

  // Deepening a move at a time, keeping every root move within `margin` of
  // the best, as ai.js does. A round cut short stands for nothing.
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
        const score = this.min(depth - 1, floor, INF, 1);
        pos.unmake();
        if (this.stopped) break;
        scored.push({ m, score: score > floor ? score : -INF });
        if (score > best) best = score;
      }
      if (this.stopped) break;
      scored.sort((a, b) => b.score - a.score);
      done = { depth, scored, best };
      ordered = scored.map((s) => s.m);
      if (best > MATE - 100 || best < -MATE + 100) break;
    }
    return done;
  }
}

// The computer's move for whoever is to move in `pos`. `random` gives
// unsigned 32 bit integers. Returns { move, text } or null.
export function chooseMove4(pos, difficulty, random) {
  const level = LEVELS4[difficulty] ?? LEVELS4[3];
  const me = pos.turn;
  const moves = pos.moves();
  if (!moves.length) return null;
  order(moves);

  const wildRoll = random() % 100;
  const pickRoll = random();
  // A king left hanging is always taken, at every level.
  if (orderScore(moves[0]) === 1 << 28) return { move: moves[0], text: Position4.moveText(moves[0]) };
  if (wildRoll < level.wild) {
    const m = moves[pickRoll % moves.length];
    return { move: m, text: Position4.moveText(m) };
  }

  const search = new Search4(pos, me, level);
  const result = search.root(moves);
  if (!result) return { move: moves[0], text: Position4.moveText(moves[0]) };

  const { scored, best } = result;
  const pool = scored.filter((s) => s.score > -INF && s.score >= best - level.margin);
  if (!pool.length) return { move: scored[0].m, text: Position4.moveText(scored[0].m) };
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
  return { move: chosen.m, text: Position4.moveText(chosen.m) };
}
