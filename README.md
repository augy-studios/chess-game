# Chess Game

Chess against a computer that really plays, from Beginner to Master, on one
device between two people, or between two devices on the same network. Every
game has a seed that can be copied and played again, ends with an instant
replay, and can go on a leaderboard.

Live at <https://chess.uwuapps.org>. A PWA: once opened, it plays offline.

## What runs where

| Part | Runs on |
| --- | --- |
| `main-site/`, the PWA and its leaderboard API (`main-site/api/`) | Vercel, root directory `main-site` |
| Database, `uwuchess_*` tables | The shared uwuapps Supabase project |
| Network games | Browser to browser over WebRTC. PeerJS's public broker introduces the two devices; nothing of ours is in between |

There is nothing on the VPS.

## Layout

```text
README.md
migrations/      SQL to run in the Supabase SQL editor, in number order
scripts/         pre-deploy checks and the engine tests
main-site/       the site Vercel deploys, including api/
```

The `uwuapps-*.md`, `update-bar-spec.md` and `STUN-p2p-spec.md` files at the
root are the specs this is built to. `main-site/README.md` covers the app
itself.

## First setup

1. Run every file in `migrations/`, in number order, in the Supabase SQL
   editor of the shared uwuapps project. Each is safe to run again. Never
   edit one that has been run; a change is a new numbered file.
2. On the Vercel project (root directory `main-site`), set the variables in
   `main-site/.env.example`: `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.
3. Add the domain `chess.uwuapps.org` to the Vercel project.
4. Deploy.

Without the variables the site still works in full; the API answers
`not_configured` and every game says it is not scored.

## Before every deploy

1. Bump `VERSION` in `main-site/sw.js`. Without it, returning visitors keep
   the previous build and never see the update bar.
2. Run the checks, from the repo root, with Node 20 or later and nothing to
   install:

```text
node scripts/check-sw.mjs          # the worker only activates when asked
node scripts/check-precache.mjs    # everything the app loads works offline
node scripts/check-theme.mjs       # pre-paint script matches js/theme.js
node scripts/test-engine.mjs       # rules: perft, Chess960 castling, draws
node scripts/test-verify.mjs       # the API's game check, without a database
node scripts/test-ai.mjs           # same seed, same game; speed per level
```

`test-engine.mjs --deep` adds the slow perft depths. `test-ai.mjs --matches`
plays each level against a weaker one, which takes a few minutes.

**If you change `js/ai.js`, `js/chess.js`, `js/seed.js`, `js/record.js` or
`js/score.js`,**
games played on the old build stop verifying: the API replays every game
with the code it has now. Deploy such changes when a few failed submissions
from open tabs are acceptable.
