# Bugbot review guide — @amplitude/developer-cli

This repo is the published `amp` CLI: a thin, generated client over the
Amplitude Developer API. It is a **public distribution**, so review for clarity
and safety, not just correctness. Prioritize the areas below.

## Public hygiene

- This source is public and read by external users. Flag anything that leaks
  internal context: private repo names or paths, internal infrastructure
  hostnames, internal issue-tracker IDs, internal-only tooling, or employee
  names — in code, comments, docs, or commit-touched fixtures.
- README/docs/help must make sense to someone who only has the published
  package (no upstream/monorepo context).

## Credential & token safety

- Credential files must be written with `0600` permissions. Flag any write that
  loosens this.
- Never log, print, or echo tokens, PATs, or `Authorization` headers (including
  in error messages or debug output).
- Don't weaken the documented credential precedence
  (`--token` > `AMP_TOKEN` > `--profile` > `AMP_PROFILE` > active profile).

## Destructive actions

- DELETE / destructive commands must confirm (interactive `y/N`) or require
  `--yes`. Flag any destructive path that skips the gate.
- `--dry-run` must never perform a write — flag a dry-run path that mutates.

## Generated & bundled artifacts

- `src/generated/**` and `openapi/bundled/**` are generated. Flag hand-edits;
  changes belong upstream and are regenerated.

## Human/agent output contract

- Non-interactive / piped output must stay compact, lossless, and
  machine-parseable. Flag ANSI colors, spinners, prompts, banners, or truncation
  leaking onto the non-TTY path.
- `--json` output must remain valid, parseable JSON.

## Input validation & portability

- Validate untrusted input (API responses, saved credentials, user-supplied
  `--body-json`) with schemas, not ad-hoc coercion.
- This package ships standalone: flag imports from any server/monorepo source or
  new heavyweight dependencies.
