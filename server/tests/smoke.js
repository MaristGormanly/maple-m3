// server/tests/smoke.js
// Usage: BASE_URL=https://m3.maristchat.com ADMIN_TOKEN=xxx node server/tests/smoke.js
// Defaults to localhost:3000 if BASE_URL is not set.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

async function run() {
  console.log(`\nRunning smoke tests against: ${BASE_URL}\n`);

  // /health
  await check('GET /health → 200 healthy', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.status === 'healthy', `Expected healthy, got ${body.status}`);
  });

  // /status happy path
  await check('GET /status → 200 with data array', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/campus/status`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.success === true, 'Expected success: true');
    assert(Array.isArray(body.data), 'Expected data to be an array');
  });

  // /status bad date
  await check('GET /status?date=bad → 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/campus/status?date=not-a-date`);
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    const body = await res.json();
    assert(body.error.code === 'VALIDATION_ERROR', `Expected VALIDATION_ERROR`);
  });

  // /chat happy path
  await check('POST /chat → 200 with response + sources', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/campus/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'What are the library hours?' })
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert(body.success === true, 'Expected success: true');
    assert(typeof body.data.response === 'string', 'Expected data.response to be a string');
    assert(Array.isArray(body.data.sources), 'Expected data.sources to be an array');
    assert(['high','medium','low','none'].includes(body.data.confidence), 'Invalid confidence value');
  });

  // /chat missing message
  await check('POST /chat (no message) → 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/campus/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    const body = await res.json();
    assert(body.error.code === 'VALIDATION_ERROR', 'Expected VALIDATION_ERROR');
  });

  // /ingest no auth
  await check('POST /ingest (no token) → 401 UNAUTHORIZED', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/campus/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_type: 'Admin' })
    });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
    const body = await res.json();
    assert(body.error.code === 'UNAUTHORIZED', 'Expected UNAUTHORIZED');
  });

  // /ingest wrong token
  await check('POST /ingest (wrong token) → 403 FORBIDDEN', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/campus/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer wrong-token' },
      body: JSON.stringify({ source_type: 'Admin' })
    });
    assert(res.status === 403, `Expected 403, got ${res.status}`);
    const body = await res.json();
    assert(body.error.code === 'FORBIDDEN', 'Expected FORBIDDEN');
  });

  // /ingest valid token + valid body
  await check('POST /ingest (valid token) → 202 with jobId', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/campus/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ source_type: 'Admin' })
    });
    assert(res.status === 202, `Expected 202, got ${res.status}`);
    const body = await res.json();
    assert(body.success === true, 'Expected success: true');
    assert(typeof body.data.jobId === 'string', 'Expected data.jobId to be a string');
  });

  // /ingest valid token + wrong source_type
  await check('POST /ingest (valid token, bad source_type) → 400 VALIDATION_ERROR', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/campus/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ source_type: 'Dining' })
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
    const body = await res.json();
    assert(body.error.code === 'VALIDATION_ERROR', 'Expected VALIDATION_ERROR');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });