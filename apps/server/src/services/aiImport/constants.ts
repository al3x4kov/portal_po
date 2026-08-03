/**
 * Shared constants for the AI-import pipeline (extracted from AiImportService
 * for BE-1). Re-exported from `../AiImportService.ts` so the public surface
 * (routes, tests) is unchanged.
 */

/* Mandatory user-facing texts (spec §4): readable message + "what to do next". */
export const AI_IMPORT_HINT_ARCHIVE =
  'Проверьте формат архива (zip или tar.gz) и размер до 200 МБ, соберите архив заново и повторите';
export const AI_IMPORT_HINT_NO_DOCS =
  'В архиве нет файлов документации (.md/.txt/.json/.yaml). Добавьте документацию в архив и повторите';
export const AI_IMPORT_HINT_CONFIGURE =
  'Настройте AI Hub: задайте API-ключ на экране AI и выберите модель';
export const AI_IMPORT_HINT_UPSTREAM =
  'Проверьте доступность AI Hub, корректность API-ключа и повторите анализ';
export const AI_IMPORT_HINT_UNPARSEABLE =
  'Модель вернула неструктурированный ответ. Попробуйте другую модель или повторите';
export const AI_IMPORT_HINT_POPULATE =
  'Часть элементов не создана (см. лог). Исправьте данные в проекте и повторите — существующие не будут задублированы';
export const AI_IMPORT_HINT_INTERNAL =
  'Повторите анализ; если ошибка повторяется — обратитесь к администратору.';

/** Defaults applied for gaps in the source (PO decision §3.1). */
export const AI_IMPORT_DEFAULT_CRITICALITY = 'MEDIUM' as const;

/** Attempts per AI call when the answer is not a valid JSON array (Task 13 A3/B2). */
export const AI_IMPORT_JSON_ATTEMPTS = 3;
