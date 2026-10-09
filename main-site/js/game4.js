// Four-player games on the game screen: against three computers, four people
// taking turns on this device, or up to four devices on one network with the
// computer in any empty seat. game.js owns the screen and hands its buttons
// here while a four-player game is on; the board is a second BoardView, on
// the 14 by 14 geometry.
//
// As with two players, a game is its rules and a list of entries (chess4.js),
// and everything on screen is replayed from those. Four-player games are not
// scored: the API checks games with the two-player rules only.

import { BoardView, GEOMETRY_14 } from "./board.js";
import { moveMarks } from "./board.js";
import { replay4, placing, COLOUR_NAMES, RED, partnerOf } from "./chess4.js";
import { LEVELS4 } from "./ai4.js";
import { requestMove, cancelMove } from "./computer.js";
import { newSeed, hashString } from "./seed.js";
import { newClock, remaining, hand, stop, clockToWire, clockFromWire, formatClock, formatTaken, validTime } from "./clock.js";
import { getSettings } from "./settings.js";
import { store, hydrateIcons } from "./ui.js";
import { confetti } from "./confetti.js";

const STORAGE = "uwuchess.game4";
const LOW_TIME_MS = 20000;
const ORDINAL = ["", "1st", "2nd", "3rd", "4th"];
const OUT_WORDS = {
  checkmate: "checkmated",
  stalemate: "stalemated",
  captured: "lost their king",
  resign: "resigned",
  flag: "ran out of time",
};

const $ = (id) => document.getElementById(id);

let hooks = null; // from game.js: { replayer, showPanel, showSetup, dropTwo }
let board = null;
let net = null;
let g = null;
let rec = null;
let thinking = false;
let counter = 0;
let resignTimer = null;
let leaveTimer = null;

/* ---- starting ---- */

// opts: { mode, teams, level, colourChoice (0-3 or null), time } for a game
// on this device. Network games come through start() from multiplayer.js.
export function launch(opts) {
  const seed = newSeed("STD").text;
  const me = opts.mode === "local" ? -1 : opts.colourChoice ?? hashString(`side4|${seed}`) % 4;
  const seats = [0, 1, 2, 3].map((c) => (opts.mode === "local" ? "local" : c === me ? "you" : "cpu"));
  return start({ mode: opts.mode, teams: opts.teams, level: opts.level, seed, me, seats, time: opts.time ?? null });
}

// opts: { mode, role?, teams, level, seed, me, seats ("you" | "cpu" |
// "local" | "remote", per colour), time, moves?, clock?, startedAt?, netGame? }
export function start(opts) {
  hooks.dropTwo();
  cancelMove();
  thinking = false;
  hooks.replayer.stop();
  const now = Date.now();
  g = {
    id: ++counter,
    mode: opts.mode,
    role: opts.role ?? null,
    teams: Boolean(opts.teams),
    level: opts.level ?? 3,
    seed: opts.seed,
    me: opts.me,
    seats: opts.seats.slice(),
    moves: opts.moves?.slice() ?? [],
    time: opts.time ?? null,
    clock: opts.clock ?? newClock(now, 4),
    startedAt: opts.startedAt ?? now,
    endedAt: null,
    netGame: opts.netGame ?? 0,
    turnOffset: 0,
    wasOver: false,
  };
  rec = replay4(g.teams, g.moves);
  if (rec.error) {
    g.moves = g.moves.slice(0, rec.error.ply);
    rec = replay4(g.teams, g.moves);
  }
  if (!opts.clock) syncClock();
  disarm();
  hooks.showPanel("play");
  $("play").classList.add("four");
  resetResult();
  $("status").dataset.last = "";
  persist();
  update({ fresh: true });
  maybeComputer();
  return g;
}

export function active() {
  return g !== null;
}

export function current() {
  return g;
}

// Drops the game, and any saved one, without touching the screen: another
// game is starting, or the setup is.
export function clear() {
  if (g) {
    cancelMove();
    thinking = false;
    g = null;
    disarm();
  }
  store.remove(STORAGE);
  $("play").classList.remove("four");
}

/* ---- the state of play ---- */

const humanSeat = (kind) => kind !== "cpu";

function isOver() {
  if (!g) return false;
  if (rec.outcome) return true;
  // With nobody left to play for, the computers do not play it out.
  return g.mode !== "local" && !g.seats.some((k, c) => humanSeat(k) && rec.pos.isLive(c));
}

