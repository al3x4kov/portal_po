import { DomainError, type AiModelPreset, type Requirement } from '@po/core';
import type { AiClient } from '../AiHubService.js';
import type { LinkServicePort, RequirementServicePort } from '../ports.js';
import {
  buildRelateMessages,
  parseRelateResponse,
  type ParsedRelate,
  type RelateItem,
} from '../aiImportPrompt.js';
import { AI_IMPORT_JSON_ATTEMPTS } from './constants.js';
import { sanitize } from './text.js';
import type { AiImportRuntime } from './types.js';

export interface RelateInput {
  client: AiClient;
  model: string;
  preset: AiModelPreset;
  apiKey: string;
  requirementService: RequirementServicePort;
  linkService: LinkServicePort;
}

/**
 * Optional stage «Проставление связей ФТ↔НФТ» (todo_16 B2): one AI-hub call
 * over the ALREADY-created requirements (slug + name + short description),
 * answered with NFR↔FUNCTION pairs for RELATES_TO. Hard guarantees:
 *
 * - never creates or modifies requirements — links only;
 * - fabricated ids, self-links and in-answer duplicates are dropped;
 * - existing links (incl. explicit-mention RELATES_TO from Task 15 /
 *   commit 6b3327e) are never duplicated — the fresh snapshot is checked
 *   first, and LinkService re-applies every @po/core graph rule on create;
 * - an AI error/timeout or an unparsable answer NEVER fails the import: the
 *   step is reported as `skipped` (or `partial`) in `job.relate`.
 *
 * Returns `true` when the job was cancelled inside the step (already finished by
 * {@link AiImportRuntime.cancelled}); the caller must stop then.
 */
