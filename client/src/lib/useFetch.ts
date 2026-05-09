import { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

// Tiny data hook. Re-fetch on `key` change. No caching/SWR — keep deps light.
export function useFetch<T = any>(url: string | null, deps: any[] = []) {
  const [data, setData]       = useState<T | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick]       = useState(0);

  const refetch = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    if (!url) { setData(null); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    api.get<T>(url)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e?.error || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick, ...deps]);

  return { data, error, loading, refetch };
}
