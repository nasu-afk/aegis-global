// ─── AEGIS GLOBAL — GDACS live feed ingestion ────────────────────────────────
// Pulls real-time multi-hazard disaster events from the Global Disaster Alert
// and Coordination System (GDACS — a joint UN OCHA / European Commission
// initiative) and upserts them into the disasters table. Free, no API key,
// updates continuously. Covers earthquakes, floods, cyclones, droughts,
// volcanoes and wildfires — verified live at:
//   https://www.gdacs.org/gdacsapi/api/events/geteventlist/events4app
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';

const GDACS_URL = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/events4app';

// GDACS eventtype -> our disaster_type enum. GDACS also emits 'TS' (tsunami)
// on rare occasions and other codes; anything not listed here is skipped
// rather than guessed at.
const TYPE_MAP: Record<string, string> = {
  EQ: 'earthquake',
  FL: 'flood',
  TC: 'cyclone',
  VO: 'volcano',
  WF: 'wildfire',
  DR: 'drought',
  TS: 'tsunami'
};

function mapSeverity(alertlevel: string | undefined): string {
  switch ((alertlevel || '').toLowerCase()) {
    case 'red': return 'critical';
    case 'orange': return 'high';
    case 'green': return 'low';
    default: return 'monitoring';
  }
}

// GDACS embeds depth in a free-text field for earthquakes, e.g.
// "Magnitude 4.5M, Depth:104.787km" — pull the number out when present.
function parseDepthKm(severitytext: string | undefined): number | null {
  const m = /Depth:\s*([\d.]+)\s*km/i.exec(severitytext || '');
  return m ? parseFloat(m[1]) : null;
}

interface GdacsFeature {
  geometry?: { type: string; coordinates: [number, number] };
  properties: {
    eventtype: string;
    eventid: number;
    name?: string;
    country?: string;
    fromdate?: string;
    todate?: string;
    iscurrent?: string;
    alertlevel?: string;
    source?: string;
    affectedcountries?: { iso2: string; iso3: string; countryname: string }[];
    severitydata?: { severity: number; severitytext: string; severityunit: string };
    url?: { report?: string };
  };
}

export interface IngestionResult {
  inserted: number;
  updated: number;
  skipped: number;
  total: number;
}

export async function runGdacsIngestion(
  db: Pool,
  publishEvent: (topic: string, key: string, value: unknown) => Promise<void>,
  logger: winston.Logger
): Promise<IngestionResult> {
  let inserted = 0, updated = 0, skipped = 0;

  let features: GdacsFeature[];
  try {
    const res = await fetch(GDACS_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GDACS responded ${res.status}`);
    const body = await res.json() as { features?: GdacsFeature[] };
    features = body.features || [];
  } catch (err) {
    logger.error('GDACS fetch failed', { err: err instanceof Error ? err.message : String(err) });
    return { inserted, updated, skipped, total: 0 };
  }

  for (const f of features) {
    const p = f.properties;
    const type = TYPE_MAP[p.eventtype];
    const coords = f.geometry?.coordinates;

    if (!type || !coords || coords.length < 2) { skipped++; continue; }

    const [lng, lat] = coords;
    const externalId = `${p.eventtype}-${p.eventid}`;
    const severity = mapSeverity(p.alertlevel);
    const status = p.iscurrent === 'true' ? 'active' : 'closed';
    const country = p.affectedcountries?.[0]?.countryname || p.country || null;
    const iso2 = p.affectedcountries?.[0]?.iso2 || null;
    const isEarthquake = p.eventtype === 'EQ';
    const magnitude = isEarthquake ? (p.severitydata?.severity ?? null) : null;
    const depthKm = isEarthquake ? parseDepthKm(p.severitydata?.severitytext) : null;
    const name = p.name || `${type} in ${country || 'unknown location'}`;

    const metadata = {
      gdacsAlertLevel: p.alertlevel,
      severityText: p.severitydata?.severitytext,
      severityUnit: p.severitydata?.severityunit,
      reportUrl: p.url?.report,
      dataSource: p.source
    };

    try {
      const result = await db.query(
        `INSERT INTO disasters (
           id, name, type, severity, status, country, iso2,
           coordinates, magnitude, depth_km, started_at, ended_at, metadata,
           source, external_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,
           ST_GeographyFromText('POINT(${lng} ${lat})'),$8,$9,$10,$11,$12,
           'gdacs',$13
         )
         ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO UPDATE SET
           severity   = EXCLUDED.severity,
           status     = EXCLUDED.status,
           magnitude  = EXCLUDED.magnitude,
           depth_km   = EXCLUDED.depth_km,
           ended_at   = EXCLUDED.ended_at,
           metadata   = EXCLUDED.metadata,
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS was_inserted`,
        [
          uuidv4(), name, type, severity, status, country, iso2,
          magnitude, depthKm,
          p.fromdate ? new Date(p.fromdate).toISOString() : new Date().toISOString(),
          status === 'closed' && p.todate ? new Date(p.todate).toISOString() : null,
          JSON.stringify(metadata), externalId
        ]
      );

      const row = result.rows[0];
      if (row.was_inserted) {
        inserted++;
        const full = await db.query(
          `SELECT d.*, ST_AsGeoJSON(d.coordinates)::json AS coordinates FROM disasters d WHERE id = $1`,
          [row.id]
        );
        await publishEvent('disaster.created', row.id, {
          eventId: uuidv4(), eventType: 'disaster.created',
          timestamp: new Date().toISOString(), source: 'alert-service:gdacs-ingestion',
          payload: full.rows[0]
        });
      } else {
        updated++;
      }
    } catch (err) {
      logger.error('GDACS row upsert failed', { externalId, err: err instanceof Error ? err.message : String(err) });
      skipped++;
    }
  }

  const summary = { inserted, updated, skipped, total: features.length };
  logger.info('GDACS ingestion complete', summary);
  return summary;
}
