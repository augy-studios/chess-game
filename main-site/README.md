# main-site

What Vercel deploys, served at <https://chess.uwuapps.org>. No build step:
the files are served as they are, and `api/` holds the serverless functions.

| Path | What it is |
| --- | --- |
| `index.html` | The only page. Its `<head>` is the template for any page added later. |
| `404.html`, `404.css` | The shared not-found page. |
| `sw.js` | Service worker: the offline shell, and the update bar's waiting worker. |
| `manifest.json` | PWA manifest. |
| `css/theme.css` | The uwuapps theme, verbatim from `uwuapps-theme.md`, time-based mode included. |
| `css/style.css` | Layout, the board and the pieces. Board and piece colours are tokens at the top. |
| `js/` | ES modules, below. |
| `api/` | The leaderboard API, below. |
| `images/` | Manifest screenshots. Still the template's; replace them with real ones. |

## js

Every file here is precached; `scripts/check-precache.mjs` fails if one is
not. The first five are pure, with no DOM, and the API imports them too, so
the browser and the server always agree on a game.

| File | What it does |
| --- | --- |
| `chess.js` | The rules. 0x88 board, legal moves, Chess960 castling, check, mate, stalemate, the fifty-move rule, threefold repetition, too little material, notation. |
| `ai.js` | The computer: alpha-beta search with quiescence, and difficulty (below). Deterministic. |
| `seed.js` | Seeds, and the integer random numbers everything draws from. |
| `record.js` | Replays a seed and a move list into positions and notation. |
| `score.js` | Scoring (below). |
| `ai-worker.js`, `computer.js` | The computer's Web Worker, and the page's side of it. |
| `board.js` | The board on screen: tap, drag or keyboard, sliding moves, the grey box on the square a piece left. |
| `pieces.js` | The pieces, as inline SVG drawn for this app. |
| `game.js` | The game screen: setup, play, undo, resign, result, submit, saving. |
| `replay.js` | The instant replay. |
| `net.js` | Pairing over PeerJS, STUN only, from `STUN-p2p-spec.md`. |
| `multiplayer.js` | Network games on top of `net.js`: hosting, joining, and the messages. |
| `qr.js` | QR encoder for the join link, from uwuPromptr, so it works offline. |
| `api.js`, `leaderboard.js`, `settings.js` | The API client, and the leaderboard and settings windows, after MRT Station Guesser's. |
| `theme.js`, `icons.js`, `ui.js`, `update-bar.js`, `app.js` | Theme, inline SVG icons, modal and storage helpers, the update bar, and boot. |

## The game

**Modes.** Against the computer; two people taking turns on this device, with
the board turning for each; or two devices on one network, one hosting with a
six character code, a link or a QR code, and the other joining.

**Seeds.** A seed looks like `960-BXK4-M9TR`. It picks the start position,
one of the 960 Chess960 positions or, with `STD-`, the ordinary one. It also
picks the side when the player lets the game decide, and every choice the
computer makes. The same seed and the same moves are always the same game.
The seed shows during play and at the end, where it can be copied; paste one
into the new-game screen to play that start again.

**The computer.** Five levels. Each looks further ahead, and each considers a
narrower spread of moves around its best one, so a weaker level plays good
but not best moves rather than random ones. Only Beginner sometimes plays a
move without thinking. It runs in a Web Worker, stops on a count of positions
rather than a clock, and never reads the time or `Math.random`. That is what
lets the API replay a game and check every one of the computer's moves.

| Level | Looks ahead | Spread | Moves at random |
| --- | --- | --- | --- |
| 1 Beginner | 1 move | 2.5 pawns | 15% |
| 2 Casual | 2 | 1.2 pawns | 4% |
| 3 Club | 3 | 0.5 pawns | none |
| 4 Strong | 4 | 0.15 pawns | none |
| 5 Master | up to 8 | best move only | none |

**Moving.** Tap a piece then a square, or drag it. Castling works by moving
the king to its square, the king onto the rook, or the rook onto the king.
Every move slides, and a grey box stays on the square the piece left.

