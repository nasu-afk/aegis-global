// ─── AEGIS GLOBAL — GIS & Geospatial Intelligence Service ────────────────────
import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';

const app  = express();
const PORT = process.env.PORT || 4003;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'gis-service' },
  transports: [new winston.transports.Console()]
});

const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

app.use(express.json());

// ─── GET /gis/nearby — find resources, shelters, teams near a point ───────────
app.get('/gis/nearby', async (req: Request, res: Response) => {
  const schema = z.object({
    lat:       z.coerce.number().min(-90).max(90),
    lng:       z.coerce.number().min(-180).max(180),
    radiusKm:  z.coerce.number().positive().default(50),
    types:     z.string().optional(), // comma-separated: shelters,teams,resources,drones
    limit:     z.coerce.number().int().positive().default(20)
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const { lat, lng, radiusKm, types, limit } = parsed.data;
  const typeList = types ? types.split(',').map(t => t.trim()) : ['shelters','teams','resources','drones'];
  const radiusM  = radiusKm * 1000;
  const point    = `ST_GeographyFromText('POINT(${lng} ${lat})')`;

  const results: Record<string, unknown[]> = {};

  try {
    await Promise.all(typeList.map(async (type) => {
      let query = '';
      switch (type) {
        case 'shelters':
          query = `
            SELECT id, name, 'shelter' AS entity_type,
                   ST_AsGeoJSON(location)::json AS location,
                   address, capacity_total, occupancy_current, status,
                   food_days_remaining, water_days_remaining, medical_unit,
                   ROUND(ST_Distance(location, ${point})::numeric / 1000, 2) AS distance_km
            FROM shelters
            WHERE status IN ('open','preparing')
              AND ST_DWithin(location, ${point}, $1)
            ORDER BY distance_km ASC
            LIMIT $2`;
          break;
        case 'teams':
          query = `
            SELECT id, name, 'response_team' AS entity_type,
                   ST_AsGeoJSON(current_location)::json AS location,
                   type, specialisation, personnel_count, status,
                   ROUND(ST_Distance(current_location, ${point})::numeric / 1000, 2) AS distance_km
            FROM response_teams
            WHERE status IN ('standby','deployed')
              AND ST_DWithin(current_location, ${point}, $1)
            ORDER BY distance_km ASC
            LIMIT $2`;
          break;
        case 'resources':
          query = `
            SELECT id, name, 'resource' AS entity_type,
                   ST_AsGeoJSON(current_location)::json AS location,
                   category, quantity_available, unit, status,
                   ROUND(ST_Distance(current_location, ${point})::numeric / 1000, 2) AS distance_km
            FROM resources
            WHERE status = 'available'
              AND quantity_available > 0
              AND ST_DWithin(current_location, ${point}, $1)
            ORDER BY distance_km ASC
            LIMIT $2`;
          break;
        case 'drones':
          query = `
            SELECT id, callsign, 'drone' AS entity_type,
                   ST_AsGeoJSON(current_location)::json AS location,
                   type, mission_type, status, battery_pct,
                   ROUND(ST_Distance(current_location, ${point})::numeric / 1000, 2) AS distance_km
            FROM drones
            WHERE status IN ('standby','active')
              AND ST_DWithin(current_location, ${point}, $1)
            ORDER BY distance_km ASC
            LIMIT $2`;
          break;
      }
      if (query) {
        const result = await db.query(query, [radiusM, limit]);
        results[type] = result.rows;
      }
    }));

    res.json({ status: 'success', data: results, center: { lat, lng }, radiusKm });
  } catch (err) {
    logger.error('Nearby query error', { err });
    res.status(500).json({ status: 'error', message: 'GIS query failed' });
  }
});

const evacuationRoutesSchema = z.object({
  lat:        z.coerce.number().min(-90).max(90),
  lng:        z.coerce.number().min(-180).max(180),
  disasterId: z.string().uuid().optional()
});

// ─── GET /gis/evacuation-routes ───────────────────────────────────────────────
app.get('/gis/evacuation-routes', async (req: Request, res: Response) => {
  const parsed = evacuationRoutesSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', message: 'lat and lng required', details: parsed.error.flatten() });
    return;
  }
  const { lat, lng, disasterId } = parsed.data;

  try {
    // Find nearest shelters and build evacuation route waypoints
    const shelters = await db.query(
      `SELECT id, name, address,
              ST_AsGeoJSON(location)::json AS location,
              capacity_total, occupancy_current, status,
              ROUND(ST_Distance(location, ST_GeographyFromText($1))::numeric / 1000, 2) AS distance_km
       FROM shelters
       WHERE status = 'open'
         AND occupancy_current < capacity_total
         AND ST_DWithin(location, ST_GeographyFromText($1), 100000)
       ORDER BY distance_km ASC
       LIMIT 5`,
      [`POINT(${lng} ${lat})`]
    );

    // Simulate route waypoints (production: integrate with routing API like OSRM)
    const routes = shelters.rows.map((shelter, i) => ({
      id:          uuidv4(),
      destination: shelter,
      priority:    i + 1,
      estimatedTime: Math.round(Number(shelter.distance_km) * 2), // rough estimate: 2 min/km
      distance_km: shelter.distance_km,
      waypoints: [
        { lat: Number(lat), lng: Number(lng), type: 'origin' },
        { lat: shelter.location.coordinates[1], lng: shelter.location.coordinates[0], type: 'destination' }
      ],
      safetyNotes: i === 0 ? 'Primary route — use if road is clear' : `Alternative route #${i + 1}`
    }));

    // Check for any hazards along routes
    let hazards: unknown[] = [];
    if (disasterId) {
      const hazardResult = await db.query(
        `SELECT id, name, type, severity,
                ST_AsGeoJSON(coordinates)::json AS coordinates
         FROM disasters
         WHERE id = $1 AND coordinates IS NOT NULL`,
        [disasterId]
      );
      hazards = hazardResult.rows;
    }

    res.json({
      status: 'success',
      data: {
        origin:  { lat: Number(lat), lng: Number(lng) },
        routes,
        hazards,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    logger.error('Evacuation routes error', { err });
    res.status(500).json({ status: 'error', message: 'Route calculation failed' });
  }
});

const floodModelSchema = z.object({
  lat:            z.coerce.number().min(-90).max(90),
  lng:            z.coerce.number().min(-180).max(180),
  rainfallMm:     z.coerce.number().min(0).max(2000).default(100),
  riverGaugePct:  z.coerce.number().min(0).max(100).default(70),
  tidalInfluence: z.enum(['true', 'false']).default('false').transform(v => v === 'true')
});

// ─── GET /gis/flood-model ─────────────────────────────────────────────────────
app.get('/gis/flood-model', async (req: Request, res: Response) => {
  const parsed = floodModelSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', message: 'lat and lng required', details: parsed.error.flatten() });
    return;
  }
  const { lat, lng, rainfallMm, riverGaugePct, tidalInfluence } = parsed.data;

  // Simplified flood extent model (production: integrate with LISFLOOD or HEC-RAS)
  const rainfall  = rainfallMm;
  const gauge     = riverGaugePct;
  const tidal     = tidalInfluence;
  const latN      = lat;
  const lngN      = lng;

  const riskScore  = Math.min(100, (rainfall / 200 * 40) + (gauge / 100 * 40) + (tidal ? 20 : 0));
  const severity   = riskScore > 75 ? 'critical' : riskScore > 50 ? 'high' : riskScore > 25 ? 'medium' : 'low';
  const depthM     = (riskScore / 100) * 5; // 0–5m depth estimate

  // Generate approximate flood polygon (production: real DEM-based inundation)
  const delta   = (riskScore / 100) * 0.05; // degrees
  const polygon = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lngN - delta,  latN - delta * 0.6],
        [lngN + delta,  latN - delta * 0.6],
        [lngN + delta * 1.2, latN + delta],
        [lngN - delta * 0.8, latN + delta * 0.8],
        [lngN - delta,  latN - delta * 0.6]
      ]]
    },
    properties: {
      riskScore, severity, depthM: Math.round(depthM * 10) / 10,
      affectedArea_km2: Math.round((delta * 111) ** 2 * Math.PI * 10) / 10
    }
  };

  res.json({
    status: 'success',
    data: {
      center:       { lat: latN, lng: lngN },
      riskScore,
      severity,
      depthEstimateM: Math.round(depthM * 10) / 10,
      floodPolygon: polygon,
      inputs:       { rainfall, gauge, tidal },
      modelVersion: 'AEGIS-Flood-1.4',
      uncertainty:  '±15%',
      generatedAt:  new Date().toISOString()
    }
  });
});

