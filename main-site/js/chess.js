// Chess rules: positions, legal moves, and how a game ends. Chess960 aware.
//
// Pure: no DOM and no clock, so the page, the computer's Web Worker and the
// API's replay check all run this one file and always agree on what is legal.
//
// The board is 0x88: square = rank * 16 + file, rank 0 is White's back rank.
// A square is off the board when (square & 0x88) is not zero, which makes
// edge checks one AND instead of a rank and file comparison.

export const WHITE = 0;
export const BLACK = 1;

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

// A piece is its type with the colour in bit 3: white 1-6, black 9-14.
export const makePiece = (colour, type) => type | (colour << 3);
export const colourOf = (piece) => piece >> 3;
export const typeOf = (piece) => piece & 7;

// Move flags.
export const CAPTURE = 1;
export const DOUBLE = 2;
export const EN_PASSANT = 4;
export const CASTLE = 8;
export const PROMOTION = 16;

const KNIGHT_STEPS = [33, 31, 18, 14, -14, -18, -31, -33];
const KING_STEPS = [1, -1, 16, -16, 15, 17, -15, -17];
const BISHOP_STEPS = [15, 17, -15, -17];
const ROOK_STEPS = [1, -1, 16, -16];

const LETTERS = ".pnbrqk";
const PROMOTIONS = [QUEEN, ROOK, BISHOP, KNIGHT];

// Castling rights live in four slots, each holding the square of the rook
// that may still castle, or -1. Keyed by rook square rather than a flag so
// Chess960, where the rook can start on any file, needs nothing special.
const WHITE_SHORT = 0;
const WHITE_LONG = 1;
const BLACK_SHORT = 2;
const BLACK_LONG = 3;

export const square = (file, rank) => rank * 16 + file;
export const fileOf = (sq) => sq & 7;
export const rankOf = (sq) => sq >> 4;
export const onBoard = (sq) => (sq & 0x88) === 0;
export const squareName = (sq) => "abcdefgh"[fileOf(sq)] + (rankOf(sq) + 1);

export function parseSquare(name) {
  const m = /^([a-h])([1-8])$/.exec(name ?? "");
  return m ? square(m[1].charCodeAt(0) - 97, Number(m[2]) - 1) : -1;
}

/* ---- hashing ----
   Zobrist keys from a fixed seed, so every copy of this file makes the same
   table. Two 32 bit halves; a repetition key uses 21 bits of one and all 32
   of the other, 53 bits in all, which a JavaScript number holds exactly. */

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const zrand = mulberry(0x5eed0c55);
const Z_PIECE_LO = new Int32Array(16 * 128);
const Z_PIECE_HI = new Int32Array(16 * 128);
for (let i = 0; i < 16 * 128; i++) {
  Z_PIECE_LO[i] = zrand();
  Z_PIECE_HI[i] = zrand();
}
const Z_CASTLE_LO = new Int32Array(128);
const Z_CASTLE_HI = new Int32Array(128);
for (let i = 0; i < 128; i++) {
  Z_CASTLE_LO[i] = zrand();
  Z_CASTLE_HI[i] = zrand();
}
const Z_EP_LO = new Int32Array(8);
const Z_EP_HI = new Int32Array(8);
for (let i = 0; i < 8; i++) {
  Z_EP_LO[i] = zrand();
  Z_EP_HI[i] = zrand();
}
const Z_SIDE_LO = zrand() | 0;
const Z_SIDE_HI = zrand() | 0;

/* ---- Chess960 start positions ----
   The standard numbering, 0 to 959, in which 518 is the ordinary start. */

const KRN = ["NNRKR", "NRNKR", "NRKNR", "NRKRN", "RNNKR", "RNKNR", "RNKRN", "RKNNR", "RKNRN", "RKRNN"];
export const STANDARD_INDEX = 518;

export function backRank960(index) {
  const rank = new Array(8).fill("");
  let n = index;
  rank[(n % 4) * 2 + 1] = "B";
  n = Math.floor(n / 4);
  rank[(n % 4) * 2] = "B";
  n = Math.floor(n / 4);
  const empties = () => rank.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
  rank[empties()[n % 6]] = "Q";
  n = Math.floor(n / 6);
  const krn = KRN[n];
  empties().forEach((file, i) => {
    rank[file] = krn[i];
  });
  return rank.join("");
}

