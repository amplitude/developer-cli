/* eslint-disable no-console */
import { text } from 'node:stream/consumers';

import { type FlagValue, isFlagEnabled, stringFlag } from './args';
import { personalAccessTokenSetupUrl, resolveOrgUrl } from './auth-guidance';
import {
  type DeviceFlowOptions,
  createAnonymousRequest,
  requestDeviceToken,
} from './authToken';
import { ENV_BASE_URLS, resolveEnvBaseUrl } from './config';
import {
  resolveAuthFromFlags,
  selectProfileFromFlags,
} from './credential-resolver';
import {
  type Credential,
  type CredentialStore,
  type OAuthCredential,
  type PatCredential,
  type Profile,
  assertValidProfileName,
  emptyStore,
  getProfile,
  loadStore,
  oauthCredentialSchema,
  removeProfile,
  saveStore,
  setDefault,
  setProfile,
} from './credential-store';
import type { TokenResponse } from './oauthResponseSchemas';
import { askSecret, confirm } from './prompt';
import { DEFAULT_SCOPES } from './scopes';
import { terminal } from './terminal';

/** Builds an OAuth credential record from a freshly minted device-flow token. */
export function oauthCredentialFromToken(
  token: TokenResponse,
  now: number,
): OAuthCredential {
  return {
    type: 'oauth',
    access_token: token.access_token,
    token_type: token.token_type,
    expires_at: new Date(now + token.expires_in * 1000).toISOString(),
    refresh_token: token.refresh_token ?? undefined,
    scope: token.scope ?? undefined,
  };
}

/**
 * The base URL a login targets. Force-explicit: creating a profile needs an
 * explicit `--base-url` or `--env`; re-authing an existing profile reuses the
 * env recorded on it (so a bare re-login keeps working).
 */
export function loginBaseUrl(args: {
  baseUrlFlag?: string;
  envFlag?: string;
  existing?: Profile;
}): string {
  if (args.baseUrlFlag) {
    return args.baseUrlFlag.replace(/\/$/, '');
  }
  if (args.envFlag) {
    return resolveEnvBaseUrl(args.envFlag);
  }
  if (args.existing) {
    return args.existing.base_url;
  }
  throw new Error(
    'Creating a profile requires --env <name> or --base-url <url>.',
  );
}

export interface AuthLoginDeps {
  requestToken?: (options: DeviceFlowOptions) => Promise<TokenResponse>;
  now?: () => number;
  path?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  confirm?: (message: string) => Promise<boolean>;
}

/**
 * `amp auth login` — runs the device flow, saves the token as an OAuth profile,
 * and activates it (announcing the switch). Requires an explicit `--profile`;
 * creating a profile also requires `--env`/`--base-url`.
 */
export async function runAuthLogin(
  flags: Record<string, FlagValue>,
  deps: AuthLoginDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => Date.now());
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const emitStderr = deps.stderr ?? ((line) => console.error(line));
  const confirmOverwrite = deps.confirm ?? confirm;
  const requestToken = deps.requestToken ?? requestDeviceToken;

  const store = loadStore(deps.path);

  // No --profile re-auths the active profile in place (force-explicit applies to
  // *creating* a profile, not refreshing one — the default's env+name are already
  // recorded). With no default there's nothing to refresh, so require both flags.
  // Validate the user-supplied name only; a stored default was already validated
  // when it was created.
  const requestedName = stringFlag(flags, ['profile']);
  if (requestedName !== undefined) {
    assertValidProfileName(requestedName);
  }
  const profileName = requestedName ?? store.default;
  if (!profileName) {
    throw new Error(
      'No default profile to re-authenticate. Run `amp auth login --profile <name> --env <env>`.',
    );
  }

  const existing = getProfile(store, profileName);

  // Orphan default: the name came from the store's `default` but that profile is
  // gone (e.g. a hand-edited file). The user meant to refresh, not create, so
  // match the resolver's "No such profile" instead of falling into
  // loginBaseUrl's misleading "creating a profile requires --env" error. A
  // user-supplied --profile with no match is the legitimate create path.
  if (requestedName === undefined && !existing) {
    throw new Error(`No such profile: ${profileName}. Run \`amp auth list\`.`);
  }

  const baseUrl = loginBaseUrl({
    baseUrlFlag: stringFlag(flags, ['base-url']),
    envFlag: stringFlag(flags, ['env']),
    existing,
  });

  // Reusing a name for a different target is almost always a mistake — confirm
  // before clobbering. Same target is a silent refresh.
  if (existing && existing.base_url !== baseUrl) {
    const approved = await confirmOverwrite(
      `Profile "${profileName}" currently targets ${existing.base_url}. Overwrite to ${baseUrl}?`,
    );
    if (!approved) {
      throw new Error('Aborted.');
    }
  }

  const token = await requestToken({
    flow: stringFlag(flags, ['flow']) ?? 'device',
    scope: stringFlag(flags, ['scope']) ?? DEFAULT_SCOPES,
    request: createAnonymousRequest(baseUrl),
    stderr: emitStderr,
  });

  const profile: Profile = {
    base_url: baseUrl,
    credential: oauthCredentialFromToken(token, now()),
    saved_at: new Date(now()).toISOString(),
    store: 'file',
  };

  const previousDefault = store.default;
  saveStore(
    setDefault(setProfile(store, profileName, profile), profileName),
    deps.path,
  );

  const verb = existing ? 'updated' : 'created';
  const wasNote =
    previousDefault && previousDefault !== profileName
      ? ` (was "${previousDefault}")`
      : '';
  emitStdout(
    terminal.success(
      `Profile "${profileName}" ${verb} and set as default${wasNote}.`,
    ),
  );
}

