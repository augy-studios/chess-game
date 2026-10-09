// Four-player chess: the rules, on the 14 by 14 cross board with its three by
// three corners cut away. Red at the bottom, then Blue on the left, Yellow at
// the top and Green on the right, moving in that order, clockwise.
//
// Two ways to play. Free-for-all: a player who is checkmated, stalemated,
// resigns or runs out of time is out, and their pieces stay on the board in
// grey, as obstacles anyone can take. The last king standing wins. Teams:
// partners sit opposite (Red with Yellow, Blue with Green), cannot take each
// other's pieces, and the first player out loses it for their team.
//
// Where this differs from two-player chess: pawns promote at the centre line,
// on the eighth rank counted from their own side; there is no en passant; and
// a king left attacked by somebody else's move can be taken by whoever gets
// there first, which puts its player out.
//
// Pure, like chess.js: no DOM and no clock, so the page and the computer's
// worker always agree. Pieces use chess.js's encoding, type with the colour
// from bit 3, so colourOf and typeOf work on both. Colour 4 is a grey piece.

import { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, CAPTURE, PROMOTION, CASTLE, makePiece, colourOf, typeOf } from "./chess.js";

export const RED = 0;
export const BLUE = 1;
export const YELLOW = 2;
export const GREEN = 3;
export const DEAD = 4;
export const COLOUR_NAMES = ["Red", "Blue", "Yellow", "Green"];
export const SIZE = 14;

// A mailbox two squares wider than the board on every side, so a knight's
// jump from the edge lands on a border square rather than wrapping.
const W = SIZE + 4;
export const square4 = (file, rank) => (rank + 2) * W + file + 2;
export const fileOf4 = (sq) => (sq % W) - 2;
export const rankOf4 = (sq) => Math.floor(sq / W) - 2;

const VALID = new Uint8Array(W * W);
export const SQUARES = [];
for (let r = 0; r < SIZE; r++) {
  for (let f = 0; f < SIZE; f++) {
    const corner = (f < 3 || f > 10) && (r < 3 || r > 10);
    if (corner) continue;
    VALID[square4(f, r)] = 1;
    SQUARES.push(square4(f, r));
  }
}
export const onBoard4 = (sq) => VALID[sq] === 1;

const FILES = "abcdefghijklmn";
export const squareName4 = (sq) => FILES[fileOf4(sq)] + (rankOf4(sq) + 1);

export function parseSquare4(name) {
  const m = /^([a-n])(1[0-4]|[1-9])$/.exec(name ?? "");
  if (!m) return -1;
  const sq = square4(m[1].charCodeAt(0) - 97, Number(m[2]) - 1);
  return onBoard4(sq) ? sq : -1;
}

const KNIGHT_STEPS = [2 * W + 1, 2 * W - 1, W + 2, W - 2, -W + 2, -W - 2, -2 * W + 1, -2 * W - 1];
const KING_STEPS = [1, -1, W, -W, W + 1, W - 1, -W + 1, -W - 1];
const BISHOP_STEPS = [W + 1, W - 1, -W + 1, -W - 1];
const ROOK_STEPS = [1, -1, W, -W];

// Per colour: a pawn's step forward, and its two captures.
const FORWARD = [W, 1, -W, -1];
const PAWN_CAPTURES = [
  [W - 1, W + 1],
  [1 - W, 1 + W],
  [-W - 1, -W + 1],
  [-1 - W, -1 + W],
];
// Along a back rank, the step from the king towards its rooks' side.
const ALONG = [1, W, 1, W];

// How far a square is from `colour`'s own edge: 0 on its back rank, 1 where
// its pawns start, 7 at the centre line, where they promote.
function progress(colour, sq) {
  switch (colour) {
    case RED:
      return rankOf4(sq);
    case BLUE:
      return fileOf4(sq);
    case YELLOW:
      return SIZE - 1 - rankOf4(sq);
    default:
      return SIZE - 1 - fileOf4(sq);
  }
}
const PROMOTE_AT = 7;

