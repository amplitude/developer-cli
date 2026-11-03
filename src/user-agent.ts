import { CLI_VERSION } from './help';

const CLIENT_TAG_PATTERN = /^[a-z0-9-]{1,32}$/;

/**
 * `amp-cli/<version>`, followed by `(<tag>)` when `AMP_CLIENT` names the
 * program driving the CLI (for example `mcp`). A tag outside lowercase
 * letters, digits and `-` is dropped rather than sent.
 */
export function cliUserAgent(): string {
  const tag = process.env.AMP_CLIENT?.trim();
  return tag && CLIENT_TAG_PATTERN.test(tag)
    ? `amp-cli/${CLI_VERSION} (${tag})`
    : `amp-cli/${CLI_VERSION}`;
}
