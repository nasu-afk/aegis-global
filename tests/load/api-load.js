// ─── AEGIS GLOBAL — k6 Load Tests ────────────────────────────────────────────
// Smoke test: quick pass/fail under minimal load
// Load test: sustained 10K RPS over 10 minutes
// Spike test: 0 → 500K users in 60 seconds
// Soak test: 1K RPS for 72 hours (run separately)

import http from 'k6/http';
import ws   from 'k6/ws';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// ─── Custom metrics ───────────────────────────────────────────────────────────
const errorRate      = new Rate('aegis_error_rate');
const sosLatency     = new Trend('aegis_sos_latency_ms');
const alertLatency   = new Trend('aegis_alert_latency_ms');
const aiLatency      = new Trend('aegis_ai_latency_ms');
const wsConnections  = new Counter('aegis_ws_connections');
const sosSubmissions = new Counter('aegis_sos_submissions');

// ─── Configuration ────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const WS_URL   = __ENV.WS_URL   || 'ws://localhost:4000';

// ─── Test scenarios ───────────────────────────────────────────────────────────
export const options = {
  scenarios: {

    // Smoke test — 5 VUs for 1 minute
    smoke: {
      executor:  'constant-vus',
      vus:        5,
      duration:  '1m',
      tags:      { scenario: 'smoke' },
      env:       { SCENARIO: 'smoke' }
    },

    // Load test — ramp to 1000 VUs over 5 min, hold 10 min
    load: {
      executor: 'ramping-vus',
      startVUs:  0,
      stages: [
        { duration: '5m',  target: 1000  },
        { duration: '10m', target: 1000  },
        { duration: '5m',  target: 0     },
      ],
      tags:  { scenario: 'load' },
      env:   { SCENARIO: 'load' }
    },

    // Spike test — 0 to 50,000 in 60 seconds
    spike: {
      executor: 'ramping-vus',
      startVUs:  0,
      stages: [
        { duration: '60s',  target: 50000 },
        { duration: '3m',   target: 50000 },
        { duration: '2m',   target: 0     },
      ],
      tags: { scenario: 'spike' },
      env:  { SCENARIO: 'spike' }
    },

    // WebSocket concurrent connections
    websocket: {
      executor: 'constant-vus',
      vus:       500,
      duration: '5m',
      tags:     { scenario: 'websocket' },
      env:      { SCENARIO: 'websocket' }
    },
  },

  thresholds: {
    // p99 latency under 200ms at load
    'http_req_duration{scenario:load}':        ['p(99)<200'],
    'http_req_duration{scenario:smoke}':       ['p(99)<100'],
    'aegis_sos_latency_ms':                    ['p(95)<300', 'p(99)<500'],
    'aegis_alert_latency_ms':                  ['p(95)<150', 'p(99)<300'],
    'aegis_ai_latency_ms':                     ['p(95)<5000','p(99)<8000'],
    // Error rate below 0.1%
    'aegis_error_rate':                        ['rate<0.001'],
    'http_req_failed':                         ['rate<0.01'],
    // All checks pass
    'checks':                                  ['rate>0.99'],
  }
};

// ─── Auth token cache ─────────────────────────────────────────────────────────
let authToken: string | null = null;

function getAuthToken(): string {
  if (authToken) return authToken;
  const resp = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: 'admin@aegisglobal.io', password: 'AegisAdmin2025!' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (resp.status === 200) {
    authToken = (resp.json() as any)?.data?.tokens?.accessToken || '';
  }
  return authToken || '';
}

