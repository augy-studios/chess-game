// Asks the computer for a move. In a Web Worker where the browser supports
// module workers, on this thread otherwise. Only the latest request is
// answered: an undo or a new game makes any pending one stale.

let worker = null;
let workerFailed = false;
let latest = 0;
const waiting = new Map();

function getWorker() {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL("./ai-worker.js", import.meta.url), { type: "module" });
    worker.addEventListener("message", (e) => {
      const resolve = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      resolve?.(e.data.text);
    });
    worker.addEventListener("error", () => {
      // A browser without module workers: fall back for this and every
      // later request.
      workerFailed = true;
      worker = null;
      for (const [id, resolve] of waiting) runHere(id, resolve);
      waiting.clear();
    });
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

let pendingHere = null;

async function runHere(id, resolve) {
  const { seed, difficulty, moves, players, teams } = pendingHere;
  if (players === 4) {
    const { pickFour } = await import("./computer4.js");
    resolve(pickFour(seed, difficulty, teams, moves));
    return;
  }
  const [{ Position }, { chooseMove }, { parseSeed, moveRandom }] = await Promise.all([
    import("./chess.js"),
    import("./ai.js"),
    import("./seed.js"),
  ]);
  const s = parseSeed(seed);
  const pos = Position.fromIndex(s.index);
  for (const t of moves) pos.make(pos.findMove(t));
  resolve(chooseMove(pos, difficulty, moveRandom(s, difficulty, moves.length))?.text ?? null);
}

// Resolves with the move text, or null if a newer request replaced this one.
// A four-player game passes { players: 4, teams }.
export function requestMove(seedText, difficulty, moves, { players = 2, teams = false } = {}) {
  const id = ++latest;
  const payload = { id, seed: seedText, difficulty, moves: moves.slice(), players, teams };
  return new Promise((resolve) => {
    const done = (text) => resolve(id === latest ? text : null);
    const w = getWorker();
    pendingHere = payload;
    if (w) {
      waiting.set(id, done);
      w.postMessage(payload);
    } else {
      // Let the page paint "thinking" first.
      setTimeout(() => runHere(id, done), 30);
    }
  });
}

// Makes any request in flight stale.
export function cancelMove() {
  latest++;
}
