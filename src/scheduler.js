import cron from 'node-cron'
import { google } from 'googleapis'
import { crawlWebsite } from './crawler.js'
import { sendEmail } from './mailer.js'
import { getGoogleConnection, listAllWebsites, listUsers, recordJobRun, saveCrawlResult, saveSearchConsoleSnapshot } from './store.js'

async function syncSearchConsole(user) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return false
  const connection = await getGoogleConnection(user._id)
  if (!connection?.tokens || !connection.siteUrl) return false
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI)
  auth.setCredentials(connection.tokens)
  const api = google.searchconsole({ version: 'v1', auth })
  const end = new Date(); const start = new Date(end); start.setDate(end.getDate() - 28)
  const request = (dimensions, rowLimit) => api.searchanalytics.query({ siteUrl: connection.siteUrl, requestBody: { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), dimensions, ...(rowLimit ? { rowLimit } : {}) } })
  const [overviewResponse, queryResponse, pageResponse, countryResponse] = await Promise.all([request([]), request(['query'], 25), request(['page'], 25), request(['country'], 25)])
  const row = overviewResponse.data.rows?.[0] || {}
  await saveSearchConsoleSnapshot(user._id, { siteUrl: connection.siteUrl, overview: { clicks: row.clicks || 0, impressions: row.impressions || 0, ctr: row.ctr > 1 ? row.ctr : (row.ctr || 0) * 100, position: row.position || 0 }, queries: queryResponse.data.rows || [], pages: pageResponse.data.rows || [], countries: countryResponse.data.rows || [] })
  return true
}

export async function runDailyCrawls() {
  const startedAt = new Date(); let completed = 0; let failed = 0; let searchConsoleSynced = 0; let searchConsoleFailed = 0
  for (const website of await listAllWebsites()) {
    if (!/^https?:\/\//i.test(website.url)) continue
    try { const result = await crawlWebsite(website.url); await saveCrawlResult({ userId: website.userId, websiteId: website._id, url: website.url, result }); completed++ } catch (error) { failed++; console.error(`Daily crawl failed for ${website.url}:`, error.message) }
  }
  for (const user of await listUsers()) {
    try { if (await syncSearchConsole(user)) searchConsoleSynced++ } catch (error) { searchConsoleFailed++; console.error(`Search Console sync failed for ${user.email}:`, error.message) }
  }
  const totalFailures = failed + searchConsoleFailed
  const job = await recordJobRun({ type: 'daily-monitoring', status: totalFailures ? 'completed_with_errors' : 'completed', completed, failed, searchConsoleSynced, searchConsoleFailed, startedAt })
  if (totalFailures && process.env.ADMIN_EMAIL) {
    await sendEmail({ to: process.env.ADMIN_EMAIL, subject: 'Growth OS daily monitoring needs attention', text: `Daily monitoring completed with ${failed} crawl failure(s), ${searchConsoleFailed} Search Console failure(s), ${completed} successful crawl(s), and ${searchConsoleSynced} Search Console sync(s). Review the Automation jobs page.` })
  }
  return job
}

export function startScheduler() {
  const expression = process.env.CRON_SCHEDULE || '0 2 * * *'
  if (!cron.validate(expression)) { console.warn(`Invalid CRON_SCHEDULE ${expression}; scheduler disabled.`); return null }
  return cron.schedule(expression, () => runDailyCrawls().catch((error) => console.error('Daily crawl job failed:', error.message)))
}
