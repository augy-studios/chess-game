// The game screen: choosing a game, playing it, and what happens after.
//
// A game is a seed and a list of moves, and everything on screen is derived
// from those two by replaying them, plus how it ended if that was not on
// the board (a resignation, or a clock). That is also all that is saved,
// sent to the other device in a network game, put in a replay link, and
// submitted to the leaderboard, where the API replays it the same way.

import { WHITE, BLACK } from "./chess.js";
import { BoardView, moveMarks } from "./board.js";
import { replay as replayGame, packMoves, unpackMoves, outcomeWith, validEnd } from "./record.js";
import { newSeed, parseSeed } from "./seed.js";
import { LEVELS } from "./ai.js";
import { requestMove, cancelMove } from "./computer.js";
import { finalScore, liveScore, percentFor, resultFor, timeBonus, UNDO_COST, TIME_BONUS_MAX } from "./score.js";
import {
  PRESET_MINUTES,
  MIN_MINUTES,
  MAX_MINUTES,
  validTime,
  newClock,
  remaining,
  hand,
  stop,
  clockToWire,
  clockFromWire,
  formatClock,
  formatTaken,
} from "./clock.js";
import { api } from "./api.js";
import { getSettings, onSettingsChange, saveSettings } from "./settings.js";
import { openLeaderboard } from "./leaderboard.js";
import { typeSvg } from "./pieces.js";
import { Replay } from "./replay.js";
import { copyText, hydrateIcons, store } from "./ui.js";
import { confetti } from "./confetti.js";

const GAME_STORAGE = "uwuchess.game";
const SETUP_STORAGE = "uwuchess.setup";
const SIDE_NAME = ["White", "Black"];
const SIDE_LETTER = ["w", "b"];
const VALUE = [0, 1, 3, 3, 5, 9, 0];
const LOW_TIME_MS = 20000;
// How long to wait for the server to pick a seed before starting offline.
const START_WAIT_MS = 5000;

const $ = (id) => document.getElementById(id);

let board = null;
let replayer = null;
let g = null; // the game on screen, or null
let rec = null; // replayGame(g.seed, g.moves), refreshed on every change
let thinking = false;
let launching = false;
let gameCounter = 0;
let resignTimer = null;
let leaveTimer = null;
let rowSides = [0, 1]; // the sides shown in the bottom and top rows
let net = null; // set by multiplayer.js for network games
let watching = null; // a shared replay being watched: { seed, moves, end, meta }

/* ---- setup ---- */

// time: 0 for none, minutes for a preset, or "custom" for `custom` minutes.
// split: "each" for a clock per player, "total" for one for the game.
const setup = { mode: "computer", level: 3, side: "seed", variant: "960", time: 0, custom: 20, split: "each" };

function loadSetup() {
  const saved = store.getJSON(SETUP_STORAGE) ?? {};
  if (["computer", "local", "network"].includes(saved.mode)) setup.mode = saved.mode;
  if (Number.isInteger(saved.level) && saved.level >= 1 && saved.level <= 5) setup.level = saved.level;
  if (["w", "b", "seed"].includes(saved.side)) setup.side = saved.side;
  if (["960", "STD"].includes(saved.variant)) setup.variant = saved.variant;
  if (saved.time === 0 || saved.time === "custom" || PRESET_MINUTES.includes(saved.time)) setup.time = saved.time;
  if (Number.isInteger(saved.custom) && saved.custom >= MIN_MINUTES && saved.custom <= MAX_MINUTES) setup.custom = saved.custom;
  if (["each", "total"].includes(saved.split)) setup.split = saved.split;
}

function saveSetup() {
  store.set(SETUP_STORAGE, setup);
}

const MODE_NOTES = {
  computer: "Scored on the leaderboard when the game starts while you are online.",
  local: "Two players taking turns on this device. Not scored.",
  network: "Play someone on the same wifi, or sharing a hotspot. Scored when started online.",
};

function timeNote() {
  if (setup.time === 0) return "";
  const min = setup.time === "custom" ? setup.custom : setup.time;
  if (setup.split === "total") {
    return `${min} minutes for the whole game. When it runs out, whoever has more material wins.`;
  }
  const each =
    setup.mode === "computer"
      ? `You have ${min} minutes; only your own thinking time counts.`
      : `Each player has ${min} minutes of their own.`;
  return `${each} Running out loses, unless the other side could never checkmate.`;
}

function renderSetup() {
  const check = (sel, attr, value) =>
    document.querySelectorAll(sel).forEach((el) => el.setAttribute("aria-checked", String(el.dataset[attr] === String(value))));
  check("#modePick [data-pick]", "pick", setup.mode);
  check("#levelPick [data-level]", "level", setup.level);
  check("#sidePick [data-side]", "side", setup.side);
  check("#variantPick [data-variant]", "variant", setup.variant);
  check("#timePick [data-time]", "time", setup.time);
  check("#timeSplitPick [data-split]", "split", setup.split);
  $("levelGroup").classList.toggle("hidden", setup.mode !== "computer");
  $("sideGroup").classList.toggle("hidden", setup.mode === "local");
  $("sideLabel").textContent = setup.mode === "network" ? "Host plays as" : "Play as";
  $("joinForm").classList.toggle("hidden", setup.mode !== "network");
  $("startLabel").textContent = launching ? "Starting" : setup.mode === "network" ? "Host a game" : "Start game";
  $("startBtn").disabled = launching;
  $("modeNote").textContent = MODE_NOTES[setup.mode];
  $("customTime").classList.toggle("hidden", setup.time !== "custom");
  if (document.activeElement !== $("customMinutes")) $("customMinutes").value = String(setup.custom);
  $("timeSplitPick").classList.toggle("hidden", setup.time === 0);
  $("timeNote").textContent = timeNote();
}

// The chosen time limit, null for none, or undefined if the custom number
// is not one.
function timeFromSetup() {
  if (setup.time === 0) return null;
  // The field as it reads now, not the last good number typed into it.
  const minutes = setup.time === "custom" ? Number($("customMinutes").value) : setup.time;
  if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) return undefined;
  return { mode: setup.split, ms: minutes * 60000 };
}

function shake(input) {
  input.classList.remove("shake");
  void input.offsetWidth;
  input.classList.add("shake");
  input.focus();
}

// What the seed field holds, as a seed, or null if it cannot be one. Eight
// characters with no prefix take the start position chosen above.
function seedFromField() {
  const raw = $("seedInput").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^(960|STD)/.test(raw) ? parseSeed(raw) : parseSeed(setup.variant + raw);
}

