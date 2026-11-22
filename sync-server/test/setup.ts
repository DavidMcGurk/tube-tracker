import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Idempotent: migrations already applied are skipped, so every test file can run this.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
