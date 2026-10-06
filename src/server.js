import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import MongoStore from 'connect-mongo'
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import rateLimit from 'express-rate-limit'
import session from 'express-session'
import helmet from 'helmet'
import PDFDocument from 'pdfkit'
import { google } from 'googleapis'
import { crawlWebsite, validatePublicUrl } from './crawler.js'
import { calculateContentReadiness } from './analysis.js'
import { sendEmail } from './mailer.js'
import { startScheduler, runDailyCrawls } from './scheduler.js'
import {
  connectStore, createPasswordReset, createUser, createWebsite, findUserByEmail, findUserById,
  getGoogleConnection, getLatestAnalyticsSnapshot, getLatestCrawl, getSearchConsoleSnapshot, listAllWebsites, listJobRuns, listSearchConsoleSnapshots, listUsers, listWebsites,
  checkStore, consumePasswordReset, getSearchConsoleHistory, recordConversion, recordJobRun, saveAnalyticsSnapshot, saveCrawlResult, saveGoogleConnection, saveSearchConsoleSnapshot, summarizeConversions, updateUserPassword, upsertWebsite, verifyPassword,
} from './store.js'

dotenv.config()

const app = express()
const port = Number(process.env.PORT || 5000)
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
const hasGoogleConfig = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
const demoMode = process.env.DEMO_MODE === 'true'
const isProduction = process.env.NODE_ENV === 'production'
const sessionSameSite = ['lax', 'strict', 'none'].includes(String(process.env.SESSION_COOKIE_SAMESITE || '').toLowerCase()) ? String(process.env.SESSION_COOKIE_SAMESITE).toLowerCase() : 'lax'
const sessionStore = process.env.MONGO_URI ? MongoStore.create({ mongoUrl: process.env.MONGO_URI, dbName: process.env.MONGO_DB_NAME || 'growth_os', collectionName: 'sessions', ttl: 60 * 60 * 8 }) : undefined

app.disable('x-powered-by')
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false)
app.use(helmet())
app.use(cors({ origin: frontendUrl, credentials: true }))
app.use(express.json({ limit: '1mb' }))
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false })
const integrationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false })
const contactLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false })
app.use('/api/auth', authLimiter)
app.use('/api/integrations', integrationLimiter)
app.use(session({
  secret: process.env.SESSION_SECRET || 'growth-os-prototype-only',
  ...(sessionStore ? { store: sessionStore } : {}),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: sessionSameSite, secure: process.env.SESSION_COOKIE_SECURE === 'true' || isProduction, maxAge: 1000 * 60 * 60 * 8 },
}))

const demo = {
  siteUrl: 'sc-domain:acmedental.com', clicks: 1284, impressions: 24800, ctr: 5.18, position: 12.4,
  change: { clicks: 18.4, impressions: 12.8, leads: 9 },
  queries: [
    { query: 'dental implants near me', clicks: 214, impressions: 3200, ctr: 6.7, position: 8.2 },
    { query: 'emergency dentist', clicks: 173, impressions: 2800, ctr: 6.2, position: 10.1 },
    { query: 'teeth whitening', clicks: 148, impressions: 4100, ctr: 3.6, position: 15.7 },
  ],
  pages: [
    { page: 'https://acmedental.com/', clicks: 482, impressions: 6400, ctr: 7.5, position: 6.1 },
    { page: 'https://acmedental.com/dental-implants', clicks: 316, impressions: 5100, ctr: 6.2, position: 9.4 },
    { page: 'https://acmedental.com/emergency-dentist', clicks: 204, impressions: 3900, ctr: 5.2, position: 11.8 },
  ],
}

const clampScore = (value) => Math.max(0, Math.min(100, Math.round(value)))
function calculateScores(metrics, snapshot) {
  const position = Number(metrics.position || 0)
  const positionScore = position > 0 ? clampScore(100 - Math.max(0, (position - 1) * 5)) : 0
  const ctrScore = clampScore((Number(metrics.ctr || 0) / 5) * 100)
  const reachScore = clampScore(Math.log10(Number(metrics.impressions || 0) + 1) * 25)
  const queryScore = clampScore((snapshot?.queries?.length || 0) * 4)
  const pageScore = clampScore((snapshot?.pages?.length || 0) * 3)
  const seo = clampScore(positionScore * 0.5 + ctrScore * 0.3 + reachScore * 0.1 + pageScore * 0.1)
  const health = clampScore(positionScore * 0.6 + ctrScore * 0.25 + reachScore * 0.15)
  const geo = clampScore(seo * 0.7 + queryScore * 0.2 + pageScore * 0.1)
  const aeo = clampScore(seo * 0.65 + queryScore * 0.25 + pageScore * 0.1)
  return { health, seo, geo, aeo, components: { position: positionScore, ctr: ctrScore, reach: reachScore, queries: queryScore, pages: pageScore } }
}

async function getCurrentPerformance(userId, snapshot, metrics) {
  const websites = await listWebsites(userId)
  const website = websites.find((item) => snapshot?.siteUrl && (item.siteUrl === snapshot.siteUrl || item.url === snapshot.siteUrl)) || websites[0]
  const crawl = website ? await getLatestCrawl(userId, website._id) : null
  const readiness = calculateContentReadiness(crawl, snapshot)
  const scores = calculateScores(metrics, snapshot)
  scores.geo = readiness.geoScore
  scores.aeo = readiness.aeoScore
  if (crawl) {
    scores.health = clampScore(scores.health * 0.6 + crawl.score * 0.4)
    scores.seo = clampScore(scores.seo * 0.7 + crawl.score * 0.3)
  }
  return { websites, website, crawl, readiness, scores }
}

