// ─── AEGIS GLOBAL — SOS Service ──────────────────────────────────────────────
import express, { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { Pool } from 'pg';
import { Kafka, Producer, Consumer } from 'kafkajs';
import { createClient } from 'redis';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import winston from 'winston';

const app  = express();
const PORT = process.env.PORT || 4005;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'sos-service' },
  transports: [new winston.transports.Console()]
});

const db    = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const redis = createClient({ url: process.env.REDIS_URL });
redis.connect().catch(err => logger.error('Redis failed', { err }));

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://localhost:4009';

// ─── Kafka ────────────────────────────────────────────────────────────────────
const kafka    = new Kafka({ clientId: 'sos-service', brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',') });
let producer: Producer;
let consumer: Consumer;

async function initKafka(attempt = 1, maxAttempts = 10): Promise<void> {
  try {
    producer = kafka.producer();
    consumer = kafka.consumer({ groupId: 'sos-service-group' });
    await producer.connect();
    await consumer.connect();
    await consumer.subscribe({ topic: 'disaster.created', fromBeginning: false });
    await consumer.subscribe({ topic: 'disaster.updated', fromBeginning: false });

    await consumer.run({
      eachMessage: async ({ topic, message }) => {
        try {
          const event = JSON.parse(message.value?.toString() || '{}');
          if (topic === 'disaster.created' || topic === 'disaster.updated') {
            // Link any unassigned SOS reports in the affected area
            await linkSOSToDisaster(event.payload);
          }
        } catch (err) {
          logger.error('Kafka message error', { err });
        }
      }
    });

    logger.info('Kafka connected');
  } catch (err) {
    // A brand-new topic can briefly return UNKNOWN_TOPIC_OR_PARTITION on
    // subscribe before broker-side auto-creation has propagated -- retry
    // instead of giving up permanently on the very first attempt.
    const delayMs = Math.min(3000 * attempt, 15000);
    logger.error('Kafka init failed, retrying', {
      attempt, maxAttempts, delayMs,
      err: err instanceof Error ? err.message : String(err)
    });
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, delayMs));
      return initKafka(attempt + 1, maxAttempts);
    }
    logger.error(`Kafka init gave up after ${maxAttempts} attempts -- SOS/disaster linking will not work until this service is restarted`);
  }
}
initKafka();

async function linkSOSToDisaster(disaster: any) {
  if (!disaster?.id || !disaster?.coordinates) return;
  try {
    await db.query(
      `UPDATE sos_reports
       SET disaster_id = $1
       WHERE disaster_id IS NULL
         AND created_at > NOW() - INTERVAL '24 hours'
         AND ST_DWithin(location, ST_GeographyFromText($2), 50000)`,
      [disaster.id, `POINT(${disaster.coordinates.coordinates[0]} ${disaster.coordinates.coordinates[1]})`]
    );
  } catch (err) {
    logger.error('Link SOS to disaster failed', { err });
  }
}

app.use(express.json({ limit: '10mb' }));

// ─── Validation schemas ───────────────────────────────────────────────────────
const SOSCreateSchema = z.object({
  type:         z.enum([
    'trapped_rubble','stranded_flood','medical_emergency','missing_person',
    'hazard_observed','need_evacuation','resource_request','one_click_sos','other'
  ]),
  lat:          z.number().min(-90).max(90),
  lng:          z.number().min(-180).max(180),
  address:      z.string().max(500).optional(),
  peopleCount:  z.number().int().positive().max(1000).default(1),
  description:  z.string().max(2000).optional(),
  contactPhone: z.string().max(50).optional(),
  mediaUrls:    z.array(z.string().url()).max(5).default([]),
  isAnonymous:  z.boolean().default(false)
});

const SOSUpdateSchema = z.object({
  status:         z.enum(['pending','acknowledged','dispatched','resolved','false_alarm']).optional(),
  assignedTeamId: z.string().uuid().optional(),
  notes:          z.string().max(1000).optional()
});

// ─── AI triage call ───────────────────────────────────────────────────────────
async function callAITriage(sosData: z.infer<typeof SOSCreateSchema>): Promise<{
  severity: string; confidenceScore: number; immediateActions: string[];
  recommendedTeam: string; safetyGuidance: string; triageNarrative: string;
}> {
  try {
    const response = await fetch(`${AI_SERVICE_URL}/ai/triage/sos`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type:        sosData.type,
        description: sosData.description || '',
        location:    { lat: sosData.lat, lng: sosData.lng },
        peopleCount: sosData.peopleCount
      }),
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) throw new Error(`AI triage failed: ${response.status}`);
    const result = await response.json() as any;
    return result.data?.triage || defaultTriage(sosData);
  } catch (err) {
    logger.warn('AI triage unavailable, using default', { err });
    return defaultTriage(sosData);
  }
}

