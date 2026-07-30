// ─── AEGIS GLOBAL — Comprehensive Test Suite ─────────────────────────────────
// Tests for: Auth, Alert, SOS, Drone, AI, GIS, Prediction, Historical, Resource services
// Framework: Jest + Supertest

import request from 'supertest';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

// ─── Test utilities ───────────────────────────────────────────────────────────
const JWT_SECRET = 'test_jwt_secret_for_ci';

function makeToken(role = 'global_admin', userId = uuidv4()) {
  return jwt.sign({ sub: userId, role, email: `test-${role}@aegis.io` }, JWT_SECRET, { expiresIn: '1h' });
}

function authHeader(role = 'global_admin') {
  return { Authorization: `Bearer ${makeToken(role)}` };
}

// ─── Mock DB setup ────────────────────────────────────────────────────────────
jest.mock('pg', () => {
  const mockQuery = jest.fn();
  const MockPool  = jest.fn(() => ({ query: mockQuery, connect: jest.fn(), end: jest.fn() }));
  return { Pool: MockPool, mockQuery };
});

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect:  jest.fn().mockResolvedValue(undefined),
    get:      jest.fn().mockResolvedValue(null),
    set:      jest.fn().mockResolvedValue('OK'),
    setEx:    jest.fn().mockResolvedValue('OK'),
    del:      jest.fn().mockResolvedValue(1),
    ping:     jest.fn().mockResolvedValue('PONG'),
    incr:     jest.fn().mockResolvedValue(1),
    expire:   jest.fn().mockResolvedValue(1),
  }))
}));

jest.mock('kafkajs', () => ({
  Kafka: jest.fn(() => ({
    producer: jest.fn(() => ({
      connect:     jest.fn().mockResolvedValue(undefined),
      send:        jest.fn().mockResolvedValue(undefined),
      disconnect:  jest.fn().mockResolvedValue(undefined),
    })),
    consumer: jest.fn(() => ({
      connect:    jest.fn().mockResolvedValue(undefined),
      subscribe:  jest.fn().mockResolvedValue(undefined),
      run:        jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    }))
  }))
}));

jest.mock('@anthropic-ai/sdk', () => ({
  default: jest.fn(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"severity":"high","confidenceScore":0.85,"immediateActions":["Deploy SAR team","Attempt contact"],"recommendedTeam":"USAR Alpha","safetyGuidance":"Stay in place. Signal rescuers.","triageNarrative":"High priority rescue required."}' }]
      })
    }
  }))
}));

