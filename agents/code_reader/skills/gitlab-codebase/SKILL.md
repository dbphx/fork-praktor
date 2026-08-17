---
name: gitlab-codebase
description: Read, clone, inspect, understand, map, and trace bugs in GitLab-hosted codebases using GITLAB_DOMAIN and GITLAB_TOKEN from the environment. Use when a user asks to inspect a GitLab repo, understand the whole codebase, trace a bug, find files/functions/routes/jobs/config, review code, compare branches, summarize architecture, or answer implementation questions grounded in source.
---

# GitLab Codebase Skill

Use this skill for GitLab source-code reading and codebase analysis.

For bug tracing, the goal is not only to find a keyword. Build a working map of the codebase first, then trace the concrete execution path that could produce the symptom.

## Environment

Expected env vars:

- `GITLAB_DOMAIN`: GitLab host or base URL, for example `gitlab.example.com` or `https://gitlab.example.com`.
- `GITLAB_TOKEN`: GitLab personal/project access token.
- `GITLAB_USERNAME`: optional username for HTTPS clone. Default to `oauth2` when absent.

Never print `GITLAB_TOKEN`. If the user asks to verify it, only say whether it is present.

## Repository Input

Accept any of these forms:

- full HTTPS URL: `https://gitlab.example.com/group/project.git`
- SSH-like path: `git@gitlab.example.com:group/project.git`
- namespace path: `group/project`
- namespace path plus branch/ref: `group/project@main`

Normalize the repository to an HTTPS clone URL using `GITLAB_DOMAIN`.

## Clone Pattern

Clone under `/workspace/agent/repos`. Prefer shallow clone first:

```sh
mkdir -p /workspace/agent/repos
git clone --depth 1 --branch "$REF" "https://${GITLAB_USERNAME:-oauth2}:${GITLAB_TOKEN}@${GITLAB_DOMAIN}/${PROJECT_PATH}.git" "/workspace/agent/repos/$SAFE_NAME"
```

If no ref is provided, omit `--branch "$REF"`.

If clone fails because the branch is missing, retry without `--branch`, then inspect refs:

```sh
git branch -a
git tag -l
```

Avoid leaving tokenized URLs in command output. Do not run commands that echo the clone URL.

After clone, scrub the remote URL:

```sh
git remote set-url origin "https://${GITLAB_DOMAIN}/${PROJECT_PATH}.git"
```

## Inspection Workflow

1. Confirm the repo path and current ref:
   ```sh
   git rev-parse --show-toplevel
   git rev-parse --short HEAD
   git status --short
   ```
2. Map the project:
   ```sh
   rg --files
   ```
3. Search before opening files:
   ```sh
   rg -n "keyword|route|function|class|config_key"
   ```
4. Read focused files with line numbers:
   ```sh
   nl -ba path/to/file | sed -n '1,220p'
   ```
5. Follow call chains and configuration references until the answer is grounded.
6. Cite paths and line numbers in the final answer when possible.

Prefer `rg` over `grep`, and prefer structured parsers or framework conventions over ad hoc assumptions.

## Whole-Codebase Map

Before tracing a bug or claiming broad understanding, create or refresh a map:

```sh
sh /workspace/agent/skills/gitlab-codebase/scripts/codebase-map.sh "$REPO_DIR" /workspace/agent/notes/codebase-map.md
```

Read `/workspace/agent/notes/codebase-map.md`, then inspect the files it points to. The map is only a starting index; do not treat it as complete proof.

Build this mental model:

- runtime entrypoints: binaries, servers, workers, scheduled jobs, CLIs
- framework shape: routes/controllers/handlers, middleware, dependency injection
- business layers: service/usecase/domain modules
- data layer: models, repositories, migrations, schema, caches
- integrations: HTTP clients, queues, storage, auth, feature flags
- configuration: env vars, YAML/TOML/JSON, deployment manifests
- tests: unit/integration/e2e tests around the suspected behavior

If the repo is a monorepo, identify the relevant service first, but still inspect shared libraries and deployment/config files that can affect the bug.

## Bug Trace Workflow

Use this workflow when the user provides a symptom, log line, stack trace, endpoint, job name, UI action, status code, or failing behavior.

1. Restate the symptom and known inputs:
   - repo, branch/ref, environment if known
   - endpoint/job/module/user action
   - observed error, status, panic, wrong output, or missing side effect
2. Map the codebase with `codebase-map.sh`.
3. Locate the likely entrypoint:
   - HTTP route/controller
   - CLI command
   - queue consumer/job
   - scheduled task
   - frontend event/API client
4. Trace downstream in order:
   - validation and request parsing
   - auth/permission/tenant checks
   - service/usecase logic
   - DB/cache/external calls
   - error wrapping and response mapping
5. Trace upstream when needed:
   - config/env defaults
   - dependency injection or module registration
   - migrations/schema assumptions
   - deployment manifests and feature flags
6. Check tests that should cover the path. If none exist, note the missing test explicitly.
7. Produce a bug hypothesis only after reading the relevant files. Mark it as confirmed only when the code path proves it.

Useful search patterns:

```sh
rg -n "exact_error|status_code|route_path|job_name|config_key|table_name|function_name" "$REPO_DIR"
rg -n "TODO|FIXME|panic|throw new|return err|errors\\.New|fmt\\.Errorf|logger\\.(error|warn)" "$REPO_DIR"
rg -n "process\\.env|os\\.Getenv|viper\\.|config\\.|env\\." "$REPO_DIR"
```

When tracing across languages, follow imports/calls manually with `rg` and direct file reads. Do not rely on a single filename match.

## Bug Trace Output

For bug-trace answers, use this shape:

```text
Trace summary
• Repo/ref inspected: ...
• Entry point: file:line
• Path: A -> B -> C

Likely cause
• ...

Evidence
• file:line - observed code fact
• file:line - observed code fact

Fix direction
• ...

Tests to add/run
• ...

Uncertainty
• ...
```

If the evidence is insufficient, say exactly which file, config, branch, log, or runtime input is missing.

## Review Mode

When the user asks for a review, lead with findings:

```text
Findings
• Severity: file:line - issue and impact.

Questions
• ...

Summary
• ...
```

Prioritize bugs, security risks, behavioral regressions, missing tests, deployment/config mistakes, and data-loss risks.

## Answer Rules

Be explicit about what was read:

- repo/path/ref inspected
- whether `/workspace/agent/notes/codebase-map.md` was generated/read for bug tracing
- key files and functions
- entrypoint and traced call path
- observed behavior
- inference and uncertainty

If the repository cannot be cloned:

- report the exact failure class without exposing token
- suggest checking `GITLAB_DOMAIN`, token scope, project path, or branch/ref

## Safety

Do not push, delete, tag, force-reset, or create merge requests unless the user explicitly asks.
Do not modify cloned code unless the user asks for edits.
Do not store tokens in files, notes, remotes, logs, or final answers.
