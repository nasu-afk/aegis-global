// ─── AEGIS GLOBAL — App Root & Router ────────────────────────────────────────
import React, { useEffect, Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuthStore, useUIStore, useWSStore } from './store';
import { useWebSocket } from './hooks';
import { authApi } from './utils/api';

// ─── Lazy-loaded pages ────────────────────────────────────────────────────────
const Dashboard      = lazy(() => import('./components/dashboard/Dashboard'));
const MapView        = lazy(() => import('./components/map/MapView'));
const AlertsPanel    = lazy(() => import('./components/alerts/AlertsPanel'));
const SOSPortal      = lazy(() => import('./components/sos/SOSPortal'));
const Analytics      = lazy(() => import('./components/analytics/Analytics'));
const AIIntelligence = lazy(() => import('./components/ai/AIIntelligence'));
const Historical     = lazy(() => import('./components/historical/Historical'));
const AdminPortal    = lazy(() => import('./components/admin/AdminPortal'));
const LoginPage      = lazy(() => import('./components/auth/LoginPage'));
const RegisterPage   = lazy(() => import('./components/auth/RegisterPage'));
const PublicView     = lazy(() => import('./components/public/PublicView'));

// ─── Query client ─────────────────────────────────────────────────────────────
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, staleTime: 30_000, refetchOnWindowFocus: false }
  }
});

// ─── Auth guard ───────────────────────────────────────────────────────────────
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  const location = useLocation();
  if (!isAuthenticated) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

// ─── WebSocket initialiser — always called, conditionally connects ─────────────
function WSInitialiser() {
  useWebSocket();
  return null;
}