function onStart() {
  const typed = $("seedInput").value.trim() !== "";
  const seed = typed ? seedFromField() : null;
  if (typed && !seed) {
    $("seedNote").textContent = "That is not a seed. Seeds look like 960-BXK4-M9TR.";
    return shake($("seedInput"));
  }
  const time = timeFromSetup();
  if (time === undefined) {
    $("timeNote").textContent = `Enter a whole number of minutes, ${MIN_MINUTES} to ${MAX_MINUTES}.`;
    return shake($("customMinutes"));
  }
  const sideChoice = setup.side === "seed" ? null : setup.side;
  if (setup.mode === "network") {
    net?.host({ seed, variant: setup.variant, side: sideChoice, time });
    return;
  }
  launch({
    mode: setup.mode,
    seed,
    variant: setup.variant,
    level: setup.level,
    sideChoice: setup.mode === "local" ? null : sideChoice,
    time,
  });
}

function setLaunching(on) {
  launching = on;
  $("againBtn").disabled = on;
  renderSetup();
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);
}

// Starts a game. With no seed, a scored game asks the server to pick one
// (only those earn the time bonus); if it cannot be reached in a few
// seconds, the game starts anyway on a seed of its own, unscored. A pasted
// seed starts at once and fetches its ticket meanwhile. Resolves with the
// game, or null if a start was already under way.
export async function launch(opts) {
  const { mode, variant = "960", level = null, sideChoice = null, time = null, role = null } = opts;
  if (mode === "local" || opts.seed) return startGame({ ...opts, seed: opts.seed ?? newSeed(variant) });
  if (launching) return null;
  setLaunching(true);
  let ticket = null;
  try {
    ticket = await withTimeout(api.start({ mode, variant, difficulty: level ?? undefined, side: sideChoice ?? undefined, time: time ?? undefined }), START_WAIT_MS);
  } catch {
    ticket = null;
  }
  setLaunching(false);
  const seed = ticket && parseSeed(ticket.seed);
  if (seed) {
    return startGame({
      mode,
      role,
      seed,
      level,
      sideChoice,
      time,
      firstSide: ticket.first_side,
      gameId: ticket.game_id,
      ticket: "ok",
      serverSeed: ticket.server_seed === true,
    });
  }
  return startGame({ mode, role, seed: newSeed(variant), level, sideChoice, time, ticket: "offline" });
}

/* ---- the game ---- */

// opts: { mode, seed, level?, sideChoice ("w" | "b" | null), role?,
// firstSide?, gameId?, moves?, undos?, end?, submitted?, ticket?,
// serverSeed?, time?, clock?, startedAt?, elapsed? }
export function startGame(opts) {
  cancelMove();
  thinking = false;
  replayer.stop();
  if (watching) closeWatch({ show: false });
  const now = Date.now();
  const sideChoice = opts.sideChoice ?? null;
  g = {
    id: ++gameCounter,
    mode: opts.mode,
    role: opts.role ?? null,
    seed: opts.seed,
    level: opts.mode === "computer" ? opts.level : null,
    sideChoice,
    firstSide: opts.firstSide ?? (sideChoice === "w" ? WHITE : sideChoice === "b" ? BLACK : opts.seed.firstSide),
    moves: opts.moves?.slice() ?? [],
    undos: opts.undos?.slice() ?? [0, 0],
    end: opts.end ?? null,
    gameId: opts.gameId ?? null,
    ticket: opts.ticket ?? (opts.mode === "local" || opts.role === "guest" ? "none" : "pending"),
    serverSeed: opts.serverSeed ?? false,
    submitted: opts.submitted ?? false,
    submittedText: opts.submittedText ?? null,
    time: opts.time ?? null,
    clock: opts.clock ?? newClock(now),
    startedAt: opts.startedAt ?? now,
    elapsed: opts.elapsed ?? null,
    finishSent: opts.elapsed != null,
    takeback: null,
    flipped: false,
    wasOver: false,
  };
  rec = replayGame(g.seed, g.moves);
  if (rec.error) {
    // A saved game that no longer replays: start it again from the top.
    g.moves = g.moves.slice(0, rec.error.ply);
    rec = replayGame(g.seed, g.moves);
  }
  if (!opts.clock) syncClock();
  disarmResign();
  disarmLeave();
  showPanel("play");
  resetResult();
  persist();
  update({ fresh: true });
  if (g.ticket === "pending") fetchTicket(g);
  maybeComputer();
  return g;
}

// The ticket for a game on a seed the player chose. It never earns the time
// bonus, but it can go on the leaderboard.
async function fetchTicket(game) {
  try {
    const t = await api.start({
      mode: game.mode,
      seed: game.seed.text,
      difficulty: game.level ?? undefined,
      side: SIDE_LETTER[game.firstSide],
      time: game.time ?? undefined,
    });
    if (game !== g) return;
    g.gameId = t.game_id;
    g.ticket = "ok";
  } catch {
    if (game !== g) return;
    g.ticket = "offline";
  }
  persist();
  update();
  net?.changed();
}

function isOver() {
  return Boolean(g && (g.end !== null || rec.outcome));
}

function outcome() {
  return outcomeWith(rec, g.end);
}

// The side this screen plays: the person against the computer, one end of
// a network game, or, on a shared device, whoever is to move.
function mySide() {
  if (g.mode === "computer") return g.firstSide;
  if (g.mode === "network") return g.role === "host" ? g.firstSide : g.firstSide ^ 1;
  return rec.pos.turn;
}

function orientation() {
  let side;
  if (g.mode === "local") side = getSettings().auto_flip ? rec.pos.turn : WHITE;
  else side = mySide();
  return g.flipped ? side ^ 1 : side;
}

function interactiveSide() {
  if (isOver() || thinking) return -1;
  if (g.mode === "local") return rec.pos.turn;
  if (g.mode === "network" && (!net?.connected() || g.takeback)) return -1;
  return rec.pos.turn === mySide() ? mySide() : -1;
}

function scoring() {
  return g.mode !== "local";
}

function percent() {
  return percentFor(g.mode, g.level);
}

/* ---- the clock ---- */

// Whether `side` has a clock of its own. Against the computer only the
// player does: its thinking time depends on the device, and nobody could
// check a claim that it ran out.
function clocked(side) {
  return g.time?.mode === "each" && (g.mode !== "computer" || side === g.firstSide);
}

// The guest's clock is the host's, from the snapshots. Everybody else keeps
// their own.
function ownsClock() {
  return Boolean(g?.time) && g.role !== "guest";
}

// Hands the clock to whoever is to move now, or stops it if the game is
// over. Safe to call after any change.
function syncClock() {
  if (!ownsClock()) return;
  const now = Date.now();
  if (isOver()) stop(g.clock, now);
  else if (g.time.mode === "each") hand(g.clock, clocked(rec.pos.turn) ? rec.pos.turn : -1, now);
}

function endByTime(end) {
  cancelMove();
  thinking = false;
  g.end = end;
  stop(g.clock, Date.now());
  $("status").dataset.last = end.by === "flag" ? `${SIDE_NAME[end.side]} ran out of time.` : "The game clock ran out.";
  persist();
  update();
  net?.changed();
}

