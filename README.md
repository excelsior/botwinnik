# botwinnik

AI models play chess against each other. An admin sets up a game (time
control, the two models, optionally their colors), and Botwinnik asks each
model for its moves, runs the clocks, enforces the rules, saves the game with
the reasoning the models give for their moves, and exports it as PGN. Games
can be imported from PGN too, and a game exported while paused can be resumed
after importing it. Each model has an Elo rating for bullet, blitz, rapid and
classical that moves with every finished game.

ChatGPT (OpenAI API), Claude (Anthropic API), Gemini (Gemini API) and Grok
(xAI API) are supported.

## Setup

```bash
npm install
cp config.example.ini config.ini   # then add at least one API key
npm start                          # http://127.0.0.1:3000/
npm run dev                        # the same, restarting when the code or config.ini changes
```

`config.ini` holds the API keys and is git-ignored. At least one key must be
present; with a single key, models from that provider play each other (for
example Claude vs Claude). Keys come from
[platform.openai.com](https://platform.openai.com/api-keys),
[platform.claude.com](https://platform.claude.com/settings/keys),
[Google AI Studio](https://aistudio.google.com/apikey) and
[console.x.ai](https://console.x.ai).

```ini
[openai]
api_key = sk-...
models = gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna   ; listed first in the setup form
effort =                                           ; optional reasoning effort

[anthropic]
api_key = sk-ant-...
models = claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-1
effort =

[google]
api_key = AIza...
models = gemini-3.8-flash, gemini-3.1-pro-preview, gemini-2.5-pro, gemini-2.5-flash-lite
effort =                                           ; thinking level, Gemini 3 and later

[xai]
api_key = xai-...
models = grok-4.7, grok-4.6, grok-4.3
effort =

[app]
host = 127.0.0.1
port = 3000
games_dir = games
```

The setup form suggests every model each key can use, fetched from the
provider's API (OpenAI's, Google's and xAI's lists are narrowed to chat models
that support structured outputs), with the `models` from `config.ini` that the key can use
listed first. If the list can't be fetched, the form says why and suggests
just the `models` lists. Any model ID can be typed in either way. Use
`BOTWINNIK_CONFIG=/path/to/config.ini` (or `--config`) to read the file from
elsewhere.

## Using it

**Web page** (`npm start`): start a game and watch it live with the board,
both clocks, the material each side has captured and each move's reasoning.
The page fits the window: the board takes the height it has, and the move list
scrolls on its own, following each new move as it is played. Step through the
moves with the arrow keys (Home and End jump to the start and the latest
move), and flip the board with the ⇅ button or F. Abort a running game, resume
a paused one, download a game as PGN once it is over or paused, and import a
game from a PGN file on the home page. **Rematch** (on a finished game's page
or its row in the games list) starts a game between the same two models with
the same time control, with the colors swapped, kept or drawn at random. The
page only listens on this machine by default. After updating Botwinnik (say,
with `git pull`), restart it; until then the home page shows a reminder,
because the page updates on reload but the running server doesn't.
`npm run dev` restarts by itself whenever the code or `config.ini` changes
(changes to `public/` show on a page reload). Games running when the app
stops come back paused: resume one and the turn it stopped in starts over,
with the time the player had at its start.

**Eval bar:** next to the board, Stockfish evaluates the position shown. The
engine (Stockfish 18 lite, single-threaded WebAssembly, in
`public/vendor/stockfish/`, GPLv3) runs in your browser only: its evaluation
never reaches the server or the players' prompts. Hide or show it with the
Eval button or E; the choice is remembered in the browser.

**Command line:**

```bash
npm run botwinnik -- play --time 5+3 --white claude-opus-5-5 --black gpt-5.6-sol
npm run botwinnik -- play --time 10+0 --players claude-opus-5-5,gpt-5.6-sol   # random colors
npm run botwinnik -- models   # the models each key can use
npm run botwinnik -- resume <game-id>   # continue a paused game
npm run botwinnik -- list
npm run botwinnik -- ratings   # each model's Elo ratings (or: ratings blitz)
npm run botwinnik -- pgn <game-id> --out game.pgn
npm run botwinnik -- import game.pgn   # a game without a result comes back paused
```

A model can be written as `provider:model` (`openai:my-model`); the provider
can be left out when the name starts with `claude`, `gpt`, `gemini` or `grok`.

## Rules

- **Time control** is `minutes+seconds`, e.g. `5+3` or `10+0`. The wall-clock
  time of each API call comes off the player's clock, and the game ends the
  moment the clock reaches zero, even mid-request. Running out of time loses,
  unless the opponent has only a king left, which is a draw.
- **Game end:** checkmate, stalemate, insufficient material, threefold
  repetition and the fifty-move rule end the game immediately, with no claim
  needed.
- **Resigning and draws:** a player can resign, or offer a draw together with
  a move. The opponent accepts on their next turn, or declines by moving. A
  player who has offered a draw can't offer another until the opponent has
  offered one.
- **Illegal moves:** the move is taken back and the same player must move
  again on their running clock, while the opponent gets extra time: 2 minutes
  in classical games, 1 minute in bullet, blitz and rapid. A second illegal
  move loses the game. A reply with no usable move at all (unreadable, a
  refusal, accepting a draw nobody offered) is asked for again without
  penalty, but three in a row within one turn count as an illegal move.
- **Categories** follow FIDE, based on the time for a 60-move game
  (base + 60 × increment): up to 10 minutes is blitz (under 3 is bullet),
  under 60 minutes is rapid, 60 minutes or more is classical. So `30+30`
  and `60+0` are classical, `15+10` is rapid.
- **What players see** each turn: the position (FEN and a diagram), the moves
  so far, both clocks, any pending draw offer, whether they may offer a draw,
  their illegal-move count, and their own last few explanations. They do not
  get a list of legal moves, and never see the opponent's reasoning.
- **API errors:** temporary ones (rate limits, overload, network) are retried
  on the player's clock. Errors that retrying can't fix (bad key, unknown
  model) abort the game without a result.
- **Out of funds:** if a call fails because the API account has run out of
  money (OpenAI's exhausted quota, Anthropic's billing error or low credit
  balance, Gemini's depleted prepaid credits, spending cap or used-up daily
  quota, an xAI team with no credits or at its spending limit), the game pauses with both clocks stopped. Add funds, then press
  **Resume** on the game's page or run `botwinnik resume <game-id>`, and the
  game continues where it stopped, with the same player to move. Time spent
  paused doesn't count, and a paused game stays paused if the app is
  restarted. It can also be aborted.

Each reply is a JSON object (`reasoning`, `action`, `move`, `offer_draw`)
enforced through structured outputs on every API. Claude's refusal fallbacks
are deliberately not enabled, since they would let a different model play the
move.

## Costs

Every API reports the tokens each call uses (thinking/reasoning tokens count as
output). Botwinnik multiplies them by the model's price and records the cost:

- **per move:** every call in that turn, including rejected attempts such as
  illegal moves and unreadable replies;
- **per game:** each player's total and the sum, including turns that ended
  without a move (resigning, accepting a draw, a losing illegal move, running
  out of time).

The page shows the cost next to each move, under each player and in the
games list; `play` prints it per move and as a summary.

When a player runs out of time, or the game is aborted, while a model is still
thinking, the game ends right away but the request isn't cancelled: it runs to
the end so its cost can be added to that player's and the game's totals. The
page says it's waiting for that call, and `play` waits for it before exiting
(Ctrl+C skips the wait). A request still running when the app stops is lost
and isn't counted.

Prices (USD per million tokens) are built in for the current Claude,
GPT-5.6, Gemini and Grok models, as of October 2026. The GPT-5.6 prices come
from third-party listings rather than OpenAI's own page, and a few Gemini
ones (2.5 Flash, 3.1 Flash-Lite, 3.5 Flash-Lite, 3.6 Flash) from LiteLLM's
price list, so check them. Gemini 3.8 Flash is at its introductory price,
which doubles on January 1, 2027; the built-in price switches on that date.
Gemini and Grok charge more for prompts over 200k tokens, which a player's
prompt never comes close to. Set or override any model's price in
`config.ini`:

```ini
[prices]
; model = input, output[, cached input]
gpt-5.6-sol = 5, 30, 0.5
my-fine-tuned-model = 1.25, 10
```

A model without a price still has its tokens counted, and its cost shows as
unknown.

## Ratings

Every model has a separate Elo rating for each time control category:
bullet, blitz, rapid and classical. A game's category comes from its base
time plus 60 increments (the time for a 60-move game): under 3 minutes is
bullet, up to 10 minutes blitz, under 60 minutes rapid, and 60 minutes or more
classical. 5+3 is blitz, 10+5 rapid and 90+30 classical.

Each rating starts at 1500. Each finished game moves its players' ratings in
its category by K × (score − expected score), with K = 32 and the expected
score 1 / (1 + 10^((opponent − rating) / 400)), so a win against an equal
model gains 16 points and the loser drops by the same amount. Games count in
the order they ended. Aborted games and games between a model and itself
don't count; a paused game counts once it is resumed and finished.

The home page lists the ratings with a tab per category, and the game page
shows each player's rating in the game's category going into the game and,
once it's over, the change. `botwinnik ratings` prints a table per category
(`botwinnik ratings blitz` just one), and PGN exports carry the ratings going
into the game as `WhiteElo` and `BlackElo`.

Ratings are worked out again from the saved games whenever they're needed,
so they stay right when games are imported or game files are deleted. An
imported game that is already over counts as of when it was imported.

## Saved games and PGN

Every game is saved as `games/<id>.json` after each change, including the
moves, each move's reasoning, thinking time, clock, tokens and cost, and
events such as illegal moves and draw offers. Games interrupted by stopping the app are
marked as aborted the next time it starts.

PGN export includes the standard tags (`TimeControl`, `Termination`,
`WhiteType "program"`...), the clock after each move as `[%clk]` and the time
spent on it as `[%emt]`, the reasoning as move comments, and illegal moves,
draw offers and the final outcome as comments. It also carries what's needed
to restore the game exactly: tags for each player's provider, remaining clock
and total spend (`WhiteProvider`, `WhiteClock`, `WhiteSpend`...) and the game's
status, plus `[%spend]`, `[%draw]`, `[%event]` and `[%end]` commands in the
comments.

**Import** (home page, or `botwinnik import game.pgn`) reads one game per PGN.
A Botwinnik export comes back as it was, keeping its game ID unless a saved
game already has it. PGNs from elsewhere work too when they have a
`TimeControl` in seconds (`"300+3"`) and model names that start with `claude`,
`gpt`, `gemini` or `grok` (or `WhiteProvider`/`BlackProvider` tags saying
`anthropic`, `openai`, `google` or `xai`); their comments become the moves'
reasoning. A game without a result is imported paused, ready to resume from
its last position with the clocks it had, unless that position already ends
the game.

## Development

```bash
npm test            # node:test via tsx
npm run typecheck
```

`src/game` holds the engine (`game.ts`), PGN export and import, storage and
the game service; `src/players` the prompts and the OpenAI, Anthropic, Gemini
and xAI clients;
`src/server` the admin API; `public/` the web page.

### Dev container

The repository started as a TypeScript project for a dev container with
**Claude Code** and **Codex** preinstalled behind an egress firewall
(`.devcontainer/init-firewall.sh`, allowing GitHub, npm, Anthropic and OpenAI
among others). Open the folder in VS Code and run **Dev Containers: Reopen in
Container**, or `devcontainer up --workspace-folder .`.

To start Botwinnik with hot reload whenever the container starts, add
`scripts/start-dev-server.sh` to the `postStartCommand` in
`.devcontainer/devcontainer.json`, after the firewall script that already runs
there, and forward the port:

```jsonc
"postStartCommand": "... && ${containerWorkspaceFolder}/scripts/start-dev-server.sh",
"forwardPorts": [3000],
```

The script installs the dependencies if they're missing, then runs
`npm run dev` in the background with its output in `dev-server.log`. Without a
`config.ini` the server waits, and starts once the file is saved. For Gemini
and Grok, the firewall also has to allow `generativelanguage.googleapis.com`
and `api.x.ai`: add them to `ALLOWED_DOMAINS` in `init-firewall.sh`.
