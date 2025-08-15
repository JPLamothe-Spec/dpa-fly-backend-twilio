FROM node:20-alpine

WORKDIR /app

# Copy manifest + lockfile if present
COPY package.json package-lock.json* ./

# Use lockfile when available; otherwise fall back safely
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# Copy the rest
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Ensure we start the right file
CMD ["node", "server.js"]
