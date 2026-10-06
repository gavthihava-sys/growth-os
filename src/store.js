import crypto from 'node:crypto'
import { MongoClient, ObjectId } from 'mongodb'
import bcrypt from 'bcryptjs'

let client
let database
let mongoReady = false
const memory = { users: [], websites: [], searchConsole: [], analytics: [], crawls: [], jobs: [], passwordResets: [], conversions: [] }

const id = (value) => value && ObjectId.isValid(value) ? new ObjectId(value) : value
const tokenKey = () => crypto.createHash('sha256').update(process.env.TOKEN_ENCRYPTION_KEY || process.env.SESSION_SECRET || 'growth-os-local-key').digest()

export function encrypt(value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(), iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${encrypted.toString('hex')}`
}

export function decrypt(value) {
  const [ivHex, tagHex, dataHex] = String(value).split('.')
  const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8'))
}

export async function connectStore() {
  const uri = process.env.MONGO_URI
  if (!uri) return console.warn('MONGO_URI is not set; using temporary memory storage.')
  try {
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 2500 })
    await client.connect()
    database = client.db(process.env.MONGO_DB_NAME || 'growth_os')
    await Promise.all([
      database.collection('users').createIndex({ email: 1 }, { unique: true }),
      database.collection('websites').createIndex({ userId: 1 }),
      database.collection('websites').createIndex({ userId: 1, url: 1 }, { unique: true }),
      database.collection('search_console').createIndex({ userId: 1, siteUrl: 1 }, { unique: true }),
      database.collection('analytics').createIndex({ userId: 1, propertyId: 1, syncedAt: -1 }),
      database.collection('crawls').createIndex({ userId: 1, websiteId: 1, createdAt: -1 }),
      database.collection('jobs').createIndex({ createdAt: -1 }),
      database.collection('password_resets').createIndex({ tokenHash: 1 }, { unique: true }),
      database.collection('password_resets').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      database.collection('conversions').createIndex({ userId: 1, occurredAt: -1 }),
    ])
    mongoReady = true
    console.log(`MongoDB connected: ${process.env.MONGO_DB_NAME || 'growth_os'}`)
  } catch (error) {
    mongoReady = false
    if (process.env.NODE_ENV === 'production') throw error
    console.warn(`MongoDB unavailable (${error.message}); using temporary memory storage until it is started.`)
  }
}

export const storageStatus = () => mongoReady ? 'mongodb' : 'memory'
export async function checkStore() {
  if (!mongoReady || !database) return { storage: 'memory', healthy: !process.env.MONGO_URI, latencyMs: null }
  const started = Date.now()
  try { await database.command({ ping: 1 }); return { storage: 'mongodb', healthy: true, latencyMs: Date.now() - started } }
  catch (error) { mongoReady = false; return { storage: 'memory', healthy: false, latencyMs: Date.now() - started, error: error.message } }
}
const users = () => mongoReady ? database.collection('users') : null
const websites = () => mongoReady ? database.collection('websites') : null
const searchConsole = () => mongoReady ? database.collection('search_console') : null
const analytics = () => mongoReady ? database.collection('analytics') : null
const crawls = () => mongoReady ? database.collection('crawls') : null
const jobs = () => mongoReady ? database.collection('jobs') : null
const passwordResets = () => mongoReady ? database.collection('password_resets') : null
const conversions = () => mongoReady ? database.collection('conversions') : null

export async function findUserByEmail(email) {
  const normalized = email.trim().toLowerCase()
  return mongoReady ? users().findOne({ email: normalized }) : memory.users.find((user) => user.email === normalized) || null
}

export async function findUserById(userId) {
  return mongoReady ? users().findOne({ _id: id(userId) }) : memory.users.find((user) => String(user._id) === String(userId)) || null
}

export async function listUsers() {
  if (mongoReady) return users().find({ role: 'user' }, { projection: { passwordHash: 0, googleConnection: 0 } }).sort({ createdAt: -1 }).toArray()
  return memory.users.filter((user) => user.role === 'user').map(({ passwordHash, googleConnection, ...publicUser }) => publicUser)
}

export async function createUser({ name, email, password, role = 'user' }) {
  const user = { name: name?.trim() || email.split('@')[0], email: email.trim().toLowerCase(), passwordHash: await bcrypt.hash(password, 12), role, createdAt: new Date(), googleConnection: null }
  if (mongoReady) { const result = await users().insertOne(user); return { ...user, _id: result.insertedId } }
  user._id = new ObjectId(); memory.users.push(user); return user
}

export async function verifyPassword(user, password) { return user ? bcrypt.compare(password, user.passwordHash) : false }

export async function saveGoogleConnection(userId, { tokens, siteUrl }) {
  const update = { googleConnection: { siteUrl, tokens: encrypt(tokens), updatedAt: new Date() } }
  if (mongoReady) return users().updateOne({ _id: id(userId) }, { $set: update })
  const user = memory.users.find((item) => String(item._id) === String(userId)); if (user) Object.assign(user, update)
}

export async function getGoogleConnection(userId) {
  const user = await findUserById(userId)
  if (!user?.googleConnection) return null
  return { siteUrl: user.googleConnection.siteUrl, tokens: decrypt(user.googleConnection.tokens) }
}

export async function createWebsite({ userId, name, url, siteUrl = null }) {
  const website = { userId: id(userId), name: name.trim(), url: url.trim(), siteUrl, status: 'pending_connection', createdAt: new Date() }
  if (mongoReady) { const result = await websites().insertOne(website); return { ...website, _id: result.insertedId } }
  website._id = new ObjectId(); memory.websites.push(website); return website
}

export async function upsertWebsite({ userId, name, url, siteUrl = null }) {
  const filter = siteUrl ? { userId: id(userId), $or: [{ siteUrl }, { url: url.trim() }] } : { userId: id(userId), url: url.trim() }
  const update = { $set: { name: name.trim(), url: url.trim(), siteUrl, status: siteUrl ? 'connected' : 'pending_connection', updatedAt: new Date() }, $setOnInsert: { userId: id(userId), createdAt: new Date() } }
  if (mongoReady) return websites().findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after' })
  const existing = memory.websites.find((website) => String(website.userId) === String(userId) && (siteUrl ? (website.siteUrl === siteUrl || website.url === url.trim()) : website.url === url.trim()))
  if (existing) { Object.assign(existing, update.$set); return existing }
  const website = { userId: id(userId), name: name.trim(), url: url.trim(), siteUrl, status: siteUrl ? 'connected' : 'pending_connection', createdAt: new Date(), updatedAt: new Date(), _id: new ObjectId() }
  memory.websites.push(website); return website
}

export async function listWebsites(userId) {
  if (mongoReady) return websites().find({ userId: id(userId) }).sort({ createdAt: -1 }).toArray()
  return memory.websites.filter((website) => String(website.userId) === String(userId))
}

export async function listAllWebsites() {
  if (mongoReady) return websites().find().sort({ createdAt: -1 }).toArray()
  return memory.websites
}

export async function saveSearchConsoleSnapshot(userId, { siteUrl, overview, queries, pages, countries }) {
  const syncedAt = new Date(); const update = { userId: id(userId), siteUrl, ...(overview ? { overview } : {}), ...(queries ? { queries } : {}), ...(pages ? { pages } : {}), ...(countries ? { countries } : {}), syncedAt }
  const operators = { $set: update }
  if (overview) operators.$push = { history: { $each: [{ syncedAt, overview }], $slice: -90 } }
  if (mongoReady) return searchConsole().findOneAndUpdate({ userId: id(userId), siteUrl }, operators, { upsert: true, returnDocument: 'after' })
  const existing = memory.searchConsole.find((item) => String(item.userId) === String(userId) && item.siteUrl === siteUrl)
  if (existing) { Object.assign(existing, update); if (overview) existing.history = [...(existing.history || []), { syncedAt, overview }].slice(-90); return existing }
  const snapshot = { ...update, history: overview ? [{ syncedAt, overview }] : [], _id: new ObjectId() }; memory.searchConsole.push(snapshot); return snapshot
}

export async function getSearchConsoleSnapshot(userId, siteUrl = null) {
  if (mongoReady) return searchConsole().findOne({ userId: id(userId), ...(siteUrl ? { siteUrl } : {}) }, { sort: { syncedAt: -1 } })
  return memory.searchConsole.filter((item) => String(item.userId) === String(userId) && (!siteUrl || item.siteUrl === siteUrl)).sort((a, b) => new Date(b.syncedAt) - new Date(a.syncedAt))[0] || null
}

export async function listSearchConsoleSnapshots() {
  if (mongoReady) return searchConsole().find().sort({ syncedAt: -1 }).toArray()
  return [...memory.searchConsole].sort((a, b) => new Date(b.syncedAt) - new Date(a.syncedAt))
}

export async function getSearchConsoleHistory(userId, siteUrl = null) {
  const snapshot = await getSearchConsoleSnapshot(userId, siteUrl)
  return [...(snapshot?.history || [])].sort((a, b) => new Date(a.syncedAt) - new Date(b.syncedAt))
}

export async function saveAnalyticsSnapshot(userId, snapshot) {
  const record = { userId: id(userId), ...snapshot, syncedAt: new Date() }
  if (mongoReady) { const inserted = await analytics().insertOne(record); return { ...record, _id: inserted.insertedId } }
  record._id = new ObjectId(); memory.analytics.unshift(record); return record
}

export async function getLatestAnalyticsSnapshot(userId, propertyId = null) {
  if (mongoReady) return analytics().findOne({ userId: id(userId), ...(propertyId ? { propertyId } : {}) }, { sort: { syncedAt: -1 } })
  return memory.analytics.filter((item) => String(item.userId) === String(userId) && (!propertyId || item.propertyId === propertyId)).sort((a, b) => new Date(b.syncedAt) - new Date(a.syncedAt))[0] || null
}

export async function saveCrawlResult({ userId, websiteId, url, result }) {
  const crawl = { userId: id(userId), websiteId: id(websiteId), url, ...result, createdAt: new Date() }
  if (mongoReady) { const inserted = await crawls().insertOne(crawl); return { ...crawl, _id: inserted.insertedId } }
  crawl._id = new ObjectId(); memory.crawls.push(crawl); return crawl
}

export async function getLatestCrawl(userId, websiteId = null) {
  if (mongoReady) return crawls().findOne({ userId: id(userId), ...(websiteId ? { websiteId: id(websiteId) } : {}) }, { sort: { createdAt: -1 } })
  return memory.crawls.filter((crawl) => String(crawl.userId) === String(userId) && (!websiteId || String(crawl.websiteId) === String(websiteId))).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null
}

export async function createPasswordReset({ userId, tokenHash, expiresAt }) {
  const reset = { userId: id(userId), tokenHash, expiresAt, createdAt: new Date(), usedAt: null }
  if (mongoReady) { const inserted = await passwordResets().insertOne(reset); return { ...reset, _id: inserted.insertedId } }
  reset._id = new ObjectId(); memory.passwordResets.push(reset); return reset
}

export async function consumePasswordReset(tokenHash) {
  const query = { tokenHash, usedAt: null, expiresAt: { $gt: new Date() } }
  if (mongoReady) return passwordResets().findOneAndUpdate(query, { $set: { usedAt: new Date() } }, { returnDocument: 'before' })
  const reset = memory.passwordResets.find((item) => item.tokenHash === tokenHash && !item.usedAt && new Date(item.expiresAt) > new Date()); if (reset) reset.usedAt = new Date(); return reset || null
}

export async function updateUserPassword(userId, passwordHash) {
  if (mongoReady) return users().updateOne({ _id: id(userId) }, { $set: { passwordHash, passwordUpdatedAt: new Date() } })
  const user = memory.users.find((item) => String(item._id) === String(userId)); if (user) { user.passwordHash = passwordHash; user.passwordUpdatedAt = new Date() }
}

export async function recordJobRun(job) {
  const record = { ...job, createdAt: new Date() }
  if (mongoReady) { const inserted = await jobs().insertOne(record); return { ...record, _id: inserted.insertedId } }
  record._id = new ObjectId(); memory.jobs.unshift(record); return record
}

export async function listJobRuns(limit = 25) {
  if (mongoReady) return jobs().find({}).sort({ createdAt: -1 }).limit(limit).toArray()
  return memory.jobs.slice(0, limit)
}

export async function recordConversion({ userId, type = 'lead', value = 0, currency = 'USD', source = 'crm', email = null, occurredAt = new Date(), metadata = {} }) {
  const conversion = { userId: id(userId), type, value: Number(value) || 0, currency, source, email, occurredAt: new Date(occurredAt), metadata, createdAt: new Date() }
  if (mongoReady) { const inserted = await conversions().insertOne(conversion); return { ...conversion, _id: inserted.insertedId } }
  conversion._id = new ObjectId(); memory.conversions.push(conversion); return conversion
}

export async function summarizeConversions(userId) {
  if (mongoReady) { const rows = await conversions().aggregate([{ $match: { userId: id(userId) } }, { $group: { _id: '$type', count: { $sum: 1 }, value: { $sum: '$value' } } }]).toArray(); return rows.reduce((result, row) => ({ ...result, [row._id]: { count: row.count, value: row.value } }), {}) }
  return memory.conversions.filter((item) => String(item.userId) === String(userId)).reduce((result, item) => { const current = result[item.type] || { count: 0, value: 0 }; current.count++; current.value += item.value; result[item.type] = current; return result }, {})
}