function tickClock() {
  if (!g?.time) return;
  renderClocks();
  if (isOver() || !ownsClock()) return;
  const now = Date.now();
  if (g.time.mode === "total") {
    if (remaining(g.time, g.clock, 0, now) <= 0) endByTime({ by: "timeup" });
    return;
  }
  const side = g.clock.running;
  if (side >= 0 && remaining(g.time, g.clock, side, now) <= 0) endByTime({ by: "flag", side });
}

function renderClock(el, ms, running, label) {
  el.textContent = formatClock(ms);
  el.classList.toggle("running", running);
  el.classList.toggle("low", ms < LOW_TIME_MS);
  el.setAttribute("aria-label", label);
}

function renderClocks() {
  const now = Date.now();
  const over = isOver();
  const game = $("gameClock");
  const rows = [$("bottomClock"), $("topClock")];
  if (!g?.time) {
    game.textContent = "";
    rows.forEach((el) => (el.textContent = ""));
    return;
  }
  if (g.time.mode === "total") {
    rows.forEach((el) => (el.textContent = ""));
    const ms = remaining(g.time, g.clock, 0, now);
    renderClock(game, ms, !over, `Game clock, ${formatClock(ms)} left`);
    return;
  }
  game.textContent = "";
  rows.forEach((el, i) => {
    const side = rowSides[i];
    if (!clocked(side)) {
      el.textContent = "";
      return;
    }
    const ms = remaining(g.time, g.clock, side, now);
    renderClock(el, ms, !over && g.clock.running === side, `${SIDE_NAME[side]}'s clock, ${formatClock(ms)} left`);
  });
}

/* ---- moves ---- */

// Plays a move, from the board, the computer or the network. Returns false
// if it is not legal here and now.
export function playMove(text, { from = "board" } = {}) {
  if (!g || isOver()) return false;
  const before = rec.pos;
  const marks = moveMarks(before, text);
  if (!marks) return false;
  g.moves.push(text);
  rec = replayGame(g.seed, g.moves);
  syncClock();
  persist();
  const ply = rec.plies.at(-1);
  announce(ply, from);
  update({ animate: marks });
  net?.changed();
  if (!isOver()) maybeComputer();
  return true;
}

function announce(ply, from) {
  const who =
    g.mode === "computer"
      ? from === "computer"
        ? "The computer played"
        : "You played"
      : g.mode === "network"
        ? from === "network"
          ? "Your opponent played"
          : "You played"
        : `${SIDE_NAME[ply.side]} played`;
  $("status").dataset.last = `${who} ${ply.san}.`;
}

async function maybeComputer() {
  if (!g || g.mode !== "computer" || isOver() || rec.pos.turn === g.firstSide || thinking) return;
  const game = g;
  const ply = g.moves.length;
  thinking = true;
  update();
  // A beat before even an instant reply, so the move is seen to happen.
  const pause = new Promise((r) => setTimeout(r, 350 + g.level * 60));
  const text = await requestMove(g.seed.text, g.level, g.moves);
  await pause;
  if (game !== g || g.moves.length !== ply || !thinking || isOver()) return;
  thinking = false;
  if (!text || !playMove(text, { from: "computer" })) update();
}

/* ---- undo ---- */

// How many plies an undo by `side` takes back: to the last point where it
// was that side's turn, which is one ply or two.
function undoPlies(side) {
  const n = g.moves.length;
  if (!n) return 0;
  const lastSide = rec.plies[n - 1].side;
  if (lastSide === side) return 1;
  return n >= 2 ? 2 : 0;
}

function canUndo() {
  if (!g || g.submitted) return false;
  if (g.mode === "local") return g.moves.length > 0;
  if (g.mode === "computer") return thinking || undoPlies(g.firstSide) > 0;
  return net?.connected() && !g.takeback && undoPlies(mySide()) > 0;
}

// Takes back `count` plies, charging the undo to `side`. Shared with network
// takebacks, which the host applies once they are accepted. Time already
// spent stays spent: the clock is not wound back.
export function takeBack(count, side) {
  if (!count) return;
  const marks = [];
  for (let i = 0; i < count; i++) {
    const n = g.moves.length;
    const prev = replayGame(g.seed, g.moves.slice(0, n - 1)).pos;
    const m = moveMarks(prev, g.moves[n - 1]);
    if (m) marks.push({ from: m.to, to: m.from, rookFrom: m.rookTo, rookTo: m.rookFrom });
    g.moves.pop();
  }
  g.undos[side]++;
  g.end = null;
  g.takeback = null;
  // The game is open again: its next ending is a new one to report.
  g.finishSent = false;
  g.elapsed = null;
  if (g.clock.stopped && ownsClock()) g.clock.stopped = null;
  rec = replayGame(g.seed, g.moves);
  syncClock();
  if (g.gameId && (g.mode === "computer" || (g.mode === "network" && side === mySide()))) {
    api.undo(g.gameId, SIDE_LETTER[side]).catch(() => {});
  }
  persist();
  replayer.stop();
  resetResult();
  $("status").dataset.last = count === 1 ? "Took back a move." : "Took back two moves.";
  update({ animate: marks });
  net?.changed();
}

function onUndo() {
  if (!canUndo()) return;
  if (g.mode === "network") {
    net.requestTakeback();
    return;
  }
  if (g.mode === "computer" && thinking) {
    // The computer has not answered yet: take back the move it is answering.
    cancelMove();
    thinking = false;
    takeBack(1, g.firstSide);
    return;
  }
  const side = g.mode === "computer" ? g.firstSide : rec.plies.at(-1).side;
  takeBack(g.mode === "computer" ? undoPlies(side) : 1, side);
}

/* ---- resigning and leaving ---- */

function disarmResign() {
  clearTimeout(resignTimer);
  resignTimer = null;
  $("resignBtn").classList.remove("armed");
  $("resignLabel").textContent = "Resign";
}

// Two taps, so a stray one does not end the game.
function onResign() {
  if (!g || isOver()) return;
  if (!resignTimer) {
    $("resignBtn").classList.add("armed");
    $("resignLabel").textContent = "Tap again to resign";
    resignTimer = setTimeout(disarmResign, 3000);
    return;
  }
  disarmResign();
  if (g.mode === "network" && g.role === "guest") {
    net.resign();
    return;
  }
  resign(g.mode === "local" ? rec.pos.turn : mySide());
}

export function resign(side) {
  if (!g || isOver()) return;
  cancelMove();
  thinking = false;
  g.end = { by: "resign", side };
  syncClock();
  $("status").dataset.last = `${SIDE_NAME[side]} resigned.`;
  persist();
  update();
  net?.changed();
}

function disarmLeave() {
  clearTimeout(leaveTimer);
  leaveTimer = null;
  $("leaveBtn").classList.remove("armed");
}