/** Strips Bearer / PAT= prefixes from a pasted token, leaving the bare PAT. */
export function normalizePat(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('Bearer ')) {
    value = value.slice('Bearer '.length).trim();
  }
  if (value.startsWith('PAT=')) {
    value = value.slice('PAT='.length).trim();
  }
  return value;
}

/**
 * Reads a PAT for `--with-token`: from stdin when piped (the agent / CI path),
 * or a masked prompt at a TTY (the human path). Honors the "two readers"
 * tenet — one flag, both input modes.
 */
async function readWithToken(
  baseUrl: string,
  emitStdout: (line: string) => void,
): Promise<string> {
  if (process.stdin.isTTY) {
    emitStdout(
      `Create a PAT with the scopes you need at:\n  ${personalAccessTokenSetupUrl(
        { apiBaseUrl: baseUrl, orgUrl: resolveOrgUrl() },
      )}`,
    );
    return askSecret('Paste your Personal Access Token: ');
  }
  return text(process.stdin);
}

export interface AuthPatDeps {
  path?: string;
  now?: () => number;
  stdout?: (line: string) => void;
  confirm?: (message: string) => Promise<boolean>;
  // Test seam: supplies the raw token in place of stdin / the masked prompt.
  readToken?: () => Promise<string>;
}

/**
 * `amp auth pat --with-token` — save a supplied Personal Access Token as a
 * profile and activate it. The token is read from stdin when piped, or a masked
 * prompt at a TTY. Force-explicit like login: a new profile needs --profile and
 * --env/--base-url; re-auth of an existing profile reuses its recorded env.
 *
 * `--with-token` is mandatory: it makes the supply-an-existing-PAT path
 * explicit and keeps the bare `amp auth pat` verb reserved.
 */
export async function runAuthPat(
  flags: Record<string, FlagValue>,
  deps: AuthPatDeps = {},
): Promise<void> {
  if (!isFlagEnabled(flags['with-token'])) {
    throw new Error(
      '`amp auth pat` requires --with-token to supply an existing PAT (piped on stdin, or pasted at a prompt).',
    );
  }

  const profileName = stringFlag(flags, ['profile']);
  if (!profileName) {
    throw new Error('`amp auth pat` requires --profile <name>.');
  }
  assertValidProfileName(profileName);

  const now = deps.now ?? (() => Date.now());
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const confirmOverwrite = deps.confirm ?? confirm;

  const store = loadStore(deps.path);
  const existing = getProfile(store, profileName);
  const baseUrl = loginBaseUrl({
    baseUrlFlag: stringFlag(flags, ['base-url']),
    envFlag: stringFlag(flags, ['env']),
    existing,
  });

  // Reusing a name for a different target is almost always a mistake — confirm
  // before clobbering. Same target is a silent refresh.
  if (existing && existing.base_url !== baseUrl) {
    const approved = await confirmOverwrite(
      `Profile "${profileName}" currently targets ${existing.base_url}. Overwrite to ${baseUrl}?`,
    );
    if (!approved) {
      throw new Error('Aborted.');
    }
  }

  const readToken =
    deps.readToken ?? (() => readWithToken(baseUrl, emitStdout));
  const pat = normalizePat(await readToken());
  if (!pat) {
    throw new Error('PAT cannot be empty.');
  }

  const credential: PatCredential = { type: 'pat', pat };
  const profile: Profile = {
    base_url: baseUrl,
    credential,
    saved_at: new Date(now()).toISOString(),
    store: 'file',
  };

  const previousDefault = store.default;
  saveStore(
    setDefault(setProfile(store, profileName, profile), profileName),
    deps.path,
  );

  const verb = existing ? 'updated' : 'created';
  const wasNote =
    previousDefault && previousDefault !== profileName
      ? ` (was "${previousDefault}")`
      : '';
  emitStdout(
    terminal.success(
      `Profile "${profileName}" ${verb} and set as default${wasNote}.`,
    ),
  );
}

