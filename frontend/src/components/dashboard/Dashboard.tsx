// ─── AEGIS GLOBAL — Main Dashboard ───────────────────────────────────────────
import React, { useMemo, useState } from 'react';
import { useDisasters, useAlerts, useSOSStats } from '../../hooks';
import { useDisasterStore, useAlertStore } from '../../store';
import { formatDistanceToNow } from 'date-fns';
import type { Disaster } from '../../types';

const SEV_COLOURS: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  critical:   { bg: 'bg-red-950/60',    text: 'text-red-400',    border: 'border-red-800',    dot: 'bg-red-500'    },
  high:       { bg: 'bg-orange-950/60', text: 'text-orange-400', border: 'border-orange-800', dot: 'bg-orange-500' },
  medium:     { bg: 'bg-amber-950/60',  text: 'text-amber-400',  border: 'border-amber-800',  dot: 'bg-amber-500'  },
  low:        { bg: 'bg-green-950/60',  text: 'text-green-400',  border: 'border-green-800',  dot: 'bg-green-500'  },
  monitoring: { bg: 'bg-slate-900/60',  text: 'text-slate-400',  border: 'border-slate-700',  dot: 'bg-slate-500'  },
};

const TYPE_ICON: Record<string, string> = {
  earthquake: '🌍', tsunami: '🌊', flood: '🌊', flash_flood: '🌊',
  cyclone: '🌀', hurricane: '🌀', typhoon: '🌀', tornado: '🌪',
  wildfire: '🔥', volcano: '🌋', landslide: '⛰', drought: '🏜',
  heatwave: '🌡', pandemic: '🦠', disease_outbreak: '🦠',
  industrial: '🏭', chemical_leak: '☣', nuclear: '☢',
};

