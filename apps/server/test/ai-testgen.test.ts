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

describe('AiHubService.generateTestCases · надёжность батча', () => {
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

  const SIX = ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => req(s, `Требование ${s}`));
  const SIX_NAMES = new Map(SIX.map((r) => [r.slug, r.name]));
  const sixInput: AiGenerateTestsRequest = {
    projectId: 'Demo',
    kind: 'smoke',
    slugs: SIX.map((r) => r.slug),
  };

  it('бюджет ответа зависит от размера батча и вида модели', async () => {
    const client = clientAnswering([JSON.stringify({ cases: SIX.map((r) => kase(r.slug)) })]);
    await service(client).generateTestCases(sixInput, SIX, SIX_NAMES);
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    const small = (create.mock.calls[0]![0] as { max_tokens: number }).max_tokens;

    const client2 = clientAnswering([JSON.stringify({ cases: [kase('vhod'), kase('vyhod')] })]);
    await service(client2).generateTestCases(INPUT, BATCH, NAMES);
    const create2 = client2.chat.completions.create as ReturnType<typeof vi.fn>;
    const smaller = (create2.mock.calls[0]![0] as { max_tokens: number }).max_tokens;

    // Шесть требований требуют больше бюджета, чем два — прежние 3000 были
    // одинаковыми для любого батча и обрывали ответ.
    expect(small).toBeGreaterThan(smaller);
  });

  it('крит-регресс закладывает больше токенов, чем смок: негатив обязателен', async () => {
    const answer = JSON.stringify({ cases: SIX.map((r) => kase(r.slug)) });
    const smoke = clientAnswering([answer]);
    await service(smoke).generateTestCases(sixInput, SIX, SIX_NAMES);
    const crit = clientAnswering([answer]);
    await service(crit).generateTestCases({ ...sixInput, kind: 'crit-regression' }, SIX, SIX_NAMES);

    const tokensOf = (c: AiClient): number =>
      (
        (c.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
          max_tokens: number;
        }
      ).max_tokens;
    expect(tokensOf(crit)).toBeGreaterThan(tokensOf(smoke));
    // Именно этот случай раньше не помещался в фиксированные 3000 токенов.
    expect(tokensOf(crit)).toBeGreaterThan(3000);
  });

  it('оборванный ответ не роняет батч: часть делится пополам и повторяется', async () => {
    // Первый вызов — обрыв JSON на середине (ровно симптом из отчёта).
    const truncated = '{"cases":[{"slug":"a","title":"Кейс a","goal":"Прове';
    const half1 = JSON.stringify({ cases: [kase('a'), kase('b'), kase('c')] });
    const half2 = JSON.stringify({ cases: [kase('d'), kase('e'), kase('f')] });
    const client = clientAnswering([truncated, half1, half2]);

    const res = await service(client).generateTestCases(sixInput, SIX, SIX_NAMES);
    expect(res.cases.map((c) => c.slug).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(res.missing).toEqual([]);
    // Один провальный вызов + две половины.
    expect((client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it('дробление доходит до одного требования; неподдавшееся уходит в missing', async () => {
    const two = SIX.slice(0, 2);
    const twoNames = new Map(two.map((r) => [r.slug, r.name]));
    // Батч не парсится, левая половина (одно требование) — тоже, правая даёт кейс.
    const client = clientAnswering([
      'мусор',
      'снова мусор',
      JSON.stringify({ cases: [kase('b')] }),
    ]);

    const res = await service(client).generateTestCases(
      { ...sixInput, slugs: ['a', 'b'] },
      two,
      twoNames,
    );
    expect(res.cases.map((c) => c.slug)).toEqual(['b']);
    expect(res.missing).toEqual(['a']); // достроится шаблоном на клиенте
  });

  it('частичный успех не считается ошибкой вызова', async () => {
    const client = clientAnswering([
      JSON.stringify({ cases: [kase('a'), kase('b'), kase('c')] }),
      'не JSON',
      'не JSON',
      'не JSON',
      'не JSON',
      'не JSON',
      'не JSON',
      'не JSON',
    ]);
    const res = await service(client).generateTestCases(sixInput, SIX, SIX_NAMES);
    expect(res.cases.length).toBeGreaterThan(0);
    expect(res.missing.length).toBeGreaterThan(0);
  });

  it('когда не удалось совсем ничего — ошибка вызова (клиент покажет её и предложит повтор)', async () => {
    const client = clientAnswering(['мусор', 'мусор', 'мусор']);
    await expect(
      service(client).generateTestCases({ ...sixInput, slugs: ['a'] }, [SIX[0]!], SIX_NAMES),
    ).rejects.toThrow(/не распознан/);
  });

  it('обрыв соединения повторяется, а не роняет батч', async () => {
    let calls = 0;
    const client: AiClient = {
      models: { list: vi.fn(async () => ({ data: [] })) },
      chat: {
        completions: {
          create: vi.fn(async () => {
            calls += 1;
            if (calls === 1) {
              const err = new Error('fetch failed') as Error & { code?: string };
              err.code = 'ECONNRESET';
              throw err;
            }
            return { choices: [{ message: { content: JSON.stringify({ cases: [kase('a')] }) } }] };
          }),
        },
      },
    };
    const res = await service(client).generateTestCases(
      { ...sixInput, slugs: ['a'] },
      [SIX[0]!],
      SIX_NAMES,
    );
    expect(res.cases.map((c) => c.slug)).toEqual(['a']);
    expect(calls).toBeGreaterThan(1);
  });
});
