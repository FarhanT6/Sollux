import { PrivacyPage, TermsPage } from './pages/PolicyPage';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { SignIn, SignUp } from '@clerk/clerk-react';
import { isNative } from './lib/native';
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
import VaultPage from './pages/VaultPage';
import PersonalPage from './pages/PersonalPage';
import CreditCardPage from './pages/CreditCardPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  if (!isLoaded) return <div className="flex h-screen items-center justify-center text-gray-400">Loading...</div>;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  return <>{children}</>;
}

// Inside the iOS app the page's address is capacitor://localhost. Clerk's
// "Continue with Google" (and any sign-in that comes back through a link)
// must send the browser back to an https address, and refuses this one
// ("Invalid URL scheme ... redirect_url"); Google also blocks its sign-in
// inside embedded web views. So the app offers email and password (or a
// code) only.
const nativeAuthAppearance = isNative
  ? { elements: { socialButtonsRoot: { display: 'none' }, dividerRow: { display: 'none' } } }
  : undefined;

function NativeSignInNote() {
  return (
    <p className="max-w-xs text-center text-xs text-gray-500">
      In the app, sign in with your email and password. If your account was made with Google,
      set a password first on the website: profile picture → Manage account → Security.
    </p>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public: Google's OAuth consent screen links to these. */}
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/sign-in/*" element={
          <div className="flex h-screen items-center justify-center bg-[#161616]">
            <div className="flex flex-col items-center gap-3">
              <SignIn routing="path" path="/sign-in" afterSignInUrl="/dashboard" appearance={nativeAuthAppearance} />
              {isNative && <NativeSignInNote />}
            </div>
          </div>
        } />
        <Route path="/sign-up/*" element={
          <div className="flex h-screen items-center justify-center bg-[#161616]">
            <div className="flex flex-col items-center gap-3">
              <SignUp routing="path" path="/sign-up" afterSignUpUrl="/dashboard" appearance={nativeAuthAppearance} />
              {isNative && <NativeSignInNote />}
            </div>
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
          <Route path="personal" element={<PersonalPage />} />
          <Route path="vault" element={<VaultPage />} />
          <Route path="personal/cards/:id" element={<CreditCardPage />} />
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