interface ProfileCommandDeps {
  path?: string;
  now?: () => number;
  stdout?: (line: string) => void;
}

/** Reverses a base_url back to its friendly `--env` name when one is known. */
export function envLabel(baseUrl: string): string {
  for (const [name, url] of Object.entries(ENV_BASE_URLS)) {
    if (url === baseUrl) {
      return name;
    }
  }
  return baseUrl;
}

function humanizeDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Time-to-expiry label for `auth list` — only OAuth tokens expire. */
export function expiryLabel(credential: Credential, now: number): string {
  const oauth = oauthCredentialSchema.safeParse(credential);
  if (!oauth.success) {
    return '—';
  }
  const at = Date.parse(oauth.data.expires_at);
  if (Number.isNaN(at)) {
    return '—';
  }
  return at <= now ? 'expired' : `in ${humanizeDuration(at - now)}`;
}

export function formatProfileList(store: CredentialStore, now: number): string {
  const names = Object.keys(store.profiles);
  if (names.length === 0) {
    return 'No profiles. Run `amp auth login`.';
  }

  const rows = names.map((name) => {
    const profile = store.profiles[name];
    return {
      marker: store.default === name ? '*' : ' ',
      profile: name,
      type: profile.credential.type,
      env: envLabel(profile.base_url),
      expires: expiryLabel(profile.credential, now),
    };
  });

  // Pad each column to the widest cell (header included) so the table aligns
  // regardless of profile-name / env length. Trailing column isn't padded.
  const header = {
    profile: 'PROFILE',
    type: 'TYPE',
    env: 'ENV',
    expires: 'EXPIRES',
  };
  const width = (key: 'profile' | 'type' | 'env') =>
    Math.max(header[key].length, ...rows.map((row) => row[key].length));
  const wProfile = width('profile');
  const wType = width('type');
  const wEnv = width('env');

  const line = (
    marker: string,
    cells: { profile: string; type: string; env: string; expires: string },
  ) =>
    `${marker} ${cells.profile.padEnd(wProfile)}  ${cells.type.padEnd(wType)}  ${cells.env.padEnd(wEnv)}  ${cells.expires}`.trimEnd();

  return [line(' ', header), ...rows.map((row) => line(row.marker, row))].join(
    '\n',
  );
}

/** `amp auth list` — show profiles, marking the default with `*`. */
export function runAuthList(deps: ProfileCommandDeps = {}): void {
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const now = deps.now?.() ?? Date.now();
  emitStdout(formatProfileList(loadStore(deps.path), now));
}

/** `amp auth use <name>` — repoint the default with no re-auth. */
export function runAuthUse(
  name: string | undefined,
  deps: ProfileCommandDeps = {},
): void {
  if (!name) {
    throw new Error(
      '`amp auth use` requires a profile name: amp auth use <name>.',
    );
  }
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const store = loadStore(deps.path);
  if (!getProfile(store, name)) {
    const known = Object.keys(store.profiles);
    throw new Error(
      `No such profile: ${name}.${known.length ? ` Known: ${known.join(', ')}.` : ' Run `amp auth login`.'}`,
    );
  }
  const previousDefault = store.default;
  saveStore(setDefault(store, name), deps.path);
  const wasNote =
    previousDefault && previousDefault !== name
      ? ` (was "${previousDefault}")`
      : '';
  emitStdout(terminal.success(`Default profile is now "${name}"${wasNote}.`));
}

/**
 * `amp logout [--profile <name> | --all]` — remove a profile, or wipe the whole
 * store with `--all`. Target resolution is `--profile` > default > error. Clears
 * `default` if it pointed at the removed profile and never auto-promotes a
 * survivor (the active identity only changes on an explicit command), so
 * logging out the default leaves no default set.
 */
