// ─── AEGIS GLOBAL — Public World View (no login required) ───────────────────
// A read-only global disaster overview for anyone — journalists, researchers,
// concerned citizens — without requiring an account. Staff/response teams use
// the full authenticated app via "Staff Sign In" above.
import React, { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { disastersApi } from '../../utils/api';
import type { Disaster } from '../../types';

const SEV_COLOR: Record<string, string> = {
  critical: '#ef4444', high: '#f97316', medium: '#f59e0b',
  low: '#22c55e', monitoring: '#64748b'
};
const TYPE_EMOJI: Record<string, string> = {
  earthquake: '🌍', tsunami: '🌊', flood: '🌊', flash_flood: '🌊',
  cyclone: '🌀', hurricane: '🌀', typhoon: '🌀', tornado: '🌪',
  wildfire: '🔥', volcano: '🌋', landslide: '⛰', drought: '🏜',
  pandemic: '🦠', disease_outbreak: '🦠'
};

function loadLeaflet(): Promise<any> {
  return new Promise((resolve) => {
    if ((window as any).L) { resolve((window as any).L); return; }
    if (!document.querySelector('link[href*="leaflet"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(link);
    }
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => resolve((window as any).L);
    document.head.appendChild(script);
  });
}

function usePublicDisasters() {
  return useQuery({
    queryKey: ['public-disasters'],
    queryFn: () => disastersApi.public({ limit: 100 }),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

export default function PublicView() {
  const mapRef       = useRef<HTMLDivElement>(null);
  const leafletMap   = useRef<any>(null);
  const markersLayer = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<Disaster | null>(null);

  const { data: result, isLoading } = usePublicDisasters();
  const disasters = result?.data || [];

  useEffect(() => { loadLeaflet().then(() => setReady(true)); }, []);

  useEffect(() => {
    if (!ready || !mapRef.current || leafletMap.current) return;
    const L = (window as any).L;
    const map = L.map(mapRef.current, { minZoom: 2, maxZoom: 10, worldCopyJump: false }).setView([20, 10], 2);

    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      { attribution: '© Esri © OpenStreetMap contributors', maxZoom: 18, maxNativeZoom: 16, noWrap: true }
    ).addTo(map);
    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 18, maxNativeZoom: 16, noWrap: true }
    ).addTo(map);

    markersLayer.current = L.layerGroup().addTo(map);
    leafletMap.current = map;
  }, [ready]);

  useEffect(() => {
    if (!leafletMap.current || !markersLayer.current) return;
    const L = (window as any).L;
    markersLayer.current.clearLayers();

    disasters.forEach((d: any) => {
      const coords = d.coordinates?.coordinates;
      if (!coords) return;
      const [lng, lat] = coords;
      const colour = SEV_COLOR[d.severity] || SEV_COLOR.monitoring;
      const icon = L.divIcon({
        html: `<div style="background:${colour};width:14px;height:14px;border-radius:50%;border:2px solid #0a0e1a;box-shadow:0 0 6px ${colour}"></div>`,
        className: '', iconSize: [14, 14], iconAnchor: [7, 7]
      });
      L.marker([lat, lng], { icon }).addTo(markersLayer.current).on('click', () => setSelected(d));
    });
  }, [disasters]);

  const critical = disasters.filter((d: any) => d.severity === 'critical').length;
  const countries = new Set(disasters.map((d: any) => d.country).filter(Boolean)).size;

  return (
    <div className="h-screen flex flex-col bg-[#0a0e1a] text-slate-200">
      <header className="h-14 flex-shrink-0 border-b border-[#1e2d4a] flex items-center px-4 gap-3">
        <div className="w-7 h-7 rounded-md bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-sm">🌍</div>
        <div>
          <div className="font-bold text-sm leading-tight">AEGIS GLOBAL</div>
          <div className="text-[10px] text-slate-500 leading-tight">Global Disaster Watch — public view</div>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-4 text-xs text-slate-400">
            <span>{disasters.length} active</span>
            <span className="text-red-400">{critical} critical</span>
            <span>{countries} countries</span>
          </div>
          <Link
            to="/login"
            className="text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors"
          >
            Staff Sign In
          </Link>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative">
          <div ref={mapRef} className="w-full h-full" />
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#0a0e1a]/60 text-sm text-slate-400">
              Loading global disaster data…
            </div>
          )}
        </div>

        <div className="w-80 flex-shrink-0 border-l border-[#1e2d4a] overflow-y-auto p-3 flex flex-col gap-2">
          <div className="text-xs text-slate-500 uppercase tracking-wider px-1 mb-1">Active worldwide</div>
          {disasters.length === 0 && !isLoading && (
            <div className="text-sm text-slate-600 text-center py-10">No active disasters reported</div>
          )}
          {[...disasters]
            .sort((a: any, b: any) => {
              const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, monitoring: 4 };
              return (order[a.severity] ?? 5) - (order[b.severity] ?? 5);
            })
            .map((d: any) => {
              const colour = SEV_COLOR[d.severity] || SEV_COLOR.monitoring;
              return (
                <div
                  key={d.id}
                  onClick={() => setSelected(d)}
                  className="p-2.5 rounded-lg border border-[#1e2d4a] bg-[#141b2d] cursor-pointer hover:brightness-110 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium flex items-center gap-1.5">
                      <span>{TYPE_EMOJI[d.type] || '⚠'}</span>{d.name}
                    </span>
                    <span className="text-[10px] font-semibold uppercase" style={{ color: colour }}>{d.severity}</span>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    📍 {d.country || 'Unknown'} · {formatDistanceToNow(new Date(d.startedAt), { addSuffix: true })}
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setSelected(null)}>
          <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-5 max-w-md w-full" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-lg">{TYPE_EMOJI[selected.type] || '⚠'}</span>
                <span className="text-base font-semibold">{selected.name}</span>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
            </div>
            <div className="text-xs text-slate-500 mb-4">
              📍 {selected.country || 'Unknown location'} · {formatDistanceToNow(new Date(selected.startedAt), { addSuffix: true })}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-[#0d1420] border border-[#1e2d4a] rounded-lg p-2.5 text-center">
                <div className="text-sm font-semibold text-red-400">{selected.deaths.toLocaleString()}</div>
                <div className="text-[10px] text-slate-600 uppercase">Deaths</div>
              </div>
              <div className="bg-[#0d1420] border border-[#1e2d4a] rounded-lg p-2.5 text-center">
                <div className="text-sm font-semibold text-orange-400">{selected.injured.toLocaleString()}</div>
                <div className="text-[10px] text-slate-600 uppercase">Injured</div>
              </div>
              <div className="bg-[#0d1420] border border-[#1e2d4a] rounded-lg p-2.5 text-center">
                <div className="text-sm font-semibold text-slate-300">{selected.affected.toLocaleString()}</div>
                <div className="text-[10px] text-slate-600 uppercase">Affected</div>
              </div>
            </div>
            {selected.magnitude != null && (
              <div className="text-xs text-slate-500 mt-3">Magnitude M{selected.magnitude}{selected.depthKm != null ? ` · Depth ${selected.depthKm}km` : ''}</div>
            )}
          </div>
        </div>
      )}

      <footer className="flex-shrink-0 text-center text-[10px] text-slate-600 py-1.5 border-t border-[#1e2d4a]">
        Data aggregated from GDACS (UN OCHA / European Commission) and verified reports · Updates automatically
      </footer>
    </div>
  );
}
