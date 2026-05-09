import { useState, FormEvent } from 'react';
import { useFetch } from '../lib/useFetch';
import { api } from '../api/client';
import { fmtINR, fmtDate } from '../lib/format';
import { PageHeader, PrimaryButton, DangerButton } from '../components/PageHeader';
import { Modal, Field, inputClass } from '../components/Modal';

export function Payments() {
  const { data, loading, refetch } = useFetch<{ scheduled_payments: any[] }>('/api/payments');
  const [open, setOpen] = useState(false);
  const pays = data?.scheduled_payments || [];
  const monthly = pays.filter(p => p.is_active).reduce((s, p) => {
    if (p.frequency === 'Monthly')   return s + Number(p.amount || 0);
    if (p.frequency === 'Annual')    return s + Number(p.amount || 0) / 12;
    if (p.frequency === 'Quarterly') return s + Number(p.amount || 0) / 3;
    return s;
  }, 0);
  return (
    <div className="space-y-5">
      <PageHeader title="Scheduled Payments" subtitle="Recurring bills, EMIs, SIPs, subscriptions"
        right={<PrimaryButton onClick={() => setOpen(true)}>+ Add Payment</PrimaryButton>} />
      <div className="surface p-4 inline-block">
        <div className="text-xs text-mocha uppercase tracking-wider">Monthly Outflows</div>
        <div className="text-2xl font-bold text-rust">{fmtINR(monthly)}</div>
      </div>
      {loading && <div className="text-mocha">Loading…</div>}
      {pays.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {pays.map(p => (
            <div key={p.id} className="surface p-3">
              <div className="flex justify-between items-start">
                <div>
                  <div className="font-semibold text-espresso">{p.name}</div>
                  <div className="text-xs text-mocha">{p.category} · {p.frequency}</div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-rust">{fmtINR(p.amount)}</div>
                  {p.next_due_date && <div className="text-[11px] text-mocha">Due {fmtDate(p.next_due_date)}</div>}
                </div>
              </div>
              <div className="flex justify-end mt-2">
                <DangerButton onClick={async () => {
                  if (!confirm('Delete?')) return;
                  await api.del(`/api/payments/${p.id}`); refetch();
                }}>Del</DangerButton>
              </div>
            </div>
          ))}
        </div>
      )}
      <AddPaymentModal open={open} onClose={() => setOpen(false)} onAdded={refetch} />
    </div>
  );
}

function AddPaymentModal({ open, onClose, onAdded }: any) {
  const [name, setName] = useState(''); const [category, setCategory] = useState('Other');
  const [amount, setAmount] = useState(''); const [freq, setFreq] = useState('Monthly');
  const [due, setDue] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{id:number}>('/api/payments', {
        name, category, amount: parseFloat(amount), frequency: freq,
        next_due_date: due || null, auto_debit: false, is_active: true
      });
      if (r.id) { onAdded(); onClose(); }
    } catch (e: any) { alert(e?.error || 'Save failed'); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add Scheduled Payment"
      footer={<><button onClick={onClose} className="px-3 py-1.5 rounded border border-latte text-mocha text-sm">Cancel</button>
               <button onClick={submit} className="px-4 py-1.5 rounded bg-caramel text-cream text-sm font-semibold">Save</button></>}>
      <form onSubmit={submit}>
        <Field label="Name *"><input className={inputClass} value={name} onChange={e=>setName(e.target.value)} required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category"><select className={inputClass} value={category} onChange={e=>setCategory(e.target.value)}>
            <option>EMI</option><option>SIP</option><option>Insurance</option><option>Tax</option><option>Rent</option><option>Other</option>
          </select></Field>
          <Field label="Frequency"><select className={inputClass} value={freq} onChange={e=>setFreq(e.target.value)}>
            <option>Monthly</option><option>Annual</option><option>Quarterly</option><option>Weekly</option><option>One-time</option>
          </select></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (₹) *"><input className={inputClass} type="number" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} required /></Field>
          <Field label="Next Due"><input className={inputClass} type="date" value={due} onChange={e=>setDue(e.target.value)} /></Field>
        </div>
      </form>
    </Modal>
  );
}
