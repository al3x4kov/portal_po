import { describe, expect, it } from 'vitest';
import {
  AI_IMPORT_PO_GROUP_NAME_MAX,
  AI_IMPORT_PO_MAX_CHILDREN,
  AI_IMPORT_PO_MAX_ROOTS,
  nameKey,
  type AiStructureNode,
} from '@po/core';
import {
  PO_GROUP_DESCRIPTION,
  PO_GROUP_SOURCE,
  assignTaxonomyIds,
  emptyTaxonomy,
  materializeTaxonomy,
  mergeTaxonomyRound,
  resolveAssignments,
} from '../src/services/aiImport/poTaxonomy.js';

function node(over: Partial<AiStructureNode> = {}): AiStructureNode {
  return { type: 'FUNCTION', name: 'Домен', parentName: null, ...over };
}

describe('poTaxonomy · mergeTaxonomyRound (слияние раундов проектирования)', () => {
  it('добавляет корни и подгруппы; первый ответ побеждает при конфликте родителя', () => {
    const tax = emptyTaxonomy();
    const s1 = mergeTaxonomyRound(tax, [
      node({ name: 'Доступ' }),
      node({ name: 'Аутентификация', parentName: 'Доступ' }),
    ]);
    expect(s1.added).toBe(2);
    // Второй раунд пытается перевесить «Аутентификация» под другой корень — игнор.
    mergeTaxonomyRound(tax, [
      node({ name: 'Интеграции' }),
      node({ name: 'Аутентификация', parentName: 'Интеграции' }),
    ]);
    const auth = tax.nodes.get(nameKey('FUNCTION', 'Аутентификация'))!;
    expect(auth.parentKey).toBe(nameKey('FUNCTION', 'Доступ'));
  });

  it('неизвестный родитель создаётся как корневой домен неявно', () => {
    const tax = emptyTaxonomy();
    mergeTaxonomyRound(tax, [node({ name: 'Поиск', parentName: 'Каталог' })]);
    expect(tax.nodes.get(nameKey('FUNCTION', 'Каталог'))?.parentKey).toBeNull();
    expect(tax.nodes.get(nameKey('FUNCTION', 'Поиск'))?.parentKey).toBe(
      nameKey('FUNCTION', 'Каталог'),
    );
  });

  it('глубина ограничена двумя уровнями: внук перевешивается под корень', () => {
    const tax = emptyTaxonomy();
    mergeTaxonomyRound(tax, [
      node({ name: 'Каталог' }),
      node({ name: 'Поиск', parentName: 'Каталог' }),
    ]);
    const stats = mergeTaxonomyRound(tax, [node({ name: 'Фасеты', parentName: 'Поиск' })]);
    expect(stats.depthFlattened).toBe(1);
    expect(tax.nodes.get(nameKey('FUNCTION', 'Фасеты'))?.parentKey).toBe(
      nameKey('FUNCTION', 'Каталог'),
    );
  });

  it('кап корней на тип: лишние корневые домены отбрасываются со счётчиком', () => {
    const tax = emptyTaxonomy();
    const answer = Array.from({ length: AI_IMPORT_PO_MAX_ROOTS + 3 }, (_, i) =>
      node({ name: `Домен ${i + 1}` }),
    );
    const stats = mergeTaxonomyRound(tax, answer);
    expect(stats.rootsCapped).toBe(3);
    expect(tax.nodes.size).toBe(AI_IMPORT_PO_MAX_ROOTS);
    // Кап независим по типам: NFR-корни ещё помещаются.
    const nfr = mergeTaxonomyRound(tax, [node({ type: 'NFR', name: 'Надёжность' })]);
    expect(nfr.added).toBe(1);
  });

  it('кап детей под одним корнем', () => {
    const tax = emptyTaxonomy();
    mergeTaxonomyRound(tax, [node({ name: 'Ядро' })]);
    const answer = Array.from({ length: AI_IMPORT_PO_MAX_CHILDREN + 2 }, (_, i) =>
      node({ name: `Раздел ${i + 1}`, parentName: 'Ядро' }),
    );
    const stats = mergeTaxonomyRound(tax, answer);
    expect(stats.childrenCapped).toBe(2);
  });

  it('нормализация имён: пробелы схлопываются, пустые узлы и само-родители не ломают дерево', () => {
    const tax = emptyTaxonomy();
    const stats = mergeTaxonomyRound(tax, [
      node({ name: '  Импорт   данных ' }),
      node({ name: '   ' }),
      node({ name: 'Импорт данных', parentName: 'Импорт данных' }),
      node({ name: `Д${'x'.repeat(AI_IMPORT_PO_GROUP_NAME_MAX + 10)}` }),
    ]);
    expect(tax.nodes.get(nameKey('FUNCTION', 'Импорт данных'))?.parentKey).toBeNull();
    expect(stats.namesTruncated).toBe(1);
    for (const n of tax.nodes.values()) {
      expect(n.name.length).toBeLessThanOrEqual(AI_IMPORT_PO_GROUP_NAME_MAX);
    }
  });

  it('мусорные имена от модели не становятся узлами дерева (журнал testik12t)', () => {
    const tax = emptyTaxonomy();
    const stats = mergeTaxonomyRound(tax, [
      // Строковый «null» вместо JSON-null — раньше давал корневой домен «null».
      node({ name: 'null' }),
      node({ type: 'NFR', name: 'NULL' }),
      // Имя с приклеенным хвостом собственного ответа модели.
      node({ type: 'NFR', name: 'Доступность и надежность → null}, {' }),
      // Нормальный узел рядом с мусором обязан уцелеть.
      node({ name: 'Каталоги и шаблоны' }),
    ]);

    const names = [...tax.nodes.values()].map((n) => n.name).sort();
    expect(names).toEqual(['Доступность и надежность', 'Каталоги и шаблоны']);
    expect(stats.namesRejected).toBe(2);
  });

  it('строковый «null» в parentName означает корень, а не домен с таким именем', () => {
    const tax = emptyTaxonomy();
    mergeTaxonomyRound(tax, [node({ name: 'Отчеты и выгрузки', parentName: 'null' })]);

    const names = [...tax.nodes.values()].map((n) => n.name);
    expect(names).toEqual(['Отчеты и выгрузки']);
    expect(tax.nodes.get(nameKey('FUNCTION', 'Отчеты и выгрузки'))!.parentKey).toBeNull();
  });
});

