import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiGenerateTestsRequest, Requirement } from '@po/core';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { AiHubService, type AiClient } from '../src/services/AiHubService.js';
import { buildTestCasesMessages, buildTestCasesSystemPrompt } from '../src/services/aiPrompt.js';
import { cleanup, makeTmpRoot } from './helpers.js';

/**
 * Развилка «Генерации артефактов»: AI-кейсы для батча требований с
 * детерминированной анти-галлюцинационной проверкой (якорь — slug).
 */

const SECRET = 'sk-testgen-secret';

function req(slug: string, name: string, over: Partial<Requirement> = {}): Requirement {
  return {
    slug,
    type: 'FUNCTION',
    name,
    criticality: 'HIGH',
    implemented: true,
    links: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Requirement;
}

const BATCH = [req('vhod', 'Вход по паролю'), req('vyhod', 'Выход из системы')];
const NAMES = new Map(BATCH.map((r) => [r.slug, r.name]));

function kase(slug: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug,
    title: `Кейс ${slug}`,
    goal: 'Проверить функцию',
    precondition: 'Приложение запущено',
    steps: ['Открыть экран', 'Выполнить действие'],
    expected: 'Действие выполнено',
    ...over,
  };
}

function clientAnswering(answers: string[]): AiClient {
  const queue = [...answers];
  return {
    models: { list: vi.fn(async () => ({ data: [] })) },
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: queue.shift() ?? '{"cases":[]}' } }],
        })),
      },
    },
  };
}

const INPUT: AiGenerateTestsRequest = {
  projectId: 'Demo',
  kind: 'smoke',
  slugs: ['vhod', 'vyhod'],
};

describe('AiHubService.generateTestCases (анти-галлюцинационная проверка)', () => {
  let root: string;
  let repo: AiConfigRepo;

  beforeEach(async () => {
    root = await makeTmpRoot();
    repo = new AiConfigRepo(root);
    await repo.update({ apiKey: SECRET, projectId: 'Demo', model: 'Qwen-Coder-Next' });
  });
  afterEach(async () => {
    await cleanup(root);
  });

  function service(client: AiClient): AiHubService {
    return new AiHubService({ repo, makeClient: () => client });
  }

  it('счастливый путь: кейсы обоих требований, dropped=0, missing=[]', async () => {
    const client = clientAnswering([JSON.stringify({ cases: [kase('vhod'), kase('vyhod')] })]);
    const res = await service(client).generateTestCases(INPUT, BATCH, NAMES);
    expect(res.cases.map((c) => c.slug).sort()).toEqual(['vhod', 'vyhod']);
    expect(res.dropped).toBe(0);
    expect(res.missing).toEqual([]);
    // Вызов несёт строгую схему structured output своего вида.
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    const params = create.mock.calls[0]![0] as {
      response_format?: { json_schema?: { name?: string } };
      temperature: number;
    };
    expect(params.response_format?.json_schema?.name).toBe('test_cases');
    expect(params.temperature).toBe(0.3);
  });

  it('галлюцинации отброшены: чужой slug, повтор по slug и невалидная форма → dropped, требование без кейса → missing', async () => {
    const answer = JSON.stringify({
      cases: [
        kase('vhod'),
        kase('vhod', { title: 'Повторный кейс' }), // повтор — первый побеждает
        kase('vydumannyj'), // выдуманный slug
        { slug: 'vyhod', title: 'Без шагов' }, // невалидная форма
      ],
    });
    const res = await service(clientAnswering([answer])).generateTestCases(INPUT, BATCH, NAMES);
    expect(res.cases).toHaveLength(1);
    expect(res.cases[0]!.slug).toBe('vhod');
    expect(res.cases[0]!.title).toBe('Кейс vhod'); // первый ответ, не «Повторный»
    expect(res.dropped).toBe(3);
    expect(res.missing).toEqual(['vyhod']);
  });

  it('null-опциональность strict-схемы нормализуется (negativeSteps: null не валит кейс)', async () => {
    const answer = JSON.stringify({
      cases: [kase('vhod', { negativeSteps: null, negativeExpected: null }), kase('vyhod')],
    });
    const res = await service(clientAnswering([answer])).generateTestCases(INPUT, BATCH, NAMES);
    expect(res.cases).toHaveLength(2);
    expect(res.cases[0]!.negativeSteps).toBeUndefined();
  });

  it('бэкенд без structured output: повтор без response_format тем же запросом', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('response_format is not supported'))
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ cases: [kase('vhod')] }) } }],
      });
    const client: AiClient = {
      models: { list: vi.fn(async () => ({ data: [] })) },
      chat: { completions: { create } },
    };
    const res = await service(client).generateTestCases(
      { ...INPUT, slugs: ['vhod'] },
      [BATCH[0]!],
      NAMES,
    );
    expect(res.cases).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[1]![0] as Record<string, unknown>).response_format).toBeUndefined();
  });

  it('не-JSON ответ → AI_UPSTREAM с читаемым русским сообщением', async () => {
    const err = await service(clientAnswering(['извини, не могу']))
      .generateTestCases(INPUT, BATCH, NAMES)
      .catch((e) => e as Error & { code: string });
    expect(err.code).toBe('AI_UPSTREAM');
    expect(err.message).toContain('не распознан');
  });

  it('без ключа → 400; без модели → 400', async () => {
    const bare = new AiConfigRepo(await makeTmpRoot());
    const svc = new AiHubService({ repo: bare, makeClient: () => clientAnswering([]) });
    await expect(svc.generateTestCases(INPUT, BATCH, NAMES)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('негативы: для смок — только по чекбоксу, для крит-регресса — всегда', async () => {
    expect(buildTestCasesSystemPrompt('smoke', false)).toContain('НЕ включай');
    expect(buildTestCasesSystemPrompt('smoke', true)).toContain('обязательны');
    expect(buildTestCasesSystemPrompt('crit-regression', true)).toContain('негативным сценарием');
    // Промпт несёт золотое правило анти-галлюцинаций и якорь slug.
    const system = buildTestCasesSystemPrompt('full', true);
    expect(system).toContain('ТОЛЬКО переданные требования');
    expect(system).toContain('slug');
  });

  it('user-сообщение батча: slug, критичность по-русски, усечённое описание и дети', async () => {
    const withChild = req('lenta', 'Лента', {
      description: 'Оч'.repeat(400),
      links: [{ type: 'PARENT_OF', targetSlug: 'vhod' }],
    });
    const messages = buildTestCasesMessages(
      'full',
      [
        {
          slug: withChild.slug,
          type: withChild.type,
          criticality: withChild.criticality,
          name: withChild.name,
          description: withChild.description,
          childNames: ['Вход по паролю'],
        },
      ],
      true,
    );
    const user = messages[1]!.content;
    expect(user).toContain('lenta\t');
    expect(user).toContain('Высокая');
    expect(user).toContain('…'); // описание усечено бюджетом
    expect(user).toContain('дети: Вход по паролю');
  });
});