function defaultTriage(sosData: z.infer<typeof SOSCreateSchema>) {
  const criticalTypes = ['trapped_rubble', 'medical_emergency', 'one_click_sos'];
  const severity      = criticalTypes.includes(sosData.type) ? 'critical' : 'high';
  return {
    severity,
    confidenceScore: 0.6,
    immediateActions: ['Dispatch nearest response team', 'Attempt phone contact', 'Share GPS with responders'],
    recommendedTeam:  'Emergency response unit',
    safetyGuidance:   'Stay in place if safe. Signal rescuers with bright cloth or whistle.',
    triageNarrative:  `${sosData.type.replace('_', ' ')} report with ${sosData.peopleCount} person(s) affected. Auto-triaged as ${severity} priority.`
  };
}

// ─── Find nearest disaster ────────────────────────────────────────────────────
async function findNearestDisaster(lat: number, lng: number): Promise<string | null> {
  try {
    const result = await db.query(
      `SELECT id FROM disasters
       WHERE status = 'active'
         AND ST_DWithin(coordinates, ST_GeographyFromText($1), 100000)
       ORDER BY ST_Distance(coordinates, ST_GeographyFromText($1)) ASC
       LIMIT 1`,
      [`POINT(${lng} ${lat})`]
    );
    return result.rows[0]?.id || null;
  } catch {
    return null;
  }
}

// ─── POST /sos — submit SOS report ───────────────────────────────────────────
// Defense-in-depth: this service is also directly exposed on its own host
// port in docker-compose, so it can be reached bypassing the gateway (where
// the real per-client rate limit lives, since only the gateway sees actual
// client IPs). This is a coarser backstop, not the primary defense.
const sosCreateLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

app.post('/sos', sosCreateLimiter, async (req: Request, res: Response) => {
  const parsed = SOSCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const userId = req.headers['x-user-id'] as string;
  const sos    = parsed.data;

  try {
    // AI triage + disaster linking in parallel
    const [triage, disasterId] = await Promise.all([
      callAITriage(sos),
      findNearestDisaster(sos.lat, sos.lng)
    ]);

    const id = uuidv4();

    await db.query(
      `INSERT INTO sos_reports (
         id, user_id, disaster_id, type, location, address, people_count,
         description, status, ai_severity, ai_confidence, ai_analysis,
         media_urls, contact_phone, is_anonymous, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,
         ST_GeographyFromText($5),
         $6,$7,$8,'pending',$9,$10,$11,$12,$13,$14,NOW(),NOW()
       )`,
      [
        id,
        sos.isAnonymous ? null : (userId || null),
        disasterId,
        sos.type,
        `POINT(${sos.lng} ${sos.lat})`,
        sos.address, sos.peopleCount, sos.description,
        triage.severity, triage.confidenceScore,
        triage.triageNarrative,
        sos.mediaUrls,
        sos.contactPhone, sos.isAnonymous
      ]
    );

    // Track in Redis for real-time dashboard
    const redisKey = `sos:active:${id}`;
    await redis.setEx(redisKey, 3600, JSON.stringify({
      id, lat: sos.lat, lng: sos.lng, severity: triage.severity,
      type: sos.type, peopleCount: sos.peopleCount, status: 'pending'
    }));

    // Publish Kafka event. This is a best-effort notification for downstream
    // consumers (dashboards, notification-service) — it must NEVER be allowed
    // to fail the request. The actual emergency report was already durably
    // written to Postgres and Redis above; if we let a broker hiccup here
    // turn into a 500, a citizen in danger would see "failed to submit" for
    // a report that in fact went through, and could give up resubmitting.
    try {
      await producer.send({
        topic: 'sos.created',
        messages: [{
          key: id,
          value: JSON.stringify({
            eventId: uuidv4(), eventType: 'sos.created',
            timestamp: new Date().toISOString(), source: 'sos-service',
            payload: {
              id, type: sos.type, severity: triage.severity, lat: sos.lat, lng: sos.lng,
              peopleCount: sos.peopleCount, disasterId, contactPhone: sos.contactPhone
            }
          })
        }]
      });
    } catch (err) {
      logger.warn('SOS created but Kafka publish failed — report is saved, event notification was skipped', {
        sosId: id, err: err instanceof Error ? err.message : String(err)
      });
    }

    logger.info('SOS created', { sosId: id, type: sos.type, severity: triage.severity, disasterId });

    res.status(201).json({
      status: 'success',
      data: {
        sosId:          id,
        status:         'pending',
        aiSeverity:     triage.severity,
        aiConfidence:   triage.confidenceScore,
        immediateActions: triage.immediateActions,
        safetyGuidance: triage.safetyGuidance,
        recommendedTeam:triage.recommendedTeam,
        trackingUrl:    `https://aegisglobal.io/track/${id}`,
        disasterId
      }
    });
  } catch (err) {
    logger.error('SOS creation error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to submit SOS report' });
  }
});