// Back to choosing a game. A game in progress asks for a second tap.
function onLeave() {
  if (g && !isOver() && g.moves.length > 0 && !leaveTimer) {
    $("leaveBtn").classList.add("armed");
    $("leaveLabel").textContent = g.mode === "network" ? "Tap again to leave" : "Tap again to end this game";
    leaveTimer = setTimeout(() => {
      disarmLeave();
      update();
    }, 3000);
    return;
  }
  disarmLeave();
  if (g?.mode === "network") net?.leave();
  endGame();
}

// Drops the game on screen and shows the setup.
export function endGame() {
  cancelMove();
  thinking = false;
  replayer.stop();
  g = null;
  store.remove(GAME_STORAGE);
  showPanel("setup");
  renderSetup();
}

/* ---- drawing ---- */

function update({ animate = null, fresh = false } = {}) {
  if (!g) return;
  const over = isOver();
  const s = getSettings();

  if (over && !g.wasOver) {
    g.wasOver = true;
    finish(fresh);
  } else if (over) {
    renderSubmit();
  } else {
    g.wasOver = false;
    board.set({
      pos: rec.pos,
      orientation: orientation(),
      interactive: interactiveSide(),
      lastMove: g.moves.length ? moveMarks(replayGame(g.seed, g.moves.slice(0, -1)).pos, g.moves.at(-1)) : null,
      animate,
      showMoves: s.show_moves,
      coords: s.coords,
    });
  }

  const turn = rec.pos.turn;
  $("turnChip").textContent = over ? "Game over" : `${SIDE_NAME[turn]} to move`;
  $("seedChip").textContent = g.seed.text;
  const me = mySide();
  const live = liveScore(rec.plies, me, percent(), g.undos[me]);
  $("scoreChip").textContent = scoring() && !over ? `${live} ${live === 1 ? "point" : "points"}` : "";

  renderPlayers();
  renderClocks();
  renderStatus(over);
  renderActions(over);
  renderTakeback();
}

function sideLabel(side) {
  if (g.mode === "computer") return side === g.firstSide ? "You" : `Computer, ${LEVELS[g.level].name}`;
  if (g.mode === "network") return side === mySide() ? `You, ${SIDE_NAME[side]}` : `Opponent, ${SIDE_NAME[side]}`;
  return SIDE_NAME[side];
}

function renderPlayers() {
  const bottom = orientation();
  rowSides = [bottom, bottom ^ 1];
  const taken = [[], []];
  for (const p of rec.plies) if (p.captured) taken[p.side].push(p.captured);
  const material = (side) => taken[side].reduce((sum, t) => sum + VALUE[t], 0);
  for (const [row, side] of [["bottom", bottom], ["top", bottom ^ 1]]) {
    $(`${row}Name`).textContent = sideLabel(side);
    const lead = material(side) - material(side ^ 1);
    $(`${row}Captured`).innerHTML =
      taken[side]
        .slice()
        .sort((a, b) => a - b)
        .map((t) => typeSvg(t, side ^ 1))
        .join("") + (lead > 0 ? `<span class="lead">+${lead}</span>` : "");
  }
}

function renderStatus(over) {
  const el = $("status");
  const last = el.dataset.last ? `${el.dataset.last} ` : "";
  if (over) {
    el.textContent = last;
    return;
  }
  const check = rec.pos.inCheck() ? "Check. " : "";
  let now;
  if (g.mode === "computer") now = thinking ? "The computer is thinking." : "Your move.";
  else if (g.mode === "network") {
    if (!net?.connected()) now = "Waiting for your opponent to reconnect.";
    else now = rec.pos.turn === mySide() ? "Your move." : "Waiting for your opponent.";
  } else now = `${SIDE_NAME[rec.pos.turn]} to move.`;
  el.textContent = `${last}${check}${now}`;
}

function renderActions(over) {
  // A submitted game cannot be undone. A network game keeps the row anyway,
  // for its way out of the session.
  $("liveActions").classList.toggle("hidden", over && g.submitted && g.mode !== "network");
  $("undoBtn").classList.toggle("hidden", g.submitted);
  $("undoBtn").disabled = !canUndo();
  $("undoLabel").textContent = g.mode === "network" ? "Ask to undo" : "Undo";
  $("resignBtn").classList.toggle("hidden", over);
  $("flipBtn").classList.toggle("hidden", over);
  // Once it is over the result has its own buttons; a network game keeps
  // its way out of the session here.
  $("leaveBtn").classList.toggle("hidden", over && g.mode !== "network");
  if (!leaveTimer) {
    $("leaveLabel").textContent = g.mode === "network" ? (g.role === "host" ? "Stop hosting" : "Leave") : "New game";
  }

  let note = "";
  if (g.mode === "computer") {
    note = `Undo as often as you like. Each one takes ${Math.floor((UNDO_COST * percent()) / 100)} points off this game's score.`;
  } else if (g.mode === "network") {
    note = "Undo asks your opponent to take your last move back. Each one they accept costs you points.";
  }
  if (g.time) note += " Undo does not give time back.";
  if (g.ticket === "offline" && scoring()) note += " This game started offline, so it is not scored.";
  const undone = g.undos[mySide()];
  if (scoring() && undone) note += ` Undos so far: ${undone}.`;
  $("undoNote").textContent = note.trim();
}

function renderTakeback() {
  const box = $("takeback");
  const pending = g.mode === "network" ? g.takeback : null;
  if (!pending || isOver()) {
    box.classList.add("hidden");
    return;
  }
  const mine = pending.by === mySide();
  box.classList.remove("hidden");
  $("takebackText").textContent = mine
    ? "Asked your opponent to take back your last move."
    : "Your opponent asks to take back their last move.";
  $("takebackYes").classList.toggle("hidden", mine);
  $("takebackNo").textContent = mine ? "Cancel" : "Decline";
}

function showPanel(name) {
  for (const id of ["setup", "net", "play"]) $(id).classList.toggle("hidden", id !== name);
}

/* ---- the end ---- */

const REASONS = {
  checkmate: "By checkmate.",
  stalemate: "Stalemate: no legal move, and not in check.",
  material: "Neither side has enough left to checkmate.",
  fifty: "Fifty moves each without a capture or a pawn move.",
  repetition: "The same position came up three times.",
};

function reasonText(o, end) {
  switch (o.reason) {
    case "resign":
      return `${SIDE_NAME[end.side]} resigned.`;
    case "flag":
      return `${SIDE_NAME[end.side]} ran out of time.`;
    case "flag-draw":
      return `${SIDE_NAME[end.side]} ran out of time, but the other side could never checkmate.`;
    case "timeup":
      return o.winner === -1 ? "The game clock ran out with material level." : "The game clock ran out, and more material wins.";
    case "unfinished":
      return "The game stops here.";
    default:
      return REASONS[o.reason] ?? "";
  }
}

