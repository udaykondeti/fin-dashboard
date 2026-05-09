import { useState, FormEvent } from 'react';
import { useFetch } from '../lib/useFetch';
import { api } from '../api/client';
import { fmtINR } from '../lib/format';
import { PageHeader, PrimaryButton, DangerButton } from '../components/PageHeader';
import { Modal, Field, inputClass } from '../components/Modal';

export function Earnings() {
  const { data, loading, refetch } = useFetch<{ earnings: any[] }>('/api/earnings');
  const [open, setOpen] = useState(false);
  const earnings = data?.earnings || [];
  const grossMonthly = earnings.reduce((s, e) => s + (Number(e.gross_monthly) || 0) * ((Number(e.share_percentage)||100)/100), 0);
  const netMonthly   = earnings.reduce((s, e) => s + (Number(e.net_monthly)   || 0) * ((Number(e.share_percentage)||100)/100), 0);

  return (
    <div className="space-y-5">
      <PageHeader title="Earnings" subtitle="Income sources, post-TDS net, cash flow"
        right={<PrimaryButton onClick={() => setOpen(true)}>+ Add Income</PrimaryButton>} />
      <div className="grid grid-cols-2 gap-4">
        <div className="surface p-4">
          <div className="text-xs text-mocha uppercase tracking-wider">Gross Monthly</div>
          <div className="text-2xl font-bold text-leaf">{fmtINR(grossMonthly)}</div>
        </div>
        <div className="surface p-4">
          <div className="text-xs text-mocha uppercase tracking-wider">Net Monthly (after TDS)</div>
          <div className="text-2xl font-bold text-caramel">{fmtINR(netMonthly)}</div>
          <div className="text-[11px] text-mocha mt-0.5">{netMonthly < grossMonthly ? `~${fmtINR(grossMonthly - netMonthly)} TDS` : 'No TDS configured'}</div>
        </div>
      </div>
      {loading && <div className="text-mocha">Loading…</div>}
      {earnings.length > 0 && (
        <div className="surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-foam text-mocha text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-left">Frequency</th>
                <th className="px-3 py-2 text-right">Net/mo</th>
                <th className="px-3 py-2 text-left">Tax</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-latte">
              {earnings.map(e => (
                <tr key={e.id}>
                  <td className="px-3 py-2 font-medium">{e.source_name}{e.is_auto && <span className="ml-2 text-[10px] px-1 rounded bg-mocha/10 text-mocha">auto</span>}</td>
                  <td className="px-3 py-2 text-xs text-mocha">{e.source_type}</td>
                  <td className="px-3 py-2 text-right">{fmtINR(e.amount)}</td>
                  <td className="px-3 py-2 text-mocha">{e.frequency}</td>
                  <td className="px-3 py-2 text-right text-leaf font-semibold">{fmtINR(e.net_monthly)}</td>
                  <td className="px-3 py-2 text-xs text-mocha">{e.tax_source || '—'}</td>
                  <td className="px-3 py-2">
                    {!e.is_auto && <DangerButton onClick={async () => {
                      if (!confirm('Delete?')) return;
                      await api.del(`/api/earnings/${e.id}`); refetch();
                    }}>Del</DangerButton>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AddEarningModal open={open} onClose={() => setOpen(false)} onAdded={refetch} />
    </div>
  );
}

function AddEarningModal({ open, onClose, onAdded }: any) {
  const [name, setName] = useState(''); const [type, setType] = useState('Salary');
  const [amount, setAmount] = useState(''); const [freq, setFreq] = useState('Monthly');
  const [tdsRate, setTdsRate] = useState(''); const [received, setReceived] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{id:number}>('/api/earnings', {
        source_name: name, source_type: type, amount: parseFloat(amount),
        frequency: freq,
        tds_rate: tdsRate ? parseFloat(tdsRate) : null,
        actual_received: received ? parseFloat(received) : null
      });
      if (r.id) { onAdded(); onClose(); }
    } catch (e: any) { alert(e?.error || 'Save failed'); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add Income Source"
      footer={<><button onClick={onClose} className="px-3 py-1.5 rounded border border-latte text-mocha text-sm">Cancel</button>
               <button onClick={submit} className="px-4 py-1.5 rounded bg-caramel text-cream text-sm font-semibold">Save</button></>}>
      <form onSubmit={submit}>
        <Field label="Source Name *"><input className={inputClass} value={name} onChange={e=>setName(e.target.value)} required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type"><select className={inputClass} value={type} onChange={e=>setType(e.target.value)}>
            <option>Salary</option><option>Rent</option><option>Interest</option><option>Dividends</option><option>Freelance</option><option>Business</option><option>Other</option>
          </select></Field>
          <Field label="Frequency"><select className={inputClass} value={freq} onChange={e=>setFreq(e.target.value)}>
            <option>Monthly</option><option>Annual</option><option>Quarterly</option><option>One-time</option>
          </select></Field>
        </div>
        <Field label="Amount (₹) *"><input className={inputClass} type="number" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="TDS Rate (%)" hint="Optional. Salary auto-uses slab estimate.">
            <input className={inputClass} type="number" step="0.1" value={tdsRate} onChange={e=>setTdsRate(e.target.value)} />
          </Field>
          <Field label="Actual Received" hint="Overrides TDS calc">
            <input className={inputClass} type="number" step="0.01" value={received} onChange={e=>setReceived(e.target.value)} />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
