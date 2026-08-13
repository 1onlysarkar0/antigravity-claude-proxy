# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install native build tools required to compile better-sqlite3 from source
RUN apk add --no-cache python3 make g++

# Copy package metadata and config needed for prepare script
COPY package*.json tailwind.config.js ./

# Copy public folder to allow Tailwind CSS prepare script to run during npm ci
COPY public ./public

# Install dependencies (will run install scripts for better-sqlite3 and prepare script for Tailwind)
RUN npm ci

# Copy remaining application source code
COPY . .

# Ensure CSS is built
RUN npm run build:css

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Set environment defaults for cloud deployment
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    NODE_OPTIONS="--max-old-space-size=512"

# Copy built application and production dependencies from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/public ./public

# Create data directory for volume persistence
RUN mkdir -p /app/data

# Expose server port
EXPOSE 8080

# Volume configuration for persistent OAuth data & config
VOLUME ["/app/data"]

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

# Start the proxy server
CMD ["node", "src/index.js"]
