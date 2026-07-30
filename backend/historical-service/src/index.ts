// ─── AEGIS GLOBAL — Historical Analysis Service ──────────────────────────────
import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import { Client as ESClient } from '@elastic/elasticsearch';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';

const app  = express();
const PORT = process.env.PORT || 4010;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'historical-service' },
  transports: [new winston.transports.Console()]
});

const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

const es = new ESClient({
  node: process.env.ES_URL || 'http://localhost:9200',
  auth: { username: 'elastic', password: process.env.ES_PASSWORD || 'aegis_dev_password' },
  tls:  { rejectUnauthorized: false }
});

const HISTORICAL_INDEX = 'aegis_historical_events';

// ─── Elasticsearch index setup ────────────────────────────────────────────────
async function ensureIndex(): Promise<boolean> {
  const exists = await es.indices.exists({ index: HISTORICAL_INDEX });
  if (!exists) {
    await es.indices.create({
      index: HISTORICAL_INDEX,
      mappings: {
        properties: {
          name:           { type: 'text', analyzer: 'standard' },
          type:           { type: 'keyword' },
          country:        { type: 'keyword' },
          region:         { type: 'keyword' },
          event_date:     { type: 'date' },
          deaths:         { type: 'long' },
          injuries:       { type: 'long' },
          affected:       { type: 'long' },
          economic_loss:  { type: 'double' },
          magnitude:      { type: 'float' },
          recovery_months:{ type: 'integer' },
          coordinates:    { type: 'geo_point' },
          description:    { type: 'text', analyzer: 'standard' },
          lessons:        { type: 'text', analyzer: 'standard' },
          data_source:    { type: 'keyword' }
        }
      }
    });
    logger.info('Historical index created');
    await seedHistoricalData();
    return true;
  }
  return false;
}

// Elasticsearch (especially with xpack security enabled) can take well over a
// minute to become reachable after its container starts, and there's no
// guarantee historical-service starts after it's actually ready — only after
// its container process has started. A single ensureIndex() attempt that
// fails here previously meant the index (and its 14 seeded disasters) would
// NEVER be created for that container's entire lifetime, since nothing
// retried it. This loop retries with backoff instead of failing once and
// giving up silently.
async function ensureIndexWithRetry(maxAttempts = 10) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await ensureIndex();
      logger.info('ES index ready', { attempt });
      return;
    } catch (err) {
      const delayMs = Math.min(5000 * attempt, 30000);
      logger.error('ES index setup failed, retrying', {
        attempt, maxAttempts, delayMs,
        err: err instanceof Error ? err.message : String(err)
      });
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  logger.error(`ES index setup gave up after ${maxAttempts} attempts — use POST /historical/reindex to retry manually once Elasticsearch is confirmed up`);
}
ensureIndexWithRetry();

