#!/bin/bash

set -e

# Configuration
REGISTRY="moonplkr"
IMAGE_NAME="webdb-gateway"
TAG="${1:-latest}"
PLATFORM="linux/amd64,linux/arm64"

echo "🚀 Building and pushing ${REGISTRY}/${IMAGE_NAME}:${TAG}"

# Build and push using buildx
docker buildx build \
  --platform ${PLATFORM} \
  --tag ${REGISTRY}/${IMAGE_NAME}:${TAG} \
  --push \
  --no-cache \
  .

echo "✅ Successfully built and pushed ${REGISTRY}/${IMAGE_NAME}:${TAG}"
echo "📦 Image available at: docker.io/${REGISTRY}/${IMAGE_NAME}:${TAG}"