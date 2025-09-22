#!/bin/bash

set -e

# Configuration
SERVER="ubuntu@moon.dev.golem.network"
PROJECT_DIR="/home/ubuntu/projects/webdb"
REGISTRY="moonplkr"
IMAGE_NAME="webdb-gateway"
TAG="${1:-latest}"

echo "🚀 Deploying ${IMAGE_NAME}:${TAG} to ${SERVER}"

# Commands to run on server
ssh ${SERVER} << EOF
  set -e

  echo "📂 Setting up project directory..."
  mkdir -p ${PROJECT_DIR}
  cd ${PROJECT_DIR}

  echo "🐳 Pulling latest image..."
  docker pull ${REGISTRY}/${IMAGE_NAME}:${TAG}

  echo "🔄 Stopping existing containers..."
  docker compose down || true

  echo "🚀 Starting services..."
  docker compose up -d

  echo "🔍 Checking health..."
  sleep 5
  docker compose ps

  echo "✅ Deployment complete!"
  echo "🌐 Service available at: http://moon.dev.golem.network:8810"
EOF

echo "✅ Deployment to ${SERVER} completed successfully!"