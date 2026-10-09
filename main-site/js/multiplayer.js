// Network games: one device hosts and the others join with a six character
// code, over net.js. The host is authoritative, per STUN-p2p-spec.md: a guest
// sends what it wants to do, the host applies it and sends the whole game
// back, 20 times a second and on every change. A guest shows nothing as done
// until a snapshot says so.
//
// Two players: the host and one guest, and the game starts as soon as the
// guest says hello. Four players: up to three guests take seats in a lobby,
// the host starts when ready, and the computer plays any seat left empty.
// Every guest sends a client id with its connection, kept in its browser, so
// one that reloads or drops comes back to the same seat.
//
// Messages, beyond the spec's hello, state, bye and full:
//
//   { type: "move", text, ply }       guest to host, one move
//   { type: "resign", ply }           guest to host
//   { type: "takeback", ply }         guest to host, asking to undo (two players)
//   { type: "takeback-cancel" }       guest to host, withdrawing that
//   { type: "takeback-answer", yes }  guest to host, on the host's request
//   { type: "ping" }                  guest to host, the guest's heartbeat
//   { type: "lobby", seats, you, teams }  host to guest, four players, before
//                                     the game: "host", "guest" or "open" per
//                                     colour, and which is theirs
//   { type: "state4", ... }           host to guest, a four-player game; see
//                                     game4.js snapshot()
//
// `ply` is the number of moves the guest saw when it acted. A message about
// a game that has moved on since is ignored, and the next snapshot heals it.

import { Host, Guest, generateCode, isValidCode, normaliseCode, CODE_LENGTH, PROTOCOL_VERSION } from "./net.js";
import * as game from "./game.js";
import * as four from "./game4.js";
import { validEnd } from "./record.js";
import { validTime, validWireClock } from "./clock.js";
import { validEntry, parseEvent, MAX_ENTRIES, COLOUR_NAMES } from "./chess4.js";
import { newSeed } from "./seed.js";
import { qrToSvg } from "./qr.js";
import { copyText, hydrateIcons, store } from "./ui.js";

const HOST_CODE_KEY = "uwuchess.hostCode";
const LAST_CODE_KEY = "uwuchess.lastCode";
const CLIENT_KEY = "uwuchess.client";
const SNAPSHOT_MS = 50;
// Silence checks and the guest's bar need nothing like the snapshot rate.
const TICK_MS = 250;
const PING_MS = 1000;
const HOST_SILENCE_MS = 8000;
// Time, not missed snapshots: at 20 a second a few missed ones is an
// ordinary wifi stall, and a background host tab only ticks once a second.
const GUEST_STALE_MS = 2000;
const MOVE_TEXT = /^(?:[a-h][1-8][a-h][1-8][qrbn]?|O-O|O-O-O)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT = /^[0-9a-f]{32}$/;

const $ = (id) => document.getElementById(id);

let role = null; // "host" | "guest" | null
let host = null;
let guest = null;
let code = "";
// host: the next game. seed is a pasted one, or null for the server to
// pick; side is "w", "b" or null for the seed's (two players), or a colour
// 0 to 3 or null (four); time a limit or null; players 2 or 4.
let plan = null;
let netGame = 0;
let startingGame = false;
let retriedTaken = false;
let lastState = 0;
let reconnects = 0;
let wakeLock = null;
// host, by peer id: when it was last heard from, and its client id.
const lastHeard = new Map();
const clients = new Map();
// host, four players: per colour, "host", "open", "cpu", or { client }.
let seats = null;
// guest, four players: the last lobby, while waiting for the game.
let lobby = null;

const fourUp = () => plan?.players === 4;
const netGameOn = () => game.current()?.mode === "network" || four.current()?.mode === "network";

/* ---- the adapter game.js and game4.js call ---- */

