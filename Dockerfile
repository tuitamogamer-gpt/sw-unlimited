FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run engine:setup && npm run build
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
USER node
CMD ["node", "server/index.cjs"]
