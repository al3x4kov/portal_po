import { useState, useMemo } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Check,
  Download,
  Flame,
  ListTodo,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { Requirement } from '@po/core';
import { Modal } from './Modal';
import { RequirementPickerModal } from './RequirementPickerModal';

interface ExportTasksModalProps {
  projectId: string;
  requirements: Requirement[];
  onClose: () => void;
}

type Direction = 'tracker' | 'smoke' | 'crit-regression' | 'full';
type Step = 'choose' | 'select' | 'unimpl-question' | 'preview';

const DIRECTION_INFO: Record<
  Direction,
  { title: string; icon: LucideIcon; iconColor: string; description: string }
> = {
  tracker: {
    title: 'Задачи в TaskTracker',
    icon: ListTodo,
    iconColor: 'var(--color-primary)',
    description: 'Выбранные требования как задачи в формате OpenSpec Markdown',
  },
  smoke: {
    title: 'Smoke-модель тестирования',
    icon: Flame,
    iconColor: 'var(--crit-high)',
    description:
      'Тест-кейсы быстрой проверки ключевых функций (Блокер/Критическая/Высокая + корни дерева)',
  },
  'crit-regression': {
    title: 'Критическая регресс-модель',
    icon: Zap,
    iconColor: 'var(--crit-critical)',
    description: 'Тест-кейсы для ФТ уровня Блокер/Критическая с негативными сценариями',
  },
  full: {
    title: 'Полная модель тестирования',
    icon: BookOpen,
    iconColor: 'var(--color-accent)',
    description: 'Тест-кейсы для всех ФТ, порядок по BFS-обходу дерева',
  },
};