function amOut() {
  return g.me >= 0 && !rec.pos.isLive(g.me);
}

function interactiveSide() {
  if (isOver() || thinking) return -1;
  const turn = rec.pos.turn;
  if (g.mode === "local") return turn;
  // The host plays on while a guest is away; a guest needs the host.
  if (g.role === "guest" && !net?.connected()) return -1;
  return turn === g.me ? g.me : -1;
}

function orientation() {
  let base;
  if (g.mode === "local") base = getSettings().auto_flip && !isOver() ? rec.pos.turn : RED;
  else base = g.me;
  return (base + g.turnOffset) % 4;
}

function lastMarks(plies) {
  for (let i = plies.length - 1; i >= 0; i--) {
    const p = plies[i];
    if (p.event) return null;
    return { from: p.from, to: p.to, rookFrom: p.rookTo >= 0 ? p.rookFrom : -1, rookTo: p.rookTo ?? -1 };
  }
  return null;
}

/* ---- the clock ---- */

function clocked(colour) {
  return g.time?.mode === "each" && g.seats[colour] !== "cpu";
}

function ownsClock() {
  return Boolean(g?.time) && g.role !== "guest";
}

function syncClock() {
  if (!ownsClock()) return;
  const now = Date.now();
  if (isOver()) stop(g.clock, now);
  else if (g.time.mode === "each") {
    const turn = rec.pos.turn;
    hand(g.clock, clocked(turn) && rec.pos.isLive(turn) ? turn : -1, now);
  }
}

export function tick() {
  if (!g?.time) return;
  renderClocks();
  if (isOver() || !ownsClock()) return;
  const now = Date.now();
  if (g.time.mode === "total") {
    if (remaining(g.time, g.clock, 0, now) <= 0) addEntry("timeup", "The game clock ran out.");
    return;
  }
  const side = g.clock.running;
  if (side >= 0 && remaining(g.time, g.clock, side, now) <= 0) addEntry(`flag:${side}`, `${COLOUR_NAMES[side]} ran out of time.`);
}

function renderClocks() {
  const now = Date.now();
  const over = isOver();
  const game = $("gameClock");
  if (!g.time) {
    game.textContent = "";
    for (let c = 0; c < 4; c++) $(`seatClock${c}`) && ($(`seatClock${c}`).textContent = "");
    return;
  }
  const show = (el, ms, running, label) => {
    el.textContent = formatClock(ms);
    el.classList.toggle("running", running);
    el.classList.toggle("low", ms < LOW_TIME_MS);
    el.setAttribute("aria-label", label);
  };
  if (g.time.mode === "total") {
    const ms = remaining(g.time, g.clock, 0, now);
    show(game, ms, !over, `Game clock, ${formatClock(ms)} left`);
    return;
  }
  game.textContent = "";
  for (let c = 0; c < 4; c++) {
    const el = $(`seatClock${c}`);
    if (!el) continue;
    if (!clocked(c)) {
      el.textContent = "";
      continue;
    }
    const ms = remaining(g.time, g.clock, c, now);
    show(el, ms, !over && g.clock.running === c, `${COLOUR_NAMES[c]}'s clock, ${formatClock(ms)} left`);
  }
}

/* ---- moves ---- */

// An entry from anywhere: a move, or "resign:c", "flag:c", "timeup".
function addEntry(text, said, animate = null) {
  g.moves.push(text);
  rec = replay4(g.teams, g.moves);
  if (rec.error) {
    g.moves.pop();
    rec = replay4(g.teams, g.moves);
    return false;
  }
  if (said) $("status").dataset.last = said;
  syncClock();
  persist();
  update({ animate });
  net?.changed();
  maybeComputer();
  return true;
}

// A move from the board, the computer, or a guest (by way of the host).
export function playMove(text) {
  if (!g || isOver()) return false;
  const marks = moveMarks(rec.pos, text);
  if (!marks) return false;
  const side = rec.pos.turn;
  const outBefore = rec.out.length;
  const ok = addEntry(text, null, marks);
  if (!ok) return false;
  const ply = rec.plies.at(-1);
  const who = side === g.me ? "You" : COLOUR_NAMES[side];
  let said = `${who} played ${ply.san}.`;
  for (const o of rec.out.slice(outBefore)) said += ` ${COLOUR_NAMES[o.colour]} ${o.colour === g.me ? "(you) " : ""}${OUT_WORDS[o.reason]}.`;
  $("status").dataset.last = said;
  renderStatus();
  return true;
}

