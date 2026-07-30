// ─── AEGIS GLOBAL — Live Disaster Map ────────────────────────────────────────
import React, { useEffect, useRef, useState } from 'react';
import { useDisasters, useSOSReports } from '../../hooks';
import { useDisasterStore, useSOSStore } from '../../store';

const SEV_COLOR: Record<string, string> = {
  critical: '#ef4444', high: '#f97316', medium: '#f59e0b',
  low: '#22c55e', monitoring: '#64748b'
};
const TYPE_EMOJI: Record<string, string> = {
  earthquake:'🌍',tsunami:'🌊',flood:'🌊',flash_flood:'🌊',
  cyclone:'🌀',hurricane:'🌀',typhoon:'🌀',tornado:'🌪',
  wildfire:'🔥',volcano:'🌋',landslide:'⛰',drought:'🏜',
  pandemic:'🦠',disease_outbreak:'🦠'
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

export default function MapView() {
  const mapRef       = useRef<HTMLDivElement>(null);
  const leafletMap   = useRef<any>(null);
  const markersLayer = useRef<any>(null);
  const sosLayer     = useRef<any>(null);
  const [activeLayer, setActiveLayer] = useState<'all'|'disasters'|'sos'>('all');
  const [ready, setReady]   = useState(false);
  const [selected, setSelected] = useState<any>(null);

  const { disasters } = useDisasterStore();
  const { reports }   = useSOSStore();

  useDisasters();
  useSOSReports();

  useEffect(() => { loadLeaflet().then(() => setReady(true)); }, []);

  useEffect(() => {
    if (!ready || !mapRef.current || leafletMap.current) return;
    const L = (window as any).L;

    delete L.Icon.Default.prototype._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
      shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
    });

    const map = L.map(mapRef.current, {
      center: [20, 0],
      zoom: 2,
      minZoom: 2,
      maxZoom: 18,
      worldCopyJump: false,
      maxBounds: [[-90, -180], [90, 180]],
      maxBoundsViscosity: 1.0
    });

    // Dark tile — noWrap stops the world repeating
    // Esri's Dark Gray Canvas (base + reference) instead of CARTO dark_all:
    // CARTO's OSM-derived raster tiles bake in OSM's native multilingual
    // continent/ocean name tags (e.g. "Africa/أفريقيا"), which can't be
    // filtered out of a pre-rendered raster image. Esri's canvas basemap
    // renders English-only labels worldwide and needs no API key.
    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: '© <a href="https://www.esri.com">Esri</a> © <a href="https://openstreetmap.org">OSM</a> contributors',
        maxZoom: 18,
        maxNativeZoom: 16,
        noWrap: true
      }
    ).addTo(map);

    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 18,
        maxNativeZoom: 16,
        noWrap: true
      }
    ).addTo(map);

    markersLayer.current = L.layerGroup().addTo(map);
    sosLayer.current     = L.layerGroup().addTo(map);
    leafletMap.current   = map;

    return () => { map.remove(); leafletMap.current = null; };
  }, [ready]);

  // Plot disasters
  useEffect(() => {
    if (!ready || !markersLayer.current) return;
    const L = (window as any).L;
    markersLayer.current.clearLayers();

    disasters.filter(d => d.status === 'active').forEach(d => {
      const coords = (d as any).coordinates?.coordinates;
      if (!coords) return;
      const [lng, lat] = coords;
      const color = SEV_COLOR[d.severity] || '#64748b';
      const emoji = TYPE_EMOJI[d.type]    || '⚠';

      // Glow circle
      L.circleMarker([lat, lng], {
        radius: d.severity === 'critical' ? 22 : d.severity === 'high' ? 16 : 12,
        fillColor: color, color, weight: 1.5,
        opacity: 0.5, fillOpacity: 0.15
      }).addTo(markersLayer.current);

      // Emoji marker
      L.marker([lat, lng], { icon: L.divIcon({
        html: `<div style="
          background:${color}22;border:2px solid ${color};border-radius:50%;
          width:34px;height:34px;display:flex;align-items:center;justify-content:center;
          font-size:15px;box-shadow:0 0 12px ${color}88;cursor:pointer;
        ">${emoji}</div>`,
        className: '', iconSize: [34,34], iconAnchor: [17,17]
      })})
        .bindPopup(`
          <div style="font-family:sans-serif;min-width:190px">
            <div style="font-weight:700;font-size:13px;margin-bottom:8px">${emoji} ${d.name}</div>
            <table style="font-size:11px;width:100%;border-collapse:collapse">
              <tr><td style="color:#888;padding:2px 0">Severity</td><td style="color:${color};font-weight:700;text-transform:uppercase">${d.severity}</td></tr>
              <tr><td style="color:#888;padding:2px 0">Type</td><td>${d.type.replace(/_/g,' ')}</td></tr>
              <tr><td style="color:#888;padding:2px 0">Country</td><td>${d.country||'—'}</td></tr>
              <tr><td style="color:#888;padding:2px 0">Deaths</td><td style="color:#f87171">${(d.deaths||0).toLocaleString()}</td></tr>
              <tr><td style="color:#888;padding:2px 0">Affected</td><td>${(d.affected||0).toLocaleString()}</td></tr>
              ${d.magnitude?`<tr><td style="color:#888;padding:2px 0">Magnitude</td><td>M${d.magnitude}</td></tr>`:''}
            </table>
          </div>`, { maxWidth: 260 })
        .on('click', () => setSelected(d))
        .addTo(markersLayer.current);
    });

    if (leafletMap.current) {
      if (activeLayer === 'sos') leafletMap.current.removeLayer(markersLayer.current);
      else leafletMap.current.addLayer(markersLayer.current);
    }
  }, [disasters, ready, activeLayer]);

  // Plot SOS
  useEffect(() => {
    if (!ready || !sosLayer.current) return;
    const L = (window as any).L;
    sosLayer.current.clearLayers();

    reports.filter(r => !['resolved','false_alarm'].includes(r.status)).forEach(sos => {
      const coords = (sos as any).location?.coordinates;
      if (!coords) return;
      const [lng, lat] = coords;
      const color = sos.aiSeverity === 'critical' ? '#ef4444' : '#f97316';

      L.marker([lat, lng], { icon: L.divIcon({
        html: `<div style="background:${color};border-radius:50%;width:20px;height:20px;
          display:flex;align-items:center;justify-content:center;font-size:9px;
          border:2px solid white;box-shadow:0 0 8px ${color}">🆘</div>`,
        className:'', iconSize:[20,20], iconAnchor:[10,10]
      })})
        .bindPopup(`<b>🆘 ${sos.type.replace(/_/g,' ')}</b><br/>People: ${sos.peopleCount}<br/>
          Severity: <b style="color:${color}">${sos.aiSeverity?.toUpperCase()}</b>`)
        .addTo(sosLayer.current);
    });

    if (leafletMap.current) {
      if (activeLayer === 'disasters') leafletMap.current.removeLayer(sosLayer.current);
      else leafletMap.current.addLayer(sosLayer.current);
    }
  }, [reports, ready, activeLayer]);

  useEffect(() => {
    if (!selected || !leafletMap.current) return;
    const c = (selected as any).coordinates?.coordinates;
    if (c) leafletMap.current.flyTo([c[1], c[0]], 6, { duration: 1.2 });
  }, [selected]);

  const active   = disasters.filter(d => d.status === 'active');
  const critical = active.filter(d => d.severity === 'critical').length;
  const high     = active.filter(d => d.severity === 'high').length;
  const sos      = reports.filter(r => r.status === 'pending').length;

  return (
    <div style={{ position:'relative', width:'100%', height:'100%', background:'#0a0e1a' }}>

      {/* Map fills entire container */}
      <div ref={mapRef} style={{ position:'absolute', inset:0, zIndex:0 }} />

      {/* Layer toggles */}
      <div style={{ position:'absolute', top:12, left:12, zIndex:1000, display:'flex', gap:6 }}>
        {(['all','disasters','sos'] as const).map(l => (
          <button key={l} onClick={() => setActiveLayer(l)} style={{
            background: activeLayer===l ? '#1A56B0' : 'rgba(10,14,26,.85)',
            border: `1px solid ${activeLayer===l ? '#3b82f6' : '#1e2d4a'}`,
            borderRadius:8, padding:'6px 14px', color:'#e2e8f0',
            fontSize:12, cursor:'pointer', backdropFilter:'blur(10px)',
            fontWeight: activeLayer===l ? 600 : 400
          }}>
            {l==='all'?'🌍 All':l==='disasters'?'⚡ Disasters':'🆘 SOS'}
          </button>
        ))}
      </div>

      {/* Live stats */}
      <div style={{
        position:'absolute', top:12, right:12, zIndex:1000,
        background:'rgba(10,14,26,.85)', border:'1px solid #1e2d4a',
        borderRadius:12, padding:'12px 16px', backdropFilter:'blur(10px)', minWidth:130
      }}>
        <div style={{ fontSize:10, color:'#64748b', textTransform:'uppercase', letterSpacing:'.6px', marginBottom:8 }}>Live</div>
        {[
          ['Critical', critical, '#ef4444'],
          ['High',     high,     '#f97316'],
          ['SOS',      sos,      '#60a5fa'],
          ['Total',    active.length, '#e2e8f0'],
        ].map(([k,v,c]) => (
          <div key={k as string} style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:5 }}>
            <span style={{ color:'#64748b' }}>{k}</span>
            <span style={{ color:c as string, fontWeight:600 }}>{v as number}</span>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div style={{
        position:'absolute', bottom:32, left:12, zIndex:1000,
        background:'rgba(10,14,26,.85)', border:'1px solid #1e2d4a',
        borderRadius:12, padding:'12px 16px', backdropFilter:'blur(10px)'
      }}>
        <div style={{ fontSize:10, color:'#64748b', textTransform:'uppercase', letterSpacing:'.6px', marginBottom:8 }}>Severity</div>
        {[
          ['Critical','#ef4444'],['High','#f97316'],
          ['Medium','#f59e0b'],['Low','#22c55e']
        ].map(([l,c]) => (
          <div key={l} style={{ display:'flex', alignItems:'center', gap:7, marginBottom:5 }}>
            <div style={{ width:10, height:10, borderRadius:'50%', background:c, boxShadow:`0 0 4px ${c}` }} />
            <span style={{ fontSize:11, color:'#94a3b8' }}>{l}</span>
          </div>
        ))}
      </div>

      {/* Selected disaster card */}
      {selected && (
        <div style={{
          position:'absolute', bottom:32, right:12, zIndex:1000,
          background:'rgba(10,14,26,.92)', border:`1px solid ${SEV_COLOR[selected.severity]}55`,
          borderLeft:`3px solid ${SEV_COLOR[selected.severity]}`,
          borderRadius:12, padding:'14px 16px', maxWidth:250,
          backdropFilter:'blur(10px)', color:'#e2e8f0'
        }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:10 }}>
            <div style={{ fontSize:13, fontWeight:600, lineHeight:1.3 }}>
              {TYPE_EMOJI[selected.type]||'⚠'} {selected.name}
            </div>
            <button onClick={() => setSelected(null)}
              style={{ background:'none', border:'none', color:'#64748b', cursor:'pointer', fontSize:16, padding:0, marginLeft:8 }}>✕</button>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'auto 1fr', gap:'4px 12px', fontSize:11 }}>
            {[
              ['Severity', <b style={{color:SEV_COLOR[selected.severity],textTransform:'uppercase'}}>{selected.severity}</b>],
              ['Country',  selected.country||'—'],
              ['Deaths',   <span style={{color:'#f87171'}}>{(selected.deaths||0).toLocaleString()}</span>],
              ['Affected', (selected.affected||0).toLocaleString()],
              selected.magnitude ? ['Magnitude', `M${selected.magnitude}`] : null,
            ].filter(Boolean).map(([k,v]:any) => (
              <React.Fragment key={k}>
                <span style={{color:'#64748b'}}>{k}</span>
                <span>{v}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {/* No data hint */}
      {ready && active.length === 0 && (
        <div style={{
          position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)',
          background:'rgba(10,14,26,.9)', border:'1px solid #1e2d4a',
          borderRadius:14, padding:'24px 32px', zIndex:1000, textAlign:'center'
        }}>
          <div style={{ fontSize:32, marginBottom:10 }}>📍</div>
          <div style={{ fontSize:14, color:'#94a3b8', marginBottom:6 }}>No active disasters on map</div>
          <div style={{ fontSize:12, color:'#475569' }}>Use the API to add disaster events</div>
        </div>
      )}
    </div>
  );
}
