// ─── AEGIS GLOBAL — Alert Service ────────────────────────────────────────────
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { Pool } from 'pg';
import { Kafka, Producer } from 'kafkajs';
import { createClient } from 'redis';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';
import { runGdacsIngestion } from './ingestion.js';

const app  = express();
const PORT = process.env.PORT || 4002;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'alert-service' },
  transports: [new winston.transports.Console()]
});

const db    = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const redis = createClient({ url: process.env.REDIS_URL });
redis.connect().catch(err => logger.error('Redis failed', { err }));

// ─── Runtime migration ─────────────────────────────────────────────────────────
// Adds columns needed for external feed ingestion (GDACS). Safe to run on every
// boot — IF NOT EXISTS makes it a no-op once applied. Needed because existing
// databases were created before this feature and won't re-run init.sql.
async function runMigrations() {
  try {
    await db.query(`ALTER TABLE disasters ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'manual'`);
    await db.query(`ALTER TABLE disasters ADD COLUMN IF NOT EXISTS external_id VARCHAR(200)`);
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_disasters_source_external
       ON disasters(source, external_id) WHERE external_id IS NOT NULL`
    );
    logger.info('Migrations applied');
  } catch (err) {
    logger.error('Migration failed', { err });
  }
}

// ─── Kafka setup ──────────────────────────────────────────────────────────────
const kafka = new Kafka({
  clientId: 'alert-service',
  brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',')
});
let producer: Producer;

async function initKafka() {
  producer = kafka.producer({ allowAutoTopicCreation: true });
  await producer.connect();
  logger.info('Kafka producer connected');
}
initKafka().catch(err => logger.error('Kafka init failed', { err }));

// ─── Live disaster feed ingestion (GDACS) ──────────────────────────────────────
// Runs once on boot (after a short delay to let migrations/Kafka settle) and
// then every 10 minutes. Also triggerable on demand via POST /disasters/ingest/gdacs.
const GDACS_INTERVAL_MS = 10 * 60 * 1000;

async function startIngestionSchedule() {
  await runMigrations();
  setTimeout(() => {
    runGdacsIngestion(db, publishEvent, logger).catch((err: unknown) => logger.error('Initial GDACS ingestion failed', { err }));
    setInterval(() => {
      runGdacsIngestion(db, publishEvent, logger).catch((err: unknown) => logger.error('Scheduled GDACS ingestion failed', { err }));
    }, GDACS_INTERVAL_MS);
  }, 5000);
}
startIngestionSchedule();

async function publishEvent(topic: string, key: string, value: unknown) {
  try {
    await producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(value) }]
    });
  } catch (err) {
    logger.error('Kafka publish failed', { topic, err });
  }
}

app.use(express.json());

// ─── Validation ───────────────────────────────────────────────────────────────
const DisasterCreateSchema = z.object({
  name:           z.string().min(1).max(500),
  type:           z.string(),
  severity:       z.enum(['critical','high','medium','low','monitoring']).default('medium'),
  country:        z.string().optional(),
  iso2:           z.string().length(2).optional(),
  region:         z.string().optional(),
  lat:            z.number().min(-90).max(90).optional(),
  lng:            z.number().min(-180).max(180).optional(),
  deaths:         z.number().int().min(0).default(0),
  injured:        z.number().int().min(0).default(0),
  missing:        z.number().int().min(0).default(0),
  affected:       z.number().int().min(0).default(0),
  displaced:      z.number().int().min(0).default(0),
  economicLoss:   z.number().min(0).default(0),
  magnitude:      z.number().optional(),
  startedAt:      z.string().datetime().optional(),
  metadata:       z.record(z.unknown()).default({})
});

const AlertCreateSchema = z.object({
  disasterId: z.string().uuid().optional(),
  title:      z.string().min(1).max(500),
  message:    z.string().min(1).max(5000),
  severity:   z.enum(['critical','high','medium','low','monitoring']),
  category:   z.string().optional(),
  lat:        z.number().optional(),
  lng:        z.number().optional(),
  radiusKm:   z.number().positive().optional(),
  languages:  z.array(z.string()).default(['en']),
  channels:   z.array(z.string()).default(['push']),
  expiresAt:  z.string().datetime().optional()
});

// ─── DISASTERS ────────────────────────────────────────────────────────────────

// GET /disasters — list with filtering
const DISASTER_SORT_COLUMNS = new Set([
  'started_at', 'ended_at', 'deaths', 'injured', 'affected', 'displaced',
  'economic_loss_usd', 'magnitude', 'severity', 'created_at', 'updated_at'
]);

app.get('/disasters', async (req: Request, res: Response) => {
  const { type, severity, status, country, lat, lng, radiusKm,
          limit = '20', page = '1', sortBy = 'started_at', sortOrder = 'desc' } = req.query;
  const cappedLimit = Math.min(parseInt(limit as string) || 20, 100);
  const safePage     = Math.max(parseInt(page as string) || 1, 1);

  try {
    const conditions: string[] = [];
    const params: unknown[]    = [];
    let pi = 1;

    if (type)     { conditions.push(`type = $${pi++}`);     params.push(type); }
    if (severity) { conditions.push(`severity = $${pi++}`); params.push(severity); }
    if (status)   { conditions.push(`status = $${pi++}`);   params.push(status); }
    if (country)  { conditions.push(`(country ILIKE $${pi++} OR iso2 = $${pi++})`); params.push(`%${country}%`); params.push(country); pi++; }

    // Geospatial radius filter
    if (lat && lng && radiusKm) {
      conditions.push(`ST_DWithin(coordinates, ST_GeographyFromText($${pi}), $${pi+1})`);
      params.push(`POINT(${lng} ${lat})`);
      params.push(Number(radiusKm) * 1000); // convert to metres
      pi += 2;
    }

    const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (safePage - 1) * cappedLimit;
    // sortBy is a raw query param — SQL identifiers can't be parameterized with
    // $-placeholders (those only bind values), so this MUST be checked against
    // a fixed whitelist rather than interpolated directly. Without this, this
    // endpoint (including its public, unauthenticated variant) would be a
    // straightforward SQL injection vector via ?sortBy=.
    const safeSortBy = DISASTER_SORT_COLUMNS.has(sortBy as string) ? sortBy : 'started_at';
    const order  = `ORDER BY ${safeSortBy} ${sortOrder === 'asc' ? 'ASC' : 'DESC'}`;

    const [result, countResult] = await Promise.all([
      db.query(
        `SELECT id, name, type, severity, status, country, iso2, region,
                ST_AsGeoJSON(coordinates)::json AS coordinates,
                ST_AsGeoJSON(affected_area)::json AS affected_area,
                started_at, ended_at, deaths, injured, missing,
                affected, displaced, economic_loss_usd, magnitude,
                depth_km, wind_speed_kmh, metadata, created_at, updated_at
         FROM disasters ${where} ${order}
         LIMIT $${pi} OFFSET $${pi+1}`,
        [...params, cappedLimit, offset]
      ),
      db.query(`SELECT COUNT(*) FROM disasters ${where}`, params)
    ]);

    res.json({
      status:  'success',
      data:    result.rows,
      total:   parseInt(countResult.rows[0].count),
      page:    safePage,
      limit:   cappedLimit,
      hasMore: offset + result.rows.length < parseInt(countResult.rows[0].count)
    });
  } catch (err) {
    logger.error('List disasters error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch disasters' });
  }
});

// GET /disasters/public — read-only, no-auth summary for a general-audience
// view (e.g. an unauthenticated "what's happening in the world" page). Capped
// page size and limited to active disasters; same field set as the
// authenticated list since none of it is sensitive (no user IDs are exposed).
// Public endpoints have no auth to fall back on for abuse protection, so they
// get an explicit rate limit — generous enough for genuine dashboard use
// (auto-refresh every ~30-60s) but enough to blunt scraping/hammering.
const publicReadLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

app.get('/disasters/public', publicReadLimiter, async (req: Request, res: Response) => {
  const { type, limit = '50' } = req.query;
  const cappedLimit = Math.min(parseInt(limit as string) || 50, 100);

  try {
    const conditions = [`status = 'active'`];
    const params: unknown[] = [];
    if (type) { conditions.push(`type = $1`); params.push(type); }

    const result = await db.query(
      `SELECT id, name, type, severity, country, iso2, region,
              ST_AsGeoJSON(coordinates)::json AS coordinates,
              started_at, deaths, injured, affected, magnitude, depth_km
       FROM disasters WHERE ${conditions.join(' AND ')}
       ORDER BY started_at DESC LIMIT $${params.length + 1}`,
      [...params, cappedLimit]
    );
    res.json({ status: 'success', data: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error('Public disasters list error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch disasters' });
  }
});

// GET /disasters/:id
app.get('/disasters/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  // Try cache
  const cacheKey = `disaster:${id}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    res.json({ status: 'success', data: JSON.parse(cached), cached: true });
    return;
  }

  try {
    const result = await db.query(
      `SELECT d.*,
              ST_AsGeoJSON(d.coordinates)::json AS coordinates,
              ST_AsGeoJSON(d.affected_area)::json AS affected_area,
              COALESCE(json_agg(DISTINCT a.*) FILTER (WHERE a.id IS NOT NULL), '[]') AS alerts,
              COALESCE(json_agg(DISTINCT s.*) FILTER (WHERE s.id IS NOT NULL), '[]') AS shelters
       FROM disasters d
       LEFT JOIN alerts a ON a.disaster_id = d.id
       LEFT JOIN shelters s ON s.disaster_id = d.id
       WHERE d.id = $1
       GROUP BY d.id`,
      [id]
    );

    if (!result.rows.length) {
      res.status(404).json({ status: 'error', message: 'Disaster not found' });
      return;
    }

    const disaster = result.rows[0];
    await redis.setEx(cacheKey, 30, JSON.stringify(disaster)); // Cache 30s

    res.json({ status: 'success', data: disaster });
  } catch (err) {
    logger.error('Get disaster error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch disaster' });
  }
});