const LETTERS = ".pnbrqk";
const PROMOTIONS = [QUEEN, ROOK, BISHOP, KNIGHT];
export const WORTH = [0, 1, 3, 3, 5, 9, 0];

// Every player's pieces, from their own left to right, so all four armies
// are the same army turned: the queen on its player's left of the king.
const ARMY = "RNBQKBNR";

// Teams: Red and Yellow, Blue and Green.
export const partnerOf = (colour) => colour ^ 2;
export const teamOf = (colour) => colour & 1;

export class Position4 {
  constructor(teams = false) {
    this.teams = teams;
    this.board = new Int8Array(W * W);
    this.turn = RED;
    // A bit per player still in.
    this.live = 0b1111;
    this.kings = [-1, -1, -1, -1];
    // Two slots per player: the nearer rook, then the farther, by square;
    // -1 once that castling is gone.
    this.castle = [-1, -1, -1, -1, -1, -1, -1, -1];
    this.halfmove = 0;
    this.undo = [];
  }

  static start(teams = false) {
    const pos = new Position4(teams);
    const types = { R: ROOK, N: KNIGHT, B: BISHOP, Q: QUEEN, K: KING };
    // Each army's eight back squares in its player's left to right order,
    // and the line in front of them.
    const backs = [
      (i) => [square4(3 + i, 0), square4(3 + i, 1)],
      (i) => [square4(0, 10 - i), square4(1, 10 - i)],
      (i) => [square4(10 - i, 13), square4(10 - i, 12)],
      (i) => [square4(13, 3 + i), square4(12, 3 + i)],
    ];
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < 8; i++) {
        const [back, front] = backs[c](i);
        pos.board[back] = makePiece(c, types[ARMY[i]]);
        pos.board[front] = makePiece(c, PAWN);
      }
      const king = backs[c](4)[0];
      pos.kings[c] = king;
      const left = backs[c](0)[0];
      const right = backs[c](7)[0];
      // The king stands one square right of centre, so its right rook is
      // the nearer one.
      pos.castle[c * 2] = right;
      pos.castle[c * 2 + 1] = left;
    }
    return pos;
  }

  isLive(colour) {
    return colour < 4 && (this.live & (1 << colour)) !== 0;
  }

  liveColours() {
    const out = [];
    for (let c = 0; c < 4; c++) if (this.isLive(c)) out.push(c);
    return out;
  }

  // The next player still in after `colour`, or `colour` if nobody is.
  nextLive(colour) {
    for (let i = 1; i <= 4; i++) {
      const c = (colour + i) % 4;
      if (this.isLive(c)) return c;
    }
    return colour;
  }

  // Whether `c`'s pieces threaten `us`: anybody else still in, bar a
  // partner. Grey pieces threaten nobody.
  hostile(us, c) {
    return c !== us && c < 4 && (!this.teams || ((c ^ us) & 1) === 1);
  }

  // Whether `us` may take this piece: anybody's but its own or a partner's.
  // Grey pieces are anybody's.
  takeable(us, piece) {
    const c = colourOf(piece);
    return c !== us && (c === DEAD || !this.teams || ((c ^ us) & 1) === 1);
  }

  opponents(us) {
    return this.liveColours().filter((c) => this.hostile(us, c));
  }

  /* ---- attacks ---- */

  // Whether anybody hostile to `us` attacks `sq`.
  isAttacked(sq, us) {
    const b = this.board;
    for (let c = 0; c < 4; c++) {
      if (!this.hostile(us, c)) continue;
      const pawn = makePiece(c, PAWN);
      const caps = PAWN_CAPTURES[c];
      if (b[sq - caps[0]] === pawn || b[sq - caps[1]] === pawn) return true;
    }
    for (const step of KNIGHT_STEPS) {
      const p = b[sq + step];
      if (p && typeOf(p) === KNIGHT && this.hostile(us, colourOf(p))) return true;
    }
    for (const step of KING_STEPS) {
      const p = b[sq + step];
      if (p && typeOf(p) === KING && this.hostile(us, colourOf(p))) return true;
    }
    for (const step of BISHOP_STEPS) {
      let from = sq + step;
      while (VALID[from]) {
        const p = b[from];
        if (p) {
          const t = typeOf(p);
          if ((t === BISHOP || t === QUEEN) && this.hostile(us, colourOf(p))) return true;
          break;
        }
        from += step;
      }
    }
    for (const step of ROOK_STEPS) {
      let from = sq + step;
      while (VALID[from]) {
        const p = b[from];
        if (p) {
          const t = typeOf(p);
          if ((t === ROOK || t === QUEEN) && this.hostile(us, colourOf(p))) return true;
          break;
        }
        from += step;
      }
    }
    return false;
  }

  kingAttacked(colour) {
    const k = this.kings[colour];
    return k >= 0 && this.isAttacked(k, colour);
  }

  inCheck(colour = this.turn) {
    return this.isLive(colour) && this.kingAttacked(colour);
  }

  // Every king in check, for the board to mark.
  checkedKings() {
    return this.liveColours()
      .filter((c) => this.kingAttacked(c))
      .map((c) => this.kings[c]);
  }

  /* ---- move generation ---- */

  // Pseudo-legal moves for `us`, who need not be the side to move: the
  // computer looks at every opponent's replies at once.
  pseudoMoves(capturesOnly = false, us = this.turn) {
    const moves = [];
    const b = this.board;
    const add = (from, to, piece, flags, promo = 0) => {
      moves.push({ from, to, piece, captured: b[to], promo, flags, rookFrom: -1, rookTo: -1 });
    };

    for (const from of SQUARES) {
      const piece = b[from];
      if (!piece || colourOf(piece) !== us) continue;
      const type = typeOf(piece);

      if (type === PAWN) {
        const one = from + FORWARD[us];
        if (VALID[one] && !b[one]) {
          if (progress(us, one) === PROMOTE_AT) {
            for (const promo of PROMOTIONS) add(from, one, piece, PROMOTION, makePiece(us, promo));
          } else if (!capturesOnly) {
            add(from, one, piece, 0);
            const two = one + FORWARD[us];
            if (progress(us, from) === 1 && VALID[two] && !b[two]) add(from, two, piece, 0);
          }
        }
        for (const cap of PAWN_CAPTURES[us]) {
          const to = from + cap;
          if (!VALID[to] || !b[to] || !this.takeable(us, b[to])) continue;
          if (progress(us, to) === PROMOTE_AT) {
            for (const promo of PROMOTIONS) add(from, to, piece, CAPTURE | PROMOTION, makePiece(us, promo));
          } else {
            add(from, to, piece, CAPTURE);
          }
        }
        continue;
      }

      const steps =
        type === KNIGHT ? KNIGHT_STEPS : type === BISHOP ? BISHOP_STEPS : type === ROOK ? ROOK_STEPS : KING_STEPS;
      const slides = type === BISHOP || type === ROOK || type === QUEEN;
      for (const step of steps) {
        let to = from + step;
        while (VALID[to]) {
          const target = b[to];
          if (target) {
            if (this.takeable(us, target)) add(from, to, piece, CAPTURE);
            break;
          }
          if (!capturesOnly) add(from, to, piece, 0);
          if (!slides) break;
          to += step;
        }
      }
    }

    if (!capturesOnly) this.castlingMoves(moves, us);
    return moves;
  }

  // The king moves two squares towards the rook, and the rook lands on the
  // square it crossed. Not out of, through or into check.
  castlingMoves(moves, us) {
    const king = this.kings[us];
    if (king < 0) return;
    const rook = makePiece(us, ROOK);
    for (let side = 0; side < 2; side++) {
      const rookFrom = this.castle[us * 2 + side];
      if (rookFrom < 0 || this.board[rookFrom] !== rook) continue;
      const step = Math.sign(rookFrom - king) * ALONG[us];
      let clear = true;
      for (let sq = king + step; sq !== rookFrom; sq += step) {
        if (this.board[sq]) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      if (this.isAttacked(king, us) || this.isAttacked(king + step, us)) continue;
      moves.push({
        from: king,
        to: king + 2 * step,
        piece: makePiece(us, KING),
        captured: 0,
        promo: 0,
        flags: CASTLE,
        rookFrom,
        rookTo: king + step,
      });
    }
  }

  // Legal moves for `us`: nothing that leaves its own king attacked.
  moves(capturesOnly = false, us = this.turn) {
    if (!this.isLive(us)) return [];
    const legal = [];
    for (const m of this.pseudoMoves(capturesOnly, us)) {
      this.make(m);
      if (!this.kingAttacked(us)) legal.push(m);
      this.unmake();
    }
    return legal;
  }

  /* ---- making and unmaking ---- */

  // Turns a player's pieces grey and takes them out of the game.
  retire(colour) {
    for (const sq of SQUARES) {
      const p = this.board[sq];
      if (p && colourOf(p) === colour) this.board[sq] = makePiece(DEAD, typeOf(p));
    }
    this.live &= ~(1 << colour);
    this.kings[colour] = -1;
    this.castle[colour * 2] = this.castle[colour * 2 + 1] = -1;
  }

  make(m) {
    const b = this.board;
    const us = colourOf(m.piece);
    const u = {
      move: m,
      turn: this.turn,
      castle: this.castle.slice(),
      halfmove: this.halfmove,
      kings: this.kings.slice(),
      live: this.live,
      board: null,
    };

    if (m.flags & CASTLE) {
      const rook = b[m.rookFrom];
      b[m.from] = 0;
      b[m.rookFrom] = 0;
      b[m.to] = m.piece;
      b[m.rookTo] = rook;
      this.kings[us] = m.to;
    } else {
      if (m.captured && typeOf(m.captured) === KING && colourOf(m.captured) < 4) {
        // A king taken: its player is out. Rare enough to keep the whole
        // board for unmaking.
        u.board = b.slice();
        this.retire(colourOf(m.captured));
      }
      b[m.from] = 0;
      b[m.to] = m.promo || m.piece;
      if (typeOf(m.piece) === KING) this.kings[us] = m.to;
    }

    for (let slot = 0; slot < 8; slot++) {
      const rs = this.castle[slot];
      if (rs < 0) continue;
      if (rs === m.from || rs === m.to || ((slot >> 1) === us && typeOf(m.piece) === KING)) this.castle[slot] = -1;
    }

    this.halfmove = typeOf(m.piece) === PAWN || m.flags & CAPTURE ? 0 : this.halfmove + 1;
    this.turn = this.nextLive(us);
    this.undo.push(u);
  }

  unmake() {
    const u = this.undo.pop();
    const m = u.move;
    const b = this.board;
    if (u.board) {
      b.set(u.board);
    } else if (m.flags & CASTLE) {
      const rook = b[m.rookTo];
      b[m.to] = 0;
      b[m.rookTo] = 0;
      b[m.from] = m.piece;
      b[m.rookFrom] = rook;
    } else {
      b[m.from] = m.piece;
      b[m.to] = m.captured;
    }
    this.turn = u.turn;
    this.castle = u.castle;
    this.halfmove = u.halfmove;
    this.kings = u.kings;
    this.live = u.live;
  }

  /* ---- the end of the game ---- */

  material(colour) {
    let total = 0;
    for (const sq of SQUARES) {
      const p = this.board[sq];
      if (p && colourOf(p) === colour) total += WORTH[typeOf(p)];
    }
    return total;
  }

  // Anything but a bare king, or a king and one minor piece.
  canMate(colour) {
    let minors = 0;
    for (const sq of SQUARES) {
      const p = this.board[sq];
      if (!p || colourOf(p) !== colour) continue;
      const t = typeOf(p);
      if (t === PAWN || t === ROOK || t === QUEEN) return true;
      if (t === KNIGHT || t === BISHOP) minors++;
    }
    return minors >= 2;
  }

  /* ---- notation ---- */

  // "g2g4", "h7h8q", and "O-O" with the nearer rook or "O-O-O" with the
  // farther, as in two-player chess.
  static moveText(m) {
    if (m.flags & CASTLE) {
      const d = Math.abs(m.rookFrom - m.from);
      return d === 3 || d === 3 * W ? "O-O" : "O-O-O";
    }
    return squareName4(m.from) + squareName4(m.to) + (m.promo ? LETTERS[typeOf(m.promo)] : "");
  }

  findMove(text) {
    if (typeof text !== "string" || text.length > 7) return null;
    return this.moves().find((m) => Position4.moveText(m) === text) ?? null;
  }

  // Algebraic notation, with "+" when the move checks anybody.
  san(m, legal = this.moves()) {
    let text;
    if (m.flags & CASTLE) {
      text = Position4.moveText(m);
    } else {
      const type = typeOf(m.piece);
      const capture = m.flags & CAPTURE ? "x" : "";
      if (type === PAWN) {
        text = (capture ? squareName4(m.from).replace(/\d+/, "") : "") + capture + squareName4(m.to);
        if (m.promo) text += "=" + LETTERS[typeOf(m.promo)].toUpperCase();
      } else {
        const rivals = legal.filter((o) => o.from !== m.from && o.piece === m.piece && o.to === m.to && !(o.flags & CASTLE));
        let which = "";
        if (rivals.length) {
          const sameFile = rivals.some((o) => fileOf4(o.from) === fileOf4(m.from));
          const sameRank = rivals.some((o) => rankOf4(o.from) === rankOf4(m.from));
          if (!sameFile) which = FILES[fileOf4(m.from)];
          else if (!sameRank) which = String(rankOf4(m.from) + 1);
          else which = squareName4(m.from);
        }
        text = LETTERS[type].toUpperCase() + which + capture + squareName4(m.to);
      }
    }
    const us = colourOf(m.piece);
    this.make(m);
    if (this.opponents(us).some((c) => this.kingAttacked(c))) text += "+";
    this.unmake();
    return text;
  }

  clone() {
    const pos = new Position4(this.teams);
    pos.board = this.board.slice();
    pos.turn = this.turn;
    pos.live = this.live;
    pos.kings = this.kings.slice();
    pos.castle = this.castle.slice();
    pos.halfmove = this.halfmove;
    return pos;
  }
}

