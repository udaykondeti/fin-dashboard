import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './layout/AppShell';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Investments } from './pages/Investments';
import { Liabilities } from './pages/Liabilities';
import { HandLoans } from './pages/HandLoans';
import { Earnings } from './pages/Earnings';
import { Payments } from './pages/Payments';
import { Properties } from './pages/Properties';
import { IncomeTax } from './pages/IncomeTax';
import { Placeholder } from './pages/Placeholder';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard"   element={<Dashboard />} />
        <Route path="/investments" element={<Investments />} />
        <Route path="/liabilities" element={<Liabilities />} />
        <Route path="/handloans"   element={<HandLoans />} />
        <Route path="/earnings"    element={<Earnings />} />
        <Route path="/payments"    element={<Payments />} />
        <Route path="/properties"  element={<Properties />} />
        <Route path="/incometax"   element={<IncomeTax />} />
        {/* Vault, Agent chat, Analytics deferred — link back to v1 */}
        <Route path="/vault"      element={<Placeholder name="Vault" description="S3-backed document storage. Available in the v1 dashboard." />} />
        <Route path="/agent"      element={<Placeholder name="Agent" description="LLM-powered chat. Available in the v1 dashboard." />} />
        <Route path="/analytics"  element={<Placeholder name="Analytics" description="Charts and trends. Available in the v1 dashboard." />} />
        <Route path="*"           element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