// POST /disasters
app.post('/disasters', async (req: Request, res: Response) => {
  const parsed = DisasterCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const userId = req.headers['x-user-id'] as string;
  const role   = req.headers['x-user-role'] as string;

  if (!['global_admin','national_admin','regional_admin','emergency_coordinator'].includes(role)) {
    res.status(403).json({ status: 'error', message: 'Insufficient permissions to create disasters' });
    return;
  }

  const d = parsed.data;

  try {
    const coordsSql = d.lat && d.lng
      ? `ST_GeographyFromText('POINT(${d.lng} ${d.lat})')`
      : 'NULL';

    const result = await db.query(
      `WITH inserted AS (
         INSERT INTO disasters (
           id, name, type, severity, status, country, iso2, region,
           coordinates, deaths, injured, missing, affected, displaced,
           economic_loss_usd, magnitude, started_at, metadata, created_by
         ) VALUES (
           $1,$2,$3,$4,'active',$5,$6,$7,
           ${coordsSql},$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
         ) RETURNING *
       )
       SELECT inserted.*,
              ST_AsGeoJSON(inserted.coordinates)::json AS coordinates
       FROM inserted`,
      [
        uuidv4(), d.name, d.type, d.severity, d.country, d.iso2, d.region,
        d.deaths, d.injured, d.missing, d.affected, d.displaced,
        d.economicLoss, d.magnitude, d.startedAt || new Date().toISOString(),
        JSON.stringify(d.metadata), userId
      ]
    );

    const disaster = result.rows[0];

    // Publish Kafka event
    await publishEvent('disaster.created', disaster.id, {
      eventId: uuidv4(), eventType: 'disaster.created',
      timestamp: new Date().toISOString(), source: 'alert-service',
      payload: disaster
    });

    // Invalidate list cache
    await redis.del('disasters:list');

    logger.info('Disaster created', { disasterId: disaster.id, name: d.name, type: d.type });

    res.status(201).json({ status: 'success', data: disaster });
  } catch (err) {
    logger.error('Create disaster error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to create disaster' });
  }
});

