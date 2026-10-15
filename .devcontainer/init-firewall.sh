#!/bin/bash
# Restrict the dev container's outbound traffic to a small allowlist.
# Re-run on every container start — iptables/ipset state is not persisted.
#
# Threat model: this limits where the agents (and anything they run, e.g. npm
# postinstall scripts) can reach over the network, reducing exfiltration/blast
# radius. It is NOT a hard jail: anyone with sudo *inside* the container can
# flush these rules. For a strict boundary, also constrain the container at the
# host/Docker-network level.
set -euo pipefail
IFS=$'\n\t'

echo "[firewall] Resetting rules..."
iptables -F
iptables -X
iptables -t nat -F 2>/dev/null || true
iptables -t nat -X 2>/dev/null || true
iptables -t mangle -F 2>/dev/null || true
iptables -t mangle -X 2>/dev/null || true
ipset destroy allowed-domains 2>/dev/null || true

# --- Lock IPv6 down entirely (we only allowlist IPv4 below) ------------------
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -F 2>/dev/null || true
  ip6tables -P INPUT DROP   2>/dev/null || true
  ip6tables -P FORWARD DROP 2>/dev/null || true
  ip6tables -P OUTPUT DROP  2>/dev/null || true
  ip6tables -A INPUT  -i lo -j ACCEPT 2>/dev/null || true
  ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
fi

# --- Baseline allows (added before switching to default-DROP) ---------------
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A INPUT  -p udp --sport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A INPUT  -p tcp --sport 53 -j ACCEPT
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -p tcp --dport 22 -j ACCEPT
iptables -A INPUT  -p tcp --sport 22 -m state --state ESTABLISHED -j ACCEPT

ipset create allowed-domains hash:net

# --- GitHub IP ranges -------------------------------------------------------
echo "[firewall] Fetching GitHub IP ranges..."
gh_ranges="$(curl -fsSL --max-time 20 https://api.github.com/meta || true)"
if [ -n "$gh_ranges" ] && echo "$gh_ranges" | jq -e '.web and .api and .git' >/dev/null 2>&1; then
    github_cidrs="$(echo "$gh_ranges" | jq -r '(.web + .api + .git + (.hooks // []))[]?')"
    while read -r cidr; do
        [[ "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || continue
        ipset add allowed-domains "$cidr" 2>/dev/null || true
    done <<< "$(echo "$github_cidrs" | aggregate -q 2>/dev/null || echo "$github_cidrs")"
    echo "[firewall] Added GitHub IPv4 ranges."
else
    echo "[firewall] WARNING: could not fetch GitHub ranges; GitHub over HTTPS may fail."
fi

# --- Allowlisted domains (resolved to A records) ----------------------------
# Add project-specific hosts here as needed.
ALLOWED_DOMAINS=(
  # Package registries
  registry.npmjs.org
  pypi.org
  files.pythonhosted.org

  # Anthropic / Claude Code
  api.anthropic.com
  console.anthropic.com
  statsig.anthropic.com
  claude.ai
  # OpenAI / Codex
  api.openai.com
  auth.openai.com
  platform.openai.com
  chatgpt.com
  # Gemini, Grok and Yandex players (best-effort; Google's IPs rotate)
  generativelanguage.googleapis.com
  api.x.ai
  llm.api.cloud.yandex.net
  # VS Code server + marketplace (best-effort; CDN IPs may rotate)
  update.code.visualstudio.com
  marketplace.visualstudio.com
)

for domain in "${ALLOWED_DOMAINS[@]}"; do
    ips="$(dig +short A "$domain" 2>/dev/null || true)"
    if [ -z "$ips" ]; then
        echo "[firewall] WARNING: could not resolve $domain"
        continue
    fi
    while read -r ip; do
        [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || continue
        ipset add allowed-domains "$ip" 2>/dev/null || true
    done <<< "$ips"
    echo "[firewall] Allowed $domain"
done

# --- Allow the local Docker network (sibling services + docker DNS) ---------
host_net="$(ip -o -f inet addr show eth0 2>/dev/null | awk '{print $4}' | head -n1 || true)"
if [ -n "${host_net:-}" ]; then
    subnet="$(echo "$host_net" | sed -E 's#\.[0-9]+/#.0/#')"
    iptables -A OUTPUT -d "$subnet" -j ACCEPT 2>/dev/null || true
    iptables -A INPUT  -s "$subnet" -j ACCEPT 2>/dev/null || true
    echo "[firewall] Allowed local subnet $subnet"
fi

# --- Established connections + the allowlist, then default-DROP --------------
iptables -A INPUT  -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT

iptables -P INPUT   DROP
iptables -P FORWARD DROP
iptables -P OUTPUT  DROP

echo "[firewall] Rules applied."

# --- Sanity checks ----------------------------------------------------------
if curl -fsS --max-time 5 https://api.github.com/zen >/dev/null 2>&1; then
    echo "[firewall] OK: api.github.com reachable."
else
    echo "[firewall] WARNING: api.github.com unreachable — check connectivity."
fi
if curl -fsS --max-time 5 https://example.com >/dev/null 2>&1; then
    echo "[firewall] WARNING: example.com reachable — egress is NOT restricted!"
else
    echo "[firewall] OK: non-allowlisted egress (example.com) blocked."
fi
