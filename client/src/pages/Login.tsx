import { useState, FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

export function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to="/dashboard" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    const r = await login(email, password);
    setSubmitting(false);
    if (!r.ok) { setErr(r.error); return; }
    navigate('/dashboard');
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-cream">
      <form onSubmit={onSubmit} className="w-full max-w-sm bg-foam border border-latte rounded-2xl p-8 shadow-sm">
        <div className="text-2xl font-bold text-espresso mb-1 flex items-center gap-2">💰 FinDash</div>
        <div className="text-xs text-mocha mb-6">Sign in to your account</div>

        <label className="block text-xs text-mocha mb-1">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={e => setEmail(e.target.value)}
          className="w-full mb-4 px-3 py-2 rounded-md border border-latte bg-cream text-espresso focus:outline-none focus:border-caramel"
        />

        <label className="block text-xs text-mocha mb-1">Password</label>
        <input
          type="password"
          required
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full mb-4 px-3 py-2 rounded-md border border-latte bg-cream text-espresso focus:outline-none focus:border-caramel"
        />

        {err && <div className="text-xs text-rust bg-rust/10 border border-rust/30 rounded-md px-3 py-2 mb-3">{err}</div>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full py-2 rounded-md bg-caramel text-cream font-semibold hover:bg-caramel/90 disabled:opacity-60"
        >
          {submitting ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
