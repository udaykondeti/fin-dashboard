import { ReactNode, useEffect } from 'react';

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
};

export function Modal({ open, title, onClose, children, footer, width = '560px' }: Props) {
  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: 'rgba(44,26,14,.55)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      <div
        className="bg-cream border border-latte rounded-2xl shadow-xl w-full overflow-hidden flex flex-col"
        style={{ maxWidth: width, maxHeight: 'calc(100vh - 80px)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-latte bg-foam">
          <h3 className="text-base font-bold text-mocha">{title}</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-md hover:bg-latte text-mocha text-lg" aria-label="Close">✕</button>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-latte flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

type FieldProps = { label: string; children: ReactNode; hint?: string };
export function Field({ label, children, hint }: FieldProps) {
  return (
    <div className="mb-3">
      <label className="block text-[11px] font-bold uppercase tracking-wider text-mocha mb-1.5">{label}</label>
      {children}
      {hint && <div className="text-[11px] text-mocha mt-1">{hint}</div>}
    </div>
  );
}

export const inputClass =
  'w-full px-3 py-2 rounded-md border border-latte bg-cream text-espresso text-sm ' +
  'focus:outline-none focus:border-caramel focus:ring-2 focus:ring-caramel/20 transition';
