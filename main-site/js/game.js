// The game screen: choosing a game, playing it, and what happens after.
//
// A game is a seed and a list of moves, and everything on screen is derived
// from those two by replaying them. That is also all that is saved, sent to
// the other device in a network game, and submitted to the leaderboard,
// where the API replays it the same way.

import { WHITE, BLACK } from "./chess.js";
import { BoardView, moveMarks } from "./board.js";
import { replay as replayGame, packMoves, unpackMoves } from "./record.js";
import { newSeed, parseSeed } from "./seed.js";
import { LEVELS } from "./ai.js";
import { requestMove, cancelMove } from "./computer.js";
import { finalScore, liveScore, percentFor, resultFor, UNDO_COST } from "./score.js";
import { api } from "./api.js";
import { getSettings, onSettingsChange, saveSettings } from "./settings.js";
import { openLeaderboard } from "./leaderboard.js";
import { typeSvg } from "./pieces.js";
import { Replay } from "./replay.js";
import { copyText, hydrateIcons, store } from "./ui.js";

const GAME_STORAGE = "uwuchess.game";
const SETUP_STORAGE = "uwuchess.setup";
const SIDE_NAME = ["White", "Black"];
const SIDE_LETTER = ["w", "b"];
const VALUE = [0, 1, 3, 3, 5, 9, 0];

const $ = (id) => document.getElementById(id);

let board = null;
let replayer = null;
let g = null; // the game on screen, or null
let rec = null; // replayGame(g.seed, g.moves), refreshed on every change
let thinking = false;
let gameCounter = 0;
let resignTimer = null;
let leaveTimer = null;
let net = null; // set by multiplayer.js for network games
let watching = null; // a shared replay being watched: { seed, moves, resigned, meta }

/* ---- setup ---- */

const setup = { mode: "computer", level: 3, side: "seed", variant: "960" };

function loadSetup() {
  const saved = store.getJSON(SETUP_STORAGE) ?? {};
  if (["computer", "local", "network"].includes(saved.mode)) setup.mode = saved.mode;
  if (Number.isInteger(saved.level) && saved.level >= 1 && saved.level <= 5) setup.level = saved.level;
  if (["w", "b", "seed"].includes(saved.side)) setup.side = saved.side;
  if (["960", "STD"].includes(saved.variant)) setup.variant = saved.variant;
}

function saveSetup() {
  store.set(SETUP_STORAGE, setup);
}

const MODE_NOTES = {
  computer: "Scored on the leaderboard when the game starts while you are online.",
  local: "Two players taking turns on this device. Not scored.",
  network: "Play someone on the same wifi, or sharing a hotspot. Scored when started online.",
};

function renderSetup() {
  document.querySelectorAll("#modePick [data-pick]").forEach((el) => {
    el.setAttribute("aria-checked", String(el.dataset.pick === setup.mode));
  });
  document.querySelectorAll("#levelPick [data-level]").forEach((el) => {
    el.setAttribute("aria-checked", String(Number(el.dataset.level) === setup.level));
  });
  document.querySelectorAll("#sidePick [data-side]").forEach((el) => {
    el.setAttribute("aria-checked", String(el.dataset.side === setup.side));
  });
  document.querySelectorAll("#variantPick [data-variant]").forEach((el) => {
    el.setAttribute("aria-checked", String(el.dataset.variant === setup.variant));
  });
  $("levelGroup").classList.toggle("hidden", setup.mode !== "computer");
  $("sideGroup").classList.toggle("hidden", setup.mode === "local");
  $("sideLabel").textContent = setup.mode === "network" ? "Host plays as" : "Play as";
  $("joinForm").classList.toggle("hidden", setup.mode !== "network");
  $("startLabel").textContent = setup.mode === "network" ? "Host a game" : "Start game";
  $("modeNote").textContent = MODE_NOTES[setup.mode];
}

// What the seed field holds, as a seed, or null if it cannot be one. Eight
// characters with no prefix take the start position chosen above.
function seedFromField() {
  const raw = $("seedInput").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!raw) return newSeed(setup.variant);
  return /^(960|STD)/.test(raw) ? parseSeed(raw) : parseSeed(setup.variant + raw);
}

function badSeed() {
  const input = $("seedInput");
  $("seedNote").textContent = "That is not a seed. Seeds look like 960-BXK4-M9TR.";
  input.classList.remove("shake");
  void input.offsetWidth;
  input.classList.add("shake");
  input.focus();
}

function onStart() {
  const seed = seedFromField();
  if (!seed) return badSeed();
  if (setup.mode === "network") {
    net?.host({ seed, side: setup.side });
    return;
  }
  startGame({
    mode: setup.mode,
    seed,
    level: setup.level,
    sideChoice: setup.mode === "local" ? null : setup.side === "seed" ? null : setup.side,
  });
}

