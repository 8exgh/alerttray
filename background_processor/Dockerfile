# ---------- 1) build stage ----------
FROM node:20-alpine AS builder
WORKDIR /app

# install deps (including devDependencies for build)
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

# copy source
COPY src ./src

# copy env file if exists
COPY .env.local* ./

# build TypeScript
RUN npm run build

# ---------- 2) runtime stage ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy built application from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/.env.local* ./

# Create data directory for SQLite databases
RUN mkdir -p /app/data

# Set environment variables
ENV DATABASE_PATH=/app/data \
    NODE_ENV=production

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the background processor
CMD ["node", "dist/index.js"]