// ─── AEGIS GLOBAL — End-to-End Tests (Playwright) ────────────────────────────
// Critical user journeys: auth, dashboard, SOS, alerts, drones, AI, admin

import { test, expect, Page, BrowserContext } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const API_URL  = process.env.API_URL  || 'http://localhost:4000';

const TEST_CREDENTIALS = {
  email:    process.env.TEST_EMAIL    || 'admin@aegisglobal.io',
  password: process.env.TEST_PASSWORD || 'AegisAdmin2025!'
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function login(page: Page, email = TEST_CREDENTIALS.email, password = TEST_CREDENTIALS.password) {
  await page.goto(`${BASE_URL}/login`);
  await page.fill('input[type="email"]',    email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(`${BASE_URL}/**`, { timeout: 10_000 });
  await expect(page.locator('#aegis-clock')).toBeVisible({ timeout: 5_000 });
}

async function apiRequest(page: Page, method: string, path: string, body?: unknown) {
  const token = await page.evaluate(() => localStorage.getItem('aegis_access_token'));
  return page.request.fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`
    },
    data: body ? JSON.stringify(body) : undefined
  });
}

// ─── SUITE 1: Authentication ───────────────────────────────────────────────
test.describe('Authentication', () => {

  test('shows login page with AEGIS branding', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await expect(page.locator('text=AEGIS GLOBAL')).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('redirects unauthenticated user to login', async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await expect(page).toHaveURL(/.*login/);
  });

  test('logs in successfully with valid credentials', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.fill('input[type="email"]',    TEST_CREDENTIALS.email);
    await page.fill('input[type="password"]', TEST_CREDENTIALS.password);
    await page.click('button[type="submit"]');

    await expect(page.locator('text=Dashboard')).toBeVisible({ timeout: 10_000 });
    const token = await page.evaluate(() => localStorage.getItem('aegis_access_token'));
    expect(token).toBeTruthy();
  });

  test('shows error for invalid credentials', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.fill('input[type="email"]',    'wrong@email.com');
    await page.fill('input[type="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');

    await expect(page.locator('text=Invalid email or password')).toBeVisible({ timeout: 5_000 });
  });

  test('disables submit button when fields are empty', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    const button = page.locator('button[type="submit"]');
    await expect(button).toBeDisabled();
  });

  test('registration page renders correctly', async ({ page }) => {
    await page.goto(`${BASE_URL}/register`);
    await expect(page.locator('text=Create your account')).toBeVisible();
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('select')).toBeVisible();
  });

  test('registration validates password complexity', async ({ page }) => {
    await page.goto(`${BASE_URL}/register`);
    await page.fill('input[placeholder*="Full name"]', 'Test User');
    await page.fill('input[type="email"]',             'test@test.com');
    await page.fill('input[type="password"]',          'weakpass');
    await page.fill('input[placeholder*="Re-enter"]',  'weakpass');
    await page.click('button[type="submit"]');
    await expect(page.locator('text=/password/i')).toBeVisible();
  });

  test('logs out and clears tokens', async ({ page }) => {
    await login(page);
    // Find logout button (↩ icon in sidebar user area)
    await page.click('button:has-text("↩")');
    await expect(page).toHaveURL(/.*login/);
    const token = await page.evaluate(() => localStorage.getItem('aegis_access_token'));
    expect(token).toBeNull();
  });
});

// ─── SUITE 2: Dashboard ────────────────────────────────────────────────────
test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test('shows KPI cards with disaster metrics', async ({ page }) => {
    await expect(page.locator('text=Active events')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('text=Critical events')).toBeVisible();
    await expect(page.locator('text=People affected')).toBeVisible();
    await expect(page.locator('text=Confirmed deaths')).toBeVisible();
  });

  test('displays severity breakdown bar', async ({ page }) => {
    await expect(page.locator('text=Severity breakdown')).toBeVisible();
  });

  test('shows active disaster events list', async ({ page }) => {
    await expect(page.locator('text=Active disaster events')).toBeVisible();
  });

  test('displays SOS summary widget', async ({ page }) => {
    await expect(page.locator('text=SOS reports')).toBeVisible();
  });

  test('shows recent alerts widget', async ({ page }) => {
    await expect(page.locator('text=Recent alerts')).toBeVisible();
  });

  test('displays platform stats', async ({ page }) => {
    await expect(page.locator('text=Platform stats')).toBeVisible();
    await expect(page.locator('text=API uptime')).toBeVisible();
  });

  test('live clock updates', async ({ page }) => {
    const clock1 = await page.locator('#aegis-clock').textContent();
    await page.waitForTimeout(2000);
    const clock2 = await page.locator('#aegis-clock').textContent();
    expect(clock1).not.toBe(clock2);
  });
});

// ─── SUITE 3: Navigation ───────────────────────────────────────────────────
test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test('navigates to all main sections', async ({ page }) => {
    const sections = [
      { button: 'text=Live Map',        expect: 'text=Live GIS Map' },
      { button: 'text=Alerts',          expect: 'text=Live Alerts' },
      { button: 'text=SOS Portal',      expect: 'text=Live Reports' },
      { button: 'text=AI Intelligence', expect: 'text=AEGIS AI' },
      { button: 'text=Historical',      expect: 'text=Historical explorer' },
      { button: 'text=Dashboard',       expect: 'text=Active events' },
    ];

    for (const section of sections) {
      await page.click(section.button);
      await expect(page.locator(section.expect)).toBeVisible({ timeout: 5_000 });
    }
  });

  test('sidebar toggle collapses and expands', async ({ page }) => {
    const sidebar = page.locator('aside');
    const toggle  = page.locator('button:has-text("☰")');

    await toggle.click();
    await expect(sidebar).toHaveClass(/w-14/, { timeout: 3_000 });

    await toggle.click();
    await expect(sidebar).toHaveClass(/w-56/, { timeout: 3_000 });
  });

  test('drone fleet hidden for citizen role', async ({ page, context }) => {
    // Register a citizen user and verify drone fleet is not visible
    await page.goto(`${BASE_URL}/register`);
    const email = `citizen-${Date.now()}@test.com`;
    await page.fill('input[placeholder*="Full name"]',    'Test Citizen');
    await page.fill('input[type="email"]',                 email);
    await page.selectOption('select',                      'citizen');
    await page.fill('input[type="password"]',              'TestPass1!');
    await page.fill('input[placeholder*="Re-enter"]',      'TestPass1!');
    await page.click('button[type="submit"]');

    await expect(page.locator('text=Drone Fleet')).not.toBeVisible({ timeout: 5_000 });
  });
});

// ─── SUITE 4: SOS Portal ─────────────────────────────────────────────────
test.describe('SOS Portal', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.click('text=SOS Portal');
  });

  test('shows SOS statistics bar', async ({ page }) => {
    await expect(page.locator('text=Critical pending')).toBeVisible();
    await expect(page.locator('text=Active reports')).toBeVisible();
    await expect(page.locator('text=Resolved today')).toBeVisible();
  });

  test('switches between reports and submit tabs', async ({ page }) => {
    await expect(page.locator('text=Live Reports')).toBeVisible();
    await page.click('text=+ Submit SOS');
    await expect(page.locator('text=ONE-CLICK SOS EMERGENCY')).toBeVisible();
    await page.click('text=Live Reports');
    await expect(page.locator('text=Submit SOS')).toBeVisible();
  });

  test('submit tab shows emergency type selector', async ({ page }) => {
    await page.click('text=+ Submit SOS');
    await expect(page.locator('select')).toBeVisible();
    await expect(page.locator('text=Trapped under rubble')).toBeVisible();
  });

  test('submit button disabled when no location', async ({ page }) => {
    await page.click('text=+ Submit SOS');
    const button = page.locator('button:has-text("Submit Emergency Report")');
    await expect(button).toBeDisabled();
  });

  test('location button shows GPS coordinates', async ({ page }) => {
    await page.click('text=+ Submit SOS');

    // Grant geolocation permission
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({ latitude: 37.42, longitude: 37.18 });

    await page.click('button:has-text("Get my location")');
    await expect(page.locator('text=37.4200')).toBeVisible({ timeout: 5_000 });
  });

  test('displays incoming SOS reports', async ({ page }) => {
    // The list may be empty in test env — just verify the tab renders
    await expect(page.locator('text=Live Reports')).toBeVisible();
    // Verify no crash when empty
    await expect(page.locator('text=No active SOS reports').or(
      page.locator('[class*="sos-card"]').first()
    )).toBeVisible({ timeout: 5_000 });
  });
});

// ─── SUITE 5: AI Intelligence ────────────────────────────────────────────
test.describe('AI Intelligence', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.click('text=AI Intelligence');
  });

  test('shows AEGIS AI welcome message', async ({ page }) => {
    await expect(page.locator('text=AEGIS AI Intelligence Engine')).toBeVisible();
    await expect(page.locator('text=Welcome to AEGIS AI')).toBeVisible({ timeout: 5_000 });
  });

  test('displays quick prompt suggestions', async ({ page }) => {
    await expect(page.locator('text=72h global risk brief')).toBeVisible();
    await expect(page.locator('text=Compare 2004 vs 2011 Tsunami')).toBeVisible();
  });

  test('input textarea is focusable', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder*="Ask about"]');
    await expect(textarea).toBeVisible();
    await textarea.click();
    await expect(textarea).toBeFocused();
  });

  test('send button disabled when input empty', async ({ page }) => {
    const sendBtn = page.locator('button:has-text("→")');
    await expect(sendBtn).toBeDisabled();
  });

  test('output format selector works', async ({ page }) => {
    const select = page.locator('select');
    await select.selectOption('structured');
    await expect(select).toHaveValue('structured');
    await select.selectOption('brief');
    await expect(select).toHaveValue('brief');
  });

  test('clear button resets conversation', async ({ page }) => {
    const clearBtn = page.locator('button:has-text("Clear")');
    await clearBtn.click();
    await expect(page.locator('text=Session cleared')).toBeVisible();
  });

  test('sends message and receives AI response', async ({ page }) => {
    const textarea = page.locator('textarea[placeholder*="Ask about"]');
    await textarea.fill('What is the current status of active disasters?');
    await page.keyboard.press('Enter');

    // Should show typing indicator then response
    await expect(page.locator('[class*="typing"], [class*="ai-loading"]').or(
      page.locator('.msg.ai').nth(1)
    )).toBeVisible({ timeout: 15_000 });
  });
});

// ─── SUITE 6: API Integration Tests ─────────────────────────────────────
test.describe('API Integration', () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test('GET /api/v1/disasters returns data', async ({ page }) => {
    const resp = await apiRequest(page, 'GET', '/disasters?limit=5');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe('success');
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('GET /api/v1/alerts returns data', async ({ page }) => {
    const resp = await apiRequest(page, 'GET', '/alerts?limit=5');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe('success');
  });

  test('GET /api/v1/drones returns fleet', async ({ page }) => {
    const resp = await apiRequest(page, 'GET', '/drones?limit=10');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe('success');
  });

  test('POST /api/v1/sos creates SOS report', async ({ page }) => {
    const resp = await apiRequest(page, 'POST', '/sos', {
      type:        'hazard_observed',
      lat:          37.42,
      lng:          37.18,
      peopleCount:  1,
      description: 'E2E test SOS report',
      isAnonymous: true
    });
    expect(resp.status()).toBe(201);
    const body = await resp.json();
    expect(body.data.sosId).toBeTruthy();
    expect(body.data.status).toBe('pending');
    expect(['critical','high','medium','low']).toContain(body.data.aiSeverity);
  });

  test('POST /api/v1/predictions/run returns prediction', async ({ page }) => {
    const resp = await apiRequest(page, 'POST', '/predictions/run', {
      disasterType: 'flood',
      lat:          23.8,
      lng:          90.4,
      horizon:      72,
      contextData:  { rainfall_mm_24h: 150, river_gauge_pct: 85 }
    });
    expect(resp.status()).toBe(201);
    const body = await resp.json();
    expect(body.data.confidence).toBeGreaterThan(0);
    expect(body.data.confidence).toBeLessThanOrEqual(1);
  });

  test('GET /api/v1/gis/nearby returns results', async ({ page }) => {
    const resp = await apiRequest(page, 'GET', '/gis/nearby?lat=37.42&lng=37.18&radiusKm=100');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.data).toBeDefined();
    expect(body.center).toEqual({ lat: 37.42, lng: 37.18 });
  });

  test('GET /api/v1/risk/countries returns risk scores', async ({ page }) => {
    const resp = await apiRequest(page, 'GET', '/risk/countries');
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('GET /health returns ok', async ({ page }) => {
    const resp = await page.request.get(`${API_URL}/health`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe('ok');
  });

  test('POST /api/v1/ai/analyse returns analysis', async ({ page }) => {
    const resp = await apiRequest(page, 'POST', '/ai/analyse', {
      query:        'Brief: what is the current risk level in Bangladesh?',
      outputFormat: 'brief'
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.data.analysis).toBeTruthy();
    expect(body.data.sessionId).toBeTruthy();
  });

  test('unauthorised request returns 401', async ({ page }) => {
    const resp = await page.request.get(`${API_URL}/api/v1/disasters`, {
      headers: { Authorization: 'Bearer invalid_token' }
    });
    expect(resp.status()).toBe(401);
  });

  test('rate limiting returns 429 on abuse', async ({ page }) => {
    // Make 25 rapid auth requests to trigger rate limit
    const requests = Array.from({ length: 25 }, () =>
      page.request.post(`${API_URL}/api/v1/auth/login`, {
        data: JSON.stringify({ email: 'test@test.com', password: 'wrong' }),
        headers: { 'Content-Type': 'application/json' }
      })
    );
    const responses = await Promise.all(requests);
    const statuses  = responses.map(r => r.status());
    expect(statuses.some(s => s === 429)).toBe(true);
  });
});

// ─── SUITE 7: Accessibility ───────────────────────────────────────────────
test.describe('Accessibility', () => {
  test.beforeEach(async ({ page }) => { await login(page); });

  test('all interactive elements are keyboard accessible', async ({ page }) => {
    // Tab through main navigation
    await page.keyboard.press('Tab');
    const focused1 = await page.evaluate(() => document.activeElement?.tagName);
    expect(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA']).toContain(focused1);
  });

  test('buttons have accessible text or aria-label', async ({ page }) => {
    const buttons = page.locator('button');
    const count   = await buttons.count();

    for (let i = 0; i < Math.min(count, 20); i++) {
      const btn  = buttons.nth(i);
      const text = await btn.textContent();
      const aria = await btn.getAttribute('aria-label');
      const title= await btn.getAttribute('title');
      // Button should have either text content or aria-label or title
      expect(text?.trim() || aria || title).toBeTruthy();
    }
  });

  test('images have alt text', async ({ page }) => {
    const images = page.locator('img');
    const count  = await images.count();
    for (let i = 0; i < count; i++) {
      const alt = await images.nth(i).getAttribute('alt');
      expect(alt).not.toBeNull();
    }
  });

  test('form inputs have labels', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    const inputs = page.locator('input');
    const count  = await inputs.count();
    for (let i = 0; i < count; i++) {
      const inp   = inputs.nth(i);
      const id    = await inp.getAttribute('id');
      const aria  = await inp.getAttribute('aria-label');
      const placeholder = await inp.getAttribute('placeholder');
      // Should have id (for label) or aria-label or placeholder
      expect(id || aria || placeholder).toBeTruthy();
    }
  });
});

// ─── SUITE 8: Performance ────────────────────────────────────────────────
test.describe('Performance', () => {

  test('login page loads in under 3 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto(`${BASE_URL}/login`);
    await expect(page.locator('input[type="email"]')).toBeVisible();
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test('dashboard renders in under 5 seconds after login', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    const start = Date.now();
    await page.fill('input[type="email"]',    TEST_CREDENTIALS.email);
    await page.fill('input[type="password"]', TEST_CREDENTIALS.password);
    await page.click('button[type="submit"]');
    await expect(page.locator('text=Active events')).toBeVisible({ timeout: 5_000 });
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test('API response time under 2 seconds', async ({ page }) => {
    await login(page);
    const start = Date.now();
    const resp  = await apiRequest(page, 'GET', '/disasters?limit=20');
    expect(Date.now() - start).toBeLessThan(2000);
    expect(resp.status()).toBe(200);
  });

  test('no console errors on dashboard', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await login(page);
    await page.waitForTimeout(2000);

    // Filter out known non-critical errors (e.g., CORS in test env)
    const criticalErrors = errors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('CORS') &&
      !e.includes('net::ERR')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
