import { ReactNode } from 'react';

type Props = { title: string; subtitle?: string; right?: ReactNode };
export function PageHeader({ title, subtitle, right }: Props) {
  return (
    <header className="flex items-end justify-between mb-5 gap-4 flex-wrap">
      <div>
        <h1 className="text-2xl font-bold text-espresso">{title}</h1>
        {subtitle && <p className="text-sm text-mocha">{subtitle}</p>}
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </header>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={'surface p-4 ' + className}>{children}</div>;
}

export function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = '', ...rest } = props;
  return (
    <button
      {...rest}
      className={
        'px-4 py-2 rounded-md bg-caramel text-cream text-sm font-semibold hover:bg-caramel/90 disabled:opacity-50 ' +
        className
      }
    />
  );
}

export function SecondaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = '', ...rest } = props;
  return (
    <button
      {...rest}
      className={
        'px-3 py-1.5 rounded-md border border-latte text-mocha text-sm hover:bg-latte/40 ' +
        className
      }
    />
  );
}

export function DangerButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = '', ...rest } = props;
  return (
    <button
      {...rest}
      className={
        'px-2.5 py-1 rounded text-xs border border-rust/40 text-rust hover:bg-rust/10 ' +
        className
      }
    />
  );
}
