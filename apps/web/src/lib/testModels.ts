import type { AiTestCase, Requirement, TestModelKind } from '@po/core';

/**
 * Сборка артефактов генерации (модели тестирования + задачи TaskTracker).
 *
 * Документ собирается из БЛОКОВ, а не из одной простыни: каждый блок знает свой
 * `tc-id`, происхождение (`ai` / `template`) и тело без front-matter. Это нужно
 * полноэкранному экрану «Результат» (макеты Г9/Г10), где кейсы показываются
 * карточками с бейджем происхождения; `doc.md` при этом байт-в-байт совпадает
 * с прежним выводом генераторов — формат файла не менялся.
 */

/** Один тест-кейс (или задача трекера) как самостоятельный блок документа. */
export interface TestCaseBlock {
  /** Slug требования, к которому привязан кейс. */
  slug: string;
  /** Идентификатор кейса: `SMK-001` / `CRG-004` (для трекера — slug). */
  tcId: string;
  /** Заголовок карточки: имя требования или заголовок AI-кейса. */
  title: string;
  /** Имя требования — показывается под заголовком AI-кейса. */
  reqName: string;
  /** Происхождение: ответ модели или детерминированный шаблон. */
  source: 'ai' | 'template';
  /** Полный md-блок (front-matter + тело) — то, что уходит в файл. */
  md: string;
  /** Тело без front-matter — для предпросмотра карточкой. */
  body: string;
}

/** Готовый документ: шапка + блоки + собранный md. */
export interface TestModelDoc {
  header: string;
  blocks: TestCaseBlock[];
  md: string;
}

/** Метаданные AI-прогона для шапки собранного файла. */
export interface AiRunMeta {
  model: string;
  aiCases: number;
  fallbackCases: number;
  dropped: number;
}

function makeBlock(
  slug: string,
  tcId: string,
  title: string,
  reqName: string,
  source: 'ai' | 'template',
  front: string[],
  body: string[],
): TestCaseBlock {
  return {
    slug,
    tcId,
    title,
    reqName,
    source,
    md: [...front, ...body].join('\n'),
    body: body.join('\n'),
  };
}

function makeDoc(headerLines: string[], blocks: TestCaseBlock[]): TestModelDoc {
  const header = headerLines.join('\n');
  return { header, blocks, md: [header, ...blocks.map((b) => b.md)].join('\n') };
}

// ─── Обход дерева ────────────────────────────────────────────────────────────

/** Build slug→Requirement map from list. */
function indexBySlug(reqs: Requirement[]): Map<string, Requirement> {
  return new Map(reqs.map((r) => [r.slug, r]));
}

/** True if the requirement has a CHILD_OF link (has a parent). */
export function hasParent(r: Requirement): boolean {
  return r.links.some((l) => l.type === 'CHILD_OF');
}

/** Number of PARENT_OF links (direct children count). */
export function childCount(r: Requirement): number {
  return r.links.filter((l) => l.type === 'PARENT_OF').length;
}

/** BFS traversal order over PARENT_OF links, roots first. */
export function bfsOrder(reqs: Requirement[]): Requirement[] {
  const bySlug = indexBySlug(reqs);
  const roots = reqs.filter((r) => !hasParent(r));
  const visited = new Set<string>();
  const result: Requirement[] = [];
  const queue: Requirement[] = [...roots];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur.slug)) continue;
    visited.add(cur.slug);
    result.push(cur);
    for (const l of cur.links) {
      if (l.type === 'PARENT_OF') {
        const child = bySlug.get(l.targetSlug);
        if (child && !visited.has(child.slug)) queue.push(child);
      }
    }
  }
  // append any unreachable nodes
  for (const r of reqs) {
    if (!visited.has(r.slug)) result.push(r);
  }
  return result;
}

const CRIT_ORDER: Record<string, number> = {
  BLOCKER: 0,
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
};

/*
 * ── Отбор требований по виду тестовой модели ────────────────────────────────
 * Единый источник для ОБОИХ путей развилки: детерминированный шаблон и
 * AI-генерация работают по одному и тому же набору и порядку требований,
 * поэтому охват моделей не зависит от выбранного способа.
 */
