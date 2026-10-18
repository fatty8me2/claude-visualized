import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@core': resolve(__dirname, 'src/core') } },
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    // app windows open off-screen and never take focus (see backgroundWindows in src/main/index.ts)
    env: { CLAUDE_VIS_BACKGROUND_WINDOWS: '1' },
  },
});