const adapter = {
  connected() {
    if (role === "host") return Boolean(host && host.links.size > 0);
    if (role === "guest") return guest?.status === "connected" && Date.now() - lastState < GUEST_STALE_MS * 3;
    return false;
  },
  seatConnected(colour) {
    return Boolean(peerOf(colour));
  },
  changed() {
    if (role === "host") broadcast();
    renderBar();
  },
  host(next) {
    startHosting(next);
  },
  sendMove(text) {
    guest?.send({ type: "move", text, ply: (four.current() ?? game.current())?.moves.length ?? 0 });
  },
  resign() {
    guest?.send({ type: "resign", ply: (four.current() ?? game.current())?.moves.length ?? 0 });
  },
  requestTakeback() {
    const g = game.current();
    if (!g) return;
    if (role === "host") {
      game.setTakeback({ by: game.state().mySide });
      broadcast();
    } else {
      guest?.send({ type: "takeback", ply: g.moves.length });
    }
  },
  answerTakeback(yes) {
    const g = game.current();
    const pending = g?.takeback;
    if (!pending) return;
    const mine = pending.by === game.state().mySide;
    if (role === "host") {
      if (!mine && yes) game.takeBack(game.undoPlies(pending.by), pending.by);
      else game.setTakeback(null);
      broadcast();
    } else {
      guest?.send(mine ? { type: "takeback-cancel" } : { type: "takeback-answer", yes: Boolean(yes) });
    }
  },
  leave() {
    if (role === "host") stopHosting();
    else leaveGuest();
  },
  nextGame() {
    if (role !== "host" || !plan) return;
    // A fresh seed for every game after the first, picked by the server.
    plan.seed = null;
    startNetworkGame();
  },
};

/* ---- hosting ---- */

function readStored(key) {
  const value = store.get(key);
  return isValidCode(value) ? normaliseCode(value) : null;
}

function joinLink(c) {
  return `${location.origin}/?join=${c}`;
}

function randomColour() {
  return crypto.getRandomValues(new Uint8Array(1))[0] % 4;
}

async function startHosting(next) {
  closeAll();
  role = "host";
  plan = { ...next };
  netGame = 0;
  lastHeard.clear();
  clients.clear();
  code = readStored(HOST_CODE_KEY) ?? generateCode();
  store.set(HOST_CODE_KEY, code);

  if (fourUp()) {
    // The host keeps its colour across a fresh code; guests join again.
    const mine = plan.side ?? plan.hostColour ?? randomColour();
    plan.hostColour = mine;
    seats = [0, 1, 2, 3].map((c) => (c === mine ? "host" : "open"));
  } else {
    seats = null;
  }

  game.showPanel("net");
  $("hostView").classList.remove("hidden");
  $("hostCode").textContent = code;
  $("hostQr").innerHTML = qrToSvg(joinLink(code));
  $("copyLinkLabel").textContent = "Copy link";
  $("newCodeBtn").classList.remove("hidden");
  $("netRetryBtn").classList.add("hidden");
  renderLobby();
  setNetStatus(navigator.onLine === false ? "Network games need a connection to pair." : "Setting up the code.");

  const mine = new Host({ maxGuests: fourUp() ? 3 : 1 });
  host = mine;
  mine.addEventListener("status", ({ detail }) => {
    if (host !== mine) return;
    if (detail.taken && !retriedTaken) {
      // Another tab holds it, or the broker has not let go of it yet.
      retriedTaken = true;
      restartWithFreshCode();
      return;
    }
    if (detail.status === "waiting") retriedTaken = false;
    onHostStatus(detail);
  });
  mine.addEventListener("join", ({ detail }) => {
    if (host !== mine) return;
    const client = detail.metadata?.client;
    clients.set(detail.id, typeof client === "string" && CLIENT.test(client) ? client : detail.id);
    lastHeard.set(detail.id, Date.now());
  });
  mine.addEventListener("message", ({ detail }) => {
    if (host === mine) onHostMessage(detail.message, detail.from);
  });
  mine.addEventListener("leave", ({ detail }) => {
    if (host !== mine) return;
    lastHeard.delete(detail.id);
    clients.delete(detail.id);
    renderLobby();
    if (fourUp() && !netGameOn()) broadcast();
    four.refresh();
    game.refresh();
    renderBar();
  });

  try {
    await mine.start(code);
  } catch {
    if (host !== mine) return;
    host = null;
    setNetStatus("Could not load pairing. Check your connection.", true);
  }
}

