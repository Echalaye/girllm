import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    // node:sqlite is built into Node but still flagged "experimental": hide that notice in test output.
    // (Vitest 4+: `execArgv` sits directly under `test`; `poolOptions` was removed.)
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
