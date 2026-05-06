type Props = { name: string; description?: string };

export function Placeholder({ name, description }: Props) {
  return (
    <div className="space-y-3">
      <header>
        <h1 className="text-2xl font-bold text-espresso">{name}</h1>
        {description && <p className="text-sm text-mocha">{description}</p>}
      </header>
      <div className="surface p-6 border-dashed">
        <div className="text-sm text-mocha">
          This page hasn’t been migrated to v2 yet. The functional version still lives at the
          {' '}<a href="/" className="underline text-caramel">v1 dashboard</a>{' '}
          and will be moved over in a follow-up PR.
        </div>
      </div>
    </div>
  );
}
