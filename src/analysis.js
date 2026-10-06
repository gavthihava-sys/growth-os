export function calculateContentReadiness(crawl, snapshot) {
  const issues = crawl?.issues || []; const types = crawl?.structuredDataTypes || []; const headings = crawl?.headings || []
  const queryCount = snapshot?.queries?.length || 0; const pageCount = snapshot?.pages?.length || 0
  const geoIssues = []; const aeoIssues = []
  const crawledPages = crawl?.pagesCrawled || (crawl ? 1 : 0)
  const pageWordCount = crawl?.pages?.reduce((total, page) => total + Number(page.wordCount || 0), 0) || Number(crawl?.wordCount || 0)
  const hasEntitySchema = types.some((type) => /Organization|LocalBusiness|Product|Service|Person/i.test(type))
  const hasAnswerSchema = types.some((type) => /FAQPage|HowTo|Article|Question|QAPage/i.test(type))
  const questionQueries = snapshot?.queries?.filter((row) => /\?|how|what|when|where|why|can|best/i.test(row.keys?.[0] || row.query || '')) || []
  if (!crawl) { geoIssues.push('Run a website crawl to evaluate entity and content structure.'); aeoIssues.push('Run a website crawl to evaluate answer readiness.') }
  else {
    if (!crawl.description) geoIssues.push('Add a clear business description for entity understanding.')
    if (headings.length < 3) geoIssues.push('Use descriptive section headings that explain services and audience.')
    if (!hasEntitySchema) geoIssues.push('Add Organization, LocalBusiness, Product, or Service structured data.')
    if (!crawl.robotsTxtFound) geoIssues.push('Publish robots.txt so search and AI crawlers receive clear guidance.')
    if (!crawl.sitemapFound) geoIssues.push('Publish an XML sitemap to improve discovery of important pages.')
    if (crawl.h1Count !== 1) aeoIssues.push('Use one direct, descriptive H1 for the page topic.')
    if (!hasAnswerSchema) aeoIssues.push('Add FAQPage, HowTo, Article, or Q&A schema where it matches the content.')
    if (pageWordCount < 300) aeoIssues.push('Expand thin page copy with concise, direct answers to customer questions.')
    if (!questionQueries.length && queryCount) aeoIssues.push('Create pages that answer the questions people already use to find you.')
    if (!crawl.openGraph) geoIssues.push('Add Open Graph metadata so shared pages have a clear identity and title.')
  }
  if (!crawl) return { geoScore: 0, aeoScore: 0, geoIssues, aeoIssues, signals: { crawledPages, wordCount: pageWordCount, queryCount, pageCount, entitySchema: false, answerSchema: false, robotsTxt: false, sitemap: false, openGraph: false, questionQueries: questionQueries.length, technicalIssues: issues.length } }
  const geoScore = Math.max(0, Math.min(100, 45 + (hasEntitySchema ? 20 : 0) + (crawl.description ? 10 : 0) + (crawl.robotsTxtFound ? 5 : 0) + (crawl.sitemapFound ? 5 : 0) + (crawl.openGraph ? 5 : 0) + Math.min(15, crawledPages * 2) + Math.min(10, queryCount) - geoIssues.length * 14))
  const aeoScore = Math.max(0, Math.min(100, 40 + (crawl.h1Count === 1 ? 15 : 0) + (hasAnswerSchema ? 20 : 0) + Math.min(15, Math.floor(pageWordCount / 200)) + Math.min(10, questionQueries.length * 2) - aeoIssues.length * 12))
  return { geoScore, aeoScore, geoIssues, aeoIssues, signals: { crawledPages, wordCount: pageWordCount, queryCount, pageCount, entitySchema: hasEntitySchema, answerSchema: hasAnswerSchema, robotsTxt: Boolean(crawl?.robotsTxtFound), sitemap: Boolean(crawl?.sitemapFound), openGraph: Boolean(crawl?.openGraph), questionQueries: questionQueries.length, technicalIssues: issues.length } }
}
