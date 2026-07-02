import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServicesSection } from './ServicesSection';
import { renderWithProviders } from '../test/utils';

describe('ServicesSection (E13 · revised — Start screen)', () => {
  it('renders the three service items as a section', () => {
    renderWithProviders(<ServicesSection />);
    expect(screen.getByTestId('services-section')).toBeInTheDocument();
    expect(screen.getByTestId('service-open-ai')).toBeInTheDocument();
    expect(screen.getByTestId('service-open-rest')).toBeInTheDocument();
    expect(screen.getByTestId('service-open-mcp')).toBeInTheDocument();
    // No screen open until an item is clicked.
    expect(screen.queryByTestId('service-screen')).not.toBeInTheDocument();
  });

  async function openService(kind: 'ai' | 'rest' | 'mcp'): Promise<void> {
    const user = userEvent.setup();
    renderWithProviders(<ServicesSection />);
    await user.click(screen.getByTestId(`service-open-${kind}`));
  }

  it('opens the AI-ready API screen with the openspec format hint', async () => {
    await openService('ai');
    const el = screen.getByTestId('service-screen');
    expect(el).toHaveAttribute('data-service', 'ai');
    expect(screen.getByTestId('service-screen-title')).toHaveTextContent('AI-ready API');
    expect(el).toHaveTextContent('format=openspec');
    // Project context clarified (no bare :id).
    expect(el).toHaveTextContent('projectId');
    expect(screen.getByTestId('identifiers-note')).toBeInTheDocument();
  });

  it('opens the REST API screen with identifiers, endpoints and a Swagger link', async () => {
    await openService('rest');
    const el = screen.getByTestId('service-screen');
    expect(el).toHaveAttribute('data-service', 'rest');
    expect(screen.getByTestId('service-screen-title')).toHaveTextContent('REST API');
    expect(el).toHaveTextContent('/api/projects');
    // {id} and {slug} explained.
    expect(screen.getByTestId('identifiers-note')).toHaveTextContent('идентификатор проекта');
    expect(screen.getByTestId('identifiers-note')).toHaveTextContent('slug');
    // Full Swagger document is reachable at a concrete URL.
    expect(screen.getByTestId('swagger-link')).toHaveAttribute(
      'href',
      'http://localhost:3000/docs',
    );
    expect(screen.getByTestId('swagger-frame')).toHaveAttribute('src', '/docs');
    expect(el).toHaveTextContent('/openapi.json');
  });

  it('opens the MCP screen with the per-project workflow, tools and launch command', async () => {
    await openService('mcp');
    const el = screen.getByTestId('service-screen');
    expect(el).toHaveAttribute('data-service', 'mcp');
    expect(screen.getByTestId('service-screen-title')).toHaveTextContent('MCP');
    expect(el).toHaveTextContent('list_requirements');
    expect(el).toHaveTextContent('node apps/mcp/dist/main.js');
    // Working with a specific project is explained.
    expect(el).toHaveTextContent('projectId');
    expect(el).toHaveTextContent('list_projects');
  });

  it('closes the screen via the close button', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServicesSection />);
    await user.click(screen.getByTestId('service-open-ai'));
    expect(screen.getByTestId('service-screen')).toBeInTheDocument();
    await user.click(screen.getByTestId('service-screen-close'));
    await waitFor(() => expect(screen.queryByTestId('service-screen')).not.toBeInTheDocument());
  });

  it('closes the screen on Escape', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServicesSection />);
    await user.click(screen.getByTestId('service-open-rest'));
    expect(screen.getByTestId('service-screen')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('service-screen')).not.toBeInTheDocument());
  });

  it('closes the screen when clicking the scrim', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ServicesSection />);
    await user.click(screen.getByTestId('service-open-mcp'));
    expect(screen.getByTestId('service-screen')).toBeInTheDocument();
    await user.click(screen.getByTestId('service-screen-overlay'));
    await waitFor(() => expect(screen.queryByTestId('service-screen')).not.toBeInTheDocument());
  });
});