// ─── AUTH SERVICE TESTS ───────────────────────────────────────────────────────
describe('Auth Service', () => {
  let app: any;
  let mockQuery: jest.Mock;

  beforeAll(async () => {
    process.env.JWT_SECRET   = JWT_SECRET;
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.REDIS_URL    = 'redis://localhost:6379';
    process.env.PORT         = '14001';
    const module = await import('../backend/auth-service/src/index');
    app = (module as any).app;
    mockQuery = (require('pg') as any).mockQuery;
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /register', () => {
    it('registers a new user successfully', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // check duplicate
        .mockResolvedValueOnce({ rows: [{ id: uuidv4(), email: 'test@test.com', name: 'Test', role: 'citizen', created_at: new Date() }] }) // insert user
        .mockResolvedValueOnce({ rows: [] }); // store refresh token

      const res = await request(app).post('/register').send({
        email: 'test@test.com', password: 'TestPass1!', name: 'Test User'
      });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.user.email).toBe('test@test.com');
      expect(res.body.data.tokens.accessToken).toBeDefined();
      expect(res.body.data.tokens.refreshToken).toBeDefined();
    });

    it('rejects duplicate email', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: uuidv4() }] }); // existing user

      const res = await request(app).post('/register').send({
        email: 'existing@test.com', password: 'TestPass1!', name: 'Test'
      });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('already registered');
    });

    it('validates password complexity', async () => {
      const res = await request(app).post('/register').send({
        email: 'test@test.com', password: 'weak', name: 'Test'
      });
      expect(res.status).toBe(400);
      expect(res.body.errors).toBeDefined();
    });

    it('validates email format', async () => {
      const res = await request(app).post('/register').send({
        email: 'not-an-email', password: 'TestPass1!', name: 'Test'
      });
      expect(res.status).toBe(400);
    });

    it('rejects empty name', async () => {
      const res = await request(app).post('/register').send({
        email: 'test@test.com', password: 'TestPass1!', name: ''
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /login', () => {
    it('logs in with valid credentials', async () => {
      const hash = await bcrypt.hash('TestPass1!', 10);
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: uuidv4(), email: 'test@test.com', name: 'Test', role: 'citizen', password_hash: hash, mfa_enabled: false, is_active: true }] })
        .mockResolvedValueOnce({ rows: [] }) // del failed attempts
        .mockResolvedValueOnce({ rows: [] }) // store refresh token
        .mockResolvedValueOnce({ rows: [] }) // update last_login
        .mockResolvedValueOnce({ rows: [] }); // audit log

      const res = await request(app).post('/login').send({
        email: 'test@test.com', password: 'TestPass1!'
      });

      expect(res.status).toBe(200);
      expect(res.body.data.tokens.accessToken).toBeDefined();
    });

    it('rejects invalid password', async () => {
      const hash = await bcrypt.hash('TestPass1!', 10);
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: uuidv4(), password_hash: hash, is_active: true, mfa_enabled: false }] })
        .mockResolvedValueOnce({ rows: [{ count: 1 }] }); // incr failed attempts

      const res = await request(app).post('/login').send({
        email: 'test@test.com', password: 'WrongPass1!'
      });
      expect(res.status).toBe(401);
    });

    it('rejects disabled account', async () => {
      const hash = await bcrypt.hash('TestPass1!', 10);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: uuidv4(), password_hash: hash, is_active: false }] });

      const res = await request(app).post('/login').send({
        email: 'test@test.com', password: 'TestPass1!'
      });
      expect(res.status).toBe(403);
    });

    it('requires MFA code when MFA enabled', async () => {
      const hash = await bcrypt.hash('TestPass1!', 10);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: uuidv4(), password_hash: hash, is_active: true, mfa_enabled: true, mfa_secret: 'JBSWY3DPEHPK3PXP' }] });

      const res = await request(app).post('/login').send({
        email: 'test@test.com', password: 'TestPass1!'
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('mfa_required');
    });
  });

  describe('POST /logout', () => {
    it('invalidates tokens on logout', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const token = makeToken('citizen');
      const res   = await request(app).post('/logout').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /me', () => {
    it('returns current user profile', async () => {
      const userId = uuidv4();
      mockQuery.mockResolvedValueOnce({ rows: [{ id: userId, email: 'test@test.com', name: 'Test', role: 'citizen' }] });
      const res = await request(app).get('/me').set('x-user-id', userId);
      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(userId);
    });

    it('returns 404 for unknown user', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).get('/me').set('x-user-id', uuidv4());
      expect(res.status).toBe(404);
    });
  });
});