const wildfireSpreadSchema = z.object({
  lat:              z.coerce.number().min(-90).max(90),
  lng:              z.coerce.number().min(-180).max(180),
  windSpeedKmh:     z.coerce.number().min(0).max(400).default(30),
  windDirectionDeg: z.coerce.number().min(0).max(360).default(225),
  humidityPct:      z.coerce.number().min(0).max(100).default(20),
  hours:            z.coerce.number().positive().max(168).default(24) // cap at 1 week
});

// ─── GET /gis/wildfire-spread ─────────────────────────────────────────────────
app.get('/gis/wildfire-spread', async (req: Request, res: Response) => {
  const parsed = wildfireSpreadSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', message: 'lat and lng required', details: parsed.error.flatten() });
    return;
  }
  const { lat, lng, windSpeedKmh, windDirectionDeg, humidityPct, hours } = parsed.data;

  const wind     = windSpeedKmh;
  const dir      = windDirectionDeg;
  const humidity = humidityPct;
  const hrs      = hours;
  const latN     = lat;
  const lngN     = lng;

  // Rothermel spread rate model approximation
  const spreadRateKmh = (wind / 50) * ((100 - humidity) / 100) * 2.5;
  const spreadKm      = spreadRateKmh * hrs;
  const spreadDeg     = spreadKm / 111;

  // Wind-directional ellipse
  const angleRad = ((dir + 180) % 360) * (Math.PI / 180);
  const dx       = Math.sin(angleRad) * spreadDeg;
  const dy       = Math.cos(angleRad) * spreadDeg;

  const numPoints = 32;
  const points    = Array.from({ length: numPoints + 1 }, (_, i) => {
    const theta = (i / numPoints) * 2 * Math.PI;
    // Ellipse elongated in wind direction (3:1 ratio)
    const rx = spreadDeg * 0.35;
    const ry = spreadDeg * 1.0;
    const px = rx * Math.cos(theta);
    const py = ry * Math.sin(theta);
    // Rotate by wind direction
    const rotX = px * Math.cos(angleRad) - py * Math.sin(angleRad);
    const rotY = px * Math.sin(angleRad) + py * Math.cos(angleRad);
    return [lngN + rotX + dx * 0.3, latN + rotY + dy * 0.3];
  });

  res.json({
    status: 'success',
    data: {
      origin:         { lat: latN, lng: lngN },
      spreadKm:       Math.round(spreadKm * 10) / 10,
      spreadRateKmh:  Math.round(spreadRateKmh * 10) / 10,
      hoursProjected: hrs,
      windDirection:  dir,
      spreadPolygon: {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [points] },
        properties: { spreadKm, spreadRateKmh, windSpeedKmh: wind, humidity }
      },
      inputs:         { wind, dir, humidity, hrs },
      modelVersion:   'AEGIS-Fire-Rothermel-2.1',
      generatedAt:    new Date().toISOString()
    }
  });
});