export function selectForKind(kind: TestModelKind, reqs: Requirement[]): Requirement[] {
  const fn = reqs.filter((r) => r.type === 'FUNCTION');
  if (kind === 'smoke') {
    const included = fn.filter(
      (r) =>
        ['BLOCKER', 'CRITICAL', 'HIGH'].includes(r.criticality) || !hasParent(r) || !r.implemented,
    );
    included.sort((a, b) => {
      const ca = CRIT_ORDER[a.criticality] ?? 9;
      const cb = CRIT_ORDER[b.criticality] ?? 9;
      if (ca !== cb) return ca - cb;
      const ra = hasParent(a) ? 1 : 0;
      const rb = hasParent(b) ? 1 : 0;
      if (ra !== rb) return ra - rb;
      if (a.implemented !== b.implemented) return a.implemented ? 1 : -1;
      return 0;
    });
    return included;
  }
  if (kind === 'crit-regression') {
    const included = fn.filter(
      (r) =>
        ['BLOCKER', 'CRITICAL'].includes(r.criticality) || !r.implemented || childCount(r) >= 3,
    );
    included.sort((a, b) => {
      const ca = CRIT_ORDER[a.criticality] ?? 9;
      const cb = CRIT_ORDER[b.criticality] ?? 9;
      if (ca !== cb) return ca - cb;
      if (childCount(b) !== childCount(a)) return childCount(b) - childCount(a);
      if (a.implemented !== b.implemented) return a.implemented ? 1 : -1;
      return 0;
    });
    return included;
  }
  return bfsOrder(fn);
}

export const TC_PREFIX: Record<TestModelKind, string> = {
  smoke: 'SMK',
  'crit-regression': 'CRG',
  full: 'FUL',
};

export const KIND_TITLE: Record<TestModelKind, string> = {
  smoke: 'Smoke-модель тестирования',
  'crit-regression': 'Критический регресс-модель тестирования',
  full: 'Полная модель тестирования',
};

/** Человекочитаемое правило отбора — панель «Что вы получите» (макет Г1). */
export const KIND_RULES: Record<TestModelKind, string> = {
  smoke:
    'Критичность Блокер/Критическая/Высокая, корни дерева и нереализованные ФТ. ' +
    'Порядок — по критичности, корни раньше детей.',
  'crit-regression':
    'ФТ уровня Блокер/Критическая, «широкие» ветки (≥ 3 вложенных) и нереализованные ФТ. ' +
    'Каждый кейс — позитивный сценарий плюс обязательный негативный.',
  full: 'Все ФТ проекта в порядке обхода дерева (корни раньше детей), сценарии P/N/B.',
};

/** Номер кейса по порядку: SMK-001, CRG-012. */
function tcId(kind: TestModelKind, index: number): string {
  return `${TC_PREFIX[kind]}-${String(index + 1).padStart(3, '0')}`;
}

// ── Smoke ───────────────────────────────────────────────────────────────────

/** Smoke-модель: блоки + md (детерминированный шаблон). */
export function buildSmokeDoc(reqs: Requirement[]): TestModelDoc {
  const fn = reqs.filter((r) => r.type === 'FUNCTION');
  const included = selectForKind('smoke', reqs);
  const header = [
    '# Smoke-модель тестирования\n',
    `_Сгенерировано автоматически. Принципы: Криспин (Agile Testing). Охват: ${included.length} из ${fn.length} ФТ._\n`,
  ];
  const blocks = included.map((r, i) => {
    const id = tcId('smoke', i);
    const front = [
      `---`,
      `model: smoke`,
      `req-slug: ${r.slug}`,
      `req-criticality: ${r.criticality}`,
      `tc-id: ${id}`,
      `priority: ${i + 1}`,
      `---\n`,
    ];
    const body = [
      `### ${id} · ${r.name}\n`,
      `**Цель:** убедиться, что ключевая функция доступна и базово работает.\n`,
      `**Предусловие:** приложение запущено, проект открыт.\n`,
      `**Шаги:**`,
      `1. Открыть раздел / выполнить минимальное действие, соответствующее функции.`,
      `2. Убедиться, что функция отвечает без ошибок (нет 4xx/5xx).`,
      `3. Убедиться, что результат визуально присутствует в UI.\n`,
      `**Ожидаемый результат:** функция доступна, данные отображены без ошибок.\n`,
      `**Время выполнения:** ≤ 2 мин.\n`,
    ];
    if (r.description) body.push(`> ${r.description.split('\n').join('\n> ')}\n`);
    return makeBlock(r.slug, id, r.name, r.name, 'template', front, body);
  });
  return makeDoc(header, blocks);
}

