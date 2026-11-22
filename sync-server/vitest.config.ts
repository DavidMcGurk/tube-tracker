import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/** Tests run inside the Workers runtime against a local, in-memory D1 database. */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Override the production vars: passkeys come from the software authenticator on a local origin.
          bindings: {
            TEST_MIGRATIONS: migrations,
            RP_ID: 'localhost',
            EXPECTED_ORIGINS: 'http://localhost:5173',
            ALLOWED_ORIGINS: 'http://localhost:5173',
            CHALLENGE_KEY: 'test-challenge-key-0123456789abcdef0123456789',
            MAX_USERS: '2500',
            RATE_LIMITS: 'off'
          }
        }
      })
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
      // Every file shares one database, and some tests count all users, so files run one at a time.
      fileParallelism: false
    }
  };
});
