import type { Criticality, GenerateDescriptionRequest, RequirementType } from '@po/core';

/** One OpenAI-style chat message. */
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const TYPE_LABEL: Record<RequirementType, string> = {
  FUNCTION: 'Функциональное требование (ФТ)',
  NFR: 'Нефункциональное требование (НФТ)',
};

const CRITICALITY_LABEL_RU: Record<Criticality, string> = {
  LOW: 'Низкая',
  MEDIUM: 'Средняя',
  HIGH: 'Высокая',
  CRITICAL: 'Критическая',
  BLOCKER: 'Блокер',
};

/**
 * System prompt (RU): role, explicit quality criteria (недвусмысленность /
 * понятность / корректность / проверяемость), portal style, the rule not to
 * invent facts beyond the given context ("Допущение: …"), and "return only the
 * text". Kept as a constant so the prompt-quality test can assert on it.
 */
const SYSTEM_PROMPT = [
  'Ты — ассистент по инженерии требований для портала управления требованиями Product Owner.',
  'Твоя задача — сформировать КАЧЕСТВЕННОЕ описание требования.',
  'Явные критерии качества, которым обязано соответствовать описание:',
  '- недвусмысленность: одна трактовка, без размытых формулировок;',
  '- понятность: простой и ясный язык, доступный команде и заказчику;',
  '- корректность: соответствие предоставленному контексту, без противоречий;',
  '- проверяемость: описание можно объективно проверить или протестировать.',
  'Стиль портала: конкретно и проверяемо, без «воды», 1–3 предложения или короткое',
  'структурированное описание. Пиши на русском языке.',
  'НЕ выдумывай факты сверх предоставленного контекста. Если требуется допущение —',
  'явно помечай его словом «Допущение:».',
  'Верни ТОЛЬКО текст описания — без преамбул, markdown-заголовков и кавычек.',
].join('\n');

/** A single few-shot example (good portal-style description) to anchor the style. */
const FEW_SHOT_USER = [
  'Проект: Интернет-магазин',
  'Требование: Функциональное требование (ФТ)',
  'Имя: Авторизация по email и паролю',
  'Критичность: Высокая',
  'Текущее описание отсутствует — сформируй описание с нуля.',
].join('\n');

const FEW_SHOT_ASSISTANT = [
  'Пользователь может войти в систему, указав email и пароль. При корректных учётных данных',
  'создаётся сессия и пользователь перенаправляется на главную страницу; при неверных данных',
  'показывается сообщение об ошибке без раскрытия, какое из полей неверно. После 5 неудачных',
  'попыток вход временно блокируется на 15 минут.',
].join(' ');

/**
 * Build the chat messages for description generation (pure, unit-tested apart
 * from the network). Structure: system → one few-shot example (user+assistant)
 * → the real user context. Empty/absent context fields are omitted entirely.
 */
export function buildDescriptionMessages(input: GenerateDescriptionRequest): AiChatMessage[] {
  const { requirement, projectName, projectDescription, userHint } = input;

  const lines: string[] = [];
  if (projectName && projectName.trim()) lines.push(`Проект: ${projectName.trim()}`);
  if (projectDescription && projectDescription.trim())
    lines.push(`Описание проекта: ${projectDescription.trim()}`);
  lines.push(`Требование: ${TYPE_LABEL[requirement.type]}`);
  lines.push(`Имя: ${requirement.name}`);
  lines.push(`Критичность: ${CRITICALITY_LABEL_RU[requirement.criticality]}`);

  const current = requirement.description?.trim();
  if (current) {
    lines.push(`Текущее описание: ${current}`);
    lines.push('Задача: улучшить и дополнить текущее описание, сохранив его смысл.');
  } else {
    lines.push('Текущее описание отсутствует. Задача: сформировать описание с нуля.');
  }

  const hint = userHint?.trim();
  if (hint) lines.push(`Уточняющая подсказка пользователя: ${hint}`);

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: FEW_SHOT_USER },
    { role: 'assistant', content: FEW_SHOT_ASSISTANT },
    { role: 'user', content: lines.join('\n') },
  ];
}