export function runLogout(
  flags: Record<string, FlagValue>,
  deps: ProfileCommandDeps = {},
): void {
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const store = loadStore(deps.path);

  if (isFlagEnabled(flags.all)) {
    if (stringFlag(flags, ['profile'])) {
      throw new Error('Pass either --profile <name> or --all, not both.');
    }
    const count = Object.keys(store.profiles).length;
    if (count === 0) {
      emitStdout('No profiles to remove.');
      return;
    }
    saveStore(emptyStore(), deps.path);
    emitStdout(
      terminal.success(
        `Removed all ${count} profile${count === 1 ? '' : 's'}. No credentials remain — run \`amp auth login\`.`,
      ),
    );
    return;
  }

  const target = stringFlag(flags, ['profile']) ?? store.default;

  if (!target) {
    throw new Error(
      'No profile to log out of. Pass --profile <name> or set a default with `amp auth use`.',
    );
  }
  if (!getProfile(store, target)) {
    const known = Object.keys(store.profiles);
    throw new Error(
      `No such profile: ${target}.${known.length ? ` Known: ${known.join(', ')}.` : ''}`,
    );
  }

  const wasDefault = store.default === target;
  const next = removeProfile(store, target);
  saveStore(next, deps.path);

  if (wasDefault) {
    const remaining = Object.keys(next.profiles);
    const pick = remaining.length
      ? `select another (${remaining.join(', ')}) with \`amp auth use <profile>\``
      : 'create one with `amp auth login`';
    emitStdout(
      terminal.success(
        `Logged out of "${target}". No default set — commands won't authenticate until you ${pick}.`,
      ),
    );
    return;
  }
  emitStdout(terminal.success(`Logged out of "${target}".`));
}

/** Masks a secret for display: first and last few chars, middle elided. */
export function maskToken(token: string): string {
  if (token.length <= 8) {
    return '••••';
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

interface AuthStatusDeps {
  store?: CredentialStore;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
}

/**
 * `amp auth status` — local inspection of the active credential. Resolves via
 * the shared precedence ladder (so it agrees with every API command), then
 * prints source, profile/type/expiry, base URL, and a masked token. Exits 0
 * when a usable credential resolves, non-zero otherwise — scriptable. When
 * `AMP_TOKEN` is in effect it is announced (the gh "exported token silently
 * shadows my login" mitigation). No network call.
 */
export function runAuthStatus(
  flags: Record<string, FlagValue>,
  deps: AuthStatusDeps = {},
): void {
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const now = deps.now?.() ?? Date.now();
  const store = deps.store ?? loadStore();

  emitStdout(`${terminal.heading('Auth status')}\n`);

  const emitProfileRows = (name: string, profile: Profile): void => {
    const marker = store.default === name ? ' (default)' : '';
    emitStdout(`Profile:  ${name}${marker}`);
    emitStdout(`Type:     ${profile.credential.type}`);
    emitStdout(`Expires:  ${expiryLabel(profile.credential, now)}`);
  };

  let auth;
  try {
    auth = resolveAuthFromFlags(flags, { store, now, env: deps.env });
  } catch (error) {
    // Resolution failed — most often an expired (or otherwise unusable) stored
    // credential. Still surface the selected profile's metadata, including
    // `Expires: expired`, so status stays a useful diagnostic; then exit non-zero.
    const selected = selectProfileFromFlags(flags, { store, env: deps.env });
    if (selected) {
      emitProfileRows(selected.name, selected.profile);
    }
    emitStdout(
      terminal.warning(error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
    return;
  }

  if (auth.source.startsWith('AMP_TOKEN')) {
    emitStdout(
      terminal.warning('AMP_TOKEN is set and overrides any stored profile.'),
    );
  }

  emitStdout(`Source:   ${terminal.dim(auth.source)}`);

  const profile = auth.profile ? getProfile(store, auth.profile) : undefined;
  if (auth.profile && profile) {
    emitProfileRows(auth.profile, profile);
  }

  emitStdout(`Base URL: ${terminal.dim(auth.baseUrl)}`);
  emitStdout(`Token:    ${maskToken(auth.token)}`);
}

/**
 * `amp auth token` — print the resolved access token to stdout, nothing else,
 * so it pipes cleanly (`TOKEN=$(amp auth token)`). Reads the store via the
 * shared resolver instead of running a flow; when no credential resolves (or
 * the selected one has expired) the resolver throws and the CLI exits non-zero
 * with no stdout.
 */
export function runAuthToken(
  flags: Record<string, FlagValue>,
  deps: AuthStatusDeps = {},
): void {
  const emitStdout = deps.stdout ?? ((line) => console.log(line));
  const auth = resolveAuthFromFlags(flags, {
    store: deps.store,
    now: deps.now?.(),
    env: deps.env,
  });
  emitStdout(auth.token);
}
