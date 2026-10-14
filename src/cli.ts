import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig, parsePlayerSpec, PROVIDER_LABELS, PROVIDERS, type AppConfig } from "./config.js";
import { moveNumberOf } from "./game/game.js";
import { toPgn } from "./game/pgn.js";
import { K_FACTOR, START_RATING } from "./game/ratings.js";
import { GameService } from "./game/service.js";
import { gameSpend, GameStore } from "./game/store.js";
import type { GameRecord } from "./game/types.js";
import { playerFactory } from "./players/llmPlayer.js";
import { canPlay, listModels } from "./players/models.js";
import { createServer } from "./server/server.js";
import { formatClock, TIME_CATEGORIES, type TimeCategory } from "./timeControl.js";
import { formatUsd } from "./pricing.js";

const USAGE = `Usage:
  botwinnik serve
      Start the admin web page (address and port come from config.ini).

  botwinnik play --time 5+3 --white <model> --black <model>
  botwinnik play --time 5+3 --players <model>,<model>
      Play a game in the terminal. With --players the colors are drawn at random.
      A model is written as provider:model (openai:gpt-5.6-sol, anthropic:claude-opus-5-5);
      the provider can be left out when the model name gives it away (claude-..., gpt-...).

  botwinnik resume <game-id>
      Continue a game that paused because an API account ran out of funds.

  botwinnik models
      List the models each API key can use.

  botwinnik list
      List saved games.

  botwinnik ratings [bullet|blitz|rapid|classical]
      Show each model's Elo ratings, one table per time category (or just the
      one given). Every model starts at ${START_RATING} in each category, and each
      finished game moves its players' ratings (K = ${K_FACTOR}).

  botwinnik pgn <game-id> [--out file.pgn]
      Export a saved game as PGN (printed, or written to --out).

  botwinnik import <file.pgn>
      Save a game from a PGN. A game without a result is imported paused, so
      "botwinnik resume" can continue it.

Options:
  --config <path>   Config file (default: ./config.ini, or $BOTWINNIK_CONFIG)
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      time: { type: "string" },
      white: { type: "string" },
      black: { type: "string" },
      players: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 1;
  }

  const config = loadConfig(values.config);
  const service = new GameService(new GameStore(config.gamesDir), playerFactory(config));

  switch (command) {
    case "serve":
      return serve(config, service);
    case "play":
      return play(service, values);
    case "resume": {
      const paused = service.get(rest[0] ?? "");
      if (!paused) throw new ConfigError(`No saved game "${rest[0] ?? ""}". Run "botwinnik list" to see the IDs.`);
      if (paused.status !== "paused") throw new ConfigError(`Game ${paused.id} is not paused.`);
      const [movesBefore, eventsBefore] = [paused.moves.length, paused.events.length];
      const game = service.resume(paused.id);
      console.log(`Resuming game ${game.id}: ${game.white.model} (White) vs ${game.black.model} (Black), ${game.timeControl.label}`);
      return follow(service, game, movesBefore, eventsBefore);
    }
    case "models":
      return printModels(config);
    case "list":
      for (const g of service.list()) {
        const result = g.status === "running" || g.status === "paused" ? g.status : g.result;
        console.log(
          `${g.id}  ${g.timeControl.padEnd(6)} ${g.white.model} vs ${g.black.model}  ${result}  ${formatUsd(g.costUsd)}  ${g.termination ?? ""}`,
        );
      }
      return 0;
    case "pgn": {
      const game = service.get(rest[0] ?? "");
      if (!game) throw new ConfigError(`No saved game "${rest[0] ?? ""}". Run "botwinnik list" to see the IDs.`);
      const pgn = toPgn(game, service.ratings().forGame(game));
      if (values.out) {
        writeFileSync(values.out, pgn);
        console.log(`Wrote ${values.out}`);
      } else process.stdout.write(pgn);
      return 0;
    }
    case "ratings":
      return printRatings(service, rest[0]);
    case "import": {
      if (!rest[0]) throw new ConfigError("Give the PGN file to import: botwinnik import game.pgn");
      const game = service.importPgn(readFileSync(rest[0], "utf8"));
      console.log(`Imported game ${game.id}: ${game.white.model} (White) vs ${game.black.model} (Black), ${game.moves.length} half-moves.`);
      if (game.status === "paused") console.log(`It has no result yet. Continue it with: botwinnik resume ${game.id}`);
      else console.log(`${game.result}  ${game.termination?.message ?? ""}`);
      return 0;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

function serve(config: AppConfig, service: GameService): Promise<number> {
  const interrupted = service.recoverInterrupted();
  if (interrupted) console.log(`Marked ${interrupted} interrupted game(s) as aborted.`);
  const loopbackOnly = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  const server = createServer(service, {
    providers: config.providers,
    loopbackOnly,
    listModels: (provider) => listModels(provider, config.providers[provider]!.apiKey),
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(config.port, config.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : config.port;
      const host = config.host.includes(":") ? `[${config.host}]` : config.host;
      const providers = Object.keys(config.providers).map((p) => PROVIDER_LABELS[p as keyof typeof PROVIDER_LABELS]);
      console.log(`Botwinnik is running at http://${host}:${port}/ (players: ${providers.join(", ")})`);
      console.log(`Games are saved in ${config.gamesDir}`);
    });
  });
}

