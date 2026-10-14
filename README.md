# botwinnik

AI models play chess against each other. An admin sets up a game (time
control, the two models, optionally their colors), and Botwinnik asks each
model for its moves, runs the clocks, enforces the rules, saves the game with
the reasoning the models give for their moves, and exports it as PGN. Games
can be imported from PGN too, and a game exported while paused can be resumed
after importing it.

ChatGPT (OpenAI API) and Claude (Anthropic API) are supported.

## Setup

```bash
npm install
cp config.example.ini config.ini   # then add at least one API key
npm start                          # http://127.0.0.1:3000/
```

`config.ini` holds the API keys and is git-ignored. At least one key must be
present; with a single key, models from that provider play each other (for
example Claude vs Claude).

```ini
[openai]
api_key = sk-...
models = gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna   ; listed first in the setup form
effort =                                           ; optional reasoning effort

[anthropic]
api_key = sk-ant-...
models = claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-1
effort =

[app]
host = 127.0.0.1
port = 3000
games_dir = games
```

The setup form suggests every model each key can use, fetched from the
provider's API (OpenAI's list is narrowed to chat models that support
structured outputs), with the `models` from `config.ini` that the key can use
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
page only listens on this machine by default.

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
npm run botwinnik -- resume <game-id>   # continue a game paused for lack of funds
npm run botwinnik -- list
npm run botwinnik -- pgn <game-id> --out game.pgn
npm run botwinnik -- import game.pgn   # a game without a result comes back paused
```

A model can be written as `provider:model` (`openai:my-model`); the provider
can be left out when the name starts with `claude` or `gpt`.

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
  balance), the game pauses with both clocks stopped. Add funds, then press
  **Resume** on the game's page or run `botwinnik resume <game-id>`, and the
  game continues where it stopped, with the same player to move. Time spent
  paused doesn't count, and a paused game stays paused if the app is
  restarted. It can also be aborted.

Each reply is a JSON object (`reasoning`, `action`, `move`, `offer_draw`)
enforced through structured outputs on both APIs. Claude's refusal fallbacks
are deliberately not enabled, since they would let a different model play the
move.

## Costs

Both APIs report the tokens each call uses (thinking/reasoning tokens count as
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

Prices (USD per million tokens) are built in for current Claude models and
the GPT-5.6 models, as of October 2026. The GPT-5.6 prices come from
third-party listings rather than OpenAI's own page, so check them. Set or
override any model's price in `config.ini`:

```ini
[prices]
; model = input, output[, cached input]
gpt-5.6-sol = 5, 30, 0.5
my-fine-tuned-model = 1.25, 10
```

A model without a price still has its tokens counted, and its cost shows as
unknown.

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
`TimeControl` in seconds (`"300+3"`) and model names that start with `claude`
or `gpt` (or `WhiteProvider`/`BlackProvider` tags saying `anthropic` or
`openai`); their comments become the moves' reasoning. A game without a result
is imported paused, ready to resume from its last position with the clocks it
had, unless that position already ends the game.

## Development

```bash
npm test            # node:test via tsx
npm run typecheck
```

`src/game` holds the engine (`game.ts`), PGN export and import, storage and
the game service; `src/players` the prompts and the OpenAI and Anthropic clients;
`src/server` the admin API; `public/` the web page.

### Dev container

The repository started as a TypeScript project for a dev container with
**Claude Code** and **Codex** preinstalled behind an egress firewall
(`.devcontainer/init-firewall.sh`, allowing GitHub, npm, Anthropic and OpenAI
among others). Open the folder in VS Code and run **Dev Containers: Reopen in
Container**, or `devcontainer up --workspace-folder .`.