function onHostStatus({ status, message }) {
  if (status === "error") {
    // With a game under way the board stays; the bar says what happened.
    if (netGameOn()) renderBar(message);
    else setNetStatus(message, true);
    return;
  }
  if (status === "waiting" && !netGameOn()) {
    setNetStatus(fourUp() ? "Waiting for players to join. Start whenever you like." : "Waiting for the other device to join.");
  }
  if (status === "connected") acquireWakeLock();
  if (status === "connected" && fourUp() && !netGameOn()) setNetStatus("Start when everybody is in. The computer plays any empty seat.");
  renderBar();
  game.refresh();
  four.refresh();
}

function restartWithFreshCode() {
  store.remove(HOST_CODE_KEY);
  startHosting(plan);
}

function stopHosting() {
  host?.close();
  host = null;
  role = null;
  seats = null;
  releaseWakeLock();
}

/* ---- seats, four players ---- */

function seatOf(client) {
  return seats ? seats.findIndex((s) => typeof s === "object" && s.client === client) : -1;
}

// The peer sitting at `colour`, if it is connected.
function peerOf(colour) {
  const seat = seats?.[colour];
  if (!seat || typeof seat !== "object" || !host) return null;
  for (const id of host.links.keys()) if (clients.get(id) === seat.client) return id;
  return null;
}

function lobbyFor(colour) {
  return {
    type: "lobby",
    v: 1,
    teams: Boolean(plan.teams),
    seats: seats.map((s) => (s === "host" ? "host" : typeof s === "object" ? "guest" : "open")),
    you: colour,
  };
}

// The seats on the net panel, for the host and for a guest in the lobby.
function renderLobby() {
  const list = $("seatList");
  const view = role === "host" && seats ? lobbyFor(-1) : role === "guest" ? lobby : null;
  const show = Boolean(view) && !netGameOn();
  list.classList.toggle("hidden", !show);
  $("netStartBtn").classList.toggle("hidden", !(show && role === "host"));
  if (!show) return;
  const you = role === "host" ? seats.indexOf("host") : view.you;
  list.innerHTML = view.seats
    .map((kind, c) => {
      let text;
      if (c === you) text = "You";
      else if (kind === "host") text = "The host";
      else if (kind === "guest") text = role === "host" && !peerOf(c) ? "A player, reconnecting" : "A player";
      else text = "Empty: the computer plays";
      const partner = view.teams && you >= 0 && c === (you ^ 2) ? ", your partner" : "";
      return `<li class="seat4" data-colour="${c}"${kind === "open" ? ' data-out="true"' : ""}><span class="seat-dot" aria-hidden="true"></span><span class="seat-text"><b>${COLOUR_NAMES[c]}</b><small>${text}${partner}</small></span></li>`;
    })
    .join("");
  if (role === "host") {
    const people = seats.filter((s) => s !== "open").length;
    $("netStartLabel").textContent = people === 4 ? "Start game" : `Start with ${people} ${people === 1 ? "player" : "players"}`;
  }
}

// The game starts once the guest has said hello (two players), or when the
// host says so (four), so its clock and the server's start from when
// everybody is there.
async function startNetworkGame() {
  if (startingGame) return;
  if (fourUp()) {
    startFour();
    return;
  }
  startingGame = true;
  try {
    const g = await game.launch({
      mode: "network",
      role: "host",
      seed: plan.seed,
      variant: plan.variant,
      sideChoice: plan.side,
      time: plan.time,
    });
    if (g) g.netGame = ++netGame;
  } finally {
    startingGame = false;
  }
  broadcast();
}