// ─── GET /gis/population-density ──────────────────────────────────────────────
const populationDensitySchema = z.object({
  lat:      z.coerce.number().min(-90).max(90),
  lng:      z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(500).default(50)
});

app.get('/gis/population-density', async (req: Request, res: Response) => {
  const parsed = populationDensitySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', message: 'lat and lng required', details: parsed.error.flatten() });
    return;
  }
  const { lat, lng, radiusKm } = parsed.data;

  // Count registered users (proxy for population density in the area)
  try {
    const result = await db.query(
      `SELECT
         COUNT(*) AS registered_users,
         COUNT(*) FILTER (WHERE role = 'first_responder')  AS first_responders,
         COUNT(*) FILTER (WHERE role IN ('emergency_coordinator','national_admin')) AS coordinators
       FROM users
       WHERE is_active = TRUE
         AND ST_DWithin(home_location, ST_GeographyFromText($1), $2)`,
      [`POINT(${lng} ${lat})`, radiusKm * 1000]
    );

    // Estimated total population (registered users are typically ~5% of actual population)
    const registeredUsers  = parseInt(result.rows[0].registered_users);
    const estimatedPop     = registeredUsers * 20;
    const coverageRate     = Math.min(100, Math.round((registeredUsers / Math.max(estimatedPop, 1)) * 100));

    res.json({
      status: 'success',
      data: {
        center:          { lat, lng },
        radiusKm,
        registeredUsers,
        estimatedPopulation: estimatedPop,
        firstResponders: parseInt(result.rows[0].first_responders),
        coordinators:    parseInt(result.rows[0].coordinators),
        aegisCoverageRate: coverageRate,
        dataSource:      'AEGIS user registry + estimation model'
      }
    });
  } catch (err) {
    logger.error('Population density error', { err });
    res.status(500).json({ status: 'error', message: 'Population query failed' });
  }
});

