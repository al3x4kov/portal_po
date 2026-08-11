import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Requirement } from '@po/core';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { FsProjectRepo } from '../src/repositories/FsProjectRepo.js';
import { FsRequirementRepo } from '../src/repositories/FsRequirementRepo.js';
import { RequirementService } from '../src/services/RequirementService.js';
import { LinkService } from '../src/services/LinkService.js';
import { cleanup, fixedNow, makeTmpRoot, reqInput } from './helpers.js';

/**
 * Перемещение строки — злонамеренные сценарии.
 *
 * `move-requirement.test.ts` проверяет обещанное поведение. Здесь — то, чего
 * никто не обещал, но что случается: файлы, повреждённые чужой рукой или
 * прерванным импортом, одновременные перемещения, глубокие деревья и мусор в
 * теле запроса. Инвариант один и тот же во всех случаях: у строки на диске
 * ровно один CHILD_OF, обратная сторона согласована, а отказ приходит кодом,
 * а не пятисоткой.
 */
describe('LinkService.move · повреждённые данные на диске', () => {
  let root: string;
  let repo: FsRequirementRepo;
  let reqs: RequirementService;
  let links: LinkService;
  let feed: Requirement;
  let algo: Requirement;
  let dm: Requirement;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    repo = new FsRequirementRepo(root, 'P');
    reqs = new RequirementService(repo, fixedNow);
    links = new LinkService(repo, fixedNow);
    feed = await reqs.create(reqInput({ name: 'Лента' }));
    algo = await reqs.create(reqInput({ name: 'Алгоритмическая лента' }));
    dm = await reqs.create(reqInput({ name: 'Личные сообщения' }));
    await links.create({ sourceSlug: algo.slug, type: 'CHILD_OF', targetSlug: feed.slug });
  });
  afterEach(async () => {
    await cleanup(root);
  });

  const load = async (slug: string): Promise<Requirement> => {
    const { requirements } = await repo.loadAll();
    return requirements.find((r) => r.slug === slug)!;
  };
  const childOf = async (slug: string): Promise<string[]> =>
    (await load(slug)).links.filter((l) => l.type === 'CHILD_OF').map((l) => l.targetSlug);

  /** Записать требование мимо сервисов — так на диске появляется то, что руками правил человек. */
  const writeRaw = async (req: Requirement): Promise<void> => {
    await repo.applyBatch([{ kind: 'write', req }]);
  };

  it('висячий родитель (файл родителя удалён руками) не мешает перенести строку', async () => {
    const orphan = await load(algo.slug);
    orphan.links = [{ type: 'CHILD_OF', targetSlug: 'ghost-parent' }];
    await writeRaw(orphan);
    // Порча должна реально лечь на диск, иначе тест ничего не проверяет.
    expect(await childOf(algo.slug)).toEqual(['ghost-parent']);

    // Клиент видит строку в корне (родителя-то нет) и просит перенести её под ЛС.
    const res = await links.move({ childSlug: algo.slug, newParentSlug: dm.slug });

    expect(res.newParentSlug).toBe(dm.slug);
    // Висячая связь снята, а не осталась вторым родителем.
    expect(await childOf(algo.slug)).toEqual([dm.slug]);
  });

  it('две связи CHILD_OF в файле схлопываются в одну после перемещения', async () => {
    const twoParents = await load(algo.slug);
    twoParents.links = [
      { type: 'CHILD_OF', targetSlug: feed.slug },
      { type: 'CHILD_OF', targetSlug: dm.slug },
    ];
    await writeRaw(twoParents);
    expect(await childOf(algo.slug)).toHaveLength(2);

    await links.move({
      childSlug: algo.slug,
      newParentSlug: dm.slug,
      expectedParentSlug: feed.slug,
    });

    expect(await childOf(algo.slug)).toEqual([dm.slug]);
  });

  it('цикл, уже записанный в файлы, не вешает сервис — приходит отказ', async () => {
    // A → B → A: такого не создать через API, но так выглядит файл после
    // прерванного импорта или ручной правки.
    const a = await load(feed.slug);
    a.links = [{ type: 'CHILD_OF', targetSlug: algo.slug }];
    await writeRaw(a);
    const b = await load(algo.slug);
    b.links = [{ type: 'CHILD_OF', targetSlug: feed.slug }];
    await writeRaw(b);

    // Главное — терминировать: обойти цикл и ответить, а не крутиться вечно.
    await expect(
      Promise.race([
        links.move({ childSlug: feed.slug, newParentSlug: dm.slug }).then(
          () => 'resolved',
          () => 'rejected',
        ),
        new Promise((r) => setTimeout(() => r('hung'), 4000)),
      ]),
    ).resolves.not.toBe('hung');
  });

  it('тело файла и поля требования переживают перемещение без потерь', async () => {
    const rich = await reqs.create(
      reqInput({
        name: 'Экспорт ленты',
        description: 'Многострочное описание.\n\nВторой абзац с *разметкой* и «кавычками».',
        implemented: false,
        targetQuarter: 'Q3',
        targetYear: 2027,
      }),
    );
    const before = await load(rich.slug);

    await links.move({ childSlug: rich.slug, newParentSlug: feed.slug });

    const after = await load(rich.slug);
    expect(after.description).toBe(before.description);
    expect(after.name).toBe(before.name);
    expect(after.criticality).toBe(before.criticality);
    expect(after.implemented).toBe(before.implemented);
    expect(after.targetQuarter).toBe(before.targetQuarter);
    expect(after.targetYear).toBe(before.targetYear);
  });

  it('перемещение «туда же» ничего не пишет — updatedAt строки не меняется', async () => {
    let tick = 0;
    const movingClock = (): string => `2026-06-29T10:0${tick++}:00.000Z`;
    const svc = new LinkService(repo, movingClock);

    const before = (await load(algo.slug)).updatedAt;
    const res = await svc.move({ childSlug: algo.slug, newParentSlug: feed.slug });

    expect(res.changed).toBe(false);
    expect((await load(algo.slug)).updatedAt).toBe(before);
  });
});

