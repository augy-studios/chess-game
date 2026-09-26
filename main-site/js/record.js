// A game as a seed and a list of moves, replayed into everything the page,
// the replay and the API need: the positions, the notation, and what each
// move took or threatened. Pure, like chess.js.

import { Position, CAPTURE, typeOf } from "./chess.js";

export const MAX_PLIES = 600;

// Replays `moves` (stored move text) from the seed's start position.
// Stops at the first move that is not legal and says where.
export function replay(seed, moves) {
  const pos = Position.fromIndex(seed.index);
  const plies = [];
  let error = null;

  for (let i = 0; i < moves.length; i++) {
    if (i >= MAX_PLIES) {
      error = { ply: i, reason: "too_long" };
      break;
    }
    const legal = pos.moves();
    const text = moves[i];
    const m = typeof text === "string" ? legal.find((x) => Position.moveText(x) === text) : null;
    if (!m) {
      error = { ply: i, reason: "illegal" };
      break;
    }
    if (pos.outcome()) {
      error = { ply: i, reason: "after_end" };
      break;
    }
    const side = pos.turn;
    const san = pos.san(m, legal);
    pos.make(m);
    plies.push({
      text,
      san,
      side,
      from: m.from,
      to: m.to,
      rookFrom: m.rookFrom,
      captured: m.flags & CAPTURE ? typeOf(m.captured) : 0,
      promo: m.promo ? typeOf(m.promo) : 0,
      check: pos.inCheck(),
    });
  }

  return { pos, plies, error, outcome: error ? null : pos.outcome() };
}

// Positions after each ply, for stepping through a replay. Index 0 is the
// start.
export function positions(seed, moves) {
  const pos = Position.fromIndex(seed.index);
  const out = [pos.clone()];
  for (const text of moves) {
    const m = pos.findMove(text);
    if (!m) break;
    pos.make(m);
    out.push(pos.clone());
  }
  return out;
}

/* ---- packing a game into a link ----
   Each move is stored as its index in the position's list of legal moves,
   one byte a move, since no position has more than 218. The list's order is
   fixed by chess.js, so the same bytes always unpack to the same game, and a
   damaged link cannot unpack to an illegal one: it stops, and says so. */

function toBase64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function packMoves(seed, moves) {
  const pos = Position.fromIndex(seed.index);
  const bytes = [];
  for (const text of moves) {
    const legal = pos.moves();
    const i = legal.findIndex((m) => Position.moveText(m) === text);
    if (i < 0) break;
    bytes.push(i);
    pos.make(legal[i]);
  }
  return toBase64Url(bytes);
}

// The move list a packed string stands for, or null if it is damaged.
export function unpackMoves(seed, packed) {
  const bytes = fromBase64Url(packed ?? "");
  if (!bytes || bytes.length > MAX_PLIES) return null;
  const pos = Position.fromIndex(seed.index);
  const moves = [];
  for (const i of bytes) {
    const legal = pos.moves();
    if (i >= legal.length || pos.outcome()) return null;
    moves.push(Position.moveText(legal[i]));
    pos.make(legal[i]);
  }
  return moves;
}

// Material each side has taken, for the captured pieces rows.
export function captures(plies) {
  const taken = [[], []];
  for (const p of plies) if (p.captured) taken[p.side].push(p.captured);
  return taken;
}