/* ---- the game ---- */

// opts: { mode, seed, level?, sideChoice ("w" | "b" | null), role?,
// firstSide?, gameId?, moves?, undos?, resigned?, submitted?, ticket? }
export function startGame(opts) {
  cancelMove();
  thinking = false;
  replayer.stop();
  if (watching) closeWatch({ show: false });
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
    resigned: opts.resigned ?? null,
    gameId: opts.gameId ?? null,
    ticket: opts.ticket ?? (opts.mode === "local" || opts.role === "guest" ? "none" : "pending"),
    submitted: opts.submitted ?? false,
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

async function fetchTicket(game) {
  try {
    const t = await api.start({
      mode: game.mode,
      seed: game.seed.text,
      difficulty: game.level ?? undefined,
      side: SIDE_LETTER[game.firstSide],
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
  return Boolean(g && (g.resigned !== null || rec.outcome));
}

// The outcome, counting a resignation: { result, reason, winner }.
function outcome() {
  if (g.resigned !== null) {
    const winner = g.resigned ^ 1;
    return { result: winner === WHITE ? "1-0" : "0-1", reason: "resign", winner };
  }
  return rec.outcome;
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

// Plays a move, from the board, the computer or the network. Returns false
// if it is not legal here and now.
export function playMove(text, { from = "board" } = {}) {
  if (!g || isOver()) return false;
  const before = rec.pos;
  const marks = moveMarks(before, text);
  if (!marks) return false;
  g.moves.push(text);
  rec = replayGame(g.seed, g.moves);
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
  if (game !== g || g.moves.length !== ply || !thinking) return;
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
// takebacks, which the host applies once they are accepted.
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
  g.resigned = null;
  g.takeback = null;
  rec = replayGame(g.seed, g.moves);
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
  g.resigned = side;
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

function resetResult() {
  // A takeback reopens the game, and its next ending gets a fresh try.
  if (g) g.submitRefused = false;
  $("result").classList.add("hidden");
  $("replayBar").classList.add("hidden");
  $("submitted").classList.add("hidden");
  $("submitMsg").textContent = "";
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
  $("resultReason").textContent = o.reason === "resign" ? `${SIDE_NAME[g.resigned]} resigned.` : REASONS[o.reason];

  const score = finalScore(rec.plies, me, result, percent(), g.undos[me]);
  $("resultScore").textContent = scoring() ? `${score} ${score === 1 ? "point" : "points"}${g.undos[me] ? `, after ${g.undos[me]} undo${g.undos[me] === 1 ? "" : "s"}` : ""}.` : "";
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
}

// The leaderboard part of the result. Redrawn on every update while the game
// is over, because the start ticket can arrive after the game has ended: the
// host's check-in can be slow, and the guest only learns of it from the
// host's next snapshot. Either player then gets the form as soon as it does.
function renderSubmit() {
  const canSubmit = Boolean(scoring() && g.gameId && !g.submitted);
  $("submitForm").classList.toggle("hidden", !canSubmit || g.submitRefused);
  let why = "";
  if (g.mode === "local") why = "Games on one device are not scored.";
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
      resigned: game.resigned === null ? null : SIDE_LETTER[game.resigned],
      undos: game.undos[me],
    });
    if (game !== g) return;
    saveSettings({ name: r.name });
    g.submitted = true;
    persist();
    const games = r.games === 1 ? "1 game" : `${r.games} games`;
    $("submittedText").textContent =
      `Added as ${r.name} for ${r.score} points. Best ${r.best_score}, ranked ${r.rank}. ` +
      `Total ${r.total} over ${games}, ranked ${r.total_rank}.`;
    $("submitForm").classList.add("hidden");
    $("submitted").classList.remove("hidden");
    msg.textContent = "";
    update();
  } catch (err) {
    if (game !== g) return;
    if (err.code === "offline") msg.textContent = "No connection. Try again once you are back online.";
    else if (auto && err.status === 400) msg.textContent = "Your saved name was refused, so this game was not added. Change it in Settings.";
    else msg.textContent = err.message || "That did not go through. Try again in a moment.";
    const final = ["already_submitted", "expired", "too_fast", "overlap", "seed_used", "not_yours", "same_device", "not_computer", "illegal", "mismatch"];
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
   each (record.js), who played, and a resignation. Nothing is stored
   anywhere, so a link works for as long as the site does, offline too. It
   carries no score: anyone can edit a link, and only the leaderboard's
   score is checked. */

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

function replayLink(seed, moves, resigned, meta) {
  const params = new URLSearchParams({ watch: packMoves(seed, moves), seed: seed.text, game: meta });
  if (resigned !== null) params.set("resign", SIDE_LETTER[resigned]);
  return `${location.origin}/?${params}`;
}

async function onShare() {
  const src = watching ?? (g && { seed: g.seed, moves: g.moves, resigned: g.resigned, meta: metaFor(g) });
  if (!src) return;
  const url = replayLink(src.seed, src.moves, src.resigned, src.meta);
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
  const r = params.get("resign");
  const resigned = r === "w" ? WHITE : r === "b" ? BLACK : null;
  return { seed, moves, resigned, meta: params.get("game") ?? "l" };
}

function watch(link) {
  cancelMove();
  thinking = false;
  g = null;
  watching = link;
  const meta = readMeta(link.meta);
  const record = replayGame(link.seed, link.moves);
  // A resignation only stands if the game had not already ended.
  const resigned = record.outcome ? null : link.resigned;
  watching.resigned = resigned;
  const o =
    resigned !== null
      ? { reason: "resign", winner: resigned ^ 1 }
      : record.outcome ?? { reason: "unfinished", winner: -1 };

  showPanel("play");
  resetResult();
  for (const id of ["liveActions", "netBar", "takeback", "submitForm", "notScored", "submitted"]) $(id).classList.add("hidden");
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
  $("resultReason").textContent =
    o.reason === "resign" ? `${SIDE_NAME[resigned]} resigned.` : o.reason === "unfinished" ? "The game stops here." : REASONS[o.reason];
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
  for (const key of ["watch", "seed", "game", "resign"]) params.delete(key);
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
  if (!g) return;
  if (g.mode === "network") {
    net?.nextGame();
    return;
  }
  startGame({
    mode: g.mode,
    seed: newSeed(g.seed.variant),
    level: g.level,
    sideChoice: g.sideChoice,
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
    resigned: g.resigned,
    gameId: g.gameId,
    ticket: g.ticket === "pending" ? "offline" : g.ticket,
    submitted: g.submitted,
  });
}

function resume() {
  const saved = store.getJSON(GAME_STORAGE);
  const seed = parseSeed(saved?.seed);
  if (!saved || !seed || !["computer", "local"].includes(saved.mode) || !Array.isArray(saved.moves)) return false;
  startGame({
    mode: saved.mode,
    seed,
    level: saved.level,
    sideChoice: saved.sideChoice,
    firstSide: saved.firstSide === 1 ? 1 : 0,
    moves: saved.moves.filter((m) => typeof m === "string"),
    undos: Array.isArray(saved.undos) ? saved.undos.map((n) => Number(n) || 0) : [0, 0],
    resigned: saved.resigned === 0 || saved.resigned === 1 ? saved.resigned : null,
    gameId: typeof saved.gameId === "string" ? saved.gameId : null,
    ticket: saved.gameId ? "ok" : saved.mode === "local" ? "none" : "offline",
    submitted: saved.submitted === true,
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
  const same = g && g.mode === "network" && g.role === "guest" && g.netGame === snap.game && g.seed.text === seed.text;
  if (!same) {
    startGame({
      mode: "network",
      role: "guest",
      seed,
      firstSide: snap.firstSide,
      moves: snap.moves,
      undos: snap.undos,
      resigned: snap.resigned,
      gameId: snap.gameId,
      ticket: snap.gameId ? "ok" : "none",
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
  g.gameId = snap.gameId;
  if (snap.gameId) g.ticket = "ok";
  g.takeback = snap.takeback;
  g.resigned = snap.resigned;
  g.undos = snap.undos.slice();

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
    replayer.stop();
    resetResult();
    $("status").dataset.last = "A move was taken back.";
    update({ animate: marks });
  } else if (old.join(" ") !== next.join(" ")) {
    g.moves = next.slice();
    rec = replayGame(g.seed, g.moves);
    replayer.stop();
    resetResult();
    update();
  } else {
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
    moves: g.moves,
    resigned: g.resigned,
    undos: g.undos,
    takeback: g.takeback,
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

export function initGame({ joinCode, replayLink: shared } = {}) {
  board = new BoardView($("board"), { onMove: (text) => onBoardMove(text) });
  replayer = new Replay(board);
  loadSetup();
  buildLevelPick();

  $("modePick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pick]");
    if (!b) return;
    setup.mode = b.dataset.pick;
    saveSetup();
    renderSetup();
  });
  $("levelPick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-level]");
    if (!b) return;
    setup.level = Number(b.dataset.level);
    saveSetup();
    renderSetup();
  });
  $("sidePick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-side]");
    if (!b) return;
    setup.side = b.dataset.side;
    saveSetup();
    renderSetup();
  });
  $("variantPick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-variant]");
    if (!b) return;
    setup.variant = b.dataset.variant;
    saveSetup();
    renderSetup();
  });
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
    if (watching) {
      replayer.view.coords = getSettings().coords;
      replayer.show(replayer.index, null);
      return;
    }
    if (!g) return;
    if (isOver()) {
      replayer.view.coords = getSettings().coords;
      replayer.show(replayer.index, null);
    } else update();
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
