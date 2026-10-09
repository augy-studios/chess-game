// The instant replay: a finished game played back on the same board, one
// move at a time, with play, pause, a step either way, and a jump to any
// move from the list or the slider. Stepping back slides the piece back.

import { moveMarks } from "./board.js";
import { positions, replay as replayGame } from "./record.js";
import { escapeHtml, hydrateIcons, store } from "./ui.js";

// What a two-player game gives the replay: its board, a position before and
// after every move, the marks for each, and the notation.
export function replaySource(board, seed, moves) {
  const frames = positions(seed, moves);
  return {
    board,
    frames,
    marks: moves.map((text, i) => moveMarks(frames[i], text)),
    plies: replayGame(seed, moves).plies,
    players: 2,
  };
}

// A move every 900 ms at 1x. The slide itself takes 200 ms, so even 4x
// (225 ms a move) still shows each piece travel.
const STEP_MS = 900;
const SPEEDS = [0.5, 1, 2, 4];
const SPEED_STORAGE = "uwuchess.replaySpeed";

const $ = (id) => document.getElementById(id);

// The same marks, run backwards.
const reverse = (m) => m && { from: m.to, to: m.from, rookFrom: m.rookTo, rookTo: m.rookFrom };

export class Replay {
  constructor() {
    this.board = null;
    this.timer = null;
    this.index = 0;
    this.frames = [];
    this.marks = [];
    this.view = {};
    const saved = Number(store.get(SPEED_STORAGE));
    this.speed = SPEEDS.includes(saved) ? saved : 1;
    this.syncSpeed();

    $("rpSpeed").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-speed]");
      if (btn) this.setSpeed(Number(btn.dataset.speed));
    });
    $("rpStart").addEventListener("click", () => this.jump(0));
    $("rpBack").addEventListener("click", () => this.step(-1));
    $("rpForward").addEventListener("click", () => this.step(1));
    $("rpEnd").addEventListener("click", () => this.jump(this.frames.length - 1));
    $("rpPlay").addEventListener("click", () => (this.timer ? this.pause() : this.play()));
    $("rpScrub").addEventListener("input", (e) => this.jump(Number(e.target.value)));
    $("moveList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-ply]");
      if (btn) this.jump(Number(btn.dataset.ply) + 1);
    });
    document.addEventListener("keydown", (e) => {
      if (!this.active || e.target.closest("input, textarea, .board")) return;
      if (e.key === "ArrowLeft") this.step(-1);
      else if (e.key === "ArrowRight") this.step(1);
      else return;
      e.preventDefault();
    });
  }

  // source: replaySource() or the four-player game's equivalent, with
  // `players` saying how the move list is laid out. view: { orientation,
  // coords }. Starts at the end, or from the first move and playing when
  // `autoplay` is set.
  load(source, view, { autoplay = false } = {}) {
    this.pause();
    this.active = true;
    this.view = view;
    this.board = source.board;
    this.frames = source.frames;
    this.marks = source.marks;
    const list = $("moveList");
    list.classList.toggle("four", source.players === 4);
    $("rpScrub").max = String(this.frames.length - 1);
    list.innerHTML = source.players === 4 ? rowsOfFour(source.plies) : rowsOfTwo(source.plies);

    if (autoplay && this.frames.length > 1) {
      this.show(0, null);
      this.timer = setTimeout(() => this.play(), 500);
      this.syncPlayButton(true);
    } else {
      this.show(this.frames.length - 1, null);
    }
  }

  stop() {
    this.pause();
    this.active = false;
  }

  show(i, animate) {
    if (!this.frames[i]) return;
    this.index = i;
    this.board.set({
      pos: this.frames[i],
      orientation: this.view.orientation,
      interactive: -1,
      lastMove: i > 0 ? this.marks[i - 1] : null,
      animate,
      showMoves: false,
      coords: this.view.coords,
    });
    $("rpScrub").value = String(i);
    const total = this.frames.length - 1;
    $("rpLabel").textContent = i === 0 ? `Start position, ${total} moves` : `Move ${i} of ${total}`;
    const list = $("moveList");
    list.querySelectorAll(".ply-btn").forEach((b) => {
      const on = Number(b.dataset.ply) === i - 1;
      b.classList.toggle("current", on);
      if (on) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
    // Keep the current move in view within the list, not the page.
    const current = list.querySelector(".ply-btn.current");
    if (current) {
      const top = current.offsetTop - list.offsetTop;
      if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - 24) list.scrollTop = top - 40;
    } else if (i === 0) {
      list.scrollTop = 0;
    }
    $("rpBack").disabled = $("rpStart").disabled = i === 0;
    $("rpForward").disabled = $("rpEnd").disabled = i === total;
  }

  step(delta, fromTimer = false) {
    if (!fromTimer) this.pause();
    const next = this.index + delta;
    if (next < 0 || next >= this.frames.length) return false;
    const animate = delta > 0 ? this.marks[this.index] : reverse(this.marks[next]);
    this.show(next, animate);
    return true;
  }

  // Straight to a move. One step either way still slides.
  jump(i) {
    this.pause();
    const target = Math.max(0, Math.min(this.frames.length - 1, i));
    if (Math.abs(target - this.index) === 1) this.step(target - this.index);
    else this.show(target, null);
  }

  get stepMs() {
    return STEP_MS / this.speed;
  }

  // Remembered in this browser. A replay that is playing picks the new pace
  // up from its next move, without restarting.
  setSpeed(speed) {
    if (!SPEEDS.includes(speed)) return;
    this.speed = speed;
    store.set(SPEED_STORAGE, String(speed));
    this.syncSpeed();
    if (this.timer && this.ticking) {
      clearTimeout(this.timer);
      this.timer = setTimeout(this.ticking, this.stepMs);
    }
  }

  syncSpeed() {
    document.querySelectorAll("#rpSpeed [data-speed]").forEach((el) => {
      el.setAttribute("aria-checked", String(Number(el.dataset.speed) === this.speed));
    });
  }

  play() {
    clearTimeout(this.timer);
    // Played to the end already: start over.
    if (this.index >= this.frames.length - 1) this.show(0, null);
    this.syncPlayButton(true);
    const tick = () => {
      if (!this.step(1, true) || this.index >= this.frames.length - 1) {
        this.pause();
        return;
      }
      this.timer = setTimeout(tick, this.stepMs);
    };
    this.ticking = tick;
    this.timer = setTimeout(tick, this.index === 0 ? Math.min(400, this.stepMs) : this.stepMs / 2);
  }

  pause() {
    clearTimeout(this.timer);
    this.timer = null;
    this.ticking = null;
    this.syncPlayButton(false);
  }

  syncPlayButton(playing) {
    const btn = $("rpPlay");
    btn.setAttribute("aria-label", playing ? "Pause" : "Play");
    btn.querySelector("[data-icon]").setAttribute("data-icon", playing ? "pause" : "play");
    hydrateIcons(btn);
  }
}

