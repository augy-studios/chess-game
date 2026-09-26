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

/* ---- endings off the board ----
   A game can also end by a claim: a resignation, a player's clock running
   out ("flag"), or a shared game clock running out ("timeup"). Written
   { by: "resign" | "flag", side } or { by: "timeup" }. The page, the network
   snapshot, the replay link and the API all use this one form. */

export function validEnd(end) {
  if (end === null) return true;
  if (!end || typeof end !== "object") return false;
  if (end.by === "timeup") return true;
  return (end.by === "resign" || end.by === "flag") && (end.side === 0 || end.side === 1);
}

// What a claim means in a position the board has not already ended.
export function claimedOutcome(pos, end) {
  const won = (winner, reason) => ({ result: winner === 0 ? "1-0" : "0-1", reason, winner });
  const draw = (reason) => ({ result: "1/2-1/2", reason, winner: -1 });
  if (end.by === "resign") return won(end.side ^ 1, "resign");
  if (end.by === "flag") {
    // Out of time loses, unless the other side could never checkmate.
    return pos.canMate(end.side ^ 1) ? won(end.side ^ 1, "flag") : draw("flag-draw");
  }
  // The shared clock: more material wins, level material draws.
  const lead = pos.material(0) - pos.material(1);
  return lead === 0 ? draw("timeup") : won(lead > 0 ? 0 : 1, "timeup");
}

// The game's outcome counting a claim, or null if it goes on. A claim made
// after the board had already ended the game does not count.
export function outcomeWith(record, end) {
  if (record.outcome || !end) return record.outcome;
  return claimedOutcome(record.pos, end);
}

// A claim as text, appended to the moves wherever they are stored as one
// string, so two submissions of one game compare equal only if they agree.
export function endText(end) {
  if (!end) return "";
  return end.by === "timeup" ? " timeup" : ` ${end.by}:${end.side}`;
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
