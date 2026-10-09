// The board on screen: squares, pieces, the last move, and input by tap,
// drag or keyboard. It knows the rules only through the position it is
// given, and reports a chosen move as its stored text; the game decides what
// happens next.
//
// Every move slides. The square a piece left keeps a grey box until the next
// move, so the old position stays readable at a glance.
//
// Castling takes any of the natural inputs: the king to its landing square,
// the king onto its rook, or the rook onto its king. In Chess960 the king can
// already stand on its landing square, and the rook is then the only way in.
//
// One view draws both boards. A geometry says how big the board is, where
// each square goes for each way round, and how its pieces look: GEOMETRY_8
// for two players, GEOMETRY_14 for four, with the cut-off corners left
// empty. The four-player board can also zoom, by pinching, the buttons or a
// trackpad, while it is the player's turn; dragging an empty square then
// moves the view around.

import { CASTLE, KING, colourOf, typeOf, squareName, square, fileOf, rankOf } from "./chess.js";
import { QUEEN, ROOK, BISHOP, KNIGHT } from "./chess.js";
import { fileOf4, rankOf4, square4, onBoard4, squareName4 } from "./chess4.js";
import { pieceSvg, pieceName, typeSvg, pieceSvg4, pieceName4, typeSvg4 } from "./pieces.js";
import { icon } from "./icons.js";

const SLIDE_MS = 200;
const DRAG_START_PX = 6;
const ZOOM_MAX = 2.6;
const ZOOM_STEP = 1.5;

export const GEOMETRY_8 = {
  size: 8,
  // Screen row and column for a square, row 0 at the top. Orientation is the
  // side at the bottom.
  place(sq, o) {
    const f = fileOf(sq);
    const r = rankOf(sq);
    return o === 0 ? { row: 7 - r, col: f } : { row: r, col: 7 - f };
  },
  squareAt(row, col, o) {
    return o === 0 ? square(col, 7 - row) : square(7 - col, row);
  },
  shade: (sq) => ((fileOf(sq) + rankOf(sq)) % 2 ? "light" : "dark"),
  name: squareName,
  pieceSvg,
  pieceName,
  typeSvg,
  coords(sq, row, col) {
    if (col !== 0 && row !== 7) return "";
    return `${col === 0 ? `<span class="coord rank">${rankOf(sq) + 1}</span>` : ""}${
      row === 7 ? `<span class="coord file">${"abcdefgh"[fileOf(sq)]}</span>` : ""
    }`;
  },
};

// Orientation is the colour at the bottom: 0 Red, 1 Blue, 2 Yellow, 3 Green,
// each a quarter turn on from the one before.
export const GEOMETRY_14 = {
  size: 14,
  place(sq, o) {
    const f = fileOf4(sq);
    const r = rankOf4(sq);
    switch (o) {
      case 1:
        return { row: 13 - f, col: 13 - r };
      case 2:
        return { row: r, col: 13 - f };
      case 3:
        return { row: f, col: r };
      default:
        return { row: 13 - r, col: f };
    }
  },
  squareAt(row, col, o) {
    if (row < 0 || col < 0 || row > 13 || col > 13) return -1;
    const [f, r] = [
      [col, 13 - row],
      [13 - row, 13 - col],
      [13 - col, row],
      [row, col],
    ][o] ?? [col, 13 - row];
    const sq = square4(f, r);
    return onBoard4(sq) ? sq : -1;
  },
  shade: (sq) => ((fileOf4(sq) + rankOf4(sq)) % 2 ? "light" : "dark"),
  name: squareName4,
  pieceSvg: pieceSvg4,
  pieceName: pieceName4,
  typeSvg: typeSvg4,
  // On the edge of the board, wherever the next square out is missing: the
  // letter or number that changes along that edge.
  coords(sq, row, col, o) {
    const name = squareName4(sq);
    const letter = name[0];
    const number = name.slice(1);
    const across = o % 2 ? number : letter;
    const down = o % 2 ? letter : number;
    const bottom = this.squareAt(row + 1, col, o) < 0;
    const left = this.squareAt(row, col - 1, o) < 0;
    return `${left ? `<span class="coord rank">${down}</span>` : ""}${bottom ? `<span class="coord file">${across}</span>` : ""}`;
  },
};

