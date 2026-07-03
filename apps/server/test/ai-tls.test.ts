import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, ProxyAgent } from 'undici';
import { buildAiDispatcher, createOpenAiClientFactory } from '../src/services/openaiClient.js';
import { AiHubService } from '../src/services/AiHubService.js';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { makeTmpRoot, cleanup } from './helpers.js';

/** An error carrying a nested `cause` chain, like `openai` wraps a TLS failure. */
function connectionErrorChain(): Error {
  const root = Object.assign(new Error('unable to verify the first certificate'), {
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  });
  const mid = Object.assign(new Error('fetch failed'), { cause: root });
  return Object.assign(new Error('Connection error.'), { cause: mid });
}

describe('buildAiDispatcher (env → scoped TLS/proxy)', () => {
  it('returns undefined with no relevant env (default fetch)', () => {
    expect(buildAiDispatcher({})).toBeUndefined();
  });

  it('AI_HUB_INSECURE_TLS=1 → an Agent', () => {
    expect(buildAiDispatcher({ AI_HUB_INSECURE_TLS: '1' })).toBeInstanceOf(Agent);
  });

  it('AI_HUB_CA_CERT → an Agent (CA loaded from file)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-ca-'));
    const ca = path.join(dir, 'ca.pem');
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
    try {
      expect(buildAiDispatcher({ AI_HUB_CA_CERT: ca })).toBeInstanceOf(Agent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AI_HUB_PROXY → a ProxyAgent', () => {
    expect(buildAiDispatcher({ AI_HUB_PROXY: 'http://127.0.0.1:8888' })).toBeInstanceOf(ProxyAgent);
  });
});

describe('AiHubService surfaces the real cause and redacts the key (both operations)', () => {
  let root: string;
  let repo: AiConfigRepo;

  beforeAll(async () => {
    root = await makeTmpRoot();
    repo = new AiConfigRepo(root);
    await repo.update({
      baseURL: 'https://ai.example/v1',
      apiKey: 'SUPER-SECRET-KEY',
      projectId: 'proj',
      model: 'GigaChat-2-Pro',
    });
  });

  afterAll(async () => {
    await cleanup(root);
  });

  it('listModels: exposes nested TLS code, hides the key', async () => {
    const svc = new AiHubService({
      repo,
      makeClient: () => ({
        models: {
          list: () => Promise.reject(connectionErrorChain()),
        },
        chat: { completions: { create: () => Promise.resolve({ choices: [] }) } },
      }),
    });
    let message = '';
    try {
      await svc.listModels();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('unable to verify the first certificate');
    expect(message).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(message).not.toContain('SUPER-SECRET-KEY');
  });

  it('generateDescription: same TLS/proxy path + cause surfacing', async () => {
    const svc = new AiHubService({
      repo,
      makeClient: () => ({
        models: { list: () => Promise.resolve({ data: [] }) },
        chat: {
          completions: { create: () => Promise.reject(connectionErrorChain()) },
        },
      }),
    });
    let message = '';
    try {
      await svc.generateDescription({
        projectId: 'proj',
        requirement: { name: 'Авторизация', type: 'FUNCTION', criticality: 'HIGH' },
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(message).not.toContain('SUPER-SECRET-KEY');
  });
});

// End-to-end proof that the dispatcher actually reaches the openai client's fetch:
// a self-signed HTTPS server is rejected by default and accepted with
// AI_HUB_INSECURE_TLS=1. Skipped where openssl is unavailable.
const opensslOk = ((): boolean => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!opensslOk)('scoped insecure TLS reaches the openai client', () => {
  let server: Server;
  let baseURL: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ai-tls-'));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    // CN-only self-signed cert (no -addext, so LibreSSL on macOS works too).
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '3650',
        '-nodes',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    );
    const { readFileSync } = await import('node:fs');
    server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseURL = `https://127.0.0.1:${port}/v1`;
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a self-signed server by default', async () => {
    const client = createOpenAiClientFactory({})('key', baseURL);
    await expect(client.models.list()).rejects.toThrow();
  });

  it('accepts it with AI_HUB_INSECURE_TLS=1 (scoped, not global)', async () => {
    const client = createOpenAiClientFactory({ AI_HUB_INSECURE_TLS: '1' })('key', baseURL);
    const res = await client.models.list();
    expect(res.data.map((m) => m.id)).toContain('stub-model');
  });
});
