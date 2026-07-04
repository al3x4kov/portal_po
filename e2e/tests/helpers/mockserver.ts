import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Helper for driving a REAL MockServer (https://www.mock-server.com/) from E2E.
 *
 * Unlike helpers/ai-stub.ts (an in-process Node stub), this talks to an
 * external Java MockServer on 127.0.0.1:1080 pre-seeded with OpenAI-compatible
 * AI Hub expectations (see ~/Documents/mockserver/expectations-init.json):
 *   - GET  /openai/v1/models            → 3 models (requires `Authorization: Bearer .+`)
 *   - POST /openai/v1/chat/completions  → routed by prompt substring:
 *       «экстрактор требований» → extraction JSON array (priority 20)
 *       «инженерии требований»  → generated description text (priority 19)
 *       anything else           → chat assistant reply (priority 10)
 *   - both endpoints answer 401 without a Bearer header (priority 5)
 *
 * Tests overlay fault expectations with priority ≥ 30 via `addExpectation` and
 * MUST remove them afterwards with `clearExpectation({ id })` — never call
 * `/mockserver/reset`, that would wipe the pre-seeded base expectations too.
 */

export const MOCKSERVER_URL = 'http://127.0.0.1:1080';
const INIT_JSON = '/Users/aleksandr/Documents/mockserver/expectations-init.json';

/** OpenAI base URL the portal's AI config must point at. */
export const MOCKSERVER_OPENAI_BASE = `${MOCKSERVER_URL}/openai/v1`;
export const MODELS_PATH = '/openai/v1/models';
export const COMPLETIONS_PATH = '/openai/v1/chat/completions';

export interface MockServerHandle {
  available: boolean;
  /** true when THIS process spawned the server (then stop() kills it). */
  spawned: boolean;
  stop(): Promise<void>;
}

/** One request record from PUT /mockserver/retrieve?type=REQUESTS. */
export interface RecordedRequest {
  method?: string;
  path?: string;
  headers?: Record<string, string[]>;
  body?: unknown;
  [key: string]: unknown;
}

async function statusOk(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${MOCKSERVER_URL}/mockserver/status`, {
      method: 'PUT',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Make sure a MockServer answers on :1080. If none does, try to spawn the
 * brew-installed `mockserver` binary seeded with the base expectations; when
 * the binary is missing (e.g. CI without Java) report `available: false` so
 * the spec can skip itself gracefully.
 */
export async function ensureMockServer(): Promise<MockServerHandle> {
  if (await statusOk()) {
    return { available: true, spawned: false, stop: async () => {} };
  }

  let child: ChildProcess;
  try {
    child = spawn('mockserver', ['-serverPort', '1080'], {
      env: { ...process.env, MOCKSERVER_INITIALIZATION_JSON_PATH: INIT_JSON },
      stdio: 'ignore',
    });
  } catch {
    return { available: false, spawned: false, stop: async () => {} };
  }

  let dead = false;
  child.on('error', () => {
    dead = true; // ENOENT: binary not installed
  });
  child.on('exit', () => {
    dead = true;
  });

  const stop = async (): Promise<void> => {
    if (!child.killed) child.kill('SIGTERM');
  };

  // Java startup takes a few seconds; poll the status endpoint.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (dead) break;
    if (await statusOk()) return { available: true, spawned: true, stop };
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  return { available: false, spawned: false, stop: async () => {} };
}

/** PUT /mockserver/expectation — add a (fault) expectation; 201 expected. */
export async function addExpectation(expectation: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${MOCKSERVER_URL}/mockserver/expectation`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(expectation),
  });
  if (res.status !== 201) {
    throw new Error(`addExpectation failed (${res.status}): ${await res.text()}`);
  }
}

/**
 * PUT /mockserver/clear — remove an expectation by `{id}` or by request
 * matcher. Base expectations are only touched if the matcher covers them, so
 * tests always clear BY ID of the expectation they added.
 */
export async function clearExpectation(
  idOrMatcher: string | Record<string, unknown>,
): Promise<void> {
  const body = typeof idOrMatcher === 'string' ? { id: idOrMatcher } : idOrMatcher;
  const res = await fetch(`${MOCKSERVER_URL}/mockserver/clear`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 202) {
    const text = await res.text();
    // Idempotent clear: MockServer 7 answers 400 «No expectation found with
    // id …» — a no-op for our belt-and-suspenders cleanup, not an error.
    if (res.status === 400 && text.includes('No expectation found')) return;
    throw new Error(`clearExpectation failed (${res.status}): ${text}`);
  }
}

/**
 * PUT /mockserver/verify — assert the upstream really received the request.
 * 202 → verified; 406 → verification failed (detail in the body).
 */
export async function verify(
  httpRequest: Record<string, unknown>,
  times: Record<string, number> = { atLeast: 1 },
): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`${MOCKSERVER_URL}/mockserver/verify`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ httpRequest, times }),
  });
  const detail = await res.text();
  return { ok: res.status === 202, detail };
}

/** PUT /mockserver/retrieve?type=REQUESTS — recorded requests for a matcher. */
export async function retrieveRequests(
  matcher: Record<string, unknown>,
): Promise<RecordedRequest[]> {
  const res = await fetch(`${MOCKSERVER_URL}/mockserver/retrieve?type=REQUESTS&format=JSON`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(matcher),
  });
  if (!res.ok) throw new Error(`retrieveRequests failed (${res.status}): ${await res.text()}`);
  const parsed = (await res.json()) as unknown;
  return Array.isArray(parsed) ? (parsed as RecordedRequest[]) : [];
}

/** Body of a recorded request as a plain string (JSON bodies re-serialized). */
export function bodyAsString(req: RecordedRequest): string {
  const body = req.body as { type?: string; string?: string; json?: unknown } | string | undefined;
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (typeof body.string === 'string') return body.string;
  if (body.json !== undefined) return JSON.stringify(body.json);
  return JSON.stringify(body);
}

/** Parse a recorded chat-completions body into { model, messages }. */
export function parseChatBody(req: RecordedRequest): {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
} {
  try {
    return JSON.parse(bodyAsString(req)) as {
      model?: string;
      messages?: Array<{ role: string; content: string }>;
    };
  } catch {
    return {};
  }
}