export class Position {
  constructor() {
    this.board = new Int8Array(128);
    this.turn = WHITE;
    this.castle = [-1, -1, -1, -1];
    this.ep = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.kings = [-1, -1];
    this.lo = 0;
    this.hi = 0;
    this.undo = [];
    // One key per position reached, the current one last. Repetition counts
    // come from here.
    this.keys = [];
  }

  /* ---- setting up ---- */

  // A back rank such as "RNBQKBNR", mirrored for Black, pawns in front.
  static fromBackRank(rank) {
    const pos = new Position();
    const types = { P: PAWN, N: KNIGHT, B: BISHOP, R: ROOK, Q: QUEEN, K: KING };
    for (let f = 0; f < 8; f++) {
      pos.board[square(f, 0)] = makePiece(WHITE, types[rank[f]]);
      pos.board[square(f, 1)] = makePiece(WHITE, PAWN);
      pos.board[square(f, 6)] = makePiece(BLACK, PAWN);
      pos.board[square(f, 7)] = makePiece(BLACK, types[rank[f]]);
    }
    const king = rank.indexOf("K");
    const shortRook = rank.lastIndexOf("R");
    const longRook = rank.indexOf("R");
    pos.castle = [square(shortRook, 0), square(longRook, 0), square(shortRook, 7), square(longRook, 7)];
    pos.kings = [square(king, 0), square(king, 7)];
    pos.rehash();
    return pos;
  }

  static fromIndex(index) {
    return Position.fromBackRank(backRank960(index));
  }

