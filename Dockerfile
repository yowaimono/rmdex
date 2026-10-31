FROM node:22-alpine AS build
WORKDIR /build
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:relay

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787 RMDEX_STATE=/data/state.json RMDEX_WEB_ROOT=/app/web
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/dist ./web
COPY --from=build /build/dist-relay/index.js ./relay/index.js
COPY --from=build /build/server/skills/rmdex-employee/SKILL.md ./server/skills/rmdex-employee/SKILL.md
EXPOSE 8787
USER node
CMD ["node", "relay/index.js"]
