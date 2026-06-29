import { Link } from 'react-router-dom';
import { ThemeToggle } from '../components/ThemeToggle';

interface ActionCard {
  to: string;
  testid: string;
  title: string;
  description: string;
  glyph: string;
}

const ACTIONS: ActionCard[] = [
  {
    to: '/new',
    testid: 'start-new',
    title: 'Новый проект',
    description: 'Создать пустой проект в каталоге Projects/.',
    glyph: '＋',
  },
  {
    to: '/import',
    testid: 'start-import',
    title: 'Импорт',
    description: 'Загрузить архив .zip или .tar.gz.',
    glyph: '↓',
  },
  {
    to: '/open',
    testid: 'start-open',
    title: 'Открыть существующий',
    description: 'Выбрать проект из Projects/.',
    glyph: '🗀',
  },
];

export function Start(): React.ReactElement {
  return (
    <div className="min-h-screen" data-testid="start-page">
      <header
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
      >
        <div>
          <div className="font-bold">Требования PO</div>
          <div className="text-xs" style={{ color: 'var(--color-text-3)' }}>
            Управление ФТ и НФТ продукта
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="mx-auto max-w-4xl px-4 py-12 text-center">
        <h1 className="text-3xl font-bold">С чего начнём?</h1>
        <p className="mt-2" style={{ color: 'var(--color-text-2)' }}>
          Создайте новый проект требований, импортируйте архив или откройте существующий.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {ACTIONS.map((a) => (
            <Link
              key={a.to}
              to={a.to}
              data-testid={a.testid}
              className="card flex flex-col items-start gap-3 p-6 text-left transition-shadow hover:shadow"
            >
              <span
                className="grid h-11 w-11 place-items-center rounded-lg text-xl"
                style={{ background: 'var(--color-primary-soft)', color: 'var(--color-primary)' }}
                aria-hidden="true"
              >
                {a.glyph}
              </span>
              <span className="text-lg font-bold">{a.title}</span>
              <span className="text-sm" style={{ color: 'var(--color-text-2)' }}>
                {a.description}
              </span>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
