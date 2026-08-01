// ─── AEGIS GLOBAL — API Gateway ──────────────────────────────────────────────
import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { createClient } from 'redis';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import winston from 'winston';

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── Logger ──────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'gateway' },
  transports: [new winston.transports.Console({
    format: winston.format.combine(winston.format.colorize(), winston.format.simple())
  })]
});

// ─── Redis client ─────────────────────────────────────────────────────────────
const redis = createClient({ url: process.env.REDIS_URL });
redis.connect().catch(err => logger.error('Redis connection failed', { err }));

// ─── Service registry ─────────────────────────────────────────────────────────
const SERVICES: Record<string, string> = {
  auth:          process.env.AUTH_SERVICE_URL         || 'http://localhost:4001',
  alerts:        process.env.ALERT_SERVICE_URL        || 'http://localhost:4002',
  gis:           process.env.GIS_SERVICE_URL          || 'http://localhost:4003',
  predictions:   process.env.PREDICTION_SERVICE_URL   || 'http://localhost:4004',
  sos:           process.env.SOS_SERVICE_URL          || 'http://localhost:4005',
  notifications: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:4006',
  resources:     process.env.RESOURCE_SERVICE_URL     || 'http://localhost:4007',
  ai:            process.env.AI_SERVICE_URL           || 'http://localhost:4009',
  historical:    process.env.HISTORICAL_SERVICE_URL   || 'http://localhost:4010',
  social:        process.env.SOCIAL_INTEL_SERVICE_URL || 'http://localhost:4011',
};

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Request-ID','X-API-Key']
}));
app.use(compression());
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// ─── Health check (no auth needed) ───────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const redisOk = await redis.ping().then(() => true).catch(() => false);
  res.json({ status: 'ok', service: 'aegis-gateway', version: '3.0.0', timestamp: new Date().toISOString(), redis: redisOk });
});

// ─── Proxy factory ────────────────────────────────────────────────────────────
// stripPrefix: what to remove from the incoming path
// addPrefix:   what the downstream service expects instead (defaults to same as last segment)
function makeProxy(target: string, stripPrefix: string, addPrefix?: string) {
  const downstream = addPrefix !== undefined ? addPrefix : '/' + stripPrefix.split('/').filter(Boolean).pop();
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    selfHandleResponse: false,
    pathRewrite: (path: string) => {
      // Express already strips the mount prefix (stripPrefix) from req.url
      // before this middleware ever sees it, so `path` here is ALREADY
      // relative (e.g. '/login', '/abc123', or '' for the bare mount path).
      // Do NOT slice stripPrefix off again — that double-strips and
      // collapses everything to '', which is what caused "Cannot POST /".
      return downstream + path;
    },
    on: {
      error: (err, _req, res) => {
        logger.error('Proxy error', { target, err: (err as Error).message });
        try {
          (res as Response).status(502).json({ status: 'error', message: 'Service unavailable' });
        } catch { /* headers already sent */ }
      }
    }
  });
}

// ─── Rate limiting ──────────────────────────────────────────────────────────
// Placed here, not in downstream services, because the gateway is the only
// component that ever sees a real client IP. Every request downstream
// services receive comes from the gateway's own proxy, so a rate limiter
// there only ever sees ONE IP (the gateway's) shared across every real user —
// e.g. auth-service's existing login limiter is effectively a single
// 10-attempts-per-15-min bucket for the entire user base combined, not
// per-user brute-force protection, because it's always reached via this
// proxy. These gateway-level limiters are the ones that actually work.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { status: 'error', message: 'Too many attempts — please wait before trying again' }
});
const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests — please slow down' }
});
const sosLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { status: 'error', message: 'Too many SOS submissions from this connection — if this is a genuine ongoing emergency, contact local emergency services directly' }
});

// ─── PUBLIC routes (no auth check) ───────────────────────────────────────────
// Auth service — strip /api/v1/auth, auth-service routes are at /login /register etc
app.post('/api/v1/auth/login',    authLimiter);
app.post('/api/v1/auth/register', authLimiter);
app.use('/api/v1/auth', makeProxy(SERVICES.auth, '/api/v1/auth', ''));

// Public disaster/alert reads
app.use('/api/v1/disasters/public', publicReadLimiter, makeProxy(SERVICES.alerts, '/api/v1/disasters/public', '/disasters/public'));
app.use('/api/v1/alerts/public',    publicReadLimiter, makeProxy(SERVICES.alerts, '/api/v1/alerts/public',    '/alerts/public'));

// Public SOS submission — a citizen in danger should never be blocked by a
// login wall. sos-service itself already treats the submitter's identity as
// optional (see isAnonymous handling), so only the creation path is public
// here; everything else under /api/v1/sos (list, stats, acknowledge,
// dispatch, resolve) still requires auth via the general proxy mount below.
//
// NOTE: this is registered with app.post at an EXACT path, not app.use as a
// prefix mount. Express only strips the mount prefix from req.url for
// app.use-style prefix mounts, not for exact-path app.METHOD routes — so
// unlike makeProxy's normal pathRewrite (which assumes that stripping already
// happened), req.path here is still the full original '/api/v1/sos'. A fixed
// rewrite avoids re-deriving that and getting '/sos/api/v1/sos'.
app.post('/api/v1/sos', sosLimiter, createProxyMiddleware({
  target: SERVICES.sos,
  changeOrigin: true,
  pathRewrite: () => '/sos',
  on: {
    error: (err, _req, res) => {
      logger.error('Proxy error', { target: SERVICES.sos, err: (err as Error).message });
      try {
        (res as Response).status(502).json({ status: 'error', message: 'Service unavailable' });
      } catch { /* headers already sent */ }
    }
  }
}));

