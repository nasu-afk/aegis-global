// ─── AEGIS GLOBAL — Global State Store (Zustand) ─────────────────────────────
import { create } from 'zustand';
import { persist, devtools } from 'zustand/middleware';
import type { Disaster, Alert, SOSReport, User, Prediction, SocialSignal } from '../types';

// ─── Auth slice ───────────────────────────────────────────────────────────────
interface AuthState {
  user:          User | null;
  isAuthenticated: boolean;
  isLoading:     boolean;
  setUser:       (user: User | null) => void;
  setLoading:    (v: boolean) => void;
  logout:        () => void;
}

export const useAuthStore = create<AuthState>()(
  devtools(
    persist(
      (set) => ({
        user:            null,
        isAuthenticated: false,
        isLoading:       false,

        setUser: (user) => set({ user, isAuthenticated: !!user }),
        setLoading: (isLoading) => set({ isLoading }),
        logout: () => set({ user: null, isAuthenticated: false })
      }),
      { name: 'aegis-auth', partialize: (s) => ({ user: s.user, isAuthenticated: s.isAuthenticated }) }
    )
  )
);

// ─── Disaster slice ───────────────────────────────────────────────────────────
interface DisasterState {
  disasters:       Disaster[];
  selectedId:      string | null;
  filterType:      string | null;
  filterSeverity:  string | null;
  filterStatus:    string;
  isLoading:       boolean;
  lastFetched:     number | null;

  setDisasters:      (disasters: Disaster[]) => void;
  addDisaster:       (disaster: Disaster) => void;
  updateDisaster:    (id: string, patch: Partial<Disaster>) => void;
  selectDisaster:    (id: string | null) => void;
  setFilter:         (key: 'type' | 'severity' | 'status', value: string | null) => void;
  setLoading:        (v: boolean) => void;
  getSelected:       () => Disaster | undefined;
  getActive:         () => Disaster[];
  getBySeverity:     (sev: string) => Disaster[];
}

export const useDisasterStore = create<DisasterState>()(
  devtools((set, get) => ({
    disasters:      [],
    selectedId:     null,
    filterType:     null,
    filterSeverity: null,
    filterStatus:   'active',
    isLoading:      false,
    lastFetched:    null,

    setDisasters:   (disasters) => set({ disasters, lastFetched: Date.now() }),
    addDisaster:    (disaster)  => set((s) => ({ disasters: [disaster, ...s.disasters] })),
    updateDisaster: (id, patch) => set((s) => ({
      disasters: s.disasters.map((d) => (d.id === id ? { ...d, ...patch } : d))
    })),
    selectDisaster: (selectedId) => set({ selectedId }),
    setFilter:      (key, value) => set({ [`filter${key.charAt(0).toUpperCase() + key.slice(1)}`]: value } as any),
    setLoading:     (isLoading)  => set({ isLoading }),

    getSelected:  () => get().disasters.find((d) => d.id === get().selectedId),
    getActive:    () => get().disasters.filter((d) => d.status === 'active'),
    getBySeverity:(sev) => get().disasters.filter((d) => d.severity === sev),
  }))
);

// ─── Alert slice ──────────────────────────────────────────────────────────────
interface AlertState {
  alerts:       Alert[];
  unreadCount:  number;
  isLoading:    boolean;

  setAlerts:    (alerts: Alert[]) => void;
  addAlert:     (alert: Alert) => void;
  markAllRead:  () => void;
}

export const useAlertStore = create<AlertState>()(
  devtools((set) => ({
    alerts:      [],
    unreadCount: 0,
    isLoading:   false,

    setAlerts:   (alerts)   => set({ alerts, unreadCount: alerts.filter((a) => a.severity === 'critical').length }),
    addAlert:    (alert)    => set((s) => ({ alerts: [alert, ...s.alerts], unreadCount: s.unreadCount + 1 })),
    markAllRead: ()         => set({ unreadCount: 0 })
  }))
);

// ─── SOS slice ────────────────────────────────────────────────────────────────
interface SOSState {
  reports:      SOSReport[];
  activeCount:  number;
  criticalPending: number;
  isLoading:    boolean;

  setReports:   (reports: SOSReport[]) => void;
  addReport:    (report: SOSReport) => void;
  updateReport: (id: string, patch: Partial<SOSReport>) => void;
}

export const useSOSStore = create<SOSState>()(
  devtools((set, get) => ({
    reports:         [],
    activeCount:     0,
    criticalPending: 0,
    isLoading:       false,

    setReports:  (reports) => set({
      reports,
      activeCount:     reports.filter((r) => !['resolved','false_alarm'].includes(r.status)).length,
      criticalPending: reports.filter((r) => r.aiSeverity === 'critical' && r.status === 'pending').length
    }),
    addReport:   (report)  => set((s) => ({
      reports:         [report, ...s.reports],
      activeCount:     s.activeCount + 1,
      criticalPending: s.criticalPending + (report.aiSeverity === 'critical' ? 1 : 0)
    })),
    updateReport: (id, patch) => set((s) => ({
      reports: s.reports.map((r) => (r.id === id ? { ...r, ...patch } : r))
    }))
  }))
);

