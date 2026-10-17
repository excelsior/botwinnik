#!/usr/bin/env bash
# Deploys Botwinnik to a server, such as a DigitalOcean droplet, where it runs
# with Docker behind HTTPS and a login (see "Running on a server" in README.md):
#
#   ./deploy.sh root@<droplet IP>
#
# It installs Docker on the server if it's missing, copies this checkout's
# latest commit and config.ini to /opt/botwinnik there, and builds and starts
# the app. The first deploy asks for the password the page will ask for.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [--domain NAME] [--user NAME] [--password] root@<server>

Copies this checkout's latest commit and its config.ini to /opt/botwinnik on
the server, and builds and starts Botwinnik there with Docker (installed first
if the server doesn't have it), behind HTTPS and a login. The first deploy asks
for the password to log in with; later ones keep it.

  --domain NAME  Serve the page at this domain, which must point at the server.
                 Without it, the page is at the domain an earlier deploy set,
                 or else at the server's address as ssh has it (an IP address
                 is fine: Let's Encrypt certifies those too).
  --user NAME    The user name to log in with (admin unless set before).
  --password     Ask for a new password.
EOF
}

die() {
  echo "$*" >&2
  exit 1
}

domain='' user='' ask_password='' target=''
while [ $# -gt 0 ]; do
  case $1 in
    --domain | --user)
      [ $# -ge 2 ] || die "$1 needs a value. See ./deploy.sh --help."
      if [ "$1" = --domain ]; then domain=$2; else user=$2; fi
      shift 2
      ;;
    --domain=*) domain=${1#*=}; shift ;;
    --user=*) user=${1#*=}; shift ;;
    --password) ask_password=1; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "Unknown option $1. See ./deploy.sh --help." ;;
    *)
      [ -z "$target" ] || die "Give one server. See ./deploy.sh --help."
      target=$1
      shift
      ;;
  esac
done
[ -n "$target" ] || { usage >&2; exit 2; }

cd "$(dirname "$0")"
[ -f config.ini ] || die "There's no config.ini here: copy config.example.ini to config.ini and add at least one API key."
commit=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Deploying commit $commit: changes you haven't committed stay here."
fi

# One connection for the whole deploy, so that ssh asks for a passphrase or
# password (if it does) only once.
control=$(mktemp -d /tmp/botwinnik-deploy.XXXXXX)
ssh_options=(-o ControlMaster=auto -o "ControlPath=$control/%C" -o ControlPersist=300)
on_server() { ssh "${ssh_options[@]}" "$target" "$@"; }
cleanup() {
  ssh "${ssh_options[@]}" -O exit "$target" 2>/dev/null || true
  rm -rf "$control"
}
trap cleanup EXIT

# What an earlier deploy set up: the domain and the login, and the games running.
old_env=$(on_server '[ "$(id -u)" = 0 ] || { echo "Log in as root: ./deploy.sh root@<server>" >&2; exit 1; }
  cat /opt/botwinnik/.env 2>/dev/null || true')
env_value() {
  sed -n "s/^$1=//p" <<<"$old_env" | tail -n 1 | sed "s/^'\(.*\)'\$/\1/; s/^\"\(.*\)\"\$/\1/"
}
running=$(on_server 'cd /opt/botwinnik 2>/dev/null && docker compose exec -T app node -e "
  fetch(\"http://localhost:3000/api/games\")
    .then((res) => res.json())
    .then((games) => console.log(games.filter((g) => g.status === \"running\").length));
" 2>/dev/null || echo 0')
case $running in '' | *[!0-9]*) running=0 ;; esac
if [ "$running" -gt 0 ]; then
  echo "$running game(s) are running there. Restarting the app pauses them: resume them on their pages afterwards."
  if [ -t 0 ]; then
    answer=''
    read -r -p "Deploy now? [y/N] " answer
    case $answer in [yY]*) ;; *) exit 1 ;; esac
  fi
fi

domain=${domain:-$(env_value DOMAIN)}
domain=${domain:-$(ssh -G "$target" | awk '$1 == "hostname" { print $2; exit }')}
case $domain in
  *.*) ;;
  *) domain='' ;; # say, an ssh alias's name
esac
case $domain in
  '' | *[!A-Za-z0-9.-]*) die "Give the address to serve the page at with --domain: a domain pointing at the server, or the server's IPv4 address." ;;
