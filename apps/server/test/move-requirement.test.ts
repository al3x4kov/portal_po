import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CycleError, SelfLinkError, TypeMismatchError, type Requirement } from '@po/core';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { LinkService } from '../src/services/LinkService.js';
import { NotFoundError, StaleParentError } from '../src/lib/errors.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

/**
 * Перемещение строки по дереву (режим структуры). Проверяется ровно то, что
 * обещают макеты: меняется ОДНА связь CHILD_OF, обе стороны переписываются
 * атомарно, потомки едут вместе, а запреты и конфликт версий отвечают
 * машиночитаемым кодом, а не «просто 500».
 */
describe('LinkService.move', () => {
  let root: string;
  let repo: FsRequirementRepo;
  let reqs: RequirementService;
  let links: LinkService;
  /** Лента → (Алгоритмическая → Ранжирование), Бесконечная; Личные сообщения. */
  let feed: Requirement;
  let algo: Requirement;
  let rank: Requirement;
  let infinite: Requirement;
  let dm: Requirement;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    repo = new FsRequirementRepo(root, 'P');
    reqs = new RequirementService(repo, fixedNow);
    links = new LinkService(repo, fixedNow);
    feed = await reqs.create(reqInput({ name: 'Лента' }));
    algo = await reqs.create(reqInput({ name: 'Алгоритмическая лента' }));
    rank = await reqs.create(reqInput({ name: 'Ранжирование по интересам' }));
    infinite = await reqs.create(reqInput({ name: 'Бесконечная прокрутка' }));
    dm = await reqs.create(reqInput({ name: 'Личные сообщения' }));
    await links.create({ sourceSlug: algo.slug, type: 'CHILD_OF', targetSlug: feed.slug });
    await links.create({ sourceSlug: rank.slug, type: 'CHILD_OF', targetSlug: algo.slug });
    await links.create({ sourceSlug: infinite.slug, type: 'CHILD_OF', targetSlug: feed.slug });
  });
  afterEach(async () => {
    await cleanup(root);
  });

  const load = async (slug: string): Promise<Requirement> => {
    const { requirements } = await repo.loadAll();
    return requirements.find((r) => r.slug === slug)!;
  };
  const parentOf = async (slug: string): Promise<string | undefined> =>
    (await load(slug)).links.find((l) => l.type === 'CHILD_OF')?.targetSlug;

  it('переносит строку в другую ветку: старая связь снята, новая создана', async () => {
    const res = await links.move({ childSlug: infinite.slug, newParentSlug: dm.slug });

    expect(res).toMatchObject({
      oldParentSlug: feed.slug,
      newParentSlug: dm.slug,
      changed: true,
      movedDescendants: 0,
    });
    expect(await parentOf(infinite.slug)).toBe(dm.slug);
    // Обратная сторона переписана у обоих родителей — «висячих» связей нет.
    expect((await load(feed.slug)).links).not.toContainEqual({
      type: 'PARENT_OF',
      targetSlug: infinite.slug,
    });
    expect((await load(dm.slug)).links).toContainEqual({
      type: 'PARENT_OF',
      targetSlug: infinite.slug,
    });
  });

  it('у требования остаётся ровно один родитель', async () => {
    await links.move({ childSlug: infinite.slug, newParentSlug: dm.slug });
    const parents = (await load(infinite.slug)).links.filter((l) => l.type === 'CHILD_OF');
    expect(parents).toHaveLength(1);
  });

  it('выносит строку в корень (parentSlug = null)', async () => {
    const res = await links.move({ childSlug: algo.slug, newParentSlug: null });
    expect(res.newParentSlug).toBeNull();
    expect(await parentOf(algo.slug)).toBeUndefined();
    expect((await load(feed.slug)).links).not.toContainEqual({
      type: 'PARENT_OF',
      targetSlug: algo.slug,
    });
  });

  it('потомки едут вместе и своих связей не теряют', async () => {
    const res = await links.move({ childSlug: algo.slug, newParentSlug: dm.slug });
    expect(res.movedDescendants).toBe(1);
    // Ранжирование по-прежнему ребёнок Алгоритмической — её связи не переписаны.
    expect(await parentOf(rank.slug)).toBe(algo.slug);
  });

  it('не трогает прочие связи требования (зависимости, ассоциации)', async () => {
    await links.create({ sourceSlug: infinite.slug, type: 'RELATES_TO', targetSlug: rank.slug });
    await links.move({ childSlug: infinite.slug, newParentSlug: dm.slug });
    expect((await load(infinite.slug)).links).toContainEqual({
      type: 'RELATES_TO',
      targetSlug: rank.slug,
    });
  });

  it('повторное перемещение туда же ничего не пишет (идемпотентность)', async () => {
    const res = await links.move({ childSlug: infinite.slug, newParentSlug: feed.slug });
    expect(res.changed).toBe(false);
    expect(await parentOf(infinite.slug)).toBe(feed.slug);
  });

  it('запрещает вложить раздел в собственного потомка — цикл', async () => {
    await expect(links.move({ childSlug: feed.slug, newParentSlug: rank.slug })).rejects.toThrow(
      CycleError,
    );
    expect(await parentOf(feed.slug)).toBeUndefined();
  });

  it('запрещает бросок строки на саму себя', async () => {
    await expect(
      links.move({ childSlug: infinite.slug, newParentSlug: infinite.slug }),
    ).rejects.toThrow(SelfLinkError);
  });

  it('запрещает смешивать типы: НФТ не становится ребёнком ФТ', async () => {
    const uptime = await reqs.create(reqInput({ type: 'NFR', name: 'Доступность 99.95%' }));
    await expect(links.move({ childSlug: uptime.slug, newParentSlug: feed.slug })).rejects.toThrow(
      TypeMismatchError,
    );
  });

  it('неизвестный слаг — NotFoundError, а не молчаливый успех', async () => {
    await expect(links.move({ childSlug: 'ghost', newParentSlug: dm.slug })).rejects.toThrow(
      NotFoundError,
    );
    await expect(links.move({ childSlug: infinite.slug, newParentSlug: 'ghost' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('конфликт версий: родитель на диске другой — перемещение отклонено', async () => {
    // Кто-то другой уже перевесил строку, пока пользователь её двигал.
    await links.move({ childSlug: infinite.slug, newParentSlug: dm.slug });

    const attempt = links.move({
      childSlug: infinite.slug,
      newParentSlug: algo.slug,
      expectedParentSlug: feed.slug,
    });
    await expect(attempt).rejects.toThrow(StaleParentError);
    // Чужое изменение не перезаписано.
    expect(await parentOf(infinite.slug)).toBe(dm.slug);
  });

  it('конфликт несёт актуального родителя, чтобы клиент показал правду', async () => {
    await links.move({ childSlug: infinite.slug, newParentSlug: dm.slug });
    try {
      await links.move({
        childSlug: infinite.slug,
        newParentSlug: algo.slug,
        expectedParentSlug: feed.slug,
      });
      throw new Error('expected StaleParentError');
    } catch (err) {
      expect(err).toBeInstanceOf(StaleParentError);
      expect((err as StaleParentError).actualParentSlug).toBe(dm.slug);
    }
  });

  it('ожидание «строка в корне» тоже проверяется', async () => {
    await expect(
      links.move({ childSlug: infinite.slug, newParentSlug: dm.slug, expectedParentSlug: null }),
    ).rejects.toThrow(StaleParentError);
  });
});

describe('PUT /api/projects/:id/requirements/:rid/parent', () => {
  let root: string;
  let app: FastifyInstance;
  let feed: Requirement;
  let infinite: Requirement;
  let dm: Requirement;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    const repo = new FsRequirementRepo(root, 'P');
    const reqs = new RequirementService(repo, fixedNow);
    const links = new LinkService(repo, fixedNow);
    feed = await reqs.create(reqInput({ name: 'Лента' }));
    infinite = await reqs.create(reqInput({ name: 'Бесконечная прокрутка' }));
    dm = await reqs.create(reqInput({ name: 'Личные сообщения' }));
    await links.create({ sourceSlug: infinite.slug, type: 'CHILD_OF', targetSlug: feed.slug });
    app = await buildApp({ projectsRoot: root, now: fixedNow, logger: false });
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  const move = (slug: string, payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: `/api/projects/P/requirements/${slug}/parent`,
      payload: payload as Record<string, unknown>,
    });

  it('200 и описание изменения на успешном перемещении', async () => {
    const res = await move(infinite.slug, { parentSlug: dm.slug, expectedParentSlug: feed.slug });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      childSlug: infinite.slug,
      oldParentSlug: feed.slug,
      newParentSlug: dm.slug,
      changed: true,
    });
  });

  it('409 STALE_PARENT с актуальным родителем при конфликте', async () => {
    await move(infinite.slug, { parentSlug: dm.slug });
    const res = await move(infinite.slug, {
      parentSlug: feed.slug,
      expectedParentSlug: feed.slug,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'STALE_PARENT',
      details: { actualParentSlug: dm.slug },
    });
  });

  it('409 CYCLE при попытке вложить раздел в его потомка', async () => {
    const res = await move(feed.slug, { parentSlug: infinite.slug });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CYCLE');
  });

  it('422 TYPE_MISMATCH для ФТ под НФТ', async () => {
    const repo = new FsRequirementRepo(root, 'P');
    const uptime = await new RequirementService(repo, fixedNow).create(
      reqInput({ type: 'NFR', name: 'Доступность 99.95%' }),
    );
    const res = await move(infinite.slug, { parentSlug: uptime.slug });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('TYPE_MISMATCH');
  });

  it('404 для несуществующего проекта и требования', async () => {
    const noProject = await app.inject({
      method: 'PUT',
      url: `/api/projects/ghost/requirements/${infinite.slug}/parent`,
      payload: { parentSlug: null },
    });
    expect(noProject.statusCode).toBe(404);
    expect((await move('ghost', { parentSlug: null })).statusCode).toBe(404);
  });

  it('422 на теле без parentSlug — контракт обязателен', async () => {
    const res = await move(infinite.slug, {});
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION');
  });
});