function printRatings(service: GameService, only?: string): number {
  if (only !== undefined && !TIME_CATEGORIES.includes(only as TimeCategory)) {
    throw new ConfigError(`Unknown time category "${only}". Use ${TIME_CATEGORIES.join(", ")}.`);
  }
  const tables = service.ratings().tables();
  const categories = only ? [only as TimeCategory] : TIME_CATEGORIES.filter((c) => tables[c].length);
  if (!categories.length) {
    console.log(`No finished games yet. Every model starts at ${START_RATING}.`);
    return 0;
  }
  categories.forEach((category, n) => {
    const table = tables[category];
    console.log(`${n ? "\n" : ""}${category[0].toUpperCase()}${category.slice(1)}`);
    if (!table.length) {
      console.log(`  No finished ${category} games yet. Every model starts at ${START_RATING}.`);
      return;
    }
    const width = Math.max(...table.map((m) => m.model.length), "Model".length);
    console.log(`${"#".padStart(3)}  ${"Model".padEnd(width)}  Rating  Games   W   D   L`);
    table.forEach((m, i) => {
      const counts = [m.games, m.wins, m.draws, m.losses].map((c, j) => String(c).padStart(j ? 3 : 5)).join(" ");
      console.log(`${String(i + 1).padStart(3)}  ${m.model.padEnd(width)}  ${String(m.rating).padStart(6)}  ${counts}`);
    });
  });
  return 0;
}

async function printModels(config: AppConfig): Promise<number> {
  let failed = false;
  for (const provider of PROVIDERS) {
    const settings = config.providers[provider];
    if (!settings) continue;
    console.log(`${PROVIDER_LABELS[provider]}:`);
    try {
      for (const m of await listModels(provider, settings.apiKey)) {
        if (canPlay(provider, m.id)) console.log(`  ${m.id}${m.name ? `  (${m.name})` : ""}`);
      }
    } catch (err) {
      failed = true;
      console.log(`  Could not list the models: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failed ? 1 : 0;
}

async function play(service: GameService, values: Record<string, string | boolean | undefined>): Promise<number> {
  const time = values.time as string | undefined;
  if (!time) throw new ConfigError("--time is required, e.g. --time 5+3");
  let request: Parameters<GameService["start"]>[0];
  if (values.white || values.black) {
    if (!values.white || !values.black) throw new ConfigError("Give both --white and --black, or use --players.");
    request = {
      timeControl: time,
      players: [parsePlayerSpec(values.white as string), parsePlayerSpec(values.black as string)],
      firstPlayerColor: "white",
    };
  } else if (values.players) {
    const list = (values.players as string).split(",").map((s) => s.trim());
    if (list.length !== 2) throw new ConfigError("--players takes two models separated by a comma.");
    request = { timeControl: time, players: [parsePlayerSpec(list[0]), parsePlayerSpec(list[1])], firstPlayerColor: "random" };
  } else {
    throw new ConfigError("Pick the players with --white and --black, or --players.");
  }

  const game = service.start(request);
  console.log(`Game ${game.id}: ${game.white.model} (White) vs ${game.black.model} (Black), ${game.timeControl.label} ${game.timeControl.category}`);
  if (game.colorsAssigned === "random") console.log("Colors were drawn at random.");
  return follow(service, game);
}

/** Prints a game's moves and events as they come until it ends or pauses, then the result and costs. */
async function follow(service: GameService, game: GameRecord, printedMoves = 0, printedEvents = 0): Promise<number> {
  const print = (g: GameRecord) => {
    while (printedEvents < g.events.length || printedMoves < g.moves.length) {
      const nextEvent = g.events[printedEvents];
      if (nextEvent && nextEvent.ply <= printedMoves) {
        console.log(`   ! ${nextEvent.message}`);
        printedEvents++;
        continue;
      }
      if (printedMoves >= g.moves.length) break;
      const m = g.moves[printedMoves++];
      const num = `${moveNumberOf(m)}${m.color === "white" ? "." : "..."}`;
      const offer = m.drawOffered ? " (offers a draw)" : "";
      const cost = m.spend ? ` ${formatUsd(m.spend.costUsd)}` : "";
      console.log(`${num.padStart(5)} ${m.san.padEnd(8)} [${formatClock(m.clockMs)}${cost}] ${m.reasoning}${offer}`);
    }
  };
  const unsubscribe = service.subscribe(game.id, print);
  const onInterrupt = () => service.abort(game.id);
  process.once("SIGINT", onInterrupt);
  const final = (await service.wait(game.id))!;
  print(final);
  unsubscribe();
  process.off("SIGINT", onInterrupt);
  if (final.status === "paused") {
    console.log(`\nContinue with: botwinnik resume ${final.id}`);
    return 1;
  }
  console.log(`\n${final.result}  ${final.termination?.message ?? ""}`);
  if (final.unfinishedCall) {
    const who = final.unfinishedCall === "white" ? "White" : "Black";
    console.log(`Waiting for ${who}'s last API call to finish so its cost can be recorded (Ctrl+C to skip)...`);
    await service.callsFinished(final.id);
  }
  for (const color of ["white", "black"] as const) {
    const spend = final.spend[color];
    console.log(
      `${color === "white" ? "White" : "Black"} (${final[color].model}) spent ${formatUsd(spend.costUsd)}: ` +
        `${spend.calls} calls, ${spend.inputTokens} input and ${spend.outputTokens} output tokens`,
    );
  }
  console.log(`Total: ${formatUsd(gameSpend(final).costUsd)}`);
  const ratings = service.ratings().forGame(final);
  if (ratings) {
    const change = (color: "white" | "black") => {
      const { before, after = before } = ratings[color];
      const delta = after - before;
      return `${final[color].model} ${before} → ${after} (${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)})`;
    };
    const category = final.timeControl.category;
    console.log(`${category[0].toUpperCase()}${category.slice(1)} ratings: ${change("white")}, ${change("black")}`);
  }
  console.log(`Saved as ${final.id}. Export with: botwinnik pgn ${final.id}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof ConfigError || err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
