# developer-cli CLI — Agent Instructions

This package is the `amp` CLI: the human- and agent-facing surface over the
Amplitude Developer API. It is published as a standalone package, so treat
everything here as public and hold it to a high bar.

The Amplitude Developer API OpenAPI spec is the contract; this CLI is a thin,
generated client over it. The CLI manifest and bundled spec under
`src/generated/` and `openapi/bundled/` are generated artifacts — never edit
them by hand.

## Tenets

These break ties when a decision is ambiguous. They are deliberately aligned
with the Developer API golden standards.

### 1. Obvious by default

The best surface needs no explanation. A user should be able to guess the next
command and never get surprised by what one does.

**What good looks like**

- Discoverable help: `amp help` → surfaces → `amp <surface>` → `amp <cmd> --help`.
- Consistent verbs across surfaces (`list`, `get`, `create`, `update`, `archive`).
- Safe defaults: destructive actions confirm (interactive `y/N`, or `--yes` in
  scripts); reads are free.
- Errors are actionable — they say what to do next, not just what failed.
- Conventions users already expect work: `--version`/`-v`, `--help`/`-h`.

**Anti-patterns**

- A flag whose effect you can't infer from its name (e.g. a `--dry-run` that
  still performs the write).
- Requiring the README to use a command safely.

### 2. Code is marketing

This source is public. Readers judge Amplitude by it, so optimize for clarity,
not just function.

**What good looks like**

- Small, single-purpose modules with names that read like a table of contents.
- Public-facing code and docs use familiar, widely understood names instead of
  coined internal jargon.
- Generated code is quarantined under `src/generated/` and never hand-edited.
- Validate untrusted input (API responses, saved credentials, user JSON) with
  schemas, not ad-hoc coercion.

**Anti-patterns**

- A grab-bag module that mixes parsing, auth, transport, and routing.
- TODOs, dead code, or aspirational claims in shipped files or the README.

### 3. Test the seams that matter

Cover pure logic exhaustively and protect the safety-critical paths. Skip tests
whose only purpose is coverage of trivial glue.

**What good looks like**

- Pure functions (arg parsing, request building, output formatting) are unit
  tested.
- Security-relevant behavior has explicit tests: token precedence, the
  destructive-action gate, and credential file permissions (`0600`).
- Test files mirror their source module.

**Anti-patterns**

- Mocking away the exact branch you mean to verify.
- No coverage on the code that can delete data or leak a secret.

### 4. Two readers: humans and agents

Every command is read by a person at a terminal and by an agent over a pipe.
Optimize each for what it needs: humans want maximal visibility and
readability; agents want minimal characters.

**What good looks like**

- Interactive (TTY) output is formatted for scanning: aligned tables, short
  summaries, collapsed redundant columns, and color used only as emphasis.
- Piped / non-interactive output is compact and lossless — the full data with
  no decoration, no indentation, and nothing the caller must strip.
- The two formats carry the same information; only the presentation differs.
- `--json` always yields machine-parseable output; piping never changes the
  meaning of a command, only its verbosity.

**Anti-patterns**

- Spending agent tokens on pretty-printing, banners, color codes, or
  repeated values that carry no extra information.
- Truncating or dropping data on the piped path to save space (terseness must
  never cost correctness).
- Human-only adornments (spinners, prompts, ANSI codes) leaking into
  non-interactive output.