// PATCH /disasters/:id
app.patch('/disasters/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const role   = req.headers['x-user-role'] as string;

  if (!['global_admin','national_admin','regional_admin','emergency_coordinator'].includes(role)) {
    res.status(403).json({ status: 'error', message: 'Insufficient permissions' });
    return;
  }

  const allowedFields = ['severity','status','deaths','injured','missing','affected','displaced',
                         'economic_loss_usd','metadata','ended_at'];
  const updates: string[] = [];
  const params: unknown[] = [];
  let pi = 1;

  Object.entries(req.body).forEach(([k, v]) => {
    const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (allowedFields.includes(col)) {
      updates.push(`${col} = $${pi++}`);
      params.push(typeof v === 'object' ? JSON.stringify(v) : v);
    }
  });

  if (!updates.length) {
    res.status(400).json({ status: 'error', message: 'No valid fields to update' });
    return;
  }

  updates.push(`updated_at = NOW()`);
  params.push(id);

  try {
    const result = await db.query(
      `UPDATE disasters SET ${updates.join(', ')} WHERE id = $${pi} RETURNING *`,
      params
    );

    if (!result.rows.length) {
      res.status(404).json({ status: 'error', message: 'Disaster not found' });
      return;
    }

    await redis.del(`disaster:${id}`);

    await publishEvent('disaster.updated', id, {
      eventId: uuidv4(), eventType: 'disaster.updated',
      timestamp: new Date().toISOString(), source: 'alert-service',
      payload: result.rows[0]
    });

    res.json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Update disaster error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to update disaster' });
  }
});

