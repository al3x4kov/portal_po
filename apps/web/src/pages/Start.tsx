import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, FolderOpen, Plus, Upload, type LucideIcon } from 'lucide-react';
import { ThemeToggle } from '../components/ThemeToggle';
import { ServicesSection } from '../components/ServicesSection';
import {
  formatOpenedAt,
  readRecentProjects,
  rememberRecentProject,
  type RecentProject,
} from '../lib/recentProjects';

interface ActionCard {
  to: string;
  testid: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Tinted 44×44 icon badge (colour is not the only signal — icons differ). */
  badge: { background: string; color: string };
}

const ACTIONS: ActionCard[] = [
  {
    to: '/new',
    testid: 'start-new',
    title: 'Создать новый',
    description: 'Пустой проект в каталоге Projects/.',
    icon: Plus,
    badge: { background: 'var(--color-primary-soft)', color: 'var(--color-primary)' },
  },
  {
    to: '/import',
    testid: 'start-import',
    title: 'Импортировать',
    description: 'Загрузить архив .zip или .tar.gz.',
    icon: Upload,
    badge: { background: 'var(--color-info-bg)', color: 'var(--color-info)' },
  },
  {
    to: '/open',
    testid: 'start-open',
    title: 'Открыть существующий',
    description: 'Выбрать проект из Projects/.',
    icon: FolderOpen,
    badge: { background: 'var(--color-success-bg)', color: 'var(--color-success)' },
  },
];

export function Start(): React.ReactElement {
  // Read once per mount: the list changes only through user navigation,
  // which unmounts this page anyway.
  const [recents] = useState<RecentProject[]>(() => readRecentProjects());

  return (
    <div className="min-h-screen" data-testid="start-page">
      <header
        className="sticky top-0 z-10 flex h-header items-center justify-between border-b px-4 sm:px-6"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
      >
        <div>
          <div className="text-sm font-bold sm:text-base">Требования PO</div>
          <p className="t3 text-min">Управление ФТ и НФТ продукта</p>
        </div>
        <ThemeToggle />
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
        {/* HERO: три основных действия */}
        <section aria-labelledby="hero-h">
          <h1 id="hero-h" className="text-center text-2xl font-bold sm:text-3xl">
            С чего начнём?
          </h1>
          <p className="t2 mt-2 text-center text-sm">
            Проект — это папка с .md-файлами в каталоге Projects/.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {ACTIONS.map((a) => {
              const Icon = a.icon;
              return (
                <Link
                  key={a.to}
                  to={a.to}
                  data-testid={a.testid}
                  className="card flex flex-col items-start gap-3 p-5 text-left transition-shadow hover:shadow-md sm:p-6"
                >
                  <span
                    className="grid h-11 w-11 place-items-center rounded-lg"
                    style={a.badge}
                    aria-hidden="true"
                  >
                    <Icon className="icon" />
                  </span>
                  <span className="text-base font-bold sm:text-lg">{a.title}</span>
                  <span className="t2 text-sm">{a.description}</span>
                </Link>
              );
            })}
          </div>
        </section>

        {/* НЕДАВНИЕ ПРОЕКТЫ (§2.1-3, localStorage po.recentProjects) */}
        <section className="mt-10" aria-labelledby="recent-h" data-testid="recent-projects">
          <h2 id="recent-h" className="text-lg font-bold">
            Недавние проекты
          </h2>
          <p className="t2 mt-1 text-sm">Продолжите с того места, где остановились.</p>

          {recents.length > 0 ? (
            <ul className="card mt-4 overflow-hidden" role="list" data-testid="recent-list">
              {recents.map((p, i) => (
                <li
                  key={p.id}
                  className={i > 0 ? 'border-t' : undefined}
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  <Link
                    to={`/p/${encodeURIComponent(p.id)}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-surface-2)]"
                    data-testid={`recent-project-${p.id}`}
                    onClick={() => rememberRecentProject(p)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{p.name}</span>
                      {p.mainPath ? (
                        <span className="mono t3 block truncate text-min" title={p.mainPath}>
                          {p.mainPath}
                        </span>
                      ) : null}
                    </span>
                    <span className="t3 hidden flex-none text-xs sm:block">
                      {formatOpenedAt(p.openedAt)}
                    </span>
                    <ChevronRight className="t3 icon-sm flex-none" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="card mt-4 px-4 py-6 text-center" data-testid="recent-empty">
              <p className="t2 text-sm">Здесь появятся проекты, которые вы недавно открывали.</p>
            </div>
          )}
        </section>

        {/* СЕРВИСНЫЕ ФУНКЦИИ: компактные, вторичные (§2.1-2) */}
        <ServicesSection />
      </main>
    </div>
  );
}
