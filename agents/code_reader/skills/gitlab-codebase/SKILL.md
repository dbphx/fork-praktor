---
name: gitlab-codebase
description: Read, clone, inspect, and explain GitLab-hosted codebases using GITLAB_DOMAIN and GITLAB_TOKEN from the environment. Use when a user asks to inspect a GitLab repo, trace implementation, find files/functions/routes/jobs/config, review code, compare branches, summarize a repository, or answer codebase questions grounded in source.
---

# GitLab Codebase Skill

Use this skill for GitLab source-code reading and codebase analysis.

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
- key files and functions
- observed behavior
- inference and uncertainty

If the repository cannot be cloned:

- report the exact failure class without exposing token
- suggest checking `GITLAB_DOMAIN`, token scope, project path, or branch/ref

## Safety

Do not push, delete, tag, force-reset, or create merge requests unless the user explicitly asks.
Do not modify cloned code unless the user asks for edits.
Do not store tokens in files, notes, remotes, logs, or final answers.
