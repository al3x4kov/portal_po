import { describe, expect, it } from 'vitest';
import type { AiChatRequest, GenerateDescriptionRequest } from '@po/core';
import { buildChatMessages, buildDescriptionMessages } from '../src/services/aiPrompt.js';

const base: GenerateDescriptionRequest = {
  projectId: 'Demo',
  requirement: { name: 'Экспорт отчёта', type: 'FUNCTION', criticality: 'HIGH' },
};

describe('T-802 buildDescriptionMessages', () => {
  it('starts with a Russian system message carrying the quality criteria', () => {
    const [system] = buildDescriptionMessages(base);
    expect(system.role).toBe('system');
    for (const criterion of ['недвусмысленность', 'понятность', 'корректность', 'проверяемость']) {
      expect(system.content).toContain(criterion);
    }
    expect(system.content).toContain('Допущение:');
    expect(system.content).toContain('русском');
  });

  it('includes exactly one few-shot example (user + assistant) before the real user turn', () => {
    const msgs = buildDescriptionMessages(base);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('the final user message carries the requirement context', () => {
    const msgs = buildDescriptionMessages(base);
    const user = msgs[msgs.length - 1];
    expect(user.content).toContain('Экспорт отчёта');
    expect(user.content).toContain('Функциональное требование (ФТ)');
    expect(user.content).toContain('Высокая');
    expect(user.content).toContain('сформировать описание с нуля');
  });

  it('omits empty optional fields (no project/hint lines)', () => {
    const user = buildDescriptionMessages(base).at(-1)!;
    expect(user.content).not.toContain('Проект:');
    expect(user.content).not.toContain('Описание проекта:');
    expect(user.content).not.toContain('подсказка');
  });

  it('includes project, project description, existing description and user hint when present', () => {
    const user = buildDescriptionMessages({
      ...base,
      projectName: 'Портал',
      projectDescription: 'Управление требованиями',
      userHint: 'сделай упор на безопасность',
      requirement: { ...base.requirement, description: 'Черновик' },
    }).at(-1)!;
    expect(user.content).toContain('Проект: Портал');
    expect(user.content).toContain('Описание проекта: Управление требованиями');
    expect(user.content).toContain('Текущее описание: Черновик');
    expect(user.content).toContain('улучшить');
    expect(user.content).toContain('сделай упор на безопасность');
  });

  it('renders NFR type label', () => {
    const user = buildDescriptionMessages({
      ...base,
      requirement: { ...base.requirement, type: 'NFR' },
    }).at(-1)!;
    expect(user.content).toContain('Нефункциональное требование (НФТ)');
  });
});

describe('T-901 buildChatMessages', () => {
  const input: AiChatRequest = {
    messages: [
      { role: 'user', content: 'Помоги с критериями приёмки' },
      { role: 'assistant', content: 'Конечно, вот они.' },
      { role: 'user', content: 'Дополни первый пункт' },
    ],
  };

  it('starts with a Russian PO-assistant system prompt', () => {
    const [system] = buildChatMessages(input);
    expect(system.role).toBe('system');
    expect(system.content).toContain('Product Owner');
    expect(system.content).toContain('требован');
    expect(system.content).toContain('русском');
    expect(system.content).toContain('НЕ выдумывай');
  });

  it('appends the client history after the system prompt, unchanged', () => {
    const msgs = buildChatMessages(input);
    expect(msgs).toHaveLength(input.messages.length + 1);
    expect(msgs.slice(1)).toEqual(input.messages);
  });
});
