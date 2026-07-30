// ─── AEGIS GLOBAL — SOS Portal Component ─────────────────────────────────────
import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  useSOSReports, useSubmitSOS, useSOSStats, useGeolocation, useAlerts,
  useDisasters, useHistoricalStats, useHistoricalEvents, useSystemHealth
} from '../hooks';
import { useSOSStore, useAlertStore, useAuthStore, useDisasterStore } from '../store';
import { formatDistanceToNow } from 'date-fns';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  CartesianGrid, XAxis, YAxis, Tooltip
} from 'recharts';
import type { SOSReport } from '../types';

const SEV_STYLE: Record<string, { badge: string; border: string }> = {
  critical: { badge: 'bg-red-950 text-red-400 border border-red-700',    border: 'border-l-red-500' },
  high:     { badge: 'bg-orange-950 text-orange-400 border border-orange-700', border: 'border-l-orange-500' },
  medium:   { badge: 'bg-amber-950 text-amber-400 border border-amber-700',    border: 'border-l-amber-500' },
  low:      { badge: 'bg-green-950 text-green-400 border border-green-700',    border: 'border-l-green-500' },
};

const STATUS_BADGE: Record<string, string> = {
  pending:      'bg-red-900/50 text-red-400',
  acknowledged: 'bg-blue-900/50 text-blue-400',
  dispatched:   'bg-amber-900/50 text-amber-400',
  resolved:     'bg-green-900/50 text-green-400',
  false_alarm:  'bg-slate-800 text-slate-400',
};

function SOSCard({ report }: { report: SOSReport }) {
  const s    = SEV_STYLE[report.aiSeverity || 'low'];
  const loc  = report.location?.coordinates;
  return (
    <div className={`bg-[#141b2d] border border-[#1e2d4a] border-l-4 ${s.border} rounded-xl p-3 cursor-pointer hover:border-opacity-80`}>
      <div className="flex items-start gap-2 mb-1.5">
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${s.badge}`}>
          {report.aiSeverity?.toUpperCase() || 'UNKNOWN'}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[report.status]}`}>
          {report.status}
        </span>
        <span className="ml-auto text-xs text-slate-600">
          {formatDistanceToNow(new Date(report.createdAt), { addSuffix: true })}
        </span>
      </div>
      <div className="text-sm font-medium mb-1">
        {report.type.replace(/_/g, ' ')} — {report.peopleCount} person{report.peopleCount !== 1 ? 's' : ''}
      </div>
      {report.description && (
        <div className="text-xs text-slate-400 line-clamp-2 mb-1">{report.description}</div>
      )}
      {loc && (
        <div className="text-xs text-slate-600">
          📍 {loc[1].toFixed(4)}, {loc[0].toFixed(4)}
        </div>
      )}
      {report.aiAnalysis && (
        <div className="text-xs text-blue-400 mt-1.5 italic">AI: {report.aiAnalysis}</div>
      )}
    </div>
  );
}

