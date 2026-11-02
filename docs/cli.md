# Developer API CLI

`amp` is a manifest-driven CLI generated from the Amplitude Developer API
OpenAPI spec. A handwritten runtime in `src/cli.ts` maps flags to HTTP requests.

## Authentication

Authenticate via the OAuth device flow and save the result as a profile. Omit
`--profile` and the CLI targets `default` — the implicit profile used when you
don't name one. Picking a region stays explicit:

```bash
amp auth login --region us
```

That runs the device flow against the chosen region's Developer API, saves
the token to `~/.amplitude/amp/credentials.json` (0600), and activates the
profile. A profile binds a credential to a region (`base_url`), so an EU
token can never be sent to prod.

```bash
amp auth login --profile eu --region eu          # activates the EU profile
amp auth use prod                                 # switch (no re-auth)
amp auth list                                     # * marks the active profile
amp auth status                                   # type, base URL, expiry
amp logout --profile eu                           # remove one
amp logout --all                                   # remove every profile
```

A bare `amp auth login` re-authenticates the active profile in place (region
from its record). `--region` maps `us|eu` to a base URL.

To use a Personal Access Token instead of the device flow:

```bash
echo "$PAT" | amp auth pat --with-token --region us            # stdin → "default" profile
amp auth pat --with-token --profile ci --region us             # name it; masked prompt at a TTY
```

`--with-token` reads the PAT from stdin when piped, or from a masked prompt at a
terminal. Same rules as `login`: `--profile`
is optional (defaults to `default`) and `--region` is required to create a
profile; the credential is saved as `{ "type": "pat" }`.

`--with-token` is mandatory: it makes the supply-an-existing-PAT path explicit
and keeps the bare `amp auth pat` verb reserved.

### Credential selection

Precedence (highest first): `--token` > `AMP_TOKEN` > `--profile` >
`AMP_PROFILE` > the active (default) profile. `AMP_TOKEN` is **king** over
profile selection so a CI-injected token can't be shadowed by a stray stored
profile; `amp auth status` announces when it is in effect.

```bash
export AMP_TOKEN=amp_...        # one-off / CI; overrides stored profiles
export AMP_PROFILE=eu           # select a stored profile by name
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

| Command family                                      | Scopes                            |
| --------------------------------------------------- | --------------------------------- |
| `context`, `projects list`, `projects api-keys get` | `projects:read`                   |
| `events *`                                          | `taxonomy:read`, `taxonomy:write` |
| `flags *`                                           | `flags:read`, `flags:write`       |
| `guides *`                                          | `guides:read`, `guides:write`     |
| `surveys *`                                         | `surveys:read`, `surveys:write`   |
| `charts *`, `heatmaps *`, `zoning *`                | `analytics:read`                  |

Route-level scopes are defined on each OpenAPI operation (`x-required-scopes`).

When adding new CLI scopes, ensure the OAuth client used for `amp auth login`
allows those scopes before default login requests them. This requires an
out-of-band update on Amplitude's side — contact Amplitude if your integration
needs additional scopes.

## Developer API usage (server-side)

Authenticated requests to the Developer API (`amp projects list`, `amp flags
create`, and other API commands) are measured and logged **server-side** as
part of operating the service — route, HTTP status, your account/org, and client
version (`User-Agent`).

A program that runs `amp` on someone's behalf can set `AMP_CLIENT` (lowercase
letters, digits and `-`) to name itself; the CLI then sends
`User-Agent: amp-cli/<version> (<AMP_CLIENT>)`.

## Global flags

| Flag / env                              | Purpose                                    |
| --------------------------------------- | ------------------------------------------ |
| `--region <us\|eu>`                     | Data region name → base URL                |
| `--profile <name>` / `AMP_PROFILE`      | Select a stored profile                    |
| `--token` / `AMP_TOKEN` / saved profile | Auth token                                 |
| `--json`                                | Force raw JSON output (default when piped) |
| `--yes`                                 | Confirm DELETE operations                  |
| `--dry-run`                             | Preview destructive/query side effects     |
| `--body-json '{...}'`                   | Merge extra JSON into request bodies       |

## Help and output

```bash
amp help                  # product surfaces (context, projects, events, flags, charts, …)
amp help flags            # commands within a surface
amp flags list --help     # flags and examples for one command
amp version
amp auth status
```

In an interactive terminal, list and context commands print human-friendly tables
and summaries. Pipe to a file or another command, or pass `--json`, for raw API
JSON.

## Project ingestion API key

Use `amp projects api-keys --help` to explore the API-key commands, or
`amp projects api-keys --help --json` for structured discovery.

```bash
amp projects api-keys get
amp projects api-keys get --project 12345
amp projects api-keys get --project 12345 --json
AMPLITUDE_API_KEY="$(amp projects api-keys get --project 12345 --raw)"
```

The selector accepts a positive integer project ID, with `--project-id` and
`--project_id` as aliases. Omit it only when the organization has exactly one
non-deleted project. Selection follows the same rules in every environment.

Terminal output identifies the project and shows the full key:

```text
Project: Example Project (12345)
API key: example-project-api-key
```

When no project name is available, the project label contains only its ID.
Piped output preserves the full API response as compact JSON, including
`data.project_id`, `data.project_name`, and `data.api_key`. Pass `--json` to
request JSON at a terminal. The command-specific `--raw` flag outputs only the
full key followed by a newline; enabled `--raw` and `--json` together are a usage
error. Output modes do not change which project is selected.

The command requires `projects:read` and permission to view the project's API
key. It returns the primary ingestion key without confirmation and
does not create, rotate, or save a key. It does not change the active profile.

Failures leave stdout empty. Machine-readable errors on stderr preserve the API's
`error_code` and `retryable` when provided. Use the error code and guidance to
decide the next action:

| Error code                                             | Next action                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `project_selection_required`                           | Run `amp projects list` and provide `--project <project_id>`.                          |
| `project_not_found`                                    | Verify the project ID and your access to the project.                                  |
| `project_key_access_denied`                            | Ask an organization administrator to review key-view permission.                       |
| `project_api_key_not_available`                        | Choose a project that supports ingestion API keys.                                     |
| `project_api_key_unavailable`                          | Ask an administrator to review the project's key settings. This `503` is nonretryable. |
| `upstream_error`, `operation_availability_unavailable` | Retry later when the API marks the error retryable.                                    |

The command does not automatically retry retrieval failures. Unexpected response
bodies are reported without displaying their contents.

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
6. **Charts read** — `amp charts list --project <id> --limit 5`
7. **Events** — list → create → update → (optional delete with `--yes`)

Known issue: `flags update --enabled false` fails for deployment-less flags.
Avoid that path in smoke tests until it is fixed.

## Generated files

Do not edit by hand:

- `src/generated/cli-manifest.ts` — generated from the Developer API OpenAPI spec
- `openapi/bundled/*` — the bundled Developer API OpenAPI spec

These artifacts are generated and kept in sync upstream.
