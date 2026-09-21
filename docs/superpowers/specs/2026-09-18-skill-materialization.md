# Skill Materialization Design

## Goal

Make `amp skills get <name>` reliable for agents even when a skill is larger
than a shell tool's inline-output limit, while preserving the existing command
behavior during an opt-in evaluation period.

## Command contract

- Without `--save`, `amp skills get <name>` preserves its current behavior:
  raw Markdown goes to stdout, while `--json` returns the document in
  `data.document`.
- With `--save`, every invocation fetches the current skill, validates and
  canonicalizes it, and publishes or reuses an immutable artifact beneath the
  operating system temporary directory:
  `<tmp>/amp/skills/<name>/<UTC timestamp>-<SHA-256 prefix>/SKILL.md`.
- `--save` prints one instruction:
  `Read and follow the complete \`<name>\` skill at \`<path>\` for the current task.`
- `--save --json` returns structured materialization metadata instead of
  embedding the skill document.
- `--save=false` is equivalent to omitting `--save`.

## Validation and identity

- Skill names use lowercase letters, digits, and internal hyphens.
- The Markdown begins with frontmatter whose `name` equals the requested name.
- The final nonblank line is `<!-- END AMP SKILL: <name> -->`.
- Documents are canonicalized to LF line endings and exactly one final newline.
- The directory uses a UTC second-resolution timestamp and at least the first
  12 hexadecimal characters of the canonical document's SHA-256 digest.
- The full canonical bytes, not only the shortened hash in the path, determine
  whether an existing artifact is identical and reusable.
- JSON exposes the full digest, byte count, and line count for diagnostics.

These checks apply to the `--save` path during the evaluation period. The EOF
sentinel is an internal delivery check. The normal instruction does not ask
agents to verify metadata or perform a second consumption workflow.

## Filesystem behavior

- Without `--save`, the command performs no filesystem writes.
- Parent directories and the final saved skill file are private to the current
  user.
- The CLI writes `SKILL.md` completely inside a uniquely named sibling staging
  directory, then atomically renames that directory to the final version path.
  The final path is never used as a staging location and a published artifact
  is never overwritten.
- If another invocation has already published the same timestamp, hash prefix,
  and exact canonical bytes, the CLI removes its staging directory and reuses
  the existing path without rewriting `SKILL.md`.
- If a candidate path exists with different bytes, the CLI extends the digest
  prefix four hexadecimal characters at a time until it finds an unused path.
  If all 64 characters are exhausted, it fails without changing any published
  artifact.
- A failed publication removes its private staging directory. It determines a
  collision by inspecting the final path after the failed rename rather than
  relying on a platform-specific filesystem error code.
- No mutable `latest` pointer is created. Running the command again always
  fetches and materializes the current registry response, so an earlier path
  cannot silently stand in for a later retrieval.
- Lifecycle cleanup is delegated to the operating system temporary directory.

## Rollout

- The website prompt opts into the experiment with
  `amp skills get integrating-amplitude --region us --save`.
- Existing users, scripts, redirects, and JSON consumers remain unchanged until
  they add `--save`.
- Making saved delivery the default is a separate decision informed by agent
  completion quality, unnecessary tool-call count, and compatibility results.

## Skill authoring

Entry-point `SKILL.md` files should remain focused on routing, invariants, and
the workflow. Large SDK-specific material should be progressively disclosed
through supporting files or child skills. A practical internal target is at
most 20 KB or 300 lines for the entry file.
