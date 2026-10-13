import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_LABELS, PROVIDERS, type AppConfig, type Provider } from "../config.js";
import { toPgn } from "../game/pgn.js";
import type { GameService, StartGameRequest } from "../game/service.js";
import type { GameRecord } from "../game/types.js";
import { suggestModels, type ModelOption } from "../players/models.js";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));
const STATIC_FILES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export const TIME_CONTROL_PRESETS = ["1+0", "3+2", "5+3", "10+0", "15+10", "30+0", "90+30"];

export interface ServerOptions {
  providers: Pick<AppConfig, "providers">["providers"];
  /** Reject requests whose Host header isn't a loopback name (DNS-rebinding guard). */
  loopbackOnly: boolean;
  /** Fetches the models a provider's key can use; without it the form suggests config.ini's lists. */
  listModels?: (provider: Provider) => Promise<ModelOption[]>;
}

const MODEL_LIST_TTL_MS = 10 * 60_000;
const MODEL_LIST_RETRY_MS = 60_000;

/** The providers' model lists, each kept for a while (a failed fetch for a shorter while). */
class ModelCatalog {
  private readonly entries = new Map<Provider, { expires: number; models: Promise<ModelOption[]> }>();

  constructor(private readonly list: (provider: Provider) => Promise<ModelOption[]>) {}

  get(provider: Provider): Promise<ModelOption[]> {
    const cached = this.entries.get(provider);
    if (cached && cached.expires > Date.now()) return cached.models;
    const entry = { expires: Date.now() + MODEL_LIST_TTL_MS, models: this.list(provider) };
    entry.models.catch(() => {
      entry.expires = Date.now() + MODEL_LIST_RETRY_MS;
    });
    this.entries.set(provider, entry);
    return entry.models;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The admin API and web page. */
export function createServer(service: GameService, options: ServerOptions): Server {
  const catalog = options.listModels ? new ModelCatalog(options.listModels) : undefined;
  return createHttpServer((req, res) => {
    handle(service, options, catalog, req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });
}

async function handle(
  service: GameService,
  options: ServerOptions,
  catalog: ModelCatalog | undefined,
  req: IncomingMessage,
  res: ServerResponse,
) {
  checkOrigin(req, options);
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] !== "api") {
    const file = STATIC_FILES[url.pathname];
    if (method !== "GET" || !file) throw new HttpError(404, "Not found");
    const body = await readFile(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(file)], "Cache-Control": "no-cache" });
    res.end(body);
    return;
  }

  // /api/setup
  if (parts[1] === "setup" && parts.length === 2 && method === "GET") {
    const providers = await Promise.all(
      PROVIDERS.filter((p) => options.providers[p]).map(async (p) => {
        let available: ModelOption[] | undefined;
        let modelsError: string | undefined;
        try {
          available = await catalog?.get(p);
        } catch (err) {
          modelsError = err instanceof Error ? err.message : String(err);
        }
        return {
          id: p,
          label: PROVIDER_LABELS[p],
          models: suggestModels(p, options.providers[p]!.models, available),
          ...(modelsError ? { modelsError } : {}),
        };
      }),
    );
    return sendJson(res, 200, { providers, timeControls: TIME_CONTROL_PRESETS });
  }

  if (parts[1] !== "games") throw new HttpError(404, "Not found");

  // /api/games
  if (parts.length === 2) {
    if (method === "GET") return sendJson(res, 200, service.list());
    if (method === "POST") {
      const request = parseStartRequest(await readJson(req), options);
      let game: GameRecord;
      try {
        game = service.start(request);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err));
      }
      return sendJson(res, 201, withNow(game));
    }
    throw new HttpError(405, "Method not allowed");
  }

  const id = parts[2];
  const game = service.get(id);
  if (!game) throw new HttpError(404, `No game ${id}`);

  if (parts.length === 3 && method === "GET") return sendJson(res, 200, withNow(game));

  if (parts.length === 4 && parts[3] === "pgn" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "application/x-chess-pgn; charset=utf-8",
      "Content-Disposition": `attachment; filename="botwinnik-${game.id}.pgn"`,
    });
    res.end(toPgn(game));
    return;
  }

  if (parts.length === 4 && parts[3] === "abort" && method === "POST") {
    if (!service.abort(id)) throw new HttpError(409, "The game is not running or paused.");
    return sendJson(res, 200, withNow(service.get(id)!));
  }

  if (parts.length === 4 && parts[3] === "resume" && method === "POST") {
    if (game.status !== "paused") throw new HttpError(409, "The game is not paused.");
    try {
      return sendJson(res, 200, withNow(service.resume(id)));
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    }
  }

  if (parts.length === 4 && parts[3] === "events" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (g: GameRecord) => res.write(`data: ${JSON.stringify(withNow(g))}\n\n`);
    send(game);
    const unsubscribe = service.subscribe(id, send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  throw new HttpError(404, "Not found");
}

function parseStartRequest(body: unknown, options: ServerOptions): StartGameRequest {
  if (typeof body !== "object" || body === null) throw new HttpError(400, "Expected a JSON object.");
  const b = body as Record<string, unknown>;
  if (typeof b.timeControl !== "string") throw new HttpError(400, "timeControl is required, e.g. \"5+3\".");
  if (!Array.isArray(b.players) || b.players.length !== 2) throw new HttpError(400, "players must list two players.");
  const players = b.players.map((p, i) => {
    const spec = (p ?? {}) as Record<string, unknown>;
    const provider = spec.provider as Provider;
    const model = typeof spec.model === "string" ? spec.model.trim() : "";
    if (!PROVIDERS.includes(provider)) throw new HttpError(400, `Player ${i + 1}: unknown provider.`);
    if (!options.providers[provider]) throw new HttpError(400, `Player ${i + 1}: config.ini has no API key for ${provider}.`);
    if (!model) throw new HttpError(400, `Player ${i + 1}: pick a model.`);
    return { provider, model };
  }) as [StartGameRequest["players"][0], StartGameRequest["players"][1]];
  const color = b.firstPlayerColor ?? "random";
  if (color !== "white" && color !== "black" && color !== "random") {
    throw new HttpError(400, 'firstPlayerColor must be "white", "black" or "random".');
  }
  return { timeControl: b.timeControl, players, firstPlayerColor: color };
}

function withNow(game: GameRecord) {
  return { game, serverNow: new Date().toISOString() };
}

function checkOrigin(req: IncomingMessage, options: ServerOptions) {
  const host = req.headers.host ?? "";
  if (options.loopbackOnly) {
    const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) throw new HttpError(403, "Forbidden host.");
  }
  const origin = req.headers.origin;
  if (origin && req.method !== "GET") {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new HttpError(403, "Forbidden origin.");
    }
    if (originHost !== host) throw new HttpError(403, "Forbidden origin.");
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").includes("application/json")) {
    throw new HttpError(415, "Send JSON with Content-Type: application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new HttpError(413, "Request too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
