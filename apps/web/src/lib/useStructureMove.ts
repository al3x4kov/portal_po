import { useCallback, useEffect, useMemo, useState } from 'react';
import { collectDescendants, parentSlugOf, type Requirement } from '@po/core';
import { ApiError, errorMessage } from '../api/client';
import { useMoveRequirement } from '../api/hooks';
import { useToast } from '../components/Toast';
import { useUiStore } from '../store/ui';
import type { MoveHistoryEntry } from '../components/StructureBar';
import { dropReason, moveOptionsFor, type MoveOp, type MoveOption } from './structureMoves';

/** Переезд раздела с бо́льшим числом потомков спрашивает подтверждение (макет П5). */
export const SUBTREE_CONFIRM_THRESHOLD = 3;

/** Отложенное перемещение, ждущее подтверждения пользователя. */
export interface PendingMove {
  slug: string;
  name: string;
  parentSlug: string | null;
  parentName: string;
  descendantNames: string[];
  newDepth: number;
}

/** Состояние и действия режима структуры — вся оркестрация перемещения строк. */
export interface StructureMoveApi {
  active: boolean;
  selectedSlug: string | null;
  selected: Requirement | null;
  currentParentName: string | null;
  level: number;
  depth: number;
  descendants: number;
  options: MoveOption[];
  draggingSlug: string | null;
  failedSlug: string | null;
  error: { message: string; canRetry: boolean } | null;
  history: MoveHistoryEntry[];
  pending: PendingMove | null;
  busy: boolean;
  canUndo: boolean;
  select: (slug: string) => void;
  startDrag: (slug: string) => void;
  endDrag: () => void;
  dropReasonFor: (targetSlug: string | null) => string | undefined;
  dropOn: (targetSlug: string | null) => void;
  applyOp: (op: MoveOp) => void;
  confirmPending: () => void;
  cancelPending: () => void;
  undo: () => void;
  retry: () => void;
  dismissError: () => void;
  exit: () => void;
}

/** Уровень строки в дереве (1 = корень); безопасен к циклам. */
function levelOf(reqs: readonly Requirement[], slug: string): number {
  const bySlug = new Map(reqs.map((r) => [r.slug, r]));
  const seen = new Set<string>([slug]);
  let level = 1;
  let parent = parentSlugOf(bySlug.get(slug) ?? ({ links: [] } as unknown as Requirement));
  while (parent !== undefined && bySlug.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    level += 1;
    parent = parentSlugOf(bySlug.get(parent) as Requirement);
  }
  return level;
}

/** Глубина всего дерева этого типа — знаменатель в «уровень 2 из 5». */
function depthOf(reqs: readonly Requirement[]): number {
  return reqs.reduce((max, r) => Math.max(max, levelOf(reqs, r.slug)), 1);
}

const timeLabel = (): string =>
  new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/**
 * Режим структуры: выбор строки, перетаскивание, стрелки, клавиатура, отмена и
 * честная обработка отказов сервера.
 *
 * Перемещение оптимистично только внешне: строка возвращается на место, если
 * сервер отказал (конфликт версий, обрыв сети) — дерево на экране никогда не
 * расходится с файлами. Отсюда же берётся отмена: сервер вернул старого
 * родителя, значит откат — это такое же перемещение обратно.
 */
