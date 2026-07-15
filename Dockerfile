# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
RUN npm run build:ui
RUN cp -r src/ui dist/ui

# Stage 2: Production
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
RUN npm install --omit=dev
# Create persistent data directory (mounted as a volume to survive rebuilds)
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 7878
CMD ["npm", "start"]
