/**
 * Enrutador principal y proveedores globales de SB-Finance (`App.tsx`).
 *
 * Arquitectura y decisiones técnicas:
 * - Compone `AuthProvider` y `MonthlyPeriodProvider` por encima del router para
 *   mantener sincronizados la sesión, las configuraciones y el período seleccionado
 *   sin recargas al cambiar entre rutas.
 * - Carga diferida (`React.lazy` + `Suspense`) para las páginas principales, evitando
 *   descargar Recharts y módulos secundarios hasta que la ruta los necesite.
 * - Estiliza `<Toaster />` (`react-hot-toast`) con nuestra paleta negro/amarillo de
 *   alto contraste y colores semánticos exclusivamente para éxito/error.
 */
import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AppShell } from './components/layout/AppShell';
import { LoginPage } from './features/auth/LoginPage';
import { ProtectedRoute } from './features/auth/ProtectedRoute';
import { AuthProvider } from './hooks/useAuth';
import { MonthlyPeriodProvider } from './hooks/useMonthlyPeriod';

const DashboardPage = lazy(() =>
  import('./features/dashboard/DashboardPage').then((m) => ({
    default: m.DashboardPage,
  })),
);
const TransactionsPage = lazy(() =>
  import('./features/transactions/TransactionsPage').then((m) => ({
    default: m.TransactionsPage,
  })),
);
const CommitmentsPage = lazy(() =>
  import('./features/commitments/CommitmentsPage').then((m) => ({
    default: m.CommitmentsPage,
  })),
);
const SavingsPage = lazy(() =>
  import('./features/savings/SavingsPage').then((m) => ({
    default: m.SavingsPage,
  })),
);
const CategoriesPage = lazy(() =>
  import('./features/categories/CategoriesPage').then((m) => ({
    default: m.CategoriesPage,
  })),
);
const SettingsPage = lazy(() =>
  import('./features/settings/SettingsPage').then((m) => ({
    default: m.SettingsPage,
  })),
);
const FixedTermsPage = lazy(() =>
  import('./features/fixed-terms/FixedTermsPage').then((m) => ({
    default: m.FixedTermsPage,
  })),
);
const PriorityMatrixPage = lazy(() =>
  import('./features/priority-matrix/PriorityMatrixPage').then((m) => ({
    default: m.PriorityMatrixPage,
  })),
);
const SimulatorPage = lazy(() =>
  import('./features/simulator/SimulatorPage').then((m) => ({
    default: m.SimulatorPage,
  })),
);
const BudgetAssistantPage = lazy(() =>
  import('./features/budget-assistant/BudgetAssistantPage').then((m) => ({
    default: m.BudgetAssistantPage,
  })),
);

function RouteLoadingFallback() {
  return (
    <div
      role="status"
      aria-label="Cargando sección"
      className="flex flex-col gap-4 py-4"
    >
      <div className="h-10 w-64 rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
      <div className="h-44 w-full rounded-[8px] bg-[#121212] border border-[#262626] animate-pulse" />
      <span className="sr-only">Cargando...</span>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <MonthlyPeriodProvider>
        <BrowserRouter>
          <Suspense fallback={<RouteLoadingFallback />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />

              <Route element={<ProtectedRoute />}>
                <Route element={<AppShell />}>
                  <Route path="/" element={<DashboardPage />} />
                  <Route path="/transactions" element={<TransactionsPage />} />
                  <Route path="/commitments" element={<CommitmentsPage />} />
                  <Route path="/savings" element={<SavingsPage />} />
                  <Route path="/fixed-terms" element={<FixedTermsPage />} />
                  <Route path="/priority-matrix" element={<PriorityMatrixPage />} />
                  <Route path="/simulator" element={<SimulatorPage />} />
                  <Route path="/budget-assistant" element={<BudgetAssistantPage />} />
                  <Route path="/categories" element={<CategoriesPage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                </Route>
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>

        <Toaster
          position="bottom-right"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#121212',
              color: '#FAFAFA',
              border: '1px solid #262626',
              borderRadius: '6px',
              fontSize: '14px',
            },
            success: {
              iconTheme: {
                primary: '#22C55E',
                secondary: '#0A0A0A',
              },
            },
            error: {
              iconTheme: {
                primary: '#EF4444',
                secondary: '#0A0A0A',
              },
            },
          }}
        />
      </MonthlyPeriodProvider>
    </AuthProvider>
  );
}

export default App;