// ─── Clock updater ────────────────────────────────────────────────────────────
function ClockUpdater() {
  useEffect(() => {
    const tick = () => {
      const el = document.getElementById('aegis-clock');
      if (el) el.textContent = new Date().toUTCString().split(' ')[4] + ' UTC';
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return null;
}

// ─── Auth initialiser ─────────────────────────────────────────────────────────
function AuthInitialiser() {
  const { setUser, setLoading, isAuthenticated } = useAuthStore();
  useEffect(() => {
    if (!isAuthenticated) return;
    setLoading(true);
    authApi.getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);
  return null;
}

// ─── Notification toasts ──────────────────────────────────────────────────────
function NotificationToasts() {
  const { notifications, removeNotification } = useUIStore();
  const colours: Record<string, string> = {
    success: 'border-green-500 bg-green-950 text-green-200',
    error:   'border-red-500   bg-red-950   text-red-200',
    warning: 'border-amber-500 bg-amber-950 text-amber-200',
    info:    'border-blue-500  bg-blue-950  text-blue-200',
  };
  const icons: Record<string, string> = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm">
      {notifications.map((n) => (
        <div key={n.id} className={`flex items-start gap-3 border rounded-lg p-3 shadow-lg text-sm animate-fade-in ${colours[n.type]}`}>
          <span className="text-base font-bold flex-shrink-0">{icons[n.type]}</span>
          <span className="flex-1 leading-snug">{n.message}</span>
          <button onClick={() => removeNotification(n.id)} className="opacity-60 hover:opacity-100">×</button>
        </div>
      ))}
    </div>
  );
}

// ─── App shell layout ─────────────────────────────────────────────────────────
function AppLayout({ children }: { children: React.ReactNode }) {
  const { sidebarOpen, activePanel, setActivePanel } = useUIStore();
  const { user, logout } = useAuthStore();
  const { connected } = useWSStore();

  const navItems = [
    { id: 'dashboard',   label: 'Dashboard',      icon: '⚡', adminOnly: false },
    { id: 'map',         label: 'Live Map',        icon: '🗺',  adminOnly: false },
    { id: 'alerts',      label: 'Alerts',          icon: '🔔',  adminOnly: false },
    { id: 'sos',         label: 'SOS Portal',      icon: '🆘',  adminOnly: false },
    { id: 'ai',          label: 'AI Intelligence', icon: '🤖',  adminOnly: false },
    { id: 'historical',  label: 'Historical',      icon: '📊',  adminOnly: false },
    { id: 'analytics',   label: 'Analytics',       icon: '📈',  adminOnly: false },
    { id: 'admin',       label: 'Admin Portal',    icon: '⚙️',  adminOnly: true  },
  ] as const;

  const adminRoles = ['global_admin', 'national_admin', 'regional_admin', 'emergency_coordinator'];
  const visibleItems = navItems.filter(item =>
    !item.adminOnly || (user && adminRoles.includes(user.role))
  );

  return (
    <div className="flex h-screen overflow-hidden bg-[#0a0e1a] text-slate-200">
      {/* Sidebar */}
      <aside className={`${sidebarOpen ? 'w-56' : 'w-14'} flex-shrink-0 bg-[#0f1523] border-r border-[#1e2d4a] flex flex-col transition-all duration-200 overflow-hidden`}>
        <div className="h-12 flex items-center gap-3 px-3 border-b border-[#1e2d4a] flex-shrink-0">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-sm flex-shrink-0">🌍</div>
          {sidebarOpen && <span className="font-bold text-sm tracking-wide">AEGIS</span>}
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {visibleItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActivePanel(item.id as any)}
              title={!sidebarOpen ? item.label : undefined}
              style={{ width: 'calc(100% - 8px)', margin: '0 4px' }}
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-all
                ${activePanel === item.id
                  ? 'bg-blue-500/15 text-blue-400'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}
            >
              <span className="text-base flex-shrink-0">{item.icon}</span>
              {sidebarOpen && <span>{item.label}</span>}
            </button>
          ))}
        </nav>
        {user && (
          <div className="border-t border-[#1e2d4a] p-2 flex-shrink-0">
            <div className={`flex items-center gap-2 ${sidebarOpen ? '' : 'justify-center'}`}>
              <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-xs font-bold flex-shrink-0">
                {user.name.charAt(0).toUpperCase()}
              </div>
              {sidebarOpen && (
                <>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{user.name}</div>
                    <div className="text-xs text-slate-500 truncate">{user.role.replace('_', ' ')}</div>
                  </div>
                  <button
                    onClick={() => { authApi.logout(); logout(); }}
                    className="text-slate-500 hover:text-red-400 text-xs"
                  >↩</button>
                </>
              )}
            </div>
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-hidden flex flex-col">
        <header className="h-12 bg-[#0f1523] border-b border-[#1e2d4a] flex items-center gap-3 px-4 flex-shrink-0">
          <button
            onClick={() => useUIStore.getState().setSidebarOpen(!sidebarOpen)}
            className="text-slate-400 hover:text-slate-200 text-lg"
          >☰</button>
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="text-blue-400">{visibleItems.find(n => n.id === activePanel)?.icon}</span>
            <span>{visibleItems.find(n => n.id === activePanel)?.label}</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
              {connected ? 'Live' : 'Connecting…'}
            </div>
            <div className="text-xs text-slate-500" id="aegis-clock">--:-- UTC</div>
          </div>
        </header>
        <div className="flex-1 overflow-hidden">
          <Suspense fallback={
            <div className="flex items-center justify-center h-full">
              <div className="text-slate-400 text-sm animate-pulse">Loading…</div>
            </div>
          }>
            {children}
          </Suspense>
        </div>
      </main>
    </div>
  );
}

// ─── Main page switcher ───────────────────────────────────────────────────────
function MainContent() {
  const { activePanel } = useUIStore();
  switch (activePanel) {
    case 'dashboard':  return <Dashboard />;
    case 'map':        return <MapView />;
    case 'alerts':     return <AlertsPanel />;
    case 'sos':        return <SOSPortal />;
    case 'ai':         return <AIIntelligence />;
    case 'historical': return <Historical />;
    case 'analytics':  return <Analytics />;
    case 'admin':      return <AdminPortal />;
    default:           return <Dashboard />;
  }
}

// ─── Protected shell — mounts WS only once, after auth ────────────────────────
function ProtectedShell() {
  return (
    <>
      <WSInitialiser />
      <AppLayout>
        <MainContent />
      </AppLayout>
    </>
  );
}

// ─── Root redirect — staff who are already signed in skip the public view ─────
function RootRedirect() {
  const { isAuthenticated } = useAuthStore();
  return <Navigate to={isAuthenticated ? '/dashboard' : '/public'} replace />;
}

// ─── Root App ─────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthInitialiser />
        <ClockUpdater />
        <NotificationToasts />
        <Routes>
          <Route path="/public"   element={<Suspense fallback={null}><PublicView /></Suspense>} />
          <Route path="/login"    element={<Suspense fallback={null}><LoginPage /></Suspense>} />
          <Route path="/register" element={<Suspense fallback={null}><RegisterPage /></Suspense>} />
          <Route path="/*" element={
            <RequireAuth>
              <ProtectedShell />
            </RequireAuth>
          } />
          <Route path="/" element={<RootRedirect />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
