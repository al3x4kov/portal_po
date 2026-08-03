import { BookMarked, Briefcase, FileText, ListTodo, User, type LucideIcon } from 'lucide-react';
import type { SourceType } from '@po/core';

/** Human-readable label for a requirement source type (todo_19; BACKLOG — todo_22 PO №4). */
export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  CLIENT: 'Клиент / сделка',
  STAKEHOLDER: 'Стейкхолдер',
  STANDARD: 'Внутренний стандарт',
  BACKLOG: 'Бэклог',
  TEXT: 'Другое',
};

/** Distinct Lucide icon per source type (shape, not colour — НФТ-5). */
export const SOURCE_TYPE_ICON: Record<SourceType, LucideIcon> = {
  CLIENT: Briefcase,
  STAKEHOLDER: User,
  STANDARD: BookMarked,
  BACKLOG: ListTodo,
  TEXT: FileText,
};

/** Ordered list for select options (BACKLOG after STANDARD, TEXT stays last). */
export const SOURCE_TYPES_ORDER: readonly SourceType[] = [
  'CLIENT',
  'STAKEHOLDER',
  'STANDARD',
  'BACKLOG',
  'TEXT',
];