export function useStructureMove(
  projectId: string,
  requirements: readonly Requirement[],
): StructureMoveApi {
  const active = useUiStore((s) => s.structureMode);
  const setStructureMode = useUiStore((s) => s.setStructureMode);
  const selectedSlug = useUiStore((s) => s.moveSelection);
  const setSelection = useUiStore((s) => s.setMoveSelection);
  const toast = useToast();
  const moveMut = useMoveRequirement(projectId);

  const [draggingSlug, setDraggingSlug] = useState<string | null>(null);
  const [failedSlug, setFailedSlug] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; canRetry: boolean } | null>(null);
  const [history, setHistory] = useState<MoveHistoryEntry[]>([]);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [lastMove, setLastMove] = useState<{ slug: string; back: string | null } | null>(null);
  const [retryTarget, setRetryTarget] = useState<{
    slug: string;
    parentSlug: string | null;
  } | null>(null);

  const bySlug = useMemo(() => new Map(requirements.map((r) => [r.slug, r])), [requirements]);
  const selected = selectedSlug ? (bySlug.get(selectedSlug) ?? null) : null;

  /** Иерархия живёт внутри типа, поэтому все расчёты идут по своему срезу. */
  const scope = useMemo(
    () => (selected ? requirements.filter((r) => r.type === selected.type) : []),
    [requirements, selected],
  );

  const options = useMemo(
    () => (selected ? moveOptionsFor(scope, selected.slug) : []),
    [scope, selected],
  );

  const currentParentSlug = selected ? (parentSlugOf(selected) ?? null) : null;
  const currentParentName =
    currentParentSlug !== null ? (bySlug.get(currentParentSlug)?.name ?? null) : null;

  const nameOf = useCallback(
    (slug: string | null): string =>
      slug === null ? 'корень раздела' : (bySlug.get(slug)?.name ?? slug),
    [bySlug],
  );

  const perform = useCallback(
    async (slug: string, parentSlug: string | null, expectedParentSlug: string | null) => {
      const req = bySlug.get(slug);
      const fromName = nameOf(expectedParentSlug);
      const toName = nameOf(parentSlug);
      setFailedSlug(null);
      setError(null);
      try {
        const result = await moveMut.mutateAsync({ slug, parentSlug, expectedParentSlug });
        if (!result.changed) return;
        setLastMove({ slug, back: result.oldParentSlug });
        setRetryTarget(null);
        setHistory((h) =>
          [{ time: timeLabel(), name: req?.name ?? slug, from: fromName, to: toName }, ...h].slice(
            0,
            5,
          ),
        );
        toast.show(`«${req?.name ?? slug}» перемещено в «${toName}» · отменить Ctrl+Z`);
      } catch (err) {
        // Строка остаётся на прежнем месте (данные перечитываются мутацией) и
        // подсвечивается красным, пока пользователь не решит, что делать.
        setFailedSlug(slug);
        setRetryTarget({ slug, parentSlug });
        const conflict = err instanceof ApiError && err.code === 'STALE_PARENT';
        setError({
          message: conflict
            ? `«${req?.name ?? slug}» уже перевесили, пока вы двигали строку: ${errorMessage(err)} Перемещение не сохранено.`
            : `Перемещение не сохранено: ${errorMessage(err)}`,
          canRetry: true,
        });
      }
    },
    [bySlug, moveMut, nameOf, toast],
  );

  /** Запустить перемещение, спросив подтверждение для крупного поддерева. */
  const request = useCallback(
    (slug: string, parentSlug: string | null) => {
      const req = bySlug.get(slug);
      if (!req) return;
      const scopeOfReq = requirements.filter((r) => r.type === req.type);
      const descendants = collectDescendants(scopeOfReq, slug);
      const expected = parentSlugOf(req) ?? null;
      if (descendants.length > SUBTREE_CONFIRM_THRESHOLD) {
        setPending({
          slug,
          name: req.name,
          parentSlug,
          parentName: nameOf(parentSlug),
          descendantNames: descendants.map((s) => bySlug.get(s)?.name ?? s),
          // Новая глубина самой строки: под корнем — 1, иначе уровень нового
          // родителя + 1. Потомки уезжают ещё глубже, но их глубина
          // относительно строки не меняется.
          newDepth: parentSlug === null ? 1 : levelOf(scopeOfReq, parentSlug) + 1,
        });
        return;
      }
      void perform(slug, parentSlug, expected);
    },
    [bySlug, nameOf, perform, requirements],
  );

  const applyOp = useCallback(
    (op: MoveOp) => {
      if (!selected) return;
      const option = options.find((o) => o.op === op);
      if (!option || option.disabledReason) return;
      request(selected.slug, option.parentSlug ?? null);
    },
    [options, request, selected],
  );

  const dropReasonFor = useCallback(
    (targetSlug: string | null): string | undefined => {
      if (!draggingSlug) return undefined;
      const dragged = bySlug.get(draggingSlug);
      if (!dragged) return 'Строка не найдена — обновите дерево';
      const target = targetSlug === null ? null : bySlug.get(targetSlug);
      if (targetSlug !== null && !target) return 'Строка не найдена — обновите дерево';
      // Срез строится по типу перетаскиваемой строки: цель другого типа в него
      // не попадёт, и checkMove честно ответит «иерархия только внутри типа».
      const scopeOfDrag = requirements.filter(
        (r) => r.type === dragged.type || r.slug === targetSlug,
      );
      return dropReason(scopeOfDrag, draggingSlug, targetSlug);
    },
    [bySlug, draggingSlug, requirements],
  );

  const dropOn = useCallback(
    (targetSlug: string | null) => {
      const slug = draggingSlug;
      setDraggingSlug(null);
      if (!slug || dropReasonFor(targetSlug)) return;
      setSelection(slug);
      request(slug, targetSlug);
    },
    [draggingSlug, dropReasonFor, request, setSelection],
  );

  const undo = useCallback(() => {
    if (!lastMove) return;
    const current = bySlug.get(lastMove.slug);
    void perform(lastMove.slug, lastMove.back, current ? (parentSlugOf(current) ?? null) : null);
    setLastMove(null);
  }, [bySlug, lastMove, perform]);

  // Клавиатурный путь целиком (NFR-7): без мыши доступны все операции и отмена.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
        return;
      }
      if (e.key === 'Escape') {
        setSelection(null);
        setDraggingSlug(null);
        return;
      }
      if (!selectedSlug) return;
      if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        applyOp('up');
      } else if (e.altKey && e.key === 'ArrowDown') {
        e.preventDefault();
        applyOp('down');
      } else if (e.key === 'Tab') {
        e.preventDefault();
        applyOp(e.shiftKey ? 'outdent' : 'indent');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, applyOp, selectedSlug, setSelection, undo]);

  return {
    active,
    selectedSlug,
    selected,
    currentParentName,
    level: selected ? levelOf(scope, selected.slug) : 0,
    depth: scope.length > 0 ? depthOf(scope) : 0,
    descendants: selected ? collectDescendants(scope, selected.slug).length : 0,
    options,
    draggingSlug,
    failedSlug,
    error,
    history,
    pending,
    busy: moveMut.isPending,
    canUndo: lastMove !== null,
    select: setSelection,
    startDrag: (slug) => {
      setSelection(slug);
      setDraggingSlug(slug);
    },
    endDrag: () => setDraggingSlug(null),
    dropReasonFor,
    dropOn,
    applyOp,
    confirmPending: () => {
      if (!pending) return;
      const req = bySlug.get(pending.slug);
      void perform(pending.slug, pending.parentSlug, req ? (parentSlugOf(req) ?? null) : null);
      setPending(null);
    },
    cancelPending: () => setPending(null),
    undo,
    retry: () => {
      if (!retryTarget) return;
      const req = bySlug.get(retryTarget.slug);
      // Повтор идёт БЕЗ expectedParentSlug: пользователь уже согласился с тем,
      // что на диске, и просит применить перемещение к актуальному дереву.
      void perform(
        retryTarget.slug,
        retryTarget.parentSlug,
        req ? (parentSlugOf(req) ?? null) : null,
      );
    },
    dismissError: () => {
      setError(null);
      setFailedSlug(null);
      setRetryTarget(null);
    },
    exit: () => setStructureMode(false),
  };
}
