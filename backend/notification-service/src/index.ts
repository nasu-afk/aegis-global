// ─── AEGIS GLOBAL — Notification Service ─────────────────────────────────────
import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import { Kafka, Consumer, Producer } from 'kafkajs';
import { createClient } from 'redis';
import twilio from 'twilio';
import sgMail from '@sendgrid/mail';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';

const app  = express();
const PORT = process.env.PORT || 4006;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'notification-service' },
  transports: [new winston.transports.Console()]
});

// ─── Clients ──────────────────────────────────────────────────────────────────
const db    = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const redis = createClient({ url: process.env.REDIS_URL });
redis.connect().catch(err => logger.error('Redis failed', { err }));

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '');

// ─── Kafka ────────────────────────────────────────────────────────────────────
const kafka    = new Kafka({ clientId: 'notification-service', brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(',') });
let producer: Producer;
let consumer: Consumer;

async function initKafka(attempt = 1, maxAttempts = 10): Promise<void> {
  try {
    producer = kafka.producer();
    consumer = kafka.consumer({ groupId: 'notification-service-group' });
    await producer.connect();
    await consumer.connect();
    await consumer.subscribe({ topic: 'alert.issued',  fromBeginning: false });
    await consumer.subscribe({ topic: 'sos.created',   fromBeginning: false });
    await consumer.subscribe({ topic: 'disaster.created', fromBeginning: false });

    await consumer.run({
      eachMessage: async ({ topic, message }) => {
        const event = JSON.parse(message.value?.toString() || '{}');
        logger.info('Kafka event received', { topic, eventType: event.eventType });

        if (topic === 'alert.issued')     await processAlertEvent(event.payload);
        if (topic === 'sos.created')      await processSOSEvent(event.payload);
        if (topic === 'disaster.created') await processDisasterEvent(event.payload);
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
    logger.error(`Kafka init gave up after ${maxAttempts} attempts -- notifications will not fire until this service is restarted`);
  }
}
initKafka();

app.use(express.json());

// ─── Channel priority matrix ──────────────────────────────────────────────────
const CHANNEL_PRIORITY: Record<string, string[]> = {
  critical:   ['push', 'sms', 'voice', 'whatsapp'],
  high:       ['push', 'sms', 'whatsapp'],
  medium:     ['push', 'sms'],
  low:        ['push'],
  monitoring: ['push']
};

// ─── Translation helper (DeepL-like placeholder) ──────────────────────────────
const COMMON_PHRASES: Record<string, Record<string, string>> = {
  earthquake_warning: {
    en: 'Earthquake warning — move to open ground immediately',
    tr: 'Deprem uyarısı — hemen açık alana çıkın',
    bn: 'ভূমিকম্প সতর্কতা — অবিলম্বে খোলা জায়গায় যান',
    ar: 'تحذير زلزال — انتقل إلى أرض مفتوحة فوراً',
    hi: 'भूकंप चेतावनी — तुरंत खुले स्थान पर जाएं',
    es: 'Alerta de terremoto — muévase a terreno abierto inmediatamente',
    fr: 'Alerte séisme — déplacez-vous immédiatement en terrain dégagé',
    id: 'Peringatan gempa — segera pindah ke tanah terbuka',
  }
};

async function translate(text: string, targetLang: string): Promise<string> {
  // In production, integrate DeepL API or AWS Translate here
  // For now, return common phrases if known, else original
  const lower = text.toLowerCase().replace(/\s+/g, '_');
  if (COMMON_PHRASES[lower]?.[targetLang]) return COMMON_PHRASES[lower][targetLang];
  return text; // fallback to original
}

// ─── Push notification (FCM) ──────────────────────────────────────────────────
async function sendPushNotification(params: {
  tokens: string[]; title: string; body: string; data?: Record<string, string>; alertId: string;
}): Promise<{ sent: number; failed: number }> {
  const FCM_URL = 'https://fcm.googleapis.com/fcm/send';
  const key     = process.env.FCM_SERVER_KEY;
  if (!key) { logger.warn('FCM key not configured'); return { sent: 0, failed: params.tokens.length }; }

  let sent = 0, failed = 0;

  // Batch tokens into groups of 500 (FCM limit)
  const batches = [];
  for (let i = 0; i < params.tokens.length; i += 500) {
    batches.push(params.tokens.slice(i, i + 500));
  }

  for (const batch of batches) {
    try {
      const response = await fetch(FCM_URL, {
        method:  'POST',
        headers: { 'Authorization': `key=${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          registration_ids: batch,
          notification: { title: params.title, body: params.body, sound: 'emergency' },
          data:         { alertId: params.alertId, ...params.data },
          priority:     'high',
          android:      { priority: 'high', notification: { channel_id: 'aegis_emergency' } },
          apns:         { headers: { 'apns-priority': '10' } }
        })
      });

      if (response.ok) {
        const result = await response.json() as any;
        sent   += result.success || 0;
        failed += result.failure || 0;
      } else {
        failed += batch.length;
      }
    } catch (err) {
      logger.error('FCM batch failed', { err });
      failed += batch.length;
    }
  }

  return { sent, failed };
}

// ─── SMS delivery ─────────────────────────────────────────────────────────────
async function sendSMS(params: {
  phones: string[]; message: string; alertId: string;
}): Promise<{ sent: number; failed: number }> {
  if (!process.env.TWILIO_ACCOUNT_SID) {
    logger.warn('Twilio not configured');
    return { sent: 0, failed: params.phones.length };
  }

  let sent = 0, failed = 0;
  const FROM = process.env.TWILIO_PHONE || '+15005550006';

  // Process concurrently with a semaphore of 10
  const chunks: string[][] = [];
  for (let i = 0; i < params.phones.length; i += 10) chunks.push(params.phones.slice(i, i + 10));

  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (to) => {
      try {
        await twilioClient.messages.create({
          to, from: FROM,
          body: `[AEGIS ALERT] ${params.message.slice(0, 140)} aegis.io/a/${params.alertId.slice(0, 8)}`
        });
        sent++;
      } catch (err: any) {
        logger.warn('SMS failed', { to, error: err.message });
        failed++;
      }
    }));
  }

  return { sent, failed };
}

// ─── Email delivery ───────────────────────────────────────────────────────────
async function sendEmail(params: {
  emails: string[]; subject: string; body: string; htmlBody?: string; alertId: string;
}): Promise<{ sent: number; failed: number }> {
  if (!process.env.SENDGRID_API_KEY) {
    logger.warn('SendGrid not configured');
    return { sent: 0, failed: params.emails.length };
  }

  const chunks: string[][] = [];
  for (let i = 0; i < params.emails.length; i += 100) chunks.push(params.emails.slice(i, i + 100));

  let sent = 0, failed = 0;

  for (const chunk of chunks) {
    try {
      await sgMail.sendMultiple({
        to:      chunk,
        from:    { name: 'AEGIS GLOBAL Emergency System', email: 'alerts@aegisglobal.io' },
        subject: `[AEGIS] ${params.subject}`,
        text:    params.body,
        html:    params.htmlBody || `<p>${params.body}</p>`,
        headers: { 'X-Alert-ID': params.alertId, 'X-Priority': '1' }
      });
      sent += chunk.length;
    } catch (err: any) {
      logger.error('Email batch failed', { error: err.message });
      failed += chunk.length;
    }
  }

  return { sent, failed };
}

// ─── Voice call (Twilio TwiML) ────────────────────────────────────────────────
async function sendVoiceCall(params: {
  phones: string[]; message: string;
}): Promise<{ sent: number; failed: number }> {
  if (!process.env.TWILIO_ACCOUNT_SID) return { sent: 0, failed: params.phones.length };

  let sent = 0, failed = 0;

  for (const to of params.phones) {
    try {
      await twilioClient.calls.create({
        to,
        from: process.env.TWILIO_PHONE || '+15005550006',
        twiml: `<Response>
          <Say voice="Polly.Joanna" language="en-US">
            This is an emergency alert from AEGIS GLOBAL. ${params.message}
            This message will repeat.
          </Say>
          <Pause length="1"/>
          <Say voice="Polly.Joanna" language="en-US">
            ${params.message}
          </Say>
        </Response>`
      });
      sent++;
    } catch (err: any) {
      logger.warn('Voice call failed', { to, error: err.message });
      failed++;
    }
  }

  return { sent, failed };
}

// ─── Core alert processor ─────────────────────────────────────────────────────
async function processAlertEvent(alert: any) {
  if (!alert?.id) return;
  logger.info('Processing alert', { alertId: alert.id, severity: alert.severity });

  const startTime = Date.now();
  const channels  = CHANNEL_PRIORITY[alert.severity] || ['push'];

  // Fetch recipients based on geo targeting
  let pushTokens: string[] = [];
  let phoneNumbers: string[]= [];
  let emails: string[]      = [];

  try {
    if (alert.geo_center && alert.radius_km) {
      const users = await db.query(
        `SELECT push_token, phone, email, preferred_lang
         FROM users
         WHERE is_active = TRUE
           AND ST_DWithin(home_location, ST_GeographyFromText($1), $2)`,
        [`POINT(${alert.geo_center.coordinates[0]} ${alert.geo_center.coordinates[1]})`,
         alert.radius_km * 1000]
      );

      for (const u of users.rows) {
        if (u.push_token) pushTokens.push(u.push_token);
        if (u.phone)      phoneNumbers.push(u.phone);
        if (u.email)      emails.push(u.email);
      }
    }
  } catch (err) {
    logger.error('Failed to fetch recipients', { err });
  }

  const totalTargeted = Math.max(pushTokens.length, 1);
  let totalDelivered  = 0;
  const logEntries: any[] = [];

  // Send across channels based on severity
  const deliveryPromises: Promise<void>[] = [];

  if (channels.includes('push') && pushTokens.length > 0) {
    deliveryPromises.push(
      sendPushNotification({
        tokens: pushTokens, title: alert.title, body: alert.message, alertId: alert.id
      }).then(({ sent }) => { totalDelivered += sent; })
    );
  }

  if (channels.includes('sms') && phoneNumbers.length > 0) {
    deliveryPromises.push(
      sendSMS({ phones: phoneNumbers, message: alert.message, alertId: alert.id })
        .then(({ sent }) => { totalDelivered += sent; })
    );
  }

  if (channels.includes('voice') && phoneNumbers.length > 0 && alert.severity === 'critical') {
    deliveryPromises.push(
      sendVoiceCall({ phones: phoneNumbers.slice(0, 100), message: alert.message })
        .then(({ sent }) => { totalDelivered += sent; })
    );
  }

  if (channels.includes('email') && emails.length > 0) {
    deliveryPromises.push(
      sendEmail({
        emails, subject: alert.title, body: alert.message, alertId: alert.id
      }).then(({ sent }) => { totalDelivered += sent; })
    );
  }

  await Promise.allSettled(deliveryPromises);

  const latencyMs    = Date.now() - startTime;
  const deliveryRate = totalTargeted > 0 ? (totalDelivered / totalTargeted) * 100 : 0;

  // Update alert delivery stats
  try {
    await db.query(
      `UPDATE alerts
       SET recipients_targeted = $1, recipients_delivered = $2, delivery_rate = $3
       WHERE id = $4`,
      [totalTargeted, totalDelivered, deliveryRate, alert.id]
    );
  } catch (err) {
    logger.error('Failed to update alert stats', { err });
  }

  logger.info('Alert delivery complete', {
    alertId:    alert.id,
    targeted:   totalTargeted,
    delivered:  totalDelivered,
    deliveryRate: deliveryRate.toFixed(1) + '%',
    latencyMs
  });

  // Cache delivery stats
  await redis.setEx(
    `alert:delivery:${alert.id}`, 3600,
    JSON.stringify({ targeted: totalTargeted, delivered: totalDelivered, deliveryRate, latencyMs })
  );
}

async function processSOSEvent(sos: any) {
  if (sos?.severity !== 'critical') return;

  // Notify emergency coordinators in the region
  try {
    const coordinators = await db.query(
      `SELECT push_token, phone, email FROM users
       WHERE role IN ('emergency_coordinator','global_admin','national_admin')
         AND is_active = TRUE
         AND ST_DWithin(home_location, ST_GeographyFromText($1), 200000)`,
      [`POINT(${sos.lng} ${sos.lat})`]
    );

    const tokens = coordinators.rows.map((u: any) => u.push_token).filter(Boolean);
    if (tokens.length > 0) {
      await sendPushNotification({
        tokens,
        title: '🚨 Critical SOS Report',
        body:  `${sos.type.replace(/_/g, ' ')} — ${sos.peopleCount} person(s) affected`,
        data:  { sosId: sos.id, type: 'sos_critical' },
        alertId: sos.id
      });
    }
  } catch (err) {
    logger.error('SOS coordinator notification failed', { err });
  }
}

async function processDisasterEvent(disaster: any) {
  // Log to audit
  logger.info('New disaster event — may require manual alert issuance', {
    disasterId: disaster.id, type: disaster.type, severity: disaster.severity
  });
}

// ─── REST API endpoints ───────────────────────────────────────────────────────

// POST /notifications/send — manual notification send
app.post('/notifications/send', async (req: Request, res: Response) => {
  const schema = z.object({
    channel:  z.enum(['push','sms','email','voice']),
    targets:  z.array(z.string()).min(1).max(1000),
    title:    z.string().max(200),
    message:  z.string().max(1000),
    alertId:  z.string().optional().default(uuidv4())
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'error', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const { channel, targets, title, message, alertId } = parsed.data;

  try {
    let result = { sent: 0, failed: 0 };

    switch (channel) {
      case 'push':  result = await sendPushNotification({ tokens: targets, title, body: message, alertId }); break;
      case 'sms':   result = await sendSMS({ phones: targets, message, alertId }); break;
      case 'email': result = await sendEmail({ emails: targets, subject: title, body: message, alertId }); break;
      case 'voice': result = await sendVoiceCall({ phones: targets, message }); break;
    }

    res.json({ status: 'success', data: { ...result, channel, alertId } });
  } catch (err) {
    logger.error('Manual send error', { err });
    res.status(500).json({ status: 'error', message: 'Notification send failed' });
  }
});

// GET /notifications/stats
app.get('/notifications/stats', async (_req, res) => {
  try {
    const result = await db.query(`
      SELECT
        COUNT(*)                                                AS total_sent,
        COUNT(*) FILTER (WHERE status = 'delivered')           AS total_delivered,
        AVG(latency_ms)                                        AS avg_latency_ms,
        COUNT(*) FILTER (WHERE channel = 'push')               AS push_count,
        COUNT(*) FILTER (WHERE channel = 'sms')                AS sms_count,
        COUNT(*) FILTER (WHERE channel = 'email')              AS email_count,
        COUNT(*) FILTER (WHERE channel = 'voice')              AS voice_count
      FROM notification_log
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

    res.json({ status: 'success', data: result.rows[0] });
  } catch (err) {
    logger.error('Stats error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch stats' });
  }
});

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'notification-service' });
});

app.listen(PORT, () => logger.info(`Notification service running on port ${PORT}`));
export { app };
