import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: that one is rooted at src/web for the
// dashboard bundle, while the tests live next to the server code they cover.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Every file gets its own scratch database; see the setup file.
    setupFiles: ['src/server/test/setup.ts'],
    restoreMocks: true,
  },
});