function startFour() {
  // Empty seats go to the computer, and stay with it for the session.
  seats = seats.map((s) => (s === "open" ? "cpu" : s));
  four.start({
    mode: "network",
    role: "host",
    teams: Boolean(plan.teams),
    level: plan.level,
    seed: newSeed("STD").text,
    me: seats.indexOf("host"),
    seats: seats.map((s) => (s === "host" ? "you" : s === "cpu" ? "cpu" : "remote")),
    time: plan.time,
    netGame: ++netGame,
  });
  renderLobby();
  broadcast();
}

function broadcast() {
  if (role !== "host" || !host) return;
  if (fourUp()) {
    const g = four.current();
    const live = g && g.mode === "network" && g.netGame;
    for (const id of host.links.keys()) {
      const colour = seatOf(clients.get(id));
      if (colour < 0) continue;
      host.send(live ? four.snapshot(colour) : lobbyFor(colour), id);
    }
    return;
  }
  const g = game.current();
  if (!g || g.mode !== "network" || !g.netGame) return;
  host.send(game.snapshot());
}

function onHostMessage(message, from) {
  lastHeard.set(from, Date.now());
  if (message.type === "hello" && message.v !== PROTOCOL_VERSION) {
    host.send({ type: "old", v: PROTOCOL_VERSION }, from);
    return;
  }
  if (fourUp()) onHostMessage4(message, from);
  else onHostMessage2(message, from);
}

function onHostMessage2(message, from) {
  const g = game.current();
  const guestSide = g && g.mode === "network" ? g.firstSide ^ 1 : 1;
  const live = g && g.mode === "network" && !game.isOver();
  const ply = Number.isInteger(message.ply) ? message.ply : -1;

  switch (message.type) {
    case "hello":
      if (!g || g.mode !== "network") startNetworkGame();
      else if (g.netGame) host.send(game.snapshot(), from);
      renderBar();
      return;
    case "move":
      if (!live || typeof message.text !== "string" || !MOVE_TEXT.test(message.text)) break;
      if (ply !== g.moves.length || game.state().rec.pos.turn !== guestSide) break;
      if (g.takeback) game.setTakeback(null);
      game.playMove(message.text, { from: "network" });
      return;
    case "resign":
      if (live && ply === g.moves.length) game.resign(guestSide);
      break;
    case "takeback":
      if (g && !g.takeback && ply === g.moves.length && game.undoPlies(guestSide) > 0) game.setTakeback({ by: guestSide });
      break;
    case "takeback-cancel":
      if (g?.takeback?.by === guestSide) game.setTakeback(null);
      break;
    case "takeback-answer":
      if (g?.takeback?.by === (guestSide ^ 1)) {
        if (message.yes === true) game.takeBack(game.undoPlies(guestSide ^ 1), guestSide ^ 1);
        else game.setTakeback(null);
      }
      break;
    case "bye":
      // Leaving on purpose: this code is spent, and the game with it.
      store.remove(HOST_CODE_KEY);
      game.endGame();
      startHosting({ ...plan, seed: null });
      setNetStatus("Your opponent left. Share the new code to play again.");
      return;
    default:
      // ping, and anything this build does not know: ignored, never thrown on.
      return;
  }
  broadcast();
}

function onHostMessage4(message, from) {
  const client = clients.get(from);
  const colour = seatOf(client);
  const g = four.current();
  const started = Boolean(g && g.mode === "network" && g.netGame);
  const ply = Number.isInteger(message.ply) ? message.ply : -1;

  switch (message.type) {
    case "hello":
      if (colour < 0) {
        // A newcomer: the next open seat after the host's, in turn order.
        const mine = seats.indexOf("host");
        const open = started ? -1 : [1, 2, 3].map((i) => (mine + i) % 4).find((c) => seats[c] === "open") ?? -1;
        if (open < 0) {
          host.send({ type: "full", started }, from);
          return;
        }
        seats[open] = { client };
      }
      renderLobby();
      broadcast();
      renderBar();
      four.refresh();
      return;
    case "move":
      if (!started || colour < 0 || typeof message.text !== "string" || !validEntry(message.text) || parseEvent(message.text)) break;
      four.playRemote(colour, message.text, ply);
      return;
    case "resign":
      if (started && colour >= 0) four.resignAs(colour, ply);
      return;
    case "bye":
      // Leaving on purpose. Before the game the seat opens again; during it,
      // the computer takes over, so the others can play on.
      if (colour < 0) return;
      if (started) {
        seats[colour] = "cpu";
        four.seatToComputer(colour);
      } else {
        seats[colour] = "open";
        renderLobby();
        broadcast();
      }
      return;
    default:
      return;
  }
}

