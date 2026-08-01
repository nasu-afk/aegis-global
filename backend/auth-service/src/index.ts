// ─── AEGIS GLOBAL — Authentication Service ───────────────────────────────────
import express, { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createClient } from 'redis';
import { Pool } from 'pg';
import { authenticator } from 'otplib';
import qrcode from 'qrcode';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import winston from 'winston';
import rateLimit from 'express-rate-limit';

const app  = express();
const PORT = process.env.PORT || 4001;

// ─── Logger ──────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'auth-service' },
  transports: [new winston.transports.Console()]
});

// ─── DB + Redis ───────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000
});

const redis = createClient({ url: process.env.REDIS_URL });
// node-redis v4 clients are EventEmitters -- with no 'error' listener attached,
// any transient socket error (e.g. a brief Redis blip) becomes an uncaught
// exception and crashes the whole process instead of just logging.
redis.on('error', err => logger.error('Redis client error', { err }));
redis.connect().catch(err => logger.error('Redis failed', { err }));

// ─── Constants ────────────────────────────────────────────────────────────────
const SALT_ROUNDS          = 12;
// Fallback MUST match gateway's fallback exactly — if this service and the
// gateway ever diverge on what secret they fall back to (e.g. one runs
// outside this exact docker-compose setup), tokens issued here would fail
// verification everywhere else with an opaque "Invalid token", not an error
// that points at the actual cause. Also warn loudly if the default is ever
// actually in use, since a well-known dev secret is a real risk if this ever
// ships without JWT_SECRET set.
const JWT_SECRET_FALLBACK  = 'dev_jwt_secret_change_in_production';
const JWT_SECRET           = process.env.JWT_SECRET || JWT_SECRET_FALLBACK;
if (!process.env.JWT_SECRET) {
  logger.warn('JWT_SECRET not set — falling back to the shared dev default. Set JWT_SECRET before any real deployment.');
}
const JWT_EXPIRES_IN       = process.env.JWT_EXPIRES_IN       || '15m';
const REFRESH_EXPIRES_IN   = process.env.REFRESH_EXPIRES_IN   || '7d';
const REFRESH_EXPIRES_SEC  = 7 * 24 * 60 * 60;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

// ─── Validation schemas ───────────────────────────────────────────────────────
const RegisterSchema = z.object({
  email:        z.string().email().max(255),
  password:     z.string().min(8).max(128).regex(
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
    'Password must contain uppercase, lowercase, number, and special character'
  ),
  name:         z.string().min(1).max(255),
  role:         z.enum(['citizen','first_responder','research_analyst','ngo_coordinator']).optional().default('citizen'),
  organisation: z.string().max(255).optional(),
  country:      z.string().length(2).optional(),
  phone:        z.string().max(50).optional(),
  preferredLang:z.string().max(10).optional().default('en')
});

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string(),
  totpCode: z.string().length(6).optional()
});

const RefreshSchema = z.object({
  refreshToken: z.string()
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword:     z.string().min(8).max(128)
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateAccessToken(user: { id: string; email: string; role: string }): string {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN } as any
  );
}

function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex');
}

async function hashRefreshToken(token: string): Promise<string> {
  return bcrypt.hash(token, 10);
}

async function storeRefreshToken(
  userId: string, token: string, ipAddress?: string, userAgent?: string
): Promise<void> {
  const hash      = await hashRefreshToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_SEC * 1000);
  await db.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uuidv4(), userId, hash, expiresAt, ipAddress, userAgent]
  );
}

async function revokeUserTokens(userId: string): Promise<void> {
  await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
}

