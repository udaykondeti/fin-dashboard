import { useEffect, useState } from 'react';
import { api } from '../api/client';

type NetWorth = {
  total_assets: number;
  total_liabilities: number;
  net_worth: number;
  breakdown?: Record<string, number>;
};

type ActivityItem = {
  id: number;
  source: string;
  summary: string;
  created_at: string;
};

const fmt = (n: number | null | undefined) =>
  n == null ? '—' : '₹' + Number(n).toLocaleString('en-IN');

export function Dashboard() {
  const [nw, setNw] = useState<NetWorth | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.allSettled([
      api.get<NetWorth>('/api/networth'),
      api.get<{ activity: ActivityItem[] }>('/api/activity?limit=10')
    ]).then(([nwRes, actRes]) => {
      if (nwRes.status === 'fulfilled') setNw(nwRes.value);
      else setErr(nwRes.reason?.error || 'Failed to load net worth');
      if (actRes.status === 'fulfilled') setActivity(actRes.value.activity || []);
      setLoading(false);
    });
  }, []);

  if (loading) return <div className="text-mocha">Loading dashboard…</div>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-espresso">Dashboard</h1>
        <p className="text-sm text-mocha">{new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
      </header>

      {err && <div className="text-sm text-rust bg-rust/10 border border-rust/30 rounded-md px-3 py-2">{err}</div>}

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card label="Net Worth" value={fmt(nw?.net_worth)} accent="caramel" />
        <Card label="Total Assets" value={fmt(nw?.total_assets)} accent="leaf" />
        <Card label="Total Liabilities" value={fmt(nw?.total_liabilities)} accent="rust" />
      </section>

      {nw?.breakdown && (
        <section>
          <h2 className="text-sm font-semibold text-espresso uppercase tracking-wider mb-2">Breakdown</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Object.entries(nw.breakdown).map(([k, v]) => (
              <Card key={k} label={k.replace(/_/g, ' ')} value={fmt(v)} accent="latte" small />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold text-espresso uppercase tracking-wider mb-2">Recent Activity</h2>
        <div className="surface p-4">
          {activity.length === 0 ? (
            <div className="text-sm text-mocha">No recent activity. New entries appear within 5 minutes of changes.</div>
          ) : (
            <ul className="space-y-2">
              {activity.map(a => (
                <li key={a.id} className="border-l-2 border-caramel pl-3 py-1.5 bg-foam rounded">
                  <div className="text-sm text-espresso">{a.summary}</div>
                  <div className="text-[11px] text-mocha mt-0.5">{a.source} · {new Date(a.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Card({ label, value, accent = 'caramel', small = false }: { label: string; value: string; accent?: string; small?: boolean }) {
  const accentClass: Record<string, string> = {
    caramel: 'text-caramel',
    leaf:    'text-leaf',
    rust:    'text-rust',
    latte:   'text-mocha'
  };
  return (
    <div className="surface p-4">
      <div className="text-[11px] uppercase tracking-wider text-mocha mb-1 capitalize">{label}</div>
      <div className={`${small ? 'text-lg' : 'text-2xl'} font-bold ${accentClass[accent] || 'text-caramel'}`}>{value}</div>
    </div>
  );
}
