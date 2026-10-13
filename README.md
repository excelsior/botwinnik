# botwinnik

AI models play chess against each other. An admin sets up a game (time
control, the two models, optionally their colors), and Botwinnik asks each
model for its moves, runs the clocks, enforces the rules, saves the game with
the reasoning the models give for their moves, and exports it as PGN.

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
models = gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna   ; suggestions in the setup form
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

The `models` lists only fill the suggestions in the setup form; any model ID
can be typed in. Use `BOTWINNIK_CONFIG=/path/to/config.ini` (or `--config`) to
read the file from elsewhere.

## Using it

**Web page** (`npm start`): start a game, watch it live with the board, both
clocks and each move's reasoning, step through finished games with the arrow
keys, abort a running game, and download any game as PGN. The page only
listens on this machine by default.

**Command line:**

```bash
npm run botwinnik -- play --time 5+3 --white claude-opus-5-5 --black gpt-5.6-sol
npm run botwinnik -- play --time 10+0 --players claude-opus-5-5,gpt-5.6-sol   # random colors
npm run botwinnik -- list
npm run botwinnik -- pgn <game-id> --out game.pgn
```

A model can be written as `provider:model` (`openai:my-model`); the provider
can be left out when the name starts with `claude` or `gpt`.

## Rules

- **Time control** is `minutes+seconds`, e.g. `5+3` or `10+0`. The wall-clock
  time of each API call comes off the player's clock, and the request is cut
  off when the clock reaches zero. Running out of time loses, unless the
  opponent has only a king left, which is a draw.
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
  model, exhausted quota) abort the game without a result.

Each reply is a JSON object (`reasoning`, `action`, `move`, `offer_draw`)
enforced through structured outputs on both APIs. Claude's refusal fallbacks
are deliberately not enabled, since they would let a different model play the
move.

## Saved games and PGN

Every game is saved as `games/<id>.json` after each change, including the
moves, each move's reasoning, thinking time and clock, and events such as
illegal moves and draw offers. Games interrupted by stopping the app are
marked as aborted the next time it starts.

PGN export includes the standard tags (`TimeControl`, `Termination`,
`WhiteType "program"`...), the clock after each move as `[%clk]`, the
reasoning as move comments, and illegal moves, draw offers and the final
outcome as comments.

## Development

```bash
npm test            # node:test via tsx
npm run typecheck
```

`src/game` holds the engine (`game.ts`), PGN export, storage and the game
service; `src/players` the prompts and the OpenAI and Anthropic clients;
`src/server` the admin API; `public/` the web page.

### Dev container

The repository started as a TypeScript project for a dev container with
**Claude Code** and **Codex** preinstalled behind an egress firewall
(`.devcontainer/init-firewall.sh`, allowing GitHub, npm, Anthropic and OpenAI
among others). Open the folder in VS Code and run **Dev Containers: Reopen in
Container**, or `devcontainer up --workspace-folder .`.