// ─── ALERTS ───────────────────────────────────────────────────────────────────

// GET /alerts
app.get('/alerts', async (req: Request, res: Response) => {
  const { disasterId, severity, limit = '50', page = '1' } = req.query;

  const conditions: string[] = [];
  const params: unknown[]    = [];
  let pi = 1;

  if (disasterId) { conditions.push(`disaster_id = $${pi++}`); params.push(disasterId); }
  if (severity)   { conditions.push(`severity = $${pi++}`);    params.push(severity); }

  const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

  try {
    const result = await db.query(
      `SELECT id, disaster_id, title, message, severity, category,
              ST_AsGeoJSON(geo_center)::json AS geo_center,
              channels, languages, recipients_targeted, recipients_delivered,
              delivery_rate, issued_at, expires_at
       FROM alerts ${where}
       ORDER BY issued_at DESC
       LIMIT $${pi} OFFSET $${pi+1}`,
      [...params, parseInt(limit as string), offset]
    );

    res.json({ status: 'success', data: result.rows });
  } catch (err) {
    logger.error('List alerts error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch alerts' });
  }
});

// GET /alerts/public — read-only, no-auth, capped, most-recent-first. Same
// field set as the authenticated list (no issuer identity is exposed there
// either), just without recipient delivery stats which aren't public-facing.
app.get('/alerts/public', publicReadLimiter, async (req: Request, res: Response) => {
  const { limit = '50' } = req.query;
  const cappedLimit = Math.min(parseInt(limit as string) || 50, 100);

  try {
    const result = await db.query(
      `SELECT id, disaster_id, title, message, severity, category,
              ST_AsGeoJSON(geo_center)::json AS geo_center,
              channels, languages, issued_at, expires_at
       FROM alerts
       WHERE expires_at IS NULL OR expires_at > NOW()
       ORDER BY issued_at DESC LIMIT $1`,
      [cappedLimit]
    );
    res.json({ status: 'success', data: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error('Public alerts list error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch alerts' });
  }
});

// POST /alerts
app.post('/alerts', async (req: Request, res: Response) => {
  const parsed = AlertCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const role   = req.headers['x-user-role'] as string;
  const userId = req.headers['x-user-id'] as string;

  if (!['global_admin','national_admin','regional_admin','emergency_coordinator'].includes(role)) {
    res.status(403).json({ status: 'error', message: 'Insufficient permissions to issue alerts' });
    return;
  }

  const a = parsed.data;

  try {
    const coordsSql = a.lat && a.lng
      ? `ST_GeographyFromText('POINT(${a.lng} ${a.lat})')`
      : 'NULL';

    const result = await db.query(
      `INSERT INTO alerts (
         id, disaster_id, title, message, severity, category,
         geo_center, radius_km, languages, channels, issued_by, expires_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,${coordsSql},$7,$8,$9,$10,$11
       ) RETURNING *`,
      [
        uuidv4(), a.disasterId, a.title, a.message, a.severity, a.category,
        a.radiusKm, a.languages, a.channels,
        userId, a.expiresAt
      ]
    );

    const alert = result.rows[0];

    // Publish for notification service to pick up
    await publishEvent('alert.issued', alert.id, {
      eventId: uuidv4(), eventType: 'alert.issued',
      timestamp: new Date().toISOString(), source: 'alert-service',
      payload: { ...alert, channels: a.channels, languages: a.languages }
    });

    logger.info('Alert issued', { alertId: alert.id, severity: a.severity, disasterId: a.disasterId });

    res.status(201).json({ status: 'success', data: alert });
  } catch (err) {
    logger.error('Create alert error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to issue alert' });
  }
});

