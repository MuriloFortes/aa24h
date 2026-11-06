FROM node:20-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY web-client/package.json web-client/package-lock.json ./web-client/
RUN cd web-client && npm ci

COPY . .
RUN cd web-client && npm run build

# ── runtime ──
FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3003

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/agents ./agents
COPY --from=build /app/database ./database
COPY --from=build /app/lib ./lib
COPY --from=build /app/services ./services
COPY --from=build /app/src ./src
COPY --from=build /app/providers-photos ./providers-photos
COPY --from=build /app/server.js ./server.js
COPY --from=build /app/index.html ./index.html
COPY --from=build /app/web-client/dist ./web-client/dist

RUN mkdir -p /app/data /app/audio

EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3003/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