function resetResult() {
  // A takeback reopens the game, and its next ending gets a fresh try.
  if (g) g.submitRefused = false;
  $("result").classList.add("hidden");
  $("replayBar").classList.add("hidden");
  $("submitted").classList.add("hidden");
  $("submitMsg").textContent = "";
}

// How long the game took: the server's figure once it has one, this
// device's until then.
function elapsed() {
  if (g.elapsed != null) return g.elapsed;
  return (g.clock.stopped ?? Date.now()) - g.startedAt;
}

function renderScoreLine() {
  const me = mySide();
  const result = resultFor(outcome().winner, me);
  const took = `Took ${formatTaken(elapsed())}`;
  if (!scoring()) {
    $("resultScore").textContent = `${took}.`;
    return;
  }
  const bonus = timeBonus(result, elapsed(), g.serverSeed);
  const score = finalScore(rec.plies, me, result, percent(), g.undos[me], bonus);
  const parts = [`${score} ${score === 1 ? "point" : "points"}`];
  if (bonus) parts.push(`+${bonus}% for time`);
  if (g.undos[me]) parts.push(`${g.undos[me]} undo${g.undos[me] === 1 ? "" : "s"}`);
  let line = `${parts.join(", ")}. ${took}.`;
  if ((result === "win" || result === "draw") && !g.serverSeed && g.gameId) {
    line += ` No time bonus: the seed was chosen, not picked by the server.`;
  } else if ((result === "win" || result === "draw") && !bonus && g.serverSeed) {
    line += ` Up to +${TIME_BONUS_MAX}% for finishing within 30 minutes.`;
  }
  $("resultScore").textContent = line;
}

function finish(fresh) {
  const o = outcome();
  const me = mySide();
  const result = resultFor(o.winner, me);
  const s = getSettings();

  let title;
  if (g.mode === "local") title = o.winner === -1 ? "Draw" : `${SIDE_NAME[o.winner]} wins`;
  else if (g.mode === "computer") title = result === "win" ? "You won" : result === "draw" ? "Draw" : "The computer won";
  else title = result === "win" ? "You won" : result === "draw" ? "Draw" : "You lost";
  $("resultTitle").textContent = title;
  $("resultReason").textContent = reasonText(o, g.end);

  renderScoreLine();
  $("resultSeed").textContent = `Seed ${g.seed.text}`;
  $("copySeedLabel").textContent = "Copy seed";
  $("shareLabel").textContent = "Share replay";

  $("nameInput").value = s.name ?? "";
  $("submitBtn").disabled = false;
  g.autoTried = fresh;
  renderSubmit();

  const guest = g.mode === "network" && g.role === "guest";
  $("againBtn").classList.toggle("hidden", guest);
  $("againLabel").textContent = g.mode === "network" ? "Next game" : "Play again";
  $("newGameBtn").classList.toggle("hidden", g.mode === "network");
  $("newGameLabel").textContent = "New game";

  $("result").classList.remove("hidden");
  $("replayBar").classList.remove("hidden");
  hydrateIcons($("play"));
  replayer.load(g.seed, g.moves, { orientation: orientation(), coords: s.coords }, { autoplay: !fresh && s.auto_replay });
  if (!fresh) $("resultTitle").focus({ preventScroll: true });

  // A win as it happens, not on a reload of one. On a shared device somebody
  // at the screen has always won unless it was a draw.
  const won = g.mode === "local" ? o.winner !== -1 : result === "win";
  if (won && !fresh) confetti();
}

// An end claim as the API takes it: sides as "w" or "b".
function wireEnd(end) {
  if (!end) return null;
  return end.by === "timeup" ? { by: "timeup" } : { by: end.by, side: SIDE_LETTER[end.side] };
}

// Tells the server the game is over, the moment it is, so its clock stops
// there. Tried again when the connection comes back.
async function reportFinish(game) {
  if (!game.gameId || game.finishSent || game !== g || !isOver() || !game.moves.length) return;
  game.finishSent = true;
  try {
    const r = await api.finish({ game_id: game.gameId, moves: game.moves, end: wireEnd(game.end) });
    game.elapsed = r.elapsed_ms;
    game.serverSeed = r.server_seed === true;
    if (game === g) {
      persist();
      if (isOver()) renderScoreLine();
    }
  } catch (err) {
    if (err.code !== "offline") return;
    game.finishSent = false;
    window.addEventListener("online", () => reportFinish(game), { once: true });
  }
}

// The leaderboard part of the result. Redrawn on every update while the game
// is over, because the start ticket can arrive after the game has ended: the
// host's check-in can be slow, and the guest only learns of it from the
// host's next snapshot. Either player then gets the form as soon as it does.
function renderSubmit() {
  reportFinish(g);
  const canSubmit = Boolean(scoring() && g.gameId && !g.submitted && g.moves.length);
  $("submitForm").classList.toggle("hidden", !canSubmit || g.submitRefused);
  let why = "";
  if (g.mode === "local") why = "Games on one device are not scored.";
  else if (!g.moves.length) why = "A game needs at least one move to go on the leaderboard.";
  else if (!g.gameId) {
    why =
      g.ticket === "pending"
        ? "Still checking in with the leaderboard."
        : g.mode === "network" && g.role === "guest"
          ? "The host's device could not reach the leaderboard, so this game is not scored."
          : "This game started without a connection, so it cannot go on the leaderboard.";
  }
  $("notScored").textContent = why;
  $("notScored").classList.toggle("hidden", !why);
  // Saved with the game, so a reload shows it again rather than an empty
  // box with a tick in it. Games saved before it was kept get the short form.
  $("submittedText").textContent = g.submittedText || "This game is on the leaderboard.";
  $("submitted").classList.toggle("hidden", !g.submitted);

  const s = getSettings();
  if (canSubmit && !g.autoTried && s.auto_submit && s.name) {
    g.autoTried = true;
    submitAs(s.name, true);
  }
}

