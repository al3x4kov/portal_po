interface GraphToolbarProps {
  showNfr: boolean;
  onToggleNfr: () => void;
  showEdgeLabels: boolean;
  onToggleEdgeLabels: () => void;
  onRelayout: () => void;
}

/**
 * Floating toolbar above the ReactFlow canvas with graph-specific controls.
 * FR-G5.2: Перерасставить, FR-G7.2: НФТ фильтр, FR-G4.2: метки рёбер.
 */
export function GraphToolbar({
  showNfr,
  onToggleNfr,
  showEdgeLabels,
  onToggleEdgeLabels,
  onRelayout,
}: GraphToolbarProps): React.ReactElement {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 border-b"
      style={{
        background: 'var(--color-surface)',
        borderColor: 'var(--color-border)',
      }}
      data-testid="graph-toolbar"
    >
      <button
        type="button"
        className="btn btn-secondary text-xs"
        data-testid="graph-relayout"
        onClick={onRelayout}
        title="Перерасставить узлы"
      >
        <svg
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="mr-1 inline-block"
        >
          <path d="M3 12h18M12 3l9 9-9 9" />
        </svg>
        Перерасставить
      </button>

      <button
        type="button"
        className={`btn text-xs ${showNfr ? 'btn-primary' : 'btn-secondary'}`}
        data-testid="graph-toggle-nfr"
        onClick={onToggleNfr}
        aria-pressed={showNfr}
        title={showNfr ? 'Скрыть НФТ' : 'Показать НФТ'}
      >
        НФТ {showNfr ? 'вкл' : 'выкл'}
      </button>

      <button
        type="button"
        className={`btn text-xs ${showEdgeLabels ? 'btn-primary' : 'btn-secondary'}`}
        data-testid="graph-toggle-labels"
        onClick={onToggleEdgeLabels}
        aria-pressed={showEdgeLabels}
        title={showEdgeLabels ? 'Скрыть метки рёбер' : 'Показать метки рёбер'}
      >
        Метки рёбер
      </button>
    </div>
  );
}
