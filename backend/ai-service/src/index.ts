// ─── AEGIS GLOBAL — AI Intelligence Service ──────────────────────────────────
import express, { Request, Response } from 'express';
import OpenAI from 'openai';
import { createClient } from 'redis';
import { MongoClient, Collection } from 'mongodb';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';

const app  = express();
const PORT = process.env.PORT || 4009;

// ─── Logger ───────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'ai-service' },
  transports: [new winston.transports.Console()]
});

// ─── Clients ──────────────────────────────────────────────────────────────────
// Groq exposes an OpenAI-compatible API — point the OpenAI SDK at Groq's base URL.
const groq = new OpenAI({
  apiKey:  process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1'
});
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const redis = createClient({ url: process.env.REDIS_URL });
// node-redis v4 clients are EventEmitters -- with no 'error' listener attached,
// any transient socket error (e.g. a brief Redis blip) becomes an uncaught
// exception and crashes the whole process instead of just logging.
redis.on('error', err => logger.error('Redis client error', { err }));
redis.connect().catch(err => logger.error('Redis failed', { err }));

let aiAnalysesCollection: Collection;
let chatHistoryCollection: Collection;

async function connectMongo() {
  try {
    const client = new MongoClient(process.env.MONGO_URI || 'mongodb://localhost:27017');
    await client.connect();
    const db               = client.db();
    aiAnalysesCollection   = db.collection('ai_analyses');
    chatHistoryCollection  = db.collection('chat_histories');
    await aiAnalysesCollection.createIndex({ disasterId: 1, createdAt: -1 });
    await chatHistoryCollection.createIndex({ sessionId: 1 });
    await chatHistoryCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });
    logger.info('MongoDB connected');
  } catch (err) {
    logger.warn('MongoDB unavailable — AI will work without history persistence', { err });
  }
}
connectMongo();

app.use(express.json({ limit: '2mb' }));

// ─── AEGIS system prompt ──────────────────────────────────────────────────────
const AEGIS_SYSTEM_PROMPT = `You are AEGIS AI — the intelligence engine embedded in AEGIS GLOBAL, the world's most advanced disaster management platform. You serve governments, emergency coordinators, NGO directors, field commanders, and first responders across 100+ countries.

Your knowledge base covers:
- All 23 disaster types: earthquakes, tsunamis, floods, flash floods, cyclones, hurricanes, typhoons, tornadoes, wildfires, volcanic eruptions, landslides, avalanches, droughts, heatwaves, cold waves, pandemics, disease outbreaks, industrial disasters, chemical leaks, nuclear incidents, infrastructure failures, terror attacks, humanitarian crises
- Global disaster history from 1900 to present (22,847 indexed events)
- Emergency response protocols (ICS, NIMS, UN Cluster System, Sphere Standards)
- Humanitarian law and coordination (OCHA, UNHCR, WFP, WHO, UNICEF, Red Cross)
- Geoscience: seismology, meteorology, hydrology, volcanology, climate science
- Disaster risk reduction: Sendai Framework 2015-2030, HFA, Paris Agreement
- Resource management, logistics, and supply chain in disaster contexts
- Medical response: mass casualty triage, WASH, disease outbreak control
- Country-level infrastructure, vulnerability, and resilience profiles for all 195 nations

Response principles:
1. Be specific and data-driven — cite magnitudes, numbers, historical precedents
2. Be actionable — give commanders and coordinators clear, prioritised next steps
3. Be concise but complete — no padding, no caveats beyond what is operationally important
4. Acknowledge uncertainty where it exists, especially for predictions
5. Consider the most vulnerable populations first (elderly, disabled, children, women)
6. Always address the immediate life-safety priority before secondary concerns

You may be asked to:
- Analyse ongoing disaster events and provide situation reports
- Compare current events with historical precedents
- Recommend resource allocation and deployment priorities
- Predict likely disaster evolution and secondary risks
- Triage SOS reports by severity and urgency
- Generate government policy briefs and strategic recommendations
- Assess country vulnerability and preparedness gaps
- Interpret satellite imagery descriptions and field reports
- Support recovery planning with evidence-based timelines and cost projections`;

