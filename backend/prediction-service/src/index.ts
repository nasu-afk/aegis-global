// ─── AEGIS GLOBAL — Prediction Service ──────────────────────────────────────
import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import { MongoClient, Collection } from 'mongodb';
import { Kafka, Producer } from 'kafkajs';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';

const app  = express();
const PORT = process.env.PORT || 4004;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'prediction-service' },
  transports: [new winston.transports.Console()]
});

const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

let predictionsCollection: Collection;

async function connectMongo() {
  const client = new MongoClient(process.env.MONGO_URI || 'mongodb://localhost:27017');
  await client.connect();
  const mdb            = client.db();
  predictionsCollection = mdb.collection('ml_predictions');
  await predictionsCollection.createIndex({ disasterType: 1, createdAt: -1 });
  await predictionsCollection.createIndex({ confidence: -1 });
  await predictionsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  logger.info('MongoDB connected');
}
connectMongo().catch(err => logger.error('MongoDB failed', { err }));

const kafka    = new Kafka({ clientId: 'prediction-service', brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',') });
let producer: Producer;
async function initKafka() {
  producer = kafka.producer();
  await producer.connect();
}
initKafka().catch(err => logger.error('Kafka failed', { err }));

app.use(express.json());

// ─── Model registry ───────────────────────────────────────────────────────────
const MODEL_REGISTRY: Record<string, {
  name: string; version: string; accuracy: number; type: string; description: string;
}> = {
  flood_lstm: {
    name: 'Flood Risk LSTM+ConvLSTM', version: '2.4.1', accuracy: 0.942,
    type: 'flood', description: 'River gauge + rainfall + satellite fusion model'
  },
  wildfire_physics: {
    name: 'Wildfire Spread Physics-ML Hybrid', version: '1.8.3', accuracy: 0.886,
    type: 'wildfire', description: 'Fuel moisture + wind + terrain + weather model'
  },
  cyclone_gnn: {
    name: 'Cyclone Track GraphNN+NWP', version: '3.1.0', accuracy: 0.918,
    type: 'cyclone', description: 'SST + pressure gradient + wind shear model'
  },
  earthquake_bayesian: {
    name: 'Earthquake Bayesian+Omori', version: '1.2.5', accuracy: 0.783,
    type: 'earthquake', description: 'Seismic sequence + Coulomb stress transfer model'
  },
  landslide_rf: {
    name: 'Landslide Random Forest', version: '2.0.1', accuracy: 0.841,
    type: 'landslide', description: 'Slope + rainfall + deforestation + geology model'
  },
  disease_epi: {
    name: 'Disease Outbreak SEIR+ML', version: '1.5.2', accuracy: 0.872,
    type: 'disease_outbreak', description: 'Post-disaster WASH + population + climate model'
  },
};

// ─── Prediction schemas ───────────────────────────────────────────────────────
const PredictionRequestSchema = z.object({
  disasterType: z.enum(['flood','wildfire','cyclone','earthquake','landslide','disease_outbreak']),
  lat:          z.number().min(-90).max(90),
  lng:          z.number().min(-180).max(180),
  radiusKm:     z.number().positive().default(200),
  horizon:      z.number().int().min(6).max(168).default(72), // hours
  contextData:  z.record(z.unknown()).optional().default({})
});

// ─── Synthetic ML inference (production replaces with real model endpoints) ───
function runFloodModel(lat: number, _lng: number, context: Record<string, unknown>): {
  confidence: number; severity: string; onset_hours: number; factors: string[];
} {
  // In production: call SageMaker endpoint
  // Here we simulate using contextual heuristics
  const rainfallForecast = (context.rainfall_mm_24h as number) || 80;
  const riverGaugePct    = (context.river_gauge_pct as number) || 75;
  const baseConfidence   = Math.min(0.95, (rainfallForecast / 200 + riverGaugePct / 100) / 2);
  const confidence       = Math.round(baseConfidence * 100) / 100;
  const severity         = confidence > 0.8 ? 'critical' : confidence > 0.6 ? 'high' : 'medium';
  return {
    confidence,
    severity,
    onset_hours: confidence > 0.8 ? 18 : 36,
    factors: [
      `Rainfall forecast: ${rainfallForecast}mm/24h`,
      `River gauge at ${riverGaugePct}% capacity`,
      `Tidal influence: ${Math.abs(lat) < 15 ? 'significant' : 'moderate'}`,
      'Upstream monitoring: elevated'
    ]
  };
}

