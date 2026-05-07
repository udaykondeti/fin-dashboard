// AMFI India publishes daily NAVs for every registered mutual fund scheme as a
// semicolon-delimited text file at https://www.amfiindia.com/spages/NAVAll.txt
// Yahoo Finance doesn't carry these — exchange-traded funds yes (use Yahoo
// for those) but traditional open-ended schemes are AMFI-only.
//
// Format (one header section per AMC, blank lines separate AMCs):
//   Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
//   118989;INF179K01YV8;-;HDFC Mid-Cap Opportunities Fund - Growth Plan;164.6280;06-May-2026
//
// Fetched once per process boot and re-fetched after 1 hour. Lookup keyed by
// scheme code (the user provides this on the holding) — scheme codes are 5–6
// digit numeric strings.
//
// Fuzzy lookup by scheme name is intentionally NOT exposed: scheme names vary
// in punctuation/casing across data sources and silently mapping to the
// wrong scheme produces incorrect P&L. User must provide the exact code.

const AMFI_URL = 'https://www.amfiindia.com/spages/NAVAll.txt';
const TTL_MS = 60 * 60 * 1000;

let cache = { byCode: null, fetchedAt: 0, error: null };

async function fetchAndParse() {
  const res = await fetch(AMFI_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; fin-dashboard/1.0)' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`AMFI HTTP ${res.status}`);
  const text = await res.text();
  const byCode = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith('Scheme Code') || !line.includes(';')) continue;
    const parts = line.split(';');
    if (parts.length < 6) continue;
    const code = parts[0].trim();
    const navStr = parts[4].trim();
    const date   = parts[5].trim();
    if (!/^\d{4,}$/.test(code)) continue;
    const nav = parseFloat(navStr);
    if (!Number.isFinite(nav) || nav <= 0) continue;
    byCode[code] = { nav, date, scheme_name: parts[3].trim() };
  }
  return byCode;
}

async function loadIfStale() {
  const now = Date.now();
  if (cache.byCode && (now - cache.fetchedAt) < TTL_MS) return;
  try {
    const byCode = await fetchAndParse();
    cache = { byCode, fetchedAt: now, error: null };
    console.log(`[amfiNav] loaded ${Object.keys(byCode).length} schemes`);
  } catch (err) {
    console.error('[amfiNav] fetch failed:', err.message);
    // Keep stale cache if we have one; otherwise leave null and surface error.
    if (!cache.byCode) cache.error = err.message;
    cache.fetchedAt = now; // back off retries for the TTL window
  }
}

// Returns { nav, date, scheme_name } or null.
async function getNavByCode(schemeCode) {
  if (!schemeCode) return null;
  await loadIfStale();
  if (!cache.byCode) return null;
  return cache.byCode[String(schemeCode).trim()] || null;
}

module.exports = { getNavByCode };
