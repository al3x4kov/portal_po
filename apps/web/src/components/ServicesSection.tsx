import { useState } from 'react';
import { ServiceScreen, type ServiceKind } from './ServiceScreen';

const ITEMS: ReadonlyArray<{
  kind: ServiceKind;
  label: string;
  hint: string;
  testid: string;
  glyph: string;
}> = [
  {
    kind: 'ai',
    label: 'AI-ready API',
    hint: 'OpenSpec-контекст для ИИ-агентов.',
    testid: 'service-open-ai',
    glyph: '✷',
  },
  {
    kind: 'rest',
    label: 'REST API',
    hint: 'HTTP/JSON поверх файлового хранилища.',
    testid: 'service-open-rest',
    glyph: '⇄',
  },
  {
    kind: 'mcp',
    label: 'MCP',
    hint: 'Инструменты для ИИ по Model Context Protocol.',
    testid: 'service-open-mcp',
    glyph: '◆',
  },
];

/**
 * "Сервисные функции" section shown on the Start screen, below the primary
 * actions (E13, revised). Each card opens the corresponding ServiceScreen with
 * a description of what it is and how to use it.
 */
export function ServicesSection(): React.ReactElement {
  const [service, setService] = useState<ServiceKind | null>(null);

  return (
    <section className="mt-14" data-testid="services-section">
      <h2 className="text-lg font-bold">Сервисные функции</h2>
      <p className="mt-1 text-sm" style={{ color: 'var(--color-text-2)' }}>
        Программные интерфейсы для интеграций и ИИ-агентов.
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        {ITEMS.map((item) => (
          <button
            key={item.kind}
            type="button"
            data-testid={item.testid}
            onClick={() => setService(item.kind)}
            className="card flex flex-col items-start gap-3 p-6 text-left transition-shadow hover:shadow"
          >
            <span
              className="grid h-11 w-11 place-items-center rounded-lg text-xl"
              style={{ background: 'var(--color-primary-soft)', color: 'var(--color-primary)' }}
              aria-hidden="true"
            >
              {item.glyph}
            </span>
            <span className="text-lg font-bold">{item.label}</span>
            <span className="text-sm" style={{ color: 'var(--color-text-2)' }}>
              {item.hint}
            </span>
          </button>
        ))}
      </div>

      {service ? <ServiceScreen service={service} onClose={() => setService(null)} /> : null}
    </section>
  );
}
