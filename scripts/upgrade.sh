#!/bin/sh
set -e

git pull
docker compose --profile build build fork-agent-base
docker compose --profile build build fork-agent
docker compose up -d --build fork-praktor
docker system prune -f