/* ---- a game ----
   A game is the rules (teams or not) and a list of entries. Most entries are
   moves. The rest are things that happen off the board, each putting one
   player out: "resign:2" (Yellow resigned) and "flag:1" (Blue ran out of
   time); and "timeup", the shared game clock running out, which ends it. */

export const MAX_ENTRIES = 2000;
const MOVE_TEXT = /^(?:[a-n](?:1[0-4]|[1-9])[a-n](?:1[0-4]|[1-9])[qrbn]?|O-O|O-O-O)$/;
const EVENT_TEXT = /^(?:(resign|flag):([0-3])|timeup)$/;

export function validEntry(text) {
  return typeof text === "string" && (MOVE_TEXT.test(text) || EVENT_TEXT.test(text));
}

export function parseEvent(text) {
  const m = EVENT_TEXT.exec(text ?? "");
  if (!m) return null;
  return m[1] ? { by: m[1], colour: Number(m[2]) } : { by: "timeup" };
}

// Replays `entries` from the start. Returns the position now, a record per
// entry, the players out in the order they went, and the outcome once there
// is one: { winners: [colours], draw, reason }. Stops at the first entry
// that cannot happen here and says where. With `frames`, also the position
// after every entry, the start first, for the replay.
export function replay4(teams, entries, { frames: keepFrames = false } = {}) {
  const pos = Position4.start(teams);
  const plies = [];
  const out = []; // { colour, reason, ply }
  const frames = keepFrames ? [pos.clone()] : null;
  let outcome = null;
  let error = null;

  for (let i = 0; i < entries.length; i++) {
    const text = entries[i];
    if (i >= MAX_ENTRIES) {
      error = { ply: i, reason: "too_long" };
      break;
    }
    if (outcome) {
      error = { ply: i, reason: "after_end" };
      break;
    }
    const event = parseEvent(text);
    if (event) {
      if (event.by === "timeup") {
        plies.push({ text, san: "Time", side: -1, event: "timeup" });
        outcome = timeupOutcome(pos);
        frames?.push(pos.clone());
        continue;
      }
      if (!pos.isLive(event.colour)) {
        error = { ply: i, reason: "illegal" };
        break;
      }
      plies.push({ text, san: event.by === "resign" ? "Resigns" : "Out of time", side: event.colour, event: event.by });
      putOut(pos, out, event.colour, event.by, i);
    } else {
      const legal = pos.moves();
      const m = typeof text === "string" ? legal.find((x) => Position4.moveText(x) === text) : null;
      if (!m) {
        error = { ply: i, reason: "illegal" };
        break;
      }
      const side = pos.turn;
      const san = pos.san(m, legal);
      const before = pos.live;
      pos.make(m);
      plies.push({
        text,
        san,
        side,
        from: m.from,
        to: m.to,
        rookFrom: m.rookFrom,
        rookTo: m.rookTo,
        captured: m.flags & CAPTURE ? typeOf(m.captured) : 0,
        promo: m.promo ? typeOf(m.promo) : 0,
      });
      for (let c = 0; c < 4; c++) {
        if (before & (1 << c) && !pos.isLive(c)) out.push({ colour: c, reason: "captured", ply: i });
      }
    }
    outcome = settle(pos, out, i);
    frames?.push(pos.clone());
  }

  return { pos, plies, out, outcome, error, frames };
}

