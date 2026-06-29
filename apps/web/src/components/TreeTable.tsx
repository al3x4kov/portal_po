import type { Requirement } from '@po/core';
import { useUiStore } from '../store/ui';
import { buildForest, flattenVisible, type TreeNode } from '../lib/tree';
import { CriticalityBadge, ImplementationBadge } from './badges';

interface TreeTableProps {
  title: string;
  addLabel: string;
  testidPrefix: string;
  requirements: Requirement[];
  onAdd: () => void;
  onEdit: (req: Requirement) => void;
  onLink: (req: Requirement) => void;
  onDelete: (req: Requirement) => void;
}

function Row({
  node,
  onEdit,
  onLink,
  onDelete,
}: {
  node: TreeNode;
  onEdit: (r: Requirement) => void;
  onLink: (r: Requirement) => void;
  onDelete: (r: Requirement) => void;
}): React.ReactElement {
  const req = node.requirement;
  const hasChildren = node.children.length > 0;
  const isExpanded = useUiStore((s) => s.expanded.has(req.id));
  const toggleExpanded = useUiStore((s) => s.toggleExpanded);

  return (
    <tr
      className="group border-b"
      style={{ borderColor: 'var(--color-border)' }}
      data-testid={`tree-row-${req.id}`}
      data-req-name={req.name}
    >
      <td className="py-2.5 pr-3 align-top">
        <div className="flex items-start gap-1.5" style={{ paddingLeft: node.depth * 24 }}>
          {hasChildren ? (
            <button
              type="button"
              className="btn btn-ghost px-1 py-0 text-sm"
              aria-label={isExpanded ? 'Свернуть' : 'Развернуть'}
              aria-expanded={isExpanded}
              data-testid={`tree-toggle-${req.id}`}
              onClick={() => toggleExpanded(req.id)}
            >
              {isExpanded ? '▾' : '▸'}
            </button>
          ) : (
            <span className="px-1 text-sm" style={{ color: 'var(--color-text-3)' }} aria-hidden="true">
              •
            </span>
          )}
          <button
            type="button"
            className="text-left font-medium hover:underline"
            data-testid={`req-name-${req.id}`}
            onClick={() => onEdit(req)}
          >
            {req.name}
          </button>
        </div>
      </td>
      <td className="max-w-[1px] truncate py-2.5 pr-3 align-top text-sm" style={{ color: 'var(--color-text-2)' }}>
        {req.description}
      </td>
      <td className="py-2.5 pr-3 align-top">
        <CriticalityBadge criticality={req.criticality} />
      </td>
      <td className="py-2.5 pr-3 align-top">
        <ImplementationBadge req={req} />
      </td>
      <td className="py-2.5 align-top text-right">
        <div className="inline-flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100">
          <button
            type="button"
            className="btn btn-ghost px-2 py-1 text-xs"
            data-testid={`link-btn-${req.id}`}
            onClick={() => onLink(req)}
          >
            Связать
          </button>
          <button
            type="button"
            className="btn btn-ghost px-2 py-1 text-xs"
            style={{ color: 'var(--color-danger)' }}
            data-testid={`delete-btn-${req.id}`}
            onClick={() => onDelete(req)}
          >
            Удалить
          </button>
        </div>
      </td>
    </tr>
  );
}

export function TreeTable({
  title,
  addLabel,
  testidPrefix,
  requirements,
  onAdd,
  onEdit,
  onLink,
  onDelete,
}: TreeTableProps): React.ReactElement {
  const expanded = useUiStore((s) => s.expanded);
  const forest = buildForest(requirements);
  const rows = flattenVisible(forest, expanded);

  return (
    <section className="card mb-6 overflow-hidden" data-testid={`section-${testidPrefix}`}>
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ background: 'var(--color-surface-2)', borderColor: 'var(--color-border)' }}
      >
        <h2 className="font-bold">
          {title} <span style={{ color: 'var(--color-text-3)' }}>({requirements.length})</span>
        </h2>
        <button
          type="button"
          className="btn btn-primary py-1.5 text-sm"
          data-testid={`add-${testidPrefix}`}
          onClick={onAdd}
        >
          {addLabel}
        </button>
      </div>

      {requirements.length === 0 ? (
        <p className="px-4 py-6 text-sm" style={{ color: 'var(--color-text-3)' }} data-testid={`empty-${testidPrefix}`}>
          Пока нет требований. Нажмите «{addLabel}», чтобы добавить.
        </p>
      ) : (
        <table className="w-full text-sm" data-testid={`table-${testidPrefix}`}>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--color-text-3)' }}>
              <th className="w-[42%] px-4 py-2 font-semibold">Требование</th>
              <th className="px-4 py-2 font-semibold">Описание</th>
              <th className="px-4 py-2 font-semibold">Критичность</th>
              <th className="px-4 py-2 font-semibold">Реализация</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((node) => (
              <Row key={node.requirement.id} node={node} onEdit={onEdit} onLink={onLink} onDelete={onDelete} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
