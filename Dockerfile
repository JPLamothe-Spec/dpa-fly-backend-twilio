# Dockerfile
FROM node:20-alpine

# Run in production mode
ENV NODE_ENV=production
WORKDIR /app

# Install ffmpeg for transcoding (required by stream-handler)
RUN apk add --no-cache ffmpeg

# Install deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy app source
COPY . .

# Run as non-root
RUN chown -R node:node /app
USER node

EXPOSE 3000
CMD ["npm", "start"]