// ── Critical Regression ─────────────────────────────────────────────────────

/** Критический регресс: блоки + md (детерминированный шаблон). */
export function buildCritRegressionDoc(reqs: Requirement[]): TestModelDoc {
  const fn = reqs.filter((r) => r.type === 'FUNCTION');
  const included = selectForKind('crit-regression', reqs);
  const header = [
    '# Критический регресс-модель тестирования\n',
    `_Сгенерировано автоматически. Охват: BLOCKER/CRITICAL ФТ + широкие узлы (≥3 детей) + не реализованные. ${included.length} из ${fn.length} ФТ._\n`,
  ];
  const blocks = included.map((r, i) => {
    const id = tcId('crit-regression', i);
    const children = r.links.filter((l) => l.type === 'PARENT_OF').map((l) => l.targetSlug);
    const front = [
      `---`,
      `model: critical-regression`,
      `req-slug: ${r.slug}`,
      `req-criticality: ${r.criticality}`,
      `tc-id: ${id}`,
      `priority: ${i + 1}`,
    ];
    if (children.length > 0) {
      front.push(`covers-children:`);
      for (const c of children) front.push(`  - ${c}`);
    }
    front.push(`---\n`);
    const body = [
      `### ${id} · ${r.name}\n`,
      `**Цель:** проверить, что вся функциональная ветка работает корректно.\n`,
      `**Предусловие:** чистое состояние, все дочерние функции доступны.\n`,
      `**Позитивный сценарий:**`,
      `1. Выполнить основное действие функции.`,
    ];
    if (children.length > 0) {
      body.push(
        `2. Выполнить основное действие минимум одной дочерней функции из covers-children.`,
      );
    }
    body.push(`\n**Негативный сценарий:**`);
    body.push(`1. Передать невалидные данные / нарушить предусловие.`);
    body.push(`2. Проверить граничное значение (минимум одно).\n`);
    body.push(
      `**Ожидаемый результат (позитив):** операция завершена, данные сохранены/отображены корректно.`,
    );
    body.push(
      `**Ожидаемый результат (негатив):** система возвращает понятную ошибку, состояние не повреждено.\n`,
    );
    return makeBlock(r.slug, id, r.name, r.name, 'template', front, body);
  });
  return makeDoc(header, blocks);
}

// ── Full model ──────────────────────────────────────────────────────────────

/** Полная модель: блоки + md (детерминированный шаблон). */
export function buildFullDoc(reqs: Requirement[]): TestModelDoc {
  const fn = reqs.filter((r) => r.type === 'FUNCTION');
  const ordered = bfsOrder(fn);

  const tcIdBySlug = new Map<string, string>();
  ordered.forEach((r, i) => tcIdBySlug.set(r.slug, tcId('full', i)));

  const header = [
    '# Полная модель тестирования\n',
    `_Сгенерировано автоматически. Охват: все ${fn.length} ФТ, порядок по BFS-обходу дерева. Принципы: Криспин (Agile Testing)._\n`,
  ];
  const blocks = ordered.map((r, i) => {
    const id = tcIdBySlug.get(r.slug)!;
    const parentLink = r.links.find((l) => l.type === 'CHILD_OF');
    const parentTc = parentLink ? (tcIdBySlug.get(parentLink.targetSlug) ?? null) : null;
    const relatedSlugs = r.links
      .filter((l) => l.type === 'RELATES_TO')
      .map((l) => l.targetSlug)
      .join(', ');

    const front = [
      `---`,
      `model: full`,
      `req-slug: ${r.slug}`,
      `req-criticality: ${r.criticality}`,
      `req-implemented: ${r.implemented}`,
      `tc-id: ${id}`,
      `priority: ${i + 1}`,
    ];
    if (parentTc) front.push(`parent-tc: ${parentTc}`);
    front.push(`---\n`);

    const body = [
      `### ${id} · ${r.name}\n`,
      `**Цель:** полная проверка поведения функции во всех режимах.\n`,
      `**Предусловие:** <условие, специфичное для требования>.\n`,
      `**Позитивные сценарии:**`,
      `- [P1] <основной happy-path>`,
      `- [P2] <альтернативный допустимый вход>\n`,
      `**Негативные сценарии:**`,
      `- [N1] <невалидные данные>`,
      `- [N2] <нарушение предусловия>`,
      `- [N3] <граничное значение>\n`,
      `**Граничные случаи:**`,
      `- [B1] <пустое значение / ноль / максимальная длина>\n`,
    ];
    if (relatedSlugs) body.push(`**Связанные требования:** ${relatedSlugs}\n`);
    body.push(`**Ожидаемый результат (P):** операция завершена корректно, данные сохранены.`);
    body.push(
      `**Ожидаемый результат (N):** система отклоняет запрос, не меняет состояние, сообщение понятно.\n`,
    );
    return makeBlock(r.slug, id, r.name, r.name, 'template', front, body);
  });
  return makeDoc(header, blocks);
}

