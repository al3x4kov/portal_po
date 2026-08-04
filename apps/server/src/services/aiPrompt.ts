import type {
  AiChatMessage as CoreChatMessage,
  AiChatRequest,
  Criticality,
  GenerateDescriptionRequest,
  RequirementType,
  TestModelKind,
} from '@po/core';

/**
 * One OpenAI-style chat message: the shared core turn (`user`/`assistant`)
 * widened with the server-only `system` role. Kept under the historical name
 * so existing imports keep working while the shape stays defined in `@po/core`.
 */
export type AiChatMessage = CoreChatMessage | { role: 'system'; content: string };

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

/**
 * System prompt (RU) for the floating chat widget (Task 9): a Product Owner
 * assistant inside the requirements-management portal. Concise, Russian, no
 * invented facts. Kept as a constant so prompt tests can assert on it.
 */
const CHAT_SYSTEM_PROMPT = [
  'Ты — ассистент Product Owner в портале управления требованиями.',
  'Помогаешь формулировать требования, критерии приёмки и описания,',
  'отвечаешь на вопросы по управлению требованиями.',
  'Отвечай кратко и по делу, на русском языке.',
  'НЕ выдумывай факты: если данных не хватает — скажи об этом и уточни вопрос.',
].join('\n');

/**
 * Build the chat-completion messages for the widget: the server-side system
 * prompt followed by the client-provided history (already length-limited by
 * {@link AiChatRequest}'s schema).
 */
export function buildChatMessages(input: AiChatRequest): AiChatMessage[] {
  return [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, ...input.messages];
}

/*
 * ── AI-генерация тестовых моделей (смок / крит-регресс / полная) ────────────
 */

/** Методика по виду модели — вставляется в system prompt тест-генерации. */
const TESTGEN_KIND_GUIDE: Record<TestModelKind, string> = {
  smoke: [
    'Вид модели: SMOKE. Для каждого требования — ОДИН быстрый кейс «функция жива»:',
    'минимальное действие, время выполнения ≤ 2 минут, без глубоких проверок.',
  ].join(' '),
  'crit-regression': [
    'Вид модели: КРИТИЧЕСКИЙ РЕГРЕСС. Для каждого требования — кейс с позитивным',
    'сценарием по основному действию И обязательным негативным сценарием',
    '(невалидные данные / нарушение предусловия / граничное значение).',
  ].join(' '),
  full: [
    'Вид модели: ПОЛНЫЙ РЕГРЕСС. Для каждого требования — развёрнутый кейс:',
    'позитивный happy-path по шагам, негативный сценарий и граничный случай;',
    'шаги конкретные и проверяемые.',
  ].join(' '),
};

/**
 * System prompt (RU) тест-генерации. Персона — senior QA; золотое правило то же,
 * что у извлечения из документации: использовать ТОЛЬКО переданные требования,
 * каждый кейс якорится их slug'ом (анти-галлюцинационная проверка сервера
 * отбрасывает всё, что ссылается на несуществующий slug).
 */
export function buildTestCasesSystemPrompt(kind: TestModelKind, negatives: boolean): string {
  return [
    'Ты — опытный senior QA-инженер. По списку требований продукта составь тест-кейсы',
    'для модели тестирования.',
    TESTGEN_KIND_GUIDE[kind],
    'Золотое правило: используй ТОЛЬКО переданные требования и их описания.',
    'Не выдумывай функций, экранов, кнопок и данных, которых нет в описаниях;',
    'если описание скудное — пиши шаги общо, но честно, без изобретённых деталей.',
    'Каждый кейс обязан ссылаться на требование полем slug — ровно тем значением,',
    'которое передано в списке. Ровно один кейс на каждое требование списка.',
    negatives
      ? 'Поля negativeSteps/negativeExpected обязательны для каждого кейса.'
      : 'Поля negativeSteps/negativeExpected НЕ включай.',
    'Ответ верни СТРОГО как JSON-объект вида {"cases":[{"slug":string,"title":string,',
    '"goal":string,"precondition":string,"steps":[string],"expected":string',
    negatives ? ',"negativeSteps":[string],"negativeExpected":string}]}.' : '}]}.',
    'Без markdown, без преамбул и пояснений.',
  ].join(' ');
}

/** Один элемент списка требований в user-сообщении тест-генерации. */
export interface TestGenRequirementInfo {
  slug: string;
  type: RequirementType;
  criticality: Criticality;
  name: string;
  description?: string;
  /** Имена прямых детей (контекст ветки для крит/полной модели). */
  childNames: string[];
}

/** Per-requirement description budget в промпте тест-генерации. */
export const AI_TESTGEN_DESC_CHARS = 400;

/** Build the two-message conversation for one test-generation batch. */
export function buildTestCasesMessages(
  kind: TestModelKind,
  requirements: TestGenRequirementInfo[],
  negatives: boolean,
): AiChatMessage[] {
  const lines = requirements.map((r) => {
    const desc = (r.description ?? '').replace(/\s+/g, ' ').trim();
    const short =
      desc.length > AI_TESTGEN_DESC_CHARS ? `${desc.slice(0, AI_TESTGEN_DESC_CHARS - 1)}…` : desc;
    const children = r.childNames.length > 0 ? ` · дети: ${r.childNames.join(', ')}` : '';
    return `${r.slug}\t${TYPE_LABEL[r.type]}\t${CRITICALITY_LABEL_RU[r.criticality]}\t${r.name}\t${short}${children}`;
  });
  const user = [
    `Требования (${requirements.length} шт., формат: slug, тип, критичность, имя, описание через табуляцию):`,
    ...lines,
  ].join('\n');
  return [
    { role: 'system', content: buildTestCasesSystemPrompt(kind, negatives) },
    { role: 'user', content: user },
  ];
}