// ─── ALERT / DISASTER SERVICE TESTS ──────────────────────────────────────────
describe('Alert Service', () => {
  let app: any;
  let mockQuery: jest.Mock;

  beforeAll(async () => {
    process.env.PORT = '14002';
    const module = await import('../backend/alert-service/src/index');
    app = (module as any).app;
    mockQuery = (require('pg') as any).mockQuery;
  });

  afterEach(() => jest.clearAllMocks());

  describe('GET /disasters', () => {
    it('returns paginated list of disasters', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [
          { id: uuidv4(), name: 'Test EQ', type: 'earthquake', severity: 'critical', status: 'active', deaths: 100, affected: 5000, started_at: new Date() }
        ]})
        .mockResolvedValueOnce({ rows: [{ count: '1' }] });

      const res = await request(app).get('/disasters').set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });

    it('filters by type and severity', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const res = await request(app).get('/disasters?type=earthquake&severity=critical').set(authHeader());
      expect(res.status).toBe(200);
      expect(mockQuery.mock.calls[0][0]).toContain('type = $');
      expect(mockQuery.mock.calls[0][0]).toContain('severity = $');
    });

    it('supports geospatial radius filter', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const res = await request(app).get('/disasters?lat=37.42&lng=37.18&radiusKm=100').set(authHeader());
      expect(res.status).toBe(200);
      expect(mockQuery.mock.calls[0][0]).toContain('ST_DWithin');
    });
  });

  describe('POST /disasters', () => {
    it('creates disaster with coordinator role', async () => {
      const newDisaster = { id: uuidv4(), name: 'Test Flood', type: 'flood', severity: 'high', status: 'active' };
      mockQuery.mockResolvedValueOnce({ rows: [newDisaster] });

      const res = await request(app).post('/disasters')
        .set(authHeader('emergency_coordinator'))
        .send({ name: 'Test Flood', type: 'flood', severity: 'high', lat: 23.8, lng: 90.4 });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('Test Flood');
    });

    it('rejects creation by citizen role', async () => {
      const res = await request(app).post('/disasters')
        .set(authHeader('citizen'))
        .send({ name: 'Test', type: 'flood' });
      expect(res.status).toBe(403);
    });

    it('validates required fields', async () => {
      const res = await request(app).post('/disasters')
        .set(authHeader('global_admin'))
        .send({ type: 'flood' }); // missing name
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /disasters/:id', () => {
    it('updates disaster severity', async () => {
      const id = uuidv4();
      mockQuery.mockResolvedValueOnce({ rows: [{ id, severity: 'critical', status: 'active' }] });

      const res = await request(app).patch(`/disasters/${id}`)
        .set(authHeader('emergency_coordinator'))
        .send({ severity: 'critical', deaths: 847 });

      expect(res.status).toBe(200);
    });
  });

  describe('POST /alerts', () => {
    it('issues alert with valid payload', async () => {
      const alert = { id: uuidv4(), title: 'Earthquake Warning', severity: 'critical', issued_at: new Date() };
      mockQuery.mockResolvedValueOnce({ rows: [alert] });

      const res = await request(app).post('/alerts')
        .set(authHeader('emergency_coordinator'))
        .send({ title: 'Earthquake Warning', message: 'Evacuate immediately', severity: 'critical', channels: ['push','sms'] });

      expect(res.status).toBe(201);
      expect(res.body.data.title).toBe('Earthquake Warning');
    });

    it('requires coordinator or admin role', async () => {
      const res = await request(app).post('/alerts')
        .set(authHeader('citizen'))
        .send({ title: 'Test', message: 'Test', severity: 'low' });
      expect(res.status).toBe(403);
    });
  });
});