function runWildfireModel(_lat: number, _lng: number, context: Record<string, unknown>): {
  confidence: number; severity: string; spread_km2_24h: number; factors: string[];
} {
  const windSpeedKmh  = (context.wind_speed_kmh as number) || 30;
  const humidity      = (context.relative_humidity as number) || 20;
  const tempC         = (context.temperature_c as number) || 35;
  const fuelMoisture  = (context.fuel_moisture_pct as number) || 8;
  const riskScore     = (windSpeedKmh / 60 + (100 - humidity) / 100 + (tempC - 20) / 30 + (15 - fuelMoisture) / 15) / 4;
  const confidence    = Math.min(0.95, Math.max(0.3, riskScore));
  return {
    confidence: Math.round(confidence * 100) / 100,
    severity:   confidence > 0.75 ? 'high' : 'medium',
    spread_km2_24h: Math.round(windSpeedKmh * (confidence * 10)),
    factors: [
      `Wind: ${windSpeedKmh}km/h`,
      `Relative humidity: ${humidity}%`,
      `Temperature: ${tempC}°C`,
      `Fuel moisture: ${fuelMoisture}%`
    ]
  };
}

function runCycloneModel(_lat: number, _lng: number, context: Record<string, unknown>): {
  confidence: number; severity: string; category: number; landfall_hours?: number; factors: string[];
} {
  const sst          = (context.sea_surface_temp_c as number) || 29;
  const windShear    = (context.wind_shear_ms as number) || 5;
  const lowPressure  = (context.low_pressure_hpa as number) || 995;
  const intensConf   = Math.min(0.95, (sst - 26) / 4 + (20 - windShear) / 20 + (1013 - lowPressure) / 50);
  const confidence   = Math.max(0.3, Math.round(intensConf * 100) / 100);
  const category     = sst > 30 && windShear < 5 ? 4 : sst > 28 ? 3 : 2;
  return {
    confidence,
    severity:   category >= 4 ? 'critical' : 'high',
    category,
    landfall_hours: Math.round(24 + Math.random() * 48),
    factors: [
      `SST: ${sst}°C (anomaly: +${(sst - 27).toFixed(1)}°C)`,
      `Wind shear: ${windShear}m/s (${windShear < 8 ? 'favourable for intensification' : 'limiting'})`,
      `Central pressure: ${lowPressure}hPa`,
      `Track: poleward, accelerating`
    ]
  };
}

function runEarthquakeModel(_lat: number, _lng: number, context: Record<string, unknown>): {
  confidence: number; magnitude_max: number; factors: string[];
} {
  const mainshockMag  = (context.mainshock_magnitude as number) || 7.0;
  const aftershockCount = (context.aftershock_count_24h as number) || 15;
  // Omori-Utsu law approximation
  const omoriFactor   = Math.min(0.90, mainshockMag / 10 + aftershockCount / 100);
  const expectedMag   = mainshockMag - 1.2; // Bath's law
  return {
    confidence: Math.round(omoriFactor * 100) / 100,
    magnitude_max: Math.round(expectedMag * 10) / 10,
    factors: [
      `Mainshock M${mainshockMag} — Bath's law: M${expectedMag.toFixed(1)} expected`,
      `${aftershockCount} aftershocks in 24h (Omori decay active)`,
      `Coulomb stress transfer: elevated on parallel fault segments`,
      `b-value: 0.9 (higher aftershock risk than average)`
    ]
  };
}