// ─── JWT auth middleware (applied to all routes BELOW this line) ──────────────
app.use(async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ status: 'error', message: 'Missing or invalid authorization header' });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const blacklisted = await redis.get(`blacklist:${token}`).catch(() => null);
    if (blacklisted) { res.status(401).json({ status: 'error', message: 'Token revoked' }); return; }
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_jwt_secret_change_in_production') as any;
    req.headers['x-user-id']    = payload.sub;
    req.headers['x-user-role']  = payload.role;
    req.headers['x-user-email'] = payload.email;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ status: 'error', message: 'Token expired' });
    } else {
      res.status(401).json({ status: 'error', message: 'Invalid token' });
    }
  }
});

// ─── PROTECTED routes (JWT required) ─────────────────────────────────────────

// GET /api/v1/system/health — aggregates /health from every backend service.
// Powers the Admin Portal's system status panel. Admin-only since it reveals
// internal service topology (hostnames, ports).
app.get('/api/v1/system/health', async (req: Request, res: Response) => {
  const role = req.headers['x-user-role'] as string;
  if (!['global_admin', 'national_admin', 'regional_admin'].includes(role)) {
    res.status(403).json({ status: 'error', message: 'Insufficient permissions' });
    return;
  }

  const checks = await Promise.all(
    Object.entries(SERVICES).map(async ([name, url]) => {
      const started = Date.now();
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
        const body = await r.json().catch(() => ({}));
        return { name, url, ok: r.ok, status: r.ok ? 'healthy' : 'unhealthy', latencyMs: Date.now() - started, detail: body };
      } catch (err) {
        return { name, url, ok: false, status: 'unreachable', latencyMs: Date.now() - started, detail: { error: err instanceof Error ? err.message : String(err) } };
      }
    })
  );

  const gatewayRedisOk = await redis.ping().then(() => true).catch(() => false);
  checks.unshift({ name: 'gateway', url: 'self', ok: true, status: 'healthy', latencyMs: 0, detail: { redis: gatewayRedisOk } });

  const healthyCount = checks.filter(c => c.ok).length;
  res.json({
    status: 'success',
    data: {
      services: checks,
      healthyCount,
      totalCount: checks.length,
      overallStatus: healthyCount === checks.length ? 'healthy' : healthyCount === 0 ? 'critical' : 'degraded',
      checkedAt: new Date().toISOString()
    }
  });
});

app.use('/api/v1/disasters',    makeProxy(SERVICES.alerts,        '/api/v1/disasters'));
app.use('/api/v1/alerts',       makeProxy(SERVICES.alerts,        '/api/v1/alerts'));
app.use('/api/v1/predictions',  makeProxy(SERVICES.predictions,   '/api/v1/predictions'));
app.use('/api/v1/sos',          makeProxy(SERVICES.sos,           '/api/v1/sos'));
app.use('/api/v1/gis',          makeProxy(SERVICES.gis,           '/api/v1/gis'));
app.use('/api/v1/risk',         makeProxy(SERVICES.gis,           '/api/v1/risk'));
app.use('/api/v1/resources',    makeProxy(SERVICES.resources,     '/api/v1/resources'));
app.use('/api/v1/shelters',     makeProxy(SERVICES.resources,     '/api/v1/shelters'));
app.use('/api/v1/notifications',makeProxy(SERVICES.notifications, '/api/v1/notifications'));
app.use('/api/v1/ai',           makeProxy(SERVICES.ai,            '/api/v1/ai', ''));
app.use('/api/v1/historical',   makeProxy(SERVICES.historical,    '/api/v1/historical'));
app.use('/api/v1/social',       makeProxy(SERVICES.social,        '/api/v1/social'));

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ status: 'error', message: 'Route not found' }));

// ─── HTTP + WebSocket server ──────────────────────────────────────────────────
const server = createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });
const channels = new Map<string, Set<WebSocket>>();

wss.on('connection', (ws, req) => {
  const token = new URL(req.url || '/', 'ws://localhost').searchParams.get('token');
  if (token) {
    try { jwt.verify(token, process.env.JWT_SECRET || 'dev_jwt_secret_change_in_production'); }
    catch { ws.close(4001, 'Unauthorized'); return; }
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'subscribe' && msg.channel) {
        if (!channels.has(msg.channel)) channels.set(msg.channel, new Set());
        channels.get(msg.channel)!.add(ws);
        ws.send(JSON.stringify({ type: 'subscribed', channel: msg.channel }));
      }
      if (msg.type === 'unsubscribe' && msg.channel) {
        channels.get(msg.channel)?.delete(ws);
      }
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      }
    } catch { /* ignore */ }
  });

  ws.on('close', () => channels.forEach(subs => subs.delete(ws)));

  ws.send(JSON.stringify({
    type: 'connected', timestamp: new Date().toISOString(),
    channels: ['disasters','alerts','sos','predictions']
  }));
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach(ws => {
    if ((ws as any).isAlive === false) { ws.terminate(); return; }
    (ws as any).isAlive = false;
    ws.ping();
  });
}, 30_000);

server.listen(PORT, () => logger.info(`AEGIS Gateway running on port ${PORT}`));
export { app, server };