describe('poTaxonomy · assignTaxonomyIds', () => {
  it('корни получают F1/N1… в порядке добавления, дети — F1.1…', () => {
    const tax = emptyTaxonomy();
    mergeTaxonomyRound(tax, [
      node({ name: 'Доступ' }),
      node({ name: 'Каталог' }),
      node({ name: 'Вход', parentName: 'Доступ' }),
      node({ name: 'Роли', parentName: 'Доступ' }),
      node({ type: 'NFR', name: 'Производительность' }),
    ]);
    const { list, byId } = assignTaxonomyIds(tax);
    expect(list.map((n) => n.id)).toEqual(['F1', 'F2', 'N1', 'F1.1', 'F1.2']);
    expect(byId.get('F1.2')?.name).toBe('Роли');
    expect(byId.get('N1')?.type).toBe('NFR');
  });
});

describe('poTaxonomy · materializeTaxonomy', () => {
  it('строит group-записи и карту родителей; коллизия с извлечённым — без синтетики', () => {
    const tax = emptyTaxonomy();
    mergeTaxonomyRound(tax, [
      node({ name: 'Доступ' }),
      node({ name: 'Вход', parentName: 'Доступ' }),
    ]);
    const extractedKeys = new Set([nameKey('FUNCTION', 'Вход')]);
    const { groups, parentNameByKey, collisions } = materializeTaxonomy(tax, extractedKeys);
    expect(groups).toEqual([
      {
        type: 'FUNCTION',
        name: 'Доступ',
        description: PO_GROUP_DESCRIPTION,
        source: PO_GROUP_SOURCE,
      },
    ]);
    expect(collisions).toEqual(['Вход']);
    // Требование-«группа» всё равно получает родителя из таксономии.
    expect(parentNameByKey.get(nameKey('FUNCTION', 'Вход'))).toBe('Доступ');
    expect(parentNameByKey.get(nameKey('FUNCTION', 'Доступ'))).toBeNull();
  });
});

describe('poTaxonomy · resolveAssignments', () => {
  function setup() {
    const tax = emptyTaxonomy();
    mergeTaxonomyRound(tax, [
      node({ name: 'Доступ' }),
      node({ name: 'Вход', parentName: 'Доступ' }),
      node({ type: 'NFR', name: 'Надёжность' }),
    ]);
    const { byId } = assignTaxonomyIds(tax);
    const parentNameByKey = materializeTaxonomy(tax, new Set()).parentNameByKey;
    return { byId, parentNameByKey };
  }

  it('раскладывает по id (регистронезависимо), null — явный корень', () => {
    const { byId, parentNameByKey } = setup();
    const batchKeys = new Set([nameKey('FUNCTION', 'SSO'), nameKey('FUNCTION', 'Экспорт')]);
    const stats = resolveAssignments(
      [
        { type: 'FUNCTION', name: 'SSO', node: 'f1.1' },
        { type: 'FUNCTION', name: 'Экспорт', node: null },
      ],
      byId,
      batchKeys,
      parentNameByKey,
    );
    expect(stats).toMatchObject({ assigned: 1, explicitRoots: 1 });
    expect(parentNameByKey.get(nameKey('FUNCTION', 'SSO'))).toBe('Вход');
    expect(parentNameByKey.get(nameKey('FUNCTION', 'Экспорт'))).toBeNull();
  });

  it('отбрасывает посторонние ответы, неизвестные id и узлы другого типа', () => {
    const { byId, parentNameByKey } = setup();
    const batchKeys = new Set([nameKey('FUNCTION', 'SSO'), nameKey('NFR', 'SLA')]);
    const stats = resolveAssignments(
      [
        { type: 'FUNCTION', name: 'Чужое', node: 'F1' },
        { type: 'FUNCTION', name: 'SSO', node: 'F9.9' },
        { type: 'NFR', name: 'SLA', node: 'F1' },
      ],
      byId,
      batchKeys,
      parentNameByKey,
    );
    expect(stats).toMatchObject({ foreign: 1, unknownNode: 1, typeMismatch: 1, assigned: 0 });
    expect(parentNameByKey.has(nameKey('FUNCTION', 'SSO'))).toBe(false);
  });

  it('требование, совпавшее с узлом таксономии, не переназначается ответом модели', () => {
    const { byId, parentNameByKey } = setup();
    const key = nameKey('FUNCTION', 'Вход');
    const batchKeys = new Set([key]);
    resolveAssignments(
      [{ type: 'FUNCTION', name: 'Вход', node: 'N1' }],
      byId,
      batchKeys,
      parentNameByKey,
    );
    expect(parentNameByKey.get(key)).toBe('Доступ');
  });
});