function getDashboardSignals({ websites, snapshot, crawl, metrics, conversionSummary }) {
  const crawlableWebsite = websites.find((website) => /^https?:\/\//i.test(website.url))
  const tasks = [
    { label: snapshot ? 'Search Console sync complete' : 'Connect Search Console', status: snapshot ? 'complete' : 'needs_connection' },
    { label: crawl ? 'Latest technical crawl complete' : (crawlableWebsite ? 'Run the first technical crawl' : 'Add a public website URL'), status: crawl ? 'complete' : 'pending' },
    { label: process.env.CRON_SCHEDULE ? 'Daily monitoring schedule configured' : 'Configure daily monitoring', status: process.env.CRON_SCHEDULE ? 'ready' : 'needs_connection' },
    { label: process.env.CRM_WEBHOOK_SECRET ? 'CRM lead and sales webhook ready' : 'Connect a CRM for lead and sales data', status: process.env.CRM_WEBHOOK_SECRET ? 'ready' : 'needs_connection' },
  ]
  const alerts = []
  if (!snapshot) alerts.push({ label: 'Search Console permission or property connection is required.', action: 'Connect Google', target: '/dashboard/visibility' })
  if (!crawlableWebsite) alerts.push({ label: 'Add a public website URL before running technical, GEO, or AEO analysis.', action: 'Add website', target: '/dashboard/settings' })
  else if (!crawl) alerts.push({ label: 'Run a technical crawl to calculate website, GEO, and AEO readiness.', action: 'Run crawl', target: '/dashboard/seo' })
  if (!process.env.GA4_PROPERTY_ID) alerts.push({ label: 'GA4 is not configured; traffic and revenue analytics are unavailable.', action: 'Review integrations', target: '/dashboard/settings' })
  const changesThisWeek = []
  if (snapshot?.syncedAt) changesThisWeek.push({ label: 'Search Console data synced', at: snapshot.syncedAt, source: 'Google Search Console' })
  if (crawl?.createdAt) changesThisWeek.push({ label: 'Technical website crawl completed', at: crawl.createdAt, source: 'Growth OS crawler' })
  if (!changesThisWeek.length) changesThisWeek.push({ label: 'No live changes recorded yet', at: null, source: 'Connect an integration to begin tracking' })
  const clicks = Number(metrics.clicks || 0); const impressions = Number(metrics.impressions || 0); const ctr = Number(metrics.ctr || 0)
  const estimatedOpportunity = Math.max(0, Math.round(impressions * Math.max(0, 0.05 - (ctr / 100))))
  return { tasks, alerts, changesThisWeek, estimatedOpportunity: { value: estimatedOpportunity, basis: 'Estimated additional clicks if eligible impressions reach a 5% CTR; not a revenue forecast.' }, leadCount: conversionSummary.lead?.count || 0, callCount: conversionSummary.call?.count || 0, salesCount: conversionSummary.sale?.count || 0 }
}

function googleClient() {
  if (!hasGoogleConfig) return null
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI)
}

function publicUser(user) { return { id: String(user._id), name: user.name, email: user.email, role: user.role } }

function requireAuth(role) {
  return async (req, res, next) => {
    if (!req.session.user?.id) return res.status(401).json({ error: 'Please log in first.' })
    const user = await findUserById(req.session.user.id)
    if (!user || (role && user.role !== role)) return res.status(403).json({ error: 'You do not have permission for this resource.' })
    req.user = user
    next()
  }
}

async function authenticate(req, res, role) {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' })
  let user = await findUserByEmail(email)
  if (!user && demoMode) user = await createUser({ name: req.body?.name || email.split('@')[0], email, password, role })
  if (!user || user.role !== role || !(await verifyPassword(user, password))) return res.status(401).json({ error: 'Email or password is incorrect.' })
  req.session.user = { id: String(user._id), role: user.role }
  return res.json({ user: publicUser(user) })
}

app.get('/api/health', async (_req, res) => {
  const store = await checkStore(); const ok = store.healthy
  res.status(ok ? 200 : 503).json({ ok, service: 'growth-os-backend', googleConfigured: hasGoogleConfig, storage: store.storage, storageLatencyMs: store.latencyMs, uptimeSeconds: Math.round(process.uptime()), demoMode })
})

app.post('/api/auth/register', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (!email || !password || password.length < 6) return res.status(400).json({ error: 'Use a valid email and a password with at least 6 characters.' })
  if (await findUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists.' })
  const user = await createUser({ name: `${req.body?.firstName || ''} ${req.body?.lastName || ''}`.trim(), email, password, role: 'user' })
  req.session.user = { id: String(user._id), role: 'user' }
  res.status(201).json({ user: publicUser(user) })
})