// ─── Validation schemas ───────────────────────────────────────────────────────
const AnalyseSchema = z.object({
  disasterId:       z.string().uuid().optional(),
  query:            z.string().min(1).max(2000),
  context:          z.string().max(5000).optional(),
  includeHistorical:z.boolean().optional().default(false),
  outputFormat:     z.enum(['narrative', 'structured', 'brief']).optional().default('narrative'),
  sessionId:        z.string().optional()
});

const SimilaritySchema = z.object({
  disasterId:   z.string().uuid().optional(),
  disasterType: z.string(),
  magnitude:    z.number().optional(),
  country:      z.string().optional(),
  affectedPop:  z.number().optional(),
  description:  z.string().max(1000)
});

const SOSTriageSchema = z.object({
  type:        z.string(),
  description: z.string().max(2000),
  location:    z.object({ lat: z.number(), lng: z.number() }).optional(),
  peopleCount: z.number().int().positive().optional().default(1),
  disasterId:  z.string().uuid().optional()
});

const PolicyBriefSchema = z.object({
  country:       z.string(),
  focusAreas:    z.array(z.string()).optional(),
  timeHorizon:   z.string().optional().default('5 years'),
  requestedBy:   z.string().optional()
});

// ─── Cache helper ─────────────────────────────────────────────────────────────
async function getCached<T>(key: string): Promise<T | null> {
  const val = await redis.get(key);
  return val ? JSON.parse(val) : null;
}

async function setCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await redis.setEx(key, ttlSeconds, JSON.stringify(value));
}

// ─── Core AI call ─────────────────────────────────────────────────────────────
async function callClaude(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTokens = 1500,
  systemOverride?: string
): Promise<string> {
  const response = await groq.chat.completions.create({
    model:       GROQ_MODEL,
    max_tokens:  maxTokens,
    temperature: 0.4,
    messages: [
      { role: 'system', content: systemOverride || AEGIS_SYSTEM_PROMPT },
      ...messages
    ]
  });
  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error('Empty response from Groq');
  return text;
}

// ─── POST /analyse ────────────────────────────────────────────────────────────
app.post('/analyse', async (req: Request, res: Response) => {
  const parsed = AnalyseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const { disasterId, query, context, includeHistorical, outputFormat, sessionId } = parsed.data;
  const userId = req.headers['x-user-id'] as string;

  try {
    // Build prompt with context
    let userMessage = query;
    if (context) {
      userMessage = `Context:\n${context}\n\nQuery:\n${query}`;
    }
    if (includeHistorical) {
      userMessage += '\n\nPlease include relevant historical disaster comparisons in your analysis.';
    }
    if (outputFormat === 'structured') {
      userMessage += '\n\nProvide your response in a structured format with clear sections: Situation Assessment, Key Risks, Recommended Actions, and Resource Requirements.';
    }
    if (outputFormat === 'brief') {
      userMessage += '\n\nProvide a concise executive brief of no more than 150 words.';
    }

    // Load session history if provided
    let messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (sessionId && chatHistoryCollection) {
      try {
        const history = await chatHistoryCollection.findOne({ sessionId, userId });
        if (history?.messages) messages = history.messages;
      } catch { /* ignore */ }
    }

    messages.push({ role: 'user', content: userMessage });

    const analysis = await callClaude(messages, outputFormat === 'brief' ? 500 : 1500);

    // Store in history
    messages.push({ role: 'assistant', content: analysis });
    const newSessionId = sessionId || uuidv4();

    if (chatHistoryCollection) {
      try {
        if (sessionId) {
          await chatHistoryCollection.updateOne(
            { sessionId, userId },
            { $set: { messages, updatedAt: new Date() } }
          );
        } else {
          await chatHistoryCollection.insertOne({
            sessionId: newSessionId, userId, messages,
            createdAt: new Date(), updatedAt: new Date()
          });
        }
      } catch { /* ignore */ }
    }

    // Persist analysis
    const record = {
      id: uuidv4(), disasterId, query, context, analysis,
      outputFormat, sessionId: newSessionId, userId,
      modelVersion: GROQ_MODEL, createdAt: new Date()
    };
    if (aiAnalysesCollection) {
      try { await aiAnalysesCollection.insertOne(record); } catch { /* ignore */ }
    }

    logger.info('AI analysis completed', { userId, disasterId, outputFormat });

    res.json({
      status: 'success',
      data: { analysisId: record.id, analysis, sessionId: newSessionId }
    });
  } catch (err) {
    logger.error('Analysis error', { err });
    res.status(500).json({ status: 'error', message: 'AI analysis failed' });
  }
});