const plyButton = (p, i) =>
  `<button type="button" class="ply-btn" data-ply="${i}"${p.side >= 0 && p.side < 4 ? ` data-colour="${p.side}"` : ""}>${escapeHtml(p.san)}</button>`;

// White and Black side by side, numbered.
function rowsOfTwo(plies) {
  return plies
    .reduce((rows, p, i) => {
      const num = Math.floor(i / 2);
      // A game Black starts (never, in chess) would need an offset here.
      rows[num] ??= [];
      rows[num].push(plyButton(p, i));
      return rows;
    }, [])
    .map((pair, n) => `<li><span>${n + 1}.</span>${pair.join("")}</li>`)
    .join("");
}

// A row per round, a column per colour, gaps where somebody was out. Things
// that happen out of turn, such as a resignation, take their own row.
function rowsOfFour(plies) {
  const rows = [];
  let row = null;
  let last = 4;
  plies.forEach((p, i) => {
    const col = p.side >= 0 ? p.side : 0;
    if (!row || col <= last || p.event) {
      row = ["", "", "", ""];
      rows.push(row);
    }
    row[col] = plyButton(p, i);
    last = p.event ? 4 : col;
  });
  return rows.map((cells, n) => `<li><span>${n + 1}.</span>${cells.map((c) => c || "<span></span>").join("")}</li>`).join("");
}
