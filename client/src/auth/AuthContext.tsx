import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, getToken, setToken, clearToken } from '../api/client';

type User = { id: number; email: string; name: string; is_admin?: boolean };

type AuthState = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!getToken()) { setLoading(false); return; }
    api.get<{ user: User }>('/api/auth/me')
      .then(r => { if (!cancelled) setUser(r.user); })
      .catch(() => { if (!cancelled) clearToken(); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const login: AuthState['login'] = async (email, password) => {
    try {
      const r = await api.post<{ token: string; user: User }>('/api/auth/login', { email, password });
      if (!r.token) return { ok: false, error: 'No token returned' };
      setToken(r.token);
      localStorage.setItem('fin_user', r.user?.name || email);
      setUser(r.user);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.error || 'Login failed' };
    }
  };

  const logout = () => { clearToken(); setUser(null); };

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
