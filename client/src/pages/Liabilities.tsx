import { useState, FormEvent } from 'react';
import { useFetch } from '../lib/useFetch';
import { api } from '../api/client';
import { fmtINR } from '../lib/format';
import { PageHeader, PrimaryButton, DangerButton } from '../components/PageHeader';
import { Modal, Field, inputClass } from '../components/Modal';

export function Liabilities() {
  const [tab, setTab] = useState<'cc'|'loans'>('cc');
  return (
    <div className="space-y-5">
      <PageHeader title="Liabilities" subtitle="Credit cards, loans" />
      <div className="flex gap-1 border-b border-latte">
        {(['cc','loans'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium ${tab===t ? 'text-caramel border-b-2 border-caramel' : 'text-mocha hover:text-espresso'}`}>
            {t==='cc' ? 'Credit Cards' : 'Loans'}
          </button>
        ))}
      </div>
      {tab==='cc' ? <CCTab /> : <LoansTab />}
    </div>
  );
}

function CCTab() {
  const { data, loading, refetch } = useFetch<{ credit_cards: any[] }>('/api/liabilities/credit-cards');
  const [open, setOpen] = useState(false);
  const cards = data?.credit_cards || [];
  return (
    <div>
      <div className="flex justify-end mb-3"><PrimaryButton onClick={() => setOpen(true)}>+ Add Card</PrimaryButton></div>
      {loading && <div className="text-mocha">Loading…</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {cards.map(c => {
          const util = (c.outstanding_balance / c.card_limit) * 100;
          return (
            <div key={c.id} className="surface p-4">
              <div className="flex justify-between items-start">
                <div>
                  <div className="font-semibold text-espresso">{c.bank}</div>
                  <div className="text-xs text-mocha">{c.card_name} ···{c.last4}</div>
                </div>
                <DangerButton onClick={async () => {
                  if (!confirm('Remove?')) return;
                  await api.del(`/api/liabilities/credit-cards/${c.id}`); refetch();
                }}>Del</DangerButton>
              </div>
              <div className="my-3">
                <div className="text-xs text-mocha">Outstanding</div>
                <div className={`text-xl font-bold ${util > 80 ? 'text-rust' : 'text-espresso'}`}>{fmtINR(c.outstanding_balance)}</div>
                <div className="text-[11px] text-mocha mt-0.5">of {fmtINR(c.card_limit)} limit · {util.toFixed(1)}% used</div>
              </div>
              <div className="h-1.5 bg-latte rounded-full overflow-hidden">
                <div className={`h-full ${util > 80 ? 'bg-rust' : util > 50 ? 'bg-caramel' : 'bg-leaf'}`} style={{ width: Math.min(util, 100) + '%' }} />
              </div>
              {c.due_date && <div className="text-xs text-mocha mt-2">Due: {c.due_date}</div>}
            </div>
          );
        })}
      </div>
      <AddCCModal open={open} onClose={() => setOpen(false)} onAdded={refetch} />
    </div>
  );
}

function AddCCModal({ open, onClose, onAdded }: any) {
  const [name, setName] = useState(''); const [bank, setBank] = useState('');
  const [limit, setLimit] = useState(''); const [outstanding, setOutstanding] = useState('');
  const [last4, setLast4] = useState(''); const [due, setDue] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{success:boolean}>('/api/liabilities/credit-cards', {
        card_name: name, bank, card_limit: parseFloat(limit),
        outstanding_balance: parseFloat(outstanding) || 0,
        last4: last4 || '0000', due_date: due || null
      });
      if (r.success) { onAdded(); onClose(); }
    } catch (e: any) { alert(e?.error || 'Save failed'); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add Credit Card"
      footer={<><button onClick={onClose} className="px-3 py-1.5 rounded border border-latte text-mocha text-sm">Cancel</button>
               <button onClick={submit} className="px-4 py-1.5 rounded bg-caramel text-cream text-sm font-semibold">Save</button></>}>
      <form onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Card Name *"><input className={inputClass} value={name} onChange={e=>setName(e.target.value)} required /></Field>
          <Field label="Bank *"><input className={inputClass} value={bank} onChange={e=>setBank(e.target.value)} required /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Limit (₹) *"><input className={inputClass} type="number" value={limit} onChange={e=>setLimit(e.target.value)} required /></Field>
          <Field label="Outstanding (₹)"><input className={inputClass} type="number" value={outstanding} onChange={e=>setOutstanding(e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Last 4"><input className={inputClass} maxLength={4} value={last4} onChange={e=>setLast4(e.target.value)} /></Field>
          <Field label="Due Date"><input className={inputClass} type="date" value={due} onChange={e=>setDue(e.target.value)} /></Field>
        </div>
      </form>
    </Modal>
  );
}

function LoansTab() {
  const { data, loading, refetch } = useFetch<{ loans: any[] }>('/api/liabilities/loans');
  const [open, setOpen] = useState(false);
  const loans = data?.loans || [];
  return (
    <div>
      <div className="flex justify-end mb-3"><PrimaryButton onClick={() => setOpen(true)}>+ Add Loan</PrimaryButton></div>
      {loading && <div className="text-mocha">Loading…</div>}
      {loans.length > 0 && (
        <div className="surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-foam text-mocha text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Lender</th>
                <th className="px-3 py-2 text-right">Outstanding</th>
                <th className="px-3 py-2 text-right">EMI</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-left">Ends</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-latte">
              {loans.map(l => (
                <tr key={l.id}>
                  <td className="px-3 py-2">{l.loan_type}</td>
                  <td className="px-3 py-2 text-mocha">{l.lender}</td>
                  <td className="px-3 py-2 text-right text-rust font-semibold">{fmtINR(l.outstanding_amount)}</td>
                  <td className="px-3 py-2 text-right">{fmtINR(l.emi_amount)}/mo</td>
                  <td className="px-3 py-2 text-right">{l.interest_rate}%</td>
                  <td className="px-3 py-2 text-mocha">{l.end_date || '—'}</td>
                  <td className="px-3 py-2"><DangerButton onClick={async () => {
                    if (!confirm('Delete?')) return;
                    await api.del(`/api/liabilities/loans/${l.id}`); refetch();
                  }}>Del</DangerButton></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AddLoanModal open={open} onClose={() => setOpen(false)} onAdded={refetch} />
    </div>
  );
}

function AddLoanModal({ open, onClose, onAdded }: any) {
  const [type, setType] = useState('Home'); const [lender, setLender] = useState('');
  const [outstanding, setOutstanding] = useState(''); const [emi, setEmi] = useState('');
  const [rate, setRate] = useState(''); const [end, setEnd] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{success:boolean}>('/api/liabilities/loans', {
        loan_type: type, lender,
        principal_amount: parseFloat(outstanding),
        outstanding_amount: parseFloat(outstanding),
        emi_amount: parseFloat(emi) || 0,
        interest_rate: parseFloat(rate) || 0,
        end_date: end || null
      });
      if (r.success) { onAdded(); onClose(); }
    } catch (e: any) { alert(e?.error || 'Save failed'); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add Loan"
      footer={<><button onClick={onClose} className="px-3 py-1.5 rounded border border-latte text-mocha text-sm">Cancel</button>
               <button onClick={submit} className="px-4 py-1.5 rounded bg-caramel text-cream text-sm font-semibold">Save</button></>}>
      <form onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type"><select className={inputClass} value={type} onChange={e=>setType(e.target.value)}>
            <option>Home</option><option>Personal</option><option>Auto</option><option>Education</option><option>Business</option><option>Other</option>
          </select></Field>
          <Field label="Lender *"><input className={inputClass} value={lender} onChange={e=>setLender(e.target.value)} required /></Field>
        </div>
        <Field label="Outstanding (₹) *"><input className={inputClass} type="number" value={outstanding} onChange={e=>setOutstanding(e.target.value)} required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="EMI (₹/mo)"><input className={inputClass} type="number" value={emi} onChange={e=>setEmi(e.target.value)} /></Field>
          <Field label="Rate (% p.a.)"><input className={inputClass} type="number" step="0.01" value={rate} onChange={e=>setRate(e.target.value)} /></Field>
        </div>
        <Field label="End Date"><input className={inputClass} type="date" value={end} onChange={e=>setEnd(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