// GET /sos/reports — list with filters
app.get('/sos/reports', async (req: Request, res: Response) => {
  const { status, severity, disasterId, lat, lng, radiusKm, limit = '50', page = '1' } = req.query;
  const role   = req.headers['x-user-role'] as string;
  const userId = req.headers['x-user-id'] as string;
  const cappedLimit = Math.min(parseInt(limit as string) || 50, 100);
  const safePage     = Math.max(parseInt(page as string) || 1, 1);

  const conditions: string[] = [];
  const params: unknown[]    = [];
  let pi = 1;

  // Citizens can only see their own (non-anonymous) reports
  if (role === 'citizen') {
    conditions.push(`user_id = $${pi++} AND is_anonymous = FALSE`);
    params.push(userId);
  }

  if (status)     { conditions.push(`status = $${pi++}`);      params.push(status); }
  if (severity)   { conditions.push(`ai_severity = $${pi++}`); params.push(severity); }
  if (disasterId) { conditions.push(`disaster_id = $${pi++}`); params.push(disasterId); }

  if (lat && lng && radiusKm) {
    conditions.push(`ST_DWithin(location, ST_GeographyFromText($${pi}), $${pi+1})`);
    params.push(`POINT(${lng} ${lat})`);
    params.push(Number(radiusKm) * 1000);
    pi += 2;
  }

  const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (safePage - 1) * cappedLimit;

  try {
    const result = await db.query(
      `SELECT id, type, ST_AsGeoJSON(location)::json AS location, address,
              people_count, status, ai_severity, ai_confidence, ai_analysis,
              assigned_team_id, contact_phone, is_anonymous, disaster_id,
              created_at, updated_at, resolved_at
       FROM sos_reports ${where}
       ORDER BY
         CASE ai_severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         created_at DESC
       LIMIT $${pi} OFFSET $${pi+1}`,
      [...params, cappedLimit, offset]
    );

    res.json({ status: 'success', data: result.rows });
  } catch (err) {
    logger.error('List SOS error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch SOS reports' });
  }
});

// GET /sos/reports/:id
app.get('/sos/reports/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT *, ST_AsGeoJSON(location)::json AS location FROM sos_reports WHERE id = $1`,
      [id]
    );
    if (!result.rows.length) {
      res.status(404).json({ status: 'error', message: 'SOS report not found' });
      return;
    }
    res.json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Get SOS error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch SOS report' });
  }
});

// PATCH /sos/reports/:id — update status/assignment
app.patch('/sos/reports/:id', async (req: Request, res: Response) => {
  const { id }   = req.params;
  const role     = req.headers['x-user-role'] as string;
  const userId   = req.headers['x-user-id'] as string;
  const parsed   = SOSUpdateSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  if (!['global_admin','national_admin','regional_admin','emergency_coordinator','first_responder'].includes(role)) {
    res.status(403).json({ status: 'error', message: 'Insufficient permissions' });
    return;
  }

  const { status, assignedTeamId } = parsed.data;

  try {
    const updates: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let pi = 1;

    if (status) {
      updates.push(`status = $${pi++}`);
      params.push(status);
      if (status === 'resolved') {
        updates.push(`resolved_at = NOW()`, `resolved_by = $${pi++}`);
        params.push(userId);
      }
    }
    if (assignedTeamId) {
      updates.push(`assigned_team_id = $${pi++}`);
      params.push(assignedTeamId);
    }

    params.push(id);

    const result = await db.query(
      `UPDATE sos_reports SET ${updates.join(', ')} WHERE id = $${pi} RETURNING *`,
      params
    );

    if (!result.rows.length) {
      res.status(404).json({ status: 'error', message: 'SOS report not found' });
      return;
    }

    // Update Redis cache
    if (status === 'resolved') {
      await redis.del(`sos:active:${id}`);
    }

    // Publish update. Same reasoning as SOS creation — the status change was
    // already durably written to Postgres above, so a Kafka hiccup here must
    // not turn a successful acknowledge/dispatch/resolve into a 500.
    try {
      await producer.send({
        topic: 'sos.updated',
        messages: [{
          key: id,
          value: JSON.stringify({
            eventId: uuidv4(), eventType: 'sos.updated',
            timestamp: new Date().toISOString(), source: 'sos-service',
            payload: result.rows[0]
          })
        }]
      });
    } catch (err) {
      logger.warn('SOS updated but Kafka publish failed — update is saved, event notification was skipped', {
        sosId: id, err: err instanceof Error ? err.message : String(err)
      });
    }

    res.json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Update SOS error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to update SOS report' });
  }
});

// GET /sos/stats — dashboard summary
app.get('/sos/stats', async (_req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status != 'resolved' AND status != 'false_alarm') AS active_count,
        COUNT(*) FILTER (WHERE ai_severity = 'critical' AND status = 'pending')  AS critical_pending,
        COUNT(*) FILTER (WHERE status = 'resolved')                              AS resolved_today,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')           AS last_hour,
        AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/60)
          FILTER (WHERE status = 'resolved')                                     AS avg_resolution_minutes
      FROM sos_reports
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

    res.json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('SOS stats error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch stats' });
  }
});

app.get('/health', async (_req, res) => {
  const dbOk = await db.query('SELECT 1').then(() => true).catch(() => false);
  res.json({ status: 'ok', service: 'sos-service', db: dbOk });
});

app.listen(PORT, () => logger.info(`SOS service running on port ${PORT}`));

export { app };
