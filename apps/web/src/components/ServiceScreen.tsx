import { useEffect, useRef } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';

export type ServiceKind = 'ai' | 'rest' | 'mcp' | 'skill';

interface ServiceScreenProps {
  service: ServiceKind;
  onClose: () => void;
}

const TITLES: Record<ServiceKind, string> = {
  ai: 'AI-ready API',
  rest: 'REST API',
  mcp: 'MCP',
  skill: 'Skill',
};

/** Monospace code / config block, styled with design tokens. */
function CodeBlock({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <pre
      className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border p-3 font-mono text-xs leading-relaxed"
      style={{
        background: 'var(--color-surface-2)',
        borderColor: 'var(--color-border)',
        color: 'var(--color-text-2)',
      }}
    >
      {children}
    </pre>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>
        {title}
      </h3>
      <div className="space-y-3 text-sm" style={{ color: 'var(--color-text-2)' }}>
        {children}
      </div>
    </section>
  );
}

/** Full interactive Swagger UI and the machine-readable OpenAPI schema. */
const DOCS_URL = 'http://localhost:3000/docs';
const OPENAPI_URL = 'http://localhost:3000/openapi.json';

const REST_ENDPOINTS: ReadonlyArray<{ method: string; path: string; desc: string }> = [
  { method: 'GET', path: '/api/projects', desc: 'список проектов (у каждого — свой id)' },
  { method: 'POST', path: '/api/projects', desc: 'создать проект' },
  {
    method: 'GET',
    path: '/api/projects/{id}/requirements',
    desc: 'список/дерево (query format=json|openspec)',
  },
  { method: 'POST', path: '/api/projects/{id}/requirements', desc: 'создать требование' },
  { method: 'PUT', path: '/api/projects/{id}/requirements/{slug}', desc: 'изменить требование' },
  { method: 'DELETE', path: '/api/projects/{id}/requirements/{slug}', desc: 'удалить требование' },
  { method: 'POST', path: '/api/projects/{id}/links', desc: 'создать связь' },
  {
    method: 'GET',
    path: '/api/projects/{id}/export',
    desc: 'экспорт архива (query format=zip|targz)',
  },
];

/** All MCP tools. Every tool except `list_projects` takes a `projectId` argument. */
const MCP_TOOLS: ReadonlyArray<{ name: string; args: string }> = [
  { name: 'list_projects', args: '—' },
  { name: 'get_project', args: 'projectId' },
  { name: 'list_requirements', args: 'projectId' },
  { name: 'get_requirement', args: 'projectId, slug' },
  { name: 'create_requirement', args: 'projectId, type, name, criticality, …' },
  { name: 'update_requirement', args: 'projectId, slug, …' },
  { name: 'link_requirements', args: 'projectId, sourceSlug, type, targetSlug' },
  { name: 'delete_requirement', args: 'projectId, slug' },
  { name: 'export_project', args: 'projectId, format' },
];

const MCP_CONFIG = `{
  "mcpServers": {
    "project-po": {
      "command": "node",
      "args": ["/абсолютный/путь/apps/mcp/dist/main.js"],
      "env": { "PROJECTS_ROOT": "/абсолютный/путь/Projects" }
    }
  }
}`;

/** Downloadable `/extract` skill (served as a static asset) + GigaCode CLI links. */
const SKILL_DOWNLOAD_URL = '/skills/project-po-extract.skill.md';
const GIGACODE_URL = 'https://gitverse.ru/features/gigacode/';

const SKILL_GIGACODE_SETUP = `# 1. каталог скилла в домашней конфигурации GigaCode
mkdir -p ~/.gigacode/skills/project-po-extract

# 2. положить скачанный файл как SKILL.md
mv ~/Downloads/project-po-extract.skill.md \\
   ~/.gigacode/skills/project-po-extract/SKILL.md`;

/** Explains the two identifiers used across the REST / AI endpoints. */
function IdentifiersNote({ withSlug = true }: { withSlug?: boolean }): React.ReactElement {
  return (
    <div
      className="rounded-lg border p-3 text-sm"
      style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}
      data-testid="identifiers-note"
    >
      <p>
        <code>{'{id}'}</code> — <b>идентификатор проекта</b> (имя каталога проекта в{' '}
        <code>Projects/</code>). Список проектов и их <code>id</code>:{' '}
        <code>GET /api/projects</code> или экран «Открыть существующий».
      </p>
      {withSlug ? (
        <p className="mt-2">
          <code>{'{slug}'}</code> — <b>идентификатор требования</b>: стабильная человекочитаемая
          «ручка», которая создаётся из названия, уникальна в проекте и не меняется при
          переименовании (например «Оплата картой» → <code>oplata-kartoy</code>).
        </p>
      ) : null}
    </div>
  );
}

