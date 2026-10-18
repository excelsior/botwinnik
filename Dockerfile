# Botwinnik's web page and API, for compose.yaml (see "Running on a server" in
# README.md). config.ini is mounted at /app/config.ini, and the games are kept
# in /data/games, a volume.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src src
COPY public public

# Whatever config.ini says, listen on every interface of the container (only
# the compose network reaches it) and keep the games on the volume.
ENV BOTWINNIK_HOST=0.0.0.0 BOTWINNIK_PORT=3000 BOTWINNIK_GAMES_DIR=/data/games
# Keeps npm's update notices out of "docker compose exec app npm run botwinnik".
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN mkdir -p /data/games && chown node:node /data/games
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/cli.ts", "serve"]