async function maybeComputer() {
  if (!g || isOver() || thinking || g.role === "guest") return;
  const turn = rec.pos.turn;
  if (g.seats[turn] !== "cpu") return;
  const game = g;
  const ply = g.moves.length;
  thinking = true;
  update();
  const pause = new Promise((r) => setTimeout(r, 300 + g.level * 40));
  const text = await requestMove(g.seed, g.level, g.moves, { players: 4, teams: g.teams });
  await pause;
  if (game !== g || g.moves.length !== ply || !thinking || isOver()) return;
  thinking = false;
  if (!text || !playMove(text)) update();
}

/* ---- for the network host ---- */

// A guest's move, checked against whose turn it is.
export function playRemote(colour, text, ply) {
  if (!g || isOver() || ply !== g.moves.length || rec.pos.turn !== colour) return false;
  return playMove(text);
}

export function resignAs(colour, ply = g?.moves.length) {
  if (!g || isOver() || !rec.pos.isLive(colour) || ply !== g.moves.length) return false;
  cancelMove();
  thinking = false;
  return addEntry(`resign:${colour}`, `${COLOUR_NAMES[colour]} resigned.`);
}

// A guest who left on purpose: the computer plays their seat from here.
export function seatToComputer(colour) {
  if (!g) return;
  g.seats[colour] = "cpu";
  syncClock();
  update();
  net?.changed();
  maybeComputer();
}

/* ---- undo, resign, leave ---- */

export function canUndo() {
  if (!g) return false;
  if (g.mode === "local") return g.moves.length > 0;
  if (g.mode === "computer") return rec.plies.some((p) => p.side === g.me);
  return false;
}

// Against the computer: back to before your last move, the computers'
// replies with it. On one device: the last entry.
export function onUndo() {
  if (!canUndo()) return;
  cancelMove();
  thinking = false;
  let keep = g.moves.length - 1;
  if (g.mode === "computer") {
    while (keep >= 0 && rec.plies[keep].side !== g.me) keep--;
  }
  const undone = g.moves.length - keep;
  g.moves = g.moves.slice(0, keep);
  g.endedAt = null;
  g.wasOver = false;
  if (g.clock.stopped && ownsClock()) g.clock.stopped = null;
  rec = replay4(g.teams, g.moves);
  syncClock();
  persist();
  hooks.replayer.stop();
  resetResult();
  $("status").dataset.last = undone === 1 ? "Took back a move." : `Took back ${undone} moves.`;
  update();
  maybeComputer();
}

export function onFlip() {
  if (!g) return;
  g.turnOffset = (g.turnOffset + 1) % 4;
  update();
}

function disarm() {
  clearTimeout(resignTimer);
  clearTimeout(leaveTimer);
  resignTimer = leaveTimer = null;
  $("resignBtn").classList.remove("armed");
  $("leaveBtn").classList.remove("armed");
  $("resignLabel").textContent = "Resign";
}

export function onResign() {
  if (!g || isOver()) return;
  const who = g.mode === "local" ? rec.pos.turn : g.me;
  if (!rec.pos.isLive(who)) return;
  if (!resignTimer) {
    $("resignBtn").classList.add("armed");
    $("resignLabel").textContent = "Tap again to resign";
    resignTimer = setTimeout(disarm, 3000);
    return;
  }
  disarm();
  if (g.role === "guest") {
    net?.resign();
    return;
  }
  resignAs(who);
}

export function onLeave() {
  if (g && !isOver() && g.moves.length > 0 && !leaveTimer) {
    $("leaveBtn").classList.add("armed");
    $("leaveLabel").textContent = g.mode === "network" ? "Tap again to leave" : "Tap again to end this game";
    leaveTimer = setTimeout(() => {
      disarm();
      update();
    }, 3000);
    return;
  }
  disarm();
  if (g?.mode === "network") net?.leave();
  backToSetup();
}

export function backToSetup() {
  clear();
  hooks.replayer.stop();
  hooks.showSetup();
}

