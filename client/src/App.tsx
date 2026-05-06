import { Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './layout/AppShell';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Placeholder } from './pages/Placeholder';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard"   element={<Dashboard />} />
        <Route path="/investments" element={<Placeholder name="Investments" description="Stocks, mutual funds, FDs, US stocks, savings, insurance, NPS, import." />} />
        <Route path="/liabilities" element={<Placeholder name="Liabilities" description="Credit cards and loans." />} />
        <Route path="/handloans"   element={<Placeholder name="Hand Loans" description="Informal loans given and taken." />} />
        <Route path="/earnings"    element={<Placeholder name="Earnings" description="Income sources and cross-profile shares." />} />
        <Route path="/payments"    element={<Placeholder name="Scheduled Payments" description="Recurring bills, EMIs, SIPs." />} />
        <Route path="/properties"  element={<Placeholder name="Properties" description="Flats, plots, rental income, Section 24 summary." />} />
        <Route path="/incometax"   element={<Placeholder name="Income Tax" description="Advance tax, estimated liability, deduction categories." />} />
        <Route path="/vault"       element={<Placeholder name="Vault" description="S3-backed document storage." />} />
        <Route path="/agent"       element={<Placeholder name="Agent" description="LLM-powered chat." />} />
        <Route path="/analytics"   element={<Placeholder name="Analytics" description="Charts and trends." />} />
        <Route path="*"            element={<Navigate to="/dashboard" replace />} />
      </Route>
    </Routes>
  );
}