// ─── POST /predictions/run ────────────────────────────────────────────────────
app.post('/predictions/run', async (req: Request, res: Response) => {
  const parsed = PredictionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const { disasterType, lat, lng, horizon, contextData } = parsed.data;

  const model = Object.values(MODEL_REGISTRY).find(m => m.type === disasterType) ||
                MODEL_REGISTRY[Object.keys(MODEL_REGISTRY)[0]];

  try {
    let result: Record<string, unknown>;
    let factors: string[] = [];
    let confidence  = 0.5;
    let severity    = 'medium';
    let onsetMin    = new Date(Date.now() + 6 * 3600_000);
    let onsetMax    = new Date(Date.now() + horizon * 3600_000);

    switch (disasterType) {
      case 'flood': {
        const r = runFloodModel(lat, lng, contextData);
        confidence = r.confidence; severity = r.severity; factors = r.factors;
        onsetMin   = new Date(Date.now() + r.onset_hours * 3600_000);
        onsetMax   = new Date(Date.now() + (r.onset_hours + 18) * 3600_000);
        result     = { onsetHours: r.onset_hours };
        break;
      }
      case 'wildfire': {
        const r = runWildfireModel(lat, lng, contextData);
        confidence = r.confidence; severity = r.severity; factors = r.factors;
        result     = { spreadKm2Per24h: r.spread_km2_24h };
        break;
      }
      case 'cyclone': {
        const r = runCycloneModel(lat, lng, contextData);
        confidence = r.confidence; severity = r.severity; factors = r.factors;
        if (r.landfall_hours) {
          onsetMin = new Date(Date.now() + r.landfall_hours * 3600_000);
          onsetMax = new Date(Date.now() + (r.landfall_hours + 12) * 3600_000);
        }
        result = { category: r.category, landfallHours: r.landfall_hours };
        break;
      }
      case 'earthquake': {
        const r = runEarthquakeModel(lat, lng, contextData);
        confidence = r.confidence; factors = r.factors;
        result     = { maxExpectedMagnitude: r.magnitude_max };
        break;
      }
      default: {
        confidence = 0.5 + Math.random() * 0.3;
        severity   = confidence > 0.7 ? 'high' : 'medium';
        factors    = ['Baseline risk elevated', 'Historical pattern match', 'Environmental indicators'];
        result     = {};
      }
    }

    const prediction = {
      id:           uuidv4(),
      disasterType,
      modelName:    model.name,
      modelVersion: model.version,
      modelAccuracy:model.accuracy,
      confidence:   Math.round(confidence * 1000) / 1000,
      predictedSeverity: severity,
      location:     { type: 'Point', coordinates: [lng, lat] },
      onsetMin:     onsetMin.toISOString(),
      onsetMax:     onsetMax.toISOString(),
      horizonHours: horizon,
      contributingFactors: factors,
      riskScore:    Math.round(confidence * 100),
      metadata:     { ...result, contextData },
      isActive:     true,
      createdAt:    new Date(),
      expiresAt:    new Date(Date.now() + horizon * 3600_000)
    };

    // Store in MongoDB for fast time-series queries
    if (predictionsCollection) await predictionsCollection.insertOne(prediction);

    // Store summary in Postgres for relational queries
    await db.query(
      `INSERT INTO predictions (
         id, model_name, model_version, disaster_type, confidence,
         predicted_severity, onset_min, onset_max,
         location, contributing_factors, risk_score, is_active, created_at, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
         ST_GeographyFromText($9),$10,$11,TRUE,NOW(),$12)`,
      [
        prediction.id, model.name, model.version, disasterType,
        prediction.confidence, severity,
        onsetMin.toISOString(), onsetMax.toISOString(),
        `POINT(${lng} ${lat})`,
        JSON.stringify(factors), prediction.riskScore,
        prediction.expiresAt.toISOString()
      ]
    );

    // Publish high-confidence predictions as Kafka events. Best-effort only —
    // the prediction is already durably saved above, so a broker hiccup here
    // must not turn a successful prediction into a 500.
    if (confidence >= 0.7 && producer) {
      try {
        await producer.send({
          topic: 'prediction.high_confidence',
          messages: [{ key: prediction.id, value: JSON.stringify({
            eventId: uuidv4(), eventType: 'prediction.created',
            timestamp: new Date().toISOString(), source: 'prediction-service',
            payload: prediction
          })}]
        });
      } catch (err) {
        logger.warn('Prediction saved but Kafka publish failed', {
          predictionId: prediction.id, err: err instanceof Error ? err.message : String(err)
        });
      }
    }

    logger.info('Prediction generated', {
      id: prediction.id, type: disasterType, confidence, severity
    });

    res.status(201).json({ status: 'success', data: prediction });
  } catch (err) {
    logger.error('Prediction run error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to run prediction model' });
  }
});