// GET /shelters — included in alert service for co-location
app.get('/shelters', async (req: Request, res: Response) => {
  const { disasterId, status, lat, lng, radiusKm, limit = '20' } = req.query;

  const conditions: string[] = [];
  const params: unknown[]    = [];
  let pi = 1;

  if (disasterId) { conditions.push(`disaster_id = $${pi++}`); params.push(disasterId); }
  if (status)     { conditions.push(`status = $${pi++}`);      params.push(status); }
  if (lat && lng && radiusKm) {
    conditions.push(`ST_DWithin(location, ST_GeographyFromText($${pi}), $${pi+1})`);
    params.push(`POINT(${lng} ${lat})`);
    params.push(Number(radiusKm) * 1000);
    pi += 2;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT id, name, ST_AsGeoJSON(location)::json AS location, address,
              capacity_total, occupancy_current, medical_unit,
              food_days_remaining, water_days_remaining, status, opened_at
       FROM shelters ${where}
       ORDER BY opened_at DESC
       LIMIT $${pi}`,
      [...params, parseInt(limit as string)]
    );

    res.json({ status: 'success', data: result.rows });
  } catch (err) {
    logger.error('List shelters error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch shelters' });
  }
});

app.get('/health', async (_req, res) => {
  const dbOk = await db.query('SELECT 1').then(() => true).catch(() => false);
  res.json({ status: 'ok', service: 'alert-service', db: dbOk });
});

// POST /disasters/ingest/gdacs — trigger a live GDACS feed pull on demand
// (in addition to the automatic 10-minute schedule). Useful for demos.
app.post('/disasters/ingest/gdacs', async (req: Request, res: Response) => {
  const role = req.headers['x-user-role'] as string;
  if (!['global_admin', 'national_admin', 'regional_admin', 'emergency_coordinator'].includes(role)) {
    res.status(403).json({ status: 'error', message: 'Insufficient permissions' });
    return;
  }
  try {
    const result = await runGdacsIngestion(db, publishEvent, logger);
    await redis.del('disasters:list');
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('Manual GDACS ingestion error', { err });
    res.status(500).json({ status: 'error', message: 'Ingestion failed' });
  }
});

app.listen(PORT, () => logger.info(`Alert service running on port ${PORT}`));

export { app };
