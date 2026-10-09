// The pieces, as inline SVG drawn for this app. Unicode chess symbols are
// not used: the black pawn renders as an emoji on iOS and Android, and
// emoji are out of the design system entirely.
//
// Colours come from the --piece-* tokens in style.css. A white piece is
// white and a black piece is black whatever the theme, like the footer heart,
// so these are the fixed-meaning exception to theme tokens.

import { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, WHITE, typeOf, colourOf } from "./chess.js";

// Every piece stands on the same plinth.
const BASE = `<path d="M11 39.5h23v-2.2a2.3 2.3 0 0 0-2.3-2.3H13.3a2.3 2.3 0 0 0-2.3 2.3z"/>`;

const SHAPES = {
  [PAWN]: `${BASE}
    <path d="M15.5 35c0-4.2 2.2-7.6 5-9.5h4c2.8 1.9 5 5.3 5 9.5z"/>
    <path d="M17.5 25.8h10a1.8 1.8 0 0 0 0-3.6h-10a1.8 1.8 0 0 0 0 3.6z"/>
    <circle cx="22.5" cy="16.2" r="5.6"/>`,
  [ROOK]: `${BASE}
    <path d="M13.5 35l2-4h14l2 4z"/>
    <path d="M16.3 31l1-14h10.4l1 14z"/>
    <path d="M14 17V9.5h3.6v3h3.1v-3h3.6v3h3.1v-3H31V17z"/>
    <path class="detail" d="M17.3 20.5h10.4" fill="none"/>`,
  [BISHOP]: `${BASE}
    <path d="M14.5 35c.8-2.6 2.6-4 2.6-4h10.8s1.8 1.4 2.6 4z"/>
    <path d="M17.2 31c-1.8-3.2-2.4-6.6-1.2-9.8 1.1-3.2 3.6-6 6.5-8.5 2.9 2.5 5.4 5.3 6.5 8.5 1.2 3.2.6 6.6-1.2 9.8z"/>
    <circle cx="22.5" cy="9.8" r="2.6"/>
    <path class="detail" d="M25 17.5l-4.6 5.6M19 28h7" fill="none"/>`,
  [KNIGHT]: `${BASE}
    <path d="M14 35c-.3-4.6 2-8.2 6.3-11 1.2-.8 1.4-2.2.2-3-1.4-.9-3.3-.2-5 1.1-1.2.9-2.9.5-3.4-.9-.6-1.6.1-3.2 1.1-4.4l5.6-6.8c.6-.7.7-1.6.7-2.7l1.8-1.6 1.6 2.6c6.4.6 10.8 5.6 11.7 12.8.6 5 0 9.5-1.1 13.9z"/>
    <circle class="eye" cx="18.3" cy="14.6" r="1.1"/>
    <path class="detail" d="M26.5 13.5c1.8 2.6 2.6 6 2.4 10" fill="none"/>`,
  [QUEEN]: `${BASE}
    <path d="M13 35l2-4h15l2 4z"/>
    <path d="M15 31L10.5 15l5.3 8.2L16.5 11l4.3 11.6L22.5 9.5l1.7 13.1L28.5 11l.7 12.2 5.3-8.2L30 31z"/>
    <circle cx="10.5" cy="13.2" r="2.1"/>
    <circle cx="16.5" cy="9.3" r="2.1"/>
    <circle cx="22.5" cy="7.6" r="2.1"/>
    <circle cx="28.5" cy="9.3" r="2.1"/>
    <circle cx="34.5" cy="13.2" r="2.1"/>
    <path class="detail" d="M16 27.5h13" fill="none"/>`,
  [KING]: `${BASE}
    <path d="M13 35l2-4h15l2 4z"/>
    <path d="M15 31c-3.2-3.6-4.6-7.6-3.3-10.8 1.4-3.3 5.3-4 7.6-1.8 1.3 1.2 2.3 2.8 3.2 4.4.9-1.6 1.9-3.2 3.2-4.4 2.3-2.2 6.2-1.5 7.6 1.8 1.3 3.2-.1 7.2-3.3 10.8z"/>
    <path d="M22.5 23c-1.6-2.8-2.8-5-2.8-7.1a2.8 2.8 0 0 1 5.6 0c0 2.1-1.2 4.3-2.8 7.1z"/>
    <path d="M22.5 5v7.5M19.4 7.9h6.2" fill="none"/>
    <path class="detail" d="M16 27.5h13" fill="none"/>`,
};

const NAMES = { [PAWN]: "pawn", [KNIGHT]: "knight", [BISHOP]: "bishop", [ROOK]: "rook", [QUEEN]: "queen", [KING]: "king" };

export function pieceName(piece) {
  return `${colourOf(piece) === WHITE ? "white" : "black"} ${NAMES[typeOf(piece)]}`;
}

export function pieceSvg(piece) {
  const colour = colourOf(piece) === WHITE ? "w" : "b";
  return `<svg class="piece-art ${colour}" viewBox="0 0 45 45" aria-hidden="true" focusable="false"><g>${SHAPES[typeOf(piece)]}</g></svg>`;
}

// By type alone, for the promotion picker and the captured rows.
export function typeSvg(type, colour) {
  return pieceSvg(type | (colour << 3));
}

/* ---- four-player chess ----
   The same shapes in the four armies' colours, and grey for the pieces of a
   player who is out. Also fixed-meaning colours, from the --piece4-* tokens. */

const ARMIES = ["red", "blue", "yellow", "green", "grey"];

export function pieceName4(piece) {
  return `${ARMIES[colourOf(piece)]} ${NAMES[typeOf(piece)]}`;
}

export function pieceSvg4(piece) {
  return `<svg class="piece-art p4 ${ARMIES[colourOf(piece)]}" viewBox="0 0 45 45" aria-hidden="true" focusable="false"><g>${SHAPES[typeOf(piece)]}</g></svg>`;
}

export function typeSvg4(type, colour) {
  return pieceSvg4(type | (colour << 3));
}
