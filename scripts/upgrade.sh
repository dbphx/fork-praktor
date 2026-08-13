#!/bin/sh
set -e

git pull
docker compose --profile build build agent-base
docker compose --profile build build agent
docker compose up -d --build
docker system prune -f
