// Shared formatters + small UI primitives. Keep these tiny so pages stay
// declarative.

export const fmtINR = (n?: number | null): string =>
  n == null || !Number.isFinite(Number(n)) ? '—' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export const fmtUSD = (n?: number | null): string =>
  n == null || !Number.isFinite(Number(n)) ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

export const fmtPct = (n?: number | null, decimals = 2): string =>
  n == null || !Number.isFinite(Number(n)) ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(decimals) + '%';

export const fmtDate = (s?: string | null): string => {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-IN');
};

export const plClass = (n?: number | null): string =>
  n == null ? 'text-mocha' : (Number(n) >= 0 ? 'text-leaf' : 'text-rust');
