import * as cheerio from 'cheerio'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const getTimeoutMs = () => Math.max(1000, Math.min(60000, Number(process.env.CRAWL_TIMEOUT_MS || 15000)))
const getMaxPages = () => Math.max(1, Math.min(50, Number(process.env.CRAWL_MAX_PAGES || 12)))
const maxBodyBytes = 2 * 1024 * 1024
const blockedHost = (hostname) => {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.local') || host === '::1') return true
  if (host.startsWith('::ffff:')) return blockedHost(host.slice(7))
  if (isIP(host) === 6) return host === '::' || host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host)
  if (isIP(host) === 4) {
    const [first, second] = host.split('.').map(Number)
    if (first === 0 || first === 10 || first === 127 || first === 169 && second === 254 || first === 192 && second === 168 || first === 100 && second >= 64 && second <= 127) return true
    const match = host.match(/^172\.(\d+)\./); return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31)
  }
  return false
}

export function validatePublicUrl(value) {
  const parsed = new URL(String(value))
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https websites can be crawled.')
  if (blockedHost(parsed.hostname)) throw new Error('Private or local network URLs cannot be crawled.')
  return parsed
}

async function validateResolvedPublicUrl(value) {
  const parsed = validatePublicUrl(value)
  if (blockedHost(parsed.hostname)) throw new Error('Private or local network URLs cannot be crawled.')
  if (!isIP(parsed.hostname)) {
    let addresses
    try { addresses = await lookup(parsed.hostname, { all: true, verbatim: true }) } catch { throw new Error('The website host could not be resolved.') }
    if (!addresses.length || addresses.some(({ address }) => blockedHost(address))) throw new Error('The website resolves to a private or local network.')
  }
  return parsed
}

async function readLimitedBody(response, limit = maxBodyBytes) {
  const contentLength = Number(response.headers.get('content-length') || 0)
  if (contentLength > limit) throw new Error(`Response is larger than the ${Math.round(limit / 1024 / 1024)} MB crawl limit.`)
  if (!response.body) return Buffer.from(await response.arrayBuffer()).subarray(0, limit)
  const reader = response.body.getReader(); const chunks = []; let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      total += value.byteLength
      if (total > limit) { await reader.cancel(); throw new Error(`Response is larger than the ${Math.round(limit / 1024 / 1024)} MB crawl limit.`) }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, total)
}

async function fetchWithSafeRedirect(value, signal, { sameHost = null, limit = maxBodyBytes } = {}) {
  let current = await validateResolvedPublicUrl(value)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(current.href, { signal, redirect: 'manual', headers: { 'User-Agent': 'GrowthOSBot/1.0 (+https://growthos.example)' } })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location'); response.body?.cancel()
      if (!location) throw new Error('Website returned a redirect without a location.')
      const next = await validateResolvedPublicUrl(new URL(location, current.href))
      if (sameHost && next.hostname !== sameHost) throw new Error('Website redirected to a different host.')
      current = next; continue
    }
    return { response, url: current, body: await readLimitedBody(response, limit) }
  }
  throw new Error('Website returned too many redirects.')
}