export function onAgain() {
  if (!g) return;
  if (g.mode === "network") {
    net?.nextGame();
    return;
  }
  launch({ mode: g.mode, teams: g.teams, level: g.level, colourChoice: g.mode === "computer" ? g.me : null, time: g.time });
}

/* ---- drawing ---- */

export function refresh() {
  update();
}

function update({ animate = null, fresh = false } = {}) {
  if (!g) return;
  const over = isOver();
  const s = getSettings();
  if (over && !g.wasOver) {
    g.wasOver = true;
    g.endedAt ??= g.clock.stopped ?? Date.now();
    finish(fresh);
  } else if (!over) {
    g.wasOver = false;
    const mine = interactiveSide() >= 0 && (g.mode === "local" || rec.pos.turn === g.me);
    board.set({
      pos: rec.pos,
      orientation: orientation(),
      interactive: interactiveSide(),
      lastMove: lastMarks(rec.plies),
      animate,
      showMoves: s.show_moves,
      coords: s.coords,
      zoomable: mine,
    });
  }

  $("turnChip").textContent = over ? "Game over" : `${COLOUR_NAMES[rec.pos.turn]} to move`;
  $("scoreChip").textContent = g.teams ? "Teams" : "Free-for-all";
  renderSeats();
  renderClocks();
  renderStatus();
  renderActions(over);
}

function seatLabel(c) {
  const kind = g.seats[c];
  const partner = g.teams && g.me >= 0 && c === partnerOf(g.me);
  if (kind === "you") return "You";
  if (kind === "cpu") return partner ? "Computer, partner" : `Computer, ${LEVELS4[g.level].name}`;
  if (kind === "remote") return partner ? "Partner" : "Player";
  return g.teams ? `With ${COLOUR_NAMES[partnerOf(c)]}` : "";
}

function renderSeats() {
  const over = isOver();
  $("seats4").innerHTML = [0, 1, 2, 3]
    .map((c) => {
      const live = rec.pos.isLive(c);
      const place = placing(rec, c);
      const out = rec.out.find((o) => o.colour === c);
      const sub = !live && out ? `Out, ${OUT_WORDS[out.reason]}${g.teams ? "" : `, ${ORDINAL[place]}`}` : seatLabel(c);
      const turn = !over && live && rec.pos.turn === c;
      return `<div class="seat4" data-colour="${c}"${turn ? ' data-turn="true"' : ""}${live ? "" : ' data-out="true"'}>
        <span class="seat-dot" aria-hidden="true"></span>
        <span class="seat-text"><b>${COLOUR_NAMES[c]}</b><small>${sub}</small></span>
        <span class="clock" id="seatClock${c}" role="timer"></span></div>`;
    })
    .join("");
}

function renderStatus() {
  const el = $("status");
  const last = el.dataset.last ? `${el.dataset.last} ` : "";
  if (isOver()) {
    el.textContent = last;
    return;
  }
  const turn = rec.pos.turn;
  const name = COLOUR_NAMES[turn];
  const check = rec.pos.inCheck(turn) ? (turn === g.me ? "You are in check. " : `${name} is in check. `) : "";
  let now;
  if (g.role === "guest" && !net?.connected()) now = "Waiting for the host.";
  else if (g.role === "host" && g.seats[turn] === "remote" && !net?.seatConnected?.(turn)) now = `Waiting for ${name} to reconnect.`;
  else if (g.seats[turn] === "cpu") now = `${name}, the computer, is thinking.`;
  else if (g.mode === "local") now = `${name} to move.`;
  else if (turn === g.me) now = "Your move.";
  else now = `Waiting for ${name}.`;
  if (amOut()) {
    const place = placing(rec, g.me);
    now = `You are out${g.teams ? "" : `, in ${ORDINAL[place]} place`}. ${now}`;
  }
  el.textContent = `${last}${check}${now}`;
}

function renderActions(over) {
  $("liveActions").classList.remove("hidden");
  $("undoBtn").classList.toggle("hidden", g.mode === "network");
  $("undoBtn").disabled = !canUndo();
  $("undoLabel").textContent = "Undo";
  $("resignBtn").classList.toggle("hidden", over || (g.me >= 0 && amOut()));
  $("flipBtn").classList.toggle("hidden", over);
  $("leaveBtn").classList.toggle("hidden", over && g.mode !== "network");
  if (!leaveTimer) {
    $("leaveLabel").textContent = g.mode === "network" ? (g.role === "host" ? "Stop hosting" : "Leave") : "New game";
  }
  let note = "";
  if (g.mode === "computer") note = "Undo takes back your last move and the computers' replies.";
  if (g.mode === "network") note = "Undo is off in four-player network games.";
  if (g.time) note += " Undo does not give time back.";
  note += " Four-player games are not scored.";
  $("undoNote").textContent = note.trim();
}