/** Детерминированная сборка по виду модели (развилка «Шаблон»). */
export function buildTemplateDoc(kind: TestModelKind, reqs: Requirement[]): TestModelDoc {
  if (kind === 'smoke') return buildSmokeDoc(reqs);
  if (kind === 'crit-regression') return buildCritRegressionDoc(reqs);
  return buildFullDoc(reqs);
}

// ── AI-сборка ───────────────────────────────────────────────────────────────

/**
 * Сборка md-файла по результатам AI-генерации (развилка «Генерации
 * артефактов»). Формат кейсов совпадает с детерминированным шаблоном
 * (front-matter `model/req-slug/tc-id/priority` + разделы), дополнительно:
 * `source: ai` у кейсов модели и `source: template-fallback` у требований,
 * которые модель пропустила (анти-галлюцинационная проверка вернула их в
 * `missing` — покрытие не теряется). Шапка честно фиксирует счётчики проверки.
 */
export function buildAiDoc(
  kind: TestModelKind,
  ordered: Requirement[],
  cases: ReadonlyMap<string, AiTestCase>,
  meta: AiRunMeta,
): TestModelDoc {
  const header = [
    `# ${KIND_TITLE[kind]}\n`,
    `_Сгенерировано AI (модель: ${meta.model}). Кейсов от модели: ${meta.aiCases}, ` +
      `достроено шаблоном: ${meta.fallbackCases}. Проверка на галлюцинации: ` +
      `отброшено ответов с несуществующей привязкой: ${meta.dropped}. ` +
      `Охват: ${ordered.length} ФТ._\n`,
  ];
  const tcIdBySlug = new Map<string, string>();
  ordered.forEach((r, i) => tcIdBySlug.set(r.slug, tcId(kind, i)));

  const blocks = ordered.map((r, i) => {
    const id = tcIdBySlug.get(r.slug)!;
    const aiCase = cases.get(r.slug);
    const front = [
      `---`,
      `model: ${kind === 'crit-regression' ? 'critical-regression' : kind}`,
      `req-slug: ${r.slug}`,
      `req-criticality: ${r.criticality}`,
      `tc-id: ${id}`,
      `priority: ${i + 1}`,
      `source: ${aiCase ? 'ai' : 'template-fallback'}`,
    ];
    if (kind === 'full') {
      const parentLink = r.links.find((l) => l.type === 'CHILD_OF');
      const parentTc = parentLink ? tcIdBySlug.get(parentLink.targetSlug) : undefined;
      if (parentTc) front.push(`parent-tc: ${parentTc}`);
    }
    front.push(`---\n`);

    const body: string[] = [];
    if (aiCase) {
      body.push(`### ${id} · ${aiCase.title}\n`);
      body.push(`**Требование:** ${r.name}\n`);
      body.push(`**Цель:** ${aiCase.goal}\n`);
      body.push(`**Предусловие:** ${aiCase.precondition}\n`);
      body.push(`**Шаги:**`);
      aiCase.steps.forEach((s, n) => body.push(`${n + 1}. ${s}`));
      body.push(`\n**Ожидаемый результат:** ${aiCase.expected}\n`);
      if (aiCase.negativeSteps && aiCase.negativeSteps.length > 0) {
        body.push(`**Негативный сценарий:**`);
        aiCase.negativeSteps.forEach((s, n) => body.push(`${n + 1}. ${s}`));
        if (aiCase.negativeExpected) {
          body.push(`\n**Ожидаемый результат (негатив):** ${aiCase.negativeExpected}\n`);
        } else {
          body.push('');
        }
      }
    } else {
      // Модель не вернула кейс — детерминированная заглушка шаблонного стиля.
      body.push(`### ${id} · ${r.name}\n`);
      body.push(`**Цель:** проверить, что функция доступна и базово работает.\n`);
      body.push(`**Предусловие:** приложение запущено, проект открыт.\n`);
      body.push(`**Шаги:**`);
      body.push(`1. Выполнить основное действие функции.`);
      body.push(`2. Убедиться, что функция отвечает без ошибок.\n`);
      body.push(`**Ожидаемый результат:** функция работает, данные корректны.\n`);
      if (r.description) body.push(`> ${r.description.split('\n').join('\n> ')}\n`);
    }
    return makeBlock(
      r.slug,
      id,
      aiCase ? aiCase.title : r.name,
      r.name,
      aiCase ? 'ai' : 'template',
      front,
      body,
    );
  });
  return makeDoc(header, blocks);
}

