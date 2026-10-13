// Botwinnik admin page: set up games, watch them live, browse and export saved games.

const app = document.getElementById("app");
let cleanup = () => {};

const GLYPHS = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const TEXT = "︎"; // ask for the text (not emoji) form of the chess glyphs

/** Small DOM helper: h("div", { class: "x", onclick }, child, "text"). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** replaceChildren that skips null/false children. */
function setChildren(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

function formatClock(ms) {
  const clamped = Math.max(0, ms);
  if (clamped < 10_000) {
    const tenths = Math.floor(clamped / 100);
    return `0:0${Math.floor(tenths / 10)}.${tenths % 10}`;
  }
  const total = Math.floor(clamped / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "$0.0042", "$0.13", "$12.40"; "?" when the model's price is unknown. */
function formatUsd(usd) {
  if (usd === null || usd === undefined) return "?";
  if (usd === 0) return "$0";
  return usd < 0.1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function totalCost(game) {
  const costs = ["white", "black"].map((c) => game.spend?.[c]?.costUsd);
  return costs.some((c) => c === null || c === undefined) ? null : costs[0] + costs[1];
}

const UNKNOWN_PRICE = "Price unknown for this model: add it under [prices] in config.ini";

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function moveNumberOf(move) {
  const fullmove = Number(move.fenAfter.split(" ")[5]);
  return move.color === "white" ? fullmove : fullmove - 1;
}

// ---------------------------------------------------------------- routing

function route() {
  cleanup();
  cleanup = () => {};
  const match = /^#\/game\/([\w-]+)/.exec(location.hash);
  if (match) showGame(match[1]);
  else showHome();
}
window.addEventListener("hashchange", route);
route();

// ---------------------------------------------------------------- home

async function showHome() {
  app.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  let setup;
  try {
    setup = await api("/setup");
  } catch (err) {
    app.replaceChildren(h("p", { class: "error" }, err.message));
    return;
  }
  const gamesSection = h("section", { class: "card" }, h("h2", {}, "Games"), h("p", { class: "muted" }, "Loading…"));
  app.replaceChildren(h("div", { class: "home" }, newGameForm(setup), gamesSection));

  const refresh = async () => {
    try {
      const games = await api("/games");
      gamesSection.replaceChildren(h("h2", {}, "Games"), gamesTable(games));
    } catch (err) {
      gamesSection.replaceChildren(h("h2", {}, "Games"), h("p", { class: "error" }, err.message));
    }
  };
  await refresh();
  const timer = setInterval(refresh, 5000);
  cleanup = () => clearInterval(timer);
}

function newGameForm(setup) {
  const error = h("p", { class: "error", role: "alert" });
  const time = h("input", { id: "time", name: "time", value: "5+3", required: true, autocomplete: "off", spellcheck: "false" });
  const presets = h(
    "div",
    { class: "chips" },
    setup.timeControls.map((tc) =>
      h("button", { type: "button", class: "chip", onclick: () => { time.value = tc; } }, tc),
    ),
  );

  const playerFields = (n, defaultIndex) => {
    const providerSelect = h(
      "select",
      { id: `p${n}-provider`, "aria-label": `Player ${n} provider` },
      setup.providers.map((p) => h("option", { value: p.id }, p.label)),
    );
    const list = h("datalist", { id: `p${n}-models` });
    const model = h("input", {
      id: `p${n}-model`,
      list: `p${n}-models`,
      required: true,
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "Model ID",
      "aria-label": `Player ${n} model`,
    });
    const note = h("p", { class: "muted models-error" });
    const fill = (pick) => {
      const provider = setup.providers.find((p) => p.id === providerSelect.value);
      list.replaceChildren(...provider.models.map((m) => h("option", { value: m.id }, m.name ?? "")));
      model.value = provider.models[Math.min(pick, provider.models.length - 1)]?.id ?? "";
      note.textContent = provider.modelsError
        ? `Couldn't fetch the model list, so the suggestions come from config.ini. ${provider.modelsError}`
        : "";
    };
    // With both keys configured, default to one model from each provider.
    if (setup.providers.length > 1) providerSelect.value = setup.providers[defaultIndex % setup.providers.length].id;
    providerSelect.addEventListener("change", () => fill(0));
    fill(setup.providers.length > 1 ? 0 : defaultIndex);
    return {
      el: h("fieldset", {}, h("legend", {}, `Player ${n}`), h("div", { class: "row" }, providerSelect, model, list), note),
      value: () => ({ provider: providerSelect.value, model: model.value.trim() }),
    };
  };
  const p1 = playerFields(1, 0);
  const p2 = playerFields(2, 1);

  const color = h(
    "select",
    { id: "p1-color" },
    h("option", { value: "random" }, "Random"),
    h("option", { value: "white" }, "White"),
    h("option", { value: "black" }, "Black"),
  );
  const submit = h("button", { type: "submit", class: "primary" }, "Start game");

  const form = h(
    "form",
    {
      class: "card new-game",
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = "";
        submit.disabled = true;
        try {
          const { game } = await api("/games", {
            method: "POST",
            body: JSON.stringify({
              timeControl: time.value,
              players: [p1.value(), p2.value()],
              firstPlayerColor: color.value,
            }),
          });
          location.hash = `#/game/${game.id}`;
        } catch (err) {
          error.textContent = err.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h("h2", {}, "New game"),
    h("label", { for: "time" }, "Time control ", h("span", { class: "muted" }, "(minutes + seconds per move)")),
    time,
    presets,
    p1.el,
    p2.el,
    h("label", { for: "p1-color" }, "Player 1 plays"),
    color,
    submit,
    error,
  );
  return form;
}

function gamesTable(games) {
  if (!games.length) return h("p", { class: "muted" }, "No games yet. Start one on the left.");
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "games" },
      h("thead", {}, h("tr", {}, ["Started", "White", "Black", "Time", "Moves", "Cost", "Result"].map((t) => h("th", {}, t)))),
      h(
        "tbody",
        {},
        games.map((g) =>
          h(
            "tr",
            { onclick: () => (location.hash = `#/game/${g.id}`), tabindex: 0, onkeydown: (e) => e.key === "Enter" && (location.hash = `#/game/${g.id}`) },
            h("td", {}, formatDate(g.createdAt)),
            h("td", {}, g.white.model),
            h("td", {}, g.black.model),
            h("td", {}, g.timeControl),
            h("td", {}, Math.ceil(g.moves / 2)),
            h("td", { class: "cost", title: g.costUsd === null ? UNKNOWN_PRICE : "" }, formatUsd(g.costUsd)),
            h(
              "td",
              { title: g.termination ?? "" },
              g.status === "running" ? h("span", { class: "badge live" }, "Live") : h("span", { class: "result" }, g.result),
              g.status === "aborted" ? h("span", { class: "muted" }, " aborted") : null,
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- game view

function showGame(id) {
  app.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  let game = null;
  let offset = 0; // server clock minus local clock
  let viewPly = null; // null = follow the latest position

  const boardEl = h("div", { class: "board", role: "img" });
  const topBar = h("div", { class: "player-bar" });
  const bottomBar = h("div", { class: "player-bar" });
  const banner = h("div", { class: "banner" });
  const title = h("h2", {});
  const meta = h("p", { class: "muted" });
  const actions = h("div", { class: "actions" });
  const moveList = h("ol", { class: "moves" });
  const nav = h("div", { class: "nav" });

  app.replaceChildren(
    h(
      "div",
      { class: "game" },
      h("div", { class: "game-head" }, h("div", {}, title, meta), actions),
      banner,
      h("div", { class: "game-body" }, h("div", { class: "board-col" }, topBar, boardEl, bottomBar, nav), h("section", { class: "card moves-card" }, h("h3", {}, "Moves and reasoning"), moveList)),
    ),
  );

  const source = new EventSource(`/api/games/${id}/events`);
  source.onmessage = (event) => {
    const data = JSON.parse(event.data);
    offset = Date.parse(data.serverNow) - Date.now();
    game = data.game;
    if (viewPly !== null && viewPly > game.moves.length) viewPly = null;
    render();
    if (game.status !== "running") source.close();
  };
  source.onerror = () => {
    if (!game) {
      source.close();
      app.replaceChildren(h("p", { class: "error" }, "Couldn't load this game."));
    }
  };

  const tick = setInterval(() => game && renderClocks(), 100);
  const onKey = (e) => {
    if (!game || e.target.closest("input, select, textarea")) return;
    const current = viewPly ?? game.moves.length;
    if (e.key === "ArrowLeft") setView(Math.max(0, current - 1));
    else if (e.key === "ArrowRight") setView(Math.min(game.moves.length, current + 1));
    else return;
    e.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  cleanup = () => {
    source.close();
    clearInterval(tick);
    document.removeEventListener("keydown", onKey);
  };

  function setView(ply) {
    viewPly = ply >= game.moves.length ? null : ply;
    render();
  }

  function sideToMove() {
    const fen = game.moves.length ? game.moves[game.moves.length - 1].fenAfter : game.startFen;
    return fen.split(" ")[1] === "w" ? "white" : "black";
  }

  function liveClock(color) {
    let ms = game.clocks[color];
    if (game.status === "running" && game.turnStartedAt && sideToMove() === color) {
      ms -= Date.now() + offset - Date.parse(game.turnStartedAt);
    }
    return ms;
  }

  function renderClocks() {
    for (const bar of [topBar, bottomBar]) {
      const color = bar.dataset.color;
      const clock = bar.querySelector(".clock");
      if (!clock) continue;
      const ms = liveClock(color);
      clock.textContent = formatClock(ms);
      clock.classList.toggle("low", ms < 20_000);
      clock.classList.toggle("running", game.status === "running" && sideToMove() === color);
    }
  }

  function spendTitle(spend) {
    const calls = `${spend.calls} API call${spend.calls === 1 ? "" : "s"}`;
    const tokens = `${spend.inputTokens.toLocaleString()} input / ${spend.outputTokens.toLocaleString()} output tokens`;
    return spend.costUsd === null ? `${calls}, ${tokens}. ${UNKNOWN_PRICE}` : `${calls}, ${tokens}`;
  }

  function spendBadge(spend) {
    if (!spend) return null;
    return h("span", { class: "spend muted", title: spendTitle(spend) }, formatUsd(spend.costUsd));
  }

  function playerBar(bar, color) {
    bar.dataset.color = color;
    const spec = game[color];
    const illegal = game.illegalMoves[color];
    const offer = game.status === "running" && game.pendingDrawOffer === color;
    setChildren(
      bar,
      h("span", { class: `swatch ${color}` }),
      h("span", { class: "name" }, spec.model),
      h("span", { class: "muted provider" }, spec.provider === "anthropic" ? "Claude" : "ChatGPT"),
      spendBadge(game.spend?.[color]),
      illegal ? h("span", { class: "badge warn", title: "Illegal moves" }, `${illegal} illegal`) : null,
      offer ? h("span", { class: "badge" }, "offers a draw") : null,
      h("span", { class: "clock" }),
    );
  }

  function render() {
    title.textContent = `${game.white.model} vs ${game.black.model}`;
    meta.textContent = `${game.timeControl.label} ${game.timeControl.category} · ${formatDate(game.createdAt)} · colors ${game.colorsAssigned === "random" ? "drawn at random" : "chosen by the admin"} · game cost ${formatUsd(totalCost(game))}`;
    meta.title = totalCost(game) === null ? UNKNOWN_PRICE : "";

    setChildren(
      actions,
      h("a", { class: "button", href: `/api/games/${game.id}/pgn`, download: `botwinnik-${game.id}.pgn` }, "Download PGN"),
      game.status === "running"
        ? h(
            "button",
            {
              class: "danger",
              onclick: async () => {
                if (!confirm("Abort this game? It will be saved without a result.")) return;
                try {
                  await api(`/games/${game.id}/abort`, { method: "POST", body: "{}" });
                } catch (err) {
                  alert(err.message);
                }
              },
            },
            "Abort",
          )
        : null,
    );

    if (game.status === "running") {
      banner.className = "banner live";
      banner.textContent = `${capitalize(sideToMove())} (${game[sideToMove()].model}) is thinking…`;
    } else {
      banner.className = `banner ${game.status}`;
      banner.replaceChildren(h("strong", {}, game.result), " ", game.termination?.message ?? "");
    }

    playerBar(topBar, "black");
    playerBar(bottomBar, "white");
    renderClocks();

    const shownPly = viewPly ?? game.moves.length;
    const fen = shownPly === 0 ? game.startFen : game.moves[shownPly - 1].fenAfter;
    const last = shownPly > 0 ? game.moves[shownPly - 1].uci : null;
    renderBoard(boardEl, fen, last);
    boardEl.setAttribute("aria-label", `Position after ${shownPly} half-moves: ${fen}`);

    nav.replaceChildren(
      h("button", { onclick: () => setView(0), disabled: shownPly === 0, "aria-label": "Start" }, "⏮"),
      h("button", { onclick: () => setView(Math.max(0, shownPly - 1)), disabled: shownPly === 0, "aria-label": "Back" }, "◀"),
      h("span", { class: "muted" }, viewPly === null ? (game.status === "running" ? "Live" : "Final position") : `After ${shownPly} of ${game.moves.length}`),
      h("button", { onclick: () => setView(shownPly + 1), disabled: viewPly === null, "aria-label": "Forward" }, "▶"),
      h("button", { onclick: () => setView(game.moves.length), disabled: viewPly === null, "aria-label": "Latest" }, "⏭"),
    );

    renderMoves(shownPly);
  }

  function renderMoves(shownPly) {
    const items = [];
    const eventItem = (e) =>
      h(
        "li",
        { class: `event ${e.type}` },
        h("span", { class: "event-text" }, e.message),
        e.attempted ? h("span", { class: "muted" }, ` Sent: “${e.attempted}”.`) : null,
        e.reasoning ? h("p", { class: "reasoning" }, e.reasoning) : null,
      );
    for (const e of game.events.filter((e) => e.ply === 0)) items.push(eventItem(e));
    for (const m of game.moves) {
      items.push(
        h(
          "li",
          { class: `move ${m.ply === shownPly ? "current" : ""}`, onclick: () => setView(m.ply) },
          h(
            "div",
            { class: "move-head" },
            h("span", { class: "num" }, `${moveNumberOf(m)}${m.color === "white" ? "." : "…"}`),
            h("span", { class: "san" }, m.san),
            m.drawOffered ? h("span", { class: "badge" }, "draw offered") : null,
            h(
              "span",
              { class: "muted time", title: m.spend ? spendTitle(m.spend) : "" },
              `${(m.thinkingMs / 1000).toFixed(1)}s · ${formatClock(m.clockMs)}`,
              m.spend ? ` · ${formatUsd(m.spend.costUsd)}` : "",
            ),
          ),
          m.reasoning ? h("p", { class: "reasoning" }, m.reasoning) : null,
        ),
      );
      for (const e of game.events.filter((e) => e.ply === m.ply)) items.push(eventItem(e));
    }
    const atBottom = moveList.scrollTop + moveList.clientHeight >= moveList.scrollHeight - 30;
    moveList.replaceChildren(...(items.length ? items : [h("li", { class: "muted" }, "No moves yet.")]));
    if (viewPly === null && atBottom) moveList.scrollTop = moveList.scrollHeight;
    else if (viewPly !== null) moveList.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  }
}

function renderBoard(el, fen, lastUci) {
  const rows = fen.split(" ")[0].split("/");
  const highlight = new Set(lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : []);
  const squares = [];
  rows.forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) squares.push(square(r, file++, null));
      } else {
        squares.push(square(r, file++, ch));
      }
    }
  });
  el.replaceChildren(...squares);

  function square(r, f, piece) {
    const name = "abcdefgh"[f] + (8 - r);
    const dark = (r + f) % 2 === 1;
    const cls = ["sq", dark ? "dark" : "light", highlight.has(name) ? "last" : ""].join(" ");
    const sq = h("div", { class: cls });
    if (f === 0) sq.append(h("span", { class: "coord rank" }, 8 - r));
    if (r === 7) sq.append(h("span", { class: "coord file" }, "abcdefgh"[f]));
    if (piece) {
      const white = piece === piece.toUpperCase();
      sq.append(h("span", { class: `piece ${white ? "w" : "b"}` }, GLYPHS[piece.toLowerCase()] + TEXT));
    }
    return sq;
  }
}