// ─── Prediction slice ─────────────────────────────────────────────────────────
interface PredictionState {
  predictions:  Prediction[];
  isLoading:    boolean;
  setPredictions: (predictions: Prediction[]) => void;
  getByType:    (type: string) => Prediction[];
  getHighRisk:  () => Prediction[];
}

export const usePredictionStore = create<PredictionState>()(
  devtools((set, get) => ({
    predictions: [],
    isLoading:   false,
    setPredictions: (predictions) => set({ predictions }),
    getByType:    (type)          => get().predictions.filter((p) => p.disasterType === type),
    getHighRisk:  ()              => get().predictions.filter((p) => p.confidence >= 0.7),
  }))
);

// ─── Social signal slice ──────────────────────────────────────────────────────
interface SocialState {
  signals:      SocialSignal[];
  isLoading:    boolean;
  totalCount:   number;
  setSignals:   (signals: SocialSignal[]) => void;
  addSignal:    (signal: SocialSignal) => void;
}

export const useSocialStore = create<SocialState>()(
  devtools((set) => ({
    signals:    [],
    isLoading:  false,
    totalCount: 0,
    setSignals: (signals)  => set({ signals, totalCount: signals.length }),
    addSignal:  (signal)   => set((s) => ({ signals: [signal, ...s.signals.slice(0, 99)], totalCount: s.totalCount + 1 }))
  }))
);

// ─── UI slice ─────────────────────────────────────────────────────────────────
interface UIState {
  sidebarOpen:    boolean;
  activePanel:    'dashboard' | 'map' | 'alerts' | 'sos' | 'ai' | 'historical' | 'analytics' | 'admin';
  mapLayer:       'all' | 'flood' | 'fire' | 'evac' | 'sos' | 'population' | 'predictions';
  theme:          'dark' | 'light';
  notifications:  Array<{ id: string; message: string; type: 'success' | 'error' | 'warning' | 'info' }>;

  setSidebarOpen: (v: boolean) => void;
  setActivePanel: (panel: UIState['activePanel']) => void;
  setMapLayer:    (layer: UIState['mapLayer']) => void;
  setTheme:       (theme: 'dark' | 'light') => void;
  addNotification:(msg: string, type?: UIState['notifications'][0]['type']) => void;
  removeNotification: (id: string) => void;
}

export const useUIStore = create<UIState>()(
  devtools(
    persist(
      (set) => ({
        sidebarOpen:   true,
        activePanel:   'dashboard',
        mapLayer:      'all',
        theme:         'dark',
        notifications: [],

        setSidebarOpen:  (sidebarOpen)  => set({ sidebarOpen }),
        setActivePanel:  (activePanel)  => set({ activePanel }),
        setMapLayer:     (mapLayer)     => set({ mapLayer }),
        setTheme:        (theme)        => set({ theme }),
        addNotification: (message, type = 'info') => {
          const id = Math.random().toString(36).slice(2);
          set((s) => ({ notifications: [...s.notifications, { id, message, type }] }));
          setTimeout(() => {
            set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) }));
          }, 5000);
        },
        removeNotification: (id) => set((s) => ({
          notifications: s.notifications.filter((n) => n.id !== id)
        }))
      }),
      { name: 'aegis-ui', partialize: (s) => ({ theme: s.theme, sidebarOpen: s.sidebarOpen }) }
    )
  )
);

// ─── WebSocket slice ──────────────────────────────────────────────────────────
interface WSState {
  ws:           WebSocket | null;
  connected:    boolean;
  subscribedChannels: Set<string>;

  setWS:        (ws: WebSocket | null) => void;
  setConnected: (v: boolean) => void;
  subscribe:    (channel: string) => void;
  unsubscribe:  (channel: string) => void;
}

export const useWSStore = create<WSState>()((set, get) => ({
  ws:                 null,
  connected:          false,
  subscribedChannels: new Set(),

  setWS:        (ws)      => set({ ws }),
  setConnected: (connected) => set({ connected }),

  subscribe: (channel) => {
    const { ws } = get();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', channel }));
    }
    set((s) => ({ subscribedChannels: new Set([...s.subscribedChannels, channel]) }));
  },

  unsubscribe: (channel) => {
    const { ws } = get();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'unsubscribe', channel }));
    }
    set((s) => {
      const updated = new Set(s.subscribedChannels);
      updated.delete(channel);
      return { subscribedChannels: updated };
    });
  }
}));