function validate<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: result.error.flatten().fieldErrors
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// POST /register
app.post('/register', validate(RegisterSchema), async (req: Request, res: Response) => {
  const { email, password, name, role, organisation, country, phone, preferredLang } = req.body;

  try {
    // Check duplicate
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      res.status(409).json({ status: 'error', message: 'Email already registered' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await db.query(
      `INSERT INTO users (id, email, password_hash, name, role, organisation, country, phone, preferred_lang, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING id, email, name, role, organisation, country, preferred_lang, created_at`,
      [uuidv4(), email, passwordHash, name, role, organisation, country, phone, preferredLang]
    );

    const user        = result.rows[0];
    const accessToken = generateAccessToken(user);
    const refreshTok  = generateRefreshToken();

    await storeRefreshToken(user.id, refreshTok, req.ip, req.headers['user-agent']);

    // Audit
    await db.query(
      `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, new_value, ip_address)
       VALUES ($1, $2, 'user.register', 'user', $3, $4, $5)`,
      [uuidv4(), user.id, user.id, JSON.stringify({ email, role }), req.ip]
    );

    logger.info('User registered', { userId: user.id, email, role });

    res.status(201).json({
      status: 'success',
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        tokens: { accessToken, refreshToken: refreshTok, expiresIn: 900, tokenType: 'Bearer' }
      }
    });
  } catch (err) {
    logger.error('Registration error', { err });
    res.status(500).json({ status: 'error', message: 'Registration failed' });
  }
});

// POST /login
app.post('/login', loginLimiter, validate(LoginSchema), async (req: Request, res: Response) => {
  const { email, password, totpCode } = req.body;

  try {
    const result = await db.query(
      'SELECT id, email, name, role, password_hash, mfa_enabled, mfa_secret, is_active FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      // Timing-safe: compare anyway
      await bcrypt.compare(password, '$2b$12$invalid_hash_to_prevent_timing_attacks');
      res.status(401).json({ status: 'error', message: 'Invalid email or password' });
      return;
    }

    const user = result.rows[0];

    if (!user.is_active) {
      res.status(403).json({ status: 'error', message: 'Account is disabled' });
      return;
    }

    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      // Track failed attempts in Redis
      const key   = `login_attempts:${user.id}`;
      const count = await redis.incr(key);
      await redis.expire(key, 900);

      if (count >= 5) {
        // Lock account after 5 failed attempts
        await db.query('UPDATE users SET is_active = FALSE WHERE id = $1', [user.id]);
        logger.warn('Account locked after failed attempts', { userId: user.id });
        res.status(423).json({ status: 'error', message: 'Account locked due to too many failed attempts' });
        return;
      }

      res.status(401).json({ status: 'error', message: 'Invalid email or password' });
      return;
    }

    // Clear failed attempts
    await redis.del(`login_attempts:${user.id}`);

    // MFA check
    if (user.mfa_enabled) {
      if (!totpCode) {
        res.status(200).json({ status: 'mfa_required', message: 'TOTP code required' });
        return;
      }
      const valid = authenticator.check(totpCode, user.mfa_secret);
      if (!valid) {
        res.status(401).json({ status: 'error', message: 'Invalid TOTP code' });
        return;
      }
    }

    const accessToken  = generateAccessToken({ id: user.id, email: user.email, role: user.role });
    const refreshToken = generateRefreshToken();

    await storeRefreshToken(user.id, refreshToken, req.ip, req.headers['user-agent']);
    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    await db.query(
      `INSERT INTO audit_log (id, user_id, action, ip_address, user_agent)
       VALUES ($1, $2, 'user.login', $3, $4)`,
      [uuidv4(), user.id, req.ip, req.headers['user-agent']]
    );

    logger.info('User login', { userId: user.id, email });

    res.json({
      status: 'success',
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        tokens: { accessToken, refreshToken, expiresIn: 900, tokenType: 'Bearer' }
      }
    });
  } catch (err) {
    logger.error('Login error', { err });
    res.status(500).json({ status: 'error', message: 'Login failed' });
  }
});

// POST /refresh
app.post('/refresh', validate(RefreshSchema), async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  try {
    // Find all non-expired refresh tokens and check each hash
    const result = await db.query(
      `SELECT rt.*, u.id as uid, u.email, u.role, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.expires_at > NOW()`,
      []
    );

    let matchedRow: Record<string, string> | null = null;
    for (const row of result.rows) {
      const match = await bcrypt.compare(refreshToken, row.token_hash);
      if (match) { matchedRow = row; break; }
    }

    if (!matchedRow) {
      res.status(401).json({ status: 'error', message: 'Invalid or expired refresh token' });
      return;
    }

    if (!matchedRow.is_active) {
      res.status(403).json({ status: 'error', message: 'Account is disabled' });
      return;
    }

    // Rotate refresh token (delete old, issue new)
    await db.query('DELETE FROM refresh_tokens WHERE id = $1', [matchedRow.id]);

    const newAccessToken  = generateAccessToken({ id: matchedRow.uid, email: matchedRow.email, role: matchedRow.role });
    const newRefreshToken = generateRefreshToken();

    await storeRefreshToken(matchedRow.uid, newRefreshToken, req.ip, req.headers['user-agent']);

    res.json({
      status: 'success',
      data: {
        tokens: { accessToken: newAccessToken, refreshToken: newRefreshToken, expiresIn: 900, tokenType: 'Bearer' }
      }
    });
  } catch (err) {
    logger.error('Refresh error', { err });
    res.status(500).json({ status: 'error', message: 'Token refresh failed' });
  }
});

