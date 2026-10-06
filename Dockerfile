FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data/codex /data/state && chown -R node:node /data
COPY watch.mjs ./
USER node
ENV CODEX_HOME=/data/codex STATE_DIR=/data/state
HEALTHCHECK --interval=5m --timeout=5s --start-period=2m \
  CMD node -e "const s=require('/data/state/state.json'); if(Date.now()-Date.parse(s.lastSuccessfulCheck)>600000)process.exit(1)"
CMD ["node", "watch.mjs"]