describe('LinkService.move · одновременные перемещения', () => {
  let root: string;
  let repo: FsRequirementRepo;
  let links: LinkService;
  let feed: Requirement;
  let dm: Requirement;
  let a: Requirement;
  let b: Requirement;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    repo = new FsRequirementRepo(root, 'P');
    const reqs = new RequirementService(repo, fixedNow);
    links = new LinkService(repo, fixedNow);
    feed = await reqs.create(reqInput({ name: 'Лента' }));
    dm = await reqs.create(reqInput({ name: 'Личные сообщения' }));
    a = await reqs.create(reqInput({ name: 'Алгоритмическая лента' }));
    b = await reqs.create(reqInput({ name: 'Бесконечная прокрутка' }));
    await links.create({ sourceSlug: a.slug, type: 'CHILD_OF', targetSlug: feed.slug });
    await links.create({ sourceSlug: b.slug, type: 'CHILD_OF', targetSlug: feed.slug });
  });
  afterEach(async () => {
    await cleanup(root);
  });

  const load = async (slug: string): Promise<Requirement> => {
    const { requirements } = await repo.loadAll();
    return requirements.find((r) => r.slug === slug)!;
  };

  it('две гонки за одну строку не оставляют её с двумя родителями', async () => {
    const results = await Promise.allSettled([
      links.move({ childSlug: a.slug, newParentSlug: dm.slug }),
      links.move({ childSlug: a.slug, newParentSlug: feed.slug }),
    ]);
    // Одна из операций может честно отказать (SAME_PARENT/конфликт) — это норма.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);

    const parents = (await load(a.slug)).links.filter((l) => l.type === 'CHILD_OF');
    expect(parents).toHaveLength(1);
    // Обратная сторона согласована: строка числится ребёнком ровно у одного родителя.
    const claimed = [await load(feed.slug), await load(dm.slug)].filter((p) =>
      p.links.some((l) => l.type === 'PARENT_OF' && l.targetSlug === a.slug),
    );
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.slug).toBe(parents[0]!.targetSlug);
  });

  it('одновременный переезд двух строк к одному родителю не теряет ни одну', async () => {
    await Promise.all([
      links.move({ childSlug: a.slug, newParentSlug: dm.slug }),
      links.move({ childSlug: b.slug, newParentSlug: dm.slug }),
    ]);

    const parent = await load(dm.slug);
    const adopted = parent.links
      .filter((l) => l.type === 'PARENT_OF')
      .map((l) => l.targetSlug)
      .sort();
    expect(adopted).toEqual([a.slug, b.slug].sort());
    // И старый родитель отпустил обеих.
    expect((await load(feed.slug)).links.filter((l) => l.type === 'PARENT_OF')).toHaveLength(0);
  });
});