async function submitAs(name, auto = false) {
  const msg = $("submitMsg");
  const game = g;
  $("submitBtn").disabled = true;
  msg.textContent = auto ? `Adding as ${name}.` : "Checking the game.";
  const me = mySide();
  try {
    const r = await api.submit({
      game_id: game.gameId,
      name,
      side: SIDE_LETTER[me],
      moves: game.moves,
      end: wireEnd(game.end),
      undos: game.undos[me],
    });
    if (game !== g) return;
    saveSettings({ name: r.name });
    g.submitted = true;
    g.elapsed = r.elapsed_ms;
    persist();
    renderScoreLine();
    const games = r.games === 1 ? "1 game" : `${r.games} games`;
    const bonus = r.time_bonus ? `, with +${r.time_bonus}% for time` : "";
    g.submittedText =
      `Added as ${r.name} for ${r.score} points${bonus}. Best ${r.best_score}, ranked ${r.rank}. ` +
      `Total ${r.total} over ${games}, ranked ${r.total_rank}.`;
    persist();
    $("submittedText").textContent = g.submittedText;
    $("submitForm").classList.add("hidden");
    $("submitted").classList.remove("hidden");
    msg.textContent = "";
    update();
  } catch (err) {
    if (game !== g) return;
    if (err.code === "offline") msg.textContent = "No connection. Try again once you are back online.";
    else if (auto && err.status === 400) msg.textContent = "Your saved name was refused, so this game was not added. Change it in Settings.";
    else msg.textContent = err.message || "That did not go through. Try again in a moment.";
    const final = [
      "already_submitted",
      "expired",
      "too_fast",
      "overlap",
      "seed_used",
      "not_yours",
      "same_device",
      "not_computer",
      "illegal",
      "mismatch",
      "clock",
      "over_time",
    ];
    if (final.includes(err.code)) {
      g.submitRefused = true;
      $("submitForm").classList.add("hidden");
    } else $("submitBtn").disabled = false;
  }
}

function onSubmit(event) {
  event.preventDefault();
  const name = $("nameInput").value.trim();
  if (!name) {
    $("submitMsg").textContent = "Enter a name.";
    $("nameInput").focus();
    return;
  }
  submitAs(name);
}

/* ---- sharing a replay ----
   A replay link holds the whole game: the seed, the moves packed one byte
   each (record.js), who played, and how it ended if not on the board.
   Nothing is stored anywhere, so a link works for as long as the site does,
   offline too. It carries no score: anyone can edit a link, and only the
   leaderboard's score is checked. */

// "c3w": against the computer at level 3, the player White. "l": two
// people on one device. "n": a network game.
function metaFor(game) {
  if (game.mode === "computer") return `c${game.level}${SIDE_LETTER[game.firstSide]}`;
  return game.mode === "network" ? "n" : "l";
}

function readMeta(text) {
  const m = /^(?:c([1-5])([wb])|(l)|(n))$/.exec(text ?? "");
  if (!m) return { mode: "local" };
  if (m[1]) return { mode: "computer", level: Number(m[1]), side: m[2] === "w" ? WHITE : BLACK };
  return { mode: m[3] ? "local" : "network" };
}

// An ending in a link: "rw" White resigned, "fb" Black ran out of time,
// "t" the game clock ran out.
function endToLink(end) {
  if (!end) return null;
  return end.by === "timeup" ? "t" : `${end.by[0]}${SIDE_LETTER[end.side]}`;
}

function endFromLink(text) {
  const m = /^(?:([rf])([wb])|(t))$/.exec(text ?? "");
  if (!m) return null;
  if (m[3]) return { by: "timeup" };
  return { by: m[1] === "r" ? "resign" : "flag", side: m[2] === "w" ? WHITE : BLACK };
}

function replayLink(seed, moves, end, meta) {
  const params = new URLSearchParams({ watch: packMoves(seed, moves), seed: seed.text, game: meta });
  const e = endToLink(end);
  if (e) params.set("end", e);
  return `${location.origin}/?${params}`;
}

async function onShare() {
  const src = watching ?? (g && { seed: g.seed, moves: g.moves, end: g.end, meta: metaFor(g) });
  if (!src) return;
  const url = replayLink(src.seed, src.moves, src.end, src.meta);
  const label = $("shareLabel");
  if (navigator.share) {
    try {
      await navigator.share({ title: "Chess Game replay", text: `Watch this game of chess, seed ${src.seed.text}.`, url });
      label.textContent = "Shared";
      return;
    } catch (err) {
      // Dismissed: nothing to say. Refused or unsupported here: copy instead.
      if (err?.name === "AbortError") return;
    }
  }
  label.textContent = (await copyText(url)) ? "Link copied" : "Copy failed";
}

// Reads a replay link's parameters. Returns what to watch, { damaged: true }
// if the link is broken, or null if this is not a replay link.
export function readReplayLink(params) {
  if (!params.has("watch")) return null;
  const seed = parseSeed(params.get("seed"));
  const moves = seed && unpackMoves(seed, params.get("watch"));
  if (!moves) return { damaged: true };
  return { seed, moves, end: endFromLink(params.get("end")), meta: params.get("game") ?? "l" };
}

function watch(link) {
  cancelMove();
  thinking = false;
  g = null;
  watching = link;
  const meta = readMeta(link.meta);
  const record = replayGame(link.seed, link.moves);
  // A claimed ending only stands if the board had not already ended it.
  if (record.outcome) watching.end = null;
  const o = outcomeWith(record, watching.end) ?? { reason: "unfinished", winner: -1 };

  showPanel("play");
  resetResult();
  for (const id of ["liveActions", "netBar", "takeback", "submitForm", "notScored", "submitted"]) $(id).classList.add("hidden");
  for (const id of ["gameClock", "topClock", "bottomClock"]) $(id).textContent = "";
  $("undoNote").textContent = "";
  $("status").dataset.last = "";
  $("status").textContent = "A shared replay.";
  $("turnChip").textContent = "Replay";
  $("scoreChip").textContent = "";
  $("seedChip").textContent = link.seed.text;

  const who = (side) => {
    if (meta.mode === "computer") return side === meta.side ? `Player, ${SIDE_NAME[side]}` : `Computer, ${LEVELS[meta.level].name}`;
    return SIDE_NAME[side];
  };
  const bottom = meta.mode === "computer" ? meta.side : WHITE;
  $("bottomName").textContent = who(bottom);
  $("topName").textContent = who(bottom ^ 1);
  $("bottomCaptured").innerHTML = "";
  $("topCaptured").innerHTML = "";

  if (o.reason === "unfinished") $("resultTitle").textContent = "Unfinished game";
  else if (o.winner === -1) $("resultTitle").textContent = "Draw";
  else if (meta.mode === "computer") $("resultTitle").textContent = o.winner === meta.side ? "The player won" : "The computer won";
  else $("resultTitle").textContent = `${SIDE_NAME[o.winner]} won`;
  $("resultReason").textContent = reasonText(o, watching.end);
  $("resultScore").textContent =
    meta.mode === "computer"
      ? `Against the computer at ${LEVELS[meta.level].name} level.`
      : meta.mode === "network"
        ? "Played over the network."
        : "Two players on one device.";
  $("resultSeed").textContent = `Seed ${link.seed.text}`;
  $("copySeedLabel").textContent = "Copy seed";
  $("shareLabel").textContent = "Share replay";
  $("againBtn").classList.remove("hidden");
  $("againLabel").textContent = "Play this seed";
  $("newGameBtn").classList.remove("hidden");
  $("newGameLabel").textContent = "Close replay";

  $("result").classList.remove("hidden");
  $("replayBar").classList.remove("hidden");
  hydrateIcons($("play"));
  replayer.load(link.seed, link.moves, { orientation: bottom, coords: getSettings().coords }, { autoplay: true });
}

