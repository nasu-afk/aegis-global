// ─── AEGIS GLOBAL — Social Intelligence Service ──────────────────────────────
import express, { Request, Response } from 'express';
import { MongoClient, Collection } from 'mongodb';
import { Kafka, Producer, Consumer } from 'kafkajs';
import OpenAI from 'openai';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';

const app  = express();
const PORT = process.env.PORT || 4011;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'social-intel-service' },
  transports: [new winston.transports.Console()]
});

const groq = new OpenAI({
  apiKey:  process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

let signalsCollection:  Collection;

async function connectMongo() {
  const client = new MongoClient(process.env.MONGO_URI || 'mongodb://localhost:27017');
  await client.connect();
  const db             = client.db();
  signalsCollection    = db.collection('social_signals');
  await signalsCollection.createIndex({ disasterId: 1, processedAt: -1 });
  await signalsCollection.createIndex({ verificationStatus: 1 });
  await signalsCollection.createIndex({ 'location': '2dsphere' });
  await signalsCollection.createIndex({ processedAt: 1 }, { expireAfterSeconds: 86400 * 30 }); // 30-day TTL
  logger.info('MongoDB connected');
}
connectMongo().catch(err => logger.error('MongoDB failed', { err }));

const kafka    = new Kafka({ clientId: 'social-intel-service', brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',') });
let producer: Producer;
let consumer: Consumer;

async function initKafka(attempt = 1, maxAttempts = 10): Promise<void> {
  try {
    producer = kafka.producer();
    consumer = kafka.consumer({ groupId: 'social-intel-group' });
    await producer.connect();
    await consumer.connect();
    // Consume inbound social signals from ingestion layer
    await consumer.subscribe({ topic: 'social.raw_signal', fromBeginning: false });

    await consumer.run({
      eachMessage: async ({ message }) => {
        try {
          const signal = JSON.parse(message.value?.toString() || '{}');
          await processSignal(signal);
        } catch (err) {
          logger.error('Signal processing error', { err });
        }
      }
    });
    logger.info('Kafka consumers started');
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
    logger.error(`Kafka init gave up after ${maxAttempts} attempts -- social signal processing will not work until this service is restarted`);
  }
}
initKafka();

// ─── NLP classification system prompt ────────────────────────────────────────
const NLP_SYSTEM = `You are the AEGIS social intelligence NLP engine. Analyze social media posts and emergency communications to:
1. Classify disaster category and severity
2. Detect distress signals and SOS needs
3. Verify credibility (official vs citizen vs rumour)
4. Extract location and people count
5. Identify emerging crisis patterns

Always respond with a valid JSON object only. No markdown, no explanations.`;

// ─── Process incoming signal ──────────────────────────────────────────────────
async function processSignal(rawSignal: {
  id?: string; platform: string; content: string; author?: string;
  lat?: number; lng?: number; hashtags?: string[]; postedAt?: string;
  disasterId?: string;
}) {
  const prompt = `Analyze this social media post about a potential disaster:

Platform: ${rawSignal.platform}
Content: "${rawSignal.content}"
${rawSignal.hashtags?.length ? `Hashtags: ${rawSignal.hashtags.join(', ')}` : ''}
${rawSignal.lat && rawSignal.lng ? `Location: ${rawSignal.lat}, ${rawSignal.lng}` : ''}

Respond ONLY with this JSON:
{
  "disasterType": "earthquake|flood|wildfire|cyclone|volcano|landslide|medical|other|none",
  "severity": "critical|high|medium|low|none",
  "isDistress": true|false,
  "isPeopleTrapped": true|false,
  "peopleCount": number_or_null,
  "credibility": "official|verified_org|citizen_likely_true|citizen_unverified|likely_rumour",
  "confidence": 0.0-1.0,
  "extractedLocation": "string_or_null",
  "actionRequired": true|false,
  "category": "distress_call|hazard_report|official_update|resource_request|misinformation|general_info",
  "keyInfo": "one sentence summary of key actionable information",
  "languageDetected": "en|tr|bn|ar|hi|es|id|tl|other"
}`;

  let classification: Record<string, unknown> = {
    disasterType:  'other',
    severity:      'low',
    isDistress:    false,
    isPeopleTrapped: false,
    credibility:   'citizen_unverified',
    confidence:    0.5,
    actionRequired:false,
    category:      'general_info',
    keyInfo:       'Signal received and logged',
    languageDetected: 'en'
  };

  try {
    const response = await groq.chat.completions.create({
      model:       GROQ_MODEL,
      max_tokens:  400,
      temperature: 0.2,
      messages: [
        { role: 'system', content: NLP_SYSTEM },
        { role: 'user',   content: prompt }
      ]
    });

    const text    = response.choices[0]?.message?.content || '';
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim();
    classification = JSON.parse(cleaned);
  } catch (err) {
    logger.warn('NLP classification failed, using defaults', { err });
  }

  const verificationStatus = classification.credibility === 'official' || classification.credibility === 'verified_org'
    ? 'verified'
    : classification.credibility === 'likely_rumour'
    ? 'false'
    : 'unverified';

  const processedSignal = {
    id:                 rawSignal.id || uuidv4(),
    platform:           rawSignal.platform,
    content:            rawSignal.content,
    author:             rawSignal.author,
    hashtags:           rawSignal.hashtags || [],
    disasterId:         rawSignal.disasterId,
    location:           rawSignal.lat && rawSignal.lng ? { type: 'Point', coordinates: [rawSignal.lng, rawSignal.lat] } : undefined,
    aiCategory:         classification.disasterType,
    aiSeverity:         classification.severity,
    aiConfidence:       classification.confidence,
    isDistress:         classification.isDistress,
    isPeopleTrapped:    classification.isPeopleTrapped,
    estimatedPeople:    classification.peopleCount,
    verificationStatus,
    credibility:        classification.credibility,
    category:           classification.category,
    keyInfo:            classification.keyInfo,
    languageDetected:   classification.languageDetected,
    actionRequired:     classification.actionRequired,
    extractedLocation:  classification.extractedLocation,
    postedAt:           rawSignal.postedAt || new Date().toISOString(),
    processedAt:        new Date()
  };

  if (signalsCollection) {
    await signalsCollection.replaceOne(
      { id: processedSignal.id },
      processedSignal,
      { upsert: true }
    );
  }

  // If distress signal detected — publish high-priority event. Best-effort
  // only, since the signal is already durably saved to MongoDB above.
  if (processedSignal.isDistress && processedSignal.aiSeverity === 'critical' && producer) {
    try {
      await producer.send({
        topic: 'social.distress_detected',
        messages: [{ key: processedSignal.id, value: JSON.stringify({
          eventId:   uuidv4(), eventType: 'social.distress_detected',
          timestamp: new Date().toISOString(), source: 'social-intel-service',
          payload:   processedSignal
        })}]
      });
      logger.info('Distress signal published', { id: processedSignal.id, platform: processedSignal.platform });
    } catch (err) {
      logger.warn('Signal saved but Kafka publish failed', {
        id: processedSignal.id, err: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return processedSignal;
}

app.use(express.json());

// ─── POST /social/ingest — receive signal from collector ─────────────────────
app.post('/social/ingest', async (req: Request, res: Response) => {
  const schema = z.object({
    platform:   z.enum(['twitter','facebook','instagram','whatsapp','telegram','reliefweb','other']),
    content:    z.string().min(1).max(5000),
    author:     z.string().optional(),
    lat:        z.number().optional(),
    lng:        z.number().optional(),
    hashtags:   z.array(z.string()).optional().default([]),
    postedAt:   z.string().optional(),
    disasterId: z.string().uuid().optional(),
    externalId: z.string().optional()
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const result = await processSignal({ id: uuidv4(), ...parsed.data });
    res.status(201).json({ status: 'success', data: result });
  } catch (err) {
    logger.error('Ingest error', { err });
    res.status(500).json({ status: 'error', message: 'Signal processing failed' });
  }
});

// ─── GET /social — list signals ───────────────────────────────────────────────
const socialQuerySchema = z.object({
  disasterId: z.string().optional(),
  platform:   z.string().optional(),
  verified:   z.enum(['true', 'false']).optional(),
  distress:   z.enum(['true', 'false']).optional(),
  severity:   z.string().optional(),
  limit:      z.coerce.number().int().positive().max(100).default(50),
  page:       z.coerce.number().int().positive().default(1)
});

app.get('/social', async (req: Request, res: Response) => {
  const parsed = socialQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', message: 'Invalid query parameters', details: parsed.error.flatten() });
    return;
  }
  const { disasterId, platform, verified, distress, severity, limit, page } = parsed.data;

  // Each field is guaranteed a plain string/enum by the schema above, so this
  // filter object can't be polluted with Mongo operators via query params
  // (e.g. ?disasterId[$ne]=1), which is what made the previous version
  // vulnerable to NoSQL injection.
  const filter: Record<string, unknown> = {};
  if (disasterId) filter.disasterId = disasterId;
  if (platform)   filter.platform   = platform;
  if (distress === 'true') filter.isDistress = true;
  if (severity)   filter.aiSeverity = severity;
  if (verified === 'true')  filter.verificationStatus = 'verified';
  if (verified === 'false') filter.verificationStatus = { $in: ['unverified', 'investigating'] };

  const skip = (page - 1) * limit;

  try {
    if (!signalsCollection) {
      res.status(503).json({ status: 'error', message: 'Signal store unavailable' });
      return;
    }

    const [items, total] = await Promise.all([
      signalsCollection.find(filter)
        .sort({ processedAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      signalsCollection.countDocuments(filter)
    ]);

    res.json({
      status: 'success',
      data:   items,
      total,
      page,
      hasMore:skip + items.length < total
    });
  } catch (err) {
    logger.error('List signals error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch signals' });
  }
});

// ─── GET /social/stats ────────────────────────────────────────────────────────
app.get('/social/stats', async (_req, res) => {
  try {
    if (!signalsCollection) {
      res.json({ status: 'success', data: {} });
      return;
    }

    const since = new Date(Date.now() - 60 * 60 * 1000); // last hour

    const [total, distress, verified, byPlatform, bySeverity] = await Promise.all([
      signalsCollection.countDocuments({ processedAt: { $gte: since } }),
      signalsCollection.countDocuments({ processedAt: { $gte: since }, isDistress: true }),
      signalsCollection.countDocuments({ processedAt: { $gte: since }, verificationStatus: 'verified' }),
      signalsCollection.aggregate([
        { $match: { processedAt: { $gte: since } } },
        { $group: { _id: '$platform', count: { $sum: 1 } } }
      ]).toArray(),
      signalsCollection.aggregate([
        { $match: { processedAt: { $gte: since } } },
        { $group: { _id: '$aiSeverity', count: { $sum: 1 } } }
      ]).toArray()
    ]);

    const verificationRate = total > 0 ? Math.round((verified / total) * 100 * 10) / 10 : 0;

    res.json({
      status: 'success',
      data: {
        last_hour: { total, distress, verified, verificationRate },
        by_platform: Object.fromEntries(byPlatform.map(b => [b._id, b.count])),
        by_severity: Object.fromEntries(bySeverity.map(b => [b._id, b.count]))
      }
    });
  } catch (err) {
    logger.error('Stats error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch stats' });
  }
});

// ─── PATCH /social/:id/verify ─────────────────────────────────────────────────
app.patch('/social/:id/verify', async (req: Request, res: Response) => {
  const role = req.headers['x-user-role'] as string;
  if (!['global_admin','national_admin','regional_admin','emergency_coordinator','research_analyst'].includes(role)) {
    res.status(403).json({ status: 'error', message: 'Insufficient permissions' });
    return;
  }

  const { status } = req.body;
  if (!['verified','investigating','false'].includes(status)) {
    res.status(400).json({ status: 'error', message: 'Invalid verification status' });
    return;
  }

  try {
    if (!signalsCollection) {
      res.status(503).json({ status: 'error', message: 'Signal store unavailable' });
      return;
    }

    const result = await signalsCollection.findOneAndUpdate(
      { id: req.params.id },
      { $set: { verificationStatus: status, verifiedAt: new Date(), verifiedBy: req.headers['x-user-id'] } },
      { returnDocument: 'after' }
    );

    if (!result) {
      res.status(404).json({ status: 'error', message: 'Signal not found' });
      return;
    }

    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('Verify error', { err });
    res.status(500).json({ status: 'error', message: 'Verification update failed' });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'social-intel-service' });
});

app.listen(PORT, () => logger.info(`Social intelligence service running on port ${PORT}`));
export { app };