/* ---- the end ---- */

function resetResult() {
  $("result").classList.add("hidden");
  $("replayBar").classList.add("hidden");
}

function headline(o) {
  const winners = o?.winners ?? [];
  if (g.mode === "local") {
    if (!o || o.draw) return "Draw";
    if (g.teams) return winners.includes(RED) ? "Red and Yellow win" : "Blue and Green win";
    return `${COLOUR_NAMES[winners[0]]} wins`;
  }
  if (g.teams) {
    if (!o || o.draw) return "Draw";
    return winners.includes(g.me) ? "Your team won" : "Your team lost";
  }
  if (o && winners.includes(g.me)) return o.draw ? "Draw" : "You won";
  return `You came ${ORDINAL[placing(rec, g.me) ?? 4]}`;
}

function story(o) {
  const parts = rec.out.map((x) => `${COLOUR_NAMES[x.colour]} ${OUT_WORDS[x.reason]}.`);
  if (o?.reason === "material") parts.push("Nobody left could checkmate.");
  else if (o?.reason === "fifty") parts.push("Fifty moves each without a capture or a pawn move.");
  else if (o?.reason === "timeup") parts.push(o.draw ? "The game clock ran out with material level." : "The game clock ran out, and more material wins.");
  else if (!o) {
    const left = rec.pos.liveColours().map((c) => COLOUR_NAMES[c]);
    const names = left.length > 1 ? `${left.slice(0, -1).join(", ")} and ${left.at(-1)}` : left[0];
    parts.push(`${names} ${left.length === 1 ? "was" : "were"} still playing.`);
  }
  return parts.join(" ");
}

function finish(fresh) {
  const o = rec.outcome;
  const s = getSettings();
  $("resultTitle").textContent = headline(o);
  $("resultReason").textContent = story(o);
  $("resultScore").textContent = `Took ${formatTaken((g.endedAt ?? Date.now()) - g.startedAt)}.`;
  $("notScored").textContent = "Four-player games are not scored.";
  $("notScored").classList.remove("hidden");
  const guest = g.role === "guest";
  $("againBtn").classList.toggle("hidden", guest);
  $("againLabel").textContent = g.mode === "network" ? "Next game" : "Play again";
  $("newGameBtn").classList.toggle("hidden", g.mode === "network");
  $("newGameLabel").textContent = "New game";
  $("result").classList.remove("hidden");
  $("replayBar").classList.remove("hidden");
  hydrateIcons($("play"));

  const full = replay4(g.teams, g.moves, { frames: true });
  hooks.replayer.load(
    {
      board,
      frames: full.frames,
      marks: full.plies.map((p) => (p.event ? null : { from: p.from, to: p.to, rookFrom: p.rookTo >= 0 ? p.rookFrom : -1, rookTo: p.rookTo ?? -1 })),
      plies: full.plies,
      players: 4,
    },
    { orientation: orientation(), coords: s.coords },
    { autoplay: !fresh && s.auto_replay }
  );
  if (!fresh) $("resultTitle").focus({ preventScroll: true });

  const won = g.mode === "local" ? Boolean(o && !o.draw) : Boolean(o && !o.draw && o.winners.includes(g.me));
  if (won && !fresh) confetti();
}

/* ---- saving ---- */

function persist() {
  if (!g || g.mode === "network") return;
  store.set(STORAGE, {
    mode: g.mode,
    teams: g.teams,
    level: g.level,
    seed: g.seed,
    me: g.me,
    moves: g.moves,
    time: g.time,
    clock: g.clock,
    startedAt: g.startedAt,
  });
}

function savedClock(c) {
  const t = (x) => Number.isFinite(x) && x > 0;
  const ok =
    c &&
    Array.isArray(c.used) &&
    c.used.length === 4 &&
    c.used.every((n) => Number.isFinite(n) && n >= 0) &&
    Number.isInteger(c.running) &&
    c.running >= -1 &&
    c.running < 4 &&
    (c.since === null || t(c.since)) &&
    t(c.start) &&
    (c.stopped === null || t(c.stopped));
  return ok ? { used: c.used.slice(), running: c.running, since: c.since, start: c.start, stopped: c.stopped } : null;
}

