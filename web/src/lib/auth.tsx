import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, type ReactNode } from 'react';
import { ApiError, api, onAuthError, setCsrfToken } from './api';

export interface Membership {
  branchId: string;
  branchName: string;
  role: 'employee' | 'manager';
  canEditRequirements: boolean;
  canManageEmployees: boolean;
}

export interface Me {
  user: {
    id: string;
    employeeNumber: string;
    firstName: string;
    lastName: string;
    email: string | null;
    emailVerified: boolean;
    mustChangePassword: boolean;
    roles: string[];
    isAdmin: boolean;
    isManager: boolean;
  };
  memberships: Membership[];
  csrfToken: string;
  features: { emailEnabled: boolean; allowNameEdit: boolean };
}

interface AuthValue {
  me: Me | null;
  loading: boolean;
  setMe: (m: Me | null) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<unknown>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Me>('/api/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });

  useEffect(() => {
    if (q.data) setCsrfToken(q.data.csrfToken);
  }, [q.data]);

  const setMe = useCallback(
    (m: Me | null) => {
      if (m) setCsrfToken(m.csrfToken);
      qc.setQueryData(['me'], m);
    },
    [qc],
  );

  useEffect(
    () =>
      onAuthError((e) => {
        if (e.status === 401) {
          // Only a session that existed can "end"; the initial sign-in probe also returns 401.
          if (!qc.getQueryData(['me'])) return;
          // Session ended: drop every cached private response.
          window.setTimeout(() => {
            qc.clear();
            qc.setQueryData(['me'], null);
          }, 0);
        } else {
          void qc.invalidateQueries({ queryKey: ['me'] });
        }
      }),
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      qc.clear();
      qc.setQueryData(['me'], null);
    }
  }, [qc]);

  return (
    <AuthContext.Provider value={{ me: q.data ?? null, loading: q.isLoading, setMe, logout, refresh: q.refetch }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}

export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('Not signed in');
  return me;
}
