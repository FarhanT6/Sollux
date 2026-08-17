import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { SignIn, SignUp } from '@clerk/clerk-react';
import AppLayout from './components/layout/AppLayout';
import DashboardPage from './pages/DashboardPage';
import PropertiesPage from './pages/PropertiesPage';
import PropertyDetailPage from './pages/PropertyDetailPage';
import UtilityDetailPage from './pages/UtilityDetailPage';
import InsightsPage from './pages/InsightsPage';
import SettingsPage from './pages/SettingsPage';
import FinancesPage from './pages/FinancesPage';
import TenantsHubPage from './pages/TenantsHubPage';
import PortfolioPage from './pages/PortfolioPage';
import PropertyHubPage from './pages/PropertyHubPage';
import IncomingPaymentsPage from './pages/IncomingPaymentsPage';
import ImportPage from './pages/ImportPage';
import ScanPage from './pages/ScanPage';
// Still used for deep-link detail pages
import LoanDetailPage from './pages/LoanDetailPage';
import NoticeDetailPage from './pages/NoticeDetailPage';
import TenantDetailPage from './pages/TenantDetailPage';

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

        <Route path="/" element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />

          {/* Properties */}
          <Route path="properties" element={<PropertiesPage />} />
          <Route path="properties/:id" element={<PropertyDetailPage />} />
          <Route path="properties/:propertyId/utilities/:accountId" element={<UtilityDetailPage />} />

          {/* Finances hub */}
          <Route path="finances" element={<FinancesPage />} />
          <Route path="loans/:id" element={<LoanDetailPage />} />

          {/* Portfolio hub */}
          <Route path="portfolio" element={<PortfolioPage />} />
          <Route path="portfolio/:id" element={<PropertyHubPage />} />

          {/* Tenants hub */}
          <Route path="tenants" element={<TenantsHubPage />} />
          <Route path="tenants/:id" element={<TenantDetailPage />} />
          <Route path="notices/:id" element={<NoticeDetailPage />} />

          {/* Incoming bank payments awaiting review */}
          <Route path="incoming-payments" element={<IncomingPaymentsPage />} />

          {/* Standalone pages */}
          <Route path="insights" element={<InsightsPage />} />
          <Route path="settings" element={<SettingsPage />} />

          {/* Import */}
          <Route path="import" element={<ImportPage />} />
        <Route path="scan" element={<ScanPage />} />

          {/* Legacy redirects — preserve old bookmarks and back-nav */}
          <Route path="rent-roll"     element={<Navigate to="/tenants" replace />} />
          <Route path="notices"       element={<Navigate to="/tenants?tab=notices" replace />} />
          <Route path="pnl"           element={<Navigate to="/finances?tab=pnl" replace />} />
          <Route path="budget"        element={<Navigate to="/finances?tab=budget" replace />} />
          <Route path="loans"         element={<Navigate to="/finances?tab=loans" replace />} />
          <Route path="expenses"      element={<Navigate to="/finances?tab=expenses" replace />} />
          <Route path="payments"      element={<Navigate to="/properties" replace />} />
          <Route path="documents"     element={<Navigate to="/scan?tab=library" replace />} />
          <Route path="notifications" element={<Navigate to="/settings?tab=notifications" replace />} />

          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
