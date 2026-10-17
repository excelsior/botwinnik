# botwinnik

AI models play chess against each other. An admin sets up a game (time
control, the two models, optionally their colors), and Botwinnik asks each
model for its moves, runs the clocks, enforces the rules, saves the game with
the reasoning the models give for their moves, and exports it as PGN. Games
can be imported from PGN too, and a game exported while paused can be resumed
after importing it. Each model has an Elo rating for bullet, blitz, rapid and
classical that moves with every finished game. Models can also meet in
round-robin tournaments, whose games count for the ratings like any other.
Once a game is over, Stockfish analyzes it and works out each player's
accuracy, which the app keeps per game, per tournament and per time control,
along with the share of each model's moves that were illegal.

ChatGPT (OpenAI API), Claude (Anthropic API), Gemini (Gemini API), Grok
(xAI API) and Yandex's Alice AI and YandexGPT (Yandex AI Studio) are
supported.

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
[console.x.ai](https://console.x.ai). Yandex takes two settings: an API key
of a service account with the `ai.languageModels.user` role, created in the
[Yandex Cloud console](https://console.yandex.cloud), and the ID of the folder
the service account is in, where the models run and are billed.

```ini
[openai]
api_key = sk-...
models = gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna   ; listed first in the setup form
effort =                                           ; by time category, see below

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

[yandex]
api_key = AQVN...                                  ; the service account's API key
folder_id = b1g...                                 ; its folder
models = aliceai-llm, aliceai-llm-flash, yandexgpt-5.1
effort =                                           ; for the models that reason

[analysis]
engine =                                           ; empty: the bundled Stockfish (see Accuracy)
depth = 18

[app]
host = 127.0.0.1
port = 3000
games_dir = games
```

`effort` sets how hard the models think, by the game's time category. Left
empty, it is `low` for bullet, `medium` for blitz, `high` for rapid and `max`
for classical, so the faster the game, the faster the moves. `max` means the
highest level the API has (OpenAI's `xhigh`; Gemini's, Grok's and Yandex's
`high`). One level (say `effort = low`) applies to every game; four,
comma-separated, set bullet, blitz, rapid and classical
(`effort = low, low, medium, high`), and
`default` leaves a category to the model's own default. The levels are each
API's own: `none`, `minimal`, `low`, `medium`, `high` and `xhigh` for OpenAI;
`low`, `medium`, `high`, `xhigh` and `max` for Claude; `minimal`, `low`,
`medium` and `high` for Gemini 3 and later (Gemini 2.5 ignores it); `low`,
`medium` and `high` for Grok and Yandex (whose reasoning models take it). Not
every model takes every level: when the API turns one down, the player asks
again a level lower, down to `low`, and then with no effort at all. Each
model's turned-down levels are remembered until the app restarts, so that
costs a quick extra request once.

The setup form suggests every model each key can use, fetched from the
provider's API (OpenAI's, Google's and xAI's lists are narrowed to chat models
that support structured outputs, Yandex's to text models), with the `models`
from `config.ini` that the key can use listed first. If the list can't be
fetched, the form says why and suggests just the `models` lists. Any model ID
can be typed in either way. Yandex names its models by URI,
`gpt://<folder_id>/<model>`; Botwinnik's IDs leave out the
`gpt://<folder_id>/` (and a trailing `/latest`), so `aliceai-llm` means
`gpt://<folder_id>/aliceai-llm`, and a whole URI works too. Use
`BOTWINNIK_CONFIG=/path/to/config.ini` (or `--config`) to read the file from
elsewhere.

## Using it

**Web page** (`npm start`): start a game and watch it live with the board,
both clocks, the material each side has captured and each move's reasoning.
Under each player's name is the reasoning effort its moves are asked at
("default effort" when none is sent; see `effort` under Setup) and, once
Stockfish has analyzed the finished game, its accuracy, with Stockfish's
?!, ? and ?? after its inaccuracies, mistakes and blunders in the move list
(see Accuracy), and, once it has made one, its illegal moves (see Illegal
moves).
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
npm run botwinnik -- ratings   # each model's Elo ratings, illegal moves and accuracy (or: ratings blitz)
npm run botwinnik -- analyze   # analyze the finished games that haven't been yet
npm run botwinnik -- analyze <game-id>   # analyze a game again
npm run botwinnik -- pgn <game-id> --out game.pgn
npm run botwinnik -- import game.pgn   # a game without a result comes back paused
```

A model can be written as `provider:model` (`openai:my-model`); the provider
can be left out when the name starts with `claude`, `gpt`, `gemini`, `grok`,
`aliceai` or `yandexgpt`.

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
- **Categories** are based on the time for a 60-move game (base + 60 ×
  increment), as FIDE does: under 10 minutes is blitz (under 3 is bullet),
  under 60 minutes is rapid, 60 minutes or more is classical. So `10+0` and
  `15+10` are rapid, `30+30` and `60+0` classical.
- **What players see** each turn: the position (FEN and a diagram), the moves
  so far, both clocks, any pending draw offer, whether they may offer a draw,
  their illegal-move count, and their own last few explanations. They do not
  get a list of legal moves, and never see the opponent's reasoning.
- **Time management:** the prompt tells players that the clock is part of the
  game, to play routine moves fast and keep time for critical positions. Each
  turn says how long their previous move took and suggests a time for this
  one: the time left spread over the moves still likely to come (35 at the
  start, never fewer than 10), plus the increment. Under a minute (or a fifth
  of the base time, if less), they are told they are low on time. How hard
  they think also follows the time category (see `effort` under Setup).
- **API errors:** temporary ones (rate limits, overload, network) are retried
  on the player's clock. Errors that retrying can't fix (bad key, unknown
  model) abort the game without a result.
- **Out of funds:** if a call fails because the API account has run out of
  money (OpenAI's exhausted quota, Anthropic's billing error or low credit
  balance, Gemini's depleted prepaid credits, spending cap or used-up daily
  quota, an xAI team with no credits or at its spending limit, a suspended
  Yandex Cloud billing account), the game pauses with both clocks stopped.
  Add funds, then press **Resume** on the game's page or run
  `botwinnik resume <game-id>`, and the game continues where it stopped,
  with the same player to move. Time spent paused doesn't count, and a
  paused game stays paused if the app is restarted. It can also be aborted.

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
prompt never comes close to. Yandex's models have no built-in price: add
them under `[prices]` from
[Yandex's pricing page](https://aistudio.yandex.ru/docs/en/ai-studio/pricing.html),
which gives them per 1,000 tokens, so multiply by 1,000. Set or override any
model's price in `config.ini`:

```ini
[prices]
; model = input, output[, cached input]
gpt-5.6-sol = 5, 30, 0.5
my-fine-tuned-model = 1.25, 10
```

A model without a price still has its tokens counted, and its cost shows as
unknown.

## Accuracy

Every finished game is analyzed by Stockfish once it's over: the server
evaluates the start position and the position after every move, in the
background, one game at a time. Games are never analyzed while they're
played (running or paused), so nothing the engine finds can reach the
players. When the server starts, it queues the finished games that haven't
been analyzed yet, newest first (imported ones included), and a game whose
page is opened goes to the front of the queue. The game page shows the
progress until the analysis is done. `play` analyzes its game after it ends
(Ctrl+C skips that), and `botwinnik analyze` analyzes what's left without
the server.

Accuracy is worked out the way [Lichess](https://lichess.org/page/accuracy)
does it. Each evaluation becomes a winning chance from 0 to 100% (evaluations
past ten pawns, and mates, count as ten pawns), and each move scores 0 to 100
by how much of its player's winning chance it gave away. A game's accuracy
for a player is the average of two means of its move scores: one weighted by
how much the position was swinging at the time, and the harmonic mean, which
a few bad moves pull down hard. A move that gives away 5 points of winning
chance is an inaccuracy (?!), 10 a mistake (?) and 15 a blunder (??).
Hover over a move to see the evaluation after it, its score and the move
Stockfish preferred, and over a player's accuracy for the counts and the
average centipawn loss.

A model's accuracy over several games is the plain average of its game
accuracies: per time category in the ratings tables (home page and
`botwinnik ratings`) and per tournament in the standings. Only finished
games count, and a model playing itself counts for both sides.

The engine is the Stockfish 18 lite build the eval bar uses
(single-threaded WebAssembly, in `public/vendor/stockfish/`), run with Node,
so it needs nothing installed. It searches each position to depth 18, which
takes it roughly half a second a position, so a 40-move game takes under a
minute.
`[analysis]` in `config.ini` changes that:

```ini
[analysis]
engine = /usr/local/bin/stockfish   ; any UCI engine: a path (relative to config.ini) or a command on the PATH
depth = 20                          ; plies searched for each position
```

A native Stockfish is several times faster. `engine = off` stops analyzing
games; the analyses already saved still count. Changing the engine or the
depth doesn't redo games already analyzed; `botwinnik analyze <game-id>` does,
one game at a time. If the engine can't start, the server says so, and the
games waiting for it are tried again when it restarts.

## Illegal moves

Every illegal move a model tries is counted (see Rules: three unusable
replies in a row within one turn count as one), and the app shows it as a
share of all the moves the model tried, legal or not: 1 illegal move in a
game where it played 39 legal ones is 2.5%. The game page shows it for each
player, and `play` prints it when the game ends. Over several games the
illegal moves and the moves tried are added up before dividing, so a long
game counts for more than a short one: per time category and for every time
control together in the ratings tables (home page and `botwinnik ratings`),
and per tournament in the standings. Only finished games count, and a model
playing itself counts for both sides. The counts come straight from the
saved games, so they cover every game played before this was added too.

## Ratings

Every model has a separate Elo rating for each time control category:
bullet, blitz, rapid and classical. A game's category comes from its base
time plus 60 increments (the time for a 60-move game): under 3 minutes is
bullet, under 10 minutes blitz, under 60 minutes rapid, and 60 minutes or more
classical. 5+3 is blitz, 10+0 rapid and 90+30 classical.

Each rating starts at 1500. Each finished game moves its players' ratings in
its category by K × (score − expected score), with K = 32 and the expected
score 1 / (1 + 10^((opponent − rating) / 400)), so a win against an equal
model gains 16 points and the loser drops by the same amount. Games count in
the order they ended. Aborted games and games between a model and itself
don't count; a paused game counts once it is resumed and finished.

The home page lists the ratings with a tab per category, next to each
model's illegal moves and accuracy in that category (see Illegal moves and
Accuracy), and an All tab with those over every time control. A click on a
column's header sorts a table by it, and a second click the other way; the
page remembers the choice, for the standings too. The game page
shows each player's rating in the game's category going into the game and,
once it's over, the change. `botwinnik ratings` prints a table per category
and one for every time control together (`botwinnik ratings blitz` just the
one category), illegal moves and accuracy included, and PGN exports carry the ratings going
into the game as `WhiteElo` and `BlackElo`.

Ratings are worked out again from the saved games whenever they're needed,
so they stay right when games are imported or game files are deleted. An
imported game that is already over counts as of when it was imported.

## Tournaments

The **Tournaments** tab of the page runs round-robins. The admin names the
tournament (optional), picks a time control and adds at least three different
models (at most 20), and every model plays every other once. With an odd
number of models one of them rests each round, a different one each time. The
pairing numbers are drawn at random and the schedule follows FIDE's Berger
tables, so colors alternate from round to round: each model gets as many
Whites as Blacks, or one more of either when the number of models is even.

All the games of a round are played at the same time, and the next round
starts once every one of them is over. A paused game holds its round until it
is resumed (or aborted). An aborted game scores for nobody and the tournament
goes on without it. **Abort tournament** aborts the games in progress and
plays no more rounds.

Each tournament's page shows the standings (1 point for a win, ½ for a draw,
ties broken by Sonneborn-Berger and then by wins), each model's rating in the
tournament's time category with what the tournament's games did to it, and
every round's games, ongoing or finished, each linking to its game page. The
games are ordinary games otherwise: they are listed with the others, count for
the ratings, and their PGN carries the tournament's name and round in the
`Event` and `Round` tags.

If the app stops while a tournament runs, the tournament carries on when it
starts again. The games the stop cut off come back paused (see above) and hold
their round until they are resumed. Tournaments are saved as
`games/tournaments/<id>.json`.

The standings also show the share of each model's moves in its tournament
games that were illegal (see Illegal moves), and its accuracy over those
that Stockfish has analyzed (see Accuracy). They're sorted by points to
begin with (ties as ranked); a click on a column's header sorts them by it
instead, and a second click the other way.

## Saved games and PGN

Every game is saved as `games/<id>.json` after each change, including the
moves, each move's reasoning, thinking time, clock, tokens and cost, and
events such as illegal moves and draw offers. Games interrupted by stopping the app are
marked as aborted the next time it starts. Stockfish's analysis of a finished
game is saved next to it as `games/analysis/<id>.json`: the engine and depth,
and the evaluation and best move of every position. The accuracy is worked
out from it whenever it's needed, and a game whose moves no longer match its
analysis is analyzed again.

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
`gpt`, `gemini`, `grok`, `aliceai` or `yandexgpt` (or
`WhiteProvider`/`BlackProvider` tags saying `anthropic`, `openai`, `google`,
`xai` or `yandex`); their comments become the moves' reasoning. A game
without a result is imported paused, ready to resume from its last position
with the clocks it had, unless that position already ends the game.

## Running on a server

`deploy.sh` puts Botwinnik on a Linux server, such as a DigitalOcean droplet,
where it runs with Docker behind [Caddy](https://caddyserver.com), which serves
it over HTTPS with a certificate from Let's Encrypt and asks for a login, since
anyone who can open the page can start games on your API keys. The games are
kept in a Docker volume, so restarts, rebuilds and updates don't lose them.

1. **Create a droplet** with Ubuntu, and with your SSH key, so that
   `ssh root@<droplet IP>` logs in. The smallest size with 1 GB of memory is
   enough, since the models do the thinking on their providers' servers.
2. **Deploy** from this folder, with the API keys in `config.ini` as under
   Setup:

   ```bash
   ./deploy.sh root@<droplet IP>
   ```

   The first time, it installs Docker on the droplet and asks for the
   password the page will ask for (the user is `admin`). Then it copies the
   latest commit and `config.ini` to `/opt/botwinnik` on the droplet, builds
   and starts the app there, and waits for `https://<droplet IP>/` to answer.
   Let's Encrypt certifies IP addresses too, for six days at a time, and Caddy
   renews the certificate by itself. The app starts again by itself when the
   droplet reboots.

Run `./deploy.sh root@<droplet IP>` again to deploy a newer commit or a
changed `config.ini` (changes you haven't committed stay behind); it keeps the
login. Restarting the app pauses the games running on it, as any restart does,
so if there are some, it asks first; resume them on their pages afterwards.
`--domain chess.example.com` serves the page at a domain instead, once an A
record points the domain at the droplet (at your DNS provider, or under
Networking › Domains in DigitalOcean), and later deploys keep it.
`--password` asks for a new password, and `--user` sets a new user name.

On the droplet, in `/opt/botwinnik`:

```bash
docker compose logs -f app                             # what the app prints
docker compose logs caddy                              # why HTTPS isn't answering, if it isn't
docker compose exec app npm run botwinnik -- ratings   # the command line, in the container
docker compose cp app:/data/games ./games-backup       # copy the saved games out
```

`config.ini`'s `host`, `port` and `games_dir` don't apply there: the image sets
them with `BOTWINNIK_HOST`, `BOTWINNIK_PORT` and `BOTWINNIK_GAMES_DIR` (which
override them anywhere). Each deploy replaces `config.ini` with yours, so change
it on your machine. To bring over the games saved on your machine:

```bash
COPYFILE_DISABLE=1 tar --no-xattrs -C games -c . |
  ssh root@<droplet IP> 'cd /opt/botwinnik && docker compose exec -T app tar -x -C /data/games && docker compose restart app'
```

**By hand**, without `deploy.sh`: on a server with Docker and its compose
plugin, get the code into a folder (cloning a private repository there needs a
deploy key), and in it:

```bash
cp config.example.ini config.ini && nano config.ini   # the API keys, as under Setup
docker run --rm -it caddy:2 caddy hash-password       # type the password to log in with
cp .env.example .env && nano .env                     # the domain or IP, a user name and that hash
docker compose up -d --build
```

The hash goes between the single quotes in `.env`, which keep its `$` signs
from being read as variables.

## Development

```bash
npm test            # node:test via tsx
npm run typecheck
```

`src/game` holds the engine (`game.ts`), PGN export and import, storage,
ratings, illegal-move counts and the game service; `src/players` the prompts and the OpenAI, Anthropic, Gemini,
xAI and Yandex clients;
`src/server` the admin API; `public/` the web page.

`src/analysis` holds Stockfish's analysis of finished games: the UCI engine
client, the queue that analyzes games in the background, and the accuracy
formulas.

`src/tournament` holds the round-robin schedule, the standings and the
tournament service, which runs tournaments on top of the game service.

### Dev container

The repository started as a TypeScript project for a dev container with
**Claude Code** and **Codex** preinstalled behind an egress firewall
(`.devcontainer/init-firewall.sh`, allowing GitHub, npm and the five model
APIs among others). Open the folder in VS Code and run **Dev Containers: Reopen in
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
`config.ini` the server waits, and starts once the file is saved. The
firewall resolves its allowed hosts when the container starts, and the
container runs the copy of `init-firewall.sh` built into its image: rebuild
the container after changing `ALLOWED_DOMAINS`.