export function SOSPortal() {
  const [tab,       setTab]       = useState<'reports' | 'submit'>('reports');
  const [formData,  setFormData]  = useState({
    type: 'trapped_rubble', description: '', peopleCount: 1,
    contactPhone: '', isAnonymous: false
  });
  const [submitted, setSubmitted] = useState<Record<string, unknown> | null>(null);

  const { reports }       = useSOSStore();
  const { data: stats }   = useSOSStats();
  const { location, getLocation, loading: locLoading } = useGeolocation();
  const submitSOS         = useSubmitSOS();

  useSOSReports();

  const handleSubmit = async () => {
    if (!location) { alert('Please get your location first'); return; }
    const result = await submitSOS.mutateAsync({
      type:         formData.type as any,
      lat:          location.lat,
      lng:          location.lng,
      description:  formData.description,
      peopleCount:  formData.peopleCount,
      contactPhone: formData.contactPhone,
      isAnonymous:  formData.isAnonymous
    });
    setSubmitted(result as any);
  };

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Stats bar */}
        <div className="flex gap-3 p-3 border-b border-[#1e2d4a] flex-shrink-0">
          {[
            { label: 'Critical pending', value: stats?.critical_pending || 0, colour: 'text-red-400' },
            { label: 'Active reports',   value: stats?.active_count     || 0, colour: 'text-orange-400' },
            { label: 'Resolved today',   value: stats?.resolved_today   || 0, colour: 'text-green-400' },
            { label: 'Avg resolution',   value: stats?.avg_resolution_minutes ? Math.round(Number(stats.avg_resolution_minutes)) + 'm' : '—', colour: 'text-blue-400' },
          ].map(s => (
            <div key={s.label} className="bg-[#141b2d] border border-[#1e2d4a] rounded-lg px-3 py-2 flex-1">
              <div className="text-xs text-slate-500">{s.label}</div>
              <div className={`text-lg font-semibold ${s.colour}`}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-[#1e2d4a] flex-shrink-0">
          {(['reports', 'submit'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-5 py-2.5 text-sm capitalize transition-colors ${tab === t ? 'text-blue-400 border-b-2 border-blue-400' : 'text-slate-500 hover:text-slate-300'}`}>
              {t === 'submit' ? '+ Submit SOS' : 'Live Reports'}
            </button>
          ))}
        </div>

        {tab === 'reports' && (
          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
            {reports.length === 0 && <div className="text-sm text-slate-600 text-center py-10">No active SOS reports</div>}
            {[...reports].sort((a, b) => {
              const order = { critical: 0, high: 1, medium: 2, low: 3 };
              return (order[a.aiSeverity as keyof typeof order] ?? 4) - (order[b.aiSeverity as keyof typeof order] ?? 4);
            }).map(r => <SOSCard key={r.id} report={r} />)}
          </div>
        )}

        {tab === 'submit' && (
          <div className="flex-1 overflow-y-auto p-4">
            {submitted ? (
              <div className="bg-green-950/40 border border-green-800 rounded-xl p-5">
                <div className="text-green-400 text-base font-semibold mb-3">✓ SOS Submitted Successfully</div>
                <div className="space-y-2 text-sm">
                  <div><span className="text-slate-500">Report ID:</span> <span className="font-mono text-blue-400">{(submitted as any).sosId?.slice(0, 12)}…</span></div>
                  <div><span className="text-slate-500">AI Severity:</span> <span className="text-red-400 uppercase font-semibold">{(submitted as any).aiSeverity}</span></div>
                  <div><span className="text-slate-500">Team:</span> {(submitted as any).recommendedTeam}</div>
                </div>
                {(submitted as any).safetyGuidance && (
                  <div className="mt-3 bg-amber-950/30 border border-amber-800 rounded-lg p-3 text-sm text-amber-300">
                    <div className="font-semibold mb-1">⚠ Safety Guidance:</div>
                    {(submitted as any).safetyGuidance}
                  </div>
                )}
                {(submitted as any).immediateActions && (
                  <div className="mt-3">
                    <div className="text-xs text-slate-500 mb-2 uppercase tracking-wider">Immediate actions:</div>
                    {((submitted as any).immediateActions as string[]).map((a, i) => (
                      <div key={i} className="text-sm text-slate-300 flex gap-2 mb-1">
                        <span className="text-blue-400">{i + 1}.</span>{a}
                      </div>
                    ))}
                  </div>
                )}
                <button onClick={() => { setSubmitted(null); setTab('reports'); }}
                  className="mt-4 w-full bg-blue-600 hover:bg-blue-700 text-white rounded-lg py-2 text-sm font-medium">
                  View all reports
                </button>
              </div>
            ) : (
              <div className="max-w-lg">
                <div className="mb-4">
                  <button onClick={() => {
                    submitSOS.mutate({ type: 'one_click_sos', lat: location?.lat || 0, lng: location?.lng || 0, peopleCount: 1 });
                  }}
                    className="w-full bg-red-600 hover:bg-red-700 text-white rounded-xl py-4 text-base font-bold flex items-center justify-center gap-2 mb-3">
                    🆘 ONE-CLICK SOS EMERGENCY
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Emergency type</label>
                    <select value={formData.type}
                      onChange={e => setFormData(p => ({ ...p, type: e.target.value }))}
                      className="w-full bg-[#141b2d] border border-[#1e2d4a] rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500/50">
                      <option value="trapped_rubble">Trapped under rubble</option>
                      <option value="stranded_flood">Stranded / flood</option>
                      <option value="medical_emergency">Medical emergency</option>
                      <option value="missing_person">Missing person</option>
                      <option value="hazard_observed">Hazard observed</option>
                      <option value="need_evacuation">Need evacuation help</option>
                      <option value="resource_request">Resource request</option>
                      <option value="other">Other</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Number of people</label>
                    <input type="number" min={1} value={formData.peopleCount}
                      onChange={e => setFormData(p => ({ ...p, peopleCount: parseInt(e.target.value) || 1 }))}
                      className="w-full bg-[#141b2d] border border-[#1e2d4a] rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500/50" />
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Describe your situation</label>
                    <textarea value={formData.description}
                      onChange={e => setFormData(p => ({ ...p, description: e.target.value }))}
                      rows={3} placeholder="What happened? Are there injuries? What do you need?"
                      className="w-full bg-[#141b2d] border border-[#1e2d4a] rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500/50 resize-none" />
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Contact phone (optional)</label>
                    <input type="tel" value={formData.contactPhone}
                      onChange={e => setFormData(p => ({ ...p, contactPhone: e.target.value }))}
                      placeholder="+1 555 000 0000"
                      className="w-full bg-[#141b2d] border border-[#1e2d4a] rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500/50" />
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Your location</label>
                    <button onClick={getLocation} disabled={locLoading}
                      className={`w-full border rounded-lg py-2 text-sm font-medium transition-colors ${
                        location ? 'bg-green-950/40 border-green-700 text-green-400' : 'bg-[#141b2d] border-[#1e2d4a] text-slate-400 hover:text-slate-200'
                      }`}>
                      {locLoading ? 'Getting location…' : location ? `✓ ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : '📍 Get my location'}
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <input type="checkbox" id="anon" checked={formData.isAnonymous}
                      onChange={e => setFormData(p => ({ ...p, isAnonymous: e.target.checked }))}
                      className="rounded" />
                    <label htmlFor="anon" className="text-xs text-slate-400">Submit anonymously</label>
                  </div>

                  <button onClick={handleSubmit}
                    disabled={submitSOS.isPending || !location}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white rounded-lg py-2.5 text-sm font-semibold transition-colors">
                    {submitSOS.isPending ? 'Submitting…' : 'Submit Emergency Report →'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Minimal MapView placeholder ──────────────────────────────────────────────
export function MapView() {
  return (
    <div className="flex h-full items-center justify-center bg-[#0a0e1a] text-slate-500">
      <div className="text-center">
        <div className="text-4xl mb-3">🗺</div>
        <div className="text-sm">Live GIS Map</div>
        <div className="text-xs text-slate-600 mt-1">Mapbox GL integration — requires VITE_MAPBOX_TOKEN</div>
      </div>
    </div>
  );
}

// ─── AlertsPanel placeholder ──────────────────────────────────────────────────
export function AlertsPanel() {
  const { alerts } = useAlertStore();
  useAlerts();

  const SEV: Record<string, string> = {
    critical: 'border-l-red-500 bg-red-950/20',
    high:     'border-l-orange-500 bg-orange-950/20',
    medium:   'border-l-amber-500 bg-amber-950/20',
    low:      'border-l-green-500 bg-green-950/20',
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="text-sm font-medium text-slate-300 mb-3">Live Alerts — {alerts.length} total</div>
      <div className="flex flex-col gap-2">
        {alerts.map((alert: any) => (
          <div key={alert.id} className={`border border-[#1e2d4a] border-l-4 ${SEV[alert.severity] || ''} rounded-xl p-3`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium">{alert.title}</span>
              <span className="ml-auto text-xs text-slate-500">
                {formatDistanceToNow(new Date(alert.issuedAt), { addSuffix: true })}
              </span>
            </div>
            <div className="text-xs text-slate-400 line-clamp-2">{alert.message}</div>
            <div className="flex gap-3 mt-1.5 text-xs text-slate-600">
              <span>{alert.severity?.toUpperCase()}</span>
              <span>{alert.recipientsDelivered?.toLocaleString()} notified</span>
              <span>{alert.channels?.join(', ')}</span>
            </div>
          </div>
        ))}
        {!alerts.length && (
          <div className="text-center py-10 text-slate-600 text-sm">No alerts in the last 24 hours</div>
        )}
      </div>
    </div>
  );
}

// ─── Analytics ────────────────────────────────────────────────────────────────
const CHART_COLOURS = ['#f87171', '#fb923c', '#fbbf24', '#4ade80', '#60a5fa', '#a78bfa', '#f472b6', '#22d3ee'];

export function Analytics() {
  const { data: stats, isLoading, error } = useHistoricalStats();
  const { disasters } = useDisasterStore();
  useDisasters();

  const byType = (stats?.byType?.buckets || []).map((b: any) => ({ name: b.key.replace('_', ' '), count: b.docCount }));
  const byDecade = (stats?.byDecade?.buckets || [])
    .filter((b: any) => b.docCount > 0)
    .map((b: any) => ({ year: b.keyAsString, count: b.docCount }));
  const byCountry = (stats?.byCountry?.buckets || []).slice(0, 8).map((b: any) => ({ name: b.key, count: b.docCount }));

  const activeByType = useMemo(() => {
    const counts: Record<string, number> = {};
    disasters.filter(d => d.status === 'active').forEach(d => { counts[d.type] = (counts[d.type] || 0) + 1; });
    return Object.entries(counts).map(([name, count]) => ({ name: name.replace('_', ' '), count }));
  }, [disasters]);

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-slate-500 text-sm">Loading analytics…</div>;
  }
  if (error) {
    return <div className="flex h-full items-center justify-center text-slate-500 text-sm">Couldn't load historical statistics — is historical-service running?</div>;
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Historical deaths</div>
          <div className="text-2xl font-semibold text-red-400">{Math.round(stats?.totalDeaths?.value || 0).toLocaleString()}</div>
        </div>
        <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">People affected</div>
          <div className="text-2xl font-semibold text-orange-400">{Math.round(stats?.totalAffected?.value || 0).toLocaleString()}</div>
        </div>
        <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Economic loss (USD)</div>
          <div className="text-2xl font-semibold text-amber-400">${Math.round((stats?.totalEconomic?.value || 0) / 1e9).toLocaleString()}B</div>
        </div>
        <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Avg recovery time</div>
          <div className="text-2xl font-semibold text-blue-400">{stats?.avgRecovery?.value ? Math.round(stats.avgRecovery.value) : '—'} mo</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-3">Currently active, by type</div>
          {activeByType.length === 0 ? (
            <div className="text-xs text-slate-600 text-center py-10">No active disasters</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={activeByType}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2d4a" />
                <XAxis dataKey="name" stroke="#64748b" fontSize={11} interval={0} angle={-20} textAnchor="end" height={50} />
                <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#141b2d', border: '1px solid #1e2d4a', fontSize: 12 }} />
                <Bar dataKey="count" fill="#f87171" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-3">Historical events, by type</div>
          {byType.length === 0 ? (
            <div className="text-xs text-slate-600 text-center py-10">No historical data indexed yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={byType} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={(e: any) => e.name}>
                  {byType.map((_: any, i: number) => <Cell key={i} fill={CHART_COLOURS[i % CHART_COLOURS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: '#141b2d', border: '1px solid #1e2d4a', fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-3">Historical events over time</div>
          {byDecade.length === 0 ? (
            <div className="text-xs text-slate-600 text-center py-10">No historical data indexed yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={byDecade}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2d4a" />
                <XAxis dataKey="year" stroke="#64748b" fontSize={11} />
                <YAxis stroke="#64748b" fontSize={11} allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#141b2d', border: '1px solid #1e2d4a', fontSize: 12 }} />
                <Line type="monotone" dataKey="count" stroke="#60a5fa" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-3">Most affected countries (historical)</div>
          {byCountry.length === 0 ? (
            <div className="text-xs text-slate-600 text-center py-10">No historical data indexed yet</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={byCountry} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2d4a" />
                <XAxis type="number" stroke="#64748b" fontSize={11} allowDecimals={false} />
                <YAxis type="category" dataKey="name" stroke="#64748b" fontSize={11} width={90} />
                <Tooltip contentStyle={{ background: '#141b2d', border: '1px solid #1e2d4a', fontSize: 12 }} />
                <Bar dataKey="count" fill="#a78bfa" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Historical explorer ──────────────────────────────────────────────────────
export function Historical() {
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const { data: historicalResult, isLoading, error } = useHistoricalEvents({ type: type || undefined, limit: 100 });
  const events = historicalResult?.data || [];

  const filtered = events.filter(e =>
    !search || e.name.toLowerCase().includes(search.toLowerCase()) || e.country?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="flex items-center gap-3 mb-4">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or country…"
          className="flex-1 bg-[#0d1420] border border-[#1e2d4a] rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-600"
        />
        <select
          value={type}
          onChange={e => setType(e.target.value)}
          className="bg-[#0d1420] border border-[#1e2d4a] rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-600"
        >
          <option value="">All types</option>
          {['earthquake', 'tsunami', 'flood', 'cyclone', 'hurricane', 'wildfire', 'volcano', 'drought', 'pandemic'].map(t => (
            <option key={t} value={t}>{t.replace('_', ' ')}</option>
          ))}
        </select>
      </div>

      {isLoading && <div className="text-sm text-slate-500 text-center py-12">Loading historical events…</div>}
      {error && <div className="text-sm text-slate-500 text-center py-12">Couldn't load historical events — is historical-service running?</div>}

      {!isLoading && !error && filtered.length === 0 && (
        <div className="text-sm text-slate-600 text-center py-12">No historical events match your filters</div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {filtered.map(ev => (
          <div key={ev.id} className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium">{ev.name}</span>
              <span className="text-xs text-slate-500">{new Date(ev.eventDate).getFullYear()}</span>
            </div>
            <div className="text-xs text-slate-500 mb-3">📍 {ev.country} · {ev.type.replace('_', ' ')}{ev.magnitude ? ` · M${ev.magnitude}` : ''}</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-sm font-semibold text-red-400">{ev.deaths.toLocaleString()}</div>
                <div className="text-[10px] text-slate-600 uppercase">Deaths</div>
              </div>
              <div>
                <div className="text-sm font-semibold text-orange-400">{(ev.affected / 1000).toFixed(0)}K</div>
                <div className="text-[10px] text-slate-600 uppercase">Affected</div>
              </div>
              <div>
                <div className="text-sm font-semibold text-amber-400">
                  {(ev as any).economicLoss ? `$${((ev as any).economicLoss / 1e9).toFixed(1)}B` : '—'}
                </div>
                <div className="text-[10px] text-slate-600 uppercase">Econ. loss</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Admin Portal ──────────────────────────────────────────────────────────────
const HEALTH_COLOUR: Record<string, string> = {
  healthy:     'text-green-400 bg-green-950/50 border-green-800',
  unhealthy:   'text-amber-400 bg-amber-950/50 border-amber-800',
  unreachable: 'text-red-400 bg-red-950/50 border-red-800',
};

export function AdminPortal() {
  const { user } = useAuthStore();
  const { data: health, isLoading, error, dataUpdatedAt } = useSystemHealth();

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-sm font-medium text-slate-300">Signed in as {user?.name}</div>
          <div className="text-xs text-slate-500">{user?.role?.replace('_', ' ')}</div>
        </div>
        {dataUpdatedAt > 0 && (
          <div className="text-xs text-slate-600">Last checked {new Date(dataUpdatedAt).toLocaleTimeString()} · refreshes every 30s</div>
        )}
      </div>

      {isLoading && <div className="text-sm text-slate-500 text-center py-12">Checking system health…</div>}
      {error && (
        <div className="text-sm text-slate-500 text-center py-12">
          Couldn't load system health — this panel requires global_admin, national_admin, or regional_admin.
        </div>
      )}

      {health && (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
              <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Overall status</div>
              <div className={`text-2xl font-semibold ${health.overallStatus === 'healthy' ? 'text-green-400' : health.overallStatus === 'degraded' ? 'text-amber-400' : 'text-red-400'}`}>
                {health.overallStatus}
              </div>
            </div>
            <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
              <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Services healthy</div>
              <div className="text-2xl font-semibold text-slate-200">{health.healthyCount} / {health.totalCount}</div>
            </div>
            <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
              <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">Checked at</div>
              <div className="text-sm font-medium text-slate-300 mt-1.5">{new Date(health.checkedAt).toLocaleTimeString()}</div>
            </div>
          </div>

          <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">Service status</div>
          <div className="grid grid-cols-3 gap-2">
            {health.services.map((svc: any) => (
              <div key={svc.name} className={`rounded-lg border p-3 ${HEALTH_COLOUR[svc.status] || 'border-[#1e2d4a] text-slate-400'}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium capitalize">{svc.name.replace('-', ' ')}</span>
                  <span className="text-xs uppercase">{svc.status}</span>
                </div>
                <div className="text-xs opacity-70 mt-1">{svc.latencyMs}ms</div>
              </div>
            ))}
          </div>

          <div className="mt-4 text-xs text-slate-600 bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
            User management and audit logs aren't built yet — this panel currently covers live system health only.
          </div>
        </>
      )}
    </div>
  );
}