export class BoardView {
  constructor(root, { onMove, geometry = GEOMETRY_8, zoomable = false } = {}) {
    this.root = root;
    this.onMove = onMove ?? (() => {});
    this.geo = geometry;
    this.pos = null;
    this.legal = [];
    this.orientation = 0;
    this.interactive = -1;
    this.lastMove = null;
    this.selected = -1;
    this.focusSq = -1;
    this.showMoves = true;
    this.coords = true;
    this.drag = null;
    this.suppressClick = false;
    this.zoom = 1;
    this.canZoom = false;

    const grid = `<div class="board" role="group" aria-label="Chessboard" style="--size:${geometry.size}"></div>`;
    root.innerHTML = zoomable
      ? `<div class="board-viewport">${grid}</div>` +
        `<div class="zoom-controls hidden"><button type="button" class="icon-btn small zoom-out" aria-label="Zoom out">${icon("zoomOut")}</button>` +
        `<button type="button" class="icon-btn small zoom-in" aria-label="Zoom in">${icon("zoomIn")}</button></div>` +
        `<div class="promo-pick hidden" role="dialog" aria-label="Promote to"></div>`
      : `${grid}<div class="promo-pick hidden" role="dialog" aria-label="Promote to"></div>`;
    this.grid = root.querySelector(".board");
    this.picker = root.querySelector(".promo-pick");
    this.viewport = root.querySelector(".board-viewport");

    this.grid.addEventListener("click", (e) => this.onClick(e));
    this.grid.addEventListener("keydown", (e) => this.onKey(e));
    this.grid.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.picker.addEventListener("click", (e) => this.onPick(e));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.picker.classList.contains("hidden")) this.closePicker();
    });
    if (this.viewport) this.wireZoom();
  }

  /* ---- drawing ---- */

  // state: { pos, orientation, interactive (side that may move, -1 none),
  // lastMove { from, to, rookFrom?, rookTo?, castle? }, animate (a move to
  // slide in, or null), showMoves, coords, zoomable }
  set(state) {
    const samePos = state.pos === this.pos;
    this.pos = state.pos;
    this.legal = state.pos.moves();
    this.orientation = state.orientation ?? 0;
    this.interactive = state.interactive ?? -1;
    this.lastMove = state.lastMove ?? null;
    this.showMoves = state.showMoves ?? true;
    this.coords = state.coords ?? true;
    if (!samePos || !this.canMove(this.selected)) this.selected = -1;
    this.closePicker();
    if (this.viewport) this.setZoomable(Boolean(state.zoomable));
    this.draw();
    if (state.animate) this.slide(state.animate);
  }

  place(sq) {
    return this.geo.place(sq, this.orientation);
  }

  squareAt(row, col) {
    return this.geo.squareAt(row, col, this.orientation);
  }

  targets() {
    const out = new Map(); // square -> "move" | "capture" | "castle"
    if (this.selected < 0 || !this.showMoves) return out;
    const b = this.pos.board;
    for (const m of this.legal) {
      if (m.flags & CASTLE) {
        if (m.from === this.selected) {
          out.set(m.rookFrom, "castle");
          if (m.to !== m.from && !b[m.to]) out.set(m.to, out.get(m.to) ?? "move");
        } else if (m.rookFrom === this.selected) {
          out.set(m.from, "castle");
        }
        continue;
      }
      if (m.from === this.selected) out.set(m.to, m.captured ? "capture" : "move");
    }
    return out;
  }

  // The first square in the bottom left, where keyboard focus starts.
  firstSquare() {
    const n = this.geo.size;
    for (let row = n - 1; row >= 0; row--) {
      for (let col = 0; col < n; col++) {
        const sq = this.squareAt(row, col);
        if (sq >= 0) return sq;
      }
    }
    return -1;
  }

  draw() {
    const pos = this.pos;
    const geo = this.geo;
    const n = geo.size;
    const targets = this.targets();
    const checked = new Set(pos.checkedKings ? pos.checkedKings() : pos.inCheck() ? [pos.kings[pos.turn]] : []);
    const hadFocus = this.grid.contains(document.activeElement);
    if (this.focusSq < 0) this.focusSq = this.firstSquare();
    let html = "";

    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const sq = this.squareAt(row, col);
        if (sq < 0) {
          html += `<span class="sq void" aria-hidden="true"></span>`;
          continue;
        }
        const piece = pos.board[sq];
        const cls = ["sq", geo.shade(sq)];
        const lm = this.lastMove;
        if (lm && (sq === lm.from || sq === lm.rookFrom) && sq !== lm.to && sq !== lm.rookTo) cls.push("was");
        if (lm && (sq === lm.to || sq === lm.rookTo)) cls.push("now");
        if (sq === this.selected) cls.push("selected");
        if (checked.has(sq)) cls.push("check");
        const target = targets.get(sq);
        if (target) cls.push(`target-${target}`);

        let label = `${geo.name(sq)}, ${piece ? geo.pieceName(piece) : "empty"}`;
        if (target === "castle") label += ", castle";
        else if (target) label += target === "capture" ? ", capture" : ", move here";
        if (sq === this.selected) label += ", selected";

        const coord = this.coords ? geo.coords(sq, row, col, this.orientation) : "";
        html += `<button type="button" class="${cls.join(" ")}" data-sq="${sq}" tabindex="${sq === this.focusSq ? 0 : -1}" aria-label="${label}">${coord}${
          piece ? `<span class="piece" data-sq="${sq}">${geo.pieceSvg(piece)}</span>` : ""
        }</button>`;
      }
    }
    this.grid.innerHTML = html;
    if (hadFocus) this.focusSquare(this.focusSq);
  }

  squareEl(sq) {
    return this.grid.querySelector(`.sq[data-sq="${sq}"]`);
  }

  focusSquare(sq) {
    this.focusSq = sq;
    this.grid.querySelectorAll(".sq[data-sq]").forEach((el) => {
      el.tabIndex = Number(el.dataset.sq) === sq ? 0 : -1;
    });
    const el = this.squareEl(sq);
    el?.focus({ preventScroll: true });
    if (el && this.zoom > 1) this.keepInView(el);
  }

  // Slides the moved piece (and a castling rook) from where it was. Pieces
  // are drawn in their new squares, then offset back and released. Takes
  // one move's marks or several, for an undo that takes back two.
  slide(moves) {
    const pairs = [];
    for (const move of Array.isArray(moves) ? moves : [moves]) {
      pairs.push([move.from, move.to]);
      if (move.rookFrom >= 0 && move.rookTo >= 0) pairs.push([move.rookFrom, move.rookTo]);
    }
    const moving = [];
    for (const [from, to] of pairs) {
      if (from === to) continue;
      const el = this.squareEl(to)?.querySelector(".piece");
      if (!el) continue;
      const a = this.place(from);
      const b = this.place(to);
      el.style.transition = "none";
      el.style.transform = `translate(${(a.col - b.col) * 100}%, ${(a.row - b.row) * 100}%)`;
      el.classList.add("moving");
      moving.push(el);
    }
    if (!moving.length) return;
    // Commit the offset before releasing it, so the browser animates.
    void this.grid.offsetWidth;
    for (const el of moving) {
      el.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
      el.style.transform = "";
      el.addEventListener("transitionend", () => el.classList.remove("moving"), { once: true });
      setTimeout(() => el.classList.remove("moving"), SLIDE_MS + 50);
    }
  }

  /* ---- choosing a move ---- */

  canMove(sq) {
    if (sq < 0 || this.interactive < 0 || !this.pos) return false;
    const p = this.pos.board[sq];
    return Boolean(p) && colourOf(p) === this.interactive && this.pos.turn === this.interactive;
  }

  select(sq) {
    this.selected = this.canMove(sq) ? sq : -1;
    this.draw();
  }

  // The legal moves that going from `from` to `to` could mean.
  resolve(from, to) {
    const direct = this.legal.filter((m) => m.from === from && m.to === to && !(m.flags & CASTLE));
    if (direct.length) return direct;
    return this.legal.filter(
      (m) =>
        m.flags & CASTLE &&
        ((m.from === from && (m.rookFrom === to || m.to === to)) || (m.rookFrom === from && m.from === to))
    );
  }

  attempt(from, to) {
    const options = this.resolve(from, to);
    if (!options.length) return false;
    if (options.length > 1 && options.every((m) => m.promo)) {
      this.openPicker(options);
      return true;
    }
    this.selected = -1;
    this.onMove(this.pos.constructor.moveText(options[0]));
    return true;
  }

  onClick(e) {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const el = e.target.closest(".sq[data-sq]");
    if (!el) return;
    this.tap(Number(el.dataset.sq));
  }

  tap(sq) {
    this.focusSq = sq;
    if (this.selected >= 0) {
      if (sq === this.selected) return this.select(-1);
      if (this.attempt(this.selected, sq)) return;
    }
    // A tap on your own piece selects it; anything else clears.
    this.select(this.canMove(sq) ? sq : -1);
  }

  // Arrow keys move focus a square at a time, over the missing corners.
  onKey(e) {
    const el = e.target.closest(".sq[data-sq]");
    if (!el) return;
    const sq = Number(el.dataset.sq);
    const { row, col } = this.place(sq);
    const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (step) {
      e.preventDefault();
      const n = this.geo.size;
      for (let r = row + step[0], c = col + step[1]; r >= 0 && c >= 0 && r < n && c < n; r += step[0], c += step[1]) {
        const next = this.squareAt(r, c);
        if (next >= 0) {
          this.focusSquare(next);
          return;
        }
      }
      return;
    }
    if (e.key === "Escape" && this.selected >= 0) {
      e.preventDefault();
      this.select(-1);
    }
  }

  /* ---- dragging ---- */

  onPointerDown(e) {
    if (e.button !== 0 || this.pinch) return;
    const el = e.target.closest(".sq[data-sq]");
    if (!el) return;
    const sq = Number(el.dataset.sq);
    if (!this.canMove(sq)) return;
    const pieceEl = el.querySelector(".piece");
    const id = e.pointerId;
    this.drag = { sq, x: e.clientX, y: e.clientY, pieceEl, ghost: null, id };
    const move = (ev) => this.onPointerMove(ev);
    const up = (ev) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      this.onPointerUp(ev);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.ghost) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_START_PX) return;
      // Picked up: show where it can go, and a copy under the finger.
      if (this.selected !== d.sq) this.select(d.sq);
      const size = this.grid.getBoundingClientRect().width / this.geo.size;
      d.ghost = document.createElement("div");
      d.ghost.className = "drag-ghost";
      d.ghost.style.width = d.ghost.style.height = `${size}px`;
      d.ghost.innerHTML = this.geo.pieceSvg(this.pos.board[d.sq]);
      document.body.append(d.ghost);
      this.squareEl(d.sq)?.querySelector(".piece")?.classList.add("lifted");
    }
    e.preventDefault();
    const size = d.ghost.offsetWidth;
    d.ghost.style.transform = `translate(${e.clientX - size / 2}px, ${e.clientY - size / 2}px)`;
  }

  onPointerUp(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (!d.ghost) return;
    d.ghost.remove();
    // The click that follows a drop is not a tap.
    this.suppressClick = true;
    setTimeout(() => (this.suppressClick = false), 0);
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".sq[data-sq]");
    const to = under && this.grid.contains(under) ? Number(under.dataset.sq) : -1;
    if (to >= 0 && to !== d.sq && this.attempt(d.sq, to)) return;
    this.squareEl(d.sq)?.querySelector(".piece")?.classList.remove("lifted");
    // Dropped back where it started, or somewhere it cannot go: stay picked.
    this.select(d.sq);
  }

  // A drag given up for a pinch.
  cancelDrag() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    d.ghost?.remove();
    this.squareEl(d.sq)?.querySelector(".piece")?.classList.remove("lifted");
  }

  /* ---- zoom ----
     The board is drawn bigger inside a viewport that clips it, and the view
     moves by scrolling the viewport from code. Scrolling by finger is off:
     a finger on the board moves pieces. */

  setZoomable(on) {
    this.canZoom = on;
    this.root.querySelector(".zoom-controls").classList.toggle("hidden", !on);
    // Zoomed out again when the turn ends, to see what everybody else does.
    if (!on && this.zoom !== 1) this.setZoom(1);
    this.syncZoomButtons();
  }

  syncZoomButtons() {
    this.root.querySelector(".zoom-in").disabled = this.zoom >= ZOOM_MAX;
    this.root.querySelector(".zoom-out").disabled = this.zoom <= 1;
  }

  // Zooms to `z`, keeping the board point under (x, y), client coordinates,
  // where it is. Without a point: the selected piece, or the player's own
  // side of the board, which is always at the bottom.
  setZoom(z, x, y) {
    const vp = this.viewport;
    const rect = vp.getBoundingClientRect();
    const next = Math.min(ZOOM_MAX, Math.max(1, z));
    let ax;
    let ay;
    if (x === undefined) {
      const sel = this.selected >= 0 ? this.squareEl(this.selected)?.getBoundingClientRect() : null;
      ax = sel ? sel.left + sel.width / 2 - rect.left : rect.width / 2;
      ay = sel ? sel.top + sel.height / 2 - rect.top : rect.height * 0.82;
    } else {
      ax = x - rect.left;
      ay = y - rect.top;
    }
    const px = (vp.scrollLeft + ax) / this.zoom;
    const py = (vp.scrollTop + ay) / this.zoom;
    this.zoom = next;
    this.root.style.setProperty("--zoom", String(next));
    this.root.classList.toggle("zoomed", next > 1);
    // With no point given, the anchor moves to the middle of the view.
    const tx = x === undefined ? rect.width / 2 : ax;
    const ty = x === undefined ? rect.height / 2 : ay;
    vp.scrollLeft = px * next - tx;
    vp.scrollTop = py * next - ty;
    this.syncZoomButtons();
  }

  keepInView(el) {
    const vp = this.viewport.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.left < vp.left) this.viewport.scrollLeft -= vp.left - r.left;
    else if (r.right > vp.right) this.viewport.scrollLeft += r.right - vp.right;
    if (r.top < vp.top) this.viewport.scrollTop -= vp.top - r.top;
    else if (r.bottom > vp.bottom) this.viewport.scrollTop += r.bottom - vp.bottom;
  }

  wireZoom() {
    const vp = this.viewport;
    this.root.querySelector(".zoom-in").addEventListener("click", () => this.setZoom(this.zoom * ZOOM_STEP));
    this.root.querySelector(".zoom-out").addEventListener("click", () => this.setZoom(this.zoom / ZOOM_STEP));

    // Pinch, with pointers rather than touch events, so a pen or a mouse
    // with a finger on a touchpad both work.
    const pointers = new Map();
    let pan = null;
    vp.addEventListener("pointerdown", (e) => {
      if (!this.canZoom) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        this.cancelDrag();
        pan = null;
        const [a, b] = [...pointers.values()];
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: this.zoom };
        return;
      }
      // One finger on anything but a piece to move: the view moves.
      if (this.zoom > 1 && !this.drag) pan = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    });
    window.addEventListener("pointermove", (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        this.setZoom((this.pinch.zoom * dist) / this.pinch.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      if (pan && pan.id === e.pointerId) {
        const dx = e.clientX - pan.x;
        const dy = e.clientY - pan.y;
        if (!pan.moved && Math.hypot(dx, dy) < DRAG_START_PX) return;
        pan.moved = true;
        vp.scrollLeft -= dx;
        vp.scrollTop -= dy;
        pan.x = e.clientX;
        pan.y = e.clientY;
      }
    });
    const end = (e) => {
      if (!pointers.delete(e.pointerId)) return;
      if (pan?.id === e.pointerId && pan.moved) {
        // The click that ends a pan is not a tap.
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 0);
      }
      if (pan?.id === e.pointerId) pan = null;
      if (this.pinch && pointers.size < 2) {
        this.pinch = null;
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 0);
      }
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);

    // A trackpad pinch arrives as a wheel event with ctrlKey.
    vp.addEventListener(
      "wheel",
      (e) => {
        if (!this.canZoom || !e.ctrlKey) return;
        e.preventDefault();
        this.setZoom(this.zoom * Math.exp(-e.deltaY / 200), e.clientX, e.clientY);
      },
      { passive: false }
    );
  }

  /* ---- promotion ---- */

  openPicker(options) {
    const colour = colourOf(options[0].piece);
    const order = [QUEEN, ROOK, BISHOP, KNIGHT];
    this.pending = options;
    this.picker.innerHTML = `<p>Promote to</p><div class="promo-row">${order
      .map((t) => {
        const name = { [QUEEN]: "Queen", [ROOK]: "Rook", [BISHOP]: "Bishop", [KNIGHT]: "Knight" }[t];
        return `<button type="button" class="promo-btn" data-type="${t}" aria-label="${name}">${this.geo.typeSvg(t, colour)}</button>`;
      })
      .join("")}</div><button type="button" class="btn btn-quiet pill promo-cancel">Cancel</button>`;
    this.picker.classList.remove("hidden");
    this.picker.querySelector(".promo-btn").focus();
  }

  onPick(e) {
    if (e.target.closest(".promo-cancel")) return this.closePicker(true);
    const btn = e.target.closest(".promo-btn");
    if (!btn || !this.pending) return;
    const type = Number(btn.dataset.type);
    const m = this.pending.find((x) => typeOf(x.promo) === type);
    this.closePicker();
    this.selected = -1;
    if (m) this.onMove(this.pos.constructor.moveText(m));
  }

  closePicker(redraw = false) {
    this.pending = null;
    if (this.picker.classList.contains("hidden")) return;
    this.picker.classList.add("hidden");
    if (redraw) this.select(-1);
  }
}

// Where a stored move's pieces came from and went, for the last-move marks
// and the slide. Needs the position the move was played in.
export function moveMarks(pos, text) {
  const m = pos.findMove(text);
  if (!m) return null;
  return {
    from: m.from,
    to: m.to,
    rookFrom: m.flags & CASTLE ? m.rookFrom : -1,
    rookTo: m.flags & CASTLE ? m.rookTo : -1,
    king: typeOf(m.piece) === KING,
  };
}