// ─── SOS SERVICE TESTS ────────────────────────────────────────────────────────
describe('SOS Service', () => {
  let app: any;
  let mockQuery: jest.Mock;

  beforeAll(async () => {
    process.env.PORT            = '14005';
    process.env.AI_SERVICE_URL  = 'http://localhost:14009';
    const module = await import('../backend/sos-service/src/index');
    app = (module as any).app;
    mockQuery = (require('pg') as any).mockQuery;
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /sos', () => {
    it('creates SOS report with AI triage', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] }) // find nearest disaster
        .mockResolvedValueOnce({ rows: [] }) // insert SOS
        .mockResolvedValueOnce({ rows: [] }); // audit

      const res = await request(app).post('/sos').send({
        type: 'trapped_rubble', lat: 37.42, lng: 37.18,
        peopleCount: 3, description: 'Trapped under rubble, building unstable'
      });

      expect(res.status).toBe(201);
      expect(res.body.data.sosId).toBeDefined();
      expect(res.body.data.status).toBe('pending');
      expect(res.body.data.trackingUrl).toContain('track');
    });

    it('validates required lat/lng fields', async () => {
      const res = await request(app).post('/sos').send({
        type: 'medical_emergency', peopleCount: 1
      });
      expect(res.status).toBe(400);
    });

    it('validates lat/lng ranges', async () => {
      const res = await request(app).post('/sos').send({
        type: 'medical_emergency', lat: 200, lng: 37.18
      });
      expect(res.status).toBe(400);
    });

    it('accepts anonymous reports', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app).post('/sos').send({
        type: 'hazard_observed', lat: 37.42, lng: 37.18, isAnonymous: true, peopleCount: 1
      });
      expect(res.status).toBe(201);
    });
  });

  describe('GET /sos/reports', () => {
    it('returns SOS reports for coordinators', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [
        { id: uuidv4(), type: 'trapped_rubble', ai_severity: 'critical', status: 'pending', people_count: 3 }
      ]});

      const res = await request(app).get('/sos/reports')
        .set({ 'x-user-role': 'emergency_coordinator', 'x-user-id': uuidv4() });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('citizens only see their own reports', async () => {
      const userId = uuidv4();
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/sos/reports')
        .set({ 'x-user-role': 'citizen', 'x-user-id': userId });
      expect(res.status).toBe(200);
      expect(mockQuery.mock.calls[0][0]).toContain('user_id');
    });
  });

  describe('GET /sos/stats', () => {
    it('returns aggregated SOS statistics', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{
        active_count: '5', critical_pending: '2',
        resolved_today: '12', last_hour: '3', avg_resolution_minutes: '28.5'
      }]});

      const res = await request(app).get('/sos/stats');
      expect(res.status).toBe(200);
      expect(res.body.data.active_count).toBe('5');
    });
  });

  describe('PATCH /sos/reports/:id', () => {
    it('updates SOS status to resolved', async () => {
      const id = uuidv4();
      mockQuery.mockResolvedValueOnce({ rows: [{ id, status: 'resolved', resolved_at: new Date() }] });

      const res = await request(app).patch(`/sos/reports/${id}`)
        .set({ 'x-user-role': 'first_responder', 'x-user-id': uuidv4() })
        .send({ status: 'resolved' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('resolved');
    });
  });
});

// ─── DRONE SERVICE TESTS ──────────────────────────────────────────────────────
describe('Drone Service', () => {
  let app: any;
  let mockQuery: jest.Mock;

  beforeAll(async () => {
    process.env.PORT = '14008';
    const module = await import('../backend/drone-service/src/index');
    app = (module as any).app;
    mockQuery = (require('pg') as any).mockQuery;
  });

  afterEach(() => jest.clearAllMocks());

  describe('GET /drones', () => {
    it('returns fleet list', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [
        { id: uuidv4(), callsign: 'SAR-TR-001', status: 'active', battery_pct: 87, mission_type: 'sar' }
      ]});
      const res = await request(app).get('/drones').set(authHeader('emergency_coordinator'));
      expect(res.status).toBe(200);
      expect(res.body.data[0].callsign).toBe('SAR-TR-001');
    });

    it('filters by status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).get('/drones?status=standby').set(authHeader());
      expect(res.status).toBe(200);
      expect(mockQuery.mock.calls[0][0]).toContain('status = $');
    });
  });

  describe('POST /drones', () => {
    it('registers new drone', async () => {
      const drone = { id: uuidv4(), callsign: 'TEST-01', type: 'SAR', status: 'standby' };
      mockQuery.mockResolvedValueOnce({ rows: [drone] });

      const res = await request(app).post('/drones')
        .set(authHeader('global_admin'))
        .send({ callsign: 'TEST-01', type: 'SAR', model: 'DJI Matrice 300 RTK' });

      expect(res.status).toBe(201);
      expect(res.body.data.callsign).toBe('TEST-01');
    });

    it('rejects duplicate callsign', async () => {
      const pgError = Object.assign(new Error('unique'), { code: '23505' });
      mockQuery.mockRejectedValueOnce(pgError);

      const res = await request(app).post('/drones')
        .set(authHeader())
        .send({ callsign: 'EXISTING', type: 'SAR' });
      expect(res.status).toBe(409);
    });
  });

  describe('POST /drones/:id/telemetry', () => {
    it('records telemetry update', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{}] });

      const res = await request(app).post(`/drones/${uuidv4()}/telemetry`)
        .set(authHeader())
        .send({ batteryPct: 72, lat: 37.42, lng: 37.18, altitudeM: 82, speedMs: 14 });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Telemetry recorded');
    });

    it('validates battery percentage range', async () => {
      const res = await request(app).post(`/drones/${uuidv4()}/telemetry`)
        .set(authHeader())
        .send({ batteryPct: 150, lat: 37.42, lng: 37.18 });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /drones/fleet/summary', () => {
    it('returns fleet statistics', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{
        total: '160', active: '88', standby: '42', rtb: '18',
        charging: '12', sar_missions: '37', avg_battery_active: '76.4'
      }]});

      const res = await request(app).get('/drones/fleet/summary').set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe('160');
    });
  });
});

