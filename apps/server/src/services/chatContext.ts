import {
  AI_CHAT_CONTEXT_CHAR_BUDGET,
  AI_CHAT_CONTEXT_DESC_CHARS,
  AI_CHAT_CONTEXT_TOP_K,
  type Criticality,
  type Requirement,
} from '@po/core';
import { normalizeRequirementName } from './aiImport/dedupe.js';

/**
 * Контекст требований проекта для чат-виджета (переключатель «Учитывать
 * требования проекта»). Проект может держать и 10–15, и 1000–2000 ФТ/НФТ,
 * поэтому блок строится ДЕТЕРМИНИРОВАННО под символьный бюджет
 * ({@link AI_CHAT_CONTEXT_CHAR_BUDGET}) без дополнительных AI-вызовов:
 *
 * - режим `full` — все требования с деталями помещаются в бюджет (малые
 *   проекты): полный список в порядке дерева;
 * - режим `partial` — большой проект: топ-{@link AI_CHAT_CONTEXT_TOP_K}
 *   релевантных вопросу требований с полными деталями (лексический скоринг
 *   по нормализованным токенам вопроса) + обзор дерева именами, пока
 *   остаётся бюджет; обрезка всегда названа явно («…и ещё N»).
 */

const CRIT_RU: Record<Criticality, string> = {
  LOW: 'низкая',
  MEDIUM: 'средняя',
  HIGH: 'высокая',
  CRITICAL: 'критическая',
  BLOCKER: 'блокер',
};

/** Частые русские/английские служебные слова — не несут релевантности. */
const STOPWORDS = new Set([
  'как',
  'какой',
  'какая',
  'какие',
  'что',
  'чем',
  'это',
  'этот',
  'для',
  'при',
  'про',
  'или',
  'если',
  'есть',
  'нет',
  'все',
  'всё',
  'наш',
  'мой',
  'можно',
  'нужно',
  'надо',
  'быть',
  'будет',
  'требование',
  'требования',
  'требований',
  'проект',
  'проекта',
  'проекте',
  'the',
  'and',
  'for',
  'what',
  'how',
  'with',
]);

/** Токены вопроса: нормализация как в дедупликации, ≥3 символов, без стоп-слов. */
export function questionTokens(question: string): string[] {
  return [
    ...new Set(
      normalizeRequirementName(question)
        .split(' ')
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ),
  ];
}

interface Scored {
  req: Requirement;
  score: number;
}

/**
 * Лексическая релевантность требования вопросу: вхождение токена в имя
 * весит втрое дороже вхождения в описание (имя — самый сильный сигнал).
 * Чистая эвристика без эмбеддингов — детерминированно и бесплатно.
 */
export function scoreRequirement(req: Requirement, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  const name = normalizeRequirementName(req.name);
  const desc = normalizeRequirementName(req.description ?? '');
  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 3;
    else if (desc.includes(token)) score += 1;
  }
  return score;
}

/** parent-имя по CHILD_OF (первая по порядку связь; slug → имя через карту). */
function parentNameOf(req: Requirement, nameBySlug: ReadonlyMap<string, string>): string | null {
  const child = req.links.find((l) => l.type === 'CHILD_OF');
  return child ? (nameBySlug.get(child.targetSlug) ?? null) : null;
}

/** Одна строка полного описания требования в контекстном блоке. */
function detailLine(req: Requirement, nameBySlug: ReadonlyMap<string, string>): string {
  const type = req.type === 'FUNCTION' ? 'ФТ' : 'НФТ';
  const status = req.implemented
    ? 'реализовано'
    : `план ${req.targetQuarter ?? '?'} ${req.targetYear ?? '?'}`;
  const parent = parentNameOf(req, nameBySlug);
  const desc = (req.description ?? '').replace(/\s+/g, ' ').trim();
  const short =
    desc.length > AI_CHAT_CONTEXT_DESC_CHARS
      ? `${desc.slice(0, AI_CHAT_CONTEXT_DESC_CHARS - 1)}…`
      : desc;
  return (
    `- [${type} · ${CRIT_RU[req.criticality]} · ${status}] «${req.name}»` +
    (parent ? ` (родитель: «${parent}»)` : '') +
    (short ? ` — ${short}` : '')
  );
}

