// Scoring. The score grows as the game goes on, from what a side does with
// its moves, and the result adds a bonus at the end. The API recomputes it
// from the replayed moves and never takes a score from a browser.
//
// Integers throughout, so the page and the server always agree.

import { PAWN, KNIGHT, BISHOP, ROOK, QUEEN } from "./chess.js";

const TAKEN = { [PAWN]: 10, [KNIGHT]: 30, [BISHOP]: 30, [ROOK]: 50, [QUEEN]: 90 };
const PER_MOVE = 2;
const MOVES_COUNTED = 100;
const PROMOTION = 50;
const CHECK = 5;
const WIN = 400;
// Quicker wins earn more, down to nothing extra at 50 moves.
const QUICK_WIN = 200;
const QUICK_WIN_STEP = 4;
const DRAW = 120;
// Undo is unlimited, and each one costs this much before the percentage.
export const UNDO_COST = 40;

// Percent applied to everything, by computer level 1 to 5. A game between
// two people counts at 100.
export const LEVEL_PERCENT = [0, 40, 80, 120, 170, 240];
export const NETWORK_PERCENT = 100;

export function percentFor(mode, difficulty) {
  return mode === "computer" ? LEVEL_PERCENT[difficulty] ?? 0 : NETWORK_PERCENT;
}

// What the moves so far are worth to `side`, before the result.
export function progress(plies, side) {
  let own = 0;
  let points = 0;
  for (const p of plies) {
    if (p.side !== side) continue;
    own++;
    points += TAKEN[p.captured] ?? 0;
    if (p.promo) points += PROMOTION;
    if (p.check) points += CHECK;
  }
  return { own, points: points + Math.min(own, MOVES_COUNTED) * PER_MOVE };
}

// "win", "draw" or "loss" for `side`, from an outcome's winner.
export function resultFor(winner, side) {
  if (winner === -1) return "draw";
  return winner === side ? "win" : "loss";
}

// The score so far, shown while playing. Never below zero.
export function liveScore(plies, side, percent, undos = 0) {
  const raw = progress(plies, side).points - UNDO_COST * undos;
  return Math.max(0, Math.floor((raw * percent) / 100));
}

// The final score, with the result's bonus and less any undos.
export function finalScore(plies, side, result, percent, undos = 0) {
  const { own, points } = progress(plies, side);
  let bonus = 0;
  if (result === "win") bonus = WIN + Math.max(0, QUICK_WIN - QUICK_WIN_STEP * own);
  else if (result === "draw") bonus = DRAW;
  return Math.max(0, Math.floor(((points + bonus - UNDO_COST * undos) * percent) / 100));
}
