// Botwinnik admin page: set up games, watch them live, browse, export and import saved games.

import { Engine, evalLabel, favored, whiteShare } from "./engine.js";

const app = document.getElementById("app");
let cleanup = () => {};
/** Started on the first game page and kept, so the engine loads once. */
let engine = null;
/** Games shown from Black's side. */
const flippedGames = new Set();
const EVAL_SETTING = "botwinnik.evalBar";

/** A setting remembered in this browser; storage can be unavailable (private windows, blocked site data). */
function loadSetting(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered; the choice still holds on this page
  }
}

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

/** "Oct 13, 11:58 PM" this year, "Oct 13, 2025" before. */
function formatShortDate(iso) {
  const date = new Date(iso);
  return date.getFullYear() === new Date().getFullYear()
    ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** "$0.0042", "$0.13", "$12.40"; "?" when the model's price is unknown. */
function formatUsd(usd) {
  if (usd === null || usd === undefined) return "?";
  if (usd === 0) return "$0";
  return usd < 0.1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** Mentions a call the game stopped waiting for whose cost isn't in yet. */
function unfinishedNote(game) {
  if (!game.unfinishedCall) return "";
  return ` so far, waiting for ${game.unfinishedCall === "white" ? "White" : "Black"}'s last call to finish`;
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

// ---------------------------------------------------------------- home

async function showHome() {
  document.title = "Botwinnik";
  app.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  let setup;
  try {
    setup = await api("/setup");
  } catch (err) {
    app.replaceChildren(h("p", { class: "error" }, err.message));
    return;
  }
  const gamesSection = h("section", { class: "card" }, h("h2", {}, "Games"), h("p", { class: "muted" }, "Loading…"));
  app.replaceChildren(h("div", { class: "home" }, h("div", { class: "home-side" }, newGameForm(setup), importForm()), gamesSection));

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
    const picker = modelPicker(`p${n}-model`, `Player ${n} model`);
    const model = picker.input;
    const note = h("p", { class: "muted models-error" });
    const fill = (pick) => {
      const provider = setup.providers.find((p) => p.id === providerSelect.value);
      picker.setModels(provider.models);
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
      el: h("fieldset", {}, h("legend", {}, `Player ${n}`), h("div", { class: "row" }, providerSelect, picker.el), note),
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

/**
 * A model ID field whose list of known models opens when it gets focus, all
 * of them at first, then narrowed to what's typed. Any other ID can still be
 * typed. The list is position: fixed so the scrolling form can't clip it.
 */
function modelPicker(id, label) {
  const listId = `${id}-list`;
  const input = h("input", {
    id,
    required: true,
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "Model ID",
    role: "combobox",
    "aria-label": label,
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": listId,
  });
  const list = h("ul", { id: listId, class: "model-list", role: "listbox", "aria-label": label, hidden: true });
  let models = [];
  let shown = [];
  let active = -1;
  let typed = false; // narrow the list only once something is typed

  const isOpen = () => !list.hidden;
  const render = () => {
    const query = input.value.trim().toLowerCase();
    shown =
      typed && query
        ? models.filter((m) => m.id.toLowerCase().includes(query) || (m.name ?? "").toLowerCase().includes(query))
        : models;
    if (active >= shown.length) active = shown.length - 1;
    list.replaceChildren(
      ...shown.map((m, i) =>
        h(
          "li",
          {
            id: `${listId}-${i}`,
            role: "option",
            class: i === active ? "active" : null,
            "aria-selected": String(m.id === input.value.trim()),
            onmousedown: (e) => e.preventDefault(), // keep the focus in the field
            onclick: () => choose(m),
          },
          h("span", { class: "model-id" }, m.id),
          m.name ? h("span", { class: "muted model-name" }, m.name) : null,
        ),
      ),
    );
    if (!shown.length) {
      list.append(h("li", { class: "muted empty" }, models.length ? "No listed model matches; the ID is used as typed." : "No models listed."));
    }
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", `${listId}-${active}`);
      const item = list.children[active];
      if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
      }
    } else input.removeAttribute("aria-activedescendant");
  };
  const place = () => {
    const r = input.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 300), innerWidth - 16);
    const below = innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 180 && above > below;
    list.style.left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`;
    list.style.width = `${width}px`;
    list.style.maxHeight = `${Math.min(300, up ? above : below)}px`;
    list.style.top = up ? "auto" : `${r.bottom + 4}px`;
    list.style.bottom = up ? `${innerHeight - r.top + 4}px` : "auto";
  };
  const open = () => {
    if (isOpen()) return;
    typed = false;
    active = models.findIndex((m) => m.id === input.value.trim());
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    place();
    render();
    addEventListener("scroll", place, true);
    addEventListener("resize", place);
  };
  const close = () => {
    if (!isOpen()) return;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    removeEventListener("scroll", place, true);
    removeEventListener("resize", place);
  };
  const choose = (m) => {
    input.value = m.id;
    close();
  };

  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("blur", close);
  input.addEventListener("input", () => {
    open();
    typed = true;
    active = input.value.trim() ? 0 : -1;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) return open();
      if (!shown.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      active = (active + step + shown.length) % shown.length;
      render();
    } else if (e.key === "Enter" && isOpen() && active >= 0 && shown[active]) {
      e.preventDefault(); // pick the model instead of submitting the form
      choose(shown[active]);
    } else if (e.key === "Escape" && isOpen()) {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close();
    }
  });

  return {
    el: h("div", { class: "model-picker" }, input, list),
    input,
    setModels(options) {
      models = options;
      if (isOpen()) render();
    },
  };
}

function importForm() {
  const error = h("p", { class: "error", role: "alert" });
  const text = h("textarea", {
    id: "pgn",
    rows: 4,
    spellcheck: "false",
    placeholder: "Paste a PGN, or choose a file",
    "aria-label": "PGN to import",
  });
  const file = h("input", { type: "file", accept: ".pgn,application/x-chess-pgn,text/plain", class: "file-input", id: "pgn-file" });
  file.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    error.textContent = "";
    text.value = await chosen.text();
    file.value = "";
  });
  const submit = h("button", { type: "submit" }, "Import");
  return h(
    "form",
    {
      class: "card import",
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = "";
        if (!text.value.trim()) {
          error.textContent = "Paste a PGN or choose a file first.";
          return;
        }
        submit.disabled = true;
        try {
          const { game } = await api("/games/import", { method: "POST", body: JSON.stringify({ pgn: text.value }) });
          location.hash = `#/game/${game.id}`;
        } catch (err) {
          error.textContent = err.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h("h2", {}, "Import a game"),
    h("p", { class: "muted hint" }, "A game without a result comes back paused, so you can resume it."),
    text,
    h("div", { class: "import-actions" }, h("label", { class: "button", for: "pgn-file" }, "Choose file…"), file, submit),
    error,
  );
}

function gamesTable(games) {
  if (!games.length) return h("p", { class: "muted" }, "No games yet. Start one on the left.");
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "games" },
      h(
        "thead",
        {},
        h("tr", {}, ["Started", "White", "Black", "Time", "Moves", "Cost", "Result"].map((t) => h("th", {}, t)), h("th", {}, h("span", { class: "visually-hidden" }, "Rematch"))),
      ),
      h(
        "tbody",
        {},
        games.map((g) =>
          h(
            "tr",
            {
              onclick: () => (location.hash = `#/game/${g.id}`),
              tabindex: 0,
              onkeydown: (e) => e.key === "Enter" && e.target === e.currentTarget && (location.hash = `#/game/${g.id}`),
            },
            h("td", { title: formatDate(g.createdAt) }, formatShortDate(g.createdAt)),
            h("td", {}, g.white.model),
            h("td", {}, g.black.model),
            h("td", {}, g.timeControl),
            h("td", {}, Math.ceil(g.moves / 2)),
            h("td", { class: "cost", title: g.costUsd === null ? UNKNOWN_PRICE : "" }, formatUsd(g.costUsd)),
            h(
              "td",
              { title: g.termination ?? "" },
              g.status === "running"
                ? h("span", { class: "badge live" }, "Live")
                : g.status === "paused"
                  ? h("span", { class: "badge warn" }, "Paused")
                  : h("span", { class: "result" }, g.result),
              g.status === "aborted" ? h("span", { class: "muted" }, " aborted") : null,
            ),
            h(
              "td",
              { class: "row-action" },
              g.status === "finished" || g.status === "aborted"
                ? h(
                    "button",
                    {
                      type: "button",
                      class: "small",
                      title: "Start a game between the same models with the same time control",
                      onclick: (e) => {
                        e.stopPropagation();
                        openRematch({ white: g.white, black: g.black, timeControl: g.timeControl });
                      },
                    },
                    "Rematch",
                  )
                : null,
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * Asks how to assign the colors, then starts a game between the same two
 * models with the same time control. `game` is { white, black, timeControl: "5+3" }.
 */
function openRematch(game) {
  const choices = [
    ["swap", "Swap colors", `${game.black.model} plays White`],
    ["same", "Same colors", `${game.white.model} plays White`],
    ["random", "Random colors", "drawn when the game starts"],
  ];
  const error = h("p", { class: "error", role: "alert" });
  const start = h("button", { type: "submit", class: "primary" }, "Start rematch");
  const dialog = h("dialog", { class: "card rematch", "aria-labelledby": "rematch-title" });
  const form = h(
    "form",
    {
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = "";
        start.disabled = true;
        const colors = new FormData(form).get("colors");
        try {
          const { game: next } = await api("/games", {
            method: "POST",
            body: JSON.stringify({
              timeControl: game.timeControl,
              players: [game.white, game.black],
              // The first player is the previous White.
              firstPlayerColor: colors === "swap" ? "black" : colors === "same" ? "white" : "random",
            }),
          });
          dialog.close();
          location.hash = `#/game/${next.id}`;
        } catch (err) {
          error.textContent = err.message;
        } finally {
          start.disabled = false;
        }
      },
    },
    h("h2", { id: "rematch-title" }, "Rematch"),
    h("p", { class: "muted" }, `${game.white.model} vs ${game.black.model}, ${game.timeControl}`),
    h(
      "fieldset",
      {},
      h("legend", {}, "Colors"),
      choices.map(([value, name, detail], i) =>
        h("label", { class: "choice" }, h("input", { type: "radio", name: "colors", value, checked: i === 0 }), h("span", {}, h("strong", {}, name), h("span", { class: "muted" }, ` · ${detail}`))),
      ),
    ),
    h("div", { class: "dialog-actions" }, h("button", { type: "button", onclick: () => dialog.close() }, "Cancel"), start),
    error,
  );
  dialog.append(form);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// ---------------------------------------------------------------- game view

/** Wide enough to put the board and the moves side by side, filling the window. */
const FILL_LAYOUT = matchMedia("(min-width: 900px) and (min-height: 560px)");
const MOVES_MIN_WIDTH = 320;
const COLUMN_GAP = 20;
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)");
/** How long a new move stays highlighted in the list; matches the "fresh" animation in style.css. */
const FLASH_MS = 1600;

function showGame(id) {
  document.title = "Botwinnik";
  app.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  let game = null;
  let offset = 0; // server clock minus local clock
  let viewPly = null; // null = follow the latest position
  let flipped = flippedGames.has(id);
  let rendered = null; // what the move list showed last time: { moves, events, viewPly }
  let fresh = null; // the move that just arrived, flashed for a moment: { ply, at }
  let evaluation = null;
  let evalOn = loadSetting(EVAL_SETTING, "on") !== "off";

  const boardEl = h("div", { class: "board", role: "img" });
  const evalFill = h("div", { class: "eval-fill" });
  const evalText = h("span", { class: "eval-label" });
  const evalBar = h("div", { class: "eval-bar", "aria-live": "off" }, evalFill, evalText);
  const boardArea = h("div", { class: "board-area" }, h("div", { class: "board-wrap" }, evalBar, boardEl));
  const topBar = h("div", { class: "player-bar" });
  const bottomBar = h("div", { class: "player-bar" });
  const banner = h("div", { class: "banner" });
  const title = h("h2", {});
  const meta = h("p", { class: "muted" });
  const actions = h("div", { class: "actions" });
  const moveList = h("ol", { class: "moves" });
  const nav = h("div", { class: "nav" });
  const boardCol = h("div", { class: "board-col" }, topBar, boardArea, bottomBar, nav);
  const body = h("div", { class: "game-body" }, boardCol, h("section", { class: "card moves-card" }, h("h3", {}, "Moves and reasoning"), moveList));
  const view = h("div", { class: `game${evalOn ? "" : " no-eval"}` }, h("div", { class: "game-head" }, h("div", {}, title, meta), actions), banner, body);
  document.body.classList.add("game-page");

  const source = new EventSource(`/api/games/${id}/events`);
  source.onmessage = (event) => {
    const data = JSON.parse(event.data);
    offset = Date.parse(data.serverNow) - Date.now();
    const first = !game;
    game = data.game;
    if (viewPly !== null && viewPly > game.moves.length) viewPly = null;
    if (first) {
      app.replaceChildren(view);
      fitBoard();
    }
    render();
    // A finished game can still be waiting for a cut-off call's cost.
    if (game.status !== "running" && !game.unfinishedCall) source.close();
  };
  source.onerror = () => {
    if (!game) {
      source.close();
      app.replaceChildren(h("p", { class: "error" }, "Couldn't load this game."));
    }
  };

  // The board takes the room the window leaves it: the height of its column next to the moves, or the width on narrow screens.
  function fitBoard() {
    const evalWidth = evalOn ? evalBar.offsetWidth + 6 : 0;
    const room = FILL_LAYOUT.matches
      ? Math.min(boardArea.clientHeight, body.clientWidth - MOVES_MIN_WIDTH - COLUMN_GAP - evalWidth)
      : Math.min(boardCol.clientWidth - evalWidth, 640);
    const size = Math.max(200, Math.floor(room / 8) * 8);
    view.style.setProperty("--board", `${size}px`);
  }
  const resize = new ResizeObserver(fitBoard);
  resize.observe(body);
  resize.observe(boardArea);
  FILL_LAYOUT.addEventListener("change", fitBoard);

  const tick = setInterval(() => game && renderClocks(), 100);
  const onKey = (e) => {
    if (!game || e.target.closest("input, select, textarea, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
    const current = viewPly ?? game.moves.length;
    if (e.key === "ArrowLeft") setView(Math.max(0, current - 1));
    else if (e.key === "ArrowRight") setView(Math.min(game.moves.length, current + 1));
    else if (e.key === "Home") setView(0);
    else if (e.key === "End") setView(game.moves.length);
    else if (e.key === "f" || e.key === "F") flip();
    else if (e.key === "e" || e.key === "E") toggleEval();
    else return;
    e.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  cleanup = () => {
    source.close();
    clearInterval(tick);
    resize.disconnect();
    FILL_LAYOUT.removeEventListener("change", fitBoard);
    document.removeEventListener("keydown", onKey);
    document.body.classList.remove("game-page");
    engine?.stop();
  };

  function setView(ply) {
    viewPly = ply >= game.moves.length ? null : ply;
    render();
  }

  function flip() {
    flipped = !flipped;
    if (flipped) flippedGames.add(id);
    else flippedGames.delete(id);
    render();
  }

  function toggleEval() {
    evalOn = !evalOn;
    saveSetting(EVAL_SETTING, evalOn ? "on" : "off");
    view.classList.toggle("no-eval", !evalOn);
    if (!evalOn) {
      engine?.stop();
      delete evalBar.dataset.fen; // analyse again when it's turned back on
    }
    fitBoard();
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

  function materialRow(color, material) {
    const taken = material.captured[color];
    const lead = color === "white" ? material.diff : -material.diff;
    const pieceColor = color === "white" ? "b" : "w";
    const groups = PIECE_ORDER.filter((p) => taken.includes(p)).map((p) =>
      h("span", { class: "taken-group" }, taken.filter((t) => t === p).map(() => h("span", { class: `taken ${pieceColor}` }, GLYPHS[p] + TEXT))),
    );
    const names = taken.map((p) => PIECE_NAMES[p]).join(", ");
    return h(
      "div",
      { class: "material", title: taken.length ? `Captured: ${names}` : "" },
      groups,
      lead > 0 ? h("span", { class: "lead" }, `+${lead}`) : null,
    );
  }

  function playerBar(bar, color, material) {
    bar.dataset.color = color;
    const spec = game[color];
    const illegal = game.illegalMoves[color];
    const offer = game.status === "running" && game.pendingDrawOffer === color;
    setChildren(
      bar,
      h(
        "div",
        { class: "who" },
        h(
          "div",
          { class: "who-line" },
          h("span", { class: `swatch ${color}`, title: capitalize(color) }),
          h("span", { class: "name" }, spec.model),
          h("span", { class: "muted provider" }, spec.provider === "anthropic" ? "Claude" : "ChatGPT"),
          spendBadge(game.spend?.[color]),
          illegal ? h("span", { class: "badge warn", title: "Illegal moves" }, `${illegal} illegal`) : null,
          offer ? h("span", { class: "badge" }, "offers a draw") : null,
        ),
        materialRow(color, material),
      ),
      h("span", { class: "clock" }),
    );
  }

  function render() {
    title.textContent = `${game.white.model} vs ${game.black.model}`;
    const state =
      game.status === "running" ? "Live" : game.status === "paused" ? "Paused" : game.status === "aborted" ? "Aborted" : game.result;
    document.title = `${state} · ${game.white.model} vs ${game.black.model} · Botwinnik`;
    meta.textContent = `${game.timeControl.label} ${game.timeControl.category} · ${formatDate(game.createdAt)} · colors ${game.colorsAssigned === "random" ? "drawn at random" : "chosen by the admin"} · game cost ${formatUsd(totalCost(game))}${unfinishedNote(game)}`;
    meta.title = totalCost(game) === null ? UNKNOWN_PRICE : "";

    const post = async (action) => {
      try {
        await api(`/games/${game.id}/${action}`, { method: "POST", body: "{}" });
      } catch (err) {
        alert(err.message);
      }
    };
    const stoppable = game.status === "running" || game.status === "paused";
    const over = game.status === "finished" || game.status === "aborted";
    setChildren(
      actions,
      over
        ? h(
            "button",
            {
              title: "Start a game between the same models with the same time control",
              onclick: () => openRematch({ white: game.white, black: game.black, timeControl: game.timeControl.label }),
            },
            "Rematch",
          )
        : null,
      game.status === "running"
        ? h("button", { disabled: true, title: "Available once the game is over or paused" }, "Download PGN")
        : h("a", { class: "button", href: `/api/games/${game.id}/pgn`, download: `botwinnik-${game.id}.pgn` }, "Download PGN"),
      game.status === "paused"
        ? h(
            "button",
            {
              class: "primary",
              onclick: async () => {
                await post("resume");
                route(); // reconnect to the live updates, which stop while paused
              },
            },
            "Resume",
          )
        : null,
      stoppable
        ? h(
            "button",
            {
              class: "danger",
              onclick: async () => {
                if (!confirm("Abort this game? It will be saved without a result.")) return;
                await post("abort");
                if (game.status === "paused") route();
              },
            },
            "Abort",
          )
        : null,
    );

    if (game.status === "running") {
      banner.className = "banner live";
      banner.textContent = `${capitalize(sideToMove())} (${game[sideToMove()].model}) is thinking…`;
    } else if (game.status === "paused") {
      banner.className = "banner paused";
      banner.textContent = game.events.findLast((e) => e.type === "paused")?.message ?? "Paused: resume the game to continue it.";
    } else {
      banner.className = `banner ${game.status}`;
      banner.replaceChildren(h("strong", {}, game.result), " ", game.termination?.message ?? "");
    }

    const shownPly = viewPly ?? game.moves.length;
    const fen = shownPly === 0 ? game.startFen : game.moves[shownPly - 1].fenAfter;
    const material = materialOf(game, shownPly);
    const [top, bottom] = flipped ? ["white", "black"] : ["black", "white"];
    playerBar(topBar, top, material);
    playerBar(bottomBar, bottom, material);
    renderClocks();

    const last = shownPly > 0 ? game.moves[shownPly - 1].uci : null;
    renderBoard(boardEl, fen, last, flipped);
    boardEl.setAttribute("aria-label", `Position after ${shownPly} half-moves${flipped ? ", from Black's side" : ""}: ${fen}`);
    renderEval(fen);

    nav.replaceChildren(
      h("button", { onclick: () => setView(0), disabled: shownPly === 0, "aria-label": "Start", title: "Start (Home)" }, "⏮"),
      h("button", { onclick: () => setView(Math.max(0, shownPly - 1)), disabled: shownPly === 0, "aria-label": "Back", title: "Back (←)" }, "◀"),
      h("span", { class: "muted nav-label" }, viewPly === null ? (game.status === "running" ? "Live" : game.status === "paused" ? "Paused" : "Final position") : `After ${shownPly} of ${game.moves.length}`),
      h("button", { onclick: () => setView(shownPly + 1), disabled: viewPly === null, "aria-label": "Forward", title: "Forward (→)" }, "▶"),
      h("button", { onclick: () => setView(game.moves.length), disabled: viewPly === null, "aria-label": "Latest", title: "Latest (End)" }, "⏭"),
      h(
        "span",
        { class: "toggles" },
        h("button", { class: "toggle", onclick: flip, "aria-pressed": String(flipped), "aria-label": "Flip the board", title: "Flip the board (F)" }, "⇅"),
        h("button", { class: "toggle", onclick: toggleEval, "aria-pressed": String(evalOn), title: "Show or hide the eval bar (E)" }, "Eval"),
      ),
    );

    renderMoves(shownPly);
  }

  function renderEval(fen) {
    if (!evalOn) return;
    evalBar.classList.toggle("flipped", flipped);
    if (evalBar.dataset.fen !== fen) {
      evalBar.dataset.fen = fen;
      evaluation = null;
      showEval();
      engine ??= new Engine();
      engine.analyse(fen, (update) => {
        if (evalBar.dataset.fen !== fen) return;
        evaluation = update;
        showEval();
      });
    } else {
      showEval();
    }
  }

  function showEval() {
    const share = whiteShare(evaluation);
    evalFill.style.height = `${(share * 100).toFixed(1)}%`;
    evalText.textContent = evaluation ? evalLabel(evaluation) : "…";
    const side = favored(evaluation) ?? "white";
    evalText.className = `eval-label ${side}`;
    // The label sits at the favored side's end of the bar.
    evalText.classList.toggle("top", (side === "white") === flipped);
    evalBar.title = evaluation?.error
      ? evaluation.error
      : `Stockfish evaluation${evaluation ? ` at depth ${evaluation.depth}` : ""}. Only you see this; the players don't.`;
  }

  function renderMoves(shownPly) {
    const before = rendered;
    rendered = { moves: game.moves.length, events: game.events.length, viewPly };
    const newMove = before !== null && game.moves.length > before.moves;
    if (newMove && viewPly === null) fresh = { ply: game.moves.length, at: performance.now() };
    // Re-renders during the flash continue its animation instead of restarting it.
    const flashed = fresh && performance.now() - fresh.at < FLASH_MS ? fresh : null;

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
          {
            class: `move${m.ply === shownPly ? " current" : ""}${m.ply === flashed?.ply ? " fresh" : ""}`,
            style: m.ply === flashed?.ply ? `animation-delay: -${Math.round(performance.now() - flashed.at)}ms` : null,
            "data-ply": m.ply,
            onclick: () => setView(m.ply),
          },
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
    moveList.replaceChildren(...(items.length ? items : [h("li", { class: "muted" }, "No moves yet.")]));

    if (viewPly === null) {
      // Following the game: bring a new move (and whatever came after it) into view.
      if (before && !newMove && game.events.length === before.events && before.viewPly === null) return;
      const latest = moveList.querySelector(`li[data-ply="${game.moves.length}"]`);
      reveal(latest ?? moveList.lastElementChild, moveList.lastElementChild, before !== null);
    } else if (!before || before.viewPly !== viewPly) {
      const current = moveList.querySelector(".current");
      if (current) reveal(current, current, true);
    }
  }

  /** Scrolls the move list (never the page) so `last` is visible without hiding the top of `first`. */
  function reveal(first, last, smooth) {
    if (!first) return;
    const margin = 6;
    let top = moveList.scrollTop;
    const bottom = last.offsetTop + last.offsetHeight + margin;
    if (bottom - top > moveList.clientHeight) top = bottom - moveList.clientHeight;
    if (first.offsetTop - margin < top) top = first.offsetTop - margin;
    top = Math.max(0, top);
    if (Math.abs(top - moveList.scrollTop) < 1) return;
    moveList.scrollTo({ top, behavior: smooth && !REDUCED_MOTION.matches ? "smooth" : "auto" });
  }
}

const PIECE_ORDER = ["p", "n", "b", "r", "q"];
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" };

/** Piece letters by square ("e4" → "P") from a FEN. */
function squaresOf(fen) {
  const squares = {};
  fen.split(" ")[0].split("/").forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch);
      else squares["abcdefgh"[file++] + (8 - r)] = ch;
    }
  });
  return squares;
}

/**
 * What each side has captured up to `ply` (lowercase piece letters) and the
 * material difference in pawns from White's side (promotions included).
 */
function materialOf(game, ply) {
  const captured = { white: [], black: [] };
  for (let i = 0; i < ply; i++) {
    const move = game.moves[i];
    const before = squaresOf(i === 0 ? game.startFen : game.moves[i - 1].fenAfter);
    const from = move.uci.slice(0, 2);
    const to = move.uci.slice(2, 4);
    let victim = before[to];
    // En passant: a pawn moving diagonally onto an empty square.
    if (!victim && before[from]?.toLowerCase() === "p" && from[0] !== to[0]) victim = "p";
    if (victim) captured[move.color].push(victim.toLowerCase());
  }
  const fen = ply === 0 ? game.startFen : game.moves[ply - 1].fenAfter;
  let diff = 0;
  for (const piece of Object.values(squaresOf(fen))) {
    const value = PIECE_VALUES[piece.toLowerCase()];
    diff += piece === piece.toUpperCase() ? value : -value;
  }
  return { captured, diff };
}

function renderBoard(el, fen, lastUci, flipped) {
  const pieces = squaresOf(fen);
  const highlight = new Set(lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : []);
  const squares = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      // Rank 8 at the top from White's side, rank 1 from Black's.
      const r = flipped ? 7 - row : row;
      const f = flipped ? 7 - col : col;
      const name = "abcdefgh"[f] + (8 - r);
      const sq = h("div", { class: `sq ${(r + f) % 2 ? "dark" : "light"}${highlight.has(name) ? " last" : ""}` });
      if (col === 0) sq.append(h("span", { class: "coord rank" }, 8 - r));
      if (row === 7) sq.append(h("span", { class: "coord file" }, "abcdefgh"[f]));
      const piece = pieces[name];
      if (piece) {
        const white = piece === piece.toUpperCase();
        sq.append(h("span", { class: `piece ${white ? "w" : "b"}` }, GLYPHS[piece.toLowerCase()] + TEXT));
      }
      squares.push(sq);
    }
  }
  el.replaceChildren(...squares);
}

// Sticky elements below the header need its height, which changes when the tagline wraps.
const topbar = document.querySelector(".topbar");
new ResizeObserver(() => document.documentElement.style.setProperty("--topbar-height", `${topbar.offsetHeight}px`)).observe(topbar);

window.addEventListener("hashchange", route);
route();