// POST /logout
app.post('/logout', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  const userId     = req.headers['x-user-id'] as string;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    // Blacklist the access token until expiry
    try {
      const decoded = jwt.decode(token) as any;
      if (decoded?.exp) {
        const ttl = decoded.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) await redis.setEx(`blacklist:${token}`, ttl, '1');
      }
    } catch { /* ignore */ }
  }

  if (userId) await revokeUserTokens(userId);

  res.json({ status: 'success', message: 'Logged out successfully' });
});

// GET /me — return current user profile
app.get('/me', async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) { res.status(401).json({ status: 'error', message: 'Unauthenticated' }); return; }

  try {
    const result = await db.query(
      `SELECT id, email, name, role, organisation, country, preferred_lang,
              mfa_enabled, phone, is_active, last_login, created_at
       FROM users WHERE id = $1`,
      [userId]
    );
    if (result.rows.length === 0) { res.status(404).json({ status: 'error', message: 'User not found' }); return; }

    res.json({ status: 'success', data: { user: result.rows[0] } });
  } catch (err) {
    logger.error('Get me error', { err });
    res.status(500).json({ status: 'error', message: 'Failed to fetch profile' });
  }
});

// POST /mfa/setup
app.post('/mfa/setup', async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) { res.status(401).json({ status: 'error', message: 'Unauthenticated' }); return; }

  try {
    const userResult = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
    if (!userResult.rows.length) { res.status(404).json({ status: 'error', message: 'User not found' }); return; }

    const secret  = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(userResult.rows[0].email, 'AEGIS GLOBAL', secret);
    const qrData  = await qrcode.toDataURL(otpauth);

    // Store secret temporarily in Redis (user must verify before it's saved)
    await redis.setEx(`mfa_setup:${userId}`, 600, secret);

    res.json({ status: 'success', data: { secret, qrCode: qrData } });
  } catch (err) {
    logger.error('MFA setup error', { err });
    res.status(500).json({ status: 'error', message: 'MFA setup failed' });
  }
});

// POST /mfa/verify
app.post('/mfa/verify', async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  const { code } = req.body;

  if (!userId) { res.status(401).json({ status: 'error', message: 'Unauthenticated' }); return; }
  if (!code)   { res.status(400).json({ status: 'error', message: 'TOTP code required' }); return; }

  try {
    const secret = await redis.get(`mfa_setup:${userId}`);
    if (!secret) { res.status(400).json({ status: 'error', message: 'MFA setup session expired' }); return; }

    if (!authenticator.check(code, secret)) {
      res.status(400).json({ status: 'error', message: 'Invalid TOTP code' });
      return;
    }

    await db.query('UPDATE users SET mfa_enabled = TRUE, mfa_secret = $1 WHERE id = $2', [secret, userId]);
    await redis.del(`mfa_setup:${userId}`);

    res.json({ status: 'success', message: 'MFA enabled successfully' });
  } catch (err) {
    logger.error('MFA verify error', { err });
    res.status(500).json({ status: 'error', message: 'MFA verification failed' });
  }
});

// PUT /password
app.put('/password', validate(ChangePasswordSchema), async (req: Request, res: Response) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) { res.status(401).json({ status: 'error', message: 'Unauthenticated' }); return; }

  const { currentPassword, newPassword } = req.body;

  try {
    const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!result.rows.length) { res.status(404).json({ status: 'error', message: 'User not found' }); return; }

    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) { res.status(401).json({ status: 'error', message: 'Current password is incorrect' }); return; }

    const newHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [newHash, userId]);

    // Revoke all refresh tokens to force re-login
    await revokeUserTokens(userId);

    res.json({ status: 'success', message: 'Password updated. Please log in again.' });
  } catch (err) {
    logger.error('Change password error', { err });
    res.status(500).json({ status: 'error', message: 'Password change failed' });
  }
});

// GET /health
app.get('/health', async (_req, res) => {
  const dbOk    = await db.query('SELECT 1').then(() => true).catch(() => false);
  const redisOk = await redis.ping().then(() => true).catch(() => false);
  res.json({ status: 'ok', service: 'auth-service', db: dbOk, redis: redisOk });
});

app.listen(PORT, () => logger.info(`Auth service running on port ${PORT}`));

export { app };
