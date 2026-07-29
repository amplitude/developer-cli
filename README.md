# @amplitude/developer-cli

CLI and developer artifacts for the [Amplitude Developer API](https://developer-api.amplitude.com).

`amp` manages Amplitude first-class platform primitives (projects, taxonomy, and
feature flags) via the Developer API. Related CLIs:

- `ampli` — instrumentation and typed SDK codegen
- `amplitude-wizard` — onboarding and setup

## Design tenets

These guide every change to the CLI (see [AGENTS.md](./AGENTS.md) for the full
version):

1. **Obvious by default.** The best surface needs no explanation — discoverable
   help, consistent verbs, safe defaults, and errors that tell you what to do
   next.
2. **Code is marketing.** This source is public; it is organized for clarity,
   with small single-purpose modules, familiar naming, and schema-validated
   inputs.
3. **Test the seams that matter.** Pure logic is unit tested and the
   safety-critical paths (auth precedence, destructive-action confirmation,
   credential permissions) are covered explicitly.
4. **Two readers: humans and agents.** Interactive output maximizes visibility
   and readability (tables, summaries); piped output is compact and lossless
   (minimal characters) so agents don't pay tokens for decoration.

## Install

```bash
npm install -g @amplitude/developer-cli
amp help
```

Or run without installing:

```bash
npx @amplitude/developer-cli help
```

## Authentication

Run `amp auth login` to authenticate via the OAuth device flow. Omit
`--profile` and the CLI targets `default` — the implicit profile used when you
don't name one. Picking a region stays explicit:

```bash
amp auth login --region us                       # device flow → "default" profile
amp auth status                                  # active credential, type, expiry
amp context
```

Profiles bind a credential to a region (its `base_url`), so an EU token can
never be sent to prod. Name one explicitly when you want more than one:

```bash
amp auth login --profile eu --region eu          # activates the EU profile
amp auth use prod                                 # switch back (no re-auth)
amp auth list                                     # * marks the active profile
amp logout --profile eu                           # remove one
amp logout --all                                   # remove every profile
```

A bare `amp auth login` re-authenticates the active profile in place. Profiles
are saved to `~/.amplitude/amp/credentials.json` (0600).

Prefer a Personal Access Token? `amp auth pat --with-token --region <us|eu>` reads a
PAT from stdin (or a masked prompt at a terminal) and saves it as a profile —
`--profile` optional (defaults to `default`), same force-explicit create rule,
same store. `--with-token` is required.

```bash
echo "$PAT" | amp auth pat --with-token --region us
```

For CI or a one-off shell, set a raw token — it overrides stored profiles:

```bash
export AMP_TOKEN=amp_...        # amp_… is treated as a PAT, anything else a bearer
```

`AMP_PROFILE` selects a stored profile by name; `amp auth token` prints the
active access token to stdout (`TOKEN=$(amp auth token)`).

## Examples

```bash
amp context
amp projects list
amp events list --project <project_id> --limit 5
amp events create --project <project_id> --event-type my_event --display-name "My Event"
amp flags list --project <project_id> --limit 5
amp flags create --project <project_id> --key my-flag --name "My Flag"
amp flags get --project <project_id> --flag <flag_id>
amp flags archive --project <project_id> --flag <flag_id> --dry-run
```

## Smoke test

With a credential available (`amp auth login`, or `AMP_TOKEN` set):

```bash
pnpm smoke
```

See [docs/cli.md](./docs/cli.md) for the full smoke checklist and PAT scope notes.