/* ---- joining ---- */

// This browser's id, so a host can give it back its seat.
function clientId() {
  let id = store.get(CLIENT_KEY);
  if (!CLIENT.test(id ?? "")) {
    id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    store.set(CLIENT_KEY, id);
  }
  return id;
}

export async function join(input) {
  const c = normaliseCode(input);
  if (!isValidCode(c)) {
    setNetStatus(`A code is ${CODE_LENGTH} characters.`, true);
    const field = $("joinInput");
    field.classList.remove("shake");
    void field.offsetWidth;
    field.classList.add("shake");
    field.focus();
    return;
  }
  if (role !== "guest" || code !== c) {
    reconnects = 0;
    lobby = null;
  }
  closeAll();
  role = "guest";
  code = c;
  lastState = 0;

  if (!netGameOn()) {
    game.showPanel("net");
    $("hostView").classList.add("hidden");
    $("newCodeBtn").classList.add("hidden");
    renderLobby();
  }
  $("netRetryBtn").classList.add("hidden");
  setNetStatus(navigator.onLine === false ? "Network games need a connection to pair." : `Connecting to ${c}.`);

  const mine = new Guest();
  guest = mine;
  mine.addEventListener("status", ({ detail }) => {
    if (guest === mine) onGuestStatus(detail);
  });
  mine.addEventListener("message", ({ detail }) => {
    if (guest === mine) onGuestMessage(detail.message);
  });

  try {
    await mine.connect(c, { client: clientId() });
    store.set(LAST_CODE_KEY, c);
  } catch {
    if (guest !== mine) return;
    guest = null;
    setNetStatus("Could not load pairing. Check your connection.", true);
    $("netRetryBtn").classList.remove("hidden");
  }
}

const UNREACHABLE =
  "Could not reach the other device. Both have to be on the same network: join the same wifi, or turn on a hotspot on one and join it from the other. Check the code is still the one on screen.";

function onGuestStatus({ status, message }) {
  const inGame = netGameOn();
  if (status === "connected") {
    reconnects = 0;
    acquireWakeLock();
    if (!inGame) setNetStatus("Connected. Waiting for the host's game.");
  } else if (status === "dropped") {
    // Probably coming back: try again quietly a few times.
    if (reconnects < 3) {
      reconnects++;
      setTimeout(() => role === "guest" && guest?.status === "dropped" && join(code), 1500);
    } else if (!inGame) {
      setNetStatus("The connection dropped.", true);
      $("netRetryBtn").classList.remove("hidden");
    }
  } else if (status === "unreachable" || status === "error") {
    const text = status === "unreachable" ? UNREACHABLE : message;
    if (inGame) {
      renderBar(text);
    } else {
      setNetStatus(text, true);
      $("netRetryBtn").classList.remove("hidden");
    }
  }
  renderBar();
  game.refresh();
  four.refresh();
}