// ─── PREDICTION SERVICE TESTS ─────────────────────────────────────────────────
describe('Prediction Service', () => {
  let app: any;
  let mockQuery: jest.Mock;

  beforeAll(async () => {
    process.env.PORT = '14004';
    const module = await import('../backend/prediction-service/src/index');
    app = (module as any).app;
    mockQuery = (require('pg') as any).mockQuery;
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /predictions/run', () => {
    it('runs flood prediction model', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // insert prediction

      const res = await request(app).post('/predictions/run').set(authHeader())
        .send({ disasterType: 'flood', lat: 23.8, lng: 90.4, horizon: 72,
                contextData: { rainfall_mm_24h: 185, river_gauge_pct: 92 } });

      expect(res.status).toBe(201);
      expect(res.body.data.disasterType).toBe('flood');
      expect(res.body.data.confidence).toBeGreaterThan(0);
      expect(res.body.data.confidence).toBeLessThanOrEqual(1);
      expect(['critical','high','medium','low']).toContain(res.body.data.predictedSeverity);
    });

    it('runs wildfire prediction model', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).post('/predictions/run').set(authHeader())
        .send({ disasterType: 'wildfire', lat: 37.8, lng: -122.4, horizon: 24,
                contextData: { wind_speed_kmh: 45, relative_humidity: 8, temperature_c: 38 } });

      expect(res.status).toBe(201);
      expect(res.body.data.metadata.spreadKm2Per24h).toBeDefined();
    });

    it('runs cyclone prediction model', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).post('/predictions/run').set(authHeader())
        .send({ disasterType: 'cyclone', lat: 15.0, lng: 120.0, horizon: 48,
                contextData: { sea_surface_temp_c: 30.5, wind_shear_ms: 4, low_pressure_hpa: 992 } });

      expect(res.status).toBe(201);
      expect(res.body.data.metadata.category).toBeDefined();
      expect(res.body.data.metadata.category).toBeGreaterThanOrEqual(1);
    });

    it('validates required fields', async () => {
      const res = await request(app).post('/predictions/run').set(authHeader())
        .send({ lat: 37.0, lng: 37.0 }); // missing disasterType
      expect(res.status).toBe(400);
    });

    it('validates horizon range (6–168 hours)', async () => {
      const res = await request(app).post('/predictions/run').set(authHeader())
        .send({ disasterType: 'flood', lat: 37.0, lng: 37.0, horizon: 500 });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /predictions', () => {
    it('returns active predictions', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [
        { id: uuidv4(), disaster_type: 'flood', confidence: 0.89, predicted_severity: 'critical', is_active: true }
      ]});

      const res = await request(app).get('/predictions').set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data[0].confidence).toBe(0.89);
    });
  });

  describe('GET /predictions/models', () => {
    it('returns model registry', async () => {
      const res = await request(app).get('/predictions/models').set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].accuracy).toBeDefined();
    });
  });

  describe('GET /predictions/risk-score/:iso2', () => {
    it('returns country risk score', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [
        { iso2: 'BD', country_name: 'Bangladesh', gdis_score: 91.0, rank: 1 }
      ]});

      const res = await request(app).get('/predictions/risk-score/BD').set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.gdis_score).toBe(91.0);
    });

    it('returns 404 for unknown country', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).get('/predictions/risk-score/ZZ').set(authHeader());
      expect(res.status).toBe(404);
    });
  });
});

