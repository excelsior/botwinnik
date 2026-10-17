import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/**
 * The Stockfish the eval bar runs in the browser, run with Node instead:
 * single-threaded WebAssembly, so it works wherever Node does.
 */
export const BUNDLED_ENGINE = fileURLToPath(new URL("../../public/vendor/stockfish/stockfish-18-lite-single.js", import.meta.url));

/** A UCI score, from the side to move's point of view. */
export type UciScore = { cp: number } | { mate: number };

export interface SearchResult {
  score: UciScore;
  /** The move the engine would play (UCI); null when there is none (checkmate, stalemate). */
  best: string | null;
  depth: number;
}

/** What analysis needs from a chess engine. */
export interface Engine {
  /** The engine's name, as it gives it ("Stockfish 18 Lite WASM"). */
  readonly name: string;
  /** Clears what the engine remembers from the previous game. */
  newGame(): Promise<void>;
  /** Searches the position reached by playing `moves` from `fen`, to `depth` plies. */
  search(fen: string, moves: readonly string[], depth: number): Promise<SearchResult>;
  quit(): void;
}

const START_TIMEOUT_MS = 60_000;
const SEARCH_TIMEOUT_MS = 10 * 60_000;

/** A UCI engine running as a child process, talking over stdin and stdout. */
export class UciEngine implements Engine {
  name = "UCI engine";
  private readonly lines: string[] = [];
  private waiter: { until: (line: string) => boolean; resolve: (lines: string[]) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null;
  private failure: Error | null = null;
  private readonly stderr: string[] = [];

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line.trim()));
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderr.push(line);
      if (this.stderr.length > 5) this.stderr.shift();
    });
    child.on("error", (err) => this.fail(err));
    child.on("exit", (code, signal) => {
      const detail = this.stderr.length ? `: ${this.stderr.join(" ")}` : "";
      this.fail(new Error(`The engine stopped (${signal ?? `exit code ${code}`})${detail}`));
    });
    child.stdin.on("error", () => {}); // a dead engine is reported through "exit"
  }

  /**
   * Starts an engine: the executable at `path` (any UCI engine, such as a
   * native Stockfish), or the bundled Stockfish when `path` is undefined.
   */
  static async start(path?: string, options: { hashMb?: number } = {}): Promise<UciEngine> {
    const child = path ? spawn(path, [], { stdio: "pipe" }) : spawn(process.execPath, [BUNDLED_ENGINE], { stdio: "pipe" });
    const engine = new UciEngine(child);
    try {
      const reply = await engine.command("uci", (line) => line === "uciok", START_TIMEOUT_MS);
      const id = reply.find((line) => line.startsWith("id name "));
      if (id) engine.name = id.slice("id name ".length).trim();
      if (options.hashMb) engine.send(`setoption name Hash value ${options.hashMb}`);
      await engine.ready();
      return engine;
    } catch (err) {
      engine.quit();
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(path ? `Couldn't start the engine at ${path}: ${reason}` : `Couldn't start the bundled Stockfish: ${reason}`);
    }
  }

  async newGame(): Promise<void> {
    this.send("ucinewgame");
    await this.ready();
  }

  async search(fen: string, moves: readonly string[], depth: number): Promise<SearchResult> {
    this.send(`position fen ${fen}${moves.length ? ` moves ${moves.join(" ")}` : ""}`);
    const reply = await this.command(`go depth ${depth}`, (line) => line.startsWith("bestmove"), SEARCH_TIMEOUT_MS);
    let found: { score: UciScore; depth: number } | null = null;
    for (const line of reply) {
      const info = parseInfo(line);
      if (info) found = info;
    }
    if (!found) throw new Error(`The engine gave no score for ${fen}${moves.length ? ` after ${moves.join(" ")}` : ""}.`);
    const best = reply.at(-1)!.split(/\s+/)[1];
    return { ...found, best: best && best !== "(none)" && best !== "0000" ? best : null };
  }

  quit(): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.send("quit");
    this.child.stdin.end();
    // An engine stuck in a search reads "quit" only once it's done.
    setTimeout(() => this.child.kill(), 5_000).unref();
  }

  private async ready(): Promise<void> {
    await this.command("isready", (line) => line === "readyok", START_TIMEOUT_MS);
  }

  private send(command: string): void {
    if (this.failure) return;
    this.child.stdin.write(`${command}\n`);
  }

  /** Sends a command and collects the lines that follow, up to the one `until` accepts. */
  private command(command: string, until: (line: string) => boolean, timeoutMs: number): Promise<string[]> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiter) return Promise.reject(new Error("The engine is busy."));
    this.lines.length = 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`The engine didn't answer "${command}" within ${Math.round(timeoutMs / 1000)} seconds.`));
        this.child.kill();
      }, timeoutMs);
      this.waiter = { until, resolve, reject, timer };
      this.send(command);
    });
  }

  private onLine(line: string): void {
    if (!line || !this.waiter) return;
    this.lines.push(line);
    if (!this.waiter.until(line)) return;
    const { resolve, timer } = this.waiter;
    this.waiter = null;
    clearTimeout(timer);
    resolve(this.lines.splice(0));
  }

  private fail(err: Error): void {
    this.failure ??= err;
    if (!this.waiter) return;
    const { reject, timer } = this.waiter;
    this.waiter = null;
    clearTimeout(timer);
    reject(this.failure);
  }
}

/** "info depth 18 ... score cp -35 ..." to its depth and score; null for other lines, bounds and secondary lines. */
export function parseInfo(line: string): { depth: number; score: UciScore } | null {
  const m = /^info\b.*\bdepth (\d+)\b.*\bscore (cp|mate) (-?\d+)( lowerbound| upperbound)?/.exec(line);
  if (!m || m[4]) return null;
  const multipv = /\bmultipv (\d+)/.exec(line);
  if (multipv && multipv[1] !== "1") return null;
  const value = Number(m[3]);
  return { depth: Number(m[1]), score: m[2] === "cp" ? { cp: value } : { mate: value } };
}
