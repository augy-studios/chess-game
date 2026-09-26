-- Time limits and the time bonus. Run after 001. Safe to run again.
--
-- A game can now carry a time limit, and a quick win or draw scores more.
-- Both need times a browser cannot move, so the server keeps them:
--
--   server_seed    the server picked the seed (the player pasted none), so
--                  nobody could have practised it; only these earn the time
--                  bonus
--   time_mode      'none', 'each' (a clock per player) or 'total' (one clock
--                  for the game)
--   time_limit_ms  the limit, per player or for the whole game
--
-- and uwuchess_finish records when a game ended, sent by the page the moment
-- it does, so time spent afterwards watching the replay or typing a name is
-- not counted.

alter table uwuchess_games add column if not exists server_seed boolean not null default false;
alter table uwuchess_games add column if not exists time_mode text not null default 'none';
alter table uwuchess_games add column if not exists time_limit_ms int;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'uwuchess_games_time_check') then
    alter table uwuchess_games add constraint uwuchess_games_time_check check (
      (time_mode = 'none' and time_limit_ms is null)
      or (time_mode in ('each', 'total') and time_limit_ms between 60000 and 10800000)
    );
  end if;
end $$;

-- Records the end of a game: its moves, as one string with any claim on the
-- end, and the server's time. The API has replayed the moves first. Sent
-- again after an undo reopened the game, it records the new ending; once
-- either side is on the leaderboard the game is fixed.
--
--   not_found, expired, not_yours  as for uwuchess_submit
--   mismatch                       the game is on the board with other moves
create or replace function uwuchess_finish(p_game_id uuid, p_client_key text, p_moves text)
returns table (status text, created_at timestamptz, finished_at timestamptz)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_game uwuchess_games%rowtype;
begin
  select * into v_game from uwuchess_games where id = p_game_id for update;
  if not found then
    return query select 'not_found'::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_game.created_at < now() - interval '12 hours' then
    return query select 'expired'::text, null::timestamptz, null::timestamptz;
    return;
  end if;
  -- A computer game's end only from the browser that started it. Either
  -- player of a network game may send it; it is the same game on both.
  if v_game.mode = 'computer' and p_client_key <> v_game.host_key then
    return query select 'not_yours'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if exists (select 1 from uwuchess_leaderboard l where l.game_id = p_game_id) then
    if v_game.moves is distinct from p_moves then
      return query select 'mismatch'::text, null::timestamptz, null::timestamptz;
      return;
    end if;
  elsif v_game.moves is distinct from p_moves then
    -- A new ending: the first, or one after an undo.
    update uwuchess_games set moves = p_moves, finished_at = now() where id = p_game_id
    returning finished_at into v_game.finished_at;
  end if;

  return query select 'ok'::text, v_game.created_at, v_game.finished_at;
end;
$$;

-- Undos are now counted until the game is on the leaderboard, rather than
-- until it first ended: undo reopens a finished game, and is unlimited.
create or replace function uwuchess_undo(p_game_id uuid, p_client_key text, p_side smallint)
returns int
language plpgsql
volatile
as $$
declare
  v_game uwuchess_games%rowtype;
  v_host_side boolean;
begin
  select * into v_game from uwuchess_games where id = p_game_id for update;
  if not found or v_game.created_at < now() - interval '12 hours' then
    return null;
  end if;
  if exists (select 1 from uwuchess_leaderboard l where l.game_id = p_game_id) then
    return null;
  end if;
  v_host_side := p_side = v_game.first_side;
  if (v_game.mode = 'computer' or v_host_side) and p_client_key <> v_game.host_key then
    return null;
  end if;
  if v_game.mode = 'network' and not v_host_side and p_client_key = v_game.host_key then
    return null;
  end if;
  if p_side = 0 then
    update uwuchess_games set undos_w = undos_w + 1 where id = p_game_id returning undos_w into v_game.undos_w;
    return v_game.undos_w;
  end if;
  update uwuchess_games set undos_b = undos_b + 1 where id = p_game_id returning undos_b into v_game.undos_b;
  return v_game.undos_b;
end;
$$;

revoke all on function uwuchess_finish(uuid, text, text) from public, anon, authenticated;
grant execute on function uwuchess_finish(uuid, text, text) to service_role;
