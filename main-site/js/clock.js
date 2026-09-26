// Time limits and the game clock.
//
// A time limit is { mode, ms }: "each" gives every player their own clock
// of `ms`, like a chess clock; "total" gives the whole game one clock both
// players share. No limit is null.
//
// The clock is plain data, so it can be saved, sent to the other device and
// restored: { used: [white, black], running: side or -1, since, start,
// stopped }, times in epoch milliseconds. It runs on the wall clock, so a
// game left open keeps counting, as a real clock would.

export const PRESET_MINUTES = [1, 3, 5, 10, 15, 30];
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 180;

export function validTime(time) {
  return (
    time === null ||
    (Boolean(time) &&
      (time.mode === "each" || time.mode === "total") &&
      Number.isInteger(time.ms) &&
      time.ms >= MIN_MINUTES * 60000 &&
      time.ms <= MAX_MINUTES * 60000)
  );
}

export function newClock(now) {
  return { used: [0, 0], running: -1, since: null, start: now, stopped: null };
}

// Milliseconds `side` has left; for a shared clock, the game has left.
export function remaining(time, clock, side, now) {
  const at = clock.stopped ?? now;
  if (time.mode === "total") return time.ms - (at - clock.start);
  const live = clock.running === side && clock.since !== null ? at - clock.since : 0;
  return time.ms - clock.used[side] - live;
}

// Books the running side's time and starts `next`'s (-1: nobody's, as while
// the computer thinks).
export function hand(clock, next, now) {
  if (clock.stopped) return;
  if (clock.running >= 0 && clock.since !== null) clock.used[clock.running] += now - clock.since;
  clock.running = next;
  clock.since = next >= 0 ? now : null;
}

export function stop(clock, now) {
  if (clock.stopped) return;
  hand(clock, -1, now);
  clock.stopped = now;
}

// For the network: times relative to the sender's now, since two devices'
// clocks never agree exactly.
export function clockToWire(clock, now) {
  return {
    used: clock.used.slice(),
    running: clock.running,
    elapsed: clock.since !== null ? (clock.stopped ?? now) - clock.since : 0,
    total: (clock.stopped ?? now) - clock.start,
    stopped: clock.stopped !== null,
  };
}

export function clockFromWire(wire, now) {
  return {
    used: wire.used.slice(),
    running: wire.running,
    since: wire.running >= 0 ? now - wire.elapsed : null,
    start: now - wire.total,
    stopped: wire.stopped ? now : null,
  };
}

export function validWireClock(w) {
  const n = (x) => Number.isFinite(x) && x >= 0 && x < 1e9;
  return (
    Boolean(w) &&
    Array.isArray(w.used) &&
    w.used.length === 2 &&
    w.used.every(n) &&
    (w.running === -1 || w.running === 0 || w.running === 1) &&
    n(w.elapsed) &&
    n(w.total) &&
    typeof w.stopped === "boolean"
  );
}

// "4:07", "1:02:30", and tenths under ten seconds: "7.4".
export function formatClock(ms) {
  const t = Math.max(0, ms);
  if (t < 10000) return `${Math.floor(t / 1000)}.${Math.floor((t % 1000) / 100)}`;
  const s = Math.ceil(t / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// "9:12" or "1 h 4 min" for how long a game took.
export function formatTaken(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function describeTime(time) {
  if (!time) return "No time limit";
  const min = Math.round(time.ms / 60000);
  return time.mode === "each" ? `${min} min each` : `${min} min game`;
}
