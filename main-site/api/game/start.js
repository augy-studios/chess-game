// POST /api/game/start  { client_key, mode, seed, difficulty?, side? }
//   -> { game_id, seed, first_side, created_at }
// The start ticket. A game can only go on the leaderboard if it began here,
// which is what gives it a start time no browser can move. Games started
// offline play the same; they just have no ticket.

import { endpoint, HttpError, clientKey, limit } from "../_lib/http.js";
import { rest, rpc } from "../_lib/supabase.js";
import { parseSeed } from "../../js/seed.js";

export default endpoint("POST", async ({ req, body }) => {
  const key = clientKey(body.client_key);
  const mode = body.mode;
  if (mode !== "computer" && mode !== "network") throw new HttpError(400, "bad_mode");

  const seed = parseSeed(body.seed);
  if (!seed) throw new HttpError(400, "bad_seed");

  let difficulty = null;
  if (mode === "computer") {
    difficulty = Number(body.difficulty);
    if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) throw new HttpError(400, "bad_difficulty");
  }

  // A side the player chose, or the seed's.
  let firstSide = seed.firstSide;
  if (body.side === "w") firstSide = 0;
  else if (body.side === "b") firstSide = 1;
  else if (body.side != null) throw new HttpError(400, "bad_side");

  await limit(req, "start", 600, 60);

  const [row] = await rest("uwuchess_games?select=id,created_at", {
    method: "POST",
    prefer: "return=representation",
    body: { mode, seed: seed.text, first_side: firstSide, difficulty, host_key: key },
  });

  // Now and then, clear out what nobody will submit.
  if (Math.random() < 0.02) rpc("uwuchess_prune", {}).catch(() => {});

  return { game_id: row.id, seed: seed.text, first_side: firstSide, created_at: row.created_at };
});
