import { worker, type WorkerContext } from './index.js';

export { API_XML_LIMITS } from './index.js';

export const TEST_KEY = 'mmrsim-test-only-key';
// SHA-256 of the fixed test-only key above, computed locally.
export const TEST_KEYS = 'test:12618e3ff50b86824c539a8510e2f1aca68935c9fc57639b86d74663f6797148';
export const testEnv = {
  API_KEYS: TEST_KEYS,
  RATE_LIMITER: { limit: (_input: { key: string }) => Promise.resolve({ success: true }) },
};

/** Existing behavior tests exercise real auth with an unlimited test-only limiter. */
export const authenticatedWorker = {
  fetch(request: Request, _env: unknown, ctx: WorkerContext): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${TEST_KEY}`);
    return worker.fetch(new Request(request, { headers }), testEnv, ctx);
  },
};
