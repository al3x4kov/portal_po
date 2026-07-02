import { useState, useMemo } from 'react';
import type { Requirement } from '@po/core';
import { Modal } from './Modal';

interface ExportTasksModalProps {
  projectId: string;
  requirements: Requirement[];
  onClose: () => void;
}

type Direction = 'tracker' | 'smoke' | 'crit-regression' | 'full';
type Step = 'choose' | 'select' | 'preview';

const DIRECTION_INFO: Record<Direction, { title: string; icon: string; description: string }> = {
  tracker: {
    title: 'Задачи в TaskTracker',
    icon: '📋',
    description: 'Выбранные требования как задачи в формате OpenSpec Markdown',
  },
  smoke: {
    title: 'Smoke-модель тестирования',
    icon: '🔥',
    description: 'Тест-кейсы для быстрой проверки ключевых функций (BLOCKER/CRITICAL/HIGH + корни)',
  },
  'crit-regression': {
    title: 'Крит. регресс-модель',
    icon: '⚡',
    description: 'Тест-кейсы для Blocker/Critical ФТ с негативными сценариями',
  },
  full: {
    title: 'Полная модель тестирования',
    icon: '📚',
    description: 'Тест-кейсы для всех ФТ, порядок по BFS-обходу дерева',
  },
};

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
function generateSmoke(reqs: Requirement[], _nameBySlug: Map<string, string>): string {
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
function generateCritRegression(reqs: Requirement[], _nameBySlug: Map<string, string>): string {
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
function generateFull(reqs: Requirement[], _nameBySlug: Map<string, string>): string {
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
function generateTracker(reqs: Requirement[]): string {
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
    if (r.links.length > 0) {
      lines.push(`**Связи:**`);
      for (const l of r.links) {
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

  function handleDirection(dir: Direction): void {
    setDirection(dir);
    if (dir === 'tracker') {
      // tracker reuses ExportModal for selection, then shows preview
      setShowSelectModal(true);
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
    const md = generateTracker(reqs);
    setPreviewMd(md);
    setPreviewTitle(DIRECTION_INFO.tracker.title);
    setShowSelectModal(false);
    setStep('preview');
  }

  if (showSelectModal && direction === 'tracker') {
    return (
      <TrackerSelectModal
        requirements={requirements}
        onClose={() => {
          setShowSelectModal(false);
          setDirection(null);
        }}
        onConfirm={handleTrackerSelected}
      />
    );
  }

  const footer =
    step === 'choose' ? (
      <button type="button" className="btn btn-secondary" onClick={onClose}>
        Закрыть
      </button>
    ) : (
      <>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setStep('choose');
            setDirection(null);
            setPreviewMd(null);
          }}
        >
          ← Назад
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="export-tasks-download"
          onClick={() => {
            if (previewMd) {
              const slug = direction ?? 'export';
              downloadMd(previewMd, `${slug}-${new Date().toISOString().slice(0, 10)}.md`);
            }
          }}
        >
          Скачать MD
        </button>
      </>
    );

  return (
    <Modal
      title="Экспорт задач"
      onClose={onClose}
      widthClass={step === 'preview' ? 'max-w-4xl' : 'max-w-lg'}
      testid="export-tasks-modal"
      footer={footer}
    >
      {step === 'choose' ? (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: 'var(--color-text-2)' }}>
            Выберите тип экспорта:
          </p>
          {(Object.keys(DIRECTION_INFO) as Direction[]).map((dir) => {
            const info = DIRECTION_INFO[dir];
            return (
              <button
                key={dir}
                type="button"
                className="flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:border-[var(--color-primary)]"
                style={{ borderColor: 'var(--color-border)' }}
                data-testid={`export-tasks-dir-${dir}`}
                onClick={() => handleDirection(dir)}
              >
                <span className="text-2xl" aria-hidden="true">
                  {info.icon}
                </span>
                <div>
                  <p className="font-semibold">{info.title}</p>
                  <p className="mt-0.5 text-sm" style={{ color: 'var(--color-text-3)' }}>
                    {info.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        /* Preview */
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-semibold">{previewTitle}</p>
            <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
              Предпросмотр MD-файла
            </span>
          </div>
          <div
            className="max-h-[55vh] overflow-y-auto rounded-lg border p-4 font-mono text-xs leading-relaxed"
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

// ── Tracker selection sub-modal ──────────────────────────────────────────────
interface TrackerSelectModalProps {
  requirements: Requirement[];
  onClose: () => void;
  onConfirm: (selected: Set<string>) => void;
}

function TrackerSelectModal({
  requirements,
  onClose,
  onConfirm,
}: TrackerSelectModalProps): React.ReactElement {
  const [selected, setSelected] = useState<Set<string>>(new Set(requirements.map((r) => r.slug)));

  const allSelected = requirements.length > 0 && requirements.every((r) => selected.has(r.slug));

  function toggleAll(): void {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(requirements.map((r) => r.slug)));
    }
  }

  const footer = (
    <>
      <button type="button" className="btn btn-secondary" onClick={onClose}>
        Отменить
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={selected.size === 0}
        data-testid="tracker-select-confirm"
        onClick={() => onConfirm(selected)}
      >
        Предпросмотр ({selected.size})
      </button>
    </>
  );

  return (
    <Modal
      title="Выбор ФТ/НФТ для TaskTracker"
      onClose={onClose}
      widthClass="max-w-xl"
      testid="tracker-select-modal"
      footer={footer}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="text-xs underline"
            style={{ color: 'var(--color-primary)' }}
            onClick={toggleAll}
            data-testid="tracker-toggle-all"
          >
            {allSelected ? 'Снять выделение' : 'Выбрать все'}
          </button>
          <span className="text-xs" style={{ color: 'var(--color-text-3)' }}>
            {selected.size} из {requirements.length}
          </span>
        </div>
        <div
          className="max-h-72 space-y-1 overflow-y-auto rounded-lg border p-2"
          style={{ borderColor: 'var(--color-border)' }}
        >
          {requirements.map((r) => (
            <label
              key={r.slug}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-[var(--color-surface-2)]"
            >
              <input
                type="checkbox"
                className="mt-0.5 flex-none"
                checked={selected.has(r.slug)}
                onChange={() => {
                  setSelected((s) => {
                    const next = new Set(s);
                    if (next.has(r.slug)) next.delete(r.slug);
                    else next.add(r.slug);
                    return next;
                  });
                }}
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{r.name}</p>
                <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>
                  {r.type === 'FUNCTION' ? 'ФТ' : 'НФТ'} · {r.criticality}
                </p>
              </div>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
