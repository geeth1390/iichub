# ProtoHub — production image
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install exact dependency versions from the lockfile (no dev tools).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY worker ./worker
COPY scripts ./scripts
COPY migrations ./migrations
COPY seeds ./seeds
COPY public ./public

# Never run as root inside the container.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# Apply database migrations, then start the API, screens and worker.
CMD ["sh", "-c", "node scripts/migrate.js && exec node server.js"]
