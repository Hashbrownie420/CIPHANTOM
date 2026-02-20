FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends sqlite3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY owner-app/api ./owner-app/api
COPY owner-app/web ./owner-app/web
COPY owner-app/package.json ./owner-app/package.json

EXPOSE 8787

CMD ["node", "owner-app/api/server.mjs"]