export async function runRelateStage(rt: AiImportRuntime, input: RelateInput): Promise<boolean> {
  const { job } = rt;
  job.relate = { status: 'running', created: 0 };
  rt.log('info', 'Дополнительный шаг: проставление связей ФТ↔НФТ через AI hub…');
  if (rt.cancelled()) {
    job.relate = { status: 'skipped', created: 0 };
    return true;
  }

  const { requirements } = await input.requirementService.list();
  const functions = requirements.filter((r) => r.type === 'FUNCTION');
  const nfrs = requirements.filter((r) => r.type === 'NFR');
  if (functions.length === 0 || nfrs.length === 0) {
    rt.log(
      'info',
      'Проставление связей ФТ↔НФТ: связывать нечего (в проекте нет пары ФТ/НФТ) — запрос к AI Hub не выполнялся.',
    );
    job.relate = { status: 'done', created: 0 };
    return false;
  }

  const toItem = (r: Requirement): RelateItem => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
  });
  // todo_16 Ф3/Ф5: pre-call line before the relate AI request — job.relate is
  // already 'running' at this point, so the poller sees both signals.
  rt.log('info', 'Связи ФТ↔НФТ: запрос к модели…');
  const outcome = await rt.chat<ParsedRelate>({
    client: input.client,
    model: input.model,
    preset: input.preset,
    messages: buildRelateMessages(functions.map(toItem), nfrs.map(toItem)),
    parse: (content) => parseRelateResponse(content),
    parseFinal: (content) => parseRelateResponse(content, 'lenient'),
    attemptWarn: (attempt) =>
      `Проставление связей ФТ↔НФТ: ответ модели не распознан как JSON-массив пар (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
    truncatedWarn: (attempt) =>
      `Проставление связей ФТ↔НФТ: ответ модели обрезан по лимиту токенов (попытка ${attempt} из ${AI_IMPORT_JSON_ATTEMPTS}).`,
  });
  if (outcome.kind === 'cancelled') {
    job.relate = { status: 'skipped', created: 0 };
    return true;
  }
  if (outcome.kind === 'upstream') {
    rt.log(
      'warn',
      sanitize(
        `Проставление связей ФТ↔НФТ: ошибка обращения к AI Hub: ${outcome.error.message}. Шаг пропущен, импорт продолжен.`,
        input.apiKey,
      ),
    );
    job.relate = { status: 'skipped', created: 0 };
    return false;
  }
  if (outcome.kind === 'unparsed') {
    rt.log(
      'warn',
      'Проставление связей ФТ↔НФТ: ответ модели не распознан — шаг пропущен, импорт продолжен.',
    );
    job.relate = { status: 'skipped', created: 0 };
    return false;
  }

  const { pairs, droppedInvalid, total } = outcome.value;
  if (droppedInvalid > 0) {
    rt.log(
      'warn',
      `Проставление связей ФТ↔НФТ: принято ${total - droppedInvalid} из ${total} пар, невалидных отброшено ${droppedInvalid}.`,
    );
  }
  // todo_18: a VALID empty answer is a real outcome, not a silent skip — say it
  // explicitly so the user sees the model ran and found nothing confident.
  if (pairs.length === 0) {
    rt.log('info', 'Модель не нашла уверенных смысловых пар ФТ↔НФТ.');
    job.relate = { status: 'done', created: 0 };
    return false;
  }
  // Role-typed lookups: a pair is only valid FROM an existing NFR TO an existing
  // FUNCTION — anything else counts as a fabricated id.
  const nfrBySlug = new Map(nfrs.map((r) => [r.slug, r]));
  const fnBySlug = new Map(functions.map((r) => [r.slug, r]));
  const seenPairs = new Set<string>();
  let created = 0;
  let failed = 0;
  let droppedUnknown = 0;
  let droppedSelf = 0;
  let droppedDup = 0;
  let skippedExisting = 0;
  for (const pair of pairs) {
    if (pair.nfr === pair.function) {
      droppedSelf += 1; // core rule: no self-link (assertNoSelfLink)
      continue;
    }
    const source = nfrBySlug.get(pair.nfr);
    const target = fnBySlug.get(pair.function);
    if (!source || !target) {
      droppedUnknown += 1;
      continue;
    }
    const key = `${source.slug} ${target.slug}`;
    if (seenPairs.has(key)) {
      droppedDup += 1;
      continue;
    }
    seenPairs.add(key);
    // RELATES_TO is symmetric — the NFR endpoint always carries its half, so the
    // fresh snapshot suffices to skip present links (incl. the ones just created
    // from explicit mentions, commit 6b3327e).
    if (source.links.some((l) => l.type === 'RELATES_TO' && l.targetSlug === target.slug)) {
      skippedExisting += 1;
      continue;
    }
    if (rt.cancelled()) {
      job.relate = { status: created > 0 ? 'partial' : 'skipped', created };
      return true;
    }
    try {
      // LinkService re-validates via @po/core graph rules (self-link,
      // duplicates, allowed types, cycles) before writing anything.
      await input.linkService.create({
        sourceSlug: source.slug,
        type: 'RELATES_TO',
        targetSlug: target.slug,
      });
      created += 1;
      job.relate = { status: 'running', created };
      rt.log('info', `Связано (AI): НФТ «${source.name}» → ФТ «${target.name}» (RELATES_TO).`);
    } catch (err) {
      if (err instanceof DomainError) {
        failed += 1;
        rt.log(
          'warn',
          `Связь RELATES_TO «${source.name}» → «${target.name}» не создана (${err.code}): ${err.message}`,
        );
      } else {
        throw err;
      }
    }
  }
  const dropped = droppedUnknown + droppedSelf + droppedDup;
  rt.log(
    dropped > 0 || failed > 0 ? 'warn' : 'info',
    `Проставление связей ФТ↔НФТ завершено: создано ${created}` +
      (skippedExisting > 0 ? `, уже существовало ${skippedExisting}` : '') +
      (dropped > 0
        ? `, отброшено ${dropped} (выдуманные id: ${droppedUnknown}, self-link: ${droppedSelf}, дубли: ${droppedDup})`
        : '') +
      (failed > 0 ? `, не создано из-за ошибок: ${failed}` : '') +
      '.',
  );
  job.relate = { status: failed > 0 ? 'partial' : 'done', created };
  return false;
}