// ─── KPI card ─────────────────────────────────────────────────────────────────
function KPICard({
  label, value, sub, colour = 'text-slate-200', trend, icon
}: {
  label: string; value: string | number; sub?: string;
  colour?: string; trend?: { dir: 'up' | 'down'; value: string }; icon?: string;
}) {
  return (
    <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">{label}</div>
        {icon && <span className="text-lg">{icon}</span>}
      </div>
      <div className={`text-2xl font-semibold leading-none mb-1 ${colour}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
      {trend && (
        <div className={`text-xs mt-1.5 ${trend.dir === 'up' ? 'text-red-400' : 'text-green-400'}`}>
          {trend.dir === 'up' ? '↑' : '↓'} {trend.value}
        </div>
      )}
    </div>
  );
}

// ─── Disaster row ─────────────────────────────────────────────────────────────
function DisasterRow({ disaster, onClick }: { disaster: Disaster; onClick: () => void }) {
  const c = SEV_COLOURS[disaster.severity] || SEV_COLOURS.monitoring;
  return (
    <div
      onClick={onClick}
      className={`flex items-start gap-3 p-3 rounded-lg border ${c.bg} ${c.border} cursor-pointer hover:brightness-110 transition-all`}
    >
      <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${c.dot} animate-pulse`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium truncate">{disaster.name}</span>
          <span className={`text-xs font-semibold uppercase px-1.5 py-0.5 rounded ${c.bg} ${c.text} flex-shrink-0`}>
            {disaster.severity}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span>{TYPE_ICON[disaster.type] || '⚠'} {disaster.type.replace('_', ' ')}</span>
          {disaster.country && <span>📍 {disaster.country}</span>}
          {disaster.deaths > 0 && <span className="text-red-400">⚰ {disaster.deaths.toLocaleString()}</span>}
          {disaster.affected > 0 && <span>👥 {(disaster.affected / 1000).toFixed(0)}K</span>}
          <span>{formatDistanceToNow(new Date(disaster.startedAt), { addSuffix: true })}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Severity distribution bar ────────────────────────────────────────────────
function SeverityBar({ disasters }: { disasters: Disaster[] }) {
  const counts = useMemo(() => ({
    critical:   disasters.filter(d => d.severity === 'critical').length,
    high:       disasters.filter(d => d.severity === 'high').length,
    medium:     disasters.filter(d => d.severity === 'medium').length,
    low:        disasters.filter(d => d.severity === 'low').length,
  }), [disasters]);

  const total = disasters.length || 1;
  const bars: Array<{ key: keyof typeof counts; colour: string; label: string }> = [
    { key: 'critical', colour: 'bg-red-500',    label: 'Critical' },
    { key: 'high',     colour: 'bg-orange-500', label: 'High' },
    { key: 'medium',   colour: 'bg-amber-500',  label: 'Medium' },
    { key: 'low',      colour: 'bg-green-500',  label: 'Low' },
  ];

  return (
    <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wider mb-3">Severity breakdown</div>
      <div className="flex rounded-full overflow-hidden h-2 mb-3 gap-0.5">
        {bars.map(({ key, colour }) => (
          <div
            key={key}
            className={`${colour} h-full transition-all duration-500`}
            style={{ width: `${(counts[key] / total) * 100}%` }}
            title={`${key}: ${counts[key]}`}
          />
        ))}
      </div>
      <div className="flex gap-4">
        {bars.map(({ key, colour, label }) => (
          <div key={key} className="flex items-center gap-1.5 text-xs">
            <div className={`w-2 h-2 rounded-full ${colour}`} />
            <span className="text-slate-400">{label}</span>
            <span className="font-semibold text-slate-200">{counts[key]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Recent alerts mini-list ──────────────────────────────────────────────────
function RecentAlerts() {
  const { alerts } = useAlertStore();
  const recent = alerts.slice(0, 5);

  return (
    <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500 uppercase tracking-wider">Recent alerts</div>
        <span className="text-xs text-blue-400">{alerts.length} total</span>
      </div>
      {recent.length === 0 && (
        <div className="text-xs text-slate-600 text-center py-4">No alerts in last 24h</div>
      )}
      {recent.map((alert) => {
        const c = SEV_COLOURS[alert.severity];
        return (
          <div key={alert.id} className="flex items-start gap-2">
            <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${c?.dot}`} />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate">{alert.title}</div>
              <div className="text-xs text-slate-600">
                {formatDistanceToNow(new Date(alert.issuedAt), { addSuffix: true })}
                {' · '}{alert.recipientsDelivered.toLocaleString()} notified
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── SOS summary widget ───────────────────────────────────────────────────────
function SOSSummary() {
  const { data: stats } = useSOSStats();

  return (
    <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
      <div className="text-xs text-slate-500 uppercase tracking-wider mb-3">SOS reports (24h)</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-red-950/40 border border-red-900 rounded-lg p-2 text-center">
          <div className="text-xl font-bold text-red-400">{stats?.critical_pending || 0}</div>
          <div className="text-xs text-red-400/70">Critical pending</div>
        </div>
        <div className="bg-blue-950/40 border border-blue-900 rounded-lg p-2 text-center">
          <div className="text-xl font-bold text-blue-400">{stats?.active_count || 0}</div>
          <div className="text-xs text-blue-400/70">Active reports</div>
        </div>
        <div className="bg-green-950/40 border border-green-900 rounded-lg p-2 text-center">
          <div className="text-xl font-bold text-green-400">{stats?.resolved_today || 0}</div>
          <div className="text-xs text-green-400/70">Resolved today</div>
        </div>
        <div className="bg-amber-950/40 border border-amber-900 rounded-lg p-2 text-center">
          <div className="text-xl font-bold text-amber-400">
            {stats?.avg_resolution_minutes ? Math.round(Number(stats.avg_resolution_minutes)) + 'm' : '—'}
          </div>
          <div className="text-xs text-amber-400/70">Avg resolution</div>
        </div>
      </div>
    </div>
  );
}

// ─── Disaster detail modal ─────────────────────────────────────────────────────
function DisasterDetailModal({ disaster, onClose }: { disaster: Disaster; onClose: () => void }) {
  const c = SEV_COLOURS[disaster.severity] || SEV_COLOURS.monitoring;
  const meta = disaster.metadata as Record<string, any>;

  const stat = (label: string, value: string | number, colour = 'text-slate-200') => (
    <div className="bg-[#0d1420] border border-[#1e2d4a] rounded-lg p-3">
      <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-lg font-semibold ${colour}`}>{value}</div>
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-5 max-w-lg w-full max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-1">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg">{TYPE_ICON[disaster.type] || '⚠'}</span>
              <span className="text-base font-semibold">{disaster.name}</span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-xs font-semibold uppercase px-1.5 py-0.5 rounded ${c.bg} ${c.text}`}>{disaster.severity}</span>
              <span className="text-xs text-slate-500 capitalize">{disaster.status}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-xl leading-none">×</button>
        </div>

        <div className="text-xs text-slate-500 mt-2 mb-4">
          📍 {disaster.country || 'Unknown location'}{disaster.region ? `, ${disaster.region}` : ''}
          {' · '}Started {formatDistanceToNow(new Date(disaster.startedAt), { addSuffix: true })}
          {disaster.endedAt && ` · Ended ${formatDistanceToNow(new Date(disaster.endedAt), { addSuffix: true })}`}
        </div>

        <div className="grid grid-cols-3 gap-2 mb-2">
          {stat('Deaths', disaster.deaths.toLocaleString(), 'text-red-400')}
          {stat('Injured', disaster.injured.toLocaleString(), 'text-orange-400')}
          {stat('Missing', disaster.missing.toLocaleString(), 'text-amber-400')}
        </div>
        <div className="grid grid-cols-3 gap-2 mb-2">
          {stat('People affected', disaster.affected.toLocaleString())}
          {stat('Displaced', disaster.displaced.toLocaleString())}
          {stat('Economic loss', disaster.economicLossUsd > 0 ? `$${(disaster.economicLossUsd / 1e6).toFixed(1)}M` : '—')}
        </div>

        {(disaster.magnitude || disaster.depthKm || disaster.windSpeedKmh) && (
          <div className="grid grid-cols-3 gap-2 mb-4">
            {disaster.magnitude != null && stat('Magnitude', `M${disaster.magnitude}`)}
            {disaster.depthKm != null && stat('Depth', `${disaster.depthKm} km`)}
            {disaster.windSpeedKmh != null && stat('Wind speed', `${disaster.windSpeedKmh} km/h`)}
          </div>
        )}

        {meta?.severityText && (
          <div className="text-xs text-slate-500 bg-[#0d1420] border border-[#1e2d4a] rounded-lg p-3 mb-2">
            {meta.severityText}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-slate-600 mt-3">
          <span>Source: {meta?.dataSource || (disaster as any).source || 'manual'}</span>
          {meta?.reportUrl && (
            <a href={meta.reportUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
              Full report ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard() {
  useDisasters();
  useAlerts();

  const { disasters } = useDisasterStore();
  const [selected, setSelected] = useState<Disaster | null>(null);
  const active   = disasters.filter(d => d.status === 'active');
  const critical = active.filter(d => d.severity === 'critical');
  const affected = active.reduce((sum, d) => sum + (d.affected || 0), 0);
  const deaths   = active.reduce((sum, d) => sum + (d.deaths || 0), 0);

  return (
    <div className="flex h-full overflow-hidden">

      {/* Left column — KPIs + event list */}
      <div className="flex-1 overflow-y-auto p-4">

        {/* KPI row */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <KPICard
            label="Active events"
            value={active.length}
            sub={`Across ${new Set(active.map(d => d.country)).size} countries`}
            colour="text-red-400"
            icon="⚡"
            trend={active.length > 15 ? { dir: 'up', value: '+3 today' } : undefined}
          />
          <KPICard
            label="Critical events"
            value={critical.length}
            sub="Immediate response required"
            colour="text-red-500"
            icon="🚨"
          />
          <KPICard
            label="People affected"
            value={affected === 0 ? '0' : affected >= 1_000_000 ? `${(affected / 1_000_000).toFixed(1)}M` : `${(affected / 1000).toFixed(0)}K`}
            sub="Estimated total"
            colour="text-orange-400"
            icon="👥"
          />
          <KPICard
            label="Confirmed deaths"
            value={deaths.toLocaleString()}
            sub="Across all active events"
            colour="text-slate-300"
            icon="⚰"
          />
        </div>

        <SeverityBar disasters={active} />

        <div className="mt-4 mb-2 flex items-center justify-between">
          <div className="text-sm font-medium text-slate-300">Active disaster events</div>
          <div className="text-xs text-slate-500">Sorted by severity</div>
        </div>

        {/* Disaster list */}
        <div className="flex flex-col gap-2">
          {active.length === 0 && (
            <div className="text-sm text-slate-600 text-center py-12">
              No active disasters found
            </div>
          )}
          {[...active]
            .sort((a, b) => {
              const order = { critical: 0, high: 1, medium: 2, low: 3, monitoring: 4 };
              return (order[a.severity] ?? 5) - (order[b.severity] ?? 5);
            })
            .map(disaster => <DisasterRow key={disaster.id} disaster={disaster} onClick={() => setSelected(disaster)} />)
          }
        </div>
      </div>

      {/* Right sidebar — widgets */}
      <div className="w-64 flex-shrink-0 border-l border-[#1e2d4a] overflow-y-auto p-3 flex flex-col gap-3">
        <SOSSummary />
        <RecentAlerts />
        

        {/* Global stats */}
        <div className="bg-[#141b2d] border border-[#1e2d4a] rounded-xl p-4">
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-3">Platform stats</div>
          <div className="flex flex-col gap-2 text-xs">
            <div className="flex justify-between"><span className="text-slate-500">Satellites active</span><span className="font-medium">47</span></div>
            <div className="flex justify-between"><span className="text-slate-500">API uptime</span><span className="font-medium text-green-400">99.99%</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Alerts today</span><span className="font-medium">4.8M</span></div>
            <div className="flex justify-between"><span className="text-slate-500">AI predictions</span><span className="font-medium text-purple-400">12 active</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Countries monitored</span><span className="font-medium">134</span></div>
          </div>
        </div>
      </div>

      {selected && <DisasterDetailModal disaster={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
