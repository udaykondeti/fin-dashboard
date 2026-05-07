// Centralized price + FX fetching. Replaces the duplicated fetchPrice/fetchYahooPrice
// helpers in routes/networth.js and routes/investments.js.
//
// Behavior:
//   - getPrice(symbol)         → { price, currency, ... } or { price: null, error }
//   - getUsdInrRate()          → { rate, source: 'live'|'cache'|'fallback', staleSec }
//   - The previous code silently fell back to avg_buy_price on failure, masking
//     the difference between "live price" and "cost basis". Callers now receive
//     an explicit { price: null, error } and decide how to surface that.

// Uses Node's built-in fetch (Node >=18). AbortSignal.timeout replaces the
// node-fetch v2 `timeout` option, which is not supported by the WHATWG fetch.

const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,16}$/;
const FX_TTL_MS = 60 * 60 * 1000; // cache USD/INR for one hour

let fxCache = { rate: null, fetchedAt: 0 };

function isAllowedSymbol(symbol) {
  return typeof symbol === 'string' && SYMBOL_RE.test(symbol);
}

async function getPrice(symbol) {
  if (!isAllowedSymbol(symbol)) {
    return { symbol, price: null, error: 'invalid_symbol' };
  }
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; fin-dashboard/1.0)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      return { symbol, price: null, error: `yahoo_status_${response.status}` };
    }
    const data = await response.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result) return { symbol, price: null, error: 'no_data' };

    const meta = result.meta || {};
    const price = meta.regularMarketPrice || meta.previousClose || null;
    const previousClose = meta.previousClose || null;
    const currency = meta.currency || 'INR';
    return {
      symbol,
      price,
      previousClose,
      currency,
      change: price && previousClose ? price - previousClose : null,
      changePercent: price && previousClose ? ((price - previousClose) / previousClose) * 100 : null,
      marketState: meta.marketState || 'CLOSED'
    };
  } catch (err) {
    console.error(`[priceService] Failed for ${symbol}:`, err.message);
    return { symbol, price: null, error: err.message };
  }
}

// Yahoo exposes USDINR=X — use that. Falls back to last cached value, then to a
// hardcoded constant only as a last resort. Callers can read `source` to surface
// "stale FX rate" warnings to the UI.
async function getUsdInrRate() {
  const FALLBACK_RATE = 84.0;
  const now = Date.now();
  if (fxCache.rate && now - fxCache.fetchedAt < FX_TTL_MS) {
    return { rate: fxCache.rate, source: 'cache', staleSec: Math.round((now - fxCache.fetchedAt) / 1000) };
  }
  const result = await getPrice('USDINR=X');
  if (result.price && Number.isFinite(result.price) && result.price > 30 && result.price < 200) {
    fxCache = { rate: result.price, fetchedAt: now };
    return { rate: result.price, source: 'live', staleSec: 0 };
  }
  if (fxCache.rate) {
    return { rate: fxCache.rate, source: 'cache', staleSec: Math.round((now - fxCache.fetchedAt) / 1000) };
  }
  return { rate: FALLBACK_RATE, source: 'fallback', staleSec: null };
}

module.exports = { getPrice, getUsdInrRate, isAllowedSymbol, getIndianStockPrice };

// Try a few common symbol variants for Indian equities and return the first
// hit. Trading-account CSV exports often carry suffixes that Yahoo doesn't
// recognise (Zerodha shows -EQ, some BSE feeds tack EQ on the end). For
// "AZADEQ" we try AZADEQ.NS, AZAD.NS, AZADEQ.BO, AZAD.BO. Returns the same
// shape as getPrice() with an extra `resolved_symbol` field naming the
// variant that worked, plus `live: boolean`.
async function getIndianStockPrice(rawSymbol) {
  const base = String(rawSymbol || '').trim().toUpperCase();
  if (!base) return { price: null, live: false, error: 'empty_symbol' };
  // Strip trailing series suffixes that Yahoo doesn't carry.
  const stripped = base
    .replace(/-EQ$/, '').replace(/-BE$/, '').replace(/-BZ$/, '')
    .replace(/EQ$/, '');
  const variants = [];
  const seen = new Set();
  const push = (s) => { const k = s.toUpperCase(); if (!seen.has(k)) { seen.add(k); variants.push(k); } };
  push(`${base}.NS`);
  if (stripped !== base) push(`${stripped}.NS`);
  push(`${base}.BO`);
  if (stripped !== base) push(`${stripped}.BO`);

  for (const sym of variants) {
    const r = await getPrice(sym);
    if (r && r.price != null) {
      return { ...r, live: true, resolved_symbol: sym };
    }
  }
  return { symbol: base, price: null, live: false, error: 'no_variant_found', tried: variants };
}
