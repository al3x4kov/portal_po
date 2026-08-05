import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  BookOpen,
  Check,
  Download,
  FileText,
  Flame,
  ListTodo,
  Play,
  RefreshCw,
  RotateCw,
  Sparkles,
  Square,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { AI_TESTGEN_BATCH, type AiTestCase, type Requirement, type TestModelKind } from '@po/core';
import { aiApi } from '../api/endpoints';
import { useAiConfig, useAiModelsRefresh, useProject, useRequirements } from '../api/hooks';
import { RequirementPicker } from '../components/RequirementPicker';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  AsideActions,
  AsideTitle,
  Banner,
  WorkspaceAside,
  WorkspaceScreen,
} from '../components/WorkspaceScreen';
import {
  buildAiDoc,
  buildTemplateDoc,
  buildTrackerDoc,
  KIND_RULES,
  KIND_TITLE,
  selectForKind,
  type TestModelDoc,
} from '../lib/testModels';

type Direction = 'tracker' | 'smoke' | 'crit-regression' | 'full';
type Step = 'direction' | 'select' | 'mode' | 'result';
/** Развилка тестовых моделей: детерминированный шаблон или AI-генерация. */
type GenMode = 'template' | 'ai';
/** Состояние AI-прогона: он же управляет содержимым экрана «Результат». */
type RunStatus = 'idle' | 'running' | 'stopped' | 'error' | 'done';

/** One line of the AI-generation work log (role="log"). */
interface AiLogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
}

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

const DIRECTIONS = Object.keys(DIRECTION_INFO) as Direction[];

/** Пример структуры файла для панели «Что вы получите» (макет Г1). */
const KIND_SAMPLE: Record<TestModelKind, string> = {
  smoke: `---
model: smoke
req-slug: <slug>
tc-id: SMK-001
priority: 1
---
### SMK-001 · <имя требования>
**Цель:** функция доступна и базово работает…
**Шаги:** 1. Открыть раздел… 2. Убедиться…
**Время выполнения:** ≤ 2 мин.`,
  'crit-regression': `---
model: critical-regression
req-slug: <slug>
tc-id: CRG-001
covers-children:
  - <slug ребёнка>
---
### CRG-001 · <имя требования>
**Позитивный сценарий:** 1. …
**Негативный сценарий:** 1. …`,
  full: `---
model: full
req-slug: <slug>
tc-id: FUL-001
parent-tc: FUL-000
---
### FUL-001 · <имя требования>
**Позитивные сценарии:** [P1] … [P2] …
**Негативные сценарии:** [N1] … [N2] … [N3] …
**Граничные случаи:** [B1] …`,
};

