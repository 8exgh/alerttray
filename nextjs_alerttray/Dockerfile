# ---------- 1) build stage ----------
FROM node:20-alpine AS builder
WORKDIR /app

# install deps
COPY package*.json ./
RUN npm install

# copy source
COPY . .

# copy env file if exists
COPY .env.local* ./

# build
RUN npm run build

# ---------- 2) runtime stage ----------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# only bring over what the app needs at runtime
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/.env.local* ./
COPY --from=builder /app/node_modules ./node_modules

# Copy additional required files for AlertTray
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/app ./app
COPY --from=builder /app/components ./components
COPY --from=builder /app/types ./types

# Create data directory for SQLite databases
RUN mkdir -p /app/data && chmod 755 /app/data

# Set environment variables
ENV DATABASE_PATH=/app/data \
    NEXT_TELEMETRY_DISABLED=1

EXPOSE 3000
CMD ["npm", "start"]