#!/usr/bin/env node

// Keep the executable available before the workspace package is built.
let entrypoint;
try {
  entrypoint = require.resolve('../dist/cli.js');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  console.error(
    'amp has not been built. Run pnpm build in the developer-cli package.',
  );
  process.exit(1);
}

require(entrypoint)
  .main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
