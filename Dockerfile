FROM node:20-alpine

WORKDIR /app

# Install deps from lockfile for repeatable builds
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Env & port
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Start the correct entry file
CMD ["node", "server.js"]