/** §2.15.1 · step indicator «1 Направление → 2 Выбор → 3 Предпросмотр». */
function StepIndicator({ current }: { current: 1 | 2 | 3 }): React.ReactElement {
  const steps = [
    { n: 1 as const, label: 'Направление' },
    { n: 2 as const, label: 'Выбор' },
    { n: 3 as const, label: 'Предпросмотр' },
  ];
  return (
    <ol
      className="flex items-center gap-2 text-sm"
      aria-label="Шаги генерации"
      data-testid="gen-steps"
    >
      {steps.flatMap((s, i) => {
        const done = s.n < current;
        const active = s.n === current;
        const items: React.ReactElement[] = [];
        if (i > 0) {
          items.push(
            <li
              key={`sep-${s.n}`}
              className="w-6 border-t sm:w-8"
              style={{ borderColor: 'var(--color-border)' }}
              aria-hidden="true"
            />,
          );
        }
        items.push(
          <li
            key={s.n}
            className="flex items-center gap-2"
            aria-current={active ? 'step' : undefined}
            data-testid={`gen-step-${s.n}`}
            data-state={done ? 'done' : active ? 'active' : 'todo'}
          >
            <span
              className="grid h-6 w-6 flex-none place-items-center rounded-full text-xs font-bold"
              style={
                done
                  ? { background: 'var(--color-success-bg)', color: 'var(--color-success-fg)' }
                  : active
                    ? { background: 'var(--color-primary)', color: '#fff' }
                    : { background: 'var(--color-surface-2)', color: 'var(--color-text-3)' }
              }
              aria-label={done ? `Шаг ${s.n} пройден` : undefined}
            >
              {done ? <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" /> : s.n}
            </span>
            <span
              className={active ? 'font-medium' : 'hidden sm:inline'}
              style={active ? undefined : { color: 'var(--color-text-3)' }}
            >
              {s.label}
            </span>
          </li>,
        );
        return items;
      })}
    </ol>
  );
}

// ─── MD generators ─────────────────────────────────────────────────────────

/** Build slug→Requirement map from list. */
function indexBySlug(reqs: Requirement[]): Map<string, Requirement> {
  return new Map(reqs.map((r) => [r.slug, r]));
}

/** True if the requirement has a CHILD_OF link (has a parent). */
function hasParent(r: Requirement): boolean {
  return r.links.some((l) => l.type === 'CHILD_OF');
}

/** Number of PARENT_OF links (direct children count). */
function childCount(r: Requirement): number {
  return r.links.filter((l) => l.type === 'PARENT_OF').length;
}

/** BFS traversal order over PARENT_OF links, roots first. */
function bfsOrder(reqs: Requirement[]): Requirement[] {
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

// ── Smoke generator ─────────────────────────────────────────────────────────
export function generateSmoke(reqs: Requirement[], _nameBySlug: Map<string, string>): string {
  const fn = reqs.filter((r) => r.type === 'FUNCTION');
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

  const lines: string[] = [
    '# Smoke-модель тестирования\n',
    `_Сгенерировано автоматически. Принципы: Криспин (Agile Testing). Охват: ${included.length} из ${fn.length} ФТ._\n`,
  ];

  included.forEach((r, i) => {
    const id = `SMK-${String(i + 1).padStart(3, '0')}`;
    lines.push(`---`);
    lines.push(`model: smoke`);
    lines.push(`req-slug: ${r.slug}`);
    lines.push(`req-criticality: ${r.criticality}`);
    lines.push(`tc-id: ${id}`);
    lines.push(`priority: ${i + 1}`);
    lines.push(`---\n`);
    lines.push(`### ${id} · ${r.name}\n`);
    lines.push(`**Цель:** убедиться, что ключевая функция доступна и базово работает.\n`);
    lines.push(`**Предусловие:** приложение запущено, проект открыт.\n`);
    lines.push(`**Шаги:**`);
    lines.push(`1. Открыть раздел / выполнить минимальное действие, соответствующее функции.`);
    lines.push(`2. Убедиться, что функция отвечает без ошибок (нет 4xx/5xx).`);
    lines.push(`3. Убедиться, что результат визуально присутствует в UI.\n`);
    lines.push(`**Ожидаемый результат:** функция доступна, данные отображены без ошибок.\n`);
    lines.push(`**Время выполнения:** ≤ 2 мин.\n`);
    if (r.description) {
      lines.push(`> ${r.description.split('\n').join('\n> ')}\n`);
    }
  });

  return lines.join('\n');
}

// ── Critical Regression generator ───────────────────────────────────────────
export function generateCritRegression(
  reqs: Requirement[],
  _nameBySlug: Map<string, string>,
): string {
  const fn = reqs.filter((r) => r.type === 'FUNCTION');
  const included = fn.filter(
    (r) => ['BLOCKER', 'CRITICAL'].includes(r.criticality) || !r.implemented || childCount(r) >= 3,
  );
  included.sort((a, b) => {
    const ca = CRIT_ORDER[a.criticality] ?? 9;
    const cb = CRIT_ORDER[b.criticality] ?? 9;
    if (ca !== cb) return ca - cb;
    if (childCount(b) !== childCount(a)) return childCount(b) - childCount(a);
    if (a.implemented !== b.implemented) return a.implemented ? 1 : -1;
    return 0;
  });

  const lines: string[] = [
    '# Критический регресс-модель тестирования\n',
    `_Сгенерировано автоматически. Охват: BLOCKER/CRITICAL ФТ + широкие узлы (≥3 детей) + не реализованные. ${included.length} из ${fn.length} ФТ._\n`,
  ];

  included.forEach((r, i) => {
    const id = `CRG-${String(i + 1).padStart(3, '0')}`;
    const children = r.links.filter((l) => l.type === 'PARENT_OF').map((l) => l.targetSlug);
    lines.push(`---`);
    lines.push(`model: critical-regression`);
    lines.push(`req-slug: ${r.slug}`);
    lines.push(`req-criticality: ${r.criticality}`);
    lines.push(`tc-id: ${id}`);
    lines.push(`priority: ${i + 1}`);
    if (children.length > 0) {
      lines.push(`covers-children:`);
      for (const c of children) lines.push(`  - ${c}`);
    }
    lines.push(`---\n`);
    lines.push(`### ${id} · ${r.name}\n`);
    lines.push(`**Цель:** проверить, что вся функциональная ветка работает корректно.\n`);
    lines.push(`**Предусловие:** чистое состояние, все дочерние функции доступны.\n`);
    lines.push(`**Позитивный сценарий:**`);
    lines.push(`1. Выполнить основное действие функции.`);
    if (children.length > 0) {
      lines.push(
        `2. Выполнить основное действие минимум одной дочерней функции из covers-children.`,
      );
    }
    lines.push(`\n**Негативный сценарий:**`);
    lines.push(`1. Передать невалидные данные / нарушить предусловие.`);
    lines.push(`2. Проверить граничное значение (минимум одно).\n`);
    lines.push(
      `**Ожидаемый результат (позитив):** операция завершена, данные сохранены/отображены корректно.`,
    );
    lines.push(
      `**Ожидаемый результат (негатив):** система возвращает понятную ошибку, состояние не повреждено.\n`,
    );
  });

  return lines.join('\n');
}

// ── Full model generator ─────────────────────────────────────────────────────
export function generateFull(reqs: Requirement[], _nameBySlug: Map<string, string>): string {
  const fn = reqs.filter((r) => r.type === 'FUNCTION');
  const ordered = bfsOrder(fn);

  const tcIdBySlug = new Map<string, string>();
  ordered.forEach((r, i) => {
    tcIdBySlug.set(r.slug, `FUL-${String(i + 1).padStart(3, '0')}`);
  });

  const lines: string[] = [
    '# Полная модель тестирования\n',
    `_Сгенерировано автоматически. Охват: все ${fn.length} ФТ, порядок по BFS-обходу дерева. Принципы: Криспин (Agile Testing)._\n`,
  ];

  ordered.forEach((r, i) => {
    const id = tcIdBySlug.get(r.slug)!;
    const parentLink = r.links.find((l) => l.type === 'CHILD_OF');
    const parentTc = parentLink ? (tcIdBySlug.get(parentLink.targetSlug) ?? null) : null;
    const relatedSlugs = r.links
      .filter((l) => l.type === 'RELATES_TO')
      .map((l) => l.targetSlug)
      .join(', ');

    lines.push(`---`);
    lines.push(`model: full`);
    lines.push(`req-slug: ${r.slug}`);
    lines.push(`req-criticality: ${r.criticality}`);
    lines.push(`req-implemented: ${r.implemented}`);
    lines.push(`tc-id: ${id}`);
    lines.push(`priority: ${i + 1}`);
    if (parentTc) lines.push(`parent-tc: ${parentTc}`);
    lines.push(`---\n`);
    lines.push(`### ${id} · ${r.name}\n`);
    lines.push(`**Цель:** полная проверка поведения функции во всех режимах.\n`);
    lines.push(`**Предусловие:** <условие, специфичное для требования>.\n`);
    lines.push(`**Позитивные сценарии:**`);
    lines.push(`- [P1] <основной happy-path>`);
    lines.push(`- [P2] <альтернативный допустимый вход>\n`);
    lines.push(`**Негативные сценарии:**`);
    lines.push(`- [N1] <невалидные данные>`);
    lines.push(`- [N2] <нарушение предусловия>`);
    lines.push(`- [N3] <граничное значение>\n`);
    lines.push(`**Граничные случаи:**`);
    lines.push(`- [B1] <пустое значение / ноль / максимальная длина>\n`);
    if (relatedSlugs) {
      lines.push(`**Связанные требования:** ${relatedSlugs}\n`);
    }
    lines.push(`**Ожидаемый результат (P):** операция завершена корректно, данные сохранены.`);
    lines.push(
      `**Ожидаемый результат (N):** система отклоняет запрос, не меняет состояние, сообщение понятно.\n`,
    );
  });

  return lines.join('\n');
}

// ── TaskTracker generator ────────────────────────────────────────────────────
/**
 * Generate a TaskTracker Markdown export for the given requirements.
 * Links whose `targetSlug` is NOT in `includedSlugs` (if provided) are omitted,
 * so cross-references only point to requirements that are part of the export set.
 */
export function generateTracker(reqs: Requirement[], includedSlugs?: Set<string>): string {
  const exportSet = includedSlugs ?? new Set(reqs.map((r) => r.slug));
  const lines: string[] = ['# Задачи для TaskTracker\n'];
  for (const r of reqs) {
    lines.push(`---`);
    lines.push(`slug: ${r.slug}`);
    lines.push(`type: ${r.type}`);
    lines.push(`criticality: ${r.criticality}`);
    lines.push(`implemented: ${r.implemented}`);
    if (r.targetQuarter) lines.push(`targetQuarter: ${r.targetQuarter}`);
    if (r.targetYear) lines.push(`targetYear: ${r.targetYear}`);
    lines.push(`---\n`);
    lines.push(`## ${r.name}\n`);
    if (r.description) lines.push(`${r.description}\n`);
    const visibleLinks = r.links.filter((l) => exportSet.has(l.targetSlug));
    if (visibleLinks.length > 0) {
      lines.push(`**Связи:**`);
      for (const l of visibleLinks) {
        lines.push(`- ${l.type}: ${l.targetSlug}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ExportTasksModal({
  projectId: _projectId,
  requirements,
  onClose,
}: ExportTasksModalProps): React.ReactElement {
  const [step, setStep] = useState<Step>('choose');
  const [direction, setDirection] = useState<Direction | null>(null);
  const [showSelectModal, setShowSelectModal] = useState(false);
  const [previewMd, setPreviewMd] = useState<string | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');

  const nameBySlug = useMemo(
    () => new Map(requirements.map((r) => [r.slug, r.name])),
    [requirements],
  );

  // T-532: how many unimplemented FTs the covering question is about.
  const unimplCount = useMemo(
    () => requirements.filter((r) => r.type === 'FUNCTION' && !r.implemented).length,
    [requirements],
  );

  function handleDirection(dir: Direction): void {
    setDirection(dir);
    if (dir === 'tracker') {
      // tracker reuses ExportModal for selection, then shows preview
      setShowSelectModal(true);
    } else if (
      dir === 'crit-regression' &&
      requirements.some((r) => r.type === 'FUNCTION' && !r.implemented)
    ) {
      // T-532: ask whether to include unimplemented FTs
      setStep('unimpl-question');
    } else {
      // generate immediately
      const md = generateMd(dir);
      setPreviewMd(md);
      setPreviewTitle(DIRECTION_INFO[dir].title);
      setStep('preview');
    }
  }

  function generateMd(dir: Direction, reqs: Requirement[] = requirements): string {
    if (dir === 'smoke') return generateSmoke(reqs, nameBySlug);
    if (dir === 'crit-regression') return generateCritRegression(reqs, nameBySlug);
    if (dir === 'full') return generateFull(reqs, nameBySlug);
    return generateTracker(reqs);
  }

  function downloadMd(content: string, filename: string): void {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Tracker: after requirement selection in ExportModal, generate the MD
  function handleTrackerSelected(selected: Set<string>): void {
    const reqs = requirements.filter((r) => selected.has(r.slug));
    const md = generateTracker(reqs, selected);
    setPreviewMd(md);
    setPreviewTitle(DIRECTION_INFO.tracker.title);
    setShowSelectModal(false);
    setStep('preview');
  }

  // T-532: crit-regression with unimpl question answer
  function handleUnimplAnswer(includeUnimpl: boolean): void {
    const reqs = includeUnimpl
      ? requirements
      : requirements.filter((r) => r.type !== 'FUNCTION' || r.implemented);
    const md = generateCritRegression(reqs, nameBySlug);
    setPreviewMd(md);
    setPreviewTitle(DIRECTION_INFO['crit-regression'].title);
    setStep('preview');
  }

  // §2.15.1: «Назад» from the preview returns to the PREVIOUS step, not always
  // to the direction choice.
  function goBackFromPreview(): void {
    setPreviewMd(null);
    if (direction === 'tracker') {
      setStep('select');
      setShowSelectModal(true);
    } else if (direction === 'crit-regression' && unimplCount > 0) {
      setStep('unimpl-question');
    } else {
      setStep('choose');
      setDirection(null);
    }
  }

  if (showSelectModal && direction === 'tracker') {
    return (
      <RequirementPickerModal
        title="Выбор требований для экспорта"
        requirements={requirements}
        modalTestid="tracker-select-modal"
        confirmLabel="Предпросмотр"
        onClose={() => {
          setShowSelectModal(false);
          setStep('choose');
          setDirection(null);
        }}
        onConfirm={handleTrackerSelected}
      />
    );
  }

  const filename = `${direction ?? 'export'}-${new Date().toISOString().slice(0, 10)}.md`;

  const backButton = (testid: string): React.ReactElement => (
    <button
      type="button"
      className="btn btn-secondary"
      data-testid={testid}
      onClick={
        step === 'preview'
          ? goBackFromPreview
          : () => {
              setStep('choose');
              setDirection(null);
            }
      }
    >
      <ArrowLeft className="icon-sm" aria-hidden="true" />
      Назад
    </button>
  );

  const footer =
    step === 'choose' ? (
      <button type="button" className="btn btn-secondary" onClick={onClose}>
        Закрыть
      </button>
    ) : step === 'unimpl-question' ? (
      <div className="mr-auto">{backButton('gen-back-1')}</div>
    ) : (
      <>
        <div className="mr-auto">{backButton('gen-back-2')}</div>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="export-tasks-download"
          onClick={() => {
            if (previewMd) downloadMd(previewMd, filename);
          }}
        >
          <Download className="icon-sm" aria-hidden="true" />
          Скачать .md
        </button>
      </>
    );

  const currentStepNo: 1 | 2 | 3 = step === 'choose' ? 1 : step === 'preview' ? 3 : 2;

  return (
    <Modal
      title="Генерация артефактов"
      onClose={onClose}
      widthClass={step === 'preview' ? 'max-w-4xl' : 'max-w-lg'}
      testid="export-tasks-modal"
      footer={footer}
    >
      <StepIndicator current={currentStepNo} />

      {step === 'choose' ? (
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
            Что сгенерировать из требований проекта?
          </p>
          <div className="space-y-2.5">
            {(Object.keys(DIRECTION_INFO) as Direction[]).map((dir) => {
              const info = DIRECTION_INFO[dir];
              const Icon = info.icon;
              return (
                <button
                  key={dir}
                  type="button"
                  className="flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]"
                  style={{ borderColor: 'var(--color-border)' }}
                  data-testid={`export-tasks-dir-${dir}`}
                  onClick={() => handleDirection(dir)}
                >
                  <Icon
                    className="icon mt-0.5"
                    style={{ color: info.iconColor }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{info.title}</span>
                    <span className="mt-0.5 block text-xs" style={{ color: 'var(--color-text-3)' }}>
                      {info.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : step === 'unimpl-question' ? (
        /* T-532: ask about including unimplemented FTs in crit-regression */
        <div className="space-y-4" data-testid="unimpl-question">
          <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
            Направление: <strong>{direction ? DIRECTION_INFO[direction].title : ''}</strong>.
          </p>
          <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
            Нереализованных ФТ в проекте: <strong>{unimplCount}</strong>. Включить их в модель
            тестирования?
          </p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="btn btn-primary"
              data-testid="unimpl-include-yes"
              onClick={() => handleUnimplAnswer(true)}
            >
              Да — включить нереализованные ФТ
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="unimpl-include-no"
              onClick={() => handleUnimplAnswer(false)}
            >
              Нет — только реализованные
            </button>
          </div>
        </div>
      ) : (
        /* Preview */
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">{previewTitle}</p>
            <span
              className="text-xs"
              style={{ color: 'var(--color-text-3)' }}
              data-testid="export-tasks-filename"
            >
              {filename}
            </span>
          </div>
          <div
            className="max-h-[50vh] overflow-y-auto rounded-lg border p-4 font-mono text-xs leading-relaxed"
            style={{
              borderColor: 'var(--color-border)',
              background: 'var(--color-surface-2)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
            data-testid="export-tasks-preview"
          >
            {previewMd}
          </div>
        </div>
      )}
    </Modal>
  );
}
