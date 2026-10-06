import assert from 'node:assert/strict'
import { test } from 'node:test'
import request from 'supertest'

process.env.NODE_ENV = 'test'
process.env.MONGO_URI = ''
process.env.DEMO_MODE = 'false'
process.env.CRM_WEBHOOK_SECRET = 'test-secret'
const { app } = await import('../src/server.js')
const { createUser, getLatestAnalyticsSnapshot, getSearchConsoleHistory, saveAnalyticsSnapshot, saveSearchConsoleSnapshot } = await import('../src/store.js')
const { validatePublicUrl } = await import('../src/crawler.js')

test('health endpoint reports a healthy service', async () => {
  const response = await request(app).get('/api/health')
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.match(response.headers['x-content-type-options'], /nosniff/)
})

test('protected dashboard rejects anonymous requests', async () => {
  const response = await request(app).get('/api/dashboard')
  assert.equal(response.status, 401)
})

test('admin authentication protects the admin monitoring surface', async () => {
  await createUser({ name: 'Admin Test', email: 'admin-test@example.com', password: 'StrongPass123!', role: 'admin' })
  const agent = request.agent(app)
  const login = await agent.post('/api/auth/admin-login').send({ email: 'admin-test@example.com', password: 'StrongPass123!' })
  assert.equal(login.status, 200)
  const monitoring = await agent.get('/api/admin/monitoring')
  assert.equal(monitoring.status, 200)
  assert.equal(monitoring.body.ok, true)
})

test('password reset request does not reveal account existence', async () => {
  const response = await request(app).post('/api/auth/forgot-password').send({ email: 'unknown@example.com' })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
})

test('contact form validates input and reports missing delivery configuration', async () => {
  const invalid = await request(app).post('/api/contact').send({ email: 'not-an-email' })
  assert.equal(invalid.status, 400)
  const unconfigured = await request(app).post('/api/contact').send({ name: 'Contact Test', email: 'contact@example.com', message: 'Hello Growth OS' })
  assert.equal(unconfigured.status, 503)
})

test('CRM webhook stores a lead and returns its summary', async () => {
  const agent = request.agent(app)
  const registration = await agent.post('/api/auth/register').send({ name: 'CRM Test', email: 'crm-test@example.com', password: 'StrongPass123!' })
  assert.equal(registration.status, 201)
  const userId = registration.body.user.id
  const rejected = await request(app).post('/api/integrations/crm/webhook').set('x-growth-os-webhook-secret', 'wrong').send({ userId, type: 'lead', value: 10 })
  assert.equal(rejected.status, 401)
  const accepted = await request(app).post('/api/integrations/crm/webhook').set('x-growth-os-webhook-secret', 'test-secret').send({ userId, type: 'lead', value: 10 })
  assert.equal(accepted.status, 201)
  const call = await request(app).post('/api/integrations/crm/webhook').set('x-growth-os-webhook-secret', 'test-secret').send({ userId, type: 'call', value: 0 })
  assert.equal(call.status, 201)
  const summary = await agent.get('/api/leads/summary')
  assert.equal(summary.status, 200)
  assert.equal(summary.body.summary.lead.count, 1)
  assert.equal(summary.body.summary.call.count, 1)
})

test('authenticated reports stream and Analytics reports missing configuration clearly', async () => {
  const agent = request.agent(app)
  const registration = await agent.post('/api/auth/register').send({ name: 'Report Test', email: 'report-test@example.com', password: 'StrongPass123!' })
  assert.equal(registration.status, 201)
  const analytics = await agent.get('/api/analytics/overview')
  assert.equal(analytics.status, 200)
  assert.equal(analytics.body.configured, false)
  const csv = await agent.get('/api/reports/audit/download')
  assert.equal(csv.status, 200)
  assert.match(csv.headers['content-type'], /text\/csv/)
  assert.match(csv.text, /ga4_sessions/)
  const pdf = await agent.get('/api/reports/audit/pdf')
  assert.equal(pdf.status, 200)
  assert.match(pdf.headers['content-type'], /application\/pdf/)
  assert.ok(pdf.body.length > 500)
})

test('analytics snapshots persist and crawler rejects private targets', async () => {
  const record = await saveAnalyticsSnapshot('analytics-test-user', { propertyId: '123', sessions: 42, users: 21, conversions: 3, revenue: 99 })
  const latest = await getLatestAnalyticsSnapshot('analytics-test-user', '123')
  assert.equal(String(latest._id), String(record._id))
  assert.equal(latest.sessions, 42)
  assert.throws(() => validatePublicUrl('http://127.0.0.1:5000'), /Private or local network/)
})

test('Search Console snapshots retain a bounded trend history', async () => {
  await saveSearchConsoleSnapshot('trend-user', { siteUrl: 'sc-domain:trend.example', overview: { clicks: 1, impressions: 2, ctr: 50, position: 4 } })
  await saveSearchConsoleSnapshot('trend-user', { siteUrl: 'sc-domain:trend.example', overview: { clicks: 3, impressions: 5, ctr: 60, position: 3 } })
  const history = await getSearchConsoleHistory('trend-user', 'sc-domain:trend.example')
  assert.equal(history.length, 2)
  assert.equal(history.at(-1).overview.clicks, 3)
})

test('GEO and AEO analysis route is available to an authenticated client', async () => {
  const agent = request.agent(app)
  const registration = await agent.post('/api/auth/register').send({ name: 'Analysis Test', email: 'analysis-test@example.com', password: 'StrongPass123!' })
  assert.equal(registration.status, 201)
  const analysis = await agent.get('/api/analysis/geo-aeo')
  assert.equal(analysis.status, 200)
  assert.equal(analysis.body.source, 'awaiting-crawl')
  assert.equal(analysis.body.geoScore, 0)
  assert.equal(analysis.body.aeoScore, 0)
})