function putOut(pos, out, colour, reason, ply) {
  const wasTurn = pos.turn === colour;
  pos.retire(colour);
  if (wasTurn) pos.turn = pos.nextLive(colour);
  out.push({ colour, reason, ply });
}

// After every entry: puts out whoever is to move with no legal move, as
// often as that happens, and says whether the game is over.
function settle(pos, out, ply) {
  for (;;) {
    if (pos.teams) {
      const lost = out.find((o) => o.reason !== "stalemate");
      if (lost) return { winners: teamColours(teamOf(lost.colour) ^ 1), draw: false, reason: lost.reason };
      if (out.length) return { winners: [], draw: true, reason: "stalemate" };
    }
    const live = pos.liveColours();
    if (live.length <= 1) return { winners: live, draw: false, reason: out.at(-1)?.reason ?? "checkmate" };
    if (!live.some((c) => pos.canMate(c))) return { winners: live, draw: true, reason: "material" };
    if (pos.halfmove >= 50 * live.length) return { winners: live, draw: true, reason: "fifty" };
    if (pos.moves().length) return null;
    putOut(pos, out, pos.turn, pos.inCheck() ? "checkmate" : "stalemate", ply);
  }
}

function teamColours(team) {
  return team === 0 ? [RED, YELLOW] : [BLUE, GREEN];
}

