import dotenv from 'dotenv'
import cron from 'node-cron'

dotenv.config()

const production = process.env.NODE_ENV === 'production'
const failures = []
const warnings = []
const required = (name) => { if (!String(process.env[name] || '').trim()) failures.push(`${name} is required.`) }

if (production) {
  required('MONGO_URI'); required('SESSION_SECRET'); required('TOKEN_ENCRYPTION_KEY'); required('FRONTEND_URL'); required('APP_URL'); required('GOOGLE_CLIENT_ID'); required('GOOGLE_CLIENT_SECRET'); required('GOOGLE_REDIRECT_URI')
  if (String(process.env.SESSION_SECRET || '').length < 32 || /replace|change-this|prototype-only/i.test(String(process.env.SESSION_SECRET || ''))) failures.push('SESSION_SECRET must be a long, non-default value.')
  if (String(process.env.TOKEN_ENCRYPTION_KEY || '').length < 32 || /replace|change-this|prototype-only/i.test(String(process.env.TOKEN_ENCRYPTION_KEY || ''))) failures.push('TOKEN_ENCRYPTION_KEY must be a long, non-default value.')
  for (const name of ['FRONTEND_URL', 'APP_URL', 'GOOGLE_REDIRECT_URI']) if (process.env[name] && !/^https:\/\//i.test(process.env[name])) failures.push(`${name} must use HTTPS in production.`)
  if (process.env.SESSION_COOKIE_SECURE !== 'true') failures.push('SESSION_COOKIE_SECURE=true is required in production.')
  if (!['lax', 'strict', 'none'].includes(String(process.env.SESSION_COOKIE_SAMESITE || 'lax').toLowerCase())) failures.push('SESSION_COOKIE_SAMESITE must be lax, strict, or none.')
  if (process.env.TRUST_PROXY !== 'true') warnings.push('TRUST_PROXY=true is recommended behind a hosted HTTPS proxy.')
} else {
  if (!process.env.MONGO_URI) warnings.push('MONGO_URI is empty; the application will use temporary memory storage.')
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) warnings.push('Google OAuth credentials are not configured.')
}

if (process.env.DEMO_MODE === 'true' && production) failures.push('DEMO_MODE must be false in production.')
const cronExpression = process.env.CRON_SCHEDULE || '0 2 * * *'
if (!cron.validate(cronExpression)) failures.push(`CRON_SCHEDULE is invalid: ${cronExpression}`)
if (!process.env.GA4_PROPERTY_ID) warnings.push('GA4_PROPERTY_ID is not set; Analytics reports will remain unconfigured.')
if (!process.env.CRM_WEBHOOK_SECRET) warnings.push('CRM_WEBHOOK_SECRET is not set; CRM webhooks will remain disabled.')
if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) warnings.push('SMTP is not configured; password reset/contact/failure emails cannot be delivered.')

if (failures.length) {
  console.error('Growth OS preflight failed:')
  failures.forEach((message) => console.error(`- ${message}`))
  process.exitCode = 1
} else {
  console.log(`Growth OS preflight passed (${production ? 'production' : 'development'} mode).`)
}
warnings.forEach((message) => console.warn(`Warning: ${message}`))