esac
user=${user:-$(env_value LOGIN_USER)}
user=${user:-admin}
case $user in
  *[!A-Za-z0-9._@-]*) die "Keep the user name to letters, digits and . _ @ -" ;;
esac

hash=$(env_value LOGIN_PASSWORD_HASH)
password=''
if [ -z "$hash" ] || [ -n "$ask_password" ]; then
  [ -t 0 ] || die "Run this in a terminal: it needs to ask for the password to log in with."
  while :; do
    read -r -s -p "Password to log in to the page as $user: " password
    echo
    if [ -z "$password" ]; then
      echo "It can't be empty."
      continue
    fi
    read -r -s -p "Again: " again
    echo
    [ "$password" = "$again" ] && break
    echo "They don't match. Try again."
  done
fi

on_server bash -s <<'EOF'
set -euo pipefail
if ! command -v docker >/dev/null; then
  echo "Installing Docker (a minute or two)..."
  # A new droplet may still be setting itself up, and holding apt while it does.
  cloud-init status --wait >/dev/null 2>&1 || true
  for attempt in 1 2 3; do
    curl -fsSL https://get.docker.com | sh >/dev/null && break
    [ $attempt -lt 3 ] || exit 1
    echo "Trying again in 30 seconds..." >&2
    sleep 30
  done
fi
docker compose version >/dev/null 2>&1 || { echo "Docker on the server has no compose plugin." >&2; exit 1; }
EOF

if [ -n "$password" ]; then
  # Caddy keeps only the password's bcrypt hash, worked out on the server.
  hash=$(printf '%s\n' "$password" | on_server docker run --rm -i caddy:2 caddy hash-password)
fi

echo "Copying commit $commit and config.ini to /opt/botwinnik..."
git archive --format=tar HEAD | on_server '
  set -e
  mkdir -p /opt/botwinnik
  cd /opt/botwinnik
  find . -mindepth 1 -maxdepth 1 ! -name config.ini ! -name .env -exec rm -rf {} +
  tar -x --no-same-owner --no-same-permissions -f -
'
# Readable by the app, which runs as the node user (uid 1000) in its container.
on_server 'umask 077 && cat > /opt/botwinnik/config.ini && chown 1000:1000 /opt/botwinnik/config.ini' <config.ini
printf "# Written by deploy.sh, whose --domain, --user and --password change it.\nDOMAIN=%s\nLOGIN_USER=%s\nLOGIN_PASSWORD_HASH='%s'\n" \
  "$domain" "$user" "$hash" | on_server 'umask 077 && cat > /opt/botwinnik/.env'

echo "Building and starting Botwinnik (a few minutes the first time)..."
on_server bash -s <<'EOF'
set -euo pipefail
cd /opt/botwinnik
# Recreated, so that both containers read config.ini and the Caddyfile afresh.
if ! docker compose up -d --build --force-recreate --remove-orphans >/tmp/botwinnik-deploy.log 2>&1; then
  cat /tmp/botwinnik-deploy.log >&2
  exit 1
fi
docker image prune -f >/dev/null
for _ in $(seq 30); do
  docker compose exec -T app node -e '
    fetch("http://localhost:3000/").then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1));
  ' 2>/dev/null && exit 0
  sleep 2
done
echo "The app didn't start. The end of its log:" >&2
docker compose logs --tail 30 app >&2
exit 1
EOF

url="https://$domain/"
echo "Waiting for $url to answer with its certificate..."
for _ in $(seq 40); do
  # 401: Caddy is serving the page with a valid certificate, and asking for the login.
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)" = 401 ]; then
    echo "Botwinnik is running at $url. Log in as $user."
    exit 0
  fi
  sleep 3
done
echo "Botwinnik is running, but $url didn't answer with a valid certificate." >&2
echo "If its domain was just pointed at the server, give it time. Otherwise Caddy's log says why:" >&2
echo "  ssh $target 'cd /opt/botwinnik && docker compose logs caddy'" >&2
exit 1
