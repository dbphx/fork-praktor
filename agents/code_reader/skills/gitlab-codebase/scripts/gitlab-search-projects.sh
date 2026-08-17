#!/bin/sh
set -eu

query="${1:-}"
if [ -z "$query" ]; then
  printf 'usage: %s <search-query>\n' "$0" >&2
  exit 2
fi

if [ -z "${GITLAB_DOMAIN:-}" ]; then
  printf 'GITLAB_DOMAIN is not set\n' >&2
  exit 2
fi

if [ -z "${GITLAB_TOKEN:-}" ]; then
  printf 'GITLAB_TOKEN is not set\n' >&2
  exit 2
fi

domain="$GITLAB_DOMAIN"
case "$domain" in
  http://*|https://*) base="$domain" ;;
  *) base="https://$domain" ;;
esac
base="${base%/}"

encoded_query=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$query")
url="$base/api/v4/projects?membership=true&simple=true&per_page=20&search=$encoded_query"

json=$(curl -fsS --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "$url")

if command -v jq >/dev/null 2>&1; then
  printf '%s\n' "$json" | jq -r '.[] | "\(.path_with_namespace)\tdefault_branch=\(.default_branch // "unknown")\tvisibility=\(.visibility)\t\(.web_url)"'
else
  printf '%s\n' "$json"
fi