export function resume() {
  const s = store.getJSON(STORAGE);
  if (!s || !["computer", "local"].includes(s.mode) || !Array.isArray(s.moves) || typeof s.seed !== "string") return false;
  const me = s.mode === "local" ? -1 : [0, 1, 2, 3].includes(s.me) ? s.me : 0;
  const level = Number.isInteger(s.level) && s.level >= 1 && s.level <= 5 ? s.level : 3;
  const time = validTime(s.time ?? null) ? s.time ?? null : null;
  const clock = savedClock(s.clock);
  start({
    mode: s.mode,
    teams: s.teams === true,
    level,
    seed: s.seed,
    me,
    seats: [0, 1, 2, 3].map((c) => (s.mode === "local" ? "local" : c === me ? "you" : "cpu")),
    moves: s.moves.filter((m) => typeof m === "string"),
    time: time && clock ? time : null,
    clock: time && clock ? clock : undefined,
    startedAt: Number.isFinite(s.startedAt) ? s.startedAt : Date.now(),
  });
  return true;
}

/* ---- the network ---- */

export function setNet(adapter) {
  net = adapter;
}

// The game as one guest sees it: seats are people or computers, and `you`
// says which is theirs.
export function snapshot(you) {
  return {
    type: "state4",
    v: 1,
    game: g.netGame,
    teams: g.teams,
    level: g.level,
    seed: g.seed,
    seats: g.seats.map((k) => (k === "cpu" ? "cpu" : "human")),
    you,
    moves: g.moves,
    time: g.time,
    clock: g.time ? clockToWire(g.clock, Date.now()) : null,
  };
}

export function loadSnapshot(snap) {
  const now = Date.now();
  const clock = snap.time ? clockFromWire(snap.clock, now) : undefined;
  const seats = snap.seats.map((k, c) => (c === snap.you ? "you" : k === "cpu" ? "cpu" : "remote"));
  const same = g && g.mode === "network" && g.role === "guest" && g.netGame === snap.game && g.seed === snap.seed;
  if (!same) {
    start({
      mode: "network",
      role: "guest",
      teams: snap.teams,
      level: snap.level,
      seed: snap.seed,
      me: snap.you,
      seats,
      moves: snap.moves,
      time: snap.time,
      clock,
      startedAt: clock ? clock.start : now,
      netGame: snap.game,
    });
    return;
  }
  const old = g.moves;
  const next = snap.moves;
  const seatsChanged = seats.join() !== g.seats.join();
  g.seats = seats;
  g.time = snap.time;
  if (clock) g.clock = clock;
  if (next.length === old.length && old.every((m, i) => m === next[i])) {
    if (seatsChanged) update();
    else renderClocks();
    return;
  }
  const extends1 = next.length === old.length + 1 && old.every((m, i) => m === next[i]);
  const marks = extends1 ? moveMarks(rec.pos, next.at(-1)) : null;
  const outBefore = rec.out.length;
  g.moves = next.slice();
  rec = replay4(g.teams, g.moves);
  if (extends1) {
    const ply = rec.plies.at(-1);
    let said = ply.event === "resign" ? `${COLOUR_NAMES[ply.side]} resigned.` : ply.event === "flag" ? `${COLOUR_NAMES[ply.side]} ran out of time.` : ply.event ? "The game clock ran out." : `${ply.side === g.me ? "You" : COLOUR_NAMES[ply.side]} played ${ply.san}.`;
    for (const o of rec.out.slice(outBefore)) if (o.reason !== "resign" && o.reason !== "flag") said += ` ${COLOUR_NAMES[o.colour]} ${OUT_WORDS[o.reason]}.`;
    $("status").dataset.last = said;
  }
  update({ animate: marks });
}

export function state() {
  return { rec, over: isOver() };
}

/* ---- wiring ---- */

export function initGame4(h) {
  hooks = h;
  board = new BoardView($("board4"), { onMove: onBoardMove, geometry: GEOMETRY_14, zoomable: true });
}

function onBoardMove(text) {
  if (!g) return;
  if (g.role === "guest") {
    net?.sendMove(text);
    return;
  }
  playMove(text);
}
