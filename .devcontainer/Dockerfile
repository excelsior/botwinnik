FROM node:22-bookworm

ARG TZ
ENV TZ="${TZ}"
ENV DEBIAN_FRONTEND=noninteractive

# --- System packages (core dev tools + everything init-firewall.sh needs) ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg2 \
      git git-lfs less man-db procps sudo unzip zip nano vim \
      jq fzf zsh \
      iptables ipset iproute2 dnsutils aggregate \
  && rm -rf /var/lib/apt/lists/*



# --- GitHub CLI (gh) --------------------------------------------------------
RUN mkdir -p -m 755 /etc/apt/keyrings \
  && wget -nv -O- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*



# --- Passwordless sudo for the dev user -------------------------------------
RUN echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node \
  && chmod 0440 /etc/sudoers.d/node

# --- Persisted dirs (named volumes inherit this node ownership) -------------
RUN mkdir -p /commandhistory /home/node/.claude /home/node/.codex /workspace \
  && chown -R node:node /commandhistory /home/node/.claude /home/node/.codex /workspace

# --- Firewall script --------------------------------------------------------
COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod +x /usr/local/bin/init-firewall.sh

# --- User-writable npm global prefix (so `claude update` works sans sudo) ---
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin
RUN mkdir -p /usr/local/share/npm-global && chown -R node:node /usr/local/share/npm-global

# --- Default shell: zsh -----------------------------------------------------
RUN chsh -s /usr/bin/zsh node
ENV SHELL=/usr/bin/zsh

USER node

# Persist shell history to the mounted volume + a minimal zsh setup.
RUN printf '%s\n' \
      'export HISTFILE=/commandhistory/.zsh_history' \
      'export HISTSIZE=100000' \
      'export SAVEHIST=100000' \
      'setopt INC_APPEND_HISTORY SHARE_HISTORY' \
      'export PATH=$PATH:/usr/local/share/npm-global/bin' \
      'autoload -Uz compinit && compinit -u' \
      'PROMPT="%F{cyan}%n@%m%f:%F{yellow}%~%f %# "' \
      '[ -f /usr/share/doc/fzf/examples/key-bindings.zsh ] && source /usr/share/doc/fzf/examples/key-bindings.zsh' \
      > /home/node/.zshrc \
  && printf '%s\n' 'export HISTFILE=/commandhistory/.bash_history' >> /home/node/.bashrc

# --- The agents (binaries: claude, codex) -----------------------------------
RUN npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /workspace
