// ─── AEGIS GLOBAL — Resource Management Service ──────────────────────────────
import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';

const app  = express();
const PORT = process.env.PORT || 4007;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'resource-service' },
  transports: [new winston.transports.Console()]
});

const db    = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const redis = createClient({ url: process.env.REDIS_URL });
redis.connect().catch(err => logger.error('Redis failed', { err }));

app.use(express.json());

const CACHE_TTL = 30; // seconds

// ─── RESOURCES ───────────────────────────────────────────────────────────────

app.get('/resources', async (req: Request, res: Response) => {
  const { category, disasterId, status, limit = '50', page = '1' } = req.query;
  const cappedLimit = Math.min(parseInt(limit as string) || 50, 100);
  const safePage     = Math.max(parseInt(page as string) || 1, 1);
  const cacheKey = `resources:list:${JSON.stringify(req.query)}`;

  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) { res.json(JSON.parse(cached)); return; }

  const conditions: string[] = [];
  const params: unknown[]    = [];
  let pi = 1;

  if (category)   { conditions.push(`category = $${pi++}`);   params.push(category); }
  if (disasterId) { conditions.push(`disaster_id = $${pi++}`);params.push(disasterId); }
  if (status)     { conditions.push(`status = $${pi++}`);     params.push(status); }

  const where  = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (safePage - 1) * cappedLimit;

  try {
    const result = await db.query(
      `SELECT id, category, name, unit, quantity_total, quantity_available,
              quantity_deployed, status, disaster_id, assigned_team_id, metadata,
              ST_AsGeoJSON(current_location)::json AS current_location,
              created_at, updated_at
       FROM resources ${where}
       ORDER BY category, name
       LIMIT $${pi} OFFSET $${pi+1}`,
      [...params, cappedLimit, offset]
    );
    const body = { status: 'success', data: result.rows, total: result.rows.length };
    await redis.setEx(cacheKey, CACHE_TTL, JSON.stringify(body));
    res.json(body);
  } catch (err) {
    logger.error('List resources error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch resources' });
  }
});

app.get('/resources/summary', async (_req, res) => {
  try {
    const result = await db.query(`
      SELECT
        category,
        SUM(quantity_total)     AS total,
        SUM(quantity_available) AS available,
        SUM(quantity_deployed)  AS deployed,
        COUNT(*)                AS unit_count
      FROM resources
      GROUP BY category
      ORDER BY category
    `);
    res.json({ status: 'success', data: result.rows });
  } catch (err) {
    logger.error('Resources summary error', { err });
    res.status(500).json({ status: 'error', message: 'Summary failed' });
  }
});