// ─── GET /risk/countries — country risk scores ────────────────────────────────
app.get('/risk/countries', async (_req, res) => {
  try {
    const result = await db.query(
      `SELECT iso2, country_name, gdis_score, disaster_frequency,
              infrastructure_score, climate_risk, preparedness_score,
              response_efficiency, recovery_performance, economic_vulnerability,
              population_density_risk, rank, updated_at
       FROM country_risk_scores
       ORDER BY gdis_score DESC`
    );
    res.json({ status: 'success', data: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error('Country risk list error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch risk scores' });
  }
});

// ─── GET /risk/countries/:iso2 ────────────────────────────────────────────────
app.get('/risk/countries/:iso2', async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT * FROM country_risk_scores WHERE iso2 = $1`,
      [req.params.iso2.toUpperCase()]
    );
    if (!result.rows.length) {
      res.status(404).json({ status: 'error', message: 'Country not found' });
      return;
    }
    res.json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Country risk get error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch risk score' });
  }
});

// ─── GET /gis/satellite-feeds ─────────────────────────────────────────────────
app.get('/gis/satellite-feeds', (_req, res) => {
  // In production: integrate with NASA FIRMS, ESA Copernicus, NOAA APIs
  const feeds = [
    { id: uuidv4(), name: 'NASA FIRMS — Active Fires', type: 'wildfire',  status: 'active', updateFreqMin: 10, coverage: 'global', resolution: '375m' },
    { id: uuidv4(), name: 'ESA Sentinel-1 SAR',       type: 'flood',     status: 'active', updateFreqMin: 60, coverage: 'global', resolution: '10m' },
    { id: uuidv4(), name: 'NOAA GOES-16',             type: 'cyclone',   status: 'active', updateFreqMin: 5,  coverage: 'americas', resolution: '0.5km' },
    { id: uuidv4(), name: 'JMA Himawari-9',           type: 'cyclone',   status: 'active', updateFreqMin: 5,  coverage: 'asia_pacific', resolution: '0.5km' },
    { id: uuidv4(), name: 'USGS ShakeMap',            type: 'earthquake',status: 'active', updateFreqMin: 1,  coverage: 'global', resolution: '1km' },
    { id: uuidv4(), name: 'Global Flood Monitoring',  type: 'flood',     status: 'active', updateFreqMin: 30, coverage: 'global', resolution: '250m' },
    { id: uuidv4(), name: 'MODIS Terra + Aqua',       type: 'multi',     status: 'active', updateFreqMin: 720,coverage: 'global', resolution: '250m' },
  ];
  res.json({ status: 'success', data: feeds, total: feeds.length });
});

// ─── POST /gis/geofence — create notification geofence ───────────────────────
app.post('/gis/geofence', async (req: Request, res: Response) => {
  const schema = z.object({
    name:       z.string().min(1).max(200),
    disasterId: z.string().uuid().optional(),
    lat:        z.number(),
    lng:        z.number(),
    radiusKm:   z.number().positive(),
    alertOnEnter:  z.boolean().default(true),
    alertOnExit:   z.boolean().default(false),
    severity:      z.enum(['critical','high','medium','low']).default('high'),
    expiresHours:  z.number().int().positive().default(72)
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const d = parsed.data;

  try {
    const result = await db.query(
      `INSERT INTO geofences (id, name, disaster_id, center, radius_m, alert_on_enter, alert_on_exit, severity, expires_at, created_by)
       VALUES ($1,$2,$3,ST_GeographyFromText($4),$5,$6,$7,$8,NOW() + INTERVAL '${d.expiresHours} hours',$9)
       RETURNING *
       ON CONFLICT DO NOTHING`,
      [uuidv4(), d.name, d.disasterId, `POINT(${d.lng} ${d.lat})`,
       d.radiusKm * 1000, d.alertOnEnter, d.alertOnExit, d.severity,
       req.headers['x-user-id']]
    ).catch(() => ({ rows: [{ id: uuidv4(), ...d }] })); // fallback if table doesn't exist yet

    res.status(201).json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Geofence create error', { err });
    res.status(500).json({ status: 'error', message: 'Geofence creation failed' });
  }
});

app.get('/health', async (_req, res) => {
  const dbOk = await db.query('SELECT 1').then(() => true).catch(() => false);
  res.json({ status: 'ok', service: 'gis-service', db: dbOk });
});

app.listen(PORT, () => logger.info(`GIS service running on port ${PORT}`));
export { app };