/** Однострочный элемент обзора дерева (имя + маркеры, без описания). */
function overviewLine(req: Requirement, depth: number): string {
  const type = req.type === 'FUNCTION' ? 'ФТ' : 'НФТ';
  const impl = req.implemented ? '' : ' · план';
  return `${'  '.repeat(depth)}- [${type}${impl}] ${req.name}`;
}

/**
 * Порядок дерева: корни, затем дети (DFS) по CHILD_OF; узлы с недостижимым
 * родителем и циклы безопасно попадают в конец списком (seen-guard).
 */
function treeOrder(
  requirements: readonly Requirement[],
): Array<{ req: Requirement; depth: number }> {
  const bySlug = new Map(requirements.map((r) => [r.slug, r]));
  const children = new Map<string, Requirement[]>();
  const roots: Requirement[] = [];
  for (const req of requirements) {
    const parent = req.links.find((l) => l.type === 'CHILD_OF')?.targetSlug;
    if (parent !== undefined && bySlug.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(req);
      children.set(parent, list);
    } else {
      roots.push(req);
    }
  }
  const out: Array<{ req: Requirement; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (req: Requirement, depth: number): void => {
    if (seen.has(req.slug)) return;
    seen.add(req.slug);
    out.push({ req, depth });
    for (const child of children.get(req.slug) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  // Узлы, не достижимые из корней (цикл CHILD_OF в битых данных) — в конец.
  for (const req of requirements) visit(req, 0);
  return out;
}

export interface ChatProjectContext {
  /** Готовый текст блока для system-подсказки. */
  text: string;
  /** full — все требования с деталями; partial — выборка + обзор дерева. */
  mode: 'full' | 'partial';
}

/**
 * Построить контекстный блок требований проекта под символьный бюджет.
 * `question` — склейка user-сообщений диалога (последние — самые важные для
 * релевантности). Чистая функция; бюджет переопределяется только в тестах.
 */
export function buildChatProjectContext(
  requirements: readonly Requirement[],
  question: string,
  budget: number = AI_CHAT_CONTEXT_CHAR_BUDGET,
): ChatProjectContext {
  const fn = requirements.filter((r) => r.type === 'FUNCTION').length;
  const nfr = requirements.length - fn;
  if (requirements.length === 0) {
    return { text: 'В проекте пока не зафиксировано ни одного требования.', mode: 'full' };
  }

  const nameBySlug = new Map(requirements.map((r) => [r.slug, r.name]));
  const ordered = treeOrder(requirements);
  const header = `Требования проекта: всего ${requirements.length} (ФТ ${fn}, НФТ ${nfr}).`;

  // ── Режим full: весь проект с деталями помещается в бюджет ──
  const fullLines = ordered.map(({ req }) => detailLine(req, nameBySlug));
  const fullText = [header, 'Полный список:', ...fullLines].join('\n');
  if (fullText.length <= budget) {
    return { text: fullText, mode: 'full' };
  }

  // ── Режим partial: релевантная выборка + обзор дерева под бюджет ──
  const tokens = questionTokens(question);
  const relevant: Scored[] = requirements
    .map((req) => ({ req, score: scoreRequirement(req, tokens) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, AI_CHAT_CONTEXT_TOP_K);

  const parts: string[] = [
    header,
    'Проект большой — ниже ЧАСТИЧНЫЙ контекст: релевантные вопросу требования с деталями и обзор дерева именами.',
  ];
  if (relevant.length > 0) {
    parts.push(`Релевантные вопросу требования (${relevant.length}):`);
    for (const { req } of relevant) parts.push(detailLine(req, nameBySlug));
  } else {
    parts.push('По формулировке вопроса релевантные требования не найдены — см. обзор дерева.');
  }

  // Релевантные требования из обзора не исключаются — дерево остаётся связным.
  parts.push('Обзор дерева требований (имена):');
  let used = parts.join('\n').length;
  let shown = 0;
  const omittedSuffix = (): string =>
    `  …и ещё ${ordered.length - shown} требований за пределами бюджета.`;
  for (const { req, depth } of ordered) {
    const line = overviewLine(req, depth);
    // Резерв под строку «…и ещё N» — обрезка никогда не бывает молчаливой.
    if (used + line.length + 1 > budget - 60) break;
    parts.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown < ordered.length) parts.push(omittedSuffix());

  return { text: parts.join('\n'), mode: 'partial' };
}
