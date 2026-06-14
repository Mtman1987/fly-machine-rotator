FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json tsconfig.json tsconfig.build.json ./
COPY assets ./assets
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV FLYCTL_INSTALL=/root/.fly
ENV PATH=/root/.fly/bin:$PATH
RUN apk add --no-cache bash ca-certificates curl git && curl -L https://fly.io/install.sh | sh
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/assets ./assets
COPY --from=build /app/dist ./dist
CMD ["node", "dist/index.js", "monitor"]
