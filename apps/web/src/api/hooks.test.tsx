import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSaveAiConfig, queryKeys } from './hooks';

const saveConfig = vi.fn();

vi.mock('./endpoints', () => ({
  projectsApi: {},
  requirementsApi: {},
  linksApi: {},
  aiApi: {
    saveConfig: (...a: unknown[]) => saveConfig(...a),
  },
}));

beforeEach(() => {
  saveConfig.mockReset();
});

describe('useSaveAiConfig (Task 10 follow-up: global key → global invalidation)', () => {
  it('invalidates the cached AI config of EVERY project, not just the current one', async () => {
    // NOT test/utils' makeQueryClient: its `gcTime: 0` garbage-collects the
    // observerless cache entries we seed below before we can assert on them.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // Simulate configs already cached for two different projects + the global view.
    queryClient.setQueryData(queryKeys.aiConfig('proj-a'), {
      baseURL: 'https://hub',
      hasApiKey: false,
    });
    queryClient.setQueryData(queryKeys.aiConfig('proj-b'), {
      baseURL: 'https://hub',
      hasApiKey: false,
    });
    queryClient.setQueryData(queryKeys.aiConfig(''), { baseURL: 'https://hub', hasApiKey: false });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    saveConfig.mockResolvedValue({ baseURL: 'https://hub', hasApiKey: true });

    const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSaveAiConfig(), { wrapper });

    result.current.mutate({ apiKey: 'sk-new' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Invalidation uses the prefix key, which covers every per-project entry.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.aiConfigAll });
    for (const projectId of ['proj-a', 'proj-b', '']) {
      const state = queryClient.getQueryState(queryKeys.aiConfig(projectId));
      expect(state?.isInvalidated).toBe(true);
    }
  });
});