app.post('/api/auth/login', (req, res) => authenticate(req, res, 'user'))
app.post('/api/auth/admin-login', (req, res) => authenticate(req, res, 'admin'))
app.get('/api/auth/me', requireAuth(), (req, res) => res.json({ user: publicUser(req.user) }))
app.post('/api/auth/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })))
app.post('/api/auth/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase(); const user = email ? await findUserByEmail(email) : null
  if (user) {
    const token = crypto.randomBytes(32).toString('hex'); const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
    await createPasswordReset({ userId: user._id, tokenHash, expiresAt })
    const resetUrl = `${process.env.APP_URL || frontendUrl}/reset-password?token=${token}`
    await sendEmail({ to: user.email, subject: 'Reset your Growth OS password', text: `Use this link within one hour to reset your password: ${resetUrl}`, html: `<p>Use this link within one hour to reset your password:</p><p><a href="${resetUrl}">${resetUrl}</a></p>` })
  }
  res.json({ ok: true, message: 'If an account exists for that email, reset instructions have been sent.' })
})
app.post('/api/auth/reset-password', async (req, res) => {
  const token = String(req.body?.token || ''); const password = String(req.body?.password || '')
  if (token.length < 20 || password.length < 6) return res.status(400).json({ error: 'A valid reset token and password with at least 6 characters are required.' })
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); const reset = await consumePasswordReset(tokenHash)
  if (!reset) return res.status(400).json({ error: 'This reset link is invalid or expired.' })
  await updateUserPassword(reset.userId, await bcrypt.hash(password, 12)); res.json({ ok: true, message: 'Password reset successfully. You can log in now.' })
})
app.post('/api/contact', contactLimiter, async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120); const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254); const website = String(req.body?.website || '').trim().slice(0, 500); const message = String(req.body?.message || '').trim().slice(0, 4000)
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || !message) return res.status(400).json({ error: 'Name, a valid email, and a message are required.' })
  const recipient = String(process.env.ADMIN_EMAIL || '').trim()
  if (!recipient) return res.status(503).json({ error: 'Contact email delivery is not configured yet.' })
  try { await sendEmail({ to: recipient, replyTo: email, subject: `Growth OS enquiry from ${name}`, text: `Name: ${name}\nEmail: ${email}\nWebsite: ${website || 'Not provided'}\n\n${message}` }) } catch (error) { console.error('Contact email failed:', error.message); return res.status(502).json({ error: 'The enquiry could not be delivered. Please try again later.' }) }
  res.json({ ok: true, message: 'Thanks — your enquiry has been sent.' })
})

app.get('/api/auth/google', requireAuth('user'), (req, res) => {
  const client = googleClient()
  if (!client) return res.status(503).json({ error: 'Google OAuth is not configured.' })
  const state = crypto.randomBytes(24).toString('hex')
  req.session.oauthState = state
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly'], state })
  res.json({ url })
})

app.get('/api/auth/google/callback', async (req, res) => {
  const client = googleClient()
  if (!client) return res.status(503).send('Google OAuth is not configured.')
  if (!req.query.code || req.query.state !== req.session.oauthState) return res.status(400).send('Invalid Google OAuth callback.')
  try {
    const { tokens } = await client.getToken(String(req.query.code))
    req.session.googleTokens = tokens
    delete req.session.oauthState
    if (req.session.user?.id) await saveGoogleConnection(req.session.user.id, { tokens, siteUrl: null })
    res.redirect(`${frontendUrl}/dashboard/visibility?connected=1`)
  } catch (error) {
    console.error('Google OAuth callback failed:', error.message)
    res.status(502).send('Google authorization failed. Return to Growth OS and try again.')
  }
})

async function getGoogleAccess(req) {
  if (req.session.googleTokens) return { tokens: req.session.googleTokens, siteUrl: req.session.siteUrl }
  if (!req.user) return null
  return getGoogleConnection(req.user._id)
}

app.get('/api/search-console/properties', requireAuth('user'), async (req, res) => {
  const connection = await getGoogleAccess(req)
  if (!connection?.tokens) return res.status(401).json({ error: 'Connect Google Search Console first.' })
  try {
    const client = googleClient(); client.setCredentials(connection.tokens)
    const result = await google.searchconsole({ version: 'v1', auth: client }).sites.list()
    res.json({ properties: (result.data.siteEntry || []).map((site) => ({ siteUrl: site.siteUrl, permissionLevel: site.permissionLevel })) })
  } catch (error) { res.status(502).json({ error: 'Could not load Search Console properties.', detail: error.message }) }
})

app.post('/api/search-console/connect', requireAuth('user'), async (req, res) => {
  const { siteUrl } = req.body || {}
  const connection = await getGoogleAccess(req)
  if (!siteUrl || !connection?.tokens) return res.status(400).json({ error: 'Connect Google and select a property first.' })
  req.session.googleTokens = connection.tokens; req.session.siteUrl = siteUrl
  await saveGoogleConnection(req.user._id, { tokens: connection.tokens, siteUrl })
  const website = await upsertWebsite({ userId: req.user._id, name: siteUrl.replace(/^sc-domain:/, ''), url: siteUrl, siteUrl })
  res.json({ connected: true, siteUrl, websiteId: String(website._id) })
})

async function searchConsoleQuery(req, body) {
  const connection = await getGoogleAccess(req)
  if (!connection?.tokens || !connection.siteUrl) throw new Error('Select a Search Console property first.')
  const client = googleClient(); client.setCredentials(connection.tokens)
  const end = new Date(); const start = new Date(end); start.setDate(end.getDate() - 28)
  const response = await google.searchconsole({ version: 'v1', auth: client }).searchanalytics.query({ siteUrl: connection.siteUrl, requestBody: { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), ...body } })
  return { siteUrl: connection.siteUrl, rows: response.data.rows || [] }
}

app.get('/api/search-console/overview', requireAuth('user'), async (req, res) => {
  const snapshot = await getSearchConsoleSnapshot(req.user._id)
  try {
    const result = await searchConsoleQuery(req, { dimensions: [] }); const row = result.rows[0] || {}
    const overview = { clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr > 1 ? row.ctr : (row.ctr || 0) * 100, position: row.position || 0 }
    await saveSearchConsoleSnapshot(req.user._id, { siteUrl: result.siteUrl, overview })
    res.json({ source: 'google-search-console', siteUrl: result.siteUrl, ...overview, syncedAt: new Date().toISOString() })
  } catch (error) {
    if (snapshot?.overview) return res.json({ source: 'google-search-console-cache', siteUrl: snapshot.siteUrl, ...snapshot.overview, syncedAt: snapshot.syncedAt })
    if (demoMode && !req.session.googleTokens && !req.user?.googleConnection) return res.json({ source: 'demo', ...demo })
    res.status(502).json({ error: error.message })
  }
})

