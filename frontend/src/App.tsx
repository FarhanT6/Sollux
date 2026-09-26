import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { SignIn, SignUp } from '@clerk/clerk-react';
import AppLayout from './components/layout/AppLayout';
import DashboardPage from './pages/DashboardPage';
import PropertiesPage from './pages/PropertiesPage';
import PropertyDetailPage from './pages/PropertyDetailPage';
import UtilityDetailPage from './pages/UtilityDetailPage';
import InsightsPage from './pages/InsightsPage';
import OperationsPage from './pages/OperationsPage';
import PaymentPrioritiesPage from './pages/PaymentPrioritiesPage';
import PayPlanPage from './pages/PayPlanPage';
import SettingsPage from './pages/SettingsPage';
import FinancesPage from './pages/FinancesPage';
import TenantsHubPage from './pages/TenantsHubPage';
import PortfolioPage from './pages/PortfolioPage';
import PropertyHubPage from './pages/PropertyHubPage';
import LegalPage from './pages/LegalPage';
import ImportPage from './pages/ImportPage';
import ScanPage from './pages/ScanPage';
// Still used for deep-link detail pages
import LoanDetailPage from './pages/LoanDetailPage';
import NoticeDetailPage from './pages/NoticeDetailPage';
import TenantDetailPage from './pages/TenantDetailPage';
import ReimbursementInvoicePage from './pages/ReimbursementInvoicePage';
import CompliancePage from './pages/CompliancePage';
import ProjectsPage from './pages/ProjectsPage';
import TaxesPage from './pages/TaxesPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  if (!isLoaded) return <div className="flex h-screen items-center justify-center text-gray-400">Loading...</div>;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/sign-in/*" element={
          <div className="flex h-screen items-center justify-center bg-[#161616]">
            <SignIn routing="path" path="/sign-in" afterSignInUrl="/dashboard" />
          </div>
        } />
        <Route path="/sign-up/*" element={
          <div className="flex h-screen items-center justify-center bg-[#161616]">
            <SignUp routing="path" path="/sign-up" afterSignUpUrl="/dashboard" />
          </div>
        } />

        {/* A printable page: no sidebar, no scroll container, so what prints
            is the statement and nothing else. */}
        <Route path="/reimbursements/:id" element={<ProtectedRoute><ReimbursementInvoicePage /></ProtectedRoute>} />

        <Route path="/" element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />

          {/* Properties */}
          <Route path="properties" element={<PropertiesPage />} />
          <Route path="properties/:id" element={<PropertyDetailPage />} />
          <Route path="properties/:propertyId/utilities/:accountId" element={<UtilityDetailPage />} />

          {/* Finances hub */}
          <Route path="finances" element={<FinancesPage />} />
          <Route path="taxes" element={<TaxesPage />} />
          <Route path="compliance" element={<CompliancePage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:id" element={<ProjectsPage />} />
          <Route path="loans/:id" element={<LoanDetailPage />} />

          {/* Portfolio hub */}
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="portfolio/:id" element={<PropertyHubPage />} />

          {/* Tenants hub */}
          <Route path="tenants" element={<TenantsHubPage />} />
          <Route path="tenants/:id" element={<TenantDetailPage />} />
          <Route path="notices/:id" element={<NoticeDetailPage />} />


          {/* Legal */}
          <Route path="legal" element={<LegalPage />} />

          {/* Standalone pages */}
          <Route path="payments" element={<PayPlanPage />} />
          <Route path="payments/priorities" element={<PaymentPrioritiesPage />} />
          <Route path="operations" element={<OperationsPage />} />
          <Route path="insights" element={<InsightsPage />} />
          <Route path="settings" element={<SettingsPage />} />

          {/* Import */}
          <Route path="import" element={<ImportPage />} />
        <Route path="scan" element={<ScanPage />} />

          {/* Anything else lands on the dashboard. */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