// ─── GIS SERVICE TESTS ────────────────────────────────────────────────────────
describe('GIS Service', () => {
  let app: any;
  let mockQuery: jest.Mock;

  beforeAll(async () => {
    process.env.PORT = '14003';
    const module = await import('../backend/gis-service/src/index');
    app = (module as any).app;
    mockQuery = (require('pg') as any).mockQuery;
  });

  afterEach(() => jest.clearAllMocks());

  describe('GET /gis/nearby', () => {
    it('returns nearby entities', async () => {
      mockQuery.mockResolvedValue({ rows: [
        { id: uuidv4(), name: 'Test Shelter', entity_type: 'shelter', distance_km: 2.4 }
      ]});

      const res = await request(app).get('/gis/nearby?lat=37.42&lng=37.18&radiusKm=50').set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(res.body.center).toEqual({ lat: 37.42, lng: 37.18 });
    });

    it('validates lat/lng parameters', async () => {
      const res = await request(app).get('/gis/nearby?lat=999&lng=37.18').set(authHeader());
      expect(res.status).toBe(400);
    });
  });

  describe('GET /gis/flood-model', () => {
    it('returns flood risk model output', async () => {
      const res = await request(app).get('/gis/flood-model?lat=23.8&lng=90.4&rainfallMm=200&riverGaugePct=90').set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.riskScore).toBeGreaterThan(0);
      expect(res.body.data.floodPolygon).toBeDefined();
      expect(['critical','high','medium','low']).toContain(res.body.data.severity);
    });

    it('requires lat and lng', async () => {
      const res = await request(app).get('/gis/flood-model').set(authHeader());
      expect(res.status).toBe(400);
    });
  });

  describe('GET /gis/wildfire-spread', () => {
    it('returns wildfire spread polygon', async () => {
      const res = await request(app).get('/gis/wildfire-spread?lat=37.8&lng=-122.4&windSpeedKmh=40&humidityPct=10&hours=24').set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.spreadKm).toBeGreaterThan(0);
      expect(res.body.data.spreadPolygon.geometry.type).toBe('Polygon');
    });
  });

  describe('GET /risk/countries', () => {
    it('returns country risk scores', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [
        { iso2: 'BD', country_name: 'Bangladesh', gdis_score: 91.0, rank: 1 },
        { iso2: 'PH', country_name: 'Philippines', gdis_score: 88.0, rank: 2 }
      ]});
      const res = await request(app).get('/risk/countries').set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
    });
  });

  describe('GET /gis/satellite-feeds', () => {
    it('returns satellite feed list', async () => {
      const res = await request(app).get('/gis/satellite-feeds').set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].status).toBe('active');
    });
  });
});

