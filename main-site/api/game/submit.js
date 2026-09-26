// POST /api/game/submit
//   { game_id, client_key, name, side, moves, resigned?, undos? }
//   -> { name, score, outcome, rank, best_score, total, games, total_rank }
// side and resigned are "w" or "b". moves is the whole game as stored move
// text. The score is computed here from the replayed moves; see verify.js
// for the checks on the game and the SQL function for the rest.

import { endpoint, HttpError, clientKey, gameId, side as readSide, limit } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rest, rpc } from "../_lib/supabase.js";
import { readMoves, verify } from "../_lib/verify.js";

const REFUSALS = {
  not_found: [404, "That game does not exist."],
  expired: [410, "That game started more than 12 hours ago."],
  not_yours: [403, "That game was started in a different browser."],
  same_device: [409, "Both sides of that game were played from one browser, so it stays off the leaderboard."],
  already_submitted: [409, "That game is already on the leaderboard."],
  mismatch: [409, "Those moves do not match the ones your opponent submitted."],
  too_fast: [409, "That game was played too quickly to count."],
  same_name: [409, "Your opponent is already on the leaderboard for this game under that name. Pick another."],
  overlap: [409, "That game was played at the same time as another one already on the leaderboard under this name."],
  seed_used: [409, "That name already has this seed at this level on the leaderboard. Try a new seed."],
};

export default endpoint("POST", async ({ req, body }) => {
  const id = gameId(body.game_id);
  const key = clientKey(body.client_key);
  const name = cleanName(body.name);
  const who = readSide(body.side);
  const moves = readMoves(body.moves);
  const resigned = body.resigned == null ? null : readSide(body.resigned);
  const reported = Number.isInteger(body.undos) && body.undos >= 0 ? Math.min(body.undos, 10000) : 0;

  // Replaying a long game against the Master level is real work, so this
  // is limited harder than anything else.
  await limit(req, "submit", 600, 30);

  const [game] = (await rest(`uwuchess_games?id=eq.${id}&select=*`)) ?? [];
  if (!game) throw new HttpError(404, "not_found", REFUSALS.not_found[1]);

  const recorded = who === 0 ? game.undos_w : game.undos_b;
  const result = verify(game, moves, who, resigned, Math.max(reported, recorded ?? 0));

  const [row] =
    (await rpc("uwuchess_submit", {
      p_game_id: id,
      p_side: who,
      p_name: name,
      p_client_key: key,
      p_moves: moves.join(" ") + (resigned == null ? "" : ` resign:${resigned}`),
      p_score: result.score,
      p_outcome: result.outcome,
      p_own_moves: result.ownMoves,
    })) ?? [];
  if (row?.status !== "ok") {
    const [status, message] = REFUSALS[row?.status] ?? [500, "Could not submit."];
    throw new HttpError(status, row?.status ?? "server", message);
  }

  return {
    name,
    score: result.score,
    outcome: result.outcome,
    rank: Number(row.rank),
    best_score: row.best_score,
    total: Number(row.total),
    games: row.games,
    total_rank: Number(row.total_rank),
  };
});