**Undo.** Unlimited, in every mode. Against the computer it takes back your
move and its reply. In a network game it asks the other player, who accepts
or declines. In a scored game each undo costs 40 points before the level
percentage.

**Replay.** When a game ends it plays back on the board by itself (a setting
turns this off), with play, pause, a step back or forward, a slider and the
move list.

**Scoring.** The score grows with the game, from the side's own moves:

| | Points |
| --- | --- |
| Each move, up to 100 | 2 |
| Taking a pawn, knight or bishop, rook, queen | 10, 30, 50, 90 |
| Promoting | 50 |
| Giving check | 5 |
| Winning | 400, plus up to 200 more for a quick win (4 fewer per move) |
| Drawing | 120 |
| Each undo | minus 40 |

The total is then scaled by the opponent: levels 1 to 5 count 40%, 80%,
120%, 170% and 240%; a network game counts 100%.

## The leaderboard and anti-cheat

Games against the computer and network games count; games on one device do
not. A game counts only if it started while online: starting asks
`/api/game/start` for a ticket, whose time comes from the server. Games
started offline play the same, and say they are not scored.

On submit the API trusts nothing but the name. It replays every move from the
seed and refuses an illegal one. It reads the result off the final position,
or accepts a resignation. It replays the computer at every one of its moves
and refuses any that differ. It computes the score itself. The database then
refuses a submission that:

| Code | When |
| --- | --- |
| `not_yours` | comes from a browser other than the one that started the game |
| `same_device` | is a network game's second side, sent from the host's own browser |
| `too_fast` | finishes sooner than a second per own move, or ten seconds in all |
| `overlap` | was played at the same time as another game under the same name |
| `seed_used` | repeats a seed and level already on the board under that name |
| `mismatch` | is a network game's second side, with different moves from the first |
| `same_name` | puts both sides of one network game under one name |

Undos are counted on the server as they happen, from browsers that are
online, and a submission is charged the higher of that count and its own.

None of this stops a person using a chess engine in another tab, and an undo
made offline and then hidden cannot be counted. It is meant to stop scripted
and replayed games, not to prove who played the moves.

## Network games

Per `STUN-p2p-spec.md`: STUN only, no TURN relay. **Both devices have to be
on the same network**: the same wifi, or one sharing a hotspot with the
other. PeerJS loads from cdnjs only when somebody hosts or joins, and is
never cached. The host holds the game and sends it in full twice a second;
the guest sends moves, resignations and undo requests. A guest that reloads
or drops rejoins with the same code, and leaving on purpose retires it.

## Offline and updates

Everything the page loads is precached, the computer's worker and the Jua
font included, so the site opens and plays with no connection. Only the
leaderboard and network games need the network. Nothing under `/api/` is
ever cached.

A new service worker installs and waits. The update bar offers Reload or Not
now, and nothing reloads until the reader asks. Bump `VERSION` in `sw.js` on
every change to anything in this directory.

## API

| Endpoint | Body | Returns |
| --- | --- | --- |
| `POST /api/game/start` | `client_key, mode, seed, difficulty?, side?` | `game_id, seed, first_side, created_at` |
| `POST /api/game/undo` | `game_id, client_key, side` | `undos` |
| `POST /api/game/submit` | `game_id, client_key, name, side, moves, resigned?, undos?` | `name, score, outcome, rank, best_score, total, games, total_rank` |
| `POST /api/leaderboard/name` | `name` | `name`, cleaned, or a `400` saying why not |
| `GET /api/leaderboard` | `?board=best` or `?board=total` | `board, entries`, cached 30 s |

`side` and `resigned` are `w` or `b`. Errors are `{ error, message? }` with a
matching status. Start is limited to 60 an address per 10 minutes and submit
to 30. Submit replays the whole game, so `vercel.json` gives it up to 300
seconds, although a long Master game takes well under a minute.

## Environment variables (Vercel)

Documented in `.env.example`. `.vercelignore` keeps every env file out of
deployments, since anything in this directory would otherwise be served.

| Variable | Used for |
| --- | --- |
| `SUPABASE_URL` | The shared uwuapps project. |
| `SUPABASE_SERVICE_KEY` | Service role key. Server side only, never sent to a browser. |
