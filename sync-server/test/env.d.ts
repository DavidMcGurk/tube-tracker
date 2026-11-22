import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../src/env';

/** The type of `env` from cloudflare:workers in tests: the Worker's bindings plus the migrations from vitest.config.ts. */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
