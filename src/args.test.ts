import { describe, expect, it } from 'vitest';

import { isFlagEnabled, parseArgs } from './args';

describe('parseArgs', () => {
  it('separates command tokens from flags', () => {
    const { command, flags } = parseArgs(['flags', 'list', '--project', '123']);
    expect(command).toEqual(['flags', 'list']);
    expect(flags).toEqual({ project: '123' });
  });

  it('parses --name=value equals form', () => {
    expect(parseArgs(['--yes=true']).flags).toEqual({ yes: 'true' });
  });

  it('treats a flag with no value as a boolean switch', () => {
    expect(parseArgs(['--dry-run']).flags).toEqual({ 'dry-run': true });
  });

  it('parses short switches -h and -v as booleans', () => {
    expect(parseArgs(['-h']).flags).toEqual({ h: true });
    expect(parseArgs(['-v']).flags).toEqual({ v: true });
  });

  it('stops flag parsing at -- and keeps it out of the command', () => {
    const { command } = parseArgs(['context', '--']);
    expect(command).toEqual(['context']);
  });

  it('ignores pnpm run-script leading -- separator', () => {
    const { command, flags } = parseArgs(['--', 'auth', '--open']);
    expect(command).toEqual(['auth']);
    expect(flags).toEqual({ open: true });
  });

  it('throws when a string option is passed without a value', () => {
    expect(() => parseArgs(['context', '--token'])).toThrowError(
      "option '--token <value>' argument missing",
    );
  });

  it('parses generated command options after command tokens', () => {
    const { command, flags } = parseArgs([
      'events',
      'list',
      '--project',
      '187520',
      '--limit',
      '10',
    ]);

    expect(command).toEqual(['events', 'list']);
    expect(flags).toMatchObject({ project: '187520', limit: '10' });
  });

  it('parses auth token device-flow options', () => {
    const { command, flags } = parseArgs([
      'auth',
      'token',
      '--flow',
      'device',
      '--scope',
      'openid email',
    ]);

    expect(command).toEqual(['auth', 'token']);
    expect(flags).toMatchObject({ flow: 'device', scope: 'openid email' });
  });
});

describe('isFlagEnabled', () => {
  it('treats boolean true and string "true" as enabled', () => {
    expect(isFlagEnabled(true)).toBe(true);
    expect(isFlagEnabled('true')).toBe(true);
  });

  it('treats everything else as disabled', () => {
    expect(isFlagEnabled(false)).toBe(false);
    expect(isFlagEnabled('false')).toBe(false);
    expect(isFlagEnabled('')).toBe(false);
    expect(isFlagEnabled(undefined)).toBe(false);
  });
});