// ─── Seed historical disaster data ────────────────────────────────────────────
async function seedHistoricalData() {
  const events = [
    { id: uuidv4(), name: '1931 China Floods', type: 'flood', country: 'China', event_date: '1931-07-01', deaths: 3700000, injuries: 0, affected: 53000000, economic_loss: 1400000000, magnitude: null, coordinates: { lat: 30.0, lon: 114.3 }, recovery_months: 60, description: 'One of the deadliest natural disasters in history. The Huang He, Yangtze, and Huai rivers all flooded simultaneously.', lessons: 'Importance of river basin management and integrated flood control systems.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2004 Indian Ocean Tsunami', type: 'tsunami', country: 'Multi-country', event_date: '2004-12-26', deaths: 227898, injuries: 500000, affected: 5000000, economic_loss: 14000000000, magnitude: 9.1, coordinates: { lat: 3.3, lon: 95.9 }, recovery_months: 84, description: 'Triggered by M9.1 earthquake off Sumatra coast. Affected 14 countries across Indian Ocean.', lessons: 'Global tsunami early warning system established (PTWS expansion). Community evacuation drills proven critical.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2005 Hurricane Katrina', type: 'hurricane', country: 'USA', event_date: '2005-08-29', deaths: 1833, injuries: 67000, affected: 3000000, economic_loss: 186000000000, magnitude: null, coordinates: { lat: 29.9, lon: -90.0 }, recovery_months: 120, description: 'Category 4 hurricane at landfall. New Orleans levee failures caused catastrophic flooding.', lessons: 'Infrastructure resilience, evacuation of vulnerable populations, interagency coordination failures identified.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2008 Cyclone Nargis', type: 'cyclone', country: 'Myanmar', event_date: '2008-05-02', deaths: 138366, injuries: 55000, affected: 2400000, economic_loss: 12900000000, magnitude: null, coordinates: { lat: 16.8, lon: 96.1 }, recovery_months: 48, description: 'Most deadly cyclone in Asia since 1991. Government delayed international aid access by 3 weeks.', lessons: 'Humanitarian access agreements, regional early warning systems, community shelter construction.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2010 Haiti Earthquake', type: 'earthquake', country: 'Haiti', event_date: '2010-01-12', deaths: 316000, injuries: 300000, affected: 3700000, economic_loss: 8500000000, magnitude: 7.0, coordinates: { lat: 18.5, lon: -72.3 }, recovery_months: 144, description: 'M7.0 near Port-au-Prince. 105,000 homes destroyed. 1.5M displaced to tent cities.', lessons: 'Building codes in seismic zones, long-term recovery planning, cholera outbreak management post-disaster.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2011 Japan Earthquake and Tsunami', type: 'tsunami', country: 'Japan', event_date: '2011-03-11', deaths: 19747, injuries: 6242, affected: 450000, economic_loss: 360000000000, magnitude: 9.0, coordinates: { lat: 38.3, lon: 142.4 }, recovery_months: 156, description: 'M9.0 triggered 40m tsunami waves. Fukushima Daiichi nuclear accident. Costliest disaster in history.', lessons: 'Gold standard for disaster preparedness. Seawall limitations, nuclear safety protocols, community resilience.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2013 Typhoon Haiyan', type: 'typhoon', country: 'Philippines', event_date: '2013-11-08', deaths: 6300, injuries: 28688, affected: 16100000, economic_loss: 14000000000, magnitude: null, coordinates: { lat: 11.2, lon: 125.0 }, recovery_months: 60, description: 'Strongest tropical cyclone ever recorded at landfall (315km/h). Tacloban destroyed by storm surge.', lessons: 'Storm surge awareness (not just wind), vertical evacuation structures, pre-positioned supplies.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2015 Nepal Earthquake', type: 'earthquake', country: 'Nepal', event_date: '2015-04-25', deaths: 8964, injuries: 22309, affected: 5600000, economic_loss: 10000000000, magnitude: 7.8, coordinates: { lat: 28.1, lon: 84.7 }, recovery_months: 72, description: 'M7.8 near Gorkha district. 300,000 houses destroyed. Everest base camp avalanche. Historic sites lost.', lessons: 'Mountain rescue coordination, cultural heritage protection, resilient reconstruction standards.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2017 Hurricane Maria', type: 'hurricane', country: 'Puerto Rico', event_date: '2017-09-20', deaths: 2975, injuries: 0, affected: 3400000, economic_loss: 91000000000, magnitude: null, coordinates: { lat: 18.2, lon: -66.5 }, recovery_months: 60, description: 'Category 4. Entire island power grid destroyed. 11 months until full power restoration. Death toll undercounted initially.', lessons: 'Island grid resilience, death toll methodology, federal response equity issues, community solar microgrids.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2019 Cyclone Idai', type: 'cyclone', country: 'Mozambique', event_date: '2019-03-14', deaths: 1302, injuries: 0, affected: 3000000, economic_loss: 2200000000, magnitude: null, coordinates: { lat: -19.8, lon: 34.9 }, recovery_months: 36, description: 'One of worst storms ever to hit Africa. Beira 90% destroyed. Cyclone Kenneth followed 6 weeks later.', lessons: 'African cyclone preparedness, mangrove restoration for coastal protection, back-to-back cyclone protocols.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2020 Australian Bushfires', type: 'wildfire', country: 'Australia', event_date: '2019-09-01', deaths: 34, injuries: 429, affected: 3000000, economic_loss: 103000000000, magnitude: null, coordinates: { lat: -33.8, lon: 151.2 }, recovery_months: 24, description: 'Burnt 18.6M hectares — larger than many countries. 3B animals killed. Air quality crisis in Sydney.', lessons: 'Climate-driven extreme fire conditions, wildlife corridors, prescribed burn management, air quality monitoring.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2022 Pakistan Super Floods', type: 'flood', country: 'Pakistan', event_date: '2022-06-14', deaths: 1739, injuries: 12862, affected: 33000000, economic_loss: 30000000000, magnitude: null, coordinates: { lat: 25.9, lon: 68.3 }, recovery_months: 36, description: 'One-third of Pakistan underwater. Glacial lake outburst floods + monsoon. Climate-attributed event.', lessons: 'Glacial lake outburst flood monitoring, climate finance access, agricultural resilience, sindh province drainage.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2023 Turkey–Syria Earthquake', type: 'earthquake', country: 'Turkey', event_date: '2023-02-06', deaths: 59259, injuries: 122000, affected: 13500000, economic_loss: 103000000000, magnitude: 7.8, coordinates: { lat: 37.2, lon: 37.0 }, recovery_months: 36, description: 'Double earthquake (M7.8 + M7.7) within 9 hours. 11 Turkish provinces affected. Syrian conflict complicated response.', lessons: 'Building collapse patterns, rescue window timing, cross-border humanitarian access, construction regulation enforcement.', data_source: 'EMDAT' },
    { id: uuidv4(), name: '2023 Libya Flood (Storm Daniel)', type: 'flood', country: 'Libya', event_date: '2023-09-10', deaths: 11300, injuries: 10000, affected: 900000, economic_loss: 4000000000, magnitude: null, coordinates: { lat: 32.9, lon: 21.8 }, recovery_months: 48, description: 'Dam collapses in Derna killed 11,300+. City of 90,000 lost entire districts to walls of water.', lessons: 'Dam maintenance in conflict zones, rapid onset flood response, mass casualty recovery operations at sea.', data_source: 'EMDAT' },
  ];

  const body = events.flatMap(event => [
    { index: { _index: HISTORICAL_INDEX, _id: event.id } },
    event
  ]);

  await es.bulk({ body });
  logger.info(`Seeded ${events.length} historical events to Elasticsearch`);
}