describe('LinkService.move · глубокое дерево', () => {
  let root: string;
  let repo: FsRequirementRepo;
  let links: LinkService;
  let chain: Requirement[];

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    repo = new FsRequirementRepo(root, 'P');
    const reqs = new RequirementService(repo, fixedNow);
    links = new LinkService(repo, fixedNow);
    chain = [];
    for (let i = 0; i < 40; i++) {
      const req = await reqs.create(reqInput({ name: `Уровень ${String(i).padStart(2, '0')}` }));
      if (i > 0) {
        await links.create({
          sourceSlug: req.slug,
          type: 'CHILD_OF',
          targetSlug: chain[i - 1]!.slug,
        });
      }
      chain.push(req);
    }
  });
  afterEach(async () => {
    await cleanup(root);
  });

  it('лист цепочки в 40 уровней выносится в корень', async () => {
    const leaf = chain[chain.length - 1]!;
    const res = await links.move({ childSlug: leaf.slug, newParentSlug: null });
    expect(res.changed).toBe(true);
    expect(res.newParentSlug).toBeNull();
  });

  it('корень нельзя увести под собственного глубокого потомка', async () => {
    await expect(
      links.move({ childSlug: chain[0]!.slug, newParentSlug: chain[39]!.slug }),
    ).rejects.toMatchObject({ code: 'CYCLE' });
  });

  it('перенос середины цепочки тащит весь хвост', async () => {
    const res = await links.move({ childSlug: chain[20]!.slug, newParentSlug: null });
    expect(res.movedDescendants).toBe(19);
  });
});

describe('PUT …/parent · мусор в запросе и опасные слаги', () => {
  let root: string;
  let app: FastifyInstance;
  let feed: Requirement;
  let child: Requirement;

  beforeEach(async () => {
    root = await makeTmpRoot();
    await new FsProjectRepo(root).create('P', fixedNow);
    const repo = new FsRequirementRepo(root, 'P');
    const reqs = new RequirementService(repo, fixedNow);
    const links = new LinkService(repo, fixedNow);
    feed = await reqs.create(reqInput({ name: 'Лента новостей' }));
    child = await reqs.create(reqInput({ name: 'Бесконечная прокрутка' }));
    await links.create({ sourceSlug: child.slug, type: 'CHILD_OF', targetSlug: feed.slug });
    app = await buildApp({ projectsRoot: root, now: fixedNow, logger: false });
  });
  afterEach(async () => {
    await app.close();
    await cleanup(root);
  });

  const move = (slug: string, payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: `/api/projects/P/requirements/${encodeURIComponent(slug)}/parent`,
      payload: payload as Record<string, unknown>,
    });

  it('parentSlug числом — 422 VALIDATION, а не приведение типа', async () => {
    const res = await move(child.slug, { parentSlug: 42 });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION');
  });

  it('expectedParentSlug неверного типа тоже отбивается контрактом', async () => {
    const res = await move(child.slug, { parentSlug: null, expectedParentSlug: 7 });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION');
  });

  it('пустая строка вместо parentSlug не создаёт родителя-призрака', async () => {
    const res = await move(child.slug, { parentSlug: '' });
    expect([404, 422]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
  });

  it('обход каталога в слаге строки не выходит за Projects и не даёт 500', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/P/requirements/..%2F..%2F..%2Fetc%2Fpasswd/parent',
      payload: { parentSlug: null },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 403, 404, 422]).toContain(res.statusCode);
  });

  it('обход каталога в слаге родителя тоже отбивается', async () => {
    const res = await move(child.slug, { parentSlug: '../../../etc/passwd' });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 403, 404, 422]).toContain(res.statusCode);
  });

  it('родитель из другого проекта — 404, а не молчаливая склейка проектов', async () => {
    await new FsProjectRepo(root).create('Q', fixedNow);
    const other = await new RequirementService(new FsRequirementRepo(root, 'Q'), fixedNow).create(
      reqInput({ name: 'Чужое требование' }),
    );

    const res = await move(child.slug, { parentSlug: other.slug });
    expect(res.statusCode).toBe(404);
  });

  it('тело null и тело-массив не роняют роут', async () => {
    for (const payload of [null, [], 'строка']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/P/requirements/${encodeURIComponent(child.slug)}/parent`,
        payload: payload as never,
      });
      expect(res.statusCode).toBeLessThan(500);
    }
  });
});
