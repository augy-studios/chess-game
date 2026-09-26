// Replays a submitted game with the same modules the browser plays with,
// and works out what it is worth. Nothing a browser says about a game is
// taken on trust: the moves are replayed from the seed, the result is read
// off the final position, the computer's every move is played again, and
// the score is computed here.

import { Position } from "../../js/chess.js";
import { replay, MAX_PLIES } from "../../js/record.js";
import { parseSeed, moveRandom } from "../../js/seed.js";
import { chooseMove } from "../../js/ai.js";
import { finalScore, percentFor, progress, resultFor } from "../../js/score.js";
import { HttpError } from "./http.js";

export function readMoves(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PLIES) {
    throw new HttpError(400, "bad_moves");
  }
  if (!value.every((m) => typeof m === "string" && /^(?:[a-h][1-8][a-h][1-8][qrbn]?|O-O|O-O-O)$/.test(m))) {
    throw new HttpError(400, "bad_moves");
  }
  return value;
}

// game: the uwuchess_games row. side: 0 or 1, the side being submitted.
// resigned: 0, 1 or null. undos: the side's undo count, already the higher
// of the browser's and the server's.
export function verify(game, moves, side, resigned, undos) {
  const seed = parseSeed(game.seed);
  if (!seed) throw new HttpError(500, "bad_seed");

  if (game.mode === "computer" && side !== game.first_side) {
    throw new HttpError(400, "bad_side", "Only the player's side of a computer game can be submitted.");
  }

  const record = replay(seed, moves);
  if (record.error) {
    throw new HttpError(409, "illegal", `Move ${record.error.ply + 1} is not a legal move in this game.`);
  }

  let winner;
  if (resigned === 0 || resigned === 1) {
    if (record.outcome) throw new HttpError(409, "illegal", "The game had already ended before that resignation.");
    if (game.mode === "computer" && resigned !== game.first_side) {
      throw new HttpError(409, "illegal", "The computer never resigns.");
    }
    winner = resigned ^ 1;
  } else {
    if (!record.outcome) throw new HttpError(409, "unfinished", "Only a finished game can go on the leaderboard.");
    winner = record.outcome.winner;
  }

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

  const outcome = resultFor(winner, side);
  return {
    outcome,
    ownMoves: progress(record.plies, side).own,
    score: finalScore(record.plies, side, outcome, percentFor(game.mode, game.difficulty), undos),
  };
}
