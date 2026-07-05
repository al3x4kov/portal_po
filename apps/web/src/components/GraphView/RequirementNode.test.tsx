import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequirementNode } from './RequirementNode';
import type { RequirementNodeData } from './types';
import type { NodeProps } from '@xyflow/react';

// Mock @xyflow/react Handle and Position
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom' },
}));

function makeNodeProps(
  overrides: Partial<RequirementNodeData> = {},
): NodeProps & { data: RequirementNodeData; type: unknown } {
  const data: RequirementNodeData = {
    slug: 'test-req',
    name: 'Test Requirement',
    type: 'FUNCTION',
    criticality: 'MEDIUM',
    implemented: true,
    isBroken: false,
    onClick: vi.fn(),
    ...overrides,
  };
  return {
    id: data.slug,
    data,
    type: 'requirementNode',
    selected: false,
    isConnectable: true,
    zIndex: 0,
    xPos: 0,
    yPos: 0,
    dragging: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as unknown as NodeProps & { data: RequirementNodeData; type: unknown };
}

describe('RequirementNode', () => {
  it('renders FUNCTION node with blue badge and type label ФТ', () => {
    render(<RequirementNode {...makeNodeProps({ type: 'FUNCTION' })} />);
    expect(screen.getByText('ФТ')).toBeInTheDocument();
    expect(screen.getByText('Test Requirement')).toBeInTheDocument();
  });

  it('renders NFR node with orange badge and type label НФТ', () => {
    render(<RequirementNode {...makeNodeProps({ type: 'NFR' })} />);
    expect(screen.getByText('НФТ')).toBeInTheDocument();
  });

  it('shows checkmark for implemented=true', () => {
    render(<RequirementNode {...makeNodeProps({ implemented: true })} />);
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('shows clock icon for implemented=false', () => {
    render(<RequirementNode {...makeNodeProps({ implemented: false })} />);
    expect(screen.getByText('⏱')).toBeInTheDocument();
  });

  it('renders the broken node with its own visual language (§2.20.1): label, no badges, error tooltip', () => {
    render(
      <RequirementNode
        {...makeNodeProps({
          isBroken: true,
          slug: 'broken-bad.md',
          name: 'bad.md',
          description: 'Неверный YAML во frontmatter (строка 3)',
        })}
      />,
    );
    // Отдельный визуальный язык: «Битый файл» + имя файла, БЕЗ бейджей критичности
    expect(screen.getByText('Битый файл')).toBeInTheDocument();
    expect(screen.getByText('bad.md')).toBeInTheDocument();
    expect(screen.queryByText('Средняя')).not.toBeInTheDocument();
    // Тултип с текстом ошибки
    const tip = screen.getByTestId('graph-node-broken-bad.md-tip');
    expect(tip).toHaveTextContent('Файл не читается');
    expect(tip).toHaveTextContent('Неверный YAML во frontmatter (строка 3)');
    // Красная пунктирная рамка
    expect(screen.getByTestId('graph-node-broken-bad.md')).toHaveStyle({
      border: '1.5px dashed var(--color-danger)',
    });
  });

  it('shows the Russian criticality label on regular nodes', () => {
    render(<RequirementNode {...makeNodeProps({ criticality: 'CRITICAL' })} />);
    expect(screen.getByText('Критическая')).toBeInTheDocument();
  });

  it('truncates long names after 60 chars', () => {
    const longName = 'A'.repeat(70);
    render(<RequirementNode {...makeNodeProps({ name: longName })} />);
    expect(screen.getByText(`${'A'.repeat(60)}…`)).toBeInTheDocument();
  });

  it('calls onClick with slug on card click', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<RequirementNode {...makeNodeProps({ slug: 'my-req', onClick })} />);
    await user.click(screen.getByTestId('graph-node-my-req'));
    expect(onClick).toHaveBeenCalledWith('my-req');
  });

  it('has correct data-testid attribute', () => {
    render(<RequirementNode {...makeNodeProps({ slug: 'auth-req' })} />);
    expect(screen.getByTestId('graph-node-auth-req')).toBeInTheDocument();
  });
});