async function fetchPage(url) {
  const parsed = validatePublicUrl(url)
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), getTimeoutMs())
  try {
    const { response, url: finalUrl, body } = await fetchWithSafeRedirect(parsed.href, controller.signal, { sameHost: parsed.hostname })
    if (!response.ok) throw new Error(`Website returned HTTP ${response.status}.`)
    const contentType = response.headers.get('content-type') || ''
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return null
    const buffer = body
    const html = buffer.toString('utf8'); const $ = cheerio.load(html)
    const links = $('a[href]').map((_, element) => $(element).attr('href')).get()
    const images = $('img').map((_, element) => ({ src: $(element).attr('src') || '', alt: $(element).attr('alt') || '' })).get()
    const headings = $('h1,h2,h3').map((_, element) => $(element).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean)
    const jsonLd = $('script[type="application/ld+json"]').map((_, element) => $(element).text()).get()
    const internalUrls = links.map((href) => { try { const link = new URL(href, finalUrl.href); link.hash = ''; return link } catch { return null } }).filter((link) => link && ['http:', 'https:'].includes(link.protocol) && link.hostname === parsed.hostname)
    const internalLinks = internalUrls.length
    const title = $('title').text().replace(/\s+/g, ' ').trim(); const description = $('meta[name="description"]').attr('content')?.trim() || ''; const canonical = $('link[rel="canonical"]').attr('href') || ''; const robots = $('meta[name="robots"]').attr('content') || ''
    const issues = []
    if (!title) issues.push({ code: 'missing-title', severity: 'high', message: 'Add a descriptive title tag.' })
    else if (title.length > 60) issues.push({ code: 'title-too-long', severity: 'low', message: 'Shorten the title tag to about 60 characters.' })
    if (!description) issues.push({ code: 'missing-description', severity: 'high', message: 'Add a unique meta description.' })
    else if (description.length > 160) issues.push({ code: 'description-too-long', severity: 'low', message: 'Shorten the meta description to about 160 characters.' })
    if ($('h1').length !== 1) issues.push({ code: 'h1-count', severity: 'medium', message: `Use exactly one H1 heading (found ${$('h1').length}).` })
    if (images.some((image) => !image.alt.trim())) issues.push({ code: 'image-alt', severity: 'medium', message: 'Add alternative text to every meaningful image.' })
    if (!jsonLd.length) issues.push({ code: 'structured-data', severity: 'medium', message: 'Add relevant Schema.org structured data.' })
    if (!$('meta[name="viewport"]').length) issues.push({ code: 'viewport', severity: 'low', message: 'Add a mobile viewport meta tag.' })
    if (!canonical) issues.push({ code: 'missing-canonical', severity: 'low', message: 'Add a canonical URL to clarify the preferred page.' })
    if (!$('html').attr('lang')) issues.push({ code: 'missing-language', severity: 'low', message: 'Declare the primary page language on the html element.' })
    if (/noindex/i.test(robots)) issues.push({ code: 'noindex', severity: 'high', message: 'This page is marked noindex and may not appear in search results.' })
    if (!$('meta[property="og:title"]').attr('content')) issues.push({ code: 'missing-og-title', severity: 'low', message: 'Add an Open Graph title for link previews.' })
    const score = Math.max(0, Math.min(100, 100 - issues.reduce((total, issue) => total + (issue.severity === 'high' ? 15 : issue.severity === 'medium' ? 8 : 3), 0)))
    return { status: 'success', httpStatus: response.status, finalUrl: finalUrl.href, title, description, canonical, robots, language: $('html').attr('lang') || '', wordCount: $('body').text().trim().split(/\s+/).filter(Boolean).length, h1Count: $('h1').length, headings, imageCount: images.length, missingAltCount: images.filter((image) => !image.alt.trim()).length, internalLinkCount: internalLinks, externalLinkCount: Math.max(0, links.length - internalLinks), structuredDataTypes: jsonLd.flatMap((value) => { try { const parsedData = JSON.parse(value); return Array.isArray(parsedData) ? parsedData.map((item) => item['@type'] || 'unknown') : [parsedData['@type'] || 'unknown'] } catch { return ['invalid-json'] } }), openGraph: Boolean($('meta[property="og:title"]').attr('content')), issues, score, internalUrls: internalUrls.map((link) => link.href) }
  } finally { clearTimeout(timer) }
}

export async function crawlWebsite(value) {
  const parsed = validatePublicUrl(value)
  const queue = [parsed.href]; const visited = new Set(); const pages = []; const errors = []
  const maxPages = getMaxPages()
  let robotsTxt = null; let sitemap = null
  try { const robotsResponse = await fetchWithSafeRedirect(parsed.origin + '/robots.txt', AbortSignal.timeout(getTimeoutMs()), { sameHost: parsed.hostname, limit: 200000 }); robotsTxt = robotsResponse.response.ok ? robotsResponse.body.toString('utf8') : null } catch { /* optional */ }
  const sitemapUrl = robotsTxt?.match(/^sitemap:\s*(\S+)/im)?.[1] || `${parsed.origin}/sitemap.xml`
  try { const sitemapResponse = await fetchWithSafeRedirect(sitemapUrl, AbortSignal.timeout(getTimeoutMs()), { sameHost: parsed.hostname, limit: 200000 }); sitemap = sitemapResponse.response.ok ? sitemapResponse.body.toString('utf8') : null } catch { /* optional */ }
  while (queue.length && pages.length < maxPages) {
    const url = queue.shift(); if (visited.has(url)) continue; visited.add(url)
    try {
      const page = await fetchPage(url); if (!page) continue
      pages.push(page)
      for (const link of page.internalUrls || []) if (!visited.has(link) && !queue.includes(link) && queue.length + pages.length < maxPages * 2) queue.push(link)
    } catch (error) { errors.push({ url, message: error.message }) }
  }
  if (!pages.length) throw new Error(errors[0]?.message || 'No crawlable HTML pages were found.')
  const first = pages[0]
  const allIssues = pages.flatMap((page) => page.issues.map((issue) => ({ ...issue, url: page.finalUrl })))
  const structuredDataTypes = [...new Set(pages.flatMap((page) => page.structuredDataTypes || []))]
  if (!robotsTxt) allIssues.push({ code: 'missing-robots', severity: 'low', message: 'Publish a robots.txt file with crawler guidance.', url: first.finalUrl })
  if (!sitemap) allIssues.push({ code: 'missing-sitemap', severity: 'low', message: 'Publish an XML sitemap and reference it from robots.txt.', url: first.finalUrl })
  const issueWeight = allIssues.reduce((total, issue) => total + (issue.severity === 'high' ? 15 : issue.severity === 'medium' ? 8 : 3), 0)
  const score = Math.max(0, Math.min(100, 100 - Math.round(issueWeight / pages.length)))
  return { ...first, score, pagesCrawled: pages.length, pages: pages.map(({ internalUrls, ...page }) => page), issues: allIssues, structuredDataTypes, robotsTxtFound: Boolean(robotsTxt), sitemapFound: Boolean(sitemap), crawlErrors: errors, crawledAt: new Date().toISOString() }
}
