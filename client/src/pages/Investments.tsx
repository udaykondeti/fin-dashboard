import { useState, FormEvent } from 'react';
import { useFetch } from '../lib/useFetch';
import { api } from '../api/client';
import { fmtINR, fmtUSD, fmtPct, plClass } from '../lib/format';
import { PageHeader, PrimaryButton, DangerButton } from '../components/PageHeader';
import { Modal, Field, inputClass } from '../components/Modal';

type Tab = 'stocks' | 'mf' | 'fd' | 'us';

export function Investments() {
  const [tab, setTab] = useState<Tab>('stocks');
  return (
    <div className="space-y-5">
      <PageHeader title="Investments" subtitle="Stocks, mutual funds, FDs, US holdings" />
      <div className="flex gap-1 border-b border-latte">
        {(['stocks','mf','fd','us'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium ${tab===t ? 'text-caramel border-b-2 border-caramel' : 'text-mocha hover:text-espresso'}`}
          >
            {{ stocks:'Indian Stocks', mf:'Mutual Funds', fd:'FD/RD', us:'US Stocks' }[t]}
          </button>
        ))}
      </div>
      {tab==='stocks' && <StocksTab />}
      {tab==='mf'     && <MutualFundsTab />}
      {tab==='fd'     && <FDsTab />}
      {tab==='us'     && <USStocksTab />}
    </div>
  );
}

// ─────────────────────────── Indian Stocks ───────────────────────────
function StocksTab() {
  const { data, loading, refetch } = useFetch<{ stocks: any[] }>('/api/investments/stocks');
  const [open, setOpen] = useState(false);
  const stocks = data?.stocks || [];

  let totalInv = 0, totalVal = 0;
  stocks.forEach(s => { totalInv += s.quantity * s.avg_buy_price; totalVal += s.quantity * (s.current_price || s.avg_buy_price); });
  const pl = totalVal - totalInv, plp = totalInv ? (pl/totalInv)*100 : 0;

  return (
    <div>
      <div className="flex justify-end mb-3"><PrimaryButton onClick={() => setOpen(true)}>+ Add Stock</PrimaryButton></div>
      {loading && <div className="text-mocha">Loading…</div>}
      {!loading && stocks.length === 0 && <div className="surface p-6 text-center text-mocha">No holdings yet. Add one or use the Import tab in v1.</div>}
      {stocks.length > 0 && (
        <div className="surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-foam text-mocha text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left">Symbol</th>
                <th className="px-3 py-2 text-left">Exch</th>
                <th className="px-3 py-2 text-left">Company</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Avg</th>
                <th className="px-3 py-2 text-right">Current</th>
                <th className="px-3 py-2 text-right">Invested</th>
                <th className="px-3 py-2 text-right">Value</th>
                <th className="px-3 py-2 text-right">P&amp;L</th>
                <th className="px-3 py-2 text-right">P&amp;L %</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-latte">
              {stocks.map(s => {
                const inv = s.quantity * s.avg_buy_price;
                const val = s.quantity * (s.current_price || s.avg_buy_price);
                const pls = val - inv, plps = inv ? (pls/inv)*100 : 0;
                const exch = (s.resolved_symbol || '').endsWith('.BO') ? 'BSE' : 'NSE';
                return (
                  <tr key={s.id} className="hover:bg-foam/50">
                    <td className="px-3 py-2 font-bold">{s.symbol}</td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`px-1.5 py-0.5 rounded ${exch==='BSE' ? 'bg-rust/10 text-rust' : 'bg-leaf/10 text-leaf'}`}>{exch}</span>
                    </td>
                    <td className="px-3 py-2 text-mocha">{s.company_name}</td>
                    <td className="px-3 py-2 text-right">{s.quantity}</td>
                    <td className="px-3 py-2 text-right">{fmtINR(s.avg_buy_price)}</td>
                    <td className="px-3 py-2 text-right">
                      {fmtINR(s.current_price || s.avg_buy_price)}
                      {s.live_price ? <span className="ml-1.5 text-[10px] px-1 rounded bg-leaf/15 text-leaf">LIVE</span>
                                    : <span className="ml-1.5 text-[10px] px-1 rounded bg-mocha/10 text-mocha" title={s.price_tried?.join(', ')}>N/A</span>}
                    </td>
                    <td className="px-3 py-2 text-right">{fmtINR(inv)}</td>
                    <td className="px-3 py-2 text-right">{fmtINR(val)}</td>
                    <td className={`px-3 py-2 text-right ${plClass(pls)}`}>{fmtINR(pls)}</td>
                    <td className={`px-3 py-2 text-right ${plClass(plps)}`}>{fmtPct(plps)}</td>
                    <td className="px-3 py-2 text-right">
                      <DangerButton onClick={async () => {
                        if (!confirm('Delete ' + s.symbol + '?')) return;
                        await api.del(`/api/investments/stocks/${s.id}`);
                        refetch();
                      }}>Del</DangerButton>
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-foam font-semibold">
                <td className="px-3 py-2" colSpan={6}>Total</td>
                <td className="px-3 py-2 text-right">{fmtINR(totalInv)}</td>
                <td className="px-3 py-2 text-right">{fmtINR(totalVal)}</td>
                <td className={`px-3 py-2 text-right ${plClass(pl)}`}>{fmtINR(pl)}</td>
                <td className={`px-3 py-2 text-right ${plClass(plp)}`}>{fmtPct(plp)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <AddStockModal open={open} onClose={() => setOpen(false)} onAdded={refetch} />
    </div>
  );
}

function AddStockModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [symbol, setSymbol] = useState('');
  const [company, setCompany] = useState('');
  const [qty, setQty] = useState('');
  const [avg, setAvg] = useState('');
  const [busy, setBusy] = useState(false);

  async function lookup() {
    if (!symbol) return;
    try {
      const r = await api.get<any>('/api/investments/lookup-indian?symbol=' + encodeURIComponent(symbol));
      if (r.name && !company) setCompany(r.name);
      if (r.price && !avg) setAvg(String(r.price));
    } catch (_) { /* silent */ }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post<{ success: boolean }>('/api/investments/stocks', {
        symbol: symbol.toUpperCase(),
        company_name: company || symbol.toUpperCase(),
        quantity: parseFloat(qty),
        avg_buy_price: parseFloat(avg)
      });
      if (r.success) { onAdded(); onClose(); setSymbol(''); setCompany(''); setQty(''); setAvg(''); }
    } catch (e: any) { alert(e?.error || 'Save failed'); }
    finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add Indian Stock"
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 rounded border border-latte text-mocha text-sm">Cancel</button>
        <button onClick={submit} disabled={busy} className="px-4 py-1.5 rounded bg-caramel text-cream text-sm font-semibold disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
      </>}
    >
      <form onSubmit={submit}>
        <Field label="Symbol *" hint="Tab out to auto-fill company + price">
          <input className={inputClass} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} onBlur={lookup} placeholder="RELIANCE" required />
        </Field>
        <Field label="Company">
          <input className={inputClass} value={company} onChange={e => setCompany(e.target.value)} placeholder="Reliance Industries Ltd" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity *">
            <input className={inputClass} type="number" step="0.0001" value={qty} onChange={e => setQty(e.target.value)} required />
          </Field>
          <Field label="Avg Buy Price (₹) *">
            <input className={inputClass} type="number" step="0.01" value={avg} onChange={e => setAvg(e.target.value)} required />
          </Field>
        </div>
      </form>
    </Modal>
  );
}

// ─────────────────────────── Mutual Funds ────────────────────────────
function MutualFundsTab() {
  const { data, loading, refetch } = useFetch<{ mutual_funds: any[] }>('/api/investments/mutual-funds');
  const [open, setOpen] = useState(false);
  const mfs = data?.mutual_funds || [];
  return (
    <div>
      <div className="flex justify-end mb-3"><PrimaryButton onClick={() => setOpen(true)}>+ Add Fund</PrimaryButton></div>
      {loading && <div className="text-mocha">Loading…</div>}
      {!loading && mfs.length === 0 && <div className="surface p-6 text-center text-mocha">No mutual funds yet.</div>}
      {mfs.length > 0 && (
        <div className="surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-foam text-mocha text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left">Fund</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-right">Units</th>
                <th className="px-3 py-2 text-right">Avg NAV</th>
                <th className="px-3 py-2 text-right">Current</th>
                <th className="px-3 py-2 text-right">Invested</th>
                <th className="px-3 py-2 text-right">Value</th>
                <th className="px-3 py-2 text-right">P&amp;L %</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-latte">
              {mfs.map(m => {
                const cur = m.current_nav || m.avg_nav;
                const inv = m.units * m.avg_nav;
                const val = m.units * cur;
                const plp = inv ? ((val-inv)/inv)*100 : 0;
                return (
                  <tr key={m.id} className="hover:bg-foam/50">
                    <td className="px-3 py-2 font-medium">{m.fund_name}</td>
                    <td className="px-3 py-2 text-xs"><span className="px-1.5 py-0.5 rounded bg-caramel/10 text-caramel">{m.fund_type || 'Equity'}</span></td>
                    <td className="px-3 py-2 text-right">{Number(m.units).toFixed(3)}</td>
                    <td className="px-3 py-2 text-right">{fmtINR(m.avg_nav)}</td>
                    <td className="px-3 py-2 text-right">
                      {fmtINR(cur)}
                      {m.live_nav ? <span className="ml-1.5 text-[10px] px-1 rounded bg-leaf/15 text-leaf" title={m.nav_source || ''}>LIVE</span>
                                  : <span className="ml-1.5 text-[10px] px-1 rounded bg-mocha/10 text-mocha" title="Set scheme code on v1 to enable">N/A</span>}
                    </td>
                    <td className="px-3 py-2 text-right">{fmtINR(inv)}</td>
                    <td className="px-3 py-2 text-right">{fmtINR(val)}</td>
                    <td className={`px-3 py-2 text-right ${plClass(plp)}`}>{fmtPct(plp)}</td>
                    <td className="px-3 py-2 text-right">
                      <DangerButton onClick={async () => {
                        if (!confirm('Delete ' + m.fund_name + '?')) return;
                        await api.del(`/api/investments/mutual-funds/${m.id}`);
                        refetch();
                      }}>Del</DangerButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <AddMFModal open={open} onClose={() => setOpen(false)} onAdded={refetch} />
    </div>
  );
}

function AddMFModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('Equity');
  const [units, setUnits] = useState('');
  const [nav, setNav] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api.post<{ success: boolean }>('/api/investments/mutual-funds', {
        fund_name: name, fund_type: type, units: parseFloat(units), avg_nav: parseFloat(nav)
      });
      if (r.success) { onAdded(); onClose(); setName(''); setUnits(''); setNav(''); }
    } catch (e: any) { alert(e?.error || 'Save failed'); }
    finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add Mutual Fund"
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 rounded border border-latte text-mocha text-sm">Cancel</button>
        <button onClick={submit} disabled={busy} className="px-4 py-1.5 rounded bg-caramel text-cream text-sm font-semibold">{busy ? 'Saving…' : 'Save'}</button>
      </>}
    >
      <form onSubmit={submit}>
        <Field label="Fund Name *"><input className={inputClass} value={name} onChange={e => setName(e.target.value)} required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <select className={inputClass} value={type} onChange={e => setType(e.target.value)}>
              <option>Equity</option><option>Debt</option><option>Hybrid</option><option>ETF</option><option>Liquid</option>
            </select>
          </Field>
          <Field label="Units *"><input className={inputClass} type="number" step="0.001" value={units} onChange={e => setUnits(e.target.value)} required /></Field>
        </div>
        <Field label="Avg NAV (₹) *"><input className={inputClass} type="number" step="0.01" value={nav} onChange={e => setNav(e.target.value)} required /></Field>
      </form>
    </Modal>
  );
}

// ─────────────────────────── FDs ─────────────────────────────────────
function FDsTab() {
  const { data, loading, refetch } = useFetch<{ fixed_deposits: any[] }>('/api/investments/fds');
  const [open, setOpen] = useState(false);
  const fds = data?.fixed_deposits || [];
  return (
    <div>
      <div className="flex justify-end mb-3"><PrimaryButton onClick={() => setOpen(true)}>+ Add FD/RD</PrimaryButton></div>
      {loading && <div className="text-mocha">Loading…</div>}
      {!loading && fds.length === 0 && <div className="surface p-6 text-center text-mocha">No FDs yet.</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {fds.map(f => (
          <div key={f.id} className="surface p-4">
            <div className="flex justify-between items-start mb-2">
              <div>
                <div className="font-semibold text-espresso">{f.bank_name}</div>
                <div className="text-xs text-mocha">{f.fd_type || 'Cumulative'}</div>
              </div>
              <DangerButton onClick={async () => {
                if (!confirm('Delete?')) return;
                await api.del(`/api/investments/fds/${f.id}`); refetch();
              }}>Del</DangerButton>
            </div>
            <div className="text-2xl font-bold text-leaf">{fmtINR(f.principal)}</div>
            <div className="text-sm text-mocha mt-1">{f.interest_rate}% p.a. · matures {f.maturity_date || '—'}</div>
          </div>
        ))}
      </div>
      <AddFDModal open={open} onClose={() => setOpen(false)} onAdded={refetch} />
    </div>
  );
}

function AddFDModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [bank, setBank] = useState(''); const [type, setType] = useState('Cumulative');
  const [principal, setPrincipal] = useState(''); const [rate, setRate] = useState('');
  const [start, setStart] = useState(''); const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api.post<{ success: boolean }>('/api/investments/fds', {
        bank_name: bank, fd_type: type, principal: parseFloat(principal),
        interest_rate: parseFloat(rate), start_date: start, maturity_date: end
      });
      if (r.success) { onAdded(); onClose(); setBank(''); setPrincipal(''); setRate(''); }
    } catch (e: any) { alert(e?.error || 'Save failed'); }
    finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add FD / RD"
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 rounded border border-latte text-mocha text-sm">Cancel</button>
        <button onClick={submit} disabled={busy} className="px-4 py-1.5 rounded bg-caramel text-cream text-sm font-semibold">{busy ? 'Saving…' : 'Save'}</button>
      </>}
    >
      <form onSubmit={submit}>
        <Field label="Bank *"><input className={inputClass} value={bank} onChange={e => setBank(e.target.value)} required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type"><select className={inputClass} value={type} onChange={e => setType(e.target.value)}><option>Cumulative</option><option>Non-Cumulative</option><option>RD</option></select></Field>
          <Field label="Principal (₹) *"><input className={inputClass} type="number" step="0.01" value={principal} onChange={e => setPrincipal(e.target.value)} required /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Interest Rate (% p.a.) *"><input className={inputClass} type="number" step="0.01" value={rate} onChange={e => setRate(e.target.value)} required /></Field>
          <Field label="Start Date"><input className={inputClass} type="date" value={start} onChange={e => setStart(e.target.value)} /></Field>
        </div>
        <Field label="Maturity Date"><input className={inputClass} type="date" value={end} onChange={e => setEnd(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}

// ─────────────────────────── US Stocks ───────────────────────────────
function USStocksTab() {
  const { data: fxData } = useFetch<{ rate: number; source: string }>('/api/investments/usd-inr');
  const usdInr = fxData?.rate || 84;
  const { data, loading, refetch } = useFetch<{ us_stocks: any[] }>('/api/investments/us-stocks');
  const [open, setOpen] = useState(false);
  const stocks = data?.us_stocks || [];
  let totalInvUsd = 0, totalValUsd = 0;
  stocks.forEach(s => { totalInvUsd += s.quantity * s.avg_buy_price_usd; totalValUsd += s.quantity * (s.current_price_usd || s.avg_buy_price_usd); });
  return (
    <div>
      <div className="flex justify-between items-center mb-3">
        <div className="text-sm text-mocha">USD/INR: <span className="font-semibold text-espresso">{usdInr.toFixed(2)}</span> {fxData?.source==='live' && <span className="text-xs text-leaf">(🟢 live)</span>}</div>
        <PrimaryButton onClick={() => setOpen(true)}>+ Add US Stock</PrimaryButton>
      </div>
      {loading && <div className="text-mocha">Loading…</div>}
      {!loading && stocks.length === 0 && <div className="surface p-6 text-center text-mocha">No US holdings yet.</div>}
      {stocks.length > 0 && (
        <div className="surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-foam text-mocha text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left">Symbol</th>
                <th className="px-3 py-2 text-left">Company</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Avg (USD)</th>
                <th className="px-3 py-2 text-right">Current (USD)</th>
                <th className="px-3 py-2 text-right">Inv (USD)</th>
                <th className="px-3 py-2 text-right">Val (USD)</th>
                <th className="px-3 py-2 text-right">Inv (INR)</th>
                <th className="px-3 py-2 text-right">Val (INR)</th>
                <th className="px-3 py-2 text-right">P&amp;L %</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-latte">
              {stocks.map(s => {
                const cur = s.current_price_usd || s.avg_buy_price_usd;
                const invUsd = s.quantity * s.avg_buy_price_usd;
                const valUsd = s.quantity * cur;
                const plp = invUsd ? ((valUsd-invUsd)/invUsd)*100 : 0;
                return (
                  <tr key={s.id} className="hover:bg-foam/50">
                    <td className="px-3 py-2 font-bold">{s.symbol}</td>
                    <td className="px-3 py-2 text-mocha">{s.company_name}</td>
                    <td className="px-3 py-2 text-right">{Math.round(s.quantity * 1e6) / 1e6}</td>
                    <td className="px-3 py-2 text-right">{fmtUSD(s.avg_buy_price_usd)}</td>
                    <td className="px-3 py-2 text-right">
                      {fmtUSD(cur)}
                      {s.live_price ? <span className="ml-1.5 text-[10px] px-1 rounded bg-leaf/15 text-leaf">LIVE</span>
                                    : <span className="ml-1.5 text-[10px] px-1 rounded bg-mocha/10 text-mocha">N/A</span>}
                    </td>
                    <td className="px-3 py-2 text-right">{fmtUSD(invUsd)}</td>
                    <td className="px-3 py-2 text-right">{fmtUSD(valUsd)}</td>
                    <td className="px-3 py-2 text-right">{fmtINR(invUsd * usdInr)}</td>
                    <td className="px-3 py-2 text-right">{fmtINR(valUsd * usdInr)}</td>
                    <td className={`px-3 py-2 text-right ${plClass(plp)}`}>{fmtPct(plp)}</td>
                    <td className="px-3 py-2 text-right">
                      <DangerButton onClick={async () => {
                        if (!confirm('Delete ' + s.symbol + '?')) return;
                        await api.del(`/api/investments/us-stocks/${s.id}`); refetch();
                      }}>Del</DangerButton>
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-foam font-semibold">
                <td className="px-3 py-2" colSpan={5}>Total</td>
                <td className="px-3 py-2 text-right">{fmtUSD(totalInvUsd)}</td>
                <td className="px-3 py-2 text-right">{fmtUSD(totalValUsd)}</td>
                <td className="px-3 py-2 text-right">{fmtINR(totalInvUsd * usdInr)}</td>
                <td className="px-3 py-2 text-right">{fmtINR(totalValUsd * usdInr)}</td>
                <td className={`px-3 py-2 text-right ${plClass(totalValUsd-totalInvUsd)}`}>
                  {totalInvUsd ? fmtPct(((totalValUsd-totalInvUsd)/totalInvUsd)*100) : '—'}
                </td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <AddUSStockModal open={open} onClose={() => setOpen(false)} onAdded={refetch} />
    </div>
  );
}

function AddUSStockModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [symbol, setSymbol] = useState(''); const [company, setCompany] = useState('');
  const [qty, setQty] = useState(''); const [avg, setAvg] = useState('');
  const [busy, setBusy] = useState(false);
  async function lookup() {
    if (!symbol) return;
    try {
      const r = await api.get<any>('/api/investments/prices?symbols=' + encodeURIComponent(symbol.toUpperCase()));
      const entry = r.prices && r.prices[symbol.toUpperCase()];
      if (entry?.name && !company) setCompany(entry.name);
      if (entry?.price && !avg) setAvg(Number(entry.price).toFixed(2));
    } catch (_) {}
  }
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api.post<{ success: boolean }>('/api/investments/us-stocks', {
        symbol: symbol.toUpperCase(),
        company_name: company || symbol.toUpperCase(),
        quantity: parseFloat(qty),
        avg_buy_price_usd: parseFloat(avg)
      });
      if (r.success) { onAdded(); onClose(); setSymbol(''); setCompany(''); setQty(''); setAvg(''); }
    } catch (e: any) { alert(e?.error || 'Save failed'); }
    finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add US Stock"
      footer={<>
        <button onClick={onClose} className="px-3 py-1.5 rounded border border-latte text-mocha text-sm">Cancel</button>
        <button onClick={submit} disabled={busy} className="px-4 py-1.5 rounded bg-caramel text-cream text-sm font-semibold">{busy ? 'Saving…' : 'Save'}</button>
      </>}
    >
      <form onSubmit={submit}>
        <Field label="Symbol *" hint="Tab out to auto-fill company + price">
          <input className={inputClass} value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} onBlur={lookup} placeholder="AAPL" required />
        </Field>
        <Field label="Company"><input className={inputClass} value={company} onChange={e => setCompany(e.target.value)} placeholder="Apple Inc." /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity *" hint="Up to 6 decimals">
            <input className={inputClass} type="number" step="0.000001" value={qty} onChange={e => setQty(e.target.value)} required />
          </Field>
          <Field label="Avg Buy Price (USD) *">
            <input className={inputClass} type="number" step="0.01" value={avg} onChange={e => setAvg(e.target.value)} required />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
