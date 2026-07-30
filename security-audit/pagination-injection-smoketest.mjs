import { z } from 'zod';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  - ${name}`); }
  else      { fail++; console.log(`FAIL  - ${name}`); }
}

console.log('\n=== social-intel-service /social schema ===');
const socialQuerySchema = z.object({
  disasterId: z.string().optional(),
  platform:   z.string().optional(),
  verified:   z.enum(['true', 'false']).optional(),
  distress:   z.enum(['true', 'false']).optional(),
  severity:   z.string().optional(),
  limit:      z.coerce.number().int().positive().max(100).default(50),
  page:       z.coerce.number().int().positive().default(1)
});

// Normal use
{
  const r = socialQuerySchema.safeParse({ disasterId: 'abc-123', limit: '20', page: '2' });
  check('normal request parses', r.success);
  check('normal limit/page coerced to numbers', r.success && r.data.limit === 20 && r.data.page === 2);
}
// Injection attempt: express/qs would turn this into an object
{
  const r = socialQuerySchema.safeParse({ disasterId: { '$ne': null } });
  check('object-typed disasterId (NoSQL injection attempt) is REJECTED', !r.success);
}
{
  const r = socialQuerySchema.safeParse({ verified: { '$ne': null } });
  check('object-typed verified (NoSQL injection attempt) is REJECTED', !r.success);
}
// Abuse attempt: huge limit
{
  const r = socialQuerySchema.safeParse({ limit: '999999' });
  check('limit=999999 is REJECTED (exceeds max 100)', !r.success);
}
// Default limit stays capped
{
  const r = socialQuerySchema.safeParse({});
  check('no params -> default limit 50, page 1', r.success && r.data.limit === 50 && r.data.page === 1);
}

console.log('\n=== gis-service /gis/population-density schema ===');
const populationDensitySchema = z.object({
  lat:      z.coerce.number().min(-90).max(90),
  lng:      z.coerce.number().min(-180).max(180),
  radiusKm: z.coerce.number().positive().max(500).default(50)
});
{
  const r = populationDensitySchema.safeParse({ lat: '19.2', lng: '72.9' });
  check('normal lat/lng with default radius parses', r.success && r.data.radiusKm === 50);
}
{
  const r = populationDensitySchema.safeParse({ lat: '19.2', lng: '72.9', radiusKm: '999999' });
  check('radiusKm=999999 is REJECTED (exceeds max 500km)', !r.success);
}
{
  const r = populationDensitySchema.safeParse({ lat: '999', lng: '72.9' });
  check('lat=999 (out of range) is REJECTED', !r.success);
}

console.log('\n=== gis-service /gis/wildfire-spread schema ===');
const wildfireSpreadSchema = z.object({
  lat:              z.coerce.number().min(-90).max(90),
  lng:              z.coerce.number().min(-180).max(180),
  windSpeedKmh:     z.coerce.number().min(0).max(400).default(30),
  windDirectionDeg: z.coerce.number().min(0).max(360).default(225),
  humidityPct:      z.coerce.number().min(0).max(100).default(20),
  hours:            z.coerce.number().positive().max(168).default(24)
});
{
  const r = wildfireSpreadSchema.safeParse({ lat: '19.2', lng: '72.9', hours: '9999999' });
  check('hours=9999999 is REJECTED (previously totally unbounded)', !r.success);
}
{
  const r = wildfireSpreadSchema.safeParse({ lat: '19.2', lng: '72.9' });
  check('no hours param -> default 24', r.success && r.data.hours === 24);
}

console.log('\n=== pagination cap pattern (used across alert/sos/resource/historical/prediction/ai-service) ===');
function capLimit(rawLimit, fallback = 50, max = 100) {
  return Math.min(parseInt(rawLimit) || fallback, max);
}
function safePage(rawPage) {
  return Math.max(parseInt(rawPage) || 1, 1);
}
check('limit=99999 capped to 100', capLimit('99999') === 100);
check('limit=abc (NaN) falls back to default 50', capLimit('abc') === 50);
check('limit=20 passes through unchanged', capLimit('20') === 20);
check('page=-5 clamped to 1', safePage('-5') === 1);
check('page=0 clamped to 1', safePage('0') === 1);
check('page=abc clamped to 1', safePage('abc') === 1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
