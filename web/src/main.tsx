import '@fontsource-variable/plus-jakarta-sans';
import './styles/tokens.css';
import './styles/app.css';
import './styles/manager.css';
import { IconContext } from '@phosphor-icons/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { ToastProvider } from './components/ui';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { applyTheme, getTheme } from './lib/prefs';

applyTheme(getTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <IconContext.Provider value={{ weight: 'light', size: 22 }}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ToastProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </IconContext.Provider>
  </StrictMode>,
);