// ── TaskTracker ─────────────────────────────────────────────────────────────

/**
 * Generate a TaskTracker Markdown export for the given requirements.
 * Links whose `targetSlug` is NOT in `includedSlugs` (if provided) are omitted,
 * so cross-references only point to requirements that are part of the export set.
 */
export function buildTrackerDoc(reqs: Requirement[], includedSlugs?: Set<string>): TestModelDoc {
  const exportSet = includedSlugs ?? new Set(reqs.map((r) => r.slug));
  const header = ['# Задачи для TaskTracker\n'];
  const blocks = reqs.map((r) => {
    const front = [
      `---`,
      `slug: ${r.slug}`,
      `type: ${r.type}`,
      `criticality: ${r.criticality}`,
      `implemented: ${r.implemented}`,
    ];
    if (r.targetQuarter) front.push(`targetQuarter: ${r.targetQuarter}`);
    if (r.targetYear) front.push(`targetYear: ${r.targetYear}`);
    front.push(`---\n`);

    const body = [`## ${r.name}\n`];
    if (r.description) body.push(`${r.description}\n`);
    const visibleLinks = r.links.filter((l) => exportSet.has(l.targetSlug));
    if (visibleLinks.length > 0) {
      body.push(`**Связи:**`);
      for (const l of visibleLinks) body.push(`- ${l.type}: ${l.targetSlug}`);
      body.push('');
    }
    return makeBlock(r.slug, r.slug, r.name, r.name, 'template', front, body);
  });
  return makeDoc(header, blocks);
}

// ── Обратно совместимые обёртки (тот же md, что и раньше) ───────────────────

export function generateSmoke(reqs: Requirement[], _nameBySlug?: Map<string, string>): string {
  return buildSmokeDoc(reqs).md;
}

export function generateCritRegression(
  reqs: Requirement[],
  _nameBySlug?: Map<string, string>,
): string {
  return buildCritRegressionDoc(reqs).md;
}

export function generateFull(reqs: Requirement[], _nameBySlug?: Map<string, string>): string {
  return buildFullDoc(reqs).md;
}

export function generateTracker(reqs: Requirement[], includedSlugs?: Set<string>): string {
  return buildTrackerDoc(reqs, includedSlugs).md;
}

export function assembleAiTestModel(
  kind: TestModelKind,
  ordered: Requirement[],
  cases: ReadonlyMap<string, AiTestCase>,
  meta: AiRunMeta,
): string {
  return buildAiDoc(kind, ordered, cases, meta).md;
}