app.get('/api/search-console/queries', requireAuth('user'), async (req, res) => {
  const snapshot = await getSearchConsoleSnapshot(req.user._id)
  try { const result = await searchConsoleQuery(req, { dimensions: ['query'], rowLimit: 25 }); await saveSearchConsoleSnapshot(req.user._id, { siteUrl: result.siteUrl, queries: result.rows }); res.json({ source: 'google-search-console', ...result }) } catch (error) { if (snapshot?.queries) return res.json({ source: 'google-search-console-cache', siteUrl: snapshot.siteUrl, rows: snapshot.queries, syncedAt: snapshot.syncedAt }); if (demoMode) return res.json({ source: 'demo', rows: demo.queries }); res.status(502).json({ error: error.message }) }
})
app.get('/api/search-console/pages', requireAuth('user'), async (req, res) => {
  const snapshot = await getSearchConsoleSnapshot(req.user._id)
  try { const result = await searchConsoleQuery(req, { dimensions: ['page'], rowLimit: 25 }); await saveSearchConsoleSnapshot(req.user._id, { siteUrl: result.siteUrl, pages: result.rows }); res.json({ source: 'google-search-console', ...result }) } catch (error) { if (snapshot?.pages) return res.json({ source: 'google-search-console-cache', siteUrl: snapshot.siteUrl, rows: snapshot.pages, syncedAt: snapshot.syncedAt }); if (demoMode) return res.json({ source: 'demo', rows: demo.pages }); res.status(502).json({ error: error.message }) }
})
app.get('/api/search-console/countries', requireAuth('user'), async (req, res) => {
  const snapshot = await getSearchConsoleSnapshot(req.user._id)
  try { const result = await searchConsoleQuery(req, { dimensions: ['country'], rowLimit: 25 }); await saveSearchConsoleSnapshot(req.user._id, { siteUrl: result.siteUrl, countries: result.rows }); res.json({ source: 'google-search-console', ...result }) } catch (error) { if (snapshot?.countries) return res.json({ source: 'google-search-console-cache', siteUrl: snapshot.siteUrl, rows: snapshot.countries, syncedAt: snapshot.syncedAt }); if (demoMode) return res.json({ source: 'demo', rows: [] }); res.status(502).json({ error: error.message }) }
})
app.get('/api/search-console/trends', requireAuth('user'), async (req, res) => {
  const history = await getSearchConsoleHistory(req.user._id)
  res.json({ source: history.length ? 'google-search-console-history' : 'not-connected', rows: history })
})

app.get('/api/analytics/overview', requireAuth('user'), async (req, res) => {
  const propertyId = String(process.env.GA4_PROPERTY_ID || '').trim()
  const cached = await getLatestAnalyticsSnapshot(req.user._id, propertyId || null)
  const cachedPayload = cached ? { propertyId: cached.propertyId, sessions: cached.sessions || 0, users: cached.users || 0, conversions: cached.conversions || 0, revenue: cached.revenue || 0, syncedAt: cached.syncedAt } : null
  if (!propertyId) return res.json(cachedPayload ? { configured: false, source: 'cached-but-not-configured', ...cachedPayload } : { configured: false, source: 'not-configured', sessions: 0, users: 0, conversions: 0, revenue: 0 })
  const connection = await getGoogleAccess(req)
  if (!connection?.tokens) return cachedPayload ? res.json({ configured: true, source: 'google-analytics-cache', ...cachedPayload }) : res.status(401).json({ error: 'Connect Google Analytics first.', configured: true })
  try {
    const client = googleClient(); client.setCredentials(connection.tokens)
    const result = await google.analyticsdata({ version: 'v1beta', auth: client }).properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' }, { name: 'purchaseRevenue' }],
      },
    })
    const values = result.data.rows?.[0]?.metricValues || []
    const number = (index) => Number(values[index]?.value || 0) || 0
    const overview = { configured: true, source: 'google-analytics-4', propertyId, sessions: number(0), users: number(1), conversions: number(2), revenue: number(3) }
    const saved = await saveAnalyticsSnapshot(req.user._id, overview)
    res.json({ ...overview, syncedAt: saved.syncedAt })
  } catch (error) {
    if (cachedPayload) return res.json({ configured: true, source: 'google-analytics-cache', ...cachedPayload })
    res.status(502).json({ error: 'Could not load Google Analytics data.', detail: error.message })
  }
})

app.get('/api/leads/summary', requireAuth('user'), async (req, res) => {
  const summary = await summarizeConversions(req.user._id)
  res.json({ configured: Boolean(process.env.CRM_WEBHOOK_SECRET), source: process.env.CRM_WEBHOOK_SECRET ? 'crm-webhook' : 'not-configured', summary })
})

