import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.js'],
    testTimeout: 20000,
    pool: 'threads',
    env: {
      // Never read the developer's real .env (it holds secrets).
      WGG_SKIP_ENV_FILE: '1',
      // Blank = SMTP not configured, so no test can ever send a real mail.
      SMTP_HOST: '',
      // Same value as SECRET in test/helpers/auth.js.
      SESSION_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    },
  },
});
