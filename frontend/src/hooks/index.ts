// ─── AEGIS GLOBAL — Custom React Hooks ───────────────────────────────────────
import { useEffect, useCallback, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  disastersApi, alertsApi, sosApi,
  historicalApi, riskApi, socialApi, sheltersApi, aiApi, systemApi
} from '../utils/api';
import {
  useDisasterStore, useAlertStore, useSOSStore,
  usePredictionStore, useWSStore, useUIStore
} from '../store';
import type { Disaster, Alert, SOSReport } from '../types';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:4000';

// ─── useDisasters ─────────────────────────────────────────────────────────────
export function useDisasters(params: { type?: string; severity?: string; status?: string } = {}) {
  const { setDisasters, setLoading, filterType, filterSeverity, filterStatus } = useDisasterStore();

  const query = useQuery({
    queryKey: ['disasters', params, filterType, filterSeverity, filterStatus],
    queryFn: () => disastersApi.list({
      type:     params.type     || filterType     || undefined,
      severity: params.severity || filterSeverity || undefined,
      status:   params.status   || filterStatus   || 'active',
      limit:    100
    }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (query.data) setDisasters(query.data.data);
    setLoading(query.isLoading);
  }, [query.data, query.isLoading]);

  return query;
}

export function useDisaster(id: string) {
  return useQuery({
    queryKey:  ['disaster', id],
    queryFn:   () => disastersApi.get(id),
    staleTime: 15_000,
    enabled:   !!id,
  });
}

export function useCreateDisaster() {
  const qc = useQueryClient();
  const { addDisaster } = useDisasterStore();
  const { addNotification } = useUIStore();
  return useMutation({
    mutationFn: disastersApi.create,
    onSuccess: (disaster) => {
      addDisaster(disaster);
      qc.invalidateQueries({ queryKey: ['disasters'] });
      addNotification(`Disaster "${disaster.name}" created`, 'success');
    },
    onError: (err: any) => addNotification(err.response?.data?.message || 'Failed to create disaster', 'error')
  });
}

export function useUpdateDisaster() {
  const qc = useQueryClient();
  const { updateDisaster } = useDisasterStore();
  const { addNotification } = useUIStore();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<Disaster> }) =>
      disastersApi.update(id, payload),
    onSuccess: (disaster) => {
      updateDisaster(disaster.id, disaster);
      qc.invalidateQueries({ queryKey: ['disaster', disaster.id] });
      addNotification('Disaster updated', 'success');
    },
    onError: (err: any) => addNotification(err.response?.data?.message || 'Update failed', 'error')
  });
}

