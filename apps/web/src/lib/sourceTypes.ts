import { BookMarked, Briefcase, FileText, User, type LucideIcon } from 'lucide-react';
import type { SourceType } from '@po/core';

/** Human-readable label for a requirement source type (todo_19). */
export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  CLIENT: 'Клиент / сделка',
  STAKEHOLDER: 'Стейкхолдер',
  STANDARD: 'Внутренний стандарт',
  TEXT: 'Другое',
};

/** Distinct Lucide icon per source type (shape, not colour — НФТ-5). */
export const SOURCE_TYPE_ICON: Record<SourceType, LucideIcon> = {
  CLIENT: Briefcase,
  STAKEHOLDER: User,
  STANDARD: BookMarked,
  TEXT: FileText,
};

/** Ordered list for select options. */
export const SOURCE_TYPES_ORDER: readonly SourceType[] = [
  'CLIENT',
  'STAKEHOLDER',
  'STANDARD',
  'TEXT',
];
