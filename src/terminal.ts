import chalk from 'chalk';

export const terminal = {
  command: chalk.cyan,
  dim: chalk.dim,
  error: chalk.red,
  heading: chalk.bold,
  success: chalk.green,
  warning: chalk.yellow,
};

const plain = (value: string): string => value;

/** Terminal styling when stdout is not a TTY (piped / scripted output). */
export const plainTerminal = {
  command: plain,
  dim: plain,
  error: plain,
  heading: plain,
  success: plain,
  warning: plain,
};

export function terminalForStdout(isTTY = Boolean(process.stdout.isTTY)) {
  return isTTY ? terminal : plainTerminal;
}