// ─── useAlerts ────────────────────────────────────────────────────────────────
export function useAlerts(disasterId?: string) {
  const { setAlerts } = useAlertStore();
  const query = useQuery({
    queryKey:  ['alerts', disasterId],
    queryFn:   () => alertsApi.list({ disasterId, limit: 50 }),
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
  useEffect(() => {
    if (query.data) setAlerts(query.data.data);
  }, [query.data]);
  return query;
}

export function useIssueAlert() {
  const qc = useQueryClient();
  const { addAlert } = useAlertStore();
  const { addNotification } = useUIStore();
  return useMutation({
    mutationFn: alertsApi.create,
    onSuccess: (alert) => {
      addAlert(alert);
      qc.invalidateQueries({ queryKey: ['alerts'] });
      addNotification(`Alert issued: ${alert.title}`, 'success');
    },
    onError: (err: any) => addNotification(err.response?.data?.message || 'Failed to issue alert', 'error')
  });
}

// ─── useSOS ───────────────────────────────────────────────────────────────────
export function useSOSReports(params: { status?: string; disasterId?: string } = {}) {
  const { setReports } = useSOSStore();
  const query = useQuery({
    queryKey:  ['sos-reports', params],
    queryFn:   () => sosApi.list({ ...params, limit: 100 }),
    staleTime: 10_000,
    refetchInterval: 10_000,
  });
  useEffect(() => {
    if (query.data) setReports(query.data.data);
  }, [query.data]);
  return query;
}

export function useSubmitSOS() {
  const { addNotification } = useUIStore();
  return useMutation({
    mutationFn: sosApi.submit,
    onSuccess: (result) => {
      addNotification(
        `SOS submitted — ${result.aiSeverity.toUpperCase()} priority. Help is on the way.`,
        result.aiSeverity === 'critical' ? 'warning' : 'info'
      );
    },
    onError: (err: any) => addNotification(err.response?.data?.message || 'SOS submission failed', 'error')
  });
}

export function useSOSStats() {
  return useQuery({
    queryKey:  ['sos-stats'],
    queryFn:   sosApi.getStats,
    refetchInterval: 15_000,
  });
}

// ─── useAI ────────────────────────────────────────────────────────────────────
export function useAIAnalysis() {
  const { addNotification } = useUIStore();
  return useMutation({
    mutationFn: aiApi.analyse,
    onError: (err: any) => addNotification(err.response?.data?.message || 'AI analysis failed', 'error')
  });
}

export function useAISituationReport() {
  return useMutation({ mutationFn: (disaster: Disaster) => aiApi.situationReport(disaster) });
}

export function useAIPolicyBrief() {
  return useMutation({ mutationFn: aiApi.policyBrief });
}

// ─── useHistorical ────────────────────────────────────────────────────────────
export function useHistoricalEvents(params: { type?: string; country?: string; year?: number; limit?: number } = {}) {
  return useQuery({
    queryKey:  ['historical', params],
    queryFn:   () => historicalApi.list(params),
    staleTime: 60_000 * 5,
  });
}

export function useHistoricalStats() {
  return useQuery({
    queryKey:  ['historical-stats'],
    queryFn:   historicalApi.stats,
    staleTime: 60_000 * 10,
  });
}

// ─── useSystemHealth (Admin Portal) ────────────────────────────────────────────
export function useSystemHealth() {
  return useQuery({
    queryKey:      ['system-health'],
    queryFn:       systemApi.health,
    staleTime:     15_000,
    refetchInterval: 30_000,
  });
}

// ─── useCountryRisk ───────────────────────────────────────────────────────────
export function useCountryRisks() {
  return useQuery({
    queryKey:  ['country-risks'],
    queryFn:   riskApi.listCountries,
    staleTime: 60_000 * 60,
  });
}

// ─── useWebSocket ─────────────────────────────────────────────────────────────
export function useWebSocket() {
  const { setWS, setConnected, subscribedChannels } = useWSStore();
  const { addDisaster, updateDisaster } = useDisasterStore();
  const { addAlert } = useAlertStore();
  const { addReport, updateReport } = useSOSStore();
  const { addNotification } = useUIStore();
  const qc = useQueryClient();
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout>>();
  const reconnectDelay   = useRef(1000);

  const connect = useCallback(() => {
    const token = localStorage.getItem('aegis_access_token');
    const url   = token ? `${WS_URL}/ws?token=${token}` : `${WS_URL}/ws`;
    const ws    = new WebSocket(url);

    ws.onopen = () => {
      setConnected(true);
      setWS(ws);
      reconnectDelay.current = 1000;
      subscribedChannels.forEach((ch) => {
        ws.send(JSON.stringify({ type: 'subscribe', channel: ch }));
      });
      ['disasters', 'alerts', 'sos', 'predictions'].forEach((ch) => {
        ws.send(JSON.stringify({ type: 'subscribe', channel: ch }));
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type !== 'broadcast') return;
        switch (msg.channel) {
          case 'disasters':
            if (msg.payload?.eventType === 'disaster.created') {
              addDisaster(msg.payload.payload);
              addNotification(`New disaster: ${msg.payload.payload.name}`, 'warning');
              qc.invalidateQueries({ queryKey: ['disasters'] });
            }
            if (msg.payload?.eventType === 'disaster.updated') {
              updateDisaster(msg.payload.payload.id, msg.payload.payload);
            }
            break;
          case 'alerts':
            if (msg.payload) {
              addAlert(msg.payload as Alert);
              if ((msg.payload as Alert).severity === 'critical') {
                addNotification(`🚨 CRITICAL ALERT: ${(msg.payload as Alert).title}`, 'warning');
              }
              qc.invalidateQueries({ queryKey: ['alerts'] });
            }
            break;
          case 'sos':
            if (msg.payload?.eventType === 'sos.created') {
              addReport(msg.payload.payload as SOSReport);
              qc.invalidateQueries({ queryKey: ['sos-reports'] });
            }
            if (msg.payload?.eventType === 'sos.updated') {
              updateReport(msg.payload.payload.id, msg.payload.payload);
            }
            break;
        }
      } catch { /* ignore */ }
    };

    ws.onerror = () => setConnected(false);
    ws.onclose = () => {
      setConnected(false);
      setWS(null);
      reconnectTimeout.current = setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30_000);
        connect();
      }, reconnectDelay.current);
    };
    return ws;
  }, []);

  useEffect(() => {
    const ws = connect();
    return () => {
      clearTimeout(reconnectTimeout.current);
      ws?.close(1000, 'Component unmounted');
    };
  }, []);
}

// ─── useShelters ──────────────────────────────────────────────────────────────
export function useShelters(params: { disasterId?: string; lat?: number; lng?: number; radiusKm?: number } = {}) {
  return useQuery({
    queryKey:  ['shelters', params],
    queryFn:   () => sheltersApi.list(params),
    staleTime: 30_000,
  });
}

// ─── useSocialSignals ─────────────────────────────────────────────────────────
export function useSocialSignals(disasterId?: string) {
  return useQuery({
    queryKey:  ['social-signals', disasterId],
    queryFn:   () => socialApi.list({ disasterId, limit: 50 }),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

// ─── useGeolocation ───────────────────────────────────────────────────────────
export function useGeolocation() {
  const [location, setLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [loading, setLoading]   = useState(false);

  const getLocation = useCallback(() => {
    if (!navigator.geolocation) { setError('Geolocation not supported'); return; }
    setLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setLoading(false); },
      (err) => { setError(err.message); setLoading(false); },
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }, []);

  return { location, error, loading, getLocation };
}

// ─── useCountdown ─────────────────────────────────────────────────────────────
export function useCountdown(targetDate: string) {
  const [remaining, setRemaining] = useState<{
    hours: number; minutes: number; seconds: number; total: number;
  } | null>(null);

  useEffect(() => {
    const update = () => {
      const diff = new Date(targetDate).getTime() - Date.now();
      if (diff <= 0) { setRemaining(null); return; }
      setRemaining({
        hours:   Math.floor(diff / 3_600_000),
        minutes: Math.floor((diff % 3_600_000) / 60_000),
        seconds: Math.floor((diff % 60_000) / 1_000),
        total:   diff
      });
    };
    update();
    const interval = setInterval(update, 1_000);
    return () => clearInterval(interval);
  }, [targetDate]);

  return remaining;
}
