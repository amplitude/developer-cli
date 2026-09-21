# Skill Materialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in `--save` delivery that materializes a fetched skill into an immutable temporary file and returns a compact instruction, without changing existing callers.

**Architecture:** Add a focused materializer that owns validation, canonicalization, hashing, collision resolution, and atomic directory publication. Keep registry transport and default output unchanged; make `skills get --save` opt into materialization and its reader-aware handoff output.

**Tech Stack:** TypeScript, Node.js standard library, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-09-18-skill-materialization.md`

## Global Constraints

- Do not use TypeScript type assertions or coercions.
- Return public CLI failures as `CliError` values with actionable messages.
- Do not edit generated artifacts.
- Use test-driven development and preserve the compact/nondecorated piped output contract.
- Without `--save`, preserve the current raw Markdown and `data.document` JSON contracts byte-for-byte.
- Treat `--save=false` as an explicit opt-out.
- Never overwrite a published skill artifact; reuse an exact match or extend the hash prefix for a conflicting path.
- Do not create a commit unless the user explicitly asks for one.

---

### Task 1: Immutable skill materializer

**Files:**
- Create: `src/skill-materializer.ts`
- Create: `src/skill-materializer.test.ts`

**Interfaces:**
- Consumes: a requested skill name, fetched Markdown string, and optional `{ rootDirectory, now }` dependencies.
- Produces: `materializeSkill(name, document, deps): MaterializedSkill`, where `MaterializedSkill` contains `name`, `path`, `sha256`, `bytes`, `lines`, and `instruction`.

- [ ] **Step 1: Write failing tests for canonical materialization**

  Cover the literal 12-character-prefix directory shape, canonical bytes, full
  SHA-256 metadata, byte/line counts, file permissions, instruction string, and
  absence of staging directories after success using a temporary test root and
  fixed clock.

- [ ] **Step 2: Run the focused test and verify the expected missing-module failure**

  Run: `pnpm vitest run src/skill-materializer.test.ts`

- [ ] **Step 3: Implement minimal validation and materialization**

  Use `node:crypto`, `node:fs`, `node:os`, and `node:path`. Validate the name,
  frontmatter name, and EOF sentinel with a Zod string schema. Canonicalize CRLF
  to LF plus one trailing newline, create private parent directories, write
  `SKILL.md` completely inside a uniquely named private sibling staging
  directory, then atomically rename the staging directory to the final version
  directory. Map filesystem failures to actionable `CliError` values and clean
  the staging directory on every unsuccessful publication.

- [ ] **Step 4: Run the focused test and verify it passes**

  Run: `pnpm vitest run src/skill-materializer.test.ts`

- [ ] **Step 5: Add failing validation tests, then implement actionable failures**

  Cover invalid requested names, mismatched frontmatter names, missing
  sentinels, and mismatched sentinels. Each failure must be an `upstream_error`
  or `usage_error` `CliError` and must leave no final skill file.

- [ ] **Step 6: Add failing collision tests**

  Prepublish an exact canonical document at the fixed timestamp and 12-character
  prefix, then assert a second materialization returns that path without
  changing the existing file metadata. Prepublish different bytes at the same
  candidate path, then assert materialization leaves that artifact untouched
  and publishes under the same timestamp with a 16-character prefix. Also
  assert no staging directories remain after either outcome.

- [ ] **Step 7: Implement deterministic collision resolution**

  Before publication, compare an existing candidate's exact bytes with the
  canonical document and reuse an exact match. For different bytes, try digest
  prefix lengths `12, 16, 20, ..., 64`. During a publication race, inspect the
  candidate after a failed directory rename: reuse it if the bytes match or
  continue to the next prefix if they differ. If the 64-character candidate is
  also occupied by different bytes, return an actionable `CliError` without
  modifying any existing artifact.

- [ ] **Step 8: Run the focused materializer tests and verify they pass**

  Run: `pnpm vitest run src/skill-materializer.test.ts`

### Task 2: Command and help contract

**Files:**
- Modify: `src/args.ts`
- Modify: `src/args.test.ts`
- Modify: `src/skills-commands.ts`
- Modify: `src/skills-commands.test.ts`
- Modify: `src/catalog.ts`
- Modify: `src/catalog.test.ts`
- Modify: `src/help.ts`
- Modify: `src/help.test.ts`

**Interfaces:**
- Consumes: `materializeSkill` from Task 1.
- Produces: the existing raw/JSON document output without `--save`; one-line text output with `--save`; and `{ data: MaterializedSkill }` with `--save --json`.

- [ ] **Step 1: Write failing parsing and flag-validation tests for `--save`**

  Add `save` as an optional boolean global option that is accepted only by
  `skills get`. Assert that bare `--save` and `--save=true` opt in,
  `--save=false` opts out, and other commands reject it.

- [ ] **Step 2: Write failing command tests for the opt-in output matrix**

  Preserve the existing assertions for raw Markdown and
  `{ data: { name, document } }` without `--save`. Add assertions that
  `--save` emits only the materializer instruction at both a TTY and through a
  pipe, invokes the materializer exactly once, and that `--save --json` emits
  the same materialization fields without `document`.

- [ ] **Step 3: Run command, argument, catalog, and help tests and verify contract failures**

  Run: `pnpm vitest run src/args.test.ts src/skills-commands.test.ts src/catalog.test.ts src/help.test.ts`

- [ ] **Step 4: Wire opt-in materialization into `runSkillsGet`**

  Add `save` to the parseable global options and the `skills get` catalog flag
  set. Inject the materializer through command dependencies for focused tests.
  Always fetch once; without `--save`, retain the existing output branches.
  With `--save`, materialize once, emit the instruction plus one newline, and
  use the existing JSON formatter when `--json` is also enabled.

- [ ] **Step 5: Update public catalog and help copy**

  Preserve the description of the default raw and `data.document` contracts.
  Explain that `--save` stores a complete skill and prints the instruction
  needed to use it, and that combining it with `--json` returns structured
  materialization metadata.

- [ ] **Step 6: Run focused tests and verify they pass**

  Run: `pnpm vitest run src/skill-materializer.test.ts src/args.test.ts src/skills-commands.test.ts src/catalog.test.ts src/help.test.ts`

### Task 3: Full verification

**Files:**
- Verify all modified and created files.

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: evidence that the public CLI remains type-safe and its full test suite passes.

- [ ] **Step 1: Run the TypeScript check**

  Run: `pnpm test:typescript`

- [ ] **Step 2: Run the complete package test suite**

  Run: `pnpm test`

- [ ] **Step 3: Run the package build**

  Run: `pnpm build`

- [ ] **Step 4: Review the diff against the design**

  Confirm the final output is minimal, the file is immutable and complete, no
  generated files changed, `--save` always fetches before materializing, and
  omitting `--save` retains every existing output and filesystem behavior.
  Confirm exact collisions reuse without rewriting, different-byte collisions
  extend the digest prefix, and no code path overwrites a published artifact.
