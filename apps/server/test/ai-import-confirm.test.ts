import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError } from '../src/lib/errors.js';
import { cleanup, makeTmpRoot } from './helpers.js';
import {
  KIT_PROJECT,
  approveDocsReview,
  makeImportHarness,
  scriptedClient,
  writeZipArchive,
  type ImportHarness,
} from './aiImportKit.js';

/*
 * todo_20 · T-204: смета и подтверждение. Порог из пресета
 * (`estimateThresholdTokens`): 2 млн по умолчанию, 0 = подтверждать всегда,
 * null = не спрашивать. Пока смета не подтверждена — НИ ОДНОГО LLM-вызова
 * извлечения; `POST /confirm` в неверном статусе — 409.
 */

const EXTRACTION = JSON.stringify([
  {
    type: 'FUNCTION',
    name: 'Аутентификация',
    description: 'Пользователь входит в систему.',
    source: 'auth.md § Вход',
  },
]);
const STRUCTURE = JSON.stringify([{ type: 'FUNCTION', name: 'Аутентификация', parentName: null }]);

/** Poll until the predicate holds (the gate is reached asynchronously). */
async function until(cond: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > 3000) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('T-204 · смета и гейт подтверждения', () => {
  let root: string;
  let h: ImportHarness;
  const archives: string[] = [];

  async function zip(files: Record<string, string>): Promise<string> {
    const file = await writeZipArchive(files);
    archives.push(file);
    return file;
  }

  beforeEach(async () => {
    root = await makeTmpRoot();
    h = await makeImportHarness(root);
  });
  afterEach(async () => {
    await Promise.all(archives.splice(0).map((f) => fs.rm(f, { force: true }).catch(() => {})));
    await cleanup(root);
  });

  it('порог 0 = всегда: awaiting-confirmation, ноль LLM-вызовов до confirm, после — до конца', async () => {
    await h.setPreset({ estimateThresholdTokens: 0 });
    const client = scriptedClient([EXTRACTION, STRUCTURE]);
    const service = h.makeService(client);
    // Заголовок «Что нового» классифицируется эвристикой — LLM-триаж не нужен.
    const { jobId } = await service.start(
      KIT_PROJECT,
      await zip({ 'auth.md': '# Что нового\nВход по паролю.' }),
    );
    await until(
      () => service.getView(jobId).status === 'awaiting-confirmation',
      'awaiting-confirmation',
    );

    const view = service.getView(jobId);
    expect(view.estimate?.overThreshold).toBe(true);
    expect(view.estimate?.thresholdTokens).toBe(0);
    expect(view.log.some((l) => l.message.includes('приостановлен'))).toBe(true);
    // Критерий: до подтверждения ни одного вызова извлечения.
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).not.toHaveBeenCalled();

    const confirmed = await service.confirm(jobId);
    expect(confirmed.status).toBe('running');
    // Двухзонная выверка: the run now pauses at the docs review gate — approve
    // both zones keeping everything to reach the terminal state.
    await service.waitForCompletion(jobId);
    await approveDocsReview(service, jobId);
    const done = service.getView(jobId);
    expect(done.status).toBe('succeeded');
    expect(done.result?.createdFunctions).toBe(1);
    expect(done.log.some((l) => l.message.includes('Смета подтверждена'))).toBe(true);
  });

  it('порог null = не спрашивать: гейта нет даже при большой смете', async () => {
    await h.setPreset({ estimateThresholdTokens: null });
    const service = h.makeService(scriptedClient([EXTRACTION, STRUCTURE]));
    const { jobId } = await service.start(
      KIT_PROJECT,
      await zip({ 'auth.md': '# Что нового\nВход по паролю.' }),
    );
    await service.waitForCompletion(jobId);
    // Порога сметы нет, но двухзонная выверка — есть: подтверждаем обе зоны.
    await approveDocsReview(service, jobId);
    const view = service.getView(jobId);
    expect(view.status).toBe('succeeded');
    expect(view.estimate?.thresholdTokens).toBeNull();
    expect(view.estimate?.overThreshold).toBe(false);
  });

  it('confirm в неверном статусе → ConflictError (409), неизвестный jobId → 404', async () => {
    const service = h.makeService(scriptedClient([EXTRACTION, STRUCTURE]));
    const { jobId } = await service.start(
      KIT_PROJECT,
      await zip({ 'auth.md': '# Что нового\nВход.' }),
    );
    await service.waitForCompletion(jobId);
    await approveDocsReview(service, jobId);
    expect(service.getView(jobId).status).toBe('succeeded');
    await expect(service.confirm(jobId)).rejects.toThrow(ConflictError);
    await expect(service.confirm('nope')).rejects.toThrow(NotFoundError);
  });

  it('cancel во время ожидания сметы → cancelled, извлечение так и не началось', async () => {
    await h.setPreset({ estimateThresholdTokens: 0 });
    const client = scriptedClient([EXTRACTION, STRUCTURE]);
    const service = h.makeService(client);
    const { jobId } = await service.start(
      KIT_PROJECT,
      await zip({ 'auth.md': '# Что нового\nВход.' }),
    );
    await until(
      () => service.getView(jobId).status === 'awaiting-confirmation',
      'awaiting-confirmation',
    );
    service.cancel(jobId);
    await service.waitForCompletion(jobId);
    const view = service.getView(jobId);
    expect(view.status).toBe('cancelled');
    expect(view.result).toBeDefined();
    const create = client.chat.completions.create as ReturnType<typeof vi.fn>;
    expect(create).not.toHaveBeenCalled();
  });

  it('второй импорт, пока первый ждёт подтверждения → ConflictError (джоба активна)', async () => {
    await h.setPreset({ estimateThresholdTokens: 0 });
    const service = h.makeService(scriptedClient([EXTRACTION, STRUCTURE]));
    const { jobId } = await service.start(
      KIT_PROJECT,
      await zip({ 'auth.md': '# Что нового\nВход.' }),
    );
    await until(
      () => service.getView(jobId).status === 'awaiting-confirmation',
      'awaiting-confirmation',
    );
    await expect(
      service.start(KIT_PROJECT, await zip({ 'b.md': '# Что нового\nЕщё.' })),
    ).rejects.toThrow(ConflictError);
    // Разблокируем и даём джобе завершиться, чтобы afterEach не гонялся с ней.
    await service.confirm(jobId);
    await service.waitForCompletion(jobId);
  });

  it('T-211: статус awaiting-confirmation персистится в чекпоинт (переживает kill)', async () => {
    await h.setPreset({ estimateThresholdTokens: 0 });
    const service = h.makeService(scriptedClient([EXTRACTION, STRUCTURE]));
    const { jobId } = await service.start(
      KIT_PROJECT,
      await zip({ 'auth.md': '# Что нового\nВход.' }),
    );
    await until(
      () => service.getView(jobId).status === 'awaiting-confirmation',
      'awaiting-confirmation',
    );
    // Дождаться асинхронной записи state.json.
    let state = await h.checkpoints.load(KIT_PROJECT, jobId);
    const started = Date.now();
    while (state?.status !== 'awaiting-confirmation' && Date.now() - started < 3000) {
      await new Promise((r) => setTimeout(r, 10));
      state = await h.checkpoints.load(KIT_PROJECT, jobId);
    }
    expect(state?.status).toBe('awaiting-confirmation');
    expect(state?.confirmed).toBe(false);
    expect(state?.estimate?.overThreshold).toBe(true);
    await service.confirm(jobId);
    await service.waitForCompletion(jobId);
  });
});
