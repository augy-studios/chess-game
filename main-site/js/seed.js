// Game seeds. A seed decides the start position (one of the 960, or the
// ordinary one), which side the first player takes, and every roll of the
// dice the computer makes. The same seed and the same moves are always the
// same game, which is what lets a seed be shared and the API check a game.
//
// Written as "960-BXK4-M9TR" or "STD-BXK4-M9TR". The prefix is the start
// position rule; the eight characters after it are the seed proper.
//
// Integer arithmetic only. Math.random and Math.exp differ between browsers
// and would make a game replay differently on the server.

import { STANDARD_INDEX } from "./chess.js";

// No vowels, and no 0 O 1 I, as for pairing codes: a seed read aloud cannot
// be misheard and cannot spell a word.
const ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ23456789";
const BODY_LENGTH = 8;

export const VARIANTS = ["960", "STD"];

// 32 bit string hash (cyrb53's mixing, one half of it).
export function hashString(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

// A small, fast, well mixed generator. Returns unsigned 32 bit integers.
export function randomSource(seedNumber) {
  let a = seedNumber >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function randomBody() {
  // Bytes at or above the limit would make some characters likelier.
  const limit = 256 - (256 % ALPHABET.length);
  let body = "";
  while (body.length < BODY_LENGTH) {
    const [byte] = globalThis.crypto.getRandomValues(new Uint8Array(1));
    if (byte < limit) body += ALPHABET[byte % ALPHABET.length];
  }
  return body;
}

const isBody = (s) => s.length === BODY_LENGTH && [...s].every((c) => ALPHABET.includes(c));

function build(variant, body) {
  const text = `${variant}-${body.slice(0, 4)}-${body.slice(4)}`;
  const h = hashString(`start|${text}`);
  return {
    variant,
    body,
    text,
    index: variant === "STD" ? STANDARD_INDEX : h % 960,
    // The side the first player takes: the one playing the computer, the
    // one playing first on a shared device, or the host of a network game.
    firstSide: hashString(`side|${text}`) & 1,
  };
}

export function newSeed(variant = "960") {
  return build(VARIANTS.includes(variant) ? variant : "960", randomBody());
}

// Whatever was typed or pasted, forgiving about case, spaces and dashes.
// Eight characters with no prefix are a Chess960 seed. null if it is not one.
export function parseSeed(input) {
  const raw = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const variant of VARIANTS) {
    if (raw.startsWith(variant) && isBody(raw.slice(variant.length))) return build(variant, raw.slice(variant.length));
  }
  return isBody(raw) ? build("960", raw) : null;
}

// The computer's dice for one move. Keyed by the move number rather than
// drawn from one running stream, so the server can check any move on its own.
export function moveRandom(seed, difficulty, ply) {
  return randomSource(hashString(`ai|${seed.text}|${difficulty}|${ply}`));
}
