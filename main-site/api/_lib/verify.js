// Replays a submitted game with the same modules the browser plays with,
// and works out what it is worth. Nothing a browser says about a game is
// taken on trust: the moves are replayed from the seed, the result is read
// off the final position, the computer's every move is played again, time
// claims are held against the server's own clock, and the score is computed
// here.

import { Position } from "../../js/chess.js";
import { replay, outcomeWith, validEnd, endText, MAX_PLIES } from "../../js/record.js";
import { parseSeed, moveRandom } from "../../js/seed.js";
import { chooseMove } from "../../js/ai.js";
import { finalScore, percentFor, progress, resultFor, timeBonus } from "../../js/score.js";
import { HttpError } from "./http.js";

// A clock claim may arrive this much before the server's own clock agrees:
// the start ticket's round trip, and a little drift.
const CLAIM_SLACK_MS = 3000;
// A timed game that ends on the board this long after its time was up had
// its clock stopped.
const OVER_SLACK_MS = 60000;
// The most the computer is allowed per move when judging that.
const COMPUTER_MOVE_MS = 5000;

export function readMoves(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLIES) {
    throw new HttpError(400, "bad_moves");
  }
  if (!value.every((m) => typeof m === "string" && /^(?:[a-h][1-8][a-h][1-8][qrbn]?|O-O|O-O-O)$/.test(m))) {
    throw new HttpError(400, "bad_moves");
  }
  return value;
}

// { by, side: "w" | "b" } from a request, to the shared form.
export function readEnd(value) {
  if (value == null) return null;
  const end = { by: value.by };
  if (value.side === "w") end.side = 0;
  else if (value.side === "b") end.side = 1;
  if (end.by === "timeup") delete end.side;
  if (!validEnd(end)) throw new HttpError(400, "bad_end");
  return end;
}

// The moves as the database stores them: one string, with any claim.
export function movesText(moves, end) {
  return moves.join(" ") + endText(end);
}

// The replayed game and how it ended, with any claim on the end checked.
// elapsedMs: the server's time from the start ticket to the end.
export function settle(game, moves, end, elapsedMs) {
  const seed = parseSeed(game.seed);
  if (!seed) throw new HttpError(500, "bad_seed");

  const record = replay(seed, moves);
  if (record.error) {
    throw new HttpError(409, "illegal", `Move ${record.error.ply + 1} is not a legal move in this game.`);
  }
  if (end && record.outcome) throw new HttpError(409, "illegal", "The game had already ended on the board.");

  const limit = game.time_limit_ms;
  if (end?.by === "resign" && game.mode === "computer" && end.side !== game.first_side) {
    throw new HttpError(409, "illegal", "The computer never resigns.");
  }
  if (end?.by === "flag") {
    if (game.time_mode !== "each") throw new HttpError(409, "illegal", "That game had no clock for each player.");
    // Against the computer only the player has a clock.
    if (game.mode === "computer" && end.side !== game.first_side) throw new HttpError(409, "illegal", "The computer has no clock.");
    // A player cannot run out of time before that much time has passed.
    if (elapsedMs < limit - CLAIM_SLACK_MS) throw new HttpError(409, "clock", "That game's clock had not run out yet.");
  }
  if (end?.by === "timeup") {
    if (game.time_mode !== "total") throw new HttpError(409, "illegal", "That game had no game clock.");
    if (elapsedMs < limit - CLAIM_SLACK_MS) throw new HttpError(409, "clock", "That game's clock had not run out yet.");
  }

  // Ending on the board long after the clock should have ended it means the
  // clock was stopped.
  if (!end && game.time_mode === "total" && elapsedMs > limit + OVER_SLACK_MS) {
    throw new HttpError(409, "over_time", "That game went on past its time limit.");
  }
  if (!end && game.time_mode === "each") {
    const computerMoves = game.mode === "computer" ? record.plies.filter((p) => p.side !== game.first_side).length : 0;
    const allowed = game.mode === "computer" ? limit + computerMoves * COMPUTER_MOVE_MS : 2 * limit;
    if (elapsedMs > allowed + OVER_SLACK_MS) throw new HttpError(409, "over_time", "That game went on past its time limit.");
  }

  const outcome = outcomeWith(record, end);
  if (!outcome) throw new HttpError(409, "unfinished", "Only a finished game can go on the leaderboard.");
  return { seed, record, outcome };
}

// game: the uwuchess_games row. side: 0 or 1, the side being submitted.
// end: a claim or null. undos: the side's undo count, already the higher of
// the browser's and the server's. elapsedMs: start ticket to the game's end.
export function verify(game, moves, side, end, undos, elapsedMs) {
  if (game.mode === "computer" && side !== game.first_side) {
    throw new HttpError(400, "bad_side", "Only the player's side of a computer game can be submitted.");
  }
  const { seed, record, outcome } = settle(game, moves, end, elapsedMs);

  // Every one of the computer's moves has to be the move it would play.
  if (game.mode === "computer") {
    const computer = game.first_side ^ 1;
    const pos = Position.fromIndex(seed.index);
    for (let ply = 0; ply < moves.length; ply++) {
      if (pos.turn === computer) {
        const pick = chooseMove(pos, game.difficulty, moveRandom(seed, game.difficulty, ply));
        if (!pick || pick.text !== moves[ply]) {
          throw new HttpError(409, "not_computer", "Those moves were not played against this computer.");
        }
      }
      pos.make(pos.findMove(moves[ply]));
    }
  }

  const result = resultFor(outcome.winner, side);
  const bonus = timeBonus(result, elapsedMs, game.server_seed === true);
  return {
    outcome: result,
    ownMoves: progress(record.plies, side).own,
    timeBonus: bonus,
    score: finalScore(record.plies, side, result, percentFor(game.mode, game.difficulty), undos, bonus),
  };
}
