import NotFoundPage from './pages/NotFoundPage';
import Toaster from './components/Toaster';
import Logo from './components/brand/Logo';
import { PrivacyPage, TermsPage } from './pages/PolicyPage';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import { useAuth } from '@clerk/clerk-react';
import { SignIn, SignUp } from '@clerk/clerk-react';
import { isNative } from './lib/native';
import MoreScreen from './pages/phone/MoreScreen';
import OverviewScreen from './pages/phone/OverviewScreen';
import UtilitiesScreen from './pages/phone/UtilitiesScreen';
import FinancesScreen from './pages/phone/FinancesScreen';
import PaymentsScreen from './pages/phone/PaymentsScreen';
import { Responsive } from './ios';
import AppLayout from './components/layout/AppLayout';
import Section from './components/layout/Section';
import DashboardPage from './pages/DashboardPage';
import UtilityDetailPage from './pages/UtilityDetailPage';
import InsightsPage from './pages/InsightsPage';
import PaymentPrioritiesPage from './pages/PaymentPrioritiesPage';
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
import { TenantRoute } from './pages/TenantDetailPage';
import ReimbursementInvoicePage from './pages/ReimbursementInvoicePage';
import ProjectsPage from './pages/ProjectsPage';
import TaxesPage from './pages/TaxesPage';
import InsurancePage from './pages/InsurancePage';
import OperatingExpensesPage from './pages/OperatingExpensesPage';
import BillsPage from './pages/BillsPage';
import VaultPage from './pages/VaultPage';
import PersonalPage from './pages/PersonalPage';
import CreditCardPage from './pages/CreditCardPage';
import RepairsPage, { RepairDetailPage } from './pages/RepairsPage';
import PortalLayout from './pages/portal/PortalLayout';
import PortalJoinPage from './pages/portal/PortalJoinPage';
import PortalHomePage from './pages/portal/PortalHomePage';
import PortalRepairsPage, { PortalRepairPage } from './pages/portal/PortalRepairsPage';
import PortalPaymentsPage from './pages/portal/PortalPaymentsPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const { pathname } = useLocation();
  if (!isLoaded) return <div className="flex h-screen items-center justify-center text-gray-400">Loading...</div>;
  // Signed out, the front door is the landing page (the app opens on sign-in).
  if (!isSignedIn && pathname === '/' && !isNative) return <LandingPage />;
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
      set a password first on the website: Settings → Account → Sign-in &amp; security → Set a password.
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
        <Route path="/welcome" element={<LandingPage />} />
        <Route path="/sign-in/*" element={
          <div className="flex h-screen items-center justify-center bg-[#161616]">
            <div className="flex flex-col items-center gap-3">
              <div className="mb-2"><Logo size={40} tagline /></div>
              <SignIn routing="path" path="/sign-in" afterSignInUrl="/dashboard" appearance={nativeAuthAppearance} />
              {isNative && <NativeSignInNote />}
            </div>
          </div>
        } />
        <Route path="/sign-up/*" element={
          <div className="flex h-screen items-center justify-center bg-[#161616]">
            <div className="flex flex-col items-center gap-3">
              <div className="mb-2"><Logo size={40} tagline /></div>
              <SignUp routing="path" path="/sign-up" afterSignUpUrl="/dashboard" appearance={nativeAuthAppearance} />
              {isNative && <NativeSignInNote />}
            </div>
          </div>
        } />

        {/* A printable page: no sidebar, no scroll container, so what prints
            is the statement and nothing else. */}
        <Route path="/reimbursements/:id" element={<ProtectedRoute><ReimbursementInvoicePage /></ProtectedRoute>} />

        {/* The tenant portal: its own frame, none of the owner's pages.
            The invite link works signed out (it offers sign-up first). */}
        <Route path="/portal/join" element={<PortalJoinPage />} />
        <Route path="/portal" element={<ProtectedRoute><PortalLayout /></ProtectedRoute>}>
          <Route index element={<PortalHomePage />} />
          <Route path="repairs" element={<PortalRepairsPage />} />
          <Route path="repairs/:id" element={<PortalRepairPage />} />
          <Route path="payments" element={<PortalPaymentsPage />} />
        </Route>

        <Route path="/" element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Section group="overview"><Responsive phone={<OverviewScreen />} desktop={<DashboardPage />} /></Section>} />

          {/* Properties */}
          <Route path="properties" element={<Responsive phone={<UtilitiesScreen />} desktop={<Navigate to="/bills" replace />} />} />
          {/* One page per property: the old utilities page is its Bills tab. */}
          <Route path="properties/:id" element={<ToPropertyBills />} />
          <Route path="properties/:propertyId/utilities/:accountId" element={<UtilityDetailPage />} />

          {/* Finances hub */}
          <Route path="finances" element={<Section group="finances"><Responsive phone={<FinancesScreen />} desktop={<FinancesPage />} /></Section>} />
          <Route path="taxes" element={<Section group="properties"><TaxesPage /></Section>} />
          <Route path="insurance" element={<Section group="properties"><InsurancePage /></Section>} />
          <Route path="operating-expenses" element={<Section group="finances"><OperatingExpensesPage /></Section>} />
          <Route path="bills" element={<BillsPage />} />
          <Route path="personal" element={<Section group="personal"><PersonalPage /></Section>} />
          <Route path="vault" element={<Section group="personal"><VaultPage /></Section>} />
          <Route path="personal/cards/:id" element={<CreditCardPage />} />
          {/* Compliance is part of Legal (folded under it there). */}
          <Route path="compliance" element={<Navigate to="/legal" replace />} />
          <Route path="projects" element={<Section group="personal"><ProjectsPage /></Section>} />
          <Route path="projects/:id" element={<ProjectsPage />} />
          <Route path="loans/:id" element={<LoanDetailPage />} />

          {/* Portfolio hub */}
          <Route path="portfolio" element={<Section group="properties"><PortfolioPage /></Section>} />
          <Route path="portfolio/:id" element={<PropertyHubPage />} />

          {/* Tenants hub */}
          <Route path="tenants" element={<Section group="properties"><TenantsHubPage /></Section>} />
          <Route path="tenants/:id" element={<TenantRoute />} />
          <Route path="notices/:id" element={<NoticeDetailPage />} />
          <Route path="repairs" element={<Section group="properties"><RepairsPage /></Section>} />
          <Route path="repairs/:id" element={<RepairDetailPage />} />


          {/* Legal */}
          <Route path="legal" element={<Section group="properties"><LegalPage /></Section>} />

          {/* Standalone pages */}
          {/* On a computer, payments live on Bills (the pay planner and pay-first are off for now). */}
          <Route path="payments" element={<Responsive phone={<PaymentsScreen />} desktop={<Navigate to="/bills?view=payments" replace />} />} />
          <Route path="payments/priorities" element={<Responsive phone={<PaymentPrioritiesPage />} desktop={<Navigate to="/bills" replace />} />} />
          {/* ClickUp operations went unused and had no way in; the address goes home. */}
          <Route path="operations" element={<Navigate to="/dashboard" replace />} />
          <Route path="insights" element={<Section group="overview"><InsightsPage /></Section>} />
          <Route path="settings" element={<SettingsPage />} />
          {/* Phone: everything not in the tab bar. */}
          <Route path="more" element={<MoreScreen />} />

          {/* Import */}
          <Route path="import" element={<Section group="add"><ImportPage /></Section>} />
          <Route path="scan" element={<Section group="add"><ScanPage /></Section>} />

          {/* An address with no page says so (and is reported) instead of
              quietly landing on the dashboard. */}
          <Route path="*" element={<NotFoundPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      <Toaster />
    </BrowserRouter>
  );
}

function ToPropertyBills() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/portfolio/${id}?tab=Bills`} replace />;
}