function authHeaders() {
  return {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${getAuthToken()}`
  };
}

// ─── Main test function ───────────────────────────────────────────────────────
export default function () {
  const scenario = __ENV.SCENARIO || 'smoke';

  if (scenario === 'websocket') {
    testWebSocket();
    return;
  }

  group('Health checks', () => {
    const resp = http.get(`${BASE_URL}/health`);
    check(resp, {
      'health: status 200': r => r.status === 200,
      'health: status ok':  r => (r.json() as any)?.status === 'ok',
      'health: latency < 50ms': r => r.timings.duration < 50
    }) || errorRate.add(1);
  });

  group('Disasters API', () => {
    const start = Date.now();
    const resp  = http.get(
      `${BASE_URL}/api/v1/disasters?limit=20&status=active`,
      { headers: authHeaders() }
    );
    alertLatency.add(Date.now() - start);

    check(resp, {
      'disasters: status 200':   r => r.status === 200,
      'disasters: has data':     r => Array.isArray((r.json() as any)?.data),
      'disasters: latency < 200ms': r => r.timings.duration < 200,
    }) || errorRate.add(1);
  });

  group('Alerts API', () => {
    const start = Date.now();
    const resp  = http.get(
      `${BASE_URL}/api/v1/alerts?limit=50&severity=critical`,
      { headers: authHeaders() }
    );
    alertLatency.add(Date.now() - start);

    check(resp, {
      'alerts: status 200': r => r.status === 200,
      'alerts: latency < 150ms': r => r.timings.duration < 150,
    }) || errorRate.add(1);
  });

  group('Predictions API', () => {
    const resp = http.get(
      `${BASE_URL}/api/v1/predictions?active=true&limit=10`,
      { headers: authHeaders() }
    );
    check(resp, {
      'predictions: status 200': r => r.status === 200,
    }) || errorRate.add(1);
  });

  group('GIS Nearby', () => {
    const lat  = 37.42 + (Math.random() - 0.5) * 2;
    const lng  = 37.18 + (Math.random() - 0.5) * 2;
    const resp = http.get(
      `${BASE_URL}/api/v1/gis/nearby?lat=${lat}&lng=${lng}&radiusKm=50&types=shelters,teams`,
      { headers: authHeaders() }
    );
    check(resp, {
      'gis: status 200':          r => r.status === 200,
      'gis: latency < 300ms':     r => r.timings.duration < 300,
    }) || errorRate.add(1);
  });

  group('Risk scores', () => {
    const countries = ['BD','PH','TR','IN','ID','US'];
    const iso2 = countries[Math.floor(Math.random() * countries.length)];
    const resp = http.get(
      `${BASE_URL}/api/v1/risk/countries/${iso2}`,
      { headers: authHeaders() }
    );
    check(resp, {
      'risk: status 200 or 404': r => [200, 404].includes(r.status),
    }) || errorRate.add(1);
  });

  // SOS submission — 5% of requests
  if (Math.random() < 0.05) {
    group('SOS Submission', () => {
      const start = Date.now();
      const lat   = 37.0 + Math.random() * 5;
      const lng   = 35.0 + Math.random() * 5;
      const resp  = http.post(
        `${BASE_URL}/api/v1/sos`,
        JSON.stringify({
          type:        'hazard_observed',
          lat,
          lng,
          peopleCount: 1,
          description: 'Load test SOS report',
          isAnonymous: true
        }),
        { headers: authHeaders() }
      );
      sosLatency.add(Date.now() - start);
      sosSubmissions.add(1);

      check(resp, {
        'sos: status 201':          r => r.status === 201,
        'sos: has tracking URL':    r => !!(r.json() as any)?.data?.trackingUrl,
        'sos: latency < 500ms':     r => r.timings.duration < 500,
      }) || errorRate.add(1);
    });
  }

  // AI analysis — 2% of requests
  if (Math.random() < 0.02) {
    group('AI Analysis', () => {
      const start = Date.now();
      const resp  = http.post(
        `${BASE_URL}/api/v1/ai/analyse`,
        JSON.stringify({
          query:        'Brief: Current global risk summary',
          outputFormat: 'brief'
        }),
        { headers: authHeaders(), timeout: '30s' }
      );
      aiLatency.add(Date.now() - start);

      check(resp, {
        'ai: status 200':       r => r.status === 200,
        'ai: has analysis':     r => !!(r.json() as any)?.data?.analysis,
        'ai: latency < 8000ms': r => r.timings.duration < 8000,
      }) || errorRate.add(1);
    });
  }

  sleep(Math.random() * 0.5 + 0.1); // 100–600ms think time
}

// ─── WebSocket test ───────────────────────────────────────────────────────────
function testWebSocket() {
  const token = getAuthToken();
  const url   = `${WS_URL}/ws?token=${token}`;

  const resp  = ws.connect(url, {}, function (socket) {
    wsConnections.add(1);

    socket.on('open', () => {
      // Subscribe to all channels
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'disasters' }));
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'alerts'    }));
      socket.send(JSON.stringify({ type: 'subscribe', channel: 'sos'       }));
      socket.send(JSON.stringify({ type: 'ping' }));
    });

    socket.on('message', (data: string) => {
      try {
        const msg = JSON.parse(data);
        check(msg, {
          'ws: message has type': m => !!m.type,
        });
      } catch { /* ignore malformed */ }
    });

    socket.on('error', (e: Error) => {
      errorRate.add(1);
    });

    // Hold connection for 30 seconds
    sleep(30);
    socket.close();
  });

  check(resp, {
    'ws: connection established': r => r && r.status === 101,
  }) || errorRate.add(1);
}

// ─── Setup (runs once before tests) ──────────────────────────────────────────
export function setup() {
  // Verify the API is reachable before running load tests
  const resp = http.get(`${BASE_URL}/health`);
  if (resp.status !== 200) {
    throw new Error(`API health check failed: ${resp.status}. Abort load test.`);
  }
  console.log(`AEGIS Load Test starting against: ${BASE_URL}`);
  return { baseUrl: BASE_URL };
}

// ─── Teardown (runs once after tests) ─────────────────────────────────────────
export function teardown(data: { baseUrl: string }) {
  console.log(`Load test completed against: ${data.baseUrl}`);
}
