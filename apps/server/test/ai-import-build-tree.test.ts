import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nameKey, type Requirement } from '@po/core';
import { AiConfigRepo } from '../src/repositories/AiConfigRepo.js';
import { AiImportJobs } from '../src/services/AiImportJobs.js';
import { AiImportService } from '../src/services/AiImportService.js';
import type { AiChatCompletionParams, AiClient } from '../src/services/AiHubService.js';
import { PO_GROUP_DESCRIPTION } from '../src/services/aiImport/poTaxonomy.js';
import {
  createLinkService,
  createProjectRepo,
  createProjectService,
  createRequirementService,
  type ServiceContext,
} from '../src/factory.js';
import { cleanup, fixedNow, makeTmpRoot } from './helpers.js';
import { approveDocsReview } from './aiImportKit.js';

const SECRET = 'sk-build-tree-secret';
const PROJECT = 'Demo';

async function writeZip(files: Record<string, string>): Promise<string> {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  const file = path.join(os.tmpdir(), `po-test-bt-zip-${randomBytes(8).toString('hex')}.zip`);
  await fs.writeFile(file, zip.toBuffer());
  return file;
}

const EXTRACTION = JSON.stringify([
  {
    type: 'FUNCTION',
    name: 'Вход по паролю',
    description: 'Вход по email и паролю.',
    source: 'docs.md § Вход',
  },
  {
    type: 'FUNCTION',
    name: 'Выход из системы',
    description: 'Завершение сессии.',
    source: 'docs.md § Выход',
  },
  {
    type: 'NFR',
    name: 'Время отклика',
    description: 'Отклик до 200 мс.',
    source: 'docs.md § SLA',
  },
]);
const TAXONOMY = JSON.stringify([
  { type: 'FUNCTION', name: 'Управление доступом', parentName: null },
  { type: 'FUNCTION', name: 'Аутентификация', parentName: 'Управление доступом' },
  { type: 'NFR', name: 'Производительность', parentName: null },
]);
const ASSIGN = JSON.stringify([
  { type: 'FUNCTION', name: 'Вход по паролю', node: 'F1.1' },
  { type: 'FUNCTION', name: 'Выход из системы', node: 'F1' },
  { type: 'NFR', name: 'Время отклика', node: 'N1' },
]);

interface SeenCall {
  user: string;
  params: AiChatCompletionParams;
}

/** AiClient маршрутизирует ответы по содержимому user-сообщения (порядок вызовов не важен). */
function scriptedClient(calls: SeenCall[]): AiClient {
  return {
    models: { list: vi.fn(async () => ({ data: [] })) },
    chat: {
      completions: {
        create: vi.fn(async (params: AiChatCompletionParams) => {
          const user = params.messages.find((m) => m.role === 'user')?.content ?? '';
          calls.push({ user, params });
          let answer: string;
          if (user.includes('Раунд проектирования')) answer = TAXONOMY;
          else if (user.includes('Таксономия (id, тип, имя, родитель):')) answer = ASSIGN;
          else answer = EXTRACTION;
          return { choices: [{ message: { content: answer } }] };
        }),
      },
    },
  };
}

