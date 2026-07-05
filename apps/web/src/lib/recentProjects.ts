/**
 * «Недавние проекты» on the Start screen (T2, todo_17).
 *
 * PO decision: there is no API/log of openings, so recents live in
 * localStorage only. Every open / create / import of a project calls
 * `rememberRecentProject`; deleting a project calls `forgetRecentProject`.
 */

export const RECENT_PROJECTS_KEY = 'po.recentProjects';
/** The Start mockup shows at most five recent projects. */
export const RECENT_PROJECTS_MAX = 5;

export interface RecentProject {
  id: string;
  name: string;
  /** Absolute Main Path shown as secondary text (optional for forward compat). */
  mainPath?: string;
  /** ISO timestamp of the last open/create/import. */
  openedAt: string;
}

function isRecentProject(value: unknown): value is RecentProject {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.name === 'string' &&
    typeof v.openedAt === 'string' &&
    (v.mainPath === undefined || typeof v.mainPath === 'string')
  );
}

/** Read the recents list; corrupt/foreign data degrades to an empty list. */
export function readRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentProject).slice(0, RECENT_PROJECTS_MAX);
  } catch {
    return [];
  }
}

function write(list: RecentProject[]): void {
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(list.slice(0, RECENT_PROJECTS_MAX)));
  } catch {
    // Quota/private mode — recents are a convenience, never fail the action.
  }
}

/** Put the project on top of the recents list (dedup by id). */
export function rememberRecentProject(
  project: { id: string; name: string; mainPath?: string },
  now: Date = new Date(),
): void {
  const rest = readRecentProjects().filter((p) => p.id !== project.id);
  write([
    {
      id: project.id,
      name: project.name,
      mainPath: project.mainPath,
      openedAt: now.toISOString(),
    },
    ...rest,
  ]);
}

/** Drop a project from recents (called after the project is deleted). */
export function forgetRecentProject(id: string): void {
  write(readRecentProjects().filter((p) => p.id !== id));
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Human-readable «when»: «только что» / «N мин назад» / «2 часа назад» /
 * «вчера» / «3 июля» — matching the Start mockup examples.
 */
export function formatOpenedAt(openedAt: string, now: Date = new Date()): string {
  const then = new Date(openedAt);
  if (Number.isNaN(then.getTime())) return '';

  const diffMs = now.getTime() - then.getTime();
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate();

  if (sameDay) {
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) return 'только что';
    if (minutes < 60) return `${minutes} мин назад`;
    const hours = Math.floor(minutes / 60);
    return `${hours} ${pluralRu(hours, 'час', 'часа', 'часов')} назад`;
  }

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (
    then.getFullYear() === yesterday.getFullYear() &&
    then.getMonth() === yesterday.getMonth() &&
    then.getDate() === yesterday.getDate()
  ) {
    return 'вчера';
  }

  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(then);
}
