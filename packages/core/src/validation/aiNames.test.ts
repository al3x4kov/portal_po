import { describe, it, expect } from 'vitest';
import { sanitizeAiName, sanitizeAiParentName } from './aiNames.js';

/**
 * Реальные образцы из журнала импорта (testik12t.md): модель отдавала строку
 * «null» вместо JSON-null и имена с приклеенным хвостом своего же ответа —
 * портал создавал требования «null» и «Домен → null}, {».
 */
describe('sanitizeAiName', () => {
  it('пропускает нормальные имена без изменений', () => {
    for (const name of [
      'Авторизация и аутентификация',
      'Интеграция с OneWork',
      'Доступность Developer portal (WIDP)',
      'REST API v2',
      'Мониторинг и системный журнал',
    ]) {
      expect(sanitizeAiName(name)).toBe(name);
    }
  });

  it('отбраковывает слова-заглушки в любом регистре', () => {
    for (const raw of ['null', 'NULL', ' Null ', 'undefined', 'none', 'N/A', 'nil', 'nan']) {
      expect(sanitizeAiName(raw), raw).toBeNull();
    }
  });

  it('отбраковывает пустое и строки без букв и цифр', () => {
    for (const raw of ['', '   ', '-', '—', '...', '…', '?', '{}', '", "', '::']) {
      expect(sanitizeAiName(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('срезает приклеенный хвост JSON из ответа модели', () => {
    expect(sanitizeAiName('Доступность и надежность → null}, {')).toBe('Доступность и надежность');
    expect(sanitizeAiName('Устанавливаемость в Kubernetes → null}, {')).toBe(
      'Устанавливаемость в Kubernetes',
    );
    expect(sanitizeAiName('Отчеты и выгрузки"}, {"type": "NFR"')).toBe('Отчеты и выгрузки');
    expect(sanitizeAiName('Каталоги [и шаблоны]')).toBe('Каталоги');
  });

  it('срезает скопированный формат «имя → родитель» в обоих написаниях стрелки', () => {
    expect(sanitizeAiName('Уведомления и CSAT → Платформа')).toBe('Уведомления и CSAT');
    expect(sanitizeAiName('Уведомления -> Платформа')).toBe('Уведомления');
  });

  it('снимает обрамляющие кавычки и хвостовую пунктуацию', () => {
    expect(sanitizeAiName('«Заявки и публикации»')).toBe('Заявки и публикации');
    expect(sanitizeAiName('"Интеграции и API",')).toBe('Интеграции и API');
    expect(sanitizeAiName('Конфигурация и установка;')).toBe('Конфигурация и установка');
  });

  it('схлопывает пробелы и переводы строк', () => {
    expect(sanitizeAiName('  Управление\n\tпользователями   и ролями  ')).toBe(
      'Управление пользователями и ролями',
    );
  });

  it('имя, состоящее только из хвоста, отбраковывается целиком', () => {
    expect(sanitizeAiName('→ null}, {')).toBeNull();
    expect(sanitizeAiName('{"type": "NFR"}')).toBeNull();
  });
});

describe('sanitizeAiParentName', () => {
  it('строковый «null» означает отсутствие родителя, а не домен «null»', () => {
    expect(sanitizeAiParentName('null')).toBeNull();
    expect(sanitizeAiParentName('NULL')).toBeNull();
  });

  it('настоящий null/undefined остаются отсутствием родителя', () => {
    expect(sanitizeAiParentName(null)).toBeNull();
    expect(sanitizeAiParentName(undefined)).toBeNull();
  });

  it('осмысленное имя родителя сохраняется', () => {
    expect(sanitizeAiParentName('Платформа')).toBe('Платформа');
  });
});
