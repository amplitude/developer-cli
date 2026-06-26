# Developer API CLI

`amp` is a manifest-driven CLI generated from the Amplitude Developer API
OpenAPI spec. A handwritten runtime in `src/cli.ts` maps flags to HTTP requests.

## Authentication

Authenticate via the OAuth device flow and save the result as a named profile.
Creating a profile is force-explicit — name it and pick its environment:

```bash
amp auth login --profile prod --env prod
```

That runs the device flow against the chosen environment's Developer API, saves
the token to `~/.amplitude/amp/credentials.json` (0600), and activates the
profile. A
profile binds a credential to an environment (`base_url`), so a staging token
can never be sent to prod.

```bash
amp auth login --profile staging --env staging   # activates staging
amp auth use prod                                 # switch (no re-auth)
amp auth list                                     # * marks the active profile
amp auth status                                   # type, base URL, expiry
amp logout --profile staging                      # remove one
amp logout --all                                   # remove every profile
```

A bare `amp auth login` re-authenticates the active profile in place (env from
its record). `--env` maps `local|dev|staging|prod|prod-eu` to a base URL; pass
`--base-url <url>` instead to target an arbitrary host.

To use a Personal Access Token instead of the device flow:

```bash
echo "$PAT" | amp auth pat --with-token --profile ci --env prod   # stdin
amp auth pat --with-token --profile ci --env prod                 # masked prompt at a TTY
```

`--with-token` reads the PAT from stdin when piped (the agent / CI path) or a
masked prompt at a terminal (the human path). Same force-explicit create rule
and store as `login`; the credential is saved as `{ "type": "pat" }`.

`--with-token` is mandatory: it makes the supply-an-existing-PAT path explicit
and keeps the bare `amp auth pat` verb reserved.

### Credential selection

Precedence (highest first): `--token` > `AMP_TOKEN` > `--profile` >
`AMP_PROFILE` > the active (default) profile. `AMP_TOKEN` is **king** over
profile selection so a CI-injected token can't be shadowed by a stray stored
profile; `amp auth status` announces when it is in effect.

```bash
export AMP_TOKEN=amp_...        # one-off / CI; overrides stored profiles
export AMP_PROFILE=staging      # select a stored profile by name
```

Accepted forms for `--token` / `AMP_TOKEN`:

- Raw PAT: `amp_...` (normalized to `Bearer PAT=amp_...`)
- Prefixed: `PAT=amp_...`
- Full bearer: `Bearer PAT=amp_...` (or any `Bearer <jwt>`)

`amp auth token` prints the active access token to stdout
(`TOKEN=$(amp auth token)`).

### Required scopes (examples)

`amp auth login` requests **every** scope the CLI can use by default (the
granular `read:`/`write:` scopes below plus the legacy `mcp:read`/`mcp:write`
org scopes), so all commands work immediately after login. The per-command
scopes below document what each command needs.

| Command family             | Scopes                            |
| -------------------------- | --------------------------------- |
| `context`, `projects list` | `read:projects`                   |
| `events *`                 | `read:taxonomy`, `write:taxonomy` |
| `flags *`                  | `read:flags`, `write:flags`       |

Route-level scopes are defined on each OpenAPI operation (`x-required-scopes`).

## Global flags

| Flag / env                              | Purpose                                    |
| --------------------------------------- | ------------------------------------------ |
| `--base-url` / `AMP_API_BASE_URL`       | API host (default: prod)                   |
| `--env <env>`                           | Friendly env name → base URL               |
| `--profile <name>` / `AMP_PROFILE`      | Select a stored profile                    |
| `--token` / `AMP_TOKEN` / saved profile | Auth token                                 |
| `--json`                                | Force raw JSON output (default when piped) |
| `--yes`                                 | Confirm DELETE operations                  |
| `--dry-run`                             | Preview destructive/query side effects     |
| `--body-json '{...}'`                   | Merge extra JSON into request bodies       |

## Help and output

```bash
amp help                  # product surfaces (context, projects, events, flags, …)
amp help flags            # commands within a surface
amp flags list --help     # flags and examples for one command
amp version
amp auth status
```

In an interactive terminal, list and context commands print human-friendly tables
and summaries. Pipe to a file or another command, or pass `--json`, for raw API
JSON.

## Prod smoke checklist

Run against a disposable project when possible. Requires a credential with the
scopes listed above — either an active profile (`amp auth login`) or `AMP_TOKEN`.

```bash
export AMP_TOKEN=amp_...
pnpm smoke
```

Manual checklist:

1. **Health** — `GET /health` returns `200` with `{"status":"ok"}`
2. **Context** — `amp context` resolves auth and org/project context
3. **Projects** — `amp projects list`
4. **Flags read** — `amp flags list --project <id> --limit 5`
5. **Flags write** — create → get → update description → archive dry-run → archive
6. **Events** — list → create → update → (optional delete with `--yes`)

Known issue: `flags update --enabled false` fails for deployment-less flags.
Avoid that path in smoke tests until it is fixed.

## Local server

Point at a running local server:

```bash
amp --base-url http://localhost:3036 context
```

## Generated files

Do not edit by hand:

- `src/generated/cli-manifest.ts` — generated from the Developer API OpenAPI spec
- `openapi/bundled/*` — the bundled Developer API OpenAPI spec

These artifacts are generated and kept in sync upstream.