// ─── POST /similarity — find historical matches ───────────────────────────────
app.post('/similarity', async (req: Request, res: Response) => {
  const parsed = SimilaritySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const { disasterType, magnitude, country, affectedPop, description } = parsed.data;
  const cacheKey = `similarity:${JSON.stringify(parsed.data)}`;

  try {
    const cached = await getCached<unknown>(cacheKey);
    if (cached) { res.json({ status: 'success', data: cached, cached: true }); return; }

    const prompt = `Identify the 3-5 most similar historical disasters to this event and provide detailed analysis:

Event type: ${disasterType}
${magnitude ? `Magnitude/intensity: ${magnitude}` : ''}
${country ? `Country: ${country}` : ''}
${affectedPop ? `Estimated affected population: ${affectedPop.toLocaleString()}` : ''}
Description: ${description}

For each historical match provide:
1. Event name, date, location
2. Key statistics (deaths, economic losses, affected population)
3. Similarity factors (what makes it comparable)
4. Response lessons learned
5. How long recovery took

Then conclude with: Based on these precedents, what should response teams prioritise in the next 72 hours?`;

    const result = await callClaude([{ role: 'user', content: prompt }], 2000);
    const responseData = { similarEvents: result, query: parsed.data };

    await setCache(cacheKey, responseData, 3600); // Cache 1 hour

    res.json({ status: 'success', data: responseData });
  } catch (err) {
    logger.error('Similarity search error', { err });
    res.status(500).json({ status: 'error', message: 'Similarity search failed' });
  }
});

// ─── POST /triage/sos — real-time SOS triage ─────────────────────────────────
app.post('/triage/sos', async (req: Request, res: Response) => {
  const parsed = SOSTriageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const { type, description, location, peopleCount } = parsed.data;

  try {
    const prompt = `Triage this SOS emergency report immediately:

Emergency type: ${type}
People affected: ${peopleCount}
${location ? `GPS location: ${location.lat}, ${location.lng}` : ''}
Description: ${description}

Respond with a JSON object (no markdown) with these exact fields:
{
  "severity": "critical|high|medium|low",
  "confidenceScore": 0.0-1.0,
  "immediateActions": ["action1", "action2", "action3"],
  "recommendedTeam": "team type to dispatch",
  "estimatedEta": "X minutes/hours",
  "safetyGuidance": "immediate instructions for the person",
  "additionalRisks": ["risk1", "risk2"],
  "triageNarrative": "2-3 sentence assessment"
}`;

    const raw = await callClaude(
      [{ role: 'user', content: prompt }],
      600,
      `You are the AEGIS AI triage system. Respond only with the requested JSON. Be direct and decisive — lives depend on speed. Severity definitions: critical=life-threatening immediate threat, high=serious risk within hours, medium=significant risk within 24h, low=monitoring needed.`
    );

    let triage: Record<string, unknown>;
    try {
      const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
      triage = JSON.parse(cleaned);
    } catch {
      triage = {
        severity: 'high', confidenceScore: 0.7,
        immediateActions: ['Dispatch nearest response team', 'Attempt contact with caller'],
        recommendedTeam: 'Emergency response unit',
        estimatedEta: 'Unknown — calculating',
        safetyGuidance: 'Stay in place if safe. Signal your location visually.',
        additionalRisks: [],
        triageNarrative: raw.slice(0, 300)
      };
    }

    // Store triage result
    await aiAnalysesCollection.insertOne({
      id: uuidv4(), type: 'sos_triage', input: parsed.data, output: triage,
      modelVersion: GROQ_MODEL, createdAt: new Date()
    });

    res.json({ status: 'success', data: { triage } });
  } catch (err) {
    logger.error('SOS triage error', { err });
    res.status(500).json({ status: 'error', message: 'Triage failed' });
  }
});

