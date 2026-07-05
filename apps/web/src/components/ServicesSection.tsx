import { useState } from 'react';
import { Download, ExternalLink, Link as LinkIcon, Sparkles, type LucideIcon } from 'lucide-react';
import { ServiceScreen, type ServiceKind } from './ServiceScreen';

const ITEMS: ReadonlyArray<{
  kind: ServiceKind;
  label: string;
  hint: string;
  testid: string;
  icon: LucideIcon;
}> = [
  {
    kind: 'ai',
    label: 'AI-ready API',
    hint: 'OpenSpec-контекст для ИИ-агентов.',
    testid: 'service-open-ai',
    icon: Sparkles,
  },
  {
    kind: 'rest',
    label: 'REST API',
    hint: 'HTTP/JSON поверх файлового хранилища.',
    testid: 'service-open-rest',
    icon: ExternalLink,
  },
  {
    kind: 'mcp',
    label: 'MCP',
    hint: 'Инструменты для ИИ по Model Context Protocol.',
    testid: 'service-open-mcp',
    icon: LinkIcon,
  },
  {
    kind: 'skill',
    label: 'Skill',
    hint: 'Скилл /extract для ИИ-агента: скачать и настроить.',
    testid: 'service-open-skill',
    icon: Download,
  },
];

/**
 * «Сервисные функции» on the Start screen: compact, visually secondary
 * cards (surface-2 background, primary border on hover — §2.1-2 of the
 * Norman review). A click opens the corresponding ServiceScreen.
 */
export function ServicesSection(): React.ReactElement {
  const [service, setService] = useState<ServiceKind | null>(null);

  return (
    <section className="mt-10 pb-16" data-testid="services-section">
      <h2 className="text-lg font-bold">Сервисные функции</h2>
      <p className="t2 mt-1 text-sm">Программные интерфейсы для интеграций и ИИ-агентов.</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.kind}
              type="button"
              data-testid={item.testid}
              onClick={() => setService(item.kind)}
              className="flex items-start gap-3 rounded-lg border border-transparent p-4 text-left transition-colors hover:border-[var(--color-primary)]"
              style={{ background: 'var(--color-surface-2)' }}
            >
              <Icon
                className="icon mt-0.5 flex-none"
                style={{ color: 'var(--color-primary)' }}
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{item.label}</span>
                <span className="t2 mt-0.5 block text-xs">{item.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      {service ? <ServiceScreen service={service} onClose={() => setService(null)} /> : null}
    </section>
  );
}
