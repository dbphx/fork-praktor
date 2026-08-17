#!/bin/sh
set -eu

repo="${1:-.}"
out="${2:-/workspace/agent/notes/codebase-map.md}"

cd "$repo"
mkdir -p "$(dirname "$out")"

{
  printf '# Codebase Map\n\n'
  printf 'Generated: %s\n\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  printf '## Git\n\n'
  printf 'Root: `%s`\n\n' "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  printf 'HEAD: `%s`\n\n' "$(git rev-parse --short HEAD 2>/dev/null || printf unknown)"
  printf 'Branch: `%s`\n\n' "$(git branch --show-current 2>/dev/null || printf unknown)"

  printf '## Top-Level Files\n\n'
  find . -maxdepth 2 -type f \
    ! -path '*/.git/*' \
    ! -path '*/node_modules/*' \
    ! -path '*/vendor/*' \
    ! -path '*/dist/*' \
    ! -path '*/build/*' \
    | sed 's#^\./##' | sort | head -n 200

  printf '\n\n## Manifests And Build Files\n\n'
  find . -type f \( \
    -name 'go.mod' -o -name 'go.work' -o -name 'package.json' -o -name 'pnpm-lock.yaml' -o -name 'yarn.lock' -o -name 'package-lock.json' -o \
    -name 'pom.xml' -o -name 'build.gradle' -o -name 'settings.gradle' -o -name 'requirements.txt' -o -name 'pyproject.toml' -o \
    -name 'Cargo.toml' -o -name 'composer.json' -o -name 'Gemfile' -o -name 'Dockerfile' -o -name 'docker-compose.yml' -o \
    -name 'Makefile' -o -name '*.csproj' -o -name '*.sln' \
  \) ! -path '*/.git/*' ! -path '*/node_modules/*' | sed 's#^\./##' | sort | head -n 300

  printf '\n\n## Important Directories\n\n'
  find . -maxdepth 3 -type d \
    ! -path '*/.git*' \
    ! -path '*/node_modules*' \
    ! -path '*/vendor*' \
    ! -path '*/dist*' \
    ! -path '*/build*' \
    | sed 's#^\./##' | sort | head -n 300

  printf '\n\n## Entrypoint Hints\n\n'
  if command -v rg >/dev/null 2>&1; then
    rg -n --glob '!node_modules' --glob '!vendor' --glob '!dist' --glob '!build' \
      'func main\(|public static void main|if __name__ == .__main__.|app\.listen|createServer\(|SpringApplication\.run|FastAPI\(|Flask\(|gin\.Default|http\.HandleFunc|router\.(GET|POST|PUT|DELETE)|express\(|NestFactory\.create' \
      . | head -n 200 || true
  else
    printf 'rg not found\n'
  fi

  printf '\n\n## Route And Handler Hints\n\n'
  if command -v rg >/dev/null 2>&1; then
    rg -n --glob '!node_modules' --glob '!vendor' --glob '!dist' --glob '!build' \
      '(@(Get|Post|Put|Delete|Patch|RequestMapping)|router\.(get|post|put|delete|patch)|\.(GET|POST|PUT|DELETE|PATCH)\(|HandleFunc\(|http\.Handle|route\(|Controller\(|Path\(|fastapi|APIRouter)' \
      . | head -n 250 || true
  fi

  printf '\n\n## Data And Migration Hints\n\n'
  find . -type f \( \
    -path '*/migrations/*' -o -path '*/migration/*' -o -path '*/schema/*' -o -path '*/models/*' -o \
    -name '*migration*' -o -name '*schema*' -o -name '*.sql' \
  \) ! -path '*/.git/*' ! -path '*/node_modules/*' | sed 's#^\./##' | sort | head -n 250

  printf '\n\n## Test Hints\n\n'
  find . -type f \( \
    -name '*_test.go' -o -name '*.test.*' -o -name '*.spec.*' -o -name 'test_*.py' -o -path '*/tests/*' -o -path '*/__tests__/*' \
  \) ! -path '*/.git/*' ! -path '*/node_modules/*' | sed 's#^\./##' | sort | head -n 250
} > "$out"

printf '%s\n' "$out"
