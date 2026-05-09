import { useState, FormEvent } from 'react';
import { useFetch } from '../lib/useFetch';
import { api } from '../api/client';
import { fmtINR } from '../lib/format';
import { PageHeader, PrimaryButton, DangerButton } from '../components/PageHeader';
import { Modal, Field, inputClass } from '../components/Modal';

export function HandLoans() {
  const { data, loading, refetch } = useFetch<{ hand_loans: any[] }>('/api/loans/hand-loans');
  const [open, setOpen] = useState(false);
  const all = data?.hand_loans || [];
  const given = all.filter(l => l.direction === 'given' && l.status !== 'settled');
  const taken = all.filter(l => l.direction === 'taken' && l.status !== 'settled');
  const lent = given.reduce((s,l) => s + Number(l.amount || 0), 0);
  const borrowed = taken.reduce((s,l) => s + Number(l.amount || 0), 0);
  return (
    <div className="space-y-5">
      <PageHeader title="Hand Loans" subtitle="Informal loans given (you lent) and taken (you borrowed)"
        right={<PrimaryButton onClick={() => setOpen(true)}>+ Add Hand Loan</PrimaryButton>} />
      <div className="grid grid-cols-2 gap-4">
        <div className="surface p-4">
          <div className="text-xs text-mocha uppercase tracking-wider">Money Lent</div>
          <div className="text-2xl font-bold text-leaf">{fmtINR(lent)}</div>
        </div>
        <div className="surface p-4">
          <div className="text-xs text-mocha uppercase tracking-wider">Money Borrowed</div>
          <div className="text-2xl font-bold text-rust">{fmtINR(borrowed)}</div>
        </div>
      </div>
      {loading && <div className="text-mocha">Loading…</div>}
      <Section title="Given (you lent)" rows={given} refetch={refetch} accent="leaf" />
      <Section title="Taken (you borrowed)" rows={taken} refetch={refetch} accent="rust" />
      <AddHandLoanModal open={open} onClose={() => setOpen(false)} onAdded={refetch} />
    </div>
  );
}

function Section({ title, rows, refetch, accent }: any) {
  if (!rows.length) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold text-espresso mb-2">{title}</h3>
      <div className="surface overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-foam text-mocha text-[11px] uppercase tracking-wider">
            <tr>
              <th className="px-3 py-2 text-left">Person</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-right">Rate</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-latte">
            {rows.map((l: any) => (
              <tr key={l.id}>
                <td className="px-3 py-2">{l.person_name}</td>
                <td className={`px-3 py-2 text-right font-semibold text-${accent}`}>{fmtINR(l.amount)}</td>
                <td className="px-3 py-2 text-mocha">{l.date}</td>
                <td className="px-3 py-2 text-right">{l.interest_rate || 0}%</td>
                <td className="px-3 py-2"><span className="text-xs px-1.5 py-0.5 rounded bg-caramel/10 text-caramel">{l.status}</span></td>
                <td className="px-3 py-2"><DangerButton onClick={async () => {
                  if (!confirm('Delete?')) return;
                  await api.del(`/api/loans/hand-loans/${l.id}`); refetch();
                }}>Del</DangerButton></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddHandLoanModal({ open, onClose, onAdded }: any) {
  const [person, setPerson] = useState(''); const [direction, setDirection] = useState('given');
  const [amount, setAmount] = useState(''); const [date, setDate] = useState(new Date().toISOString().slice(0,10));
  const [rate, setRate] = useState('0');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{success:boolean}>('/api/loans/hand-loans', {
        person_name: person, direction, amount: parseFloat(amount),
        date, interest_rate: parseFloat(rate) || 0, status: 'active'
      });
      if (r.success) { onAdded(); onClose(); }
    } catch (e: any) { alert(e?.error || 'Save failed'); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add Hand Loan"
      footer={<><button onClick={onClose} className="px-3 py-1.5 rounded border border-latte text-mocha text-sm">Cancel</button>
               <button onClick={submit} className="px-4 py-1.5 rounded bg-caramel text-cream text-sm font-semibold">Save</button></>}>
      <form onSubmit={submit}>
        <Field label="Person *"><input className={inputClass} value={person} onChange={e=>setPerson(e.target.value)} required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Direction"><select className={inputClass} value={direction} onChange={e=>setDirection(e.target.value)}>
            <option value="given">Given (you lent)</option><option value="taken">Taken (you borrowed)</option>
          </select></Field>
          <Field label="Amount (₹) *"><input className={inputClass} type="number" value={amount} onChange={e=>setAmount(e.target.value)} required /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date"><input className={inputClass} type="date" value={date} onChange={e=>setDate(e.target.value)} /></Field>
          <Field label="Interest %"><input className={inputClass} type="number" step="0.01" value={rate} onChange={e=>setRate(e.target.value)} /></Field>
        </div>
      </form>
    </Modal>
  );
}
