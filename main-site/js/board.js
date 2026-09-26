// The board on screen: squares, pieces, the last move, and input by tap,
// drag or keyboard. It knows the rules only through chess.js, and reports a
// chosen move as its stored text; the game decides what happens next.
//
// Every move slides. The square a piece left keeps a grey box until the next
// move, so the old position stays readable at a glance.
//
// Castling takes any of the natural inputs: the king to its landing square,
// the king onto its rook, or the rook onto its king. In Chess960 the king can
// already stand on its landing square, and the rook is then the only way in.

import { Position, CASTLE, KING, colourOf, typeOf, squareName, square, fileOf, rankOf } from "./chess.js";
import { pieceSvg, pieceName, typeSvg } from "./pieces.js";
import { QUEEN, ROOK, BISHOP, KNIGHT } from "./chess.js";

const SLIDE_MS = 200;
const DRAG_START_PX = 6;

export class BoardView {
  constructor(root, { onMove } = {}) {
    this.root = root;
    this.onMove = onMove ?? (() => {});
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

    root.innerHTML = `<div class="board" role="group" aria-label="Chessboard"></div><div class="promo-pick hidden" role="dialog" aria-label="Promote to"></div>`;
    this.grid = root.querySelector(".board");
    this.picker = root.querySelector(".promo-pick");

    this.grid.addEventListener("click", (e) => this.onClick(e));
    this.grid.addEventListener("keydown", (e) => this.onKey(e));
    this.grid.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.picker.addEventListener("click", (e) => this.onPick(e));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.picker.classList.contains("hidden")) this.closePicker();
    });
  }

  /* ---- drawing ---- */

  // state: { pos, orientation, interactive (side that may move, -1 none),
  // lastMove { from, to, rookFrom?, rookTo?, castle? }, animate (a move to
  // slide in, or null), showMoves, coords }
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
    this.draw();
    if (state.animate) this.slide(state.animate);
  }

  // Screen row and column for a square, row 0 at the top.
  place(sq) {
    const f = fileOf(sq);
    const r = rankOf(sq);
    return this.orientation === 0 ? { row: 7 - r, col: f } : { row: r, col: 7 - f };
  }

  squareAt(row, col) {
    return this.orientation === 0 ? square(col, 7 - row) : square(7 - col, row);
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

  draw() {
    const pos = this.pos;
    const targets = this.targets();
    const checked = pos.inCheck() ? pos.kings[pos.turn] : -1;
    const hadFocus = this.grid.contains(document.activeElement);
    if (this.focusSq < 0) this.focusSq = this.squareAt(7, 0);
    let html = "";

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const sq = this.squareAt(row, col);
        const piece = pos.board[sq];
        const cls = ["sq", (fileOf(sq) + rankOf(sq)) % 2 ? "light" : "dark"];
        const lm = this.lastMove;
        if (lm && (sq === lm.from || sq === lm.rookFrom) && sq !== lm.to && sq !== lm.rookTo) cls.push("was");
        if (lm && (sq === lm.to || sq === lm.rookTo)) cls.push("now");
        if (sq === this.selected) cls.push("selected");
        if (sq === checked) cls.push("check");
        const target = targets.get(sq);
        if (target) cls.push(`target-${target}`);

        let label = `${squareName(sq)}, ${piece ? pieceName(piece) : "empty"}`;
        if (target === "castle") label += ", castle";
        else if (target) label += target === "capture" ? ", capture" : ", move here";
        if (sq === this.selected) label += ", selected";

        const coord =
          this.coords && (col === 0 || row === 7)
            ? `${col === 0 ? `<span class="coord rank">${rankOf(sq) + 1}</span>` : ""}${
                row === 7 ? `<span class="coord file">${"abcdefgh"[fileOf(sq)]}</span>` : ""
              }`
            : "";

        html += `<button type="button" class="${cls.join(" ")}" data-sq="${sq}" tabindex="${sq === this.focusSq ? 0 : -1}" aria-label="${label}">${coord}${
          piece ? `<span class="piece" data-sq="${sq}">${pieceSvg(piece)}</span>` : ""
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
    this.grid.querySelectorAll(".sq").forEach((el) => {
      el.tabIndex = Number(el.dataset.sq) === sq ? 0 : -1;
    });
    this.squareEl(sq)?.focus({ preventScroll: true });
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
    this.onMove(Position.moveText(options[0]));
    return true;
  }

  onClick(e) {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const el = e.target.closest(".sq");
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

  onKey(e) {
    const el = e.target.closest(".sq");
    if (!el) return;
    const sq = Number(el.dataset.sq);
    const { row, col } = this.place(sq);
    const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (step) {
      e.preventDefault();
      const r = Math.min(7, Math.max(0, row + step[0]));
      const c = Math.min(7, Math.max(0, col + step[1]));
      this.focusSquare(this.squareAt(r, c));
      return;
    }
    if (e.key === "Escape" && this.selected >= 0) {
      e.preventDefault();
      this.select(-1);
    }
  }

  /* ---- dragging ---- */

  onPointerDown(e) {
    if (e.button !== 0) return;
    const el = e.target.closest(".sq");
    if (!el) return;
    const sq = Number(el.dataset.sq);
    if (!this.canMove(sq)) return;
    const pieceEl = el.querySelector(".piece");
    this.drag = { sq, x: e.clientX, y: e.clientY, pieceEl, ghost: null, id: e.pointerId };
    const move = (ev) => this.onPointerMove(ev);
    const up = (ev) => {
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
      const size = this.grid.getBoundingClientRect().width / 8;
      d.ghost = document.createElement("div");
      d.ghost.className = "drag-ghost";
      d.ghost.style.width = d.ghost.style.height = `${size}px`;
      d.ghost.innerHTML = pieceSvg(this.pos.board[d.sq]);
      document.body.append(d.ghost);
      this.squareEl(d.sq)?.querySelector(".piece")?.classList.add("lifted");
    }
    e.preventDefault();
    const size = d.ghost.offsetWidth;
    d.ghost.style.transform = `translate(${e.clientX - size / 2}px, ${e.clientY - size / 2}px)`;
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d?.ghost) return;
    d.ghost.remove();
    // The click that follows a drop is not a tap.
    this.suppressClick = true;
    setTimeout(() => (this.suppressClick = false), 0);
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".sq");
    const to = under && this.grid.contains(under) ? Number(under.dataset.sq) : -1;
    if (to >= 0 && to !== d.sq && this.attempt(d.sq, to)) return;
    this.squareEl(d.sq)?.querySelector(".piece")?.classList.remove("lifted");
    // Dropped back where it started, or somewhere it cannot go: stay picked.
    this.select(d.sq);
  }

  /* ---- promotion ---- */

  openPicker(options) {
    const colour = colourOf(options[0].piece);
    const order = [QUEEN, ROOK, BISHOP, KNIGHT];
    this.pending = options;
    this.picker.innerHTML = `<p>Promote to</p><div class="promo-row">${order
      .map((t) => {
        const name = { [QUEEN]: "Queen", [ROOK]: "Rook", [BISHOP]: "Bishop", [KNIGHT]: "Knight" }[t];
        return `<button type="button" class="promo-btn" data-type="${t}" aria-label="${name}">${typeSvg(t, colour)}</button>`;
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
    if (m) this.onMove(Position.moveText(m));
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
