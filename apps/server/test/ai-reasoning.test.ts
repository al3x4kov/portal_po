import { describe, expect, it } from 'vitest';
import { stripReasoning } from '../src/services/aiReasoning.js';

describe('todo_18 stripReasoning', () => {
  it('is a no-op when there is no <think> tag', () => {
    expect(stripReasoning('[{"nfr":"a","function":"b"}]')).toBe('[{"nfr":"a","function":"b"}]');
    expect(stripReasoning('обычный ответ без тегов')).toBe('обычный ответ без тегов');
    expect(stripReasoning('')).toBe('');
  });

  it('strips a leading <think>…</think> before a JSON array', () => {
    const raw =
      '<think>Подумаю: НФТ 1 связано с ФТ 2, тут есть [скобки].</think>\n[{"nfr":"a","function":"b"}]';
    expect(stripReasoning(raw)).toBe('[{"nfr":"a","function":"b"}]');
  });

  it('strips a trailing <think>…</think> after a JSON array', () => {
    const raw = '[{"nfr":"a","function":"b"}]<think>готово</think>';
    expect(stripReasoning(raw)).toBe('[{"nfr":"a","function":"b"}]');
  });

  it('strips reasoning wrapping the payload on both sides', () => {
    const raw = '<think>начало</think>ПОЛЕЗНОЕ<think>конец</think>';
    expect(stripReasoning(raw)).toBe('ПОЛЕЗНОЕ');
  });

  it('is case-insensitive and tolerates attributes', () => {
    expect(stripReasoning('<THINK>x</THINK> answer')).toBe('answer');
    expect(stripReasoning('<think lang="ru">x</think>answer')).toBe('answer');
  });

  it('handles a dangling close tag with no matching open', () => {
    expect(stripReasoning('рассуждение без открытия</think>[1,2]')).toBe('[1,2]');
  });

  it('handles an unterminated open tag (truncated reasoning)', () => {
    expect(stripReasoning('[1,2]<think>обрыв рассуждения без конца')).toBe('[1,2]');
  });
});
