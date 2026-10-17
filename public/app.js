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

const PROVIDER_NAMES = { openai: "ChatGPT", anthropic: "Claude", google: "Gemini", xai: "Grok", yandex: "Alice AI" };

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

const RESTART = "restart it (Ctrl+C, then npm start; npm run dev restarts by itself). Games in progress pause and can be resumed.";

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  // A server started before an update doesn't know the requests the updated page makes.
  if (res.status === 404 && body.error === "Not found") throw new Error(`The server doesn't handle this yet. If Botwinnik was just updated, ${RESTART}`);
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

/** "87.3%", "1.5%". */
function formatPercent(percent) {
  return `${percent.toFixed(1)}%`;
}

/** A side's illegal moves in a game, out of the moves it tried (legal or not), as the server counts them. */
function illegalMovesOf(game, color) {
  const illegal = game.illegalMoves[color];
  const tried = game.moves.filter((m) => m.color === color).length + illegal;
  return { illegal, tried, percent: tried ? (100 * illegal) / tried : null };
}

/** "1 inaccuracy", "2 mistakes". */
function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** An evaluation from White's side in words: "+1.3", "White mates in 3", "checkmate". */
function describeEval(evaluation) {
  if (evaluation.mate === 0) return "checkmate";
  if (evaluation.mate !== undefined) return `${evaluation.mate > 0 ? "White" : "Black"} mates in ${Math.abs(evaluation.mate)}`;
  return evalLabel(evaluation);
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
  const tournament = /^#\/tournament\/([\w-]+)/.exec(location.hash);
  const tournaments = tournament || location.hash === "#/tournaments";
  for (const link of document.querySelectorAll(".topnav a")) {
    const current = link.dataset.section === (tournaments ? "tournaments" : "games");
    if (current) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (match) showGame(match[1]);
  else if (tournament) showTournament(tournament[1]);
  else if (tournaments) showTournaments();
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
  const ratingsSection = h("section", { class: "card" }, h("h2", {}, "Ratings"), h("p", { class: "muted" }, "Loading…"));
  const gamesSection = h("section", { class: "card" }, h("h2", {}, "Games"), h("p", { class: "muted" }, "Loading…"));
  setChildren(
    app,
    setup.outdated
      ? h("div", { class: "banner warn", role: "status" }, `Botwinnik was updated after this server started, so parts of this page may not work until you ${RESTART}`)
      : null,
    h("div", { class: "home" }, h("div", { class: "home-side" }, newGameForm(setup), importForm()), h("div", { class: "home-main" }, ratingsSection, gamesSection)),
  );

  let ratedGames = null; // the finished games the ratings shown were worked out from
  let analyzing = false; // whether Stockfish was still analyzing games, so the accuracy shown can change
  const refresh = async () => {
    let games;
    try {
      games = await api("/games");
      gamesSection.replaceChildren(h("h2", {}, "Games"), gamesTable(games));
    } catch (err) {
      gamesSection.replaceChildren(h("h2", {}, "Games"), h("p", { class: "error" }, err.message));
      return;
    }
    // Ratings only change when a game finishes, and accuracy when Stockfish has analyzed one.
    const finished = games.filter((g) => g.status === "finished").map((g) => g.id).join();
    if (finished === ratedGames && !analyzing) return;
    try {
      const ratings = await api("/ratings");
      ratingsSection.replaceChildren(...ratingsCard(ratings));
      ratedGames = finished;
      analyzing = (ratings.analysis?.pending ?? 0) > 0;
    } catch (err) {
      ratingsSection.replaceChildren(h("h2", {}, "Ratings"), h("p", { class: "error" }, err.message));
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
      setup.providers.map((p) => h("option", { value: p.id }, PROVIDER_NAMES[p.id] ?? p.label)),
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
    // With more than one key configured, default to models from two providers.
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

const CATEGORY_NAMES = { bullet: "Bullet", blitz: "Blitz", rapid: "Rapid", classical: "Classical" };
const RATINGS_TAB_SETTING = "botwinnik.ratingsTab";

/**
 * The ratings card's contents: a tab per time category, each with its own
 * table, and one for every time control together. `categories` maps bullet,
 * blitz, rapid and classical to their models; `overall` is every model's
 * figures over all its games.
 */
function ratingsCard({ start, k, categories, overall, analysis }) {
  const rated = Object.keys(categories);
  const gamesIn = (c) => categories[c].reduce((sum, m) => sum + m.games, 0) / 2;
  if (!rated.some(gamesIn)) {
    return [h("h2", {}, "Ratings"), h("p", { class: "muted" }, `No rated games yet. Every model starts at ${start} in each time control.`)];
  }
  const order = [...rated, "all"];
  // The tab picked last time, or the time control with the most games.
  let current = loadSetting(RATINGS_TAB_SETTING, null);
  if (!order.includes(current)) current = rated.reduce((best, c) => (gamesIn(c) > gamesIn(best) ? c : best));

  const panel = h("div", { role: "tabpanel", id: "ratings-panel" });
  const tabs = order.map((c) =>
    h(
      "button",
      {
        type: "button",
        class: "chip",
        role: "tab",
        id: `ratings-tab-${c}`,
        "aria-controls": "ratings-panel",
        onclick: () => select(c),
        onkeydown: (e) => {
          const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
          if (!step) return;
          const next = order[(order.indexOf(current) + step + order.length) % order.length];
          select(next);
          tabs[order.indexOf(next)].focus();
        },
      },
      c === "all" ? "All" : (CATEGORY_NAMES[c] ?? c),
    ),
  );
  const select = (c) => {
    current = c;
    saveSetting(RATINGS_TAB_SETTING, c);
    tabs.forEach((tab, i) => {
      const selected = order[i] === c;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panel.setAttribute("aria-labelledby", `ratings-tab-${c}`);
    panel.replaceChildren(
      c === "all"
        ? overallTable(overall, analysis)
        : categories[c].length
          ? ratingsTable(categories[c], analysis)
          : h("p", { class: "muted" }, `No rated ${c} games yet. Every model starts at ${start}.`),
    );
  };
  select(current);
  const pending = analysis?.pending
    ? ` Stockfish is analyzing ${count(analysis.pending, "more game", "more games")}, so these can still change.`
    : "";

  return [
    h("div", { class: "card-head" }, h("h2", {}, "Ratings"), h("div", { class: "chips tabs", role: "tablist", "aria-label": "Time control" }, tabs)),
    panel,
    h(
      "p",
      { class: "muted note" },
      `Elo ratings from finished games, in the order they ended, kept separately for each time control. ` +
        `A game's time control counts its base time plus 60 increments: under 3 minutes is bullet, under 10 blitz, under 60 rapid, and 60 or more classical. ` +
        `Every model starts at ${start}, and each game moves its players' ratings by up to ${k} points. Aborted games and a model playing itself don't count for the ratings. ` +
        `Illegal is the share of the moves a model tried that were illegal (three unusable replies in a row count as one), and Accuracy ` +
        `(0 to 100%, worked out as Lichess does from Stockfish's evaluations) its average over the games Stockfish has analyzed: both over its finished games in the time control, ` +
        `a model playing itself included. All puts every time control together. Click a column's header to sort by it, and again to reverse.${pending}`,
    ),
  ];
}

/** A cell with the share of a model's moves that were illegal: "1.5%", or a dash when it tried none. */
function illegalCell(rate) {
  if (!rate || rate.percent === null) return h("td", { class: "num muted" }, "–");
  const title = `${count(rate.illegal, "illegal move", "illegal moves")} in ${count(rate.tried, "move", "moves")} tried, over ${count(rate.games, "finished game", "finished games")}`;
  return h("td", { class: "num", title }, formatPercent(rate.percent));
}

/** An average accuracy cell: "87.3%", or a dash before any game has been analyzed. */
function accuracyCell(average, analysis, where) {
  if (!average) {
    const why = analysis ? `None of its ${where} has been analyzed yet` : "Stockfish analysis is turned off in config.ini";
    return h("td", { class: "num muted", title: why }, "–");
  }
  return h("td", { class: "num", title: `Average over ${count(average.games, "analyzed game", "analyzed games")}` }, formatPercent(average.accuracy));
}

/** The sorts picked on this page, by setting, for when the browser doesn't keep settings. */
const sortsPicked = {};

/**
 * A table sortable by any column: a click on a column's header sorts by it
 * (names A to Z and places from first, everything else from the most), and a
 * second click the other way. Rows without a value for the column (null) go
 * last either way, and ties keep the rows' own order. The choice is kept
 * under `setting`, so it survives the page redrawing the table.
 *
 * Each column: { key, label, title?, text? (sorts as text), ascending?
 * (sorts up first), value(row, i), cell(row, i) }, where i is the row's place
 * in `rows`.
 */
function sortableTable({ className, columns, rows, setting, initial }) {
  const wrap = h("div", { class: "table-wrap" });
  const current = () => {
    const [key, direction] = String(sortsPicked[setting] ?? loadSetting(setting, "")).split(":");
    return columns.some((c) => c.key === key) ? { key, descending: direction === "desc" } : initial;
  };

  const draw = (focus) => {
    const sort = current();
    const column = columns.find((c) => c.key === sort.key);
    const sorted = rows.map((row, i) => ({ row, i, value: column.value(row, i) }));
    sorted.sort((a, b) => {
      if (a.value === null || b.value === null) return (a.value === null) - (b.value === null) || a.i - b.i;
      const order = column.text ? a.value.localeCompare(b.value) : a.value - b.value;
      return (sort.descending ? -order : order) || a.i - b.i;
    });
    const header = (c) => {
      const active = c.key === sort.key;
      const ascendingFirst = c.text || c.ascending;
      const next = active ? (sort.descending ? "ascending" : "descending") : ascendingFirst ? "ascending" : "descending";
      const mark = h("span", { class: "sort-mark", "aria-hidden": "true" }, active ? (sort.descending ? "▼" : "▲") : "");
      return h(
        "th",
        { class: c.text ? "sortable" : "num sortable", "aria-sort": active ? (sort.descending ? "descending" : "ascending") : null },
        h(
          "button",
          {
            type: "button",
            class: "sort",
            "data-sort": c.key,
            title: `${c.title ?? c.label}: sort ${next}`,
            onclick: () => {
              sortsPicked[setting] = `${c.key}:${next === "descending" ? "desc" : "asc"}`;
              saveSetting(setting, sortsPicked[setting]);
              draw(c.key);
            },
          },
          // Before a right-aligned label, so the label stays over its numbers.
          c.text ? [c.label, mark] : [mark, c.label],
        ),
      );
    };
    wrap.replaceChildren(
      h(
        "table",
        { class: className },
        h("thead", {}, h("tr", {}, columns.map(header))),
        h(
          "tbody",
          {},
          sorted.map(({ row, i }) => h("tr", {}, columns.map((c) => c.cell(row, i)))),
        ),
      ),
    );
    if (focus) wrap.querySelector(`button[data-sort="${focus}"]`)?.focus();
  };
  draw();
  return wrap;
}

const RATINGS_SORT_SETTING = "botwinnik.ratingsSort";
const OVERALL_SORT_SETTING = "botwinnik.overallSort";

/** A cell with a number in it. */
function num(value) {
  return h("td", { class: "num" }, value);
}

/** The Model column of a table of models, with the provider on hover. */
const MODEL_COLUMN = {
  key: "model",
  label: "Model",
  text: true,
  value: (m) => m.model,
  cell: (m) => h("td", { title: PROVIDER_NAMES[m.provider] ?? m.provider }, m.model),
};

/** A model's illegal-move share, null when it has none. */
const illegalPercent = (rate) => rate?.percent ?? null;

/** A time category's table, highest rating first to begin with. */
function ratingsTable(models, analysis) {
  return sortableTable({
    className: "ratings",
    rows: models,
    setting: RATINGS_SORT_SETTING,
    initial: { key: "rating", descending: true },
    columns: [
      { key: "place", label: "#", title: "Place by rating", ascending: true, value: (m, i) => i, cell: (m, i) => num(i + 1) },
      MODEL_COLUMN,
      { key: "rating", label: "Rating", value: (m) => m.rating, cell: (m) => h("td", { class: "num rating-cell" }, m.rating) },
      { key: "games", label: "Games", value: (m) => m.games, cell: (m) => num(m.games) },
      { key: "wins", label: "Won", value: (m) => m.wins, cell: (m) => num(m.wins) },
      { key: "draws", label: "Drawn", value: (m) => m.draws, cell: (m) => num(m.draws) },
      { key: "losses", label: "Lost", value: (m) => m.losses, cell: (m) => num(m.losses) },
      { key: "illegal", label: "Illegal", value: (m) => illegalPercent(m.illegalMoves), cell: (m) => illegalCell(m.illegalMoves) },
      {
        key: "accuracy",
        label: "Accuracy",
        value: (m) => m.accuracy?.accuracy ?? null,
        cell: (m) => accuracyCell(m.accuracy, analysis, "finished games in this time control"),
      },
    ],
  });
}

/** Every model's figures over all its finished games, whatever the time control: most games first to begin with. */
function overallTable(models, analysis) {
  return sortableTable({
    className: "ratings",
    rows: models,
    setting: OVERALL_SORT_SETTING,
    initial: { key: "games", descending: true },
    columns: [
      MODEL_COLUMN,
      { key: "games", label: "Games", value: (m) => m.games, cell: (m) => num(m.games) },
      { key: "illegal", label: "Illegal", value: (m) => illegalPercent(m.illegalMoves), cell: (m) => illegalCell(m.illegalMoves) },
      { key: "accuracy", label: "Accuracy", value: (m) => m.accuracy?.accuracy ?? null, cell: (m) => accuracyCell(m.accuracy, analysis, "finished games") },
    ],
  });
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

// ---------------------------------------------------------------- tournaments

const TOURNAMENT_PLAYERS = { min: 3, max: 20 };

/** "3", "2½", "½". */
function formatPoints(points) {
  const whole = Math.floor(points);
  return points === whole ? String(whole) : `${whole || ""}½`;
}

/** "1 round", "3 games". */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "a", "a and b", "a, b and c". */
function listing(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** USD for a set of game summaries; null when a model's price is unknown. */
function sumCost(games) {
  return games.some((g) => g.costUsd === null) ? null : games.reduce((sum, g) => sum + g.costUsd, 0);
}

async function showTournaments() {
  document.title = "Tournaments · Botwinnik";
  app.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  let setup;
  try {
    setup = await api("/setup");
  } catch (err) {
    app.replaceChildren(h("p", { class: "error" }, err.message));
    return;
  }
  const listSection = h("section", { class: "card" }, h("h2", {}, "Tournaments"), h("p", { class: "muted" }, "Loading…"));
  setChildren(
    app,
    setup.outdated
      ? h("div", { class: "banner warn", role: "status" }, `Botwinnik was updated after this server started, so parts of this page may not work until you ${RESTART}`)
      : null,
    h("div", { class: "home wide-side" }, h("div", { class: "home-side" }, newTournamentForm(setup)), h("div", { class: "home-main" }, listSection)),
  );
  const refresh = async () => {
    try {
      listSection.replaceChildren(h("h2", {}, "Tournaments"), tournamentsTable(await api("/tournaments")));
    } catch (err) {
      listSection.replaceChildren(h("h2", {}, "Tournaments"), h("p", { class: "error" }, err.message));
    }
  };
  await refresh();
  const timer = setInterval(refresh, 5000);
  cleanup = () => clearInterval(timer);
}

function newTournamentForm(setup) {
  const error = h("p", { class: "error", role: "alert" });
  const name = h("input", { id: "t-name", maxlength: 80, autocomplete: "off", placeholder: "Optional, e.g. October blitz" });
  const time = h("input", { id: "t-time", value: "5+3", required: true, autocomplete: "off", spellcheck: "false" });
  const presets = h(
    "div",
    { class: "chips" },
    setup.timeControls.map((tc) => h("button", { type: "button", class: "chip", onclick: () => { time.value = tc; } }, tc)),
  );
  const unlisted = setup.providers.filter((p) => p.modelsError);
  const note = unlisted.length
    ? h(
        "p",
        { class: "muted models-error" },
        `Couldn't fetch the model list for ${listing(unlisted.map((p) => p.label))}, so the suggestions come from config.ini. `,
        unlisted.map((p) => p.modelsError).join(" "),
      )
    : null;

  const list = h("ol", { class: "player-list" });
  const rows = [];
  let nextId = 0;
  const summary = h("p", { class: "muted hint" });
  const add = h("button", { type: "button", class: "small", onclick: () => addRow().focus() }, "Add player");
  const update = () => {
    rows.forEach((row, i) => row.number(i + 1, rows.length > TOURNAMENT_PLAYERS.min));
    add.disabled = rows.length >= TOURNAMENT_PLAYERS.max;
    const n = rows.length;
    summary.textContent =
      `${n} players: ${plural(n % 2 ? n : n - 1, "round")} of ${plural(Math.floor(n / 2), "game")}` +
      `${n % 2 ? ", one player resting each round" : ""}, ${plural((n * (n - 1)) / 2, "game")} in all.`;
  };
  const addRow = () => {
    const row = tournamentPlayerRow(setup, `t-player-${nextId++}`, nextChoice(setup, rows), () => {
      rows.splice(rows.indexOf(row), 1);
      row.el.remove();
      update();
    });
    rows.push(row);
    list.append(row.el);
    update();
    return row;
  };
  for (let i = 0; i < TOURNAMENT_PLAYERS.min; i++) addRow();

  const submit = h("button", { type: "submit", class: "primary" }, "Start tournament");
  return h(
    "form",
    {
      class: "card new-game new-tournament",
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = "";
        submit.disabled = true;
        try {
          const { tournament } = await api("/tournaments", {
            method: "POST",
            body: JSON.stringify({ name: name.value, timeControl: time.value, players: rows.map((r) => r.value()) }),
          });
          location.hash = `#/tournament/${tournament.id}`;
        } catch (err) {
          error.textContent = err.message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h("h2", {}, "New tournament"),
    h("label", { for: "t-name" }, "Name"),
    name,
    h("label", { for: "t-time" }, "Time control ", h("span", { class: "muted" }, "(minutes + seconds per move)")),
    time,
    presets,
    h("fieldset", {}, h("legend", {}, "Players"), list, note, add),
    summary,
    h(
      "p",
      { class: "muted hint" },
      "A round-robin: every model plays every other once. The games of a round are played at the same time, pairing numbers are drawn at random, and colors alternate from round to round.",
    ),
    submit,
    error,
  );
}

/** The first model, taking one from each provider in turn, that no row has yet. */
function nextChoice(setup, rows) {
  const taken = new Set(rows.map((r) => `${r.value().provider}:${r.value().model}`));
  const longest = Math.max(0, ...setup.providers.map((p) => p.models.length));
  for (let i = 0; i < longest; i++) {
    for (const provider of setup.providers) {
      const model = provider.models[i];
      if (model && !taken.has(`${provider.id}:${model.id}`)) return { provider: provider.id, model: model.id };
    }
  }
  return { provider: setup.providers[0].id, model: "" };
}

function tournamentPlayerRow(setup, id, choice, onRemove) {
  const number = h("span", { class: "muted player-number" });
  // "Claude" for "Claude (Anthropic)": the row has little room.
  const providerSelect = h("select", {}, setup.providers.map((p) => h("option", { value: p.id }, p.label.replace(/\s*\(.*\)$/, ""))));
  const picker = modelPicker(`${id}-model`, "Model");
  const fill = (model) => {
    const provider = setup.providers.find((p) => p.id === providerSelect.value);
    picker.setModels(provider.models);
    picker.input.value = model ?? provider.models[0]?.id ?? "";
  };
  providerSelect.value = choice.provider;
  providerSelect.addEventListener("change", () => fill());
  fill(choice.model);
  const remove = h("button", { type: "button", class: "remove", onclick: onRemove }, "×");
  return {
    el: h("li", { class: "player-row" }, number, providerSelect, picker.el, remove),
    number(n, removable) {
      number.textContent = n;
      providerSelect.setAttribute("aria-label", `Player ${n} provider`);
      picker.input.setAttribute("aria-label", `Player ${n} model`);
      remove.setAttribute("aria-label", `Remove player ${n}`);
      remove.title = removable ? "Remove this player" : `A tournament needs at least ${TOURNAMENT_PLAYERS.min} players`;
      remove.disabled = !removable;
    },
    value: () => ({ provider: providerSelect.value, model: picker.input.value.trim() }),
    focus: () => picker.input.focus(),
  };
}

function tournamentsTable(tournaments) {
  if (!tournaments.length) return h("p", { class: "muted" }, "No tournaments yet. Start one on the left.");
  const open = (t) => (location.hash = `#/tournament/${t.id}`);
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "games tournaments" },
      h("thead", {}, h("tr", {}, ["Tournament", "Time", "Progress", "Leader", "Cost"].map((t) => h("th", {}, t)))),
      h(
        "tbody",
        {},
        tournaments.map((t) =>
          h(
            "tr",
            { onclick: () => open(t), tabindex: 0, onkeydown: (e) => e.key === "Enter" && e.target === e.currentTarget && open(t) },
            h(
              "td",
              { class: "name-cell" },
              h("div", {}, t.name),
              h(
                "div",
                { class: "muted sub", title: `${formatDate(t.createdAt)}: ${t.players.map((p) => p.model).join(", ")}` },
                `${formatShortDate(t.createdAt)} · ${plural(t.players.length, "player")}`,
              ),
            ),
            h("td", { title: capitalize(t.category) }, t.timeControl),
            h(
              "td",
              { title: `${t.gamesPlayed} of ${t.gamesTotal} games finished` },
              t.status === "running"
                ? h("span", { class: "badge live" }, t.round ? `Round ${t.round} of ${t.rounds}` : "Running")
                : t.status === "finished"
                  ? "Finished"
                  : h("span", { class: "muted" }, "Aborted"),
              t.status === "running" && t.gamesPaused ? [" ", h("span", { class: "badge warn", title: "A game is waiting to be resumed" }, "Paused")] : null,
            ),
            h(
              "td",
              { class: "leader-cell" },
              t.leaders.length
                ? [listing(t.leaders.map((l) => l.model)), h("span", { class: "muted" }, ` ${formatPoints(t.leaders[0].points)}`)]
                : h("span", { class: "muted" }, "—"),
            ),
            h("td", { class: "cost", title: t.costUsd === null ? UNKNOWN_PRICE : "" }, formatUsd(t.costUsd)),
          ),
        ),
      ),
    ),
  );
}

function showTournament(id) {
  document.title = "Tournament · Botwinnik";
  app.replaceChildren(h("p", { class: "muted" }, "Loading…"));
  const title = h("h2", {});
  const meta = h("p", { class: "muted" });
  const actions = h("div", { class: "actions" });
  const banner = h("div", { class: "banner" });
  const standingsCard = h("section", { class: "card" });
  const roundsCard = h("section", { class: "card" });
  const page = h("div", { class: "tournament" }, h("div", { class: "game-head" }, h("div", {}, title, meta), actions), banner, standingsCard, roundsCard);
  let shown = false;

  const refresh = async () => {
    let data;
    try {
      data = await api(`/tournaments/${id}`);
    } catch (err) {
      if (!shown) app.replaceChildren(h("p", { class: "error" }, err.message));
      return;
    }
    if (!shown) {
      app.replaceChildren(page);
      shown = true;
    }
    render(data);
  };
  refresh();
  const timer = setInterval(refresh, 5000);
  cleanup = () => clearInterval(timer);

  function render({ tournament: t, round, standings, games, analysis }) {
    title.textContent = t.name;
    document.title = `${t.name} · Botwinnik`;
    const cost = sumCost(Object.values(games));
    meta.textContent =
      `${t.timeControl.label} ${t.timeControl.category} · ${plural(t.players.length, "player")}, round robin · ${formatDate(t.createdAt)} · ` +
      `${t.status === "running" ? "cost so far" : "cost"} ${formatUsd(cost)}`;
    meta.title = cost === null ? UNKNOWN_PRICE : "";

    setChildren(
      actions,
      t.status === "running"
        ? h(
            "button",
            {
              class: "danger",
              onclick: async () => {
                if (!confirm("Abort this tournament? Its games in progress are aborted, and no more rounds are played. Finished games still count for the ratings.")) return;
                try {
                  await api(`/tournaments/${t.id}/abort`, { method: "POST", body: "{}" });
                } catch (err) {
                  alert(err.message);
                }
                refresh();
              },
            },
            "Abort tournament",
          )
        : null,
    );

    const paused = Object.values(games).some((g) => g.status === "paused");
    banner.className = `banner ${t.status === "running" ? (paused ? "warn" : "live") : t.status}`;
    banner.textContent = tournamentState(t, round, standings, games);

    setChildren(
      standingsCard,
      h("h2", {}, "Standings"),
      standingsTable(standings, t.timeControl.category, analysis),
      h(
        "p",
        { class: "muted note" },
        `A win scores 1 and a draw ½; aborted games count for nobody. Ties are broken by Sonneborn-Berger (SB: the points of the models a model beat, plus half the points of those it drew with), then by wins. ` +
          `Illegal is the share of the moves the model tried in its finished games in this tournament that were illegal. ` +
          `Accuracy (0 to 100%, worked out as Lichess does from Stockfish's evaluations) is averaged over the model's finished games in this tournament that Stockfish has analyzed. ` +
          `Rating is the model's ${t.timeControl.category} rating now, with what this tournament's games did to it. ` +
          `Click a column's header to sort by it, and again to reverse.`,
      ),
    );
    setChildren(roundsCard, h("h2", {}, "Rounds"), h("div", { class: "rounds" }, t.rounds.map((r, i) => roundBlock(t, r, i + 1, round, games))));
  }
}

/** What the tournament is doing, in a sentence or three. */
function tournamentState(t, round, standings, games) {
  if (t.status === "finished") {
    const winners = standings.filter((s) => s.rank === 1 && s.played > 0);
    if (!winners.length) return "Finished, without a single finished game.";
    const points = `${formatPoints(winners[0].points)} point${winners[0].points === 1 ? "" : "s"}`;
    return winners.length === 1
      ? `Finished. ${winners[0].model} wins with ${points}.`
      : `Finished. ${listing(winners.map((w) => w.model))} share first place with ${points}.`;
  }
  if (t.status === "aborted") return `${t.message ?? "Aborted."} Finished games still count for the ratings.`;
  const current = t.rounds[round - 1];
  if (!current) return "Moving on to the next round…";
  const paused = current.games.filter((p) => games[p.gameId]?.status === "paused").length;
  return [
    `Round ${round} of ${t.rounds.length} is being played.`,
    current.bye !== null ? `${t.players[current.bye].model} rests this round.` : "",
    paused ? `${paused === 1 ? "A game is" : `${paused} games are`} paused: resume ${paused === 1 ? "it" : "them"} from the game page to play on.` : "",
    round < t.rounds.length ? "The next round starts when every game of this one is over." : "",
  ]
    .filter(Boolean)
    .join(" ");
}

const STANDINGS_SORT_SETTING = "botwinnik.standingsSort";

/** The tournament's standings, most points first to begin with (ties as ranked: tiebreak, then wins). */
function standingsTable(standings, category, analysis) {
  // No places until a game has finished.
  const ranked = standings.some((s) => s.played > 0);
  const sb = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""));
  // Accuracy and illegal moves mean nothing before a model has finished a game.
  const played = (s, value) => (s.played ? value : null);
  return sortableTable({
    className: "ratings standings",
    rows: standings,
    setting: STANDINGS_SORT_SETTING,
    initial: { key: "points", descending: true },
    columns: [
      { key: "rank", label: "#", title: "Place", ascending: true, value: (s, i) => i, cell: (s) => num(ranked ? s.rank : "") },
      { key: "model", label: "Model", text: true, value: (s) => s.model, cell: (s) => h("td", {}, s.model) },
      { key: "points", label: "Points", value: (s) => s.points, cell: (s) => h("td", { class: "num rating-cell" }, formatPoints(s.points)) },
      { key: "played", label: "Played", value: (s) => s.played, cell: (s) => num(s.played) },
      { key: "wins", label: "Won", value: (s) => s.wins, cell: (s) => num(s.wins) },
      { key: "draws", label: "Drawn", value: (s) => s.draws, cell: (s) => num(s.draws) },
      { key: "losses", label: "Lost", value: (s) => s.losses, cell: (s) => num(s.losses) },
      {
        key: "tiebreak",
        label: h("abbr", { title: "Sonneborn-Berger tiebreak" }, "SB"),
        title: "Sonneborn-Berger tiebreak",
        value: (s) => s.tiebreak,
        cell: (s) => num(sb(s.tiebreak)),
      },
      {
        key: "illegal",
        label: "Illegal",
        value: (s) => played(s, illegalPercent(s.illegalMoves)),
        cell: (s) => (s.played ? illegalCell(s.illegalMoves) : num("")),
      },
      {
        key: "accuracy",
        label: "Accuracy",
        value: (s) => played(s, s.accuracy?.accuracy ?? null),
        cell: (s) => (s.played ? accuracyCell(s.accuracy, analysis, "finished games in this tournament") : num("")),
      },
      {
        key: "rating",
        label: "Rating",
        value: (s) => s.rating?.now ?? null,
        cell: (s) =>
          h(
            "td",
            { class: "num", title: `${CATEGORY_NAMES[category] ?? category} rating now, and the change from this tournament's games` },
            s.rating ? [String(s.rating.now), s.played ? ratingChange(s.rating.change) : h("span", { class: "rating-change" })] : "",
          ),
      },
    ],
  });
}

function ratingChange(delta) {
  return h("span", { class: `rating-change${delta > 0 ? " up" : delta < 0 ? " down" : ""}` }, delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : "±0");
}

function roundBlock(t, r, number, current, games) {
  const live = t.status === "running" && number === current;
  const ahead = r.games.every((p) => !p.gameId);
  const state = live
    ? h("span", { class: "badge live" }, "In progress")
    : ahead
      ? h("span", { class: "muted" }, t.status === "running" ? "Upcoming" : "Not played")
      : null;
  const open = (game) => (location.hash = `#/game/${game.id}`);
  return h(
    "section",
    { class: `round${live ? " current" : ""}${ahead ? " ahead" : ""}` },
    h(
      "div",
      { class: "round-head" },
      h("h3", {}, `Round ${number}`),
      state,
      r.bye !== null ? h("span", { class: "muted rests" }, `${t.players[r.bye].model} rests`) : null,
    ),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "games round-games" },
        h("thead", {}, h("tr", {}, ["White", "Black", "Result", "Moves", "Cost"].map((c) => h("th", {}, c)))),
        h(
          "tbody",
          {},
          r.games.map((p) => {
            const game = p.gameId ? games[p.gameId] : null;
            return h(
              "tr",
              game
                ? { onclick: () => open(game), tabindex: 0, onkeydown: (e) => e.key === "Enter" && e.target === e.currentTarget && open(game) }
                : { class: "unplayed" },
              h("td", {}, t.players[p.white].model),
              h("td", {}, t.players[p.black].model),
              h("td", { title: game?.termination ?? "" }, gameState(game)),
              h("td", {}, game ? Math.ceil(game.moves / 2) : ""),
              h("td", { class: "cost", title: game?.costUsd === null ? UNKNOWN_PRICE : "" }, game ? formatUsd(game.costUsd) : ""),
            );
          }),
        ),
      ),
    ),
  );
}

/** A game summary's result, or where it stands. */
function gameState(game) {
  if (!game) return h("span", { class: "muted" }, "—");
  if (game.status === "running") return h("span", { class: "badge live" }, "Live");
  if (game.status === "paused") return h("span", { class: "badge warn" }, "Paused");
  if (game.status === "aborted") return h("span", { class: "muted" }, "aborted");
  return h("span", { class: "result" }, game.result);
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
  let ratings = null; // { white: { before, after? }, black: ... }, or null for an unrated game
  let analysis = null; // Stockfish's analysis once the game is over: { status, ... }, or null

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
    ratings = data.ratings ?? null;
    analysis = data.analysis ?? null;
    if (viewPly !== null && viewPly > game.moves.length) viewPly = null;
    if (first) {
      app.replaceChildren(view);
      fitBoard();
    }
    render();
    // A finished game can still be waiting for a cut-off call's cost, or for Stockfish.
    const analyzing = analysis?.status === "queued" || analysis?.status === "analyzing";
    if (game.status !== "running" && !game.unfinishedCall && !analyzing) source.close();
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

  /** The rating going into the game, and what the game did to it once it's over. */
  function ratingTag({ before, after }) {
    const kind = `${CATEGORY_NAMES[game.timeControl.category] ?? ""} Elo rating`.trim();
    if (after === undefined) return h("span", { class: "rating", title: kind }, String(before));
    const delta = after - before;
    return h(
      "span",
      { class: "rating", title: `${kind}: ${before} before this game, ${after} after it` },
      String(before),
      h("span", { class: `rating-change${delta > 0 ? " up" : delta < 0 ? " down" : ""}` }, delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : "±0"),
    );
  }

  /** How hard the player is set to think, once the game knows. */
  function effortTag(color) {
    const effort = game.effort?.[color];
    if (effort === undefined) return null;
    if (effort === null) {
      return h("span", { class: "effort", title: "No effort level is sent, so the model thinks as much as it does by default" }, "default effort");
    }
    return h("span", { class: "effort", title: `Reasoning effort: ${effort}, set by the time control` }, `${effort} effort`);
  }

  /** The player's accuracy, once Stockfish has analyzed the game. */
  function accuracyTag(color) {
    const side = analysis?.status === "done" ? analysis[color] : null;
    if (side?.accuracy === null || side?.accuracy === undefined) return null;
    const judged = [
      count(side.inaccuracies, "inaccuracy", "inaccuracies"),
      count(side.mistakes, "mistake", "mistakes"),
      count(side.blunders, "blunder", "blunders"),
    ];
    const title =
      `Accuracy ${formatPercent(side.accuracy)} over ${count(side.moves, "move", "moves")}, from ${analysis.engine} at depth ${analysis.depth}, ` +
      `worked out as Lichess does. ${capitalize(listing(judged))}; average centipawn loss ${Math.round(side.acpl)}.`;
    return h("span", { class: "accuracy", title }, `${formatPercent(side.accuracy)} accuracy`);
  }

  /** The player's illegal moves, as a share of the moves it tried, once it has made one. */
  function illegalTag(color) {
    const { illegal, tried, percent } = illegalMovesOf(game, color);
    if (!illegal) return null;
    const title = `${count(illegal, "illegal move", "illegal moves")} in ${count(tried, "move", "moves")} tried (${formatPercent(percent)})`;
    return h("span", { class: "illegal", title }, `${illegal} illegal · ${formatPercent(percent)}`);
  }

  function spendBadge(spend) {
    if (!spend) return null;
    return h("span", { class: "spend muted", title: spendTitle(spend) }, formatUsd(spend.costUsd));
  }

  /** Under the name: the player's effort, accuracy and illegal moves, then the pieces it has captured. */
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
      effortTag(color),
      accuracyTag(color),
      illegalTag(color),
      groups,
      lead > 0 ? h("span", { class: "lead" }, `+${lead}`) : null,
    );
  }

  function playerBar(bar, color, material) {
    bar.dataset.color = color;
    const spec = game[color];
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
          ratings ? ratingTag(ratings[color]) : null,
          h("span", { class: "muted provider" }, PROVIDER_NAMES[spec.provider] ?? spec.provider),
          spendBadge(game.spend?.[color]),
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
    setChildren(
      meta,
      `${game.timeControl.label} ${game.timeControl.category} · ${formatDate(game.createdAt)} · `,
      game.tournament
        ? [`round ${game.tournament.round} of `, h("a", { href: `#/tournament/${game.tournament.id}` }, game.tournament.name)]
        : `colors ${game.colorsAssigned === "random" ? "drawn at random" : "chosen by the admin"}`,
      ` · game cost ${formatUsd(totalCost(game))}${unfinishedNote(game)}`,
    );
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
                const going = game.tournament ? ", and the tournament goes on without it" : "";
                if (!confirm(`Abort this game? It will be saved without a result${going}.`)) return;
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
      setChildren(banner, h("strong", {}, game.result), " ", game.termination?.message ?? "", analysisState());
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

  /** Where Stockfish's analysis of the finished game stands, until it's done. */
  function analysisState() {
    const text =
      analysis?.status === "queued"
        ? "Waiting for Stockfish to analyze this game for the players' accuracy…"
        : analysis?.status === "analyzing"
          ? `Stockfish is analyzing this game: ${analysis.progress.done} of ${analysis.progress.total} positions…`
          : analysis?.status === "failed"
            ? `Stockfish couldn't analyze this game: ${analysis.error}`
            : null;
    return text ? h("span", { class: `analysis-state${analysis.status === "failed" ? " failed" : ""}` }, text) : null;
  }

  /** Stockfish's verdict on a move: its judgement (?!, ?, ??), and what it would have played. */
  function moveVerdict(m) {
    const report = analysis?.status === "done" ? analysis.moves[m.ply - 1] : null;
    if (!report) return { title: "", mark: null };
    const chances = `${Math.round(report.winBefore)}% → ${Math.round(report.winAfter)}%`;
    const best = report.bestSan ? ` Stockfish preferred ${report.bestSan}.` : "";
    const title = `Stockfish: ${describeEval(report.eval)} after this move. ${capitalize(m.color)}'s winning chances ${chances}, move accuracy ${Math.round(report.accuracy)}%.${best}`;
    const mark = report.judgement
      ? h("span", { class: `judgement ${report.judgement}`, title: `${capitalize(report.judgement)}. ${title}` }, JUDGEMENT_MARKS[report.judgement])
      : null;
    return { title, mark };
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
      const verdict = moveVerdict(m);
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
            h("span", { class: "san", title: verdict.title }, m.san, verdict.mark),
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

const JUDGEMENT_MARKS = { inaccuracy: "?!", mistake: "?", blunder: "??" };

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