function AiContent(): React.ReactElement {
  return (
    <>
      <Section title="Что это">
        <p>
          Требования каждого <b>проекта</b> — источник истины для ИИ. Они хранятся в
          человекочитаемом формате OpenSpec (<code>### Requirement:</code> /{' '}
          <code>#### Scenario:</code>), который ИИ-агент читает без отдельного парсера.
        </p>
      </Section>
      <Section title="Как пользоваться">
        <IdentifiersNote withSlug={false} />
        <p>
          Запросите склеенный OpenSpec-текст конкретного проекта{' '}
          <span
            onClick={() => window.open('/doom/', '_blank', 'noopener,noreferrer')}
            style={{ cursor: 'inherit' }}
          >
            дум
          </span>{' '}
          и отдайте агенту как контекст — эндпоинт возвращает <code>text/markdown</code> (здесь{' '}
          <code>{'{projectId}'}</code> — тот самый <code>id</code> проекта):
        </p>
        <CodeBlock>{'GET /api/projects/{projectId}/requirements?format=openspec'}</CodeBlock>
        <p>Пример вызова:</p>
        <CodeBlock>
          {'curl "http://localhost:3000/api/projects/my-product/requirements?format=openspec"'}
        </CodeBlock>
      </Section>
    </>
  );
}

function RestContent(): React.ReactElement {
  return (
    <>
      <Section title="Что это">
        <p>
          Локальный сервер даёт REST/JSON поверх файлового хранилища. Все запросы и ответы
          валидируются zod-схемами из <code>@po/core</code>.
        </p>
      </Section>
      <Section title="Идентификаторы в путях">
        <IdentifiersNote />
      </Section>
      <Section title="Полная Swagger-документация">
        <p>
          Полная интерактивная документация со <b>схемами тел запроса и ответа</b> и{' '}
          <b>query-параметрами</b> по каждому эндпоинту доступна по адресу:
        </p>
        <p>
          <a
            data-testid="swagger-link"
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline"
            style={{ color: 'var(--color-primary)' }}
          >
            {DOCS_URL}
          </a>
        </p>
        <p>
          Машиночитаемая OpenAPI-схема (JSON): <code>{OPENAPI_URL}</code>
        </p>
        <div
          className="overflow-hidden rounded-lg border"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <iframe
            data-testid="swagger-frame"
            src="/docs"
            title="Swagger UI"
            className="h-[440px] w-full"
            style={{ background: '#ffffff' }}
          />
        </div>
        <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>
          Встроенный просмотр доступен, когда приложение открыто с локального сервера (
          <code>node apps/server/dist/main.js</code>). Иначе откройте ссылку выше в новой вкладке.
        </p>
      </Section>
      <Section title="Быстрая справка по эндпоинтам">
        <div
          className="overflow-x-auto rounded-lg border"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <table className="w-full border-collapse text-left text-xs" data-testid="rest-endpoints">
            <thead>
              <tr style={{ background: 'var(--color-surface-2)' }}>
                <th className="px-3 py-2 font-semibold" style={{ color: 'var(--color-text-2)' }}>
                  Метод
                </th>
                <th className="px-3 py-2 font-semibold" style={{ color: 'var(--color-text-2)' }}>
                  Путь
                </th>
                <th className="px-3 py-2 font-semibold" style={{ color: 'var(--color-text-2)' }}>
                  Назначение
                </th>
              </tr>
            </thead>
            <tbody>
              {REST_ENDPOINTS.map((e) => (
                <tr
                  key={`${e.method} ${e.path}`}
                  className="border-t"
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  <td className="px-3 py-2 font-mono font-semibold align-top">{e.method}</td>
                  <td className="px-3 py-2 font-mono align-top">{e.path}</td>
                  <td className="px-3 py-2 align-top" style={{ color: 'var(--color-text-2)' }}>
                    {e.desc}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>Пример запроса:</p>
        <CodeBlock>{'curl "http://localhost:3000/api/projects"'}</CodeBlock>
      </Section>
    </>
  );
}

function McpContent(): React.ReactElement {
  return (
    <>
      <Section title="Что это">
        <p>
          MCP-сервер выставляет требования проекта как инструменты (tools) для ИИ-агентов по
          протоколу Model Context Protocol. Агент вызывает их напрямую, без REST-обвязки.
        </p>
      </Section>
      <Section title="Работа с конкретным проектом">
        <p>
          Почти все инструменты принимают аргумент <code>projectId</code> — тот же идентификатор
          проекта, что и в REST (имя каталога в <code>Projects/</code>). Типичный порядок работы:
        </p>
        <ol className="ml-4 list-decimal space-y-1 text-sm">
          <li>
            <code>list_projects</code> → выбрать нужный <code>projectId</code>.
          </li>
          <li>
            <code>{'list_requirements { projectId }'}</code> — получить требования проекта.
          </li>
          <li>
            <code>{'create_requirement { projectId, … }'}</code>,{' '}
            <code>{'link_requirements { projectId, … }'}</code>,{' '}
            <code>{'export_project { projectId, format }'}</code> и т.д.
          </li>
        </ol>
      </Section>
      <Section title="Инструменты (tools)">
        <p>
          Все инструменты, кроме <code>list_projects</code>, требуют <code>projectId</code>:
        </p>
        <ul className="grid gap-1.5 sm:grid-cols-2" data-testid="mcp-tools">
          {MCP_TOOLS.map((tool) => (
            <li key={tool.name} className="flex items-baseline gap-2 text-xs">
              <span
                className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: 'var(--color-primary)' }}
                aria-hidden="true"
              />
              <span className="font-mono font-semibold">{tool.name}</span>
              <span className="font-mono" style={{ color: 'var(--color-text-3)' }}>
                ({tool.args})
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Как запустить">
        <p>
          Соберите сервер и запустите его, указав корень проектов через <code>PROJECTS_ROOT</code>:
        </p>
        <CodeBlock>{'npm run build\nnode apps/mcp/dist/main.js'}</CodeBlock>
        <p>Пример конфигурации MCP-клиента:</p>
        <CodeBlock>{MCP_CONFIG}</CodeBlock>
      </Section>
    </>
  );
}

function SkillContent(): React.ReactElement {
  return (
    <>
      <Section title="Что это">
        <p>
          <b>Skill «/extract»</b> — сценарий для ИИ-агента в терминале (GigaCode CLI, Claude Code):
          по переданному источнику (ссылка на веб-документацию, локальный PDF или Word) он{' '}
          <b>вычленяет</b> функциональные (ФТ) и нефункциональные (НФТ) требования — строго из
          источника, без домысливания — и наполняет ими проект в этом портале через <b>MCP</b>.
          Требует запущенного MCP-сервера <code>project-po</code> (см. панель «MCP»).
        </p>
      </Section>

      <Section title="1. Скачать Skill с портала">
        <p>Скачайте файл скилла — портал отдаёт его напрямую:</p>
        <p>
          <a
            data-testid="skill-download-link"
            href={SKILL_DOWNLOAD_URL}
            download="project-po-extract.skill.md"
            className="btn btn-primary inline-flex"
            style={{ textDecoration: 'none' }}
          >
            ↓ Скачать SKILL.md
          </a>
        </p>
        <p className="text-xs" style={{ color: 'var(--color-text-3)' }}>
          Прямая ссылка: <code>{SKILL_DOWNLOAD_URL}</code>. Скачивание доступно, когда приложение
          открыто с локального сервера (<code>node apps/server/dist/main.js</code>).
        </p>
      </Section>

      <Section title="2. Настроить локально под GigaCode CLI">
        <p>
          Положите скачанный файл в домашнюю конфигурацию GigaCode CLI — каталог{' '}
          <code>~/.gigacode/</code> — под именем <code>SKILL.md</code>:
        </p>
        <CodeBlock>{SKILL_GIGACODE_SETUP}</CodeBlock>
        <p>
          После этого перезапустите GigaCode CLI и вызывайте скилл командой <code>/extract</code>{' '}
          (или попросите агента «извлеки требования из …»). Подробнее о GigaCode CLI:{' '}
          <a
            data-testid="gigacode-link"
            href={GIGACODE_URL}
            target="_blank"
            rel="noreferrer"
            className="underline"
            style={{ color: 'var(--color-primary)' }}
          >
            {GIGACODE_URL}
          </a>
        </p>
        <div
          className="rounded-lg border p-3 text-xs"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface-2)' }}
        >
          <p>
            Чтобы скилл мог наполнять портал, у агента должен быть подключён MCP-сервер{' '}
            <code>project-po</code> с переменной <code>PROJECTS_ROOT</code>, указывающей на каталог{' '}
            <code>Projects/</code> портала (конфигурацию см. в панели «MCP»).
          </p>
        </div>
      </Section>
    </>
  );
}

/**
 * Wide, scrollable description screen for a service (E13 · T-1302). Built on the
 * Modal shell pattern: dimmed scrim, Esc / close-button / scrim-click to close,
 * fixed header, scrolling body. Styled purely through design tokens.
 */
export function ServiceScreen({ service, onClose }: ServiceScreenProps): React.ReactElement {
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  // UX-5: trap focus inside the service screen, defaulting to the close button.
  useFocusTrap(cardRef, { initialFocus: closeRef });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-4"
      style={{ background: 'rgba(15,23,42,.5)' }}
      data-testid="service-screen-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-hidden="false"
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={TITLES[service]}
        data-testid="service-screen"
        data-service={service}
        className="card flex max-h-[90vh] w-full max-w-3xl flex-col p-0 shadow-lg"
      >
        <header
          className="flex shrink-0 items-center justify-between border-b px-6 py-4"
          style={{ borderColor: 'var(--color-border)' }}
        >
          <div className="flex items-center gap-3">
            <span
              className="badge"
              style={{ background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' }}
            >
              Сервис
            </span>
            <h2 className="text-lg font-bold" data-testid="service-screen-title">
              {TITLES[service]}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn btn-ghost"
            aria-label="Закрыть"
            data-testid="service-screen-close"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {service === 'ai' ? <AiContent /> : null}
          {service === 'rest' ? <RestContent /> : null}
          {service === 'mcp' ? <McpContent /> : null}
          {service === 'skill' ? <SkillContent /> : null}
        </div>
      </div>
    </div>
  );
}
