import { useState, FormEvent } from 'react';
import { useFetch } from '../lib/useFetch';
import { api } from '../api/client';
import { fmtINR } from '../lib/format';
import { PageHeader, PrimaryButton, DangerButton } from '../components/PageHeader';
import { Modal, Field, inputClass } from '../components/Modal';

export function Properties() {
  const { data, loading, refetch } = useFetch<{ properties: any[] }>('/api/properties');
  const [open, setOpen] = useState(false);
  const props = data?.properties || [];
  return (
    <div className="space-y-5">
      <PageHeader title="Properties" subtitle="Flats, plots, land — value, ownership, rental"
        right={<PrimaryButton onClick={() => setOpen(true)}>+ Add Property</PrimaryButton>} />
      <p className="text-xs text-mocha">For rental agreements, property tax, and Sec 24 summary, switch to <a href="/" className="underline text-caramel">v1</a> — those tabs aren't migrated yet.</p>
      {loading && <div className="text-mocha">Loading…</div>}
      {!loading && props.length === 0 && <div className="surface p-6 text-center text-mocha">No properties yet.</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {props.map(p => (
          <div key={p.id} className="surface p-4">
            <div className="flex justify-between items-start mb-2">
              <div>
                <div className="font-semibold text-espresso">{p.name}</div>
                <div className="text-xs text-mocha">{p.property_type} · {p.city || '—'}{p.state ? ', ' + p.state : ''}</div>
              </div>
              <DangerButton onClick={async () => {
                if (!confirm('Delete?')) return;
                await api.del(`/api/properties/${p.id}`); refetch();
              }}>Del</DangerButton>
            </div>
            <div className="text-xl font-bold text-caramel">{fmtINR(p.current_value || p.purchase_price)}</div>
            <div className="text-xs text-mocha mt-1">
              Ownership: {p.ownership_percentage || 100}%
              {p.active_rent ? ` · Rent: ${fmtINR(p.active_rent)}/mo` : ' · Not rented'}
              {p.area ? ` · ${p.area} ${p.area_unit || 'sqft'}` : ''}
            </div>
          </div>
        ))}
      </div>
      <AddPropertyModal open={open} onClose={() => setOpen(false)} onAdded={refetch} />
    </div>
  );
}

function AddPropertyModal({ open, onClose, onAdded }: any) {
  const [name, setName] = useState(''); const [type, setType] = useState('Flat');
  const [city, setCity] = useState(''); const [state, setState] = useState('');
  const [purchase, setPurchase] = useState(''); const [current, setCurrent] = useState('');
  const [ownership, setOwnership] = useState('100');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{id:number}>('/api/properties', {
        name, property_type: type, city, state,
        purchase_price: parseFloat(purchase) || 0,
        current_value: parseFloat(current) || 0,
        ownership_percentage: parseFloat(ownership) || 100
      });
      if (r.id) { onAdded(); onClose(); }
    } catch (e: any) { alert(e?.error || 'Save failed'); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add Property"
      footer={<><button onClick={onClose} className="px-3 py-1.5 rounded border border-latte text-mocha text-sm">Cancel</button>
               <button onClick={submit} className="px-4 py-1.5 rounded bg-caramel text-cream text-sm font-semibold">Save</button></>}>
      <form onSubmit={submit}>
        <Field label="Name *"><input className={inputClass} value={name} onChange={e=>setName(e.target.value)} required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type"><select className={inputClass} value={type} onChange={e=>setType(e.target.value)}>
            <option>Flat</option><option>Plot</option><option>Land</option><option>Commercial</option><option>Villa</option>
          </select></Field>
          <Field label="Ownership %"><input className={inputClass} type="number" min="1" max="100" value={ownership} onChange={e=>setOwnership(e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="City"><input className={inputClass} value={city} onChange={e=>setCity(e.target.value)} /></Field>
          <Field label="State"><input className={inputClass} value={state} onChange={e=>setState(e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Purchase Price (₹)"><input className={inputClass} type="number" value={purchase} onChange={e=>setPurchase(e.target.value)} /></Field>
          <Field label="Current Value (₹)"><input className={inputClass} type="number" value={current} onChange={e=>setCurrent(e.target.value)} /></Field>
        </div>
      </form>
    </Modal>
  );
}
