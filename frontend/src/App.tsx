import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '@clerk/clerk-react';
import { SignIn, SignUp } from '@clerk/clerk-react';
import AppLayout from './components/layout/AppLayout';
import DashboardPage from './pages/DashboardPage';
import PropertiesPage from './pages/PropertiesPage';
import PropertyDetailPage from './pages/PropertyDetailPage';
import UtilityDetailPage from './pages/UtilityDetailPage';
import InsightsPage from './pages/InsightsPage';
import PaymentsPage from './pages/PaymentsPage';
import DocumentsPage from './pages/DocumentsPage';
import ImportPage from './pages/ImportPage';
import NotificationsPage from './pages/NotificationsPage';
import SettingsPage from './pages/SettingsPage';
// Property management
import RentRollPage from './pages/RentRollPage';
import TenantsPage from './pages/TenantsPage';
import ExpensesPage from './pages/ExpensesPage';
import LoansPage from './pages/LoansPage';
import LoanDetailPage from './pages/LoanDetailPage';
import PnLPage from './pages/PnLPage';
import NoticesPage from './pages/NoticesPage';
import NoticeDetailPage from './pages/NoticeDetailPage';

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
          <Route path="properties" element={<PropertiesPage />} />
          <Route path="properties/:id" element={<PropertyDetailPage />} />
          <Route path="properties/:propertyId/utilities/:accountId" element={<UtilityDetailPage />} />
          <Route path="insights" element={<InsightsPage />} />
          <Route path="payments" element={<PaymentsPage />} />
          <Route path="documents" element={<DocumentsPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          {/* Property Mgmt */}
          <Route path="rent-roll" element={<RentRollPage />} />
          <Route path="tenants" element={<TenantsPage />} />
          <Route path="expenses" element={<ExpensesPage />} />
          <Route path="loans" element={<LoansPage />} />
          <Route path="loans/:id" element={<LoanDetailPage />} />
          <Route path="pnl" element={<PnLPage />} />
          <Route path="notices" element={<NoticesPage />} />
          <Route path="notices/:id" element={<NoticeDetailPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