app.post('/resources', async (req: Request, res: Response) => {
  const role = req.headers['x-user-role'] as string;
  if (!['global_admin','national_admin','regional_admin','emergency_coordinator'].includes(role)) {
    res.status(403).json({ status: 'error', message: 'Insufficient permissions' });
    return;
  }

  const schema = z.object({
    category:         z.enum(['sar_team','medical_unit','aerial','boat','fire_unit','supply_food','supply_water','supply_medical','drone','communication']),
    name:             z.string().min(1).max(300),
    unit:             z.string().default('unit'),
    quantityTotal:    z.number().positive(),
    lat:              z.number().optional(),
    lng:              z.number().optional(),
    metadata:         z.record(z.unknown()).default({})
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const d = parsed.data;
  const coordSql = d.lat && d.lng ? `ST_GeographyFromText('POINT(${d.lng} ${d.lat})')` : 'NULL';

  try {
    const result = await db.query(
      `INSERT INTO resources (id, category, name, unit, quantity_total, quantity_available, quantity_deployed, status, current_location, metadata)
       VALUES ($1,$2,$3,$4,$5,$5,0,'available',${coordSql},$6)
       RETURNING *`,
      [uuidv4(), d.category, d.name, d.unit, d.quantityTotal, JSON.stringify(d.metadata)]
    );
    await redis.del('resources:list:*');
    res.status(201).json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Create resource error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to create resource' });
  }
});

app.patch('/resources/:id/deploy', async (req: Request, res: Response) => {
  const { id }       = req.params;
  const { quantity, disasterId, teamId } = req.body;

  if (!quantity || quantity <= 0) {
    res.status(400).json({ status: 'error', message: 'quantity must be positive' });
    return;
  }

  try {
    const result = await db.query(
      `UPDATE resources SET
         quantity_available = quantity_available - $1,
         quantity_deployed  = quantity_deployed + $1,
         disaster_id        = COALESCE($2, disaster_id),
         assigned_team_id   = COALESCE($3, assigned_team_id),
         status             = CASE WHEN quantity_available - $1 <= 0 THEN 'fully_deployed' ELSE status END,
         updated_at         = NOW()
       WHERE id = $4 AND quantity_available >= $1
       RETURNING *`,
      [quantity, disasterId, teamId, id]
    );

    if (!result.rows.length) {
      res.status(400).json({ status: 'error', message: 'Insufficient available quantity or resource not found' });
      return;
    }

    res.json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Deploy resource error', { err });
    res.status(500).json({ status: 'error', message: 'Deployment failed' });
  }
});

app.patch('/resources/:id/return', async (req: Request, res: Response) => {
  const { id }     = req.params;
  const { quantity } = req.body;

  if (!quantity || quantity <= 0) {
    res.status(400).json({ status: 'error', message: 'quantity must be positive' });
    return;
  }

  try {
    const result = await db.query(
      `UPDATE resources SET
         quantity_available = quantity_available + $1,
         quantity_deployed  = GREATEST(0, quantity_deployed - $1),
         status             = 'available',
         updated_at         = NOW()
       WHERE id = $2 AND quantity_deployed >= $1
       RETURNING *`,
      [quantity, id]
    );

    if (!result.rows.length) {
      res.status(400).json({ status: 'error', message: 'Cannot return more than deployed' });
      return;
    }

    res.json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Return resource error', { err });
    res.status(500).json({ status: 'error', message: 'Return failed' });
  }
});

// ─── RESPONSE TEAMS ──────────────────────────────────────────────────────────

app.get('/resources/teams', async (req: Request, res: Response) => {
  const { disasterId, status, type, limit = '50' } = req.query;
  const cappedLimit = Math.min(parseInt(limit as string) || 50, 100);

  const conditions: string[] = [];
  const params: unknown[]    = [];
  let pi = 1;

  if (disasterId) { conditions.push(`disaster_id = $${pi++}`); params.push(disasterId); }
  if (status)     { conditions.push(`status = $${pi++}`);      params.push(status); }
  if (type)       { conditions.push(`type = $${pi++}`);        params.push(type); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT id, name, type, specialisation, personnel_count, status,
              disaster_id, organisation, contact, equipment, deployed_at,
              ST_AsGeoJSON(current_location)::json AS current_location
       FROM response_teams ${where}
       ORDER BY deployed_at DESC NULLS LAST
       LIMIT $${pi}`,
      [...params, cappedLimit]
    );
    res.json({ status: 'success', data: result.rows });
  } catch (err) {
    logger.error('List teams error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch teams' });
  }
});

app.post('/resources/teams', async (req: Request, res: Response) => {
  const role = req.headers['x-user-role'] as string;
  if (!['global_admin','national_admin','regional_admin','emergency_coordinator'].includes(role)) {
    res.status(403).json({ status: 'error', message: 'Insufficient permissions' });
    return;
  }

  const schema = z.object({
    name:           z.string().min(1).max(300),
    type:           z.string().min(1),
    specialisation: z.string().optional(),
    personnelCount: z.number().int().positive(),
    organisation:   z.string().optional(),
    disasterId:     z.string().uuid().optional(),
    lat:            z.number().optional(),
    lng:            z.number().optional(),
    contact:        z.record(z.string()).default({}),
    equipment:      z.array(z.string()).default([])
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const d = parsed.data;
  const coordSql = d.lat && d.lng ? `ST_GeographyFromText('POINT(${d.lng} ${d.lat})')` : 'NULL';

  try {
    const result = await db.query(
      `INSERT INTO response_teams
         (id, name, type, specialisation, personnel_count, status, disaster_id,
          organisation, current_location, contact, equipment, deployed_at)
       VALUES ($1,$2,$3,$4,$5,'deployed',$6,$7,${coordSql},$8,$9,NOW())
       RETURNING *`,
      [uuidv4(), d.name, d.type, d.specialisation, d.personnelCount,
       d.disasterId, d.organisation, JSON.stringify(d.contact), JSON.stringify(d.equipment)]
    );
    res.status(201).json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Create team error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to create team' });
  }
});

// ─── SHELTERS ────────────────────────────────────────────────────────────────

app.post('/shelters', async (req: Request, res: Response) => {
  const role = req.headers['x-user-role'] as string;
  if (!['global_admin','national_admin','regional_admin','emergency_coordinator','ngo_coordinator'].includes(role)) {
    res.status(403).json({ status: 'error', message: 'Insufficient permissions' });
    return;
  }

  const schema = z.object({
    name:                z.string().min(1).max(300),
    lat:                 z.number().min(-90).max(90),
    lng:                 z.number().min(-180).max(180),
    address:             z.string().optional(),
    disasterId:          z.string().uuid().optional(),
    capacityTotal:       z.number().int().positive(),
    medicalUnit:         z.boolean().default(false),
    foodDaysRemaining:   z.number().min(0).default(0),
    waterDaysRemaining:  z.number().min(0).default(0),
    facilities:          z.array(z.string()).default([]),
    contact:             z.record(z.string()).default({})
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const d = parsed.data;

  try {
    const result = await db.query(
      `INSERT INTO shelters
         (id, name, location, address, disaster_id, capacity_total, occupancy_current,
          medical_unit, food_days_remaining, water_days_remaining, status, facilities, contact, managed_by, opened_at)
       VALUES ($1,$2,ST_GeographyFromText($3),$4,$5,$6,0,$7,$8,$9,'open',$10,$11,$12,NOW())
       RETURNING *, ST_AsGeoJSON(location)::json AS location`,
      [uuidv4(), d.name, `POINT(${d.lng} ${d.lat})`, d.address, d.disasterId,
       d.capacityTotal, d.medicalUnit, d.foodDaysRemaining, d.waterDaysRemaining,
       JSON.stringify(d.facilities), JSON.stringify(d.contact), req.headers['x-user-id']]
    );
    res.status(201).json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Create shelter error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to create shelter' });
  }
});

app.patch('/shelters/:id/occupancy', async (req: Request, res: Response) => {
  const { id } = req.params;
  const schema = z.object({
    delta:               z.number().int(),     // +N for arrivals, -N for departures
    foodDaysRemaining:   z.number().min(0).optional(),
    waterDaysRemaining:  z.number().min(0).optional(),
    status:              z.enum(['open','full','closed','preparing']).optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const { delta, foodDaysRemaining, waterDaysRemaining, status } = parsed.data;

  try {
    const result = await db.query(
      `UPDATE shelters SET
         occupancy_current   = GREATEST(0, LEAST(capacity_total, occupancy_current + $1)),
         food_days_remaining = COALESCE($2, food_days_remaining),
         water_days_remaining= COALESCE($3, water_days_remaining),
         status = COALESCE($4,
           CASE
             WHEN occupancy_current + $1 >= capacity_total THEN 'full'
             ELSE status
           END),
         updated_at = NOW()
       WHERE id = $5
       RETURNING *, ST_AsGeoJSON(location)::json AS location`,
      [delta, foodDaysRemaining, waterDaysRemaining, status, id]
    );

    if (!result.rows.length) {
      res.status(404).json({ status: 'error', message: 'Shelter not found' });
      return;
    }

    res.json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Update shelter occupancy error', { err });
    res.status(500).json({ status: 'error', message: 'Occupancy update failed' });
  }
});

app.get('/health', async (_req, res) => {
  const dbOk = await db.query('SELECT 1').then(() => true).catch(() => false);
  res.json({ status: 'ok', service: 'resource-service', db: dbOk });
});

app.listen(PORT, () => logger.info(`Resource service running on port ${PORT}`));
export { app };