// The shared clock ran out: most material wins, a tie draws among the tied.
// In teams, a team's material is its two players'.
function timeupOutcome(pos) {
  if (pos.teams) {
    const a = pos.material(RED) + pos.material(YELLOW);
    const b = pos.material(BLUE) + pos.material(GREEN);
    if (a === b) return { winners: [], draw: true, reason: "timeup" };
    return { winners: teamColours(a > b ? 0 : 1), draw: false, reason: "timeup" };
  }
  const live = pos.liveColours();
  const best = Math.max(...live.map((c) => pos.material(c)));
  const top = live.filter((c) => pos.material(c) === best);
  return { winners: top, draw: top.length > 1, reason: "timeup" };
}

// Where a player finished: 1 for the winner, then by when they went out.
// null while they are still in a game that goes on.
export function placing(record, colour) {
  const i = record.out.findIndex((o) => o.colour === colour);
  if (i >= 0) return 4 - i;
  if (!record.outcome) return null;
  return 1;
}

// Moves below a position, for the tests.
export function perft4(pos, depth) {
  if (depth === 0) return 1;
  const moves = pos.moves();
  if (depth === 1) return moves.length;
  let total = 0;
  for (const m of moves) {
    pos.make(m);
    total += perft4(pos, depth - 1);
    pos.unmake();
  }
  return total;
}