describe('buildTree: сквозной прогон импорта с логическим деревом «навыка AI PO»', () => {
  let root: string;
  let ctx: ServiceContext;
  let configRepo: AiConfigRepo;
  let jobs: AiImportJobs;

  function makeService(client: AiClient): AiImportService {
    const projectRepo = createProjectRepo(ctx);
    return new AiImportService({
      now: fixedNow,
      jobs,
      configRepo,
      makeAiClient: () => client,
      makeRequirementService: (pid) => createRequirementService(ctx, pid),
      makeLinkService: (pid) => createLinkService(ctx, pid),
      projectExists: (pid) => projectRepo.exists(pid),
    });
  }

  async function listRequirements(): Promise<Requirement[]> {
    const { requirements } = await createRequirementService(ctx, PROJECT).list();
    return requirements;
  }

  function childOf(reqs: Requirement[], name: string): string | undefined {
    const req = reqs.find((r) => r.name === name);
    const link = (req?.links ?? []).find((l) => l.type === 'CHILD_OF');
    if (!link) return undefined;
    return reqs.find((r) => r.slug === link.targetSlug)?.name;
  }

  beforeEach(async () => {
    root = await makeTmpRoot();
    ctx = { projectsRoot: root, now: fixedNow };
    await createProjectService(ctx).create(PROJECT);
    configRepo = new AiConfigRepo(root);
    await configRepo.update({ apiKey: SECRET, projectId: PROJECT, model: 'Qwen-Coder-Next' });
    jobs = new AiImportJobs(fixedNow);
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('строит дерево: группы созданы как требования, CHILD_OF по таксономии, схемы structured output свои на каждый вид вызова', async () => {
    const calls: SeenCall[] = [];
    const service = makeService(scriptedClient(calls));
    const archive = await writeZip({ 'docs.md': '# Вход\nВход.\n# Выход\nВыход.\n# SLA\n200мс.' });
    const { jobId } = await service.start(PROJECT, archive, undefined, false, true);
    await service.waitForCompletion(jobId);
    // Двухзонная выверка: группы таксономии — тоже записи выверки; одобряем всё.
    await approveDocsReview(service, jobId);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');

    const reqs = await listRequirements();
    // 3 извлечённых + 3 группирующих узла.
    expect(reqs).toHaveLength(6);
    const groups = reqs.filter((r) => r.description === PO_GROUP_DESCRIPTION);
    expect(groups.map((g) => g.name).sort()).toEqual([
      'Аутентификация',
      'Производительность',
      'Управление доступом',
    ]);
    // Группы — тоже ИИ-происхождение (подсветка «не проверено» работает и для них).
    expect(groups.every((g) => g.origin === 'AI_DOCS')).toBe(true);

    // Дерево: домен ← раздел ← требование; НФТ — под своей категорией.
    expect(childOf(reqs, 'Аутентификация')).toBe('Управление доступом');
    expect(childOf(reqs, 'Вход по паролю')).toBe('Аутентификация');
    expect(childOf(reqs, 'Выход из системы')).toBe('Управление доступом');
    expect(childOf(reqs, 'Время отклика')).toBe('Производительность');
    expect(childOf(reqs, 'Управление доступом')).toBeUndefined();

    // Прецедент бэклог-хотфикса: каждый вид вызова несёт СВОЮ строгую схему.
    const schemaName = (p: AiChatCompletionParams): string | undefined =>
      (p.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name;
    const taxonomyCall = calls.find((c) => c.user.includes('Раунд проектирования'));
    const assignCall = calls.find(
      (c) => !c.user.includes('Раунд проектирования') && c.user.includes('Таксономия (id'),
    );
    expect(taxonomyCall && schemaName(taxonomyCall.params)).toBe('po_taxonomy_nodes');
    expect(assignCall && schemaName(assignCall.params)).toBe('po_tree_assignments');

    // Итоговая строка лога этапа.
    expect(view.log.some((l) => l.message.includes('создаётся группирующих узлов: 3'))).toBe(true);
  });

  it('повторный прогон идемпотентен: группы и связи не дублируются', async () => {
    const service = makeService(scriptedClient([]));
    const archive1 = await writeZip({ 'docs.md': 'Документация.' });
    const first = await service.start(PROJECT, archive1, undefined, false, true);
    await service.waitForCompletion(first.jobId);
    await approveDocsReview(service, first.jobId);
    const archive2 = await writeZip({ 'docs.md': 'Документация.' });
    const second = await service.start(PROJECT, archive2, undefined, false, true);
    await service.waitForCompletion(second.jobId);
    await approveDocsReview(service, second.jobId);
    expect(service.getView(second.jobId).status).toBe('succeeded');

    const reqs = await listRequirements();
    expect(reqs).toHaveLength(6); // без дублей
    const byKey = new Set(reqs.map((r) => nameKey(r.type, r.name)));
    expect(byKey.size).toBe(6);
    const auth = reqs.find((r) => r.name === 'Вход по паролю');
    expect((auth?.links ?? []).filter((l) => l.type === 'CHILD_OF')).toHaveLength(1);
  });

  it('флаг выключен (по умолчанию): вызовов таксономии/раскладки нет — работает легаси-этап structure', async () => {
    const calls: SeenCall[] = [];
    const service = makeService(scriptedClient(calls));
    const archive = await writeZip({ 'docs.md': 'Документация.' });
    const { jobId } = await service.start(PROJECT, archive);
    await service.waitForCompletion(jobId);
    await approveDocsReview(service, jobId);
    expect(service.getView(jobId).status).toBe('succeeded');
    expect(calls.some((c) => c.user.includes('Раунд проектирования'))).toBe(false);
    const reqs = await listRequirements();
    expect(reqs.some((r) => r.description === PO_GROUP_DESCRIPTION)).toBe(false);
  });
});