// Leaves a shared replay: the address loses the link, and the page goes
// back to the game this browser had going, or to choosing one.
function closeWatch({ show = true } = {}) {
  watching = null;
  replayer.stop();
  const params = new URLSearchParams(location.search);
  for (const key of ["watch", "seed", "game", "end"]) params.delete(key);
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
  if (show && !resume()) {
    showPanel("setup");
    renderSetup();
  }
}

// "Play this seed": the new-game screen with the seed filled in, and the
// replay's kind of game chosen where it can be.
function playWatchedSeed() {
  const { seed, meta: text } = watching;
  const meta = readMeta(text);
  closeWatch({ show: false });
  if (meta.mode === "computer") {
    setup.mode = "computer";
    setup.level = meta.level;
    setup.side = SIDE_LETTER[meta.side];
  } else if (meta.mode === "local") {
    setup.mode = "local";
  }
  setup.variant = seed.variant;
  saveSetup();
  $("seedInput").value = seed.text;
  showPanel("setup");
  renderSetup();
  $("startBtn").focus();
}

function onAgain() {
  if (watching) return playWatchedSeed();
  if (!g || launching) return;
  if (g.mode === "network") {
    net?.nextGame();
    return;
  }
  // A fresh seed, picked by the server where it can be.
  launch({
    mode: g.mode,
    seed: null,
    variant: g.seed.variant,
    level: g.level,
    sideChoice: g.sideChoice,
    time: g.time,
  });
}

/* ---- saving ---- */

function persist() {
  if (!g || g.mode === "network") return;
  store.set(GAME_STORAGE, {
    mode: g.mode,
    seed: g.seed.text,
    level: g.level,
    sideChoice: g.sideChoice,
    firstSide: g.firstSide,
    moves: g.moves,
    undos: g.undos,
    end: g.end,
    gameId: g.gameId,
    ticket: g.ticket === "pending" ? "offline" : g.ticket,
    serverSeed: g.serverSeed,
    submitted: g.submitted,
    submittedText: g.submittedText ?? null,
    time: g.time,
    clock: g.clock,
    startedAt: g.startedAt,
    elapsed: g.elapsed,
  });
}

function savedClock(c) {
  const t = (x) => Number.isFinite(x) && x > 0;
  const ok =
    c &&
    Array.isArray(c.used) &&
    c.used.length === 2 &&
    c.used.every((n) => Number.isFinite(n) && n >= 0) &&
    [-1, 0, 1].includes(c.running) &&
    (c.since === null || t(c.since)) &&
    t(c.start) &&
    (c.stopped === null || t(c.stopped));
  return ok ? { used: c.used.slice(), running: c.running, since: c.since, start: c.start, stopped: c.stopped } : null;
}

function resume() {
  const saved = store.getJSON(GAME_STORAGE);
  const seed = parseSeed(saved?.seed);
  if (!saved || !seed || !["computer", "local"].includes(saved.mode) || !Array.isArray(saved.moves)) return false;
  const time = validTime(saved.time ?? null) ? saved.time ?? null : null;
  const clock = savedClock(saved.clock);
  startGame({
    mode: saved.mode,
    seed,
    level: saved.level,
    sideChoice: saved.sideChoice,
    firstSide: saved.firstSide === 1 ? 1 : 0,
    moves: saved.moves.filter((m) => typeof m === "string"),
    undos: Array.isArray(saved.undos) ? saved.undos.map((n) => Number(n) || 0) : [0, 0],
    end: validEnd(saved.end ?? null) ? saved.end ?? null : null,
    gameId: typeof saved.gameId === "string" ? saved.gameId : null,
    ticket: saved.gameId ? "ok" : saved.mode === "local" ? "none" : "offline",
    serverSeed: saved.serverSeed === true,
    submitted: saved.submitted === true,
    submittedText: typeof saved.submittedText === "string" ? saved.submittedText : null,
    time: time && clock ? time : null,
    clock: time && clock ? clock : undefined,
    startedAt: Number.isFinite(saved.startedAt) ? saved.startedAt : Date.now(),
    elapsed: Number.isFinite(saved.elapsed) ? saved.elapsed : null,
  });
  return true;
}

/* ---- for multiplayer.js ---- */

// The network session plugs in here; see multiplayer.js.
export function setNet(adapter) {
  net = adapter;
}

export function current() {
  return g;
}

export function state() {
  return { rec, over: g ? isOver() : false, mySide: g ? mySide() : 0 };
}

export function refresh() {
  update();
}

export function setTakeback(value) {
  if (!g) return;
  g.takeback = value;
  update();
}

// Replaces the game with a snapshot from the host. Animates a single move
// forward or a takeback; anything else redraws.
export function loadSnapshot(snap) {
  const seed = parseSeed(snap.seed);
  if (!seed) return;
  const now = Date.now();
  const clock = snap.time ? clockFromWire(snap.clock, now) : undefined;
  const same = g && g.mode === "network" && g.role === "guest" && g.netGame === snap.game && g.seed.text === seed.text;
  if (!same) {
    startGame({
      mode: "network",
      role: "guest",
      seed,
      firstSide: snap.firstSide,
      moves: snap.moves,
      undos: snap.undos,
      end: snap.end,
      gameId: snap.gameId,
      ticket: snap.gameId ? "ok" : "none",
      serverSeed: snap.serverSeed,
      time: snap.time,
      clock,
      // Near enough for "Took"; the server's figure replaces it.
      startedAt: clock ? clock.start : now,
    });
    g.netGame = snap.game;
    g.takeback = snap.takeback;
    update({ fresh: true });
    return;
  }
  const old = g.moves;
  const next = snap.moves;
  const extends1 = next.length === old.length + 1 && old.every((m, i) => m === next[i]);
  const myUndosBefore = g.undos[mySide()];
  const wasOver = isOver();
  const shown = () => JSON.stringify([g.gameId, g.serverSeed, g.takeback, g.end, g.undos, g.time]);
  const before = shown();
  g.gameId = snap.gameId;
  if (snap.gameId) g.ticket = "ok";
  g.serverSeed = snap.serverSeed;
  g.takeback = snap.takeback;
  g.end = snap.end;
  g.undos = snap.undos.slice();
  g.time = snap.time;
  if (clock) g.clock = clock;

  if (extends1) {
    const marks = moveMarks(rec.pos, next.at(-1));
    g.moves = next.slice();
    rec = replayGame(g.seed, g.moves);
    const ply = rec.plies.at(-1);
    announce(ply, ply.side === mySide() ? "board" : "network");
    update({ animate: marks });
  } else if (next.length < old.length && next.every((m, i) => m === old[i])) {
    const marks = [];
    for (let n = old.length; n > next.length; n--) {
      const prev = replayGame(g.seed, old.slice(0, n - 1)).pos;
      const m = moveMarks(prev, old[n - 1]);
      if (m) marks.push({ from: m.to, to: m.from, rookFrom: m.rookTo, rookTo: m.rookFrom });
    }
    g.moves = next.slice();
    rec = replayGame(g.seed, g.moves);
    g.finishSent = false;
    g.elapsed = null;
    replayer.stop();
    resetResult();
    $("status").dataset.last = "A move was taken back.";
    update({ animate: marks });
  } else if (old.join(" ") !== next.join(" ") || (wasOver && !isOver())) {
    g.moves = next.slice();
    rec = replayGame(g.seed, g.moves);
    replayer.stop();
    resetResult();
    update();
  } else if (shown() === before) {
    // Most snapshots, at 20 a second: only the clock moved. A redraw would
    // cut short a move sliding in, a drag, or the promotion picker.
    renderClocks();
  } else {
    if (!wasOver && isOver() && g.end) {
      $("status").dataset.last =
        g.end.by === "resign"
          ? `${SIDE_NAME[g.end.side]} resigned.`
          : g.end.by === "flag"
            ? `${SIDE_NAME[g.end.side]} ran out of time.`
            : "The game clock ran out.";
    }
    update();
  }
  // Our own accepted undos, counted on the server from this browser.
  if (g.gameId && g.undos[mySide()] > myUndosBefore) {
    for (let i = myUndosBefore; i < g.undos[mySide()]; i++) api.undo(g.gameId, SIDE_LETTER[mySide()]).catch(() => {});
  }
}