/** Вертикальный степпер слева (макеты Г1–Г10). */
function Stepper({
  steps,
}: {
  steps: Array<{ label: string; sub?: string; state: 'todo' | 'active' | 'done' }>;
}): React.ReactElement {
  return (
    <ol
      className="flex w-[240px] flex-none flex-col gap-6 border-r p-6"
      style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      aria-label="Шаги генерации"
      data-testid="gen-steps"
    >
      {steps.map((s, i) => (
        <li
          key={s.label}
          className="flex items-start gap-3 text-sm"
          aria-current={s.state === 'active' ? 'step' : undefined}
          data-testid={`gen-step-${i + 1}`}
          data-state={s.state}
        >
          <span
            className="grid h-6 w-6 flex-none place-items-center rounded-full text-xs font-bold"
            style={
              s.state === 'done'
                ? { background: 'var(--color-success-bg)', color: 'var(--color-success-fg)' }
                : s.state === 'active'
                  ? { background: 'var(--color-primary)', color: '#fff' }
                  : { background: 'var(--color-surface-2)', color: 'var(--color-text-3)' }
            }
          >
            {s.state === 'done' ? (
              <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />
            ) : (
              i + 1
            )}
          </span>
          <span className="min-w-0">
            <span
              className={s.state === 'active' ? 'block font-semibold' : 'block'}
              style={s.state === 'active' ? undefined : { color: 'var(--color-text-3)' }}
            >
              {s.label}
            </span>
            {s.sub ? (
              <span className="mt-0.5 block text-xs" style={{ color: 'var(--color-text-3)' }}>
                {s.sub}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Цветной бейдж-счётчик правой панели. */
function Badge({
  tone,
  children,
  testid,
}: {
  tone: 'ok' | 'warn' | 'err' | 'info';
  children: React.ReactNode;
  testid?: string;
}): React.ReactElement {
  const map = {
    ok: ['var(--color-success-bg)', 'var(--color-success-fg)'],
    warn: ['var(--color-warning-bg)', 'var(--color-warning-fg)'],
    err: ['var(--color-danger-bg)', 'var(--color-danger-fg)'],
    info: ['var(--color-info-bg)', 'var(--color-info-fg)'],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <span
      className="rounded-full px-2.5 py-1 text-xs font-bold"
      style={{ background: bg, color: fg }}
      data-testid={testid}
    >
      {children}
    </span>
  );
}

/**
 * Тело кейса в карточке: markdown-исходник блока показывается человеку, а не
 * как сырой текст — заголовок `### …` не дублируем (он и есть шапка карточки),
 * `**метка:**` подаём жирным.
 */
function CaseBody({ body }: { body: string }): React.ReactElement {
  const lines = body
    .split('\n')
    .filter((l) => !l.startsWith('### '))
    .join('\n')
    .trim()
    .split('\n');
  return (
    <div
      className="mt-2 space-y-1 text-xs leading-relaxed"
      style={{ color: 'var(--color-text-2)' }}
    >
      {lines.map((line, i) => {
        if (line.trim() === '') return <div key={i} className="h-1" />;
        const parts = line.split(/\*\*(.+?)\*\*/g);
        return (
          <p key={i}>
            {parts.map((part, k) =>
              k % 2 === 1 ? (
                <strong key={k} style={{ color: 'var(--color-text)' }}>
                  {part}
                </strong>
              ) : (
                <span key={k}>{part}</span>
              ),
            )}
          </p>
        );
      })}
    </div>
  );
}

/**
 * Полноэкранный мастер генерации артефактов (макеты Г1–Г12,
 * docs/design/screens/flow-g*.html).
 *
 * Три шага в вертикальном степпере: направление → способ и параметры →
 * результат. Ключевое отличие от прежней модалки: параметры AI и вопрос о
 * нереализованных ФТ живут на одном шаге со способом, а прогон, журнал и
 * результат видны одновременно. Прогресс прогона не теряется: остановка
 * (Г7) и ошибка батча (Г8) сохраняют готовые кейсы и дают продолжить с того
 * же места либо достроить остаток детерминированным шаблоном.
 */
export function GeneratePage(): React.ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const projectQuery = useProject(id);
  const reqQuery = useRequirements(id);
  const requirements = useMemo(() => reqQuery.data?.requirements ?? [], [reqQuery.data]);

  const [step, setStep] = useState<Step>('direction');
  const [direction, setDirection] = useState<Direction>('tracker');
  const [mode, setMode] = useState<GenMode>('template');
  const [trackerSelected, setTrackerSelected] = useState<Set<string> | null>(null);
  /** Чекбокс «Включить нереализованные ФТ» — заменил отдельный шаг-вопрос. */
  const [includeUnimpl, setIncludeUnimpl] = useState(true);
  const [aiNegatives, setAiNegatives] = useState(false);
  const [aiModelOverride, setAiModelOverride] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'cards' | 'markdown'>('cards');
  const [expandedCase, setExpandedCase] = useState<string | null>(null);
  const [leaveConfirm, setLeaveConfirm] = useState(false);

  // Результат детерминированной сборки (шаблон / трекер).
  const [templateDoc, setTemplateDoc] = useState<TestModelDoc | null>(null);

  // Состояние AI-прогона: живёт между попытками, чтобы остановка и ошибка
  // батча не теряли уже полученные кейсы (макеты Г7/Г8).
  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [ordered, setOrdered] = useState<Requirement[]>([]);
  const [batches, setBatches] = useState<string[][]>([]);
  const [doneBatches, setDoneBatches] = useState(0);
  const [aiCases, setAiCases] = useState<Map<string, AiTestCase>>(new Map());
  const [dropped, setDropped] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [log, setLog] = useState<AiLogEntry[]>([]);
  const cancelled = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);

  const configQuery = useAiConfig(id);
  const configured = Boolean(configQuery.data?.hasApiKey);
  const selectedModel = aiModelOverride ?? configQuery.data?.model ?? '';
  const modelsRefresh = useAiModelsRefresh({
    enabled: configured && step === 'mode' && mode === 'ai',
    selectedModel,
    fallbackModel: configQuery.data?.model,
    onModelReset: setAiModelOverride,
  });
  const modelOptions = useMemo(() => {
    const set = new Set<string>(modelsRefresh.models);
    if (selectedModel) set.add(selectedModel);
    return [...set];
  }, [modelsRefresh.models, selectedModel]);

  // Автоскролл журнала к последней строке (как в AI-импорте).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length]);

  const nameBySlug = useMemo(
    () => new Map(requirements.map((r) => [r.slug, r.name])),
    [requirements],
  );
  const functionalCount = useMemo(
    () => requirements.filter((r) => r.type === 'FUNCTION').length,
    [requirements],
  );
  const unimplCount = useMemo(
    () => requirements.filter((r) => r.type === 'FUNCTION' && !r.implemented).length,
    [requirements],
  );

  /** Набор требований для генерации с учётом чекбокса нереализованных. */
  const genReqs = useMemo(
    () =>
      includeUnimpl
        ? requirements
        : requirements.filter((r) => r.type !== 'FUNCTION' || r.implemented),
    [requirements, includeUnimpl],
  );

  /** Живой охват направления — бейдж на карточке (макет Г1, нулевой — Г12). */
  const coverage = useMemo(() => {
    const map = new Map<Direction, number>();
    for (const dir of DIRECTIONS) {
      if (dir === 'tracker') continue;
      map.set(dir, selectForKind(dir, genReqs).length);
    }
    return map;
  }, [genReqs]);

  const isTracker = direction === 'tracker';
  const kind = direction as TestModelKind;
  const dirCoverage = isTracker ? requirements.length : (coverage.get(direction) ?? 0);
  const zeroCoverage = !isTracker && dirCoverage === 0;

  const effectiveTrackerSelected = trackerSelected ?? new Set(requirements.map((r) => r.slug));

  const running = runStatus === 'running';

  /** Документ результата: для AI собирается из накопленных кейсов на лету. */
  const aiDoc = useMemo(() => {
    if (ordered.length === 0) return null;
    // Во время прогона показываем только уже обработанные батчи: остальные
    // строки — скелетоны, а не «достроенные шаблоном» кейсы.
    const upTo = running
      ? Math.min(doneBatches * AI_TESTGEN_BATCH, ordered.length)
      : ordered.length;
    const slice = ordered.slice(0, upTo);
    if (slice.length === 0) return null;
    return buildAiDoc(kind, slice, aiCases, {
      model: selectedModel,
      aiCases: aiCases.size,
      fallbackCases: slice.length - aiCases.size,
      dropped,
    });
  }, [ordered, running, doneBatches, aiCases, dropped, kind, selectedModel]);

  const doc = mode === 'ai' && !isTracker ? aiDoc : templateDoc;
  const fallbackCount = doc ? doc.blocks.filter((b) => b.source === 'template').length : 0;

  const fileBase = isTracker ? 'tasks' : direction;
  const filename = `${fileBase}-${new Date().toISOString().slice(0, 10)}.md`;

  function logLine(level: AiLogEntry['level'], message: string): void {
    setLog((prev) => [...prev, { level, message }]);
  }

  function downloadMd(content: string): void {
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

  // ── Переходы шагов ────────────────────────────────────────────────────────

  function goFromDirection(): void {
    if (isTracker) {
      setStep('select');
      return;
    }
    setMode(configured ? 'ai' : 'template');
    setStep('mode');
  }

  function buildTracker(): void {
    const picked = requirements.filter((r) => effectiveTrackerSelected.has(r.slug));
    setTemplateDoc(buildTrackerDoc(picked, effectiveTrackerSelected));
    setRunStatus('done');
    setStep('result');
  }

  function buildTemplate(): void {
    setTemplateDoc(buildTemplateDoc(kind, genReqs));
    setRunStatus('done');
    setStep('result');
  }

  /**
   * AI-прогон: клиентская оркестрация батчей (AI_TESTGEN_BATCH требований на
   * вызов). Каждый батч сервер проверяет на галлюцинации; пропущенные моделью
   * требования достраиваются детерминированным шаблоном при сборке файла.
   * `fromBatch > 0` — продолжение после остановки или ошибки батча.
   */
  async function runAi(fromBatch = 0): Promise<void> {
    const list = fromBatch > 0 && ordered.length > 0 ? ordered : selectForKind(kind, genReqs);
    if (list.length === 0) {
      logLine('warn', 'Под выбранную модель не попало ни одного ФТ — генерировать нечего.');
      return;
    }
    const chunks =
      fromBatch > 0 && batches.length > 0
        ? batches
        : (() => {
            const out: string[][] = [];
            const slugs = list.map((r) => r.slug);
            for (let i = 0; i < slugs.length; i += AI_TESTGEN_BATCH) {
              out.push(slugs.slice(i, i + AI_TESTGEN_BATCH));
            }
            return out;
          })();

    cancelled.current = false;
    setOrdered(list);
    setBatches(chunks);
    setRunStatus('running');
    setStep('result');
    const cases = new Map(fromBatch > 0 ? aiCases : []);
    let droppedTotal = fromBatch > 0 ? dropped : 0;
    if (fromBatch === 0) {
      setLog([]);
      setAiCases(new Map());
      setDropped(0);
      setDoneBatches(0);
      setElapsedMs(0);
    }
    const startedAt = Date.now() - (fromBatch > 0 ? elapsedMs : 0);
    logLine(
      'info',
      fromBatch > 0
        ? `Продолжаем с батча ${fromBatch + 1}/${chunks.length}: уже готово кейсов ${cases.size}.`
        : `AI-генерация «${KIND_TITLE[kind]}»: модель ${selectedModel}, требований ${list.length}, батчей ${chunks.length}.`,
    );

    for (let b = fromBatch; b < chunks.length; b++) {
      if (cancelled.current) {
        setElapsedMs(Date.now() - startedAt);
        logLine(
          'warn',
          `Остановлено пользователем после батча ${b}/${chunks.length}. Готово кейсов ${cases.size} — прогресс сохранён.`,
        );
        setRunStatus('stopped');
        return;
      }
      const batch = chunks[b]!;
      logLine(
        'info',
        `Батч ${b + 1}/${chunks.length} (${batch.length} требований) — запрос к модели…`,
      );
      try {
        const res = await aiApi.generateTests({
          projectId: id,
          kind,
          slugs: batch,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(kind === 'smoke' ? { negatives: aiNegatives } : {}),
        });
        for (const c of res.cases) cases.set(c.slug, c);
        droppedTotal += res.dropped;
        const extras: string[] = [];
        if (res.dropped > 0) extras.push(`отброшено галлюцинаций: ${res.dropped}`);
        if (res.missing.length > 0) {
          extras.push(
            `без кейса (достроим шаблоном): ${res.missing
              .map((s) => `«${nameBySlug.get(s) ?? s}»`)
              .join(', ')}`,
          );
        }
        logLine(
          res.dropped > 0 || res.missing.length > 0 ? 'warn' : 'info',
          `Батч ${b + 1}/${chunks.length}: кейсов принято ${res.cases.length}${extras.length ? ` · ${extras.join(' · ')}` : ''}.`,
        );
      } catch (err) {
        setAiCases(new Map(cases));
        setDropped(droppedTotal);
        setDoneBatches(b);
        setElapsedMs(Date.now() - startedAt);
        logLine(
          'error',
          `Батч ${b + 1}/${chunks.length}: ${err instanceof Error ? err.message : String(err)} — батч отложен, готовые ${cases.size} кейсов сохранены.`,
        );
        setRunStatus('error');
        return;
      }
      setAiCases(new Map(cases));
      setDropped(droppedTotal);
      setDoneBatches(b + 1);
    }
    setElapsedMs(Date.now() - startedAt);
    const missingTotal = list.length - cases.size;
    logLine(
      'info',
      `Готово: AI-кейсов ${cases.size}, достроено шаблоном ${missingTotal}, отброшено галлюцинаций ${droppedTotal}.`,
    );
    setRunStatus('done');
  }

  /** Достроить остаток детерминированным шаблоном — выход из Г7/Г8 без тупика. */
  function fillWithTemplate(): void {
    const missing = ordered.length - aiCases.size;
    logLine('info', `Достроено шаблоном: ${missing} ${missing === 1 ? 'кейс' : 'кейсов'}.`);
    setDoneBatches(batches.length);
    setRunStatus('done');
  }

  /** Идёт прогон — уходить со страницы без подтверждения нельзя (макет Г11). */
  function guardLeave(): boolean {
    if (!running) return true;
    setLeaveConfirm(true);
    return false;
  }

  // ── Шапка и степпер ───────────────────────────────────────────────────────

  const projectName = projectQuery.data?.name ?? id;
  const titleParts = ['Генерация артефактов'];
  if (step !== 'direction') titleParts.push(DIRECTION_INFO[direction].title);
  if (step === 'result' && !isTracker) titleParts.push(mode === 'ai' ? 'AI' : 'Шаблон');
  titleParts.push(projectName);

  const steps: Array<{ label: string; sub?: string; state: 'todo' | 'active' | 'done' }> = [
    {
      label: 'Направление',
      ...(step === 'direction'
        ? { sub: 'что генерируем' }
        : { sub: DIRECTION_INFO[direction].title }),
      state: step === 'direction' ? 'active' : 'done',
    },
    isTracker
      ? {
          label: 'Выбор требований',
          state: step === 'select' ? 'active' : step === 'result' ? 'done' : 'todo',
        }
      : {
          label: 'Способ и параметры',
          ...(step === 'result'
            ? { sub: mode === 'ai' ? `AI · ${selectedModel}` : 'Шаблон' }
            : { sub: 'шаблон или AI' }),
          state: step === 'mode' ? 'active' : step === 'result' ? 'done' : 'todo',
        },
    {
      label: 'Результат',
      ...(step === 'result' && running ? { sub: 'генерация…' } : { sub: 'предпросмотр + журнал' }),
      state: step === 'result' ? 'active' : 'todo',
    },
  ];

  // ── Футер ─────────────────────────────────────────────────────────────────

  const backButton = (to: Step, testid: string): React.ReactElement => (
    <button
      type="button"
      className="btn btn-secondary"
      data-testid={testid}
      disabled={running}
      onClick={() => setStep(to)}
    >
      <ArrowLeft className="icon-sm" aria-hidden="true" />
      Назад
    </button>
  );

  let footerLeft: React.ReactNode = null;
  let footerRight: React.ReactNode = null;

  if (step === 'direction') {
    footerLeft = (
      <button
        type="button"
        className="btn btn-secondary"
        data-testid="gen-close"
        onClick={() => navigate(`/p/${id}`)}
      >
        Закрыть
      </button>
    );
    footerRight = (
      <button
        type="button"
        className="btn btn-primary"
        data-testid="gen-direction-next"
        disabled={zeroCoverage}
        title={zeroCoverage ? 'Под правила отбора не попало ни одного ФТ' : undefined}
        onClick={goFromDirection}
      >
        {isTracker ? 'Далее: выбор требований →' : 'Далее: способ и параметры →'}
      </button>
    );
  } else if (step === 'select') {
    footerLeft = backButton('direction', 'gen-back-1');
  } else if (step === 'mode') {
    footerLeft = backButton('direction', 'gen-back-1');
  } else {
    footerLeft = (
      <button
        type="button"
        className="btn btn-secondary"
        data-testid="gen-back-2"
        disabled={running}
        onClick={() => setStep(isTracker ? 'select' : 'mode')}
      >
        <ArrowLeft className="icon-sm" aria-hidden="true" />
        {isTracker ? 'Изменить выбор' : 'Изменить параметры'}
      </button>
    );
    footerRight = (
      <>
        {!isTracker ? (
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="gen-regenerate"
            disabled={running}
            onClick={() => (mode === 'ai' ? void runAi(0) : buildTemplate())}
          >
            <RotateCw className="icon-sm" aria-hidden="true" />
            {mode === 'ai' ? 'Перегенерировать' : 'Пересобрать'}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          data-testid="export-tasks-download"
          disabled={!doc || running}
          onClick={() => {
            if (doc) downloadMd(doc.md);
          }}
        >
          <Download className="icon-sm" aria-hidden="true" />
          {runStatus === 'stopped' || runStatus === 'error'
            ? 'Скачать частичный .md'
            : 'Скачать .md'}
        </button>
      </>
    );
  }

  // ── Контент шагов ─────────────────────────────────────────────────────────

  const directionStep = (
    <>
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-4 overflow-y-auto p-6">
        {DIRECTIONS.map((dir) => {
          const info = DIRECTION_INFO[dir];
          const Icon = info.icon;
          const on = direction === dir;
          const cov = dir === 'tracker' ? null : (coverage.get(dir) ?? 0);
          return (
            <button
              key={dir}
              type="button"
              className="flex flex-col gap-2 rounded-xl border p-5 text-left transition-colors"
              style={{
                borderColor: on ? 'var(--color-primary)' : 'var(--color-border)',
                background: on ? 'var(--color-primary-soft)' : 'var(--color-surface)',
                boxShadow: on ? '0 0 0 1px var(--color-primary)' : undefined,
              }}
              aria-pressed={on}
              data-testid={`export-tasks-dir-${dir}`}
              onClick={() => setDirection(dir)}
            >
              <span className="flex items-center gap-2.5 text-[15px] font-semibold">
                <Icon className="icon" style={{ color: info.iconColor }} aria-hidden="true" />
                {info.title}
              </span>
              <span className="text-sm" style={{ color: 'var(--color-text-3)' }}>
                {info.description}
              </span>
              <span
                className="mt-auto w-max rounded-full border px-3 py-1 text-xs font-bold"
                style={{
                  borderColor: 'var(--color-border)',
                  background: 'var(--color-surface)',
                  color: cov === 0 ? 'var(--color-danger)' : 'var(--color-primary)',
                }}
                data-testid={`gen-coverage-${dir}`}
              >
                {cov === null
                  ? 'выбор требований вручную'
                  : `охват: ${cov} из ${functionalCount} ФТ`}
              </span>
            </button>
          );
        })}
      </div>
      <WorkspaceAside testid="gen-direction-aside">
        <AsideTitle>Что вы получите · {DIRECTION_INFO[direction].title}</AsideTitle>
        {isTracker ? (
          <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
            Требования выбираются вручную на следующем шаге и выгружаются задачами в OpenSpec
            Markdown — для трекера или ИИ-агента. AI-способ доступен для тестовых моделей.
          </p>
        ) : zeroCoverage ? (
          <>
            <div
              className="rounded-xl border border-dashed p-5 text-center text-sm leading-relaxed"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-2)' }}
              data-testid="gen-empty-coverage"
            >
              <strong className="mb-1.5 block text-[15px]">
                Под правила отбора не попало ни одно ФТ
              </strong>
              {KIND_RULES[kind]} В проекте таких требований пока нет.
            </div>
            <Banner tone="info">
              Проставьте нужную критичность ключевым ФТ на экране «Требования» — охват пересчитается
              автоматически.
            </Banner>
            <button
              type="button"
              className="btn btn-secondary w-full justify-center"
              data-testid="gen-open-requirements"
              onClick={() => navigate(`/p/${id}`)}
            >
              Открыть «Требования» →
            </button>
          </>
        ) : (
          <>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-2)' }}>
              <strong>Правила отбора:</strong> {KIND_RULES[kind]}
            </p>
            <pre
              className="overflow-x-auto rounded-lg p-4 font-mono text-[11px] leading-relaxed"
              style={{ background: 'var(--color-surface-2)', color: 'var(--color-text-2)' }}
              data-testid="gen-sample"
            >
              {KIND_SAMPLE[kind]}
            </pre>
          </>
        )}
      </WorkspaceAside>
    </>
  );

  const selectStep = (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
        <RequirementPicker
          requirements={requirements}
          selected={effectiveTrackerSelected}
          onChange={setTrackerSelected}
          testid="tracker-select-modal"
        />
      </div>
      <WorkspaceAside testid="gen-select-aside">
        <AsideTitle>Итог</AsideTitle>
        <dl
          className="space-y-1 rounded-lg border p-3 text-sm"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)' }}
        >
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--color-text-2)' }}>Выбрано требований</dt>
            <dd className="font-semibold" data-testid="gen-select-count">
              {effectiveTrackerSelected.size}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--color-text-2)' }}>Файл</dt>
            <dd className="font-semibold">{filename}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--color-text-2)' }}>Формат</dt>
            <dd className="font-semibold">OpenSpec Markdown</dd>
          </div>
        </dl>
        <Banner tone="info">
          Задачи формируются детерминированно — AI-способ доступен для тестовых моделей (Smoke,
          регрессы).
        </Banner>
        <AsideActions>
          <button
            type="button"
            className="btn btn-primary w-full justify-center"
            data-testid="gen-select-confirm"
            disabled={effectiveTrackerSelected.size === 0}
            title={
              effectiveTrackerSelected.size === 0 ? 'Выберите хотя бы одно требование' : undefined
            }
            onClick={buildTracker}
          >
            Сформировать ({effectiveTrackerSelected.size})
          </button>
        </AsideActions>
      </WorkspaceAside>
    </>
  );

  const modeCard = (
    value: GenMode,
    icon: React.ReactNode,
    title: string,
    text: string,
    pros: string,
    cons: string,
    disabled = false,
    badge?: React.ReactNode,
  ): React.ReactElement => {
    const on = mode === value && !disabled;
    return (
      <button
        type="button"
        className="flex items-start gap-3.5 rounded-xl border p-5 text-left transition-colors"
        style={{
          borderColor: on ? 'var(--color-primary)' : 'var(--color-border)',
          background: on ? 'var(--color-primary-soft)' : 'var(--color-surface)',
          boxShadow: on ? '0 0 0 1px var(--color-primary)' : undefined,
          opacity: disabled ? 0.6 : 1,
        }}
        role="radio"
        aria-checked={on}
        disabled={disabled}
        data-testid={`export-mode-${value}`}
        onClick={() => setMode(value)}
      >
        <span
          className="mt-1 h-4 w-4 flex-none rounded-full border"
          style={{
            borderColor: on ? 'var(--color-primary)' : 'var(--color-border)',
            borderWidth: on ? 5 : 1.5,
            background: 'var(--color-surface)',
          }}
          aria-hidden="true"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-[15px] font-semibold">
            {icon}
            {title}
            {badge}
          </span>
          <span className="mt-1 block text-sm" style={{ color: 'var(--color-text-3)' }}>
            {text}
          </span>
          <span
            className="mt-2 block text-xs leading-relaxed"
            style={{ color: 'var(--color-text-2)' }}
          >
            <span className="block">✅ {pros}</span>
            <span className="block">➖ {cons}</span>
          </span>
        </span>
      </button>
    );
  };

  const modeStep = (
    <>
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6"
        data-testid="gen-mode"
      >
        {modeCard(
          'template',
          <FileText
            className="icon"
            style={{ color: 'var(--color-primary)' }}
            aria-hidden="true"
          />,
          'Детерминированный шаблон',
          'Единая структура кейсов, шаги по общей формуле.',
          'мгновенно, офлайн, воспроизводимо',
          'шаги общие, без специфики требования',
        )}
        {modeCard(
          'ai',
          <Sparkles className="icon" style={{ color: 'var(--color-accent)' }} aria-hidden="true" />,
          'AI-генерация по описаниям',
          'Модель-QA пишет конкретные шаги по описаниям требований. Каждый кейс проходит проверку на галлюцинации, пропуски достраиваются шаблоном.',
          'конкретные шаги и негативные сценарии',
          configured
            ? 'нужен настроенный AI, ~1–2 мин на модель'
            : 'недоступно: не задан ключ или модель AI-хаба',
          !configured,
          configured ? undefined : <Badge tone="warn">AI не настроен</Badge>,
        )}
      </div>
      <WorkspaceAside testid="gen-mode-aside">
        <AsideTitle>{mode === 'ai' ? 'Параметры AI-генерации' : 'Параметры шаблона'}</AsideTitle>

        {!configured ? (
          <div data-testid="gen-ai-not-configured" className="flex flex-col gap-3">
            <Banner tone="warning">
              <strong>Модель не задана.</strong> Укажите ключ AI-хаба и выберите модель в разделе
              «Настройка AI», затем вернитесь сюда — выбор сохранится.
            </Banner>
            <button
              type="button"
              className="btn btn-secondary w-full justify-center"
              data-testid="gen-open-ai-settings"
              onClick={() => navigate(`/p/${id}/ai`)}
            >
              Перейти в «Настройку AI» →
            </button>
            <Banner tone="info">
              Способ «Шаблон» доступен без AI — модель можно собрать прямо сейчас.
            </Banner>
          </div>
        ) : mode === 'ai' ? (
          <>
            <div className="flex items-center gap-2">
              <label htmlFor="gen-ai-model" className="text-sm font-medium">
                Модель:
              </label>
              <select
                id="gen-ai-model"
                className="input min-w-0 flex-1 py-1.5 text-sm"
                data-testid="gen-ai-model-select"
                value={selectedModel}
                onChange={(e) => setAiModelOverride(e.target.value)}
              >
                {modelOptions.length === 0 ? (
                  <option value="">Обновите список моделей</option>
                ) : (
                  modelOptions.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                className="btn btn-secondary shrink-0 px-2.5"
                title="Обновить список моделей"
                aria-label="Обновить список моделей"
                data-testid="gen-ai-models-refresh"
                disabled={modelsRefresh.isFetching}
                onClick={() => void modelsRefresh.refresh()}
              >
                <RefreshCw
                  className={`icon-sm ${modelsRefresh.isFetching ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
              </button>
            </div>
            {direction === 'smoke' ? (
              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                  data-testid="gen-ai-negatives"
                  checked={aiNegatives}
                  onChange={(e) => setAiNegatives(e.target.checked)}
                />
                <span>
                  Добавлять негативные сценарии (AI)
                  <span className="hint mt-0.5 block">
                    Смок обычно быстрый и позитивный; опция просит модель дописать негатив к каждому
                    кейсу. Для крит- и полного регресса негатив включён всегда.
                  </span>
                </span>
              </label>
            ) : null}
          </>
        ) : null}

        {unimplCount > 0 ? (
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
              data-testid="gen-include-unimpl"
              checked={includeUnimpl}
              onChange={(e) => setIncludeUnimpl(e.target.checked)}
            />
            <span>
              Включить нереализованные ФТ ({unimplCount})
              <span className="hint mt-0.5 block">
                Кейсы для запланированных функций помечаются «до реализации».
              </span>
            </span>
          </label>
        ) : null}

        <dl
          className="space-y-1 rounded-lg border p-3 text-sm"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg)' }}
          data-testid="gen-estimate"
        >
          <div className="flex justify-between gap-3">
            <dt style={{ color: 'var(--color-text-2)' }}>Требований в модели</dt>
            <dd className="font-semibold">
              {dirCoverage} из {functionalCount} ФТ
            </dd>
          </div>
          {mode === 'ai' && configured ? (
            <>
              <div className="flex justify-between gap-3">
                <dt style={{ color: 'var(--color-text-2)' }}>Вызовов к модели</dt>
                <dd className="font-semibold">
                  {Math.ceil(dirCoverage / AI_TESTGEN_BATCH)} батча по ≤{AI_TESTGEN_BATCH}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt style={{ color: 'var(--color-text-2)' }}>Ориентировочно</dt>
                <dd className="font-semibold">
                  ~
                  {Math.max(1, Math.ceil((dirCoverage / AI_TESTGEN_BATCH) * 20) / 60) < 1
                    ? '1 мин'
                    : `${Math.ceil((Math.ceil(dirCoverage / AI_TESTGEN_BATCH) * 20) / 60)} мин`}
                </dd>
              </div>
            </>
          ) : (
            <div className="flex justify-between gap-3">
              <dt style={{ color: 'var(--color-text-2)' }}>Время</dt>
              <dd className="font-semibold">мгновенно</dd>
            </div>
          )}
        </dl>

        <AsideActions>
          {mode === 'ai' && configured ? (
            <button
              type="button"
              className="btn btn-primary w-full justify-center"
              data-testid="gen-ai-start"
              disabled={!selectedModel || dirCoverage === 0}
              onClick={() => void runAi(0)}
            >
              <Sparkles className="icon-sm" aria-hidden="true" />
              Сгенерировать
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary w-full justify-center"
              data-testid="gen-template-start"
              disabled={dirCoverage === 0}
              onClick={buildTemplate}
            >
              Сформировать
            </button>
          )}
        </AsideActions>
      </WorkspaceAside>
    </>
  );

  const totalBatches = batches.length;
  const progressPct = totalBatches === 0 ? 0 : Math.round((doneBatches / totalBatches) * 100);
  const missingNow = Math.max(0, ordered.length - aiCases.size);

  const resultStep = (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-5">
        {runStatus === 'stopped' ? (
          <Banner tone="warning" testid="gen-stopped-banner" role="status">
            <strong>Генерация остановлена.</strong> Готово {aiCases.size} из {ordered.length} кейсов
            — прогресс сохранён: можно продолжить с батча {doneBatches + 1}, достроить остаток
            шаблоном или скачать частичный файл.
          </Banner>
        ) : null}
        {runStatus === 'error' ? (
          <Banner tone="danger" testid="gen-error-banner" role="alert">
            <strong>
              Батч {doneBatches + 1}/{totalBatches} не удался.
            </strong>{' '}
            Готовые {aiCases.size} кейсов сохранены — повторите батч или достройте остаток шаблоном.
          </Banner>
        ) : null}

        <div className="flex flex-none flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold" data-testid="gen-preview-title">
            {running
              ? `Готово ${aiCases.size} из ${ordered.length} кейсов`
              : runStatus === 'stopped' || runStatus === 'error'
                ? `Частичный результат · ${aiCases.size} ${aiCases.size === 1 ? 'кейс' : 'кейсов'}`
                : `Предпросмотр · ${doc?.blocks.length ?? 0} ${doc?.blocks.length === 1 ? 'кейс' : 'кейсов'}`}
          </p>
          <span
            className="flex items-center gap-2 text-xs"
            style={{ color: 'var(--color-text-3)' }}
          >
            <span data-testid="export-tasks-filename">{filename}</span>
            <span aria-hidden="true">·</span>
            <span>вид:</span>
            <button
              type="button"
              className="font-semibold underline underline-offset-2"
              style={{ color: viewMode === 'cards' ? 'var(--color-primary)' : undefined }}
              data-testid="gen-view-cards"
              onClick={() => setViewMode('cards')}
            >
              карточки
            </button>
            <span aria-hidden="true">|</span>
            <button
              type="button"
              className="font-semibold underline underline-offset-2"
              style={{ color: viewMode === 'markdown' ? 'var(--color-primary)' : undefined }}
              data-testid="gen-view-markdown"
              onClick={() => setViewMode('markdown')}
            >
              markdown
            </button>
          </span>
        </div>

        {viewMode === 'markdown' ? (
          <div
            className="min-h-0 flex-1 overflow-y-auto rounded-lg border p-4 font-mono text-xs leading-relaxed"
            style={{
              borderColor: 'var(--color-border)',
              background: 'var(--color-surface-2)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
            data-testid="export-tasks-preview"
          >
            {doc?.md ?? ''}
          </div>
        ) : (
          <div
            className="min-h-0 flex-1 overflow-y-auto rounded-lg border"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
            data-testid="gen-cases"
          >
            {(doc?.blocks ?? []).map((b) => {
              const open = expandedCase === b.tcId;
              return (
                <div
                  key={b.tcId}
                  className="px-4 py-3"
                  style={{ borderTop: '1px solid var(--color-border)' }}
                  data-testid={`gen-case-${b.tcId}`}
                  data-source={b.source}
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 text-left text-sm font-semibold"
                    aria-expanded={open}
                    onClick={() => setExpandedCase(open ? null : b.tcId)}
                  >
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                      style={
                        b.source === 'ai'
                          ? {
                              background: 'var(--color-primary-soft)',
                              color: 'var(--color-primary)',
                            }
                          : {
                              background: 'var(--color-warning-bg)',
                              color: 'var(--color-warning-fg)',
                            }
                      }
                    >
                      {b.source === 'ai' ? 'AI' : 'шаблон'}
                    </span>
                    <span className="min-w-0 truncate">{b.title}</span>
                    <span
                      className="flex-none text-xs font-normal"
                      style={{ color: 'var(--color-text-3)' }}
                    >
                      {b.tcId}
                    </span>
                    <span
                      className="ml-auto flex-none text-xs"
                      style={{ color: 'var(--color-text-3)' }}
                    >
                      {open ? '▾' : '▸'}
                    </span>
                  </button>
                  {open ? <CaseBody body={b.body} /> : null}
                </div>
              );
            })}
            {running
              ? [0, 1].map((i) => (
                  <div
                    key={`skeleton-${i}`}
                    className="flex items-center gap-3 px-4 py-3.5"
                    style={{ borderTop: '1px solid var(--color-border)' }}
                    data-testid="gen-case-skeleton"
                    aria-hidden="true"
                  >
                    <span
                      className="h-3 w-11 rounded"
                      style={{ background: 'var(--color-surface-2)' }}
                    />
                    <span
                      className="h-3 flex-1 rounded"
                      style={{ background: 'var(--color-surface-2)' }}
                    />
                  </div>
                ))
              : null}
          </div>
        )}
      </div>

      <WorkspaceAside testid="gen-result-aside">
        {running ? (
          <>
            <AsideTitle>Прогресс</AsideTitle>
            <div
              className="h-2 overflow-hidden rounded-full"
              style={{ background: 'var(--color-surface-2)' }}
              role="progressbar"
              aria-valuenow={progressPct}
              aria-valuemin={0}
              aria-valuemax={100}
              data-testid="gen-ai-progressbar"
            >
              <span
                className="block h-full transition-all"
                style={{ width: `${progressPct}%`, background: 'var(--color-primary)' }}
              />
            </div>
            <p
              className="text-sm"
              style={{ color: 'var(--color-text-2)' }}
              data-testid="gen-ai-progress"
            >
              Батчей готово: {doneBatches} из {totalBatches}
            </p>
          </>
        ) : mode === 'ai' && !isTracker ? (
          <>
            <AsideTitle>Проверка на галлюцинации</AsideTitle>
            <div className="flex flex-wrap gap-2" data-testid="gen-verify-badges">
              <Badge tone="ok" testid="gen-badge-ai">
                AI-кейсов: {aiCases.size}
              </Badge>
              <Badge tone="warn" testid="gen-badge-fallback">
                достроено шаблоном: {runStatus === 'done' ? fallbackCount : missingNow}
              </Badge>
              <Badge tone={dropped > 0 ? 'warn' : 'ok'} testid="gen-badge-dropped">
                галлюцинаций отброшено: {dropped}
              </Badge>
              <Badge tone={runStatus === 'error' ? 'err' : 'info'} testid="gen-badge-batches">
                батчей: {doneBatches} из {totalBatches}
                {elapsedMs > 0 ? ` · ~${Math.round(elapsedMs / 1000)} сек` : ''}
              </Badge>
            </div>
          </>
        ) : (
          <>
            <AsideTitle>Сборка</AsideTitle>
            <Banner tone="info" testid="gen-template-note">
              <strong>Детерминированная сборка.</strong> AI не использовался: одинаковый результат
              при каждом запуске, работает офлайн.
            </Banner>
          </>
        )}

        <AsideTitle>Журнал прогона</AsideTitle>
        <div
          ref={logRef}
          className="min-h-[140px] flex-1 overflow-y-auto rounded-lg border p-3 font-mono text-xs leading-relaxed"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}
          role="log"
          aria-label="Журнал генерации"
          tabIndex={0}
          data-testid="gen-ai-log"
        >
          {log.length === 0 ? (
            <span style={{ color: 'var(--color-text-3)' }}>
              {isTracker
                ? `Задачи собраны детерминированно: ${doc?.blocks.length ?? 0}.`
                : `Шаблонная сборка «${KIND_TITLE[kind]}»: кейсов ${doc?.blocks.length ?? 0}.`}
            </span>
          ) : (
            log.map((l, i) => (
              <div
                key={i}
                data-level={l.level}
                style={
                  l.level === 'error'
                    ? { color: 'var(--color-danger-fg)' }
                    : l.level === 'warn'
                      ? { color: 'var(--color-warning-fg)' }
                      : undefined
                }
              >
                {l.message}
              </div>
            ))
          )}
        </div>

        {running ? (
          <AsideActions>
            <button
              type="button"
              className="btn btn-secondary w-full justify-center"
              style={{ color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}
              data-testid="gen-ai-stop"
              onClick={() => {
                cancelled.current = true;
              }}
            >
              <Square className="icon-sm" aria-hidden="true" />
              Остановить генерацию
            </button>
          </AsideActions>
        ) : null}

        {runStatus === 'stopped' || runStatus === 'error' ? (
          <AsideActions>
            <button
              type="button"
              className="btn btn-primary w-full justify-center"
              data-testid="gen-ai-resume"
              onClick={() => void runAi(doneBatches)}
            >
              {runStatus === 'error' ? (
                <RotateCw className="icon-sm" aria-hidden="true" />
              ) : (
                <Play className="icon-sm" aria-hidden="true" />
              )}
              {runStatus === 'error'
                ? `Повторить батч ${doneBatches + 1}/${totalBatches}`
                : `Продолжить генерацию (батч ${doneBatches + 1}/${totalBatches})`}
            </button>
            <button
              type="button"
              className="btn btn-secondary w-full justify-center"
              data-testid="gen-ai-fill-template"
              onClick={fillWithTemplate}
            >
              Достроить {missingNow} {missingNow === 1 ? 'кейс' : 'кейсов'} шаблоном
            </button>
          </AsideActions>
        ) : null}
      </WorkspaceAside>
    </>
  );

  return (
    <WorkspaceScreen
      projectId={id}
      action="tasks"
      title={titleParts.join(' · ')}
      mainPath={projectQuery.data?.mainPath ?? ''}
      testid="export-tasks-modal"
      onBeforeLeave={guardLeave}
      footerLeft={footerLeft}
      footerRight={footerRight}
    >
      <Stepper steps={steps} />
      {step === 'direction'
        ? directionStep
        : step === 'select'
          ? selectStep
          : step === 'mode'
            ? modeStep
            : resultStep}

      {leaveConfirm ? (
        <ConfirmDialog
          title="Прервать генерацию?"
          message={`Выполнено ${doneBatches} из ${totalBatches} батчей — прогресс сохранится. Вы сможете продолжить с батча ${doneBatches + 1}, достроить оставшиеся кейсы шаблоном или скачать частичный файл.`}
          confirmLabel="Прервать"
          cancelLabel="Остаться"
          danger
          icon={null}
          onCancel={() => setLeaveConfirm(false)}
          onConfirm={() => {
            cancelled.current = true;
            setLeaveConfirm(false);
            navigate(`/p/${id}`);
          }}
        />
      ) : null}
    </WorkspaceScreen>
  );
}
