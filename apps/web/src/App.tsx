import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useUiStore } from './store/ui';
import { ToastProvider } from './components/Toast';
import { ChatWidget } from './components/ChatWidget';
import { Start } from './pages/Start';
import { NewProject } from './pages/NewProject';
import { Import } from './pages/Import';
import { OpenExisting } from './pages/OpenExisting';
import { Main } from './pages/Main';
import { Dashboard } from './pages/Dashboard';
import { Dictionaries } from './pages/Dictionaries';
import { AiPage } from './pages/AiPage';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
}

/** Applies the persisted theme to <html> by toggling the `dark` class. */
function ThemeApplier(): null {
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);
  return null;
}

export function AppRoutes(): React.ReactElement {
  return (
    <Routes>
      <Route path="/" element={<Start />} />
      <Route path="/new" element={<NewProject />} />
      <Route path="/import" element={<Import />} />
      <Route path="/open" element={<OpenExisting />} />
      <Route path="/p/:id" element={<Main />} />
      <Route path="/p/:id/dashboard" element={<Dashboard />} />
      <Route path="/p/:id/dictionaries" element={<Dictionaries />} />
      <Route path="/p/:id/ai" element={<AiPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App(): React.ReactElement {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeApplier />
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
          {/* Task 9: floating AI chat, available on every screen. */}
          <ChatWidget />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