export function snapshot() {
  return {
    type: "state",
    v: 1,
    game: g.netGame,
    seed: g.seed.text,
    firstSide: g.firstSide,
    gameId: g.gameId,
    serverSeed: g.serverSeed,
    moves: g.moves,
    end: g.end,
    undos: g.undos,
    takeback: g.takeback,
    time: g.time,
    clock: g.time ? clockToWire(g.clock, Date.now()) : null,
  };
}

export { undoPlies, isOver, showPanel, renderSetup };

/* ---- wiring ---- */

function buildLevelPick() {
  $("levelPick").innerHTML = LEVELS.slice(1)
    .map(
      (l, i) =>
        `<button class="level-btn" type="button" role="radio" aria-checked="false" data-level="${i + 1}"><b>${i + 1}</b><small>${l.name}</small></button>`
    )
    .join("");
}

// A radio group in the setup: clicking a button sets `key` from its data.
function pick(id, attr, key, parse = (v) => v) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest(`[data-${attr}]`);
    if (!b) return;
    setup[key] = parse(b.dataset[attr]);
    saveSetup();
    renderSetup();
    if (key === "time" && setup.time === "custom") $("customMinutes").focus();
  });
}

export function initGame({ joinCode, replayLink: shared } = {}) {
  board = new BoardView($("board"), { onMove: (text) => onBoardMove(text) });
  replayer = new Replay(board);
  loadSetup();
  buildLevelPick();

  pick("modePick", "pick", "mode");
  pick("levelPick", "level", "level", Number);
  pick("sidePick", "side", "side");
  pick("variantPick", "variant", "variant");
  pick("timePick", "time", "time", (v) => (v === "custom" ? "custom" : Number(v)));
  pick("timeSplitPick", "split", "split");
  $("customMinutes").addEventListener("input", (e) => {
    const n = Number(e.target.value);
    if (Number.isInteger(n) && n >= MIN_MINUTES && n <= MAX_MINUTES) {
      setup.custom = n;
      saveSetup();
    }
    $("timeNote").textContent = timeNote();
  });
  $("customMinutes").addEventListener("blur", renderSetup);

  $("seedInput").addEventListener("input", () => {
    $("seedNote").textContent = "Leave it empty for a new game, or paste a seed to play that start again.";
    // A pasted seed says its own start position.
    const raw = $("seedInput").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const prefix = raw.match(/^(960|STD)/)?.[1];
    if (prefix && prefix !== setup.variant) {
      setup.variant = prefix;
      renderSetup();
    }
  });
  $("seedInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onStart();
  });
  $("seedClear").addEventListener("click", () => {
    $("seedInput").value = "";
    $("seedInput").focus();
  });
  $("startBtn").addEventListener("click", onStart);

  $("undoBtn").addEventListener("click", onUndo);
  $("flipBtn").addEventListener("click", () => {
    if (!g) return;
    g.flipped = !g.flipped;
    update();
  });
  $("resignBtn").addEventListener("click", onResign);
  $("leaveBtn").addEventListener("click", onLeave);
  $("takebackYes").addEventListener("click", () => net?.answerTakeback(true));
  $("takebackNo").addEventListener("click", () => net?.answerTakeback(false));

  $("submitForm").addEventListener("submit", onSubmit);
  $("againBtn").addEventListener("click", onAgain);
  $("newGameBtn").addEventListener("click", () => (watching ? closeWatch() : endGame()));
  $("resultBoardBtn").addEventListener("click", () => openLeaderboard());
  $("shareBtn").addEventListener("click", onShare);
  const shownSeed = () => (watching ?? g)?.seed;
  $("copySeedBtn").addEventListener("click", async () => {
    const seed = shownSeed();
    if (!seed) return;
    $("copySeedLabel").textContent = (await copyText(seed.text)) ? "Copied" : "Copy failed";
  });
  $("seedChip").addEventListener("click", async () => {
    const seed = shownSeed();
    if (!seed) return;
    const chip = $("seedChip");
    const ok = await copyText(seed.text);
    chip.textContent = ok ? "Seed copied" : seed.text;
    setTimeout(() => shownSeed() && (chip.textContent = shownSeed().text), 1200);
  });

  onSettingsChange(() => {
    if (watching || (g && isOver())) {
      replayer.view.coords = getSettings().coords;
      replayer.show(replayer.index, null);
      return;
    }
    update();
  });

  // Clocks tick five times a second; a hidden tab is caught up when it is
  // shown again, and a clock that ran out meanwhile ends the game then.
  setInterval(tickClock, 200);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tickClock();
  });

  renderSetup();
  if (shared && !shared.damaged) {
    watch(shared);
    return;
  }
  if (joinCode) {
    setup.mode = "network";
    renderSetup();
    showPanel("setup");
    return;
  }
  // A broken replay link is dropped from the address, and said so on the
  // new-game screen when that is where the page lands.
  if (shared?.damaged) {
    closeWatch({ show: false });
    $("seedNote").textContent = "That replay link is damaged or incomplete, so it cannot be played back.";
  }
  if (!resume()) showPanel("setup");
}

function onBoardMove(text) {
  if (!g) return;
  if (g.mode === "network" && g.role === "guest") {
    net?.sendMove(text);
    return;
  }
  playMove(text);
}