function validSnapshot(s) {
  return (
    s.type === "state" &&
    Number.isInteger(s.game) &&
    typeof s.seed === "string" &&
    s.seed.length <= 20 &&
    (s.firstSide === 0 || s.firstSide === 1) &&
    Array.isArray(s.moves) &&
    s.moves.length <= 600 &&
    s.moves.every((m) => typeof m === "string" && MOVE_TEXT.test(m)) &&
    validEnd(s.end) &&
    typeof s.serverSeed === "boolean" &&
    (s.time === null || validTime(s.time)) &&
    (s.time === null ? s.clock === null : validWireClock(s.clock)) &&
    Array.isArray(s.undos) &&
    s.undos.length === 2 &&
    s.undos.every((n) => Number.isInteger(n) && n >= 0 && n < 100000) &&
    (s.takeback === null || (typeof s.takeback === "object" && (s.takeback.by === 0 || s.takeback.by === 1))) &&
    (s.gameId === null || (typeof s.gameId === "string" && UUID.test(s.gameId)))
  );
}

const isColour = (c) => c === 0 || c === 1 || c === 2 || c === 3;

function validSnapshot4(s) {
  return (
    Number.isInteger(s.game) &&
    typeof s.teams === "boolean" &&
    Number.isInteger(s.level) &&
    s.level >= 1 &&
    s.level <= 5 &&
    typeof s.seed === "string" &&
    s.seed.length <= 20 &&
    Array.isArray(s.seats) &&
    s.seats.length === 4 &&
    s.seats.every((k) => k === "human" || k === "cpu") &&
    isColour(s.you) &&
    s.seats[s.you] === "human" &&
    Array.isArray(s.moves) &&
    s.moves.length <= MAX_ENTRIES &&
    s.moves.every(validEntry) &&
    (s.time === null || validTime(s.time)) &&
    (s.time === null ? s.clock === null : validWireClock(s.clock, 4))
  );
}

function validLobby(s) {
  return (
    typeof s.teams === "boolean" &&
    Array.isArray(s.seats) &&
    s.seats.length === 4 &&
    s.seats.every((k) => k === "host" || k === "guest" || k === "open") &&
    isColour(s.you) &&
    s.seats[s.you] === "guest"
  );
}

function onGuestMessage(message) {
  switch (message.type) {
    case "state":
      if (!validSnapshot(message)) return;
      lastState = Date.now();
      lobby = null;
      // Rebuilt field by field, so nothing unexpected rides along.
      game.loadSnapshot({
        ...message,
        end: message.end && (message.end.by === "timeup" ? { by: "timeup" } : { by: message.end.by, side: message.end.side }),
        takeback: message.takeback && { by: message.takeback.by },
        time: message.time && { mode: message.time.mode, ms: message.time.ms },
      });
      renderBar();
      return;
    case "state4":
      if (!validSnapshot4(message)) return;
      lastState = Date.now();
      lobby = null;
      four.loadSnapshot({
        game: message.game,
        teams: message.teams,
        level: message.level,
        seed: message.seed,
        seats: message.seats.slice(),
        you: message.you,
        moves: message.moves.slice(),
        time: message.time && { mode: message.time.mode, ms: message.time.ms },
        clock: message.clock,
      });
      renderBar();
      return;
    case "lobby":
      if (!validLobby(message)) return;
      lastState = Date.now();
      lobby = { teams: message.teams, seats: message.seats.slice(), you: message.you };
      if (!netGameOn()) {
        renderLobby();
        setNetStatus(`Connected, as ${COLOUR_NAMES[message.you]}. Waiting for the host to start.`);
      }
      return;
    case "full":
      setNetStatus(message.started === true ? "That game has already started." : "That game is full.", true);
      return;
    case "old":
      setNetStatus("The host's device is on a different version. Reload both and try again.", true);
      return;
    default:
      return;
  }
}

function leaveGuest() {
  guest?.leave();
  guest = null;
  role = null;
  lobby = null;
  store.remove(LAST_CODE_KEY);
  releaseWakeLock();
}

/* ---- both ---- */

function closeAll() {
  host?.close();
  host = null;
  guest?.close();
  guest = null;
}

function setNetStatus(text, error = false) {
  const el = $("netStatus");
  el.textContent = text;
  el.classList.toggle("error", error);
}

