import { describe, it, expect, beforeEach } from 'vitest';
import {
  RECENT_PROJECTS_KEY,
  RECENT_PROJECTS_MAX,
  forgetRecentProject,
  formatOpenedAt,
  readRecentProjects,
  rememberRecentProject,
} from './recentProjects';

beforeEach(() => localStorage.removeItem(RECENT_PROJECTS_KEY));

describe('recentProjects storage (todo_17 T2)', () => {
  it('remembers a project on top and dedups by id', () => {
    rememberRecentProject({ id: 'a', name: 'A', mainPath: '/p/A' }, new Date('2026-07-01T10:00Z'));
    rememberRecentProject({ id: 'b', name: 'B', mainPath: '/p/B' }, new Date('2026-07-01T11:00Z'));
    rememberRecentProject({ id: 'a', name: 'A', mainPath: '/p/A' }, new Date('2026-07-01T12:00Z'));

    const list = readRecentProjects();
    expect(list.map((p) => p.id)).toEqual(['a', 'b']);
    expect(list[0].openedAt).toBe('2026-07-01T12:00:00.000Z');
  });

  it(`keeps at most ${RECENT_PROJECTS_MAX} entries`, () => {
    for (let i = 0; i < RECENT_PROJECTS_MAX + 3; i++) {
      rememberRecentProject({ id: `p${i}`, name: `P${i}` });
    }
    const list = readRecentProjects();
    expect(list).toHaveLength(RECENT_PROJECTS_MAX);
    expect(list[0].id).toBe(`p${RECENT_PROJECTS_MAX + 2}`);
  });

  it('forgets a deleted project', () => {
    rememberRecentProject({ id: 'a', name: 'A' });
    rememberRecentProject({ id: 'b', name: 'B' });
    forgetRecentProject('a');
    expect(readRecentProjects().map((p) => p.id)).toEqual(['b']);
  });

  it('tolerates corrupt or foreign localStorage content', () => {
    localStorage.setItem(RECENT_PROJECTS_KEY, 'не json');
    expect(readRecentProjects()).toEqual([]);
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify({ nope: true }));
    expect(readRecentProjects()).toEqual([]);
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify([{ id: 1 }, null, 'x']));
    expect(readRecentProjects()).toEqual([]);
  });
});

describe('formatOpenedAt', () => {
  const now = new Date('2026-07-05T12:00:00');

  it('«только что» within a minute', () => {
    expect(formatOpenedAt(new Date('2026-07-05T11:59:40').toISOString(), now)).toBe('только что');
  });

  it('minutes within an hour', () => {
    expect(formatOpenedAt(new Date('2026-07-05T11:15:00').toISOString(), now)).toBe('45 мин назад');
  });

  it('hours with Russian pluralization on the same day', () => {
    expect(formatOpenedAt(new Date('2026-07-05T10:00:00').toISOString(), now)).toBe('2 часа назад');
    expect(formatOpenedAt(new Date('2026-07-05T11:00:00').toISOString(), now)).toBe('1 час назад');
    expect(formatOpenedAt(new Date('2026-07-05T06:30:00').toISOString(), now)).toBe(
      '5 часов назад',
    );
  });

  it('«вчера» for the previous calendar day', () => {
    expect(formatOpenedAt(new Date('2026-07-04T23:00:00').toISOString(), now)).toBe('вчера');
  });

  it('«3 июля» for older dates', () => {
    expect(formatOpenedAt(new Date('2026-07-03T10:00:00').toISOString(), now)).toBe('3 июля');
  });

  it('empty string for an invalid timestamp', () => {
    expect(formatOpenedAt('мусор', now)).toBe('');
  });
});