// ─── POST /policy-brief ───────────────────────────────────────────────────────
app.post('/policy-brief', async (req: Request, res: Response) => {
  const parsed = PolicyBriefSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const { country, focusAreas, timeHorizon, requestedBy } = parsed.data;

  try {
    const prompt = `Generate a comprehensive government disaster risk reduction policy brief for ${country}.

Time horizon: ${timeHorizon}
${focusAreas?.length ? `Focus areas: ${focusAreas.join(', ')}` : ''}
${requestedBy ? `Requested by: ${requestedBy}` : ''}

Structure the brief as:
1. Executive Summary (3-4 sentences)
2. Current Risk Profile (top 3 disaster risks with statistical evidence)
3. Preparedness Gap Analysis (specific deficiencies vs Sendai Framework benchmarks)
4. Policy Recommendations (5 specific, prioritised, costed recommendations)
5. Implementation Roadmap (phased 12/24/36 month milestones)
6. Budget Guidance (estimated investment range and expected cost-benefit ratios)
7. International Cooperation Opportunities

Be specific to the country — reference actual geography, historical disasters, existing agencies, and real statistics.`;

    const brief = await callClaude([{ role: 'user', content: prompt }], 2500);

    const record = {
      id: uuidv4(), type: 'policy_brief', country, focusAreas, timeHorizon,
      brief, modelVersion: GROQ_MODEL, createdAt: new Date()
    };
    await aiAnalysesCollection.insertOne(record);

    res.json({ status: 'success', data: { briefId: record.id, country, brief } });
  } catch (err) {
    logger.error('Policy brief error', { err });
    res.status(500).json({ status: 'error', message: 'Policy brief generation failed' });
  }
});

// ─── GET /analyses — fetch history ───────────────────────────────────────────
app.get('/analyses', async (req: Request, res: Response) => {
  const userId     = req.headers['x-user-id'] as string;
  const { limit = '20', page = '1', disasterId } = req.query;
  const cappedLimit = Math.min(parseInt(limit as string) || 20, 100);
  const safePage     = Math.max(parseInt(page as string) || 1, 1);
  const skip = (safePage - 1) * cappedLimit;

  try {
    const filter: Record<string, unknown> = { userId };
    // Only accept a plain string here — req.query can otherwise deliver a
    // nested object (e.g. ?disasterId[$ne]=1) that would let a caller inject
    // Mongo operators into the filter.
    if (typeof disasterId === 'string') filter.disasterId = disasterId;

    const [items, total] = await Promise.all([
      aiAnalysesCollection.find(filter).sort({ createdAt: -1 })
        .skip(skip).limit(cappedLimit).toArray(),
      aiAnalysesCollection.countDocuments(filter)
    ]);

    res.json({
      status: 'success',
      data: items,
      total,
      page: safePage,
      limit: cappedLimit
    });
  } catch (err) {
    logger.error('Fetch analyses error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch analyses' });
  }
});

// ─── POST /situation-report — structured sitrep ───────────────────────────────
app.post('/situation-report', async (req: Request, res: Response) => {
  const { disasterData, timeframe = '6 hours', audience = 'government' } = req.body;
  if (!disasterData) {
    res.status(400).json({ status: 'error', message: 'disasterData is required' });
    return;
  }

  try {
    const prompt = `Generate a formal situation report (SITREP) for the following disaster:

${JSON.stringify(disasterData, null, 2)}

Timeframe covered: Last ${timeframe}
Target audience: ${audience}

Format as a professional SITREP with:
1. BLUF (Bottom Line Up Front) — 2 sentences max
2. Situation (current facts, verified data)
3. Mission (current operational objectives)
4. Execution (what teams are doing, key actions completed)
5. Administration and Logistics (resources, supply status)
6. Command and Signal (coordination, comms status)
7. Critical information requirements (what is unknown but needed)
8. Next update scheduled: [time recommendation]`;

    const sitrep = await callClaude([{ role: 'user', content: prompt }], 1500);

    res.json({
      status: 'success',
      data: {
        sitrep,
        generatedAt: new Date().toISOString(),
        disasterId: disasterData.id,
        audience
      }
    });
  } catch (err) {
    logger.error('Sitrep error', { err });
    res.status(500).json({ status: 'error', message: 'Situation report generation failed' });
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const redisOk = await redis.ping().then(() => true).catch(() => false);
  const mongoOk = !!aiAnalysesCollection;
  res.json({ status: 'ok', service: 'ai-service', redis: redisOk, mongo: mongoOk });
});

app.listen(PORT, () => logger.info(`AI service running on port ${PORT}`));

export { app };
