import { useState } from 'react';
import { useFetch } from '../lib/useFetch';
import { api } from '../api/client';
import { fmtINR, fmtDate } from '../lib/format';
import { PageHeader, PrimaryButton, DangerButton } from '../components/PageHeader';
import { Modal, Field, inputClass } from '../components/Modal';

// New Tax Regime FY2026-27 slabs.
function calcSlabTax(annual: number) {
  if (annual <= 700000) return 0;
  const slabs = [[300000,0],[300000,0.05],[300000,0.10],[300000,0.15],[300000,0.20],[Infinity,0.30]];
  let tax = 0, rem = annual;
  for (const [size, rate] of slabs) {
    const t = Math.min(rem, size as number);
    tax += t * (rate as number);
    rem -= t;
    if (rem <= 0) break;
  }
  return tax * 1.04; // cess
}

export function IncomeTax() {
  const [year, setYear] = useState('2026-27');
  const { data, refetch } = useFetch<{ advance_tax: any[] }>(`/api/tax/advance?year=${year}`, [year]);
  const { data: earningsData } = useFetch<{ earnings: any[] }>('/api/earnings');
  const [open, setOpen] = useState(false);
  const advTax = data?.advance_tax || [];
  const totalPaid = advTax.reduce((s, t) => s + Number(t.amount || 0), 0);
  const annualGross = (earningsData?.earnings || []).reduce((s, e) => s + (Number(e.gross_monthly) || 0) * 12 * ((Number(e.share_percentage)||100)/100), 0);
  const estLiability = calcSlabTax(annualGross);
  const balance = Math.max(0, estLiability - totalPaid);

  return (
    <div className="space-y-5">
      <PageHeader title="Income Tax" subtitle="Advance tax payments, estimated liability"
        right={<PrimaryButton onClick={() => setOpen(true)}>+ Add Tax Payment</PrimaryButton>} />
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="surface p-4"><div className="text-[11px] uppercase text-mocha">Total Paid (FY)</div><div className="text-xl font-bold text-leaf">{fmtINR(totalPaid)}</div></div>
        <div className="surface p-4"><div className="text-[11px] uppercase text-mocha">Est. Liability</div><div className="text-xl font-bold text-caramel">{fmtINR(estLiability)}</div></div>
        <div className="surface p-4"><div className="text-[11px] uppercase text-mocha">Balance to Pay</div><div className="text-xl font-bold text-rust">{fmtINR(balance)}</div></div>
        <div className="surface p-4"><div className="text-[11px] uppercase text-mocha">Annual Gross</div><div className="text-xl font-bold">{fmtINR(annualGross)}</div></div>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-sm text-mocha">Assessment Year:</label>
        <select className={inputClass + ' w-auto'} value={year} onChange={e => setYear(e.target.value)}>
          <option>2026-27</option><option>2025-26</option><option>2024-25</option>
        </select>
      </div>
      {advTax.length === 0 && <div className="surface p-6 text-center text-mocha">No payments recorded for AY {year}.</div>}
      {advTax.length > 0 && (
        <div className="surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-foam text-mocha text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left">Installment</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-latte">
              {advTax.map(t => (
                <tr key={t.id}>
                  <td className="px-3 py-2 font-medium">{t.installment}</td>
                  <td className="px-3 py-2 text-right text-leaf font-semibold">{fmtINR(t.amount)}</td>
                  <td className="px-3 py-2 text-mocha">{fmtDate(t.date_paid)}</td>
                  <td className="px-3 py-2 text-mocha text-xs">{t.notes || '—'}</td>
                  <td className="px-3 py-2"><DangerButton onClick={async () => {
                    if (!confirm('Delete?')) return;
                    await api.del(`/api/tax/advance/${t.id}`); refetch();
                  }}>Del</DangerButton></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="surface p-4 text-xs text-mocha space-y-1">
        <div className="font-semibold text-espresso text-sm mb-2">Advance Tax Due Dates (FY 2026-27)</div>
        <div>15 Jun — 15% · 15 Sep — 45% cumulative · 15 Dec — 75% cumulative · 15 Mar — 100%</div>
        <div className="text-[11px]">Interest u/s 234B & 234C applies if payments are missed.</div>
      </div>
      <AddAdvTaxModal open={open} onClose={() => setOpen(false)} onAdded={refetch} year={year} />
    </div>
  );
}

function AddAdvTaxModal({ open, onClose, onAdded, year }: any) {
  const [installment, setInstallment] = useState('Q1');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  async function submit(e: any) {
    e.preventDefault();
    try {
      const r = await api.post<{id:number}>('/api/tax/advance', {
        assessment_year: year, installment,
        amount: parseFloat(amount), date_paid: date, notes
      });
      if (r.id) { onAdded(); onClose(); }
    } catch (e: any) { alert(e?.error || 'Save failed'); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add Advance Tax Payment"
      footer={<><button onClick={onClose} className="px-3 py-1.5 rounded border border-latte text-mocha text-sm">Cancel</button>
               <button onClick={submit} className="px-4 py-1.5 rounded bg-caramel text-cream text-sm font-semibold">Save</button></>}>
      <form onSubmit={submit}>
        <Field label="Installment"><select className={inputClass} value={installment} onChange={e=>setInstallment(e.target.value)}>
          <option>Q1</option><option>Q2</option><option>Q3</option><option>Q4</option><option>Self-Assessment</option>
        </select></Field>
        <Field label="Amount (₹) *"><input className={inputClass} type="number" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} required /></Field>
        <Field label="Date Paid"><input className={inputClass} type="date" value={date} onChange={e=>setDate(e.target.value)} /></Field>
        <Field label="Notes"><input className={inputClass} value={notes} onChange={e=>setNotes(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