  // FEN, with castling as KQkq (outermost rook) or Shredder file letters.
  // Used by the tests; games start from fromIndex.
  static fromFEN(fen) {
    const [placement, side, castling = "-", ep = "-", half = "0", full = "1"] = fen.trim().split(/\s+/);
    const pos = new Position();
    const types = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };
    placement.split("/").forEach((row, i) => {
      const rank = 7 - i;
      let file = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) {
          file += Number(ch);
          continue;
        }
        const colour = ch === ch.toUpperCase() ? WHITE : BLACK;
        const type = types[ch.toLowerCase()];
        pos.board[square(file, rank)] = makePiece(colour, type);
        if (type === KING) pos.kings[colour] = square(file, rank);
        file++;
      }
    });
    pos.turn = side === "b" ? BLACK : WHITE;
    for (const ch of castling === "-" ? "" : castling) {
      const colour = ch === ch.toUpperCase() ? WHITE : BLACK;
      const back = colour === WHITE ? 0 : 7;
      const kingFile = fileOf(pos.kings[colour]);
      const rook = makePiece(colour, ROOK);
      const lower = ch.toLowerCase();
      let file = -1;
      if (lower === "k") {
        for (let f = 7; f > kingFile; f--) if (pos.board[square(f, back)] === rook) { file = f; break; }
      } else if (lower === "q") {
        for (let f = 0; f < kingFile; f++) if (pos.board[square(f, back)] === rook) { file = f; break; }
      } else {
        file = lower.charCodeAt(0) - 97;
      }
      if (file < 0) continue;
      const slot = (colour === WHITE ? 0 : 2) + (file > kingFile ? 0 : 1);
      pos.castle[slot] = square(file, back);
    }
    pos.ep = parseSquare(ep);
    pos.halfmove = Number(half) || 0;
    pos.fullmove = Number(full) || 1;
    pos.rehash();
    return pos;
  }

  rehash() {
    let lo = 0;
    let hi = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (!onBoard(sq) || !this.board[sq]) continue;
      lo ^= Z_PIECE_LO[this.board[sq] * 128 + sq];
      hi ^= Z_PIECE_HI[this.board[sq] * 128 + sq];
    }
    for (const rs of this.castle) {
      if (rs < 0) continue;
      lo ^= Z_CASTLE_LO[rs];
      hi ^= Z_CASTLE_HI[rs];
    }
    if (this.ep >= 0) {
      lo ^= Z_EP_LO[fileOf(this.ep)];
      hi ^= Z_EP_HI[fileOf(this.ep)];
    }
    if (this.turn === BLACK) {
      lo ^= Z_SIDE_LO;
      hi ^= Z_SIDE_HI;
    }
    this.lo = lo;
    this.hi = hi;
    this.keys = [this.key()];
  }

  key() {
    return (this.hi & 0x1fffff) * 4294967296 + (this.lo >>> 0);
  }

  toFEN() {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = "";
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.board[square(f, r)];
        if (!p) {
          empty++;
          continue;
        }
        if (empty) row += empty;
        empty = 0;
        const ch = LETTERS[typeOf(p)];
        row += colourOf(p) === WHITE ? ch.toUpperCase() : ch;
      }
      rows.push(row + (empty || ""));
    }
    const letters = this.castle
      .map((rs, slot) => {
        if (rs < 0) return "";
        const ch = "abcdefgh"[fileOf(rs)];
        return slot < 2 ? ch.toUpperCase() : ch;
      })
      .join("");
    return [
      rows.join("/"),
      this.turn === WHITE ? "w" : "b",
      letters || "-",
      this.ep >= 0 ? squareName(this.ep) : "-",
      this.halfmove,
      this.fullmove,
    ].join(" ");
  }

  /* ---- attacks ---- */

  isAttacked(sq, by) {
    const b = this.board;
    // Pawns attack diagonally forward, so look diagonally backward from sq.
    if (by === WHITE) {
      const pawn = makePiece(WHITE, PAWN);
      if (onBoard(sq - 15) && b[sq - 15] === pawn) return true;
      if (onBoard(sq - 17) && b[sq - 17] === pawn) return true;
    } else {
      const pawn = makePiece(BLACK, PAWN);
      if (onBoard(sq + 15) && b[sq + 15] === pawn) return true;
      if (onBoard(sq + 17) && b[sq + 17] === pawn) return true;
    }
    const knight = makePiece(by, KNIGHT);
    for (const step of KNIGHT_STEPS) {
      const from = sq + step;
      if (onBoard(from) && b[from] === knight) return true;
    }
    const king = makePiece(by, KING);
    for (const step of KING_STEPS) {
      const from = sq + step;
      if (onBoard(from) && b[from] === king) return true;
    }
    const bishop = makePiece(by, BISHOP);
    const rook = makePiece(by, ROOK);
    const queen = makePiece(by, QUEEN);
    for (const step of BISHOP_STEPS) {
      let from = sq + step;
      while (onBoard(from)) {
        const p = b[from];
        if (p) {
          if (p === bishop || p === queen) return true;
          break;
        }
        from += step;
      }
    }
    for (const step of ROOK_STEPS) {
      let from = sq + step;
      while (onBoard(from)) {
        const p = b[from];
        if (p) {
          if (p === rook || p === queen) return true;
          break;
        }
        from += step;
      }
    }
    return false;
  }

  inCheck(colour = this.turn) {
    return this.isAttacked(this.kings[colour], colour ^ 1);
  }

  /* ---- move generation ---- */

  // Pseudo-legal moves: everything but leaving your own king attacked, which
  // moves() filters out. Castling is checked in full here.
  pseudoMoves(capturesOnly = false) {
    const moves = [];
    const b = this.board;
    const us = this.turn;
    const them = us ^ 1;

    const add = (from, to, piece, flags, promo = 0) => {
      moves.push({ from, to, piece, captured: b[to], promo, flags, rookFrom: -1, rookTo: -1 });
    };

    for (let from = 0; from < 128; from++) {
      if (!onBoard(from)) {
        from += 7;
        continue;
      }
      const piece = b[from];
      if (!piece || colourOf(piece) !== us) continue;
      const type = typeOf(piece);

      if (type === PAWN) {
        const up = us === WHITE ? 16 : -16;
        const startRank = us === WHITE ? 1 : 6;
        const lastRank = us === WHITE ? 7 : 0;
        const one = from + up;
        if (onBoard(one) && !b[one]) {
          if (rankOf(one) === lastRank) {
            for (const promo of PROMOTIONS) add(from, one, piece, PROMOTION, makePiece(us, promo));
          } else if (!capturesOnly) {
            add(from, one, piece, 0);
            const two = one + up;
            if (rankOf(from) === startRank && !b[two]) add(from, two, piece, DOUBLE);
          }
        }
        for (const side of [up - 1, up + 1]) {
          const to = from + side;
          if (!onBoard(to)) continue;
          const target = b[to];
          if (target && colourOf(target) === them) {
            if (rankOf(to) === lastRank) {
              for (const promo of PROMOTIONS) add(from, to, piece, CAPTURE | PROMOTION, makePiece(us, promo));
            } else {
              add(from, to, piece, CAPTURE);
            }
          } else if (to === this.ep) {
            moves.push({
              from,
              to,
              piece,
              captured: makePiece(them, PAWN),
              promo: 0,
              flags: CAPTURE | EN_PASSANT,
              rookFrom: -1,
              rookTo: -1,
            });
          }
        }
        continue;
      }

      const steps =
        type === KNIGHT ? KNIGHT_STEPS : type === BISHOP ? BISHOP_STEPS : type === ROOK ? ROOK_STEPS : KING_STEPS;
      const slides = type === BISHOP || type === ROOK || type === QUEEN;

      for (const step of steps) {
        let to = from + step;
        while (onBoard(to)) {
          const target = b[to];
          if (target) {
            if (colourOf(target) === them) add(from, to, piece, CAPTURE);
            break;
          }
          if (!capturesOnly) add(from, to, piece, 0);
          if (!slides) break;
          to += step;
        }
      }
    }

    if (!capturesOnly) this.castlingMoves(moves);
    return moves;
  }

  castlingMoves(moves) {
    const us = this.turn;
    const them = us ^ 1;
    const kingFrom = this.kings[us];
    const back = us === WHITE ? 0 : 7;
    const rookPiece = makePiece(us, ROOK);

    for (const long of [false, true]) {
      const rookFrom = this.castle[(us === WHITE ? 0 : 2) + (long ? 1 : 0)];
      if (rookFrom < 0 || this.board[rookFrom] !== rookPiece) continue;
      const kingTo = square(long ? 2 : 6, back);
      const rookTo = square(long ? 3 : 5, back);

      // Every square the king or rook crosses or lands on is empty, apart
      // from the king and that rook themselves.
      const lo = Math.min(kingFrom, kingTo, rookFrom, rookTo);
      const hi = Math.max(kingFrom, kingTo, rookFrom, rookTo);
      let clear = true;
      for (let sq = lo; sq <= hi; sq++) {
        if (sq !== kingFrom && sq !== rookFrom && this.board[sq]) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;

      // Not out of check, and not through or into it. The landing square is
      // checked again after the move, with the rook gone from its old square.
      const step = kingTo > kingFrom ? 1 : -1;
      let safe = true;
      for (let sq = kingFrom; ; sq += step) {
        if (this.isAttacked(sq, them)) {
          safe = false;
          break;
        }
        if (sq === kingTo) break;
      }
      if (!safe) continue;

      moves.push({
        from: kingFrom,
        to: kingTo,
        piece: makePiece(us, KING),
        captured: 0,
        promo: 0,
        flags: CASTLE,
        rookFrom,
        rookTo,
      });
    }
  }

  // Legal moves. With capturesOnly, captures and promotions, for the
  // computer's quiescence search.
  moves(capturesOnly = false) {
    const legal = [];
    const us = this.turn;
    for (const m of this.pseudoMoves(capturesOnly)) {
      this.make(m);
      if (!this.isAttacked(this.kings[us], us ^ 1)) legal.push(m);
      this.unmake();
    }
    return legal;
  }

  /* ---- making and unmaking ---- */

  xorPiece(piece, sq) {
    this.lo ^= Z_PIECE_LO[piece * 128 + sq];
    this.hi ^= Z_PIECE_HI[piece * 128 + sq];
  }

  make(m) {
    const b = this.board;
    const us = this.turn;
    const them = us ^ 1;
    this.undo.push({
      move: m,
      castle: this.castle.slice(),
      ep: this.ep,
      halfmove: this.halfmove,
      lo: this.lo,
      hi: this.hi,
      kings: this.kings.slice(),
    });

    if (this.ep >= 0) {
      this.lo ^= Z_EP_LO[fileOf(this.ep)];
      this.hi ^= Z_EP_HI[fileOf(this.ep)];
    }
    this.ep = -1;

    if (m.flags & CASTLE) {
      const rook = b[m.rookFrom];
      // Both lifted before either lands: in Chess960 the king can land where
      // the rook stood, or stay where it is.
      b[m.from] = 0;
      b[m.rookFrom] = 0;
      this.xorPiece(m.piece, m.from);
      this.xorPiece(rook, m.rookFrom);
      b[m.to] = m.piece;
      b[m.rookTo] = rook;
      this.xorPiece(m.piece, m.to);
      this.xorPiece(rook, m.rookTo);
      this.kings[us] = m.to;
    } else {
      if (m.flags & EN_PASSANT) {
        const capSq = m.to + (us === WHITE ? -16 : 16);
        this.xorPiece(b[capSq], capSq);
        b[capSq] = 0;
      } else if (b[m.to]) {
        this.xorPiece(b[m.to], m.to);
      }
      const placed = m.promo || m.piece;
      b[m.from] = 0;
      this.xorPiece(m.piece, m.from);
      b[m.to] = placed;
      this.xorPiece(placed, m.to);
      if (typeOf(m.piece) === KING) this.kings[us] = m.to;

      if (m.flags & DOUBLE) {
        // Only recorded when a pawn could take it, so positions that differ
        // in nothing a player could use hash the same for repetition.
        const pawn = makePiece(them, PAWN);
        const left = m.to - 1;
        const right = m.to + 1;
        if ((onBoard(left) && b[left] === pawn) || (onBoard(right) && b[right] === pawn)) {
          this.ep = (m.from + m.to) >> 1;
          this.lo ^= Z_EP_LO[fileOf(this.ep)];
          this.hi ^= Z_EP_HI[fileOf(this.ep)];
        }
      }
    }

    // A king move ends both of its castling rights; a rook leaving its
    // square, or captured on it, ends that one.
    for (let slot = 0; slot < 4; slot++) {
      const rs = this.castle[slot];
      if (rs < 0) continue;
      const owner = slot < 2 ? WHITE : BLACK;
      if (
        rs === m.from ||
        rs === m.to ||
        (m.flags & CASTLE && owner === us) ||
        (typeOf(m.piece) === KING && owner === us)
      ) {
        this.lo ^= Z_CASTLE_LO[rs];
        this.hi ^= Z_CASTLE_HI[rs];
        this.castle[slot] = -1;
      }
    }

    this.halfmove = typeOf(m.piece) === PAWN || m.flags & CAPTURE ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.turn = them;
    this.lo ^= Z_SIDE_LO;
    this.hi ^= Z_SIDE_HI;
    this.keys.push(this.key());
  }

  unmake() {
    const u = this.undo.pop();
    const m = u.move;
    const b = this.board;
    this.turn ^= 1;
    const us = this.turn;
    if (us === BLACK) this.fullmove--;

    if (m.flags & CASTLE) {
      const rook = b[m.rookTo];
      b[m.to] = 0;
      b[m.rookTo] = 0;
      b[m.from] = m.piece;
      b[m.rookFrom] = rook;
    } else {
      b[m.from] = m.piece;
      if (m.flags & EN_PASSANT) {
        b[m.to] = 0;
        b[m.to + (us === WHITE ? -16 : 16)] = m.captured;
      } else {
        b[m.to] = m.captured;
      }
    }

    this.castle = u.castle;
    this.ep = u.ep;
    this.halfmove = u.halfmove;
    this.lo = u.lo;
    this.hi = u.hi;
    this.kings = u.kings;
    this.keys.pop();
  }

  // A pass, for the computer's null move pruning. Never in check.
  makeNull() {
    this.undo.push({ move: null, ep: this.ep, lo: this.lo, hi: this.hi, halfmove: this.halfmove });
    if (this.ep >= 0) {
      this.lo ^= Z_EP_LO[fileOf(this.ep)];
      this.hi ^= Z_EP_HI[fileOf(this.ep)];
    }
    this.ep = -1;
    this.turn ^= 1;
    this.lo ^= Z_SIDE_LO;
    this.hi ^= Z_SIDE_HI;
    this.halfmove++;
    this.keys.push(this.key());
  }

  unmakeNull() {
    const u = this.undo.pop();
    this.turn ^= 1;
    this.ep = u.ep;
    this.lo = u.lo;
    this.hi = u.hi;
    this.halfmove = u.halfmove;
    this.keys.pop();
  }

  /* ---- the end of the game ---- */

  // How many times the current position has occurred, this time included.
  // Only positions since the last capture or pawn move can match.
  repetitions() {
    const keys = this.keys;
    const now = keys[keys.length - 1];
    let count = 1;
    const earliest = Math.max(0, keys.length - 1 - this.halfmove);
    for (let i = keys.length - 3; i >= earliest; i -= 2) {
      if (keys[i] === now) count++;
    }
    return count;
  }

  insufficientMaterial() {
    const minors = [];
    for (let sq = 0; sq < 128; sq++) {
      if (!onBoard(sq)) continue;
      const p = this.board[sq];
      if (!p) continue;
      const t = typeOf(p);
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      if (t === KNIGHT || t === BISHOP) minors.push({ t, shade: (fileOf(sq) + rankOf(sq)) & 1 });
    }
    if (minors.length <= 1) return true;
    // Bishops alone, all on one colour of square, can never mate.
    return minors.every((m) => m.t === BISHOP) && minors.every((m) => m.shade === minors[0].shade);
  }

  // null while the game goes on, otherwise { result, reason, winner }.
  // Threefold repetition and the fifty-move rule end the game at once
  // rather than waiting to be claimed.
  outcome() {
    const legal = this.moves();
    if (legal.length === 0) {
      if (this.inCheck()) {
        const winner = this.turn ^ 1;
        return { result: winner === WHITE ? "1-0" : "0-1", reason: "checkmate", winner };
      }
      return { result: "1/2-1/2", reason: "stalemate", winner: -1 };
    }
    if (this.insufficientMaterial()) return { result: "1/2-1/2", reason: "material", winner: -1 };
    if (this.halfmove >= 100) return { result: "1/2-1/2", reason: "fifty", winner: -1 };
    if (this.repetitions() >= 3) return { result: "1/2-1/2", reason: "repetition", winner: -1 };
    return null;
  }

  /* ---- notation ---- */

  // The form moves are stored and sent in: "e2e4", "e7e8q", and "O-O" or
  // "O-O-O" for castling, which in Chess960 is clearer than a king move.
  static moveText(m) {
    if (m.flags & CASTLE) return fileOf(m.rookFrom) > fileOf(m.from) ? "O-O" : "O-O-O";
    return squareName(m.from) + squareName(m.to) + (m.promo ? LETTERS[typeOf(m.promo)] : "");
  }

  // The legal move a stored move stands for, or null.
  findMove(text) {
    if (typeof text !== "string" || text.length > 6) return null;
    return this.moves().find((m) => Position.moveText(m) === text) ?? null;
  }

  // Standard algebraic notation, for the move list and announcements.
  san(m, legal = this.moves()) {
    let text;
    if (m.flags & CASTLE) {
      text = fileOf(m.rookFrom) > fileOf(m.from) ? "O-O" : "O-O-O";
    } else {
      const type = typeOf(m.piece);
      const capture = m.flags & CAPTURE ? "x" : "";
      if (type === PAWN) {
        text = (capture ? "abcdefgh"[fileOf(m.from)] : "") + capture + squareName(m.to);
        if (m.promo) text += "=" + LETTERS[typeOf(m.promo)].toUpperCase();
      } else {
        const rivals = legal.filter(
          (o) => o.from !== m.from && o.piece === m.piece && o.to === m.to && !(o.flags & CASTLE)
        );
        let which = "";
        if (rivals.length) {
          const sameFile = rivals.some((o) => fileOf(o.from) === fileOf(m.from));
          const sameRank = rivals.some((o) => rankOf(o.from) === rankOf(m.from));
          if (!sameFile) which = "abcdefgh"[fileOf(m.from)];
          else if (!sameRank) which = String(rankOf(m.from) + 1);
          else which = squareName(m.from);
        }
        text = LETTERS[type].toUpperCase() + which + capture + squareName(m.to);
      }
    }
    this.make(m);
    if (this.inCheck()) text += this.moves().length === 0 ? "#" : "+";
    this.unmake();
    return text;
  }

  pieceAt(sq) {
    return this.board[sq];
  }

  clone() {
    const pos = new Position();
    pos.board = this.board.slice();
    pos.turn = this.turn;
    pos.castle = this.castle.slice();
    pos.ep = this.ep;
    pos.halfmove = this.halfmove;
    pos.fullmove = this.fullmove;
    pos.kings = this.kings.slice();
    pos.lo = this.lo;
    pos.hi = this.hi;
    pos.keys = this.keys.slice();
    return pos;
  }
}

// Moves below a position, for testing the generator against known counts.
export function perft(pos, depth) {
  if (depth === 0) return 1;
  const moves = pos.moves();
  if (depth === 1) return moves.length;
  let total = 0;
  for (const m of moves) {
    pos.make(m);
    total += perft(pos, depth - 1);
    pos.unmake();
  }
  return total;
}