app.post('/api/integrations/crm/webhook', async (req, res) => {
  const configuredSecret = String(process.env.CRM_WEBHOOK_SECRET || '')
  const providedSecret = String(req.get('x-growth-os-webhook-secret') || '')
  if (!configuredSecret) return res.status(503).json({ error: 'CRM webhook is not configured.' })
  const expected = Buffer.from(configuredSecret); const received = Buffer.from(providedSecret)
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return res.status(401).json({ error: 'Invalid CRM webhook secret.' })
  const userId = String(req.body?.userId || '').trim()
  if (!userId || !await findUserById(userId)) return res.status(400).json({ error: 'A valid userId is required.' })
  const type = String(req.body?.type || 'lead').trim().toLowerCase()
  if (!['lead', 'sale', 'call', 'conversion'].includes(type)) return res.status(400).json({ error: 'type must be lead, sale, call, or conversion.' })
  const value = Number(req.body?.value || 0); const currency = String(req.body?.currency || 'USD').toUpperCase(); const occurredAt = req.body?.occurredAt ? new Date(req.body.occurredAt) : new Date()
  if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: 'value must be a non-negative number.' })
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(400).json({ error: 'currency must be a three-letter ISO code.' })
  if (Number.isNaN(occurredAt.getTime())) return res.status(400).json({ error: 'occurredAt must be a valid date.' })
  const conversion = await recordConversion({ userId, type, value, currency, source: 'crm-webhook', email: req.body?.email, occurredAt, metadata: req.body?.metadata || {} })
  res.status(201).json({ ok: true, id: String(conversion._id) })
})
app.post('/api/search-console/sync', requireAuth('user'), async (req, res) => {
  try {
    const [overviewResult, queryResult, pageResult, countryResult] = await Promise.all([searchConsoleQuery(req, { dimensions: [] }), searchConsoleQuery(req, { dimensions: ['query'], rowLimit: 25 }), searchConsoleQuery(req, { dimensions: ['page'], rowLimit: 25 }), searchConsoleQuery(req, { dimensions: ['country'], rowLimit: 25 })])
    const row = overviewResult.rows[0] || {}
    const overview = { clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr > 1 ? row.ctr : (row.ctr || 0) * 100, position: row.position || 0 }
    const snapshot = await saveSearchConsoleSnapshot(req.user._id, { siteUrl: overviewResult.siteUrl, overview, queries: queryResult.rows, pages: pageResult.rows, countries: countryResult.rows })
    res.json({ synced: true, siteUrl: overviewResult.siteUrl, syncedAt: snapshot.syncedAt })
  } catch (error) {
    if (demoMode) return res.json({ synced: false, source: 'demo', message: 'Demo data is already available. Connect a Search Console property for a live sync.' })
    res.status(502).json({ error: error.message })
  }
})