// The line under the board in a network game.
function renderBar(problem) {
  const bar = $("netBar");
  if (!netGameOn()) {
    bar.classList.add("hidden");
    return;
  }
  let tone = "busy";
  let text;
  if (role === "host" && four.current()) {
    const away = [0, 1, 2, 3].filter((c) => typeof seats?.[c] === "object" && !peerOf(c)).map((c) => COLOUR_NAMES[c]);
    const people = seats?.filter((s) => typeof s === "object").length ?? 0;
    if (!people) {
      tone = "ok";
      text = "Hosting. Only computers joined.";
    } else if (!away.length) {
      tone = "ok";
      text = people === 1 ? "Connected" : `All ${people} players connected`;
    } else {
      tone = "warn";
      text = `${away.join(" and ")} disconnected. They can rejoin with ${code}.`;
    }
  } else if (role === "host") {
    if (host?.links.size) {
      tone = "ok";
      text = "Connected";
    } else {
      tone = "warn";
      text = `Opponent disconnected. They can rejoin with ${code}.`;
    }
  } else if (role === "guest") {
    const fresh = Date.now() - lastState < GUEST_STALE_MS;
    if (guest?.status === "connected" && fresh) {
      tone = "ok";
      text = "Connected to the host";
    } else if (guest?.status === "connected") {
      tone = "warn";
      text = "The connection looks stale.";
    } else if (guest?.status === "connecting" || guest?.status === "dropped") {
      text = "Reconnecting.";
    } else {
      tone = "error";
      text = "Disconnected.";
    }
  } else {
    tone = "error";
    text = "Not connected.";
  }
  if (problem) {
    tone = "error";
    text = problem;
  }
  bar.dataset.tone = tone;
  $("netBarText").textContent = text;
  bar.classList.remove("hidden");
}

async function acquireWakeLock() {
  try {
    if (!wakeLock && "wakeLock" in navigator && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    }
  } catch {
    // Refused or unsupported: the screen may sleep, nothing else changes.
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function tick() {
  if (role === "host" && host) {
    // A guest silent this long has probably gone; its seat waits for it.
    const now = Date.now();
    for (const id of [...host.links.keys()]) {
      if (now - (lastHeard.get(id) ?? now) > HOST_SILENCE_MS) {
        host.dropPeer(id);
        game.refresh();
        four.refresh();
      }
    }
  }
  if (role === "guest" || (role === "host" && four.current())) renderBar();
}

export function initMultiplayer({ joinCode } = {}) {
  game.setNet(adapter);
  four.setNet(adapter);

  $("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    join($("joinInput").value);
  });
  $("joinInput").addEventListener("input", (e) => {
    const c = normaliseCode(e.target.value);
    if (c !== e.target.value) e.target.value = c;
  });
  $("copyLinkBtn").addEventListener("click", async () => {
    $("copyLinkLabel").textContent = (await copyText(joinLink(code))) ? "Copied" : "Copy failed";
  });
  $("newCodeBtn").addEventListener("click", () => {
    if (role === "host") restartWithFreshCode();
  });
  $("netStartBtn").addEventListener("click", () => {
    if (role === "host" && fourUp() && !netGameOn()) startNetworkGame();
  });
  $("netRetryBtn").addEventListener("click", () => {
    if (role === "guest" || code) join(code);
  });
  $("netCancelBtn").addEventListener("click", () => {
    if (role === "host") stopHosting();
    else leaveGuest();
    renderLobby();
    game.endGame();
  });

  // The steady beat, which doubles as the host's heartbeat.
  setInterval(() => role === "host" && broadcast(), SNAPSHOT_MS);
  setInterval(tick, TICK_MS);
  setInterval(() => role === "guest" && guest?.send({ type: "ping" }), PING_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (role && adapter.connected()) acquireWakeLock();
    // Back from the background with a channel that died meanwhile.
    if (role === "guest" && guest?.status === "dropped") join(code);
  });

  // From a join link, or from last time.
  const initial = normaliseCode(joinCode) || readStored(LAST_CODE_KEY) || "";
  if (initial) $("joinInput").value = initial;
  hydrateIcons($("net"));
}
