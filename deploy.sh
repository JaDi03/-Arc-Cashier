#!/bin/bash
set -e

# deploy.sh
# Pulls latest changes, rebuilds the Tessera backend image, and restarts the container.
# Usage: ./deploy.sh

CONTAINER_NAME="tessera-backend"
IMAGE_NAME="tessera-backend"
DATA_DIR="$(pwd)/data"

BRANCH=${1:-main}

echo "🔄 Pulling latest version from GitHub..."
git fetch origin
git reset --hard "origin/$BRANCH"

echo "📦 Building Docker image (no cache)..."
docker build --no-cache -t "$IMAGE_NAME" .

echo "🛑 Stopping old container (if running)..."
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

echo "📁 Ensuring data directory exists on host..."
mkdir -p "$DATA_DIR"
# Migrate legacy JSON files from root to data/ (only needed once)
[ -f "$(pwd)/sessions.json" ] && [ ! -f "$DATA_DIR/sessions.json" ] && cp "$(pwd)/sessions.json" "$DATA_DIR/sessions.json" && echo "  Migrated sessions.json" || true
[ -f "$(pwd)/creators.json" ] && [ ! -f "$DATA_DIR/creators.json" ] && cp "$(pwd)/creators.json" "$DATA_DIR/creators.json" && echo "  Migrated creators.json" || true

echo "🚀 Starting new container..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p 7878:7878 \
  --env-file .env \
  -v "$DATA_DIR:/app/data" \
  "$IMAGE_NAME"

echo "✅ Tessera backend deployed successfully!"
echo "   Container: $CONTAINER_NAME"
echo "   Data volume: $DATA_DIR → /app/data"
