# botwinnik

A near-empty **TypeScript** project in a dev container with **Claude Code**
and **Codex** preinstalled behind an egress firewall. The container brings the
toolchain; the project is yours to fill in.

## Getting started

1. Open this folder in VS Code and run **Dev Containers: Reopen in Container**
   (or `devcontainer up --workspace-folder .`).
2. First build installs the toolchain and both agents; then authenticate
   (persists across rebuilds):
   ```bash
   claude          # sign in (subscription or API key)
   codex login     # OpenAI sign-in (ChatGPT account or API key)
   ```
3. Install dependencies with `npm install`, then start writing code (e.g. in `src/`).

## The firewall

`.devcontainer/init-firewall.sh` runs on every start and drops outbound traffic
except an allowlist (DNS, loopback, the local Docker network, GitHub, npm/PyPI +
this stack's registry, Anthropic, OpenAI, VS Code marketplace). Add hosts by
editing `ALLOWED_DOMAINS` there. It is not a hard jail — sudo in the container
can flush it.

Prefer API keys over interactive login? Export `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY`, or add them to `containerEnv` in `devcontainer.json`.