// ─── GET /predictions ─────────────────────────────────────────────────────────
app.get('/predictions', async (req: Request, res: Response) => {
  const { disasterType, active, minConfidence, lat, lng, radiusKm, limit = '20' } = req.query;
  const cappedLimit = Math.min(parseInt(limit as string) || 20, 100);

  const conditions: string[] = ['p.is_active = TRUE', 'p.expires_at > NOW()'];
  const params: unknown[]    = [];
  let pi = 1;

  if (disasterType)   { conditions.push(`p.disaster_type = $${pi++}`);   params.push(disasterType); }
  if (minConfidence)  { conditions.push(`p.confidence >= $${pi++}`);     params.push(Number(minConfidence)); }
  if (active === 'false') conditions[0] = 'p.is_active = FALSE';

  if (lat && lng && radiusKm) {
    conditions.push(`ST_DWithin(p.location, ST_GeographyFromText($${pi}), $${pi+1})`);
    params.push(`POINT(${lng} ${lat})`);
    params.push(Number(radiusKm) * 1000);
    pi += 2;
  }

  try {
    const result = await db.query(
      `SELECT p.id, p.disaster_type, p.model_name, p.model_version,
              p.confidence, p.predicted_severity, p.onset_min, p.onset_max,
              p.risk_score, p.contributing_factors, p.is_active, p.created_at, p.expires_at,
              ST_AsGeoJSON(p.location)::json AS location
       FROM predictions p
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.confidence DESC, p.created_at DESC
       LIMIT $${pi}`,
      [...params, cappedLimit]
    );

    res.json({ status: 'success', data: result.rows, total: result.rows.length });
  } catch (err) {
    logger.error('List predictions error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch predictions' });
  }
});

// ─── GET /predictions/models ──────────────────────────────────────────────────
app.get('/predictions/models', (_req, res) => {
  res.json({ status: 'success', data: Object.values(MODEL_REGISTRY) });
});

// ─── POST /predictions/batch ─── run all models for a region ─────────────────
app.post('/predictions/batch', async (req: Request, res: Response) => {
  const { lat, lng, radiusKm = 500 } = req.body;
  if (!lat || !lng) {
    res.status(400).json({ status: 'error', message: 'lat and lng required' });
    return;
  }

  const results = [];
  for (const [, model] of Object.entries(MODEL_REGISTRY)) {
    try {
      const result = await runSinglePrediction(model.type as any, lat, lng, 72, {});
      results.push(result);
    } catch {
      /* skip failed models */
    }
  }

  res.json({ status: 'success', data: results, count: results.length });
});

async function runSinglePrediction(
  disasterType: string, lat: number, lng: number, horizon: number, _contextData: Record<string, unknown>
) {
  const model  = Object.values(MODEL_REGISTRY).find(m => m.type === disasterType)!;
  let confidence = 0.5 + Math.random() * 0.4;
  const factors  = ['Elevated environmental risk index', 'Historical frequency high', 'Seasonal risk elevated'];
  return {
    id:           uuidv4(),
    disasterType,
    modelName:    model.name,
    confidence:   Math.round(confidence * 1000) / 1000,
    predictedSeverity: confidence > 0.75 ? 'high' : 'medium',
    onsetMin:     new Date(Date.now() + 12 * 3600_000).toISOString(),
    onsetMax:     new Date(Date.now() + horizon * 3600_000).toISOString(),
    contributingFactors: factors,
    riskScore:    Math.round(confidence * 100),
    location:     { type: 'Point', coordinates: [lng, lat] }
  };
}

// ─── GET /predictions/risk-score/:iso2 ───────────────────────────────────────
app.get('/predictions/risk-score/:iso2', async (req: Request, res: Response) => {
  const { iso2 } = req.params;

  try {
    const result = await db.query(
      `SELECT iso2, country_name, gdis_score, disaster_frequency, infrastructure_score,
              climate_risk, preparedness_score, response_efficiency, recovery_performance,
              economic_vulnerability, population_density_risk, rank, updated_at
       FROM country_risk_scores WHERE iso2 = $1`,
      [iso2.toUpperCase()]
    );

    if (!result.rows.length) {
      res.status(404).json({ status: 'error', message: 'Country not found' });
      return;
    }

    res.json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Risk score error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch risk score' });
  }
});

app.get('/health', async (_req, res) => {
  const dbOk = await db.query('SELECT 1').then(() => true).catch(() => false);
  res.json({ status: 'ok', service: 'prediction-service', db: dbOk, models: Object.keys(MODEL_REGISTRY).length });
});

app.listen(PORT, () => logger.info(`Prediction service running on port ${PORT}`));
export { app };