app.get('/api/dashboard', requireAuth('user'), async (req, res) => {
  const websites = await listWebsites(req.user._id)
  let snapshot = await getSearchConsoleSnapshot(req.user._id)
  let overview = snapshot?.overview
  if (!overview) {
    try {
      const result = await searchConsoleQuery(req, { dimensions: [] }); const row = result.rows[0] || {}
      overview = { clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr > 1 ? row.ctr : (row.ctr || 0) * 100, position: row.position || 0 }
      snapshot = await saveSearchConsoleSnapshot(req.user._id, { siteUrl: result.siteUrl, overview })
    } catch { /* the demo response below is used until a property is connected */ }
  }
  const source = overview ? 'google-search-console' : (demoMode ? 'demo' : 'not-connected')
  const metrics = overview || (demoMode ? { clicks: demo.clicks, impressions: demo.impressions, ctr: demo.ctr, position: demo.position } : { clicks: 0, impressions: 0, ctr: 0, position: 0 })
  const performance = await getCurrentPerformance(req.user._id, snapshot, metrics); const { scores, crawl: latestCrawl } = performance
  const conversionSummary = await summarizeConversions(req.user._id)
  const history = await getSearchConsoleHistory(req.user._id)
  const websiteRows = websites.map((website) => ({ id: String(website._id), name: website.name, url: website.url, status: website.status, siteUrl: website.siteUrl }))
  const crawl = latestCrawl ? { score: latestCrawl.score, pagesCrawled: latestCrawl.pagesCrawled, createdAt: latestCrawl.createdAt } : null
  return res.json({ source, siteUrl: snapshot?.siteUrl || (demoMode ? demo.siteUrl : null), ...metrics, ...scores, visibility: scores.seo, leads: conversionSummary.lead?.count || 0, calls: conversionSummary.call?.count || 0, sales: conversionSummary.sale?.count || 0, revenue: conversionSummary.sale?.value || 0, crawl, syncedAt: snapshot?.syncedAt || null, trend: history, websites: websiteRows, ...getDashboardSignals({ websites, snapshot, crawl, metrics, conversionSummary }) })
})
app.get('/api/seo-analysis', requireAuth('user'), async (req, res) => {
  let snapshot = await getSearchConsoleSnapshot(req.user._id)
  if (!snapshot?.queries) {
    try { const result = await searchConsoleQuery(req, { dimensions: ['query'], rowLimit: 25 }); snapshot = await saveSearchConsoleSnapshot(req.user._id, { siteUrl: result.siteUrl, queries: result.rows, overview: snapshot?.overview }) } catch { /* demo findings are returned when no property is connected */ }
  }
  const queries = snapshot?.queries || (demoMode ? demo.queries : [])
  const findings = queries.slice(0, 3).map((row) => ({ name: row.keys?.[0] ? `Improve ${row.keys[0]} visibility` : 'Improve high-impression query visibility', area: 'Search Console', impact: (row.impressions || 0) > 1000 ? 'High impact' : 'Review', query: row.keys?.[0] || row.query || '' }))
  while (findings.length < 3) findings.push([{ name: 'Run a Search Console sync to find page opportunities', area: 'Search Console', impact: 'Review', query: '' }][0])
  const performance = await getCurrentPerformance(req.user._id, snapshot, snapshot?.overview || demo); const { website, crawl, readiness } = performance; const score = performance.scores.seo
  if (crawl?.issues) crawl.issues.slice(0, 3).forEach((issue) => findings.push({ name: issue.message, area: 'Technical SEO', impact: issue.severity === 'high' ? 'High impact' : 'Review', query: '' }))
  res.json({ source: snapshot ? 'google-search-console-and-crawl' : (demoMode ? 'demo' : 'not-connected'), siteUrl: snapshot?.siteUrl || website?.url || null, score, findings: findings.slice(0, 8), crawl, geoScore: readiness.geoScore, aeoScore: readiness.aeoScore, syncedAt: snapshot?.syncedAt || crawl?.createdAt || null })
})
app.get('/api/recommendations', requireAuth('user'), async (req, res) => {
  let snapshot = await getSearchConsoleSnapshot(req.user._id)
  if (!snapshot?.queries || !snapshot?.pages) {
    try {
      const [queryResult, pageResult] = await Promise.all([searchConsoleQuery(req, { dimensions: ['query'], rowLimit: 25 }), searchConsoleQuery(req, { dimensions: ['page'], rowLimit: 25 })])
      snapshot = await saveSearchConsoleSnapshot(req.user._id, { siteUrl: queryResult.siteUrl, queries: queryResult.rows, pages: pageResult.rows, overview: snapshot?.overview })
    } catch { /* demo recommendations are returned when no property is connected */ }
  }
  const queries = snapshot?.queries || (demoMode ? demo.queries : [])
  const pages = snapshot?.pages || (demoMode ? demo.pages : [])
  const rows = []
  queries.slice(0, 5).forEach((row) => {
    const query = row.keys?.[0] || row.query || 'high-impression query'
    if (Number(row.impressions || 0) > 0 && Number(row.ctr || 0) < 0.03) rows.push({ name: `Improve title and description for “${query}”`, area: 'SEO', impact: 'High', evidence: `${row.impressions} impressions with low CTR`, status: 'pending' })
    else if (Number(row.position || 0) >= 8 && Number(row.position || 0) <= 20) rows.push({ name: `Refresh content targeting “${query}”`, area: 'SEO', impact: 'High', evidence: `Average position ${Number(row.position).toFixed(1)}`, status: 'pending' })
  })
  pages.slice(0, 5).forEach((row) => { if (rows.length < 5) rows.push({ name: `Add clearer answers and internal links to ${row.keys?.[0] || row.page || 'a visible page'}`, area: 'GEO/AEO', impact: 'Medium', evidence: `${row.clicks || 0} clicks and ${row.impressions || 0} impressions`, status: 'pending' }) })
  if (!rows.length) rows.push({ name: 'Collect more Search Console data before prioritizing changes', area: 'Search Console', impact: 'Review', evidence: 'No actionable query threshold reached yet', status: 'pending' })
  res.json({ source: snapshot ? 'google-search-console-cache' : (demoMode ? 'demo' : 'not-connected'), rows })
})
app.get('/api/reports', requireAuth('user'), async (req, res) => {
  const snapshot = await getSearchConsoleSnapshot(req.user._id)
  res.json({ source: snapshot ? 'google-search-console-cache' : (demoMode ? 'demo' : 'not-connected'), reports: [['Website audit', 'CSV', snapshot?.syncedAt || 'Not generated', 'audit'], ['Weekly monitoring', 'CSV', snapshot?.syncedAt || 'Not generated', 'weekly'], ['Monthly growth report', 'CSV', snapshot?.syncedAt || 'Not generated', 'monthly']] })
})
app.get('/api/reports/:kind/download', requireAuth('user'), async (req, res) => {
  const snapshot = await getSearchConsoleSnapshot(req.user._id)
  const overview = snapshot?.overview || (demoMode ? demo : { clicks: 0, impressions: 0, ctr: 0, position: 0 })
  const { scores } = await getCurrentPerformance(req.user._id, snapshot, overview)
  const analyticsSnapshot = await getLatestAnalyticsSnapshot(req.user._id); const conversions = await summarizeConversions(req.user._id)
  const rows = [['Growth OS report', req.params.kind], ['source', snapshot ? 'Google Search Console' : (demoMode ? 'Demo fallback' : 'Not connected')], ['property', snapshot?.siteUrl || (demoMode ? demo.siteUrl : 'Not connected')], ['synced_at', snapshot?.syncedAt || 'Not generated'], [], ['metric', 'value'], ['clicks', overview.clicks || 0], ['impressions', overview.impressions || 0], ['ctr_percent', overview.ctr || 0], ['average_position', overview.position || 0], ['search_health_score', scores.health], ['seo_signal_score', scores.seo], ['geo_readiness_score', scores.geo], ['aeo_readiness_score', scores.aeo], ['ga4_sessions', analyticsSnapshot?.sessions || 0], ['ga4_users', analyticsSnapshot?.users || 0], ['ga4_conversions', analyticsSnapshot?.conversions || 0], ['ga4_revenue', analyticsSnapshot?.revenue || 0], ['crm_leads', conversions.lead?.count || 0], ['crm_calls', conversions.call?.count || 0], ['crm_sales', conversions.sale?.count || 0], ['crm_sales_value', conversions.sale?.value || 0]]
  if (req.params.kind === 'weekly' && snapshot?.queries) { rows.push([], ['query', 'clicks', 'impressions', 'ctr', 'position']); snapshot.queries.forEach((row) => rows.push([row.keys?.[0] || '', row.clicks || 0, row.impressions || 0, row.ctr || 0, row.position || 0])) }
  if (req.params.kind === 'monthly' && snapshot?.pages) { rows.push([], ['page', 'clicks', 'impressions', 'ctr', 'position']); snapshot.pages.forEach((row) => rows.push([row.keys?.[0] || '', row.clicks || 0, row.impressions || 0, row.ctr || 0, row.position || 0])) }
  const csv = rows.map((line) => line.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n')
  const kind = ['audit', 'weekly', 'monthly'].includes(req.params.kind) ? req.params.kind : 'report'
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="growth-os-${kind}-report.csv"`); res.send(csv)
})
app.get('/api/reports/:kind/pdf', requireAuth('user'), async (req, res) => {
  const snapshot = await getSearchConsoleSnapshot(req.user._id); const overview = snapshot?.overview || (demoMode ? demo : { clicks: 0, impressions: 0, ctr: 0, position: 0 }); const { scores } = await getCurrentPerformance(req.user._id, snapshot, overview); const analyticsSnapshot = await getLatestAnalyticsSnapshot(req.user._id); const conversions = await summarizeConversions(req.user._id)
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="growth-os-${req.params.kind}-report.pdf"`)
  const pdf = new PDFDocument({ margin: 48 }); pdf.pipe(res); pdf.fontSize(22).text('Growth OS report'); pdf.moveDown(); pdf.fontSize(11).text(`Report: ${req.params.kind}`); pdf.text(`Source: ${snapshot ? 'Google Search Console' : (demoMode ? 'Demo fallback' : 'Not connected')}`); pdf.text(`Property: ${snapshot?.siteUrl || (demoMode ? demo.siteUrl : 'Not connected')}`); pdf.text(`Synced: ${snapshot?.syncedAt || 'Not generated'}`); pdf.moveDown(); pdf.fontSize(15).text('Performance'); pdf.fontSize(11).text(`Clicks: ${overview.clicks || 0}`); pdf.text(`Impressions: ${overview.impressions || 0}`); pdf.text(`CTR: ${overview.ctr || 0}%`); pdf.text(`Average position: ${overview.position || 0}`); pdf.text(`GA4 sessions: ${analyticsSnapshot?.sessions || 0}`); pdf.text(`GA4 conversions: ${analyticsSnapshot?.conversions || 0}`); pdf.text(`GA4 revenue: ${analyticsSnapshot?.revenue || 0}`); pdf.text(`CRM leads: ${conversions.lead?.count || 0}`); pdf.text(`CRM calls: ${conversions.call?.count || 0}`); pdf.text(`CRM sales: ${conversions.sale?.count || 0}`); pdf.text(`CRM sales value: ${conversions.sale?.value || 0}`); pdf.moveDown(); pdf.fontSize(15).text('Calculated readiness'); pdf.fontSize(11).text(`Search health: ${scores.health}/100`); pdf.text(`SEO signal: ${scores.seo}/100`); pdf.text(`GEO readiness: ${scores.geo}/100`); pdf.text(`AEO readiness: ${scores.aeo}/100`); pdf.moveDown(); pdf.fontSize(9).fillColor('#555').text('GEO and AEO are calculated readiness signals, not Google-issued scores.'); pdf.end()
})
async function findOwnedWebsite(req, websiteId) { return (await listWebsites(req.user._id)).find((website) => String(website._id) === String(websiteId)) }
app.post('/api/websites/:websiteId/crawl', requireAuth('user'), async (req, res) => {
  const website = await findOwnedWebsite(req, req.params.websiteId); if (!website) return res.status(404).json({ error: 'Website not found.' })
  try { const result = await crawlWebsite(website.url); const crawl = await saveCrawlResult({ userId: req.user._id, websiteId: website._id, url: website.url, result }); res.json({ crawl }) } catch (error) { res.status(502).json({ error: error.message }) }
})
app.get('/api/websites/:websiteId/crawl/latest', requireAuth('user'), async (req, res) => {
  const website = await findOwnedWebsite(req, req.params.websiteId); if (!website) return res.status(404).json({ error: 'Website not found.' }); const crawl = await getLatestCrawl(req.user._id, website._id); res.json({ crawl })
})
app.get('/api/analysis/geo-aeo', requireAuth('user'), async (req, res) => {
  const snapshot = await getSearchConsoleSnapshot(req.user._id); const websites = await listWebsites(req.user._id); const website = req.query.websiteId ? await findOwnedWebsite(req, req.query.websiteId) : (websites.find((item) => snapshot?.siteUrl && (item.siteUrl === snapshot.siteUrl || item.url === snapshot.siteUrl)) || websites[0])
  const crawl = website ? await getLatestCrawl(req.user._id, website._id) : null; const readiness = calculateContentReadiness(crawl, snapshot)
  res.json({ source: crawl ? 'website-crawl-and-search-console' : 'awaiting-crawl', website: website ? { id: String(website._id), name: website.name, url: website.url } : null, crawl, ...readiness })
})
app.post('/api/websites', requireAuth('user'), async (req, res) => { const { name, url } = req.body || {}; if (!name || !url) return res.status(400).json({ error: 'Name and URL are required.' }); try { validatePublicUrl(url) } catch (error) { return res.status(400).json({ error: error.message }) } const website = await upsertWebsite({ userId: req.user._id, name, url }); res.status(201).json({ website: { ...website, _id: String(website._id), userId: String(website.userId) } }) })
app.get('/api/websites', requireAuth('user'), async (req, res) => res.json({ websites: (await listWebsites(req.user._id)).map((website) => ({ ...website, _id: String(website._id), userId: String(website.userId) })) }))

