import { Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { TopNav } from './TopNav';

export function AppShell() {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8 text-mocha">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="min-h-full">
      <TopNav />
      <main className="max-w-[1400px] mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
