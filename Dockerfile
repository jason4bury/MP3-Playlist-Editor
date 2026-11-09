# MP3 Playlist Editor v1.00. Build with: docker compose build
# (or docker build -t jason4bury/mp3-playlist-editor:1.00 .)
# Node.js is pinned to an exact version so every build is the same; bump it here on purpose.
ARG NODE_IMAGE=node:22.23.4-alpine
FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="MP3 Playlist Editor" \
      org.opencontainers.image.description="Turn a pasted tracklist into a numbered, tagged MP3 playlist, self-hosted in Docker" \
      org.opencontainers.image.version="1.00" \
      org.opencontainers.image.source="https://github.com/jason4bury/MP3-Playlist-Editor" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Jason Rhodes"

WORKDIR /app

# Production dependencies only, exactly as locked in package-lock.json
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js auth.js mp3-info.js version.js ./
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

# Playlists, attached audio, cover art and sign-in sessions live here
VOLUME ["/app/data"]
EXPOSE 3000

# Docker's health status (docker ps, Portainer) comes from GET /healthz. Uses Node itself, so
# the image doesn't need curl or wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