app.get('/api/admin/websites', requireAuth('admin'), async (_req, res) => res.json({ websites: (await listAllWebsites()).map((website) => ({ ...website, _id: String(website._id), userId: String(website.userId) })) }))
app.post('/api/admin/websites', requireAuth('admin'), async (req, res) => { const { name, url, userId } = req.body || {}; if (!name || !url || !userId) return res.status(400).json({ error: 'Name, URL, and a client owner are required.' }); const owner = await findUserById(userId); if (!owner || owner.role !== 'user') return res.status(400).json({ error: 'Choose a valid client user as the website owner.' }); try { validatePublicUrl(url) } catch (error) { return res.status(400).json({ error: error.message }) } const website = await upsertWebsite({ userId: owner._id, name, url }); res.status(201).json({ website: { ...website, _id: String(website._id), userId: String(website.userId) } }) })
app.get('/api/admin/jobs', requireAuth('admin'), async (_req, res) => { const runs = await listJobRuns(); res.json({ rows: runs.length ? runs.map((run) => ({ name: run.type, status: run.status, completed: run.completed, failed: run.failed, searchConsoleSynced: run.searchConsoleSynced, searchConsoleFailed: run.searchConsoleFailed, createdAt: run.createdAt })) : [{ name: 'Daily monitoring', status: 'Scheduled' }] }) })
app.post('/api/admin/jobs/run-crawl', requireAuth('admin'), async (_req, res) => { try { const job = await runDailyCrawls(); res.json({ ok: true, job }) } catch (error) { await recordJobRun({ type: 'daily-crawl', status: 'failed', error: error.message }); res.status(500).json({ error: error.message }) } })
app.get('/api/admin/summary', requireAuth('admin'), async (_req, res) => {
  const clients = await listUsers(); const websites = await listAllWebsites(); const snapshots = await listSearchConsoleSnapshots(); const latest = snapshots[0]
  const metrics = latest?.overview || (demoMode ? demo : { clicks: 0, impressions: 0, ctr: 0, position: 0 }); const performance = latest?.userId ? await getCurrentPerformance(latest.userId, latest, metrics) : { scores: calculateScores(metrics, latest), crawl: null }; const scores = performance.scores
  res.json({ ...scores, clicks: metrics.clicks || 0, impressions: metrics.impressions || 0, ctr: metrics.ctr || 0, position: metrics.position || 0, clients: clients.length, websites: websites.length, connectedWebsites: websites.filter((website) => website.status === 'connected').length, latestProperty: latest?.siteUrl || null, syncedAt: latest?.syncedAt || null, crawl: performance.crawl ? { score: performance.crawl.score, pagesCrawled: performance.crawl.pagesCrawled, createdAt: performance.crawl.createdAt } : null })
})
app.get('/api/admin/integrations', requireAuth('admin'), (_req, res) => res.json({
  searchConsole: { configured: hasGoogleConfig, status: hasGoogleConfig ? 'Configured' : 'Needs OAuth credentials' },
  analytics: { configured: Boolean(process.env.GA4_PROPERTY_ID), status: process.env.GA4_PROPERTY_ID ? 'Configured' : 'Add GA4_PROPERTY_ID' },
  crm: { configured: Boolean(process.env.CRM_WEBHOOK_SECRET), status: process.env.CRM_WEBHOOK_SECRET ? 'Webhook ready' : 'Add CRM_WEBHOOK_SECRET' },
  smtp: { configured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS), status: process.env.SMTP_HOST ? 'Configured' : 'Development preview only' },
}))
app.get('/api/admin/monitoring', requireAuth('admin'), async (_req, res) => {
  const store = await checkStore(); const recentJobs = await listJobRuns(5); const memoryUsage = process.memoryUsage()
  res.status(store.healthy ? 200 : 503).json({ ok: store.healthy, storage: store, uptimeSeconds: Math.round(process.uptime()), nodeVersion: process.version, memory: { rss: memoryUsage.rss, heapUsed: memoryUsage.heapUsed, heapTotal: memoryUsage.heapTotal }, recentJobs: recentJobs.map((job) => ({ type: job.type, status: job.status, createdAt: job.createdAt })) })
})
app.post('/api/admin/clients', requireAuth('admin'), async (req, res) => {
  const name = String(req.body?.name || '').trim(); const email = String(req.body?.email || '').trim().toLowerCase(); const password = String(req.body?.password || '')
  if (!name || !email || password.length < 6) return res.status(400).json({ error: 'Name, email, and a password with at least 6 characters are required.' })
  if (await findUserByEmail(email)) return res.status(409).json({ error: 'A user with this email already exists.' })
  try { const user = await createUser({ name, email, password, role: 'user' }); res.status(201).json({ user: { id: String(user._id), name: user.name, email: user.email, role: user.role } }) } catch (error) { res.status(400).json({ error: error.message }) }
})
app.get('/api/admin/clients', requireAuth('admin'), async (_req, res) => {
  const clientUsers = await listUsers()
  const allWebsites = await listAllWebsites()
  const clients = clientUsers.map((user) => ({
    id: String(user._id), name: user.name, email: user.email,
    websites: allWebsites.filter((website) => String(website.userId) === String(user._id)).length,
    status: 'Active', createdAt: user.createdAt,
  }))
  res.json({ clients })
})

export { app }
export async function startServer() {
  if (isProduction) {
    const sessionSecret = process.env.SESSION_SECRET || ''
    const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY || ''
    if (!process.env.MONGO_URI || sessionSecret.length < 32 || encryptionKey.length < 32 || /replace|change-this|prototype-only/i.test(`${sessionSecret} ${encryptionKey}`)) throw new Error('Production startup requires MONGO_URI plus long, non-default SESSION_SECRET and TOKEN_ENCRYPTION_KEY values.')
    if (sessionSameSite === 'none' && process.env.SESSION_COOKIE_SECURE !== 'true') throw new Error('SESSION_COOKIE_SECURE=true is required when SESSION_COOKIE_SAMESITE=none.')
  }
  await connectStore(); startScheduler(); return app.listen(port, () => console.log(`Growth OS backend listening on http://localhost:${port}`))
}
if (process.env.NODE_ENV !== 'test') await startServer()