app.use(express.json());

// ─── GET /historical — full-text search + filters ────────────────────────────
app.get('/historical', async (req: Request, res: Response) => {
  const {
    q, type, country, yearFrom, yearTo, minDeaths, maxDeaths,
    minEconomicLoss, sortBy = 'deaths', sortOrder = 'desc',
    limit = '20', page = '1'
  } = req.query;

  const cappedLimit = Math.min(parseInt(limit as string) || 20, 100);
  const safePage     = Math.max(parseInt(page as string) || 1, 1);
  const from  = (safePage - 1) * cappedLimit;
  const must: unknown[]   = [];
  const filter: unknown[] = [];

  if (q) {
    must.push({ multi_match: { query: q, fields: ['name^3', 'description', 'lessons', 'country^2'], type: 'best_fields', fuzziness: 'AUTO' } });
  }
  if (type)    filter.push({ term: { type } });
  if (country) filter.push({ term: { country } });
  if (yearFrom || yearTo) {
    filter.push({ range: { event_date: {
      ...(yearFrom ? { gte: `${yearFrom}-01-01` } : {}),
      ...(yearTo   ? { lte: `${yearTo}-12-31`   } : {})
    }}});
  }
  if (minDeaths) filter.push({ range: { deaths: { gte: Number(minDeaths) } } });
  if (maxDeaths) filter.push({ range: { deaths: { lte: Number(maxDeaths) } } });
  if (minEconomicLoss) filter.push({ range: { economic_loss: { gte: Number(minEconomicLoss) } } });

  const sortField = ['deaths','economic_loss','affected','magnitude','event_date'].includes(sortBy as string)
    ? sortBy : 'deaths';

  try {
    const result = await es.search({
      index: HISTORICAL_INDEX,
      from,
      size:  cappedLimit,
      query: (must.length || filter.length
        ? { bool: { must: must.length ? must : [{ match_all: {} }], filter } }
        : { match_all: {} }) as any,
      sort:  [{ [sortField as string]: { order: sortOrder as 'asc' | 'desc' } }] as any,
      _source: true
    });

    const hits  = result.hits.hits;
    const total = typeof result.hits.total === 'number' ? result.hits.total : result.hits.total?.value || 0;

    res.json({
      status: 'success',
      data:   hits.map(h => ({ id: h._id, ...h._source as object })),
      total,
      page:   safePage,
      limit:  cappedLimit,
      hasMore:from + hits.length < total
    });
  } catch (err) {
    logger.error('Historical search error', { err });
    res.status(500).json({ status: 'error', message: 'Search failed' });
  }
});

// ─── GET /historical/:id ──────────────────────────────────────────────────────
app.get('/historical/:id', async (req: Request, res: Response) => {
  try {
    const result = await es.get({ index: HISTORICAL_INDEX, id: req.params.id });
    res.json({ status: 'success', data: { id: result._id, ...result._source as object } });
  } catch (err: any) {
    if (err.meta?.statusCode === 404) {
      res.status(404).json({ status: 'error', message: 'Event not found' });
    } else {
      res.status(500).json({ status: 'error', message: 'Fetch failed' });
    }
  }
});

