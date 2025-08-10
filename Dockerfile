# ---- Base (Alpine + fast APK mirror + ffmpeg) ------------------------------
FROM node:20-alpine AS base

# Use a fast AU mirror for APK to speed up ffmpeg installs
# (Safe no-op after the first build due to Docker layer cache)
RUN sed -i 's/dl-cdn.alpinelinux.org/mirror.aarnet.edu.au/g' /etc/apk/repositories

# Install ffmpeg in its own cached layer (happens once unless base changes)
RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production
WORKDIR /app

# ---- Deps layer (cache on package-lock.json) -------------------------------
FROM base AS deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Runtime image ---------------------------------------------------------
FROM base AS runner
WORKDIR /app

# Copy node_modules from deps layer (fast, cached by lockfile)
COPY --from=deps /app/node_modules /app/node_modules

# Copy the rest of the app (this is the layer that changes most)
COPY . .

# Run as non-root
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["npm", "start"]