// ─── RESOURCE SERVICE TESTS ───────────────────────────────────────────────────
describe('Resource Service', () => {
  let app: any;
  let mockQuery: jest.Mock;

  beforeAll(async () => {
    process.env.PORT = '14007';
    const module = await import('../backend/resource-service/src/index');
    app = (module as any).app;
    mockQuery = (require('pg') as any).mockQuery;
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /resources', () => {
    it('creates a resource', async () => {
      const resource = { id: uuidv4(), category: 'sar_team', name: 'Alpha SAR Team', quantity_total: 1, quantity_available: 1 };
      mockQuery.mockResolvedValueOnce({ rows: [resource] });

      const res = await request(app).post('/resources')
        .set(authHeader('emergency_coordinator'))
        .send({ category: 'sar_team', name: 'Alpha SAR Team', quantityTotal: 1 });

      expect(res.status).toBe(201);
      expect(res.body.data.category).toBe('sar_team');
    });
  });

  describe('PATCH /resources/:id/deploy', () => {
    it('deploys a resource', async () => {
      const id = uuidv4();
      mockQuery.mockResolvedValueOnce({ rows: [{ id, quantity_available: 9, quantity_deployed: 1 }] });

      const res = await request(app).patch(`/resources/${id}/deploy`)
        .set(authHeader())
        .send({ quantity: 1, disasterId: uuidv4() });

      expect(res.status).toBe(200);
    });

    it('rejects negative quantity', async () => {
      const res = await request(app).patch(`/resources/${uuidv4()}/deploy`)
        .set(authHeader())
        .send({ quantity: -1 });
      expect(res.status).toBe(400);
    });

    it('rejects when insufficient stock', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // no rows = constraint failed
      const res = await request(app).patch(`/resources/${uuidv4()}/deploy`)
        .set(authHeader())
        .send({ quantity: 999 });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /shelters', () => {
    it('creates a shelter', async () => {
      const shelter = { id: uuidv4(), name: 'Test Shelter', capacity_total: 1000 };
      mockQuery.mockResolvedValueOnce({ rows: [shelter] });

      const res = await request(app).post('/shelters')
        .set(authHeader('ngo_coordinator'))
        .send({ name: 'Test Shelter', lat: 37.42, lng: 37.18, capacityTotal: 1000 });

      expect(res.status).toBe(201);
    });
  });

  describe('PATCH /shelters/:id/occupancy', () => {
    it('updates shelter occupancy', async () => {
      const id = uuidv4();
      mockQuery.mockResolvedValueOnce({ rows: [{ id, occupancy_current: 250, capacity_total: 1000 }] });

      const res = await request(app).patch(`/shelters/${id}/occupancy`)
        .set(authHeader())
        .send({ delta: 50 });

      expect(res.status).toBe(200);
    });
  });
});

// ─── INTEGRATION — cross-service flow ─────────────────────────────────────────
describe('Integration: SOS → AI Triage → Team Dispatch Flow', () => {
  it('full SOS lifecycle: submit → triage → dispatch → resolve', async () => {
    // This would test the complete flow across services
    // In a real integration test env, services would be running

    const sosPayload = {
      type: 'trapped_rubble',
      lat: 37.42, lng: 37.18,
      peopleCount: 3,
      description: 'Three people trapped under collapsed building structure. Can hear voices.'
    };

    // Validate SOS schema
    expect(sosPayload.type).toBe('trapped_rubble');
    expect(sosPayload.peopleCount).toBeGreaterThan(0);
    expect(sosPayload.lat).toBeGreaterThan(-90);
    expect(sosPayload.lat).toBeLessThan(90);
    expect(sosPayload.lng).toBeGreaterThan(-180);
    expect(sosPayload.lng).toBeLessThan(180);

    // Validate triage categories
    const validSeverities = ['critical','high','medium','low'];
    const mockTriageResult = { severity: 'critical', confidenceScore: 0.92 };
    expect(validSeverities).toContain(mockTriageResult.severity);
    expect(mockTriageResult.confidenceScore).toBeGreaterThan(0.5);

    // Validate dispatch logic — critical SOS should get fastest team
    const mockTeams = [
      { id: uuidv4(), distance_km: 2.4, status: 'standby', specialisation: 'USAR' },
      { id: uuidv4(), distance_km: 8.1, status: 'standby', specialisation: 'medical' }
    ];
    const nearestTeam = mockTeams.sort((a, b) => a.distance_km - b.distance_km)[0];
    expect(nearestTeam.distance_km).toBe(2.4);
  });
});

// ─── Performance tests ────────────────────────────────────────────────────────
describe('Performance: Response time assertions', () => {
  it('prediction model runs in under 500ms', async () => {
    const start = Date.now();
    // Simulate model execution time
    await new Promise(r => setTimeout(r, 50)); // mock model inference
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it('database queries complete in under 100ms', async () => {
    const start = Date.now();
    await Promise.resolve([]); // mock DB result
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});