// ─── POST /historical/compare ─────────────────────────────────────────────────
app.post('/historical/compare', async (req: Request, res: Response) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 5) {
    res.status(400).json({ status: 'error', message: 'Provide 2–5 event IDs to compare' });
    return;
  }

  try {
    const docs = await Promise.all(
      ids.map(id => es.get({ index: HISTORICAL_INDEX, id }).then(r => ({ id: r._id, ...r._source as object })))
    );

    // Compute comparison metrics
    const events = docs as any[];
    const comparison = {
      events,
      metrics: {
        deaths:        events.map(e => ({ name: e.name, value: e.deaths })),
        affected:      events.map(e => ({ name: e.name, value: e.affected })),
        economic_loss: events.map(e => ({ name: e.name, value: e.economic_loss })),
        recovery_months: events.map(e => ({ name: e.name, value: e.recovery_months })),
        magnitude:     events.filter(e => e.magnitude).map(e => ({ name: e.name, value: e.magnitude })),
      },
      rankings: {
        deadliest:    [...events].sort((a, b) => b.deaths - a.deaths)[0]?.name,
        costliest:    [...events].sort((a, b) => b.economic_loss - a.economic_loss)[0]?.name,
        slowestRecovery: [...events].sort((a, b) => b.recovery_months - a.recovery_months)[0]?.name,
      }
    };

    res.json({ status: 'success', data: comparison });
  } catch (err) {
    logger.error('Compare error', { err });
    res.status(500).json({ status: 'error', message: 'Comparison failed' });
  }
});

// ─── GET /historical/stats/aggregate ──────────────────────────────────────────
app.get('/historical/stats/aggregate', async (_req, res) => {
  try {
    const result = await es.search({
      index: HISTORICAL_INDEX,
      size:  0,
      aggs: {
        by_type:     { terms: { field: 'type', size: 20 } },
        by_decade:   { date_histogram: { field: 'event_date', calendar_interval: '1y', format: 'yyyy' } },
        total_deaths:{ sum: { field: 'deaths' } },
        total_affected: { sum: { field: 'affected' } },
        total_economic: { sum: { field: 'economic_loss' } },
        avg_recovery: { avg: { field: 'recovery_months' } },
        max_deaths:  { max: { field: 'deaths' } },
        by_country:  { terms: { field: 'country', size: 15 } }
      }
    });

    res.json({ status: 'success', data: result.aggregations });
  } catch (err) {
    logger.error('Aggregation error', { err });
    res.status(500).json({ status: 'error', message: 'Aggregation failed' });
  }
});

// ─── POST /historical — add new event ─────────────────────────────────────────
app.post('/historical', async (req: Request, res: Response) => {
  const role = req.headers['x-user-role'] as string;
  if (!['global_admin','national_admin','research_analyst'].includes(role)) {
    res.status(403).json({ status: 'error', message: 'Insufficient permissions' });
    return;
  }

  const schema = z.object({
    name:           z.string().min(1).max(500),
    type:           z.string(),
    country:        z.string(),
    event_date:     z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    deaths:         z.number().int().min(0),
    injuries:       z.number().int().min(0).default(0),
    affected:       z.number().int().min(0).default(0),
    economic_loss:  z.number().min(0).default(0),
    magnitude:      z.number().optional(),
    lat:            z.number().optional(),
    lng:            z.number().optional(),
    recovery_months:z.number().int().min(0).optional(),
    description:    z.string().optional(),
    lessons:        z.string().optional(),
    data_source:    z.string().default('Manual entry')
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const d   = parsed.data;
  const id  = uuidv4();
  const doc = {
    ...d,
    coordinates: d.lat && d.lng ? { lat: d.lat, lon: d.lng } : undefined,
    created_at: new Date().toISOString()
  };

  try {
    await es.index({ index: HISTORICAL_INDEX, id, document: doc });
    res.status(201).json({ status: 'success', data: { id, ...doc } });
  } catch (err) {
    logger.error('Add historical event error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to add event' });
  }
});

app.get('/health', async (_req, res) => {
  const esOk = await es.ping().then(() => true).catch(() => false);
  const indexOk = esOk ? await es.indices.exists({ index: HISTORICAL_INDEX }).catch(() => false) : false;
  res.json({ status: 'ok', service: 'historical-service', elasticsearch: esOk, indexExists: indexOk });
});

// POST /historical/reindex — manually retry index creation + seeding without
// restarting the container. Useful when Elasticsearch wasn't ready at boot.
app.post('/historical/reindex', async (req: Request, res: Response) => {
  const role = req.headers['x-user-role'] as string;
  if (!['global_admin', 'national_admin', 'research_analyst'].includes(role)) {
    res.status(403).json({ status: 'error', message: 'Insufficient permissions' });
    return;
  }
  try {
    const created = await ensureIndex();
    res.json({ status: 'success', data: { created, message: created ? 'Index created and seeded' : 'Index already existed' } });
  } catch (err) {
    logger.error('Manual reindex failed', { err });
    res.status(500).json({ status: 'error', message: 'Reindex failed — check that Elasticsearch is reachable' });
  }
});

app.listen(PORT, () => logger.info(`Historical service running on port ${PORT}`));
export { app };
