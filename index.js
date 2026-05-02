require('dotenv').config({ path: require('path').join(__dirname, '.env.local'), override: true });

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');

// ── Axios: enrich error messages for Anthropic API calls ──────────────────────
axios.interceptors.response.use(
  response => response,
  error => {
    const status = error?.response?.status;
    const data   = error?.response?.data;
    const url    = error?.config?.url || '';
    if (String(url).includes('anthropic.com') || String(url).includes('openai.com')) {
      let msg = data?.error?.message || data?.message || JSON.stringify(data).slice(0,400);
      if (status === 401) msg = 'AI API 401 — check ANTHROPIC_API_KEY or OPENAI_API_KEY in .env.local';
      if (status === 429) msg = 'AI API rate limited — slow down generation or upgrade plan';
      error.message = `AI API error (${status}): ${msg}`;
    }
    return Promise.reject(error);
  }
);

const mysql = require('mysql2/promise');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT || 7784);
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/New_York';
process.env.TZ = APP_TIMEZONE;

const CRAWL_BASE_URL = (process.env.CRAWL_BASE_URL || '').trim().replace(/\/$/, '');
const AUTO_PUBLISH_ENABLED = String(process.env.AUTO_PUBLISH_ENABLED || 'true').toLowerCase() !== 'false';
const AUTO_PUBLISH_INTERVAL_MINUTES = Math.max(1, Number(process.env.AUTO_PUBLISH_INTERVAL_MINUTES || 10));
const AUTO_PUBLISH_DAILY_LIMIT = Math.max(1, Number(process.env.AUTO_PUBLISH_DAILY_LIMIT || 1));
const MIN_QUALITY_SCORE = Math.max(1, Number(process.env.MIN_QUALITY_SCORE || 90));

// ── DataForSEO ────────────────────────────────────────────────────────────────
const DFS_ENABLED     = String(process.env.DATAFORSEO_ENABLED || 'true').toLowerCase() !== 'false'
                     && !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
const DFS_LOGIN       = process.env.DATAFORSEO_LOGIN     || '';
const DFS_PASSWORD    = process.env.DATAFORSEO_PASSWORD  || '';
const DFS_LOCATION    = Number(process.env.DATAFORSEO_LOCATION_CODE || 2840);
const DFS_LANGUAGE    = process.env.DATAFORSEO_LANGUAGE_CODE || 'en';
const DFS_DEVICE      = process.env.DATAFORSEO_DEVICE || 'desktop';
const DFS_MAX_RESULTS = Math.min(20, Math.max(5, Number(process.env.DATAFORSEO_MAX_RESULTS || 10)));
const DFS_CACHE_DAYS  = Math.max(1, Number(process.env.DATAFORSEO_CACHE_DAYS || 14));
const DFS_DAILY_CALL_CAP = Math.max(1, Number(process.env.DATAFORSEO_DAILY_CALL_CAP || 20));
let _dfsDailyCallCount = 0;
let _dfsDayKey = '';
function dfsCallAllowed() {
  const today = new Date().toISOString().slice(0,10);
  if (_dfsDayKey !== today) { _dfsDayKey = today; _dfsDailyCallCount = 0; }
  if (_dfsDailyCallCount >= DFS_DAILY_CALL_CAP) {
    console.warn(`[DFS] Daily cap (${DFS_DAILY_CALL_CAP}) reached. Falling back to cache.`);
    return false;
  }
  return true;
}
function dfsCallUsed() { _dfsDailyCallCount++; }

// ── NativPost Business Facts ──────────────────────────────────────────────────
const NATIVPOST_SITE_URL = process.env.NATIVPOST_SITE_URL || 'https://nativpost.com';
const NATIVPOST_APP_URL  = process.env.NATIVPOST_APP_URL  || 'https://app.nativpost.com';
const BUSINESS_FACTS = process.env.NATIVPOST_BUSINESS_FACTS || `
NativPost is an AI-powered social media content platform. Brands connect their social profiles, define their voice once using tone sliders and brand profiles, and NativPost generates studio-quality posts, graphics, and videos ready to publish across multiple platforms.
Key facts: 
- Plans: Starter ($19/mo, 15 posts), Growth ($39/mo, 40 posts), Pro ($79/mo, 80 posts), Agency ($149/mo, unlimited). 
- All plans have a $5 one-time setup fee and a 7-day free trial.
- Platforms supported: Instagram, Facebook, LinkedIn, Twitter/X, TikTok, Pinterest, YouTube, Threads.
- Billing: Stripe for international users, Paystack for African markets.
- Content modes: Normal, Concise, Controversial.
- Anti-slop filter scores every generated post for AI-sounding language and auto-rejects below 0.7.
- Video formats: Slideshow, Text Motion Card, Voiceover Slideshow, UGC Ad, Data Story.
- AI engine: Claude (Anthropic) with OpenAI as fallback.
- HQ: Global product, with explicit African market support via Paystack.
Do NOT claim free forever plan, unlimited posts on Starter, or pricing not listed above.
`.trim();

const NATIVPOST_TRIAL_DAYS = 7;
const NATIVPOST_TRIAL_POSTS = 3;

// ── Platform / Product Keywords ───────────────────────────────────────────────
// These are the core feature areas NativPost should rank for
const NATIVPOST_FEATURE_CLUSTERS = [
  { key: 'ai-social-media', label: 'AI Social Media', keywords: ['ai social media tool','ai social media content generator','ai social media management','social media ai','ai powered social media'] },
  { key: 'brand-voice', label: 'Brand Voice AI', keywords: ['brand voice ai','ai brand voice','brand voice generator','consistent brand voice social media','brand voice tool'] },
  { key: 'scheduling', label: 'Scheduling & Publishing', keywords: ['social media scheduler','social media scheduling tool','auto publish social media','social media calendar','schedule instagram posts'] },
  { key: 'content-generation', label: 'Content Generation', keywords: ['ai caption generator','social media caption generator','ai post generator','social media content generator','instagram caption ai'] },
  { key: 'video-generation', label: 'Video Generation', keywords: ['ai social media video generator','social media video maker ai','ugc ad generator','short video content ai'] },
  { key: 'linkedin', label: 'LinkedIn Content', keywords: ['linkedin content generator ai','linkedin post generator','ai linkedin posts','linkedin content tool'] },
  { key: 'instagram', label: 'Instagram Content', keywords: ['instagram caption generator ai','ai instagram posts','instagram content tool','instagram post generator'] },
  { key: 'smb', label: 'SMB / Small Business', keywords: ['social media tool for small business','social media marketing for small business','affordable social media tool'] },
  { key: 'agency', label: 'Agency', keywords: ['social media tool for agencies','agency social media management','white label social media tool'] },
  { key: 'africa', label: 'Africa Market', keywords: ['social media tool africa','ai social media nigeria','best social media tool south africa','social media management kenya'] },
  { key: 'competitors', label: 'Competitor Comparisons', keywords: ['nativpost vs ocoya','nativpost vs buffer','nativpost vs predis','ocoya alternative','buffer alternative ai','hootsuite alternative small business'] },
  { key: 'pricing', label: 'Pricing', keywords: ['nativpost pricing','nativpost plans','nativpost review','is nativpost worth it'] },
];

// ── Competitor knowledge base ─────────────────────────────────────────────────
const KNOWN_COMPETITORS = [
  { key: 'ocoya', label: 'Ocoya', url: 'https://ocoya.com', tier: 'direct', note: 'Content creation + scheduling. Closest direct competitor. Has design tool (Canva-lite), DM chatbots, RSS triggers. Plans $15-$159/mo.' },
  { key: 'predis', label: 'Predis.ai', url: 'https://predis.ai', tier: 'direct', note: 'AI social media content. Known issue: autopost often ignores the brief. No strong brand voice filtering.' },
  { key: 'buffer', label: 'Buffer', url: 'https://buffer.com', tier: 'scheduler', note: 'Pure scheduler + basic AI caption bolt-on. No real content generation engine.' },
  { key: 'hootsuite', label: 'Hootsuite', url: 'https://hootsuite.com', tier: 'enterprise', note: 'Enterprise scheduling. $99+/mo. AI is superficial.' },
  { key: 'jasper', label: 'Jasper', url: 'https://jasper.ai', tier: 'writing', note: 'Best brand voice AI writing. No scheduling, no video, no social publish. $59+/user/mo.' },
  { key: 'later', label: 'Later', url: 'https://later.com', tier: 'scheduler', note: 'Instagram-first scheduler. Limited AI. Good for visual calendar.' },
  { key: 'contentful-studio', label: 'ContentStudio', url: 'https://contentstudio.io', tier: 'direct', note: 'Content discovery + scheduling. Some AI captions. No deep brand voice.' },
  { key: 'socialbee', label: 'SocialBee', url: 'https://socialbee.com', tier: 'direct', note: 'AI social media. Category-based scheduling. More complex to set up.' },
  { key: 'feedhive', label: 'FeedHive', url: 'https://feedhive.io', tier: 'direct', note: 'AI writing + scheduling. Strong for LinkedIn. Limited video.' },
  { key: 'postbridge', label: 'Post Bridge', url: 'https://postbridge.io', tier: 'scheduler', note: 'Pure cross-posting. No AI. Solo founder indie tool. $7.50/mo.' },
  { key: 'sproutsocial', label: 'Sprout Social', url: 'https://sproutsocial.com', tier: 'enterprise', note: 'Large team enterprise. $249+/seat. Not a real competitor at NativPost\'s price.' },
];

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

// ── AUTH ──────────────────────────────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || 'nativpost-seo-secret-2026-change-me';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
if (SESSION_SECRET.includes('change-me')) {
  console.warn('⚠️  SESSION_SECRET is the built-in default. Rotate before production: openssl rand -hex 32');
}

async function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, buf) => {
      if (err) reject(err); else resolve(buf.toString('hex'));
    });
  });
}
async function verifyPassword(password, hash, salt) {
  const attempt = await hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(hash, 'hex'));
}
function generateSessionId() { return crypto.randomBytes(32).toString('hex'); }
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const result = {};
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) result[decodeURIComponent(k.trim())] = decodeURIComponent(v.join('=').trim());
  }
  return result;
}
async function getSessionUser(req) {
  const cookies = parseCookies(req);
  const sid = cookies['np_seo_session'];
  if (!sid) return null;
  try {
    const session = await one('SELECT s.*, u.id user_id, u.username, u.email, u.role FROM np_seo_sessions s JOIN np_seo_users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at > NOW()', [sid]);
    return session || null;
  } catch(e) { return null; }
}
async function requireAuth(req, res, next) {
  const publicPaths = ['/login', '/auth/login', '/auth/logout', '/auth/reset-password', '/static', '/uploads'];
  if (publicPaths.some(p => req.path.startsWith(p))) return next();
  const user = await getSessionUser(req);
  if (!user) return res.redirect('/login');
  req.user = user;
  res.locals.currentUser = user;
  next();
}
function setSessionCookie(res, sessionId) {
  const expires = new Date(Date.now() + SESSION_DURATION_MS);
  res.setHeader('Set-Cookie', `np_seo_session=${sessionId}; Path=/; Expires=${expires.toUTCString()}; HttpOnly; SameSite=Lax`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'np_seo_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.json({ limit: '25mb' }));
app.use('/static', express.static(path.join(__dirname, 'public')));
const uploadDir = process.env.UPLOAD_DIR || path.resolve(__dirname, '..', 'NativPostSEO_uploads');
fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));
const upload = multer({ dest: uploadDir, limits: { fileSize: 8 * 1024 * 1024 } });

// ── DB Pool ───────────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'nativpost_seo',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  multipleStatements: false
});

async function q(sql, params=[]) { const [rows] = await pool.execute(sql, params); return rows; }
async function one(sql, params=[]) { const rows = await q(sql, params); return rows[0] || null; }
async function execSafe(sql, params=[]) { try { await pool.execute(sql, params); } catch(e) { if (!e.message.includes('Duplicate') && !e.message.includes('already exists')) console.warn('[DB]', e.message.slice(0,200)); } }

// ── Utilities ─────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().slice(0,10); }
function truncate(s='', n=255){ s=String(s||''); return s.length>n ? s.slice(0,n-1) : s; }
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function normalizeUrl(url='') { url=String(url||'').trim(); if (url && !/^https?:\/\//i.test(url)) url='https://'+url; return url; }
function originOf(url='') { try { return new URL(normalizeUrl(url)).origin; } catch { return ''; } }
function titleFromUrl(url='') { try { return new URL(url).hostname.replace(/^www\./,''); } catch { return url; } }

function inlineMarkdown(s) {
  let out = escapeHtml(s);
  out = out.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g,'<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a target="_blank" rel="noopener" href="$2">$1</a>');
  return out;
}
function markdownToHtml(md) {
  const lines = String(md||'').replace(/\r\n/g,'\n').split('\n');
  let html='', inList=false, inOl=false, para=[];
  const flushPara=()=>{ if(para.length){ html+='<p>'+inlineMarkdown(para.join(' '))+'</p>\n'; para=[]; } };
  const closeLists=()=>{ if(inList){html+='</ul>\n';inList=false;} if(inOl){html+='</ol>\n';inOl=false;} };
  for(const raw of lines){
    const line=raw.trim();
    if(!line){ flushPara(); closeLists(); continue; }
    const h=line.match(/^(#{1,6})\s+(.+)$/);
    if(h){ flushPara(); closeLists(); const lv=Math.min(6,h[1].length); html+='<h'+lv+'>'+inlineMarkdown(h[2])+'</h'+lv+'>\n'; continue; }
    const ul=line.match(/^[-*]\s+(.+)$/);
    if(ul){ flushPara(); if(inOl){html+='</ol>\n';inOl=false;} if(!inList){html+='<ul>\n';inList=true;} html+='<li>'+inlineMarkdown(ul[1])+'</li>\n'; continue; }
    const ol=line.match(/^\d+[.)]\s+(.+)$/);
    if(ol){ flushPara(); if(inList){html+='</ul>\n';inList=false;} if(!inOl){html+='<ol>\n';inOl=true;} html+='<li>'+inlineMarkdown(ol[1])+'</li>\n'; continue; }
    para.push(line);
  }
  flushPara(); closeLists();
  return html;
}

// ── Web crawler ───────────────────────────────────────────────────────────────
async function fetchUrl(url, timeout=12000) {
  try {
    const r = await axios.get(url, {
      timeout,
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NativPostSEOBot/1.0)' },
      validateStatus: s => s < 500
    });
    return { html: String(r.data||''), status: r.status, finalUrl: r.request?.res?.responseUrl || url };
  } catch(e) {
    return { html: '', status: 0, finalUrl: url };
  }
}

function extractLinks(html, base='') {
  const links = [];
  const re = /href=["']([^"'#?]+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const url = new URL(m[1], base || 'https://example.com').href;
      if (/^https?:\/\//.test(url)) links.push(url);
    } catch {}
  }
  return [...new Set(links)];
}
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim().replace(/\s+/g,' ') : '';
}
function extractMeta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`,'i');
  const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`,'i'));
  return m ? m[1].trim() : '';
}
function extractH1(html) {
  const m = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  return m ? m[1].replace(/<[^>]+>/g,'').trim() : '';
}
function countWords(html) {
  return html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().split(' ').filter(Boolean).length;
}
function resolveCrawlUrl(url='') {
  if (!CRAWL_BASE_URL) return url;
  try { const u = new URL(url); return CRAWL_BASE_URL + u.pathname + u.search; } catch { return url; }
}

// ── SERP / DuckDuckGo fallback ────────────────────────────────────────────────
async function serpLookupDDG(keyword, maxResults=5) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(keyword)}`;
    const { html } = await fetchUrl(url, 15000);
    const results = [];
    const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null && results.length < maxResults) {
      const link = m[1].replace(/^.*?uddg=([^&]+).*$/, (_, u) => { try { return decodeURIComponent(u); } catch { return u; } });
      results.push({ url: link, title: m[2].replace(/<[^>]+>/g,'').trim(), position: results.length + 1 });
    }
    return results;
  } catch(e) { return []; }
}

async function serpLookupDFS(keyword) {
  if (!DFS_ENABLED || !dfsCallAllowed()) return null;
  try {
    dfsCallUsed();
    const auth = Buffer.from(`${DFS_LOGIN}:${DFS_PASSWORD}`).toString('base64');
    const payload = [{ keyword, location_code: DFS_LOCATION, language_code: DFS_LANGUAGE, device: DFS_DEVICE, os: 'windows', depth: DFS_MAX_RESULTS }];
    const r = await axios.post('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', payload, { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 30000 });
    const items = r.data?.tasks?.[0]?.result?.[0]?.items || [];
    return items.filter(i => i.type === 'organic').map(i => ({ url: i.url, title: i.title, position: i.rank_absolute, snippet: i.description }));
  } catch(e) { console.error('[DFS] SERP lookup failed:', e.message); return null; }
}

async function serpLookup(keyword) {
  const cached = await one('SELECT result_json FROM np_seo_serp_cache WHERE keyword=? AND fetched_at > DATE_SUB(NOW(), INTERVAL ? DAY)', [keyword, DFS_CACHE_DAYS]);
  if (cached) { try { return JSON.parse(cached.result_json); } catch {} }
  let results = await serpLookupDFS(keyword);
  if (!results) results = await serpLookupDDG(keyword, DFS_MAX_RESULTS);
  if (results) {
    await execSafe('INSERT INTO np_seo_serp_cache (keyword, result_json) VALUES (?,?) ON DUPLICATE KEY UPDATE result_json=?, fetched_at=NOW()', [keyword, JSON.stringify(results), JSON.stringify(results)]);
  }
  return results || [];
}

// ── Competitor auditor ────────────────────────────────────────────────────────
async function auditCompetitor(url) {
  const crawlUrl = resolveCrawlUrl(url);
  const { html } = await fetchUrl(crawlUrl, 15000);
  const title = extractTitle(html);
  const meta = extractMeta(html, 'description') || extractMeta(html, 'og:description');
  const h1 = extractH1(html);
  const words = countWords(html);

  // find internal links and count pages
  const base = originOf(url);
  const links = extractLinks(html, base).filter(l => l.startsWith(base)).slice(0, 60);

  // find pricing signals
  const text = html.toLowerCase();
  const pricingMatch = text.match(/\$\s*(\d+)/);
  const startingPrice = pricingMatch ? Number(pricingMatch[1]) : null;

  // feature detection
  const hasAI = /\bai\b|artificial intelligence|gpt|claude|openai/.test(text);
  const hasVideo = /video|reel|ugc|remotion|animated/.test(text);
  const hasScheduling = /schedul|calendar|queue|publish/.test(text);
  const hasBrandVoice = /brand voice|tone|persona|style guide/.test(text);
  const hasAnalytics = /analytics|engagement|insights|reach/.test(text);

  // score 0-100
  let score = 0;
  if (title) score += 10;
  if (meta) score += 10;
  if (words > 200) score += 15;
  if (links.length > 5) score += 15;
  if (hasAI) score += 10;
  if (hasVideo) score += 10;
  if (hasScheduling) score += 10;
  if (hasBrandVoice) score += 10;
  if (hasAnalytics) score += 10;

  return { title, meta_description: meta, h1_text: h1, word_count: words, page_count: links.length, score, starting_price: startingPrice, has_ai: hasAI?1:0, has_video: hasVideo?1:0, has_scheduling: hasScheduling?1:0, has_brand_voice: hasBrandVoice?1:0, has_analytics: hasAnalytics?1:0 };
}

async function saveCompetitorAudit(competitorId, audit) {
  await execSafe(`UPDATE np_seo_competitors SET title=?,meta_description=?,h1_text=?,word_count=?,page_count=?,score=?,starting_price=?,has_ai=?,has_video=?,has_scheduling=?,has_brand_voice=?,has_analytics=?,last_audited_at=NOW() WHERE id=?`,
    [audit.title, audit.meta_description, audit.h1_text, audit.word_count, audit.page_count, audit.score, audit.starting_price, audit.has_ai, audit.has_video, audit.has_scheduling, audit.has_brand_voice, audit.has_analytics, competitorId]);
}

// ── Content health score for NativPost ────────────────────────────────────────
function computeContentHealthScore({ pages=0, articles=0, avgPos=0, clicks=0, impressions=0, earnedBL=0 }) {
  const crawlPct = Math.min(100, Math.round(pages / 50 * 100));
  const contentPct = Math.min(100, Math.round(articles / 100 * 100));
  const serpPct = avgPos > 0 ? Math.min(100, Math.round((100 - Math.min(avgPos, 100)) * 1.3 + clicks * 0.1 + impressions * 0.002)) : null;
  const blPct = Math.min(100, Math.round(earnedBL / 30 * 100));
  const signals = [crawlPct, contentPct];
  if (serpPct !== null) signals.push(serpPct);
  if (earnedBL > 0) signals.push(blPct);
  const overall = Math.round(signals.reduce((a,b)=>a+b,0)/signals.length);
  return { overall, crawlPct, contentPct, serpPct, blPct };
}

// ── AI Article Generation ─────────────────────────────────────────────────────
function buildNativPostArticlePrompt(keyword, opts={}) {
  const { serpData='', competitorContext='', siteContext='', wordTarget=1400 } = opts;

  // Determine article type
  const kw = keyword.toLowerCase();
  const isComparison    = /\bvs\b|\bversus\b|alternative|comparison|compare/.test(kw);
  const isPricing       = /price|pricing|cost|cheap|affordable|worth it|review/.test(kw);
  const isHowTo         = /how to|how do|guide|tutorial|step/.test(kw);
  const isListicle      = /best\b|top\b|\d+ tool|\d+ ways|\d+ reason/.test(kw);
  const isAfricaAngle   = /africa|nigeria|kenya|ghana|south africa|nairobi|lagos/.test(kw);
  const isPlatformAngle = /linkedin|instagram|tiktok|twitter|facebook|pinterest|threads/.test(kw);

  const serpContext = serpData ? `\nTOP SERP RESULTS FOR THIS KEYWORD:\n${serpData}\nUse this to understand search intent and what competitor articles cover. Then DO BETTER.\n` : '';

  let structureGuide = '';
  if (isComparison) {
    structureGuide = `COMPARISON ARTICLE STRUCTURE:
1. H1 with keyword — include "in 2026" 
2. Quick summary box (3-4 bullet TL;DR) — what's the verdict, for whom
3. Side-by-side comparison table (tool | key strength | pricing | best for) — this must come FIRST before any prose
4. Intro: frame the real dilemma the reader faces (e.g. "You want content that actually sounds like your brand, not generic AI copy")
5. ## What [Tool A] Does Best — honest strengths
6. ## What [Tool B] Does Best — honest strengths 
7. ## Where NativPost Wins — brand voice depth, anti-slop filter, video engine, Paystack for Africa
8. ## Head-to-Head Feature Matrix — detailed table (brand voice config, content modes, video gen, Africa billing, price)
9. ## Who Should Choose Which Tool — decision framework by ICP (solopreneur vs agency vs African SMB)
10. ## FAQ — minimum 4 Q&A pairs
11. CTA: "Start your 7-day free trial — no credit card required — at app.nativpost.com"`;
  } else if (isPricing) {
    structureGuide = `PRICING/REVIEW ARTICLE STRUCTURE:
1. H1 with keyword 
2. Quick verdict table (plan | posts/mo | price | best for) — must come FIRST before prose
3. Intro: make a confident, specific claim about what NativPost costs and what you get
4. ## NativPost Pricing Plans in 2026 — full breakdown of Starter/Growth/Pro/Agency/Enterprise with feature diffs
5. ## Is the Setup Fee Worth It? — explain the $5 setup fee context
6. ## What the 7-Day Trial Includes — be specific (3 posts, text only, what you can test)
7. ## NativPost vs Competitors on Price — compare to Ocoya/Buffer/Jasper at similar price points
8. ## Who Gets the Most Value from Each Plan — ICP per tier
9. ## FAQ — at least 4 Q&As including "is there a free plan", "Paystack support", "what happens after trial"
10. CTA: link to app.nativpost.com/subscribe`;
  } else if (isAfricaAngle) {
    structureGuide = `AFRICA-MARKET ARTICLE STRUCTURE:
1. H1 with keyword — include country/region + 2026
2. Quick answer table (what NativPost offers, pricing in USD, Paystack support)
3. Intro: Speak directly to African entrepreneurs — acknowledge the real pain (currency, payment friction, tools built for Western markets)
4. ## The Social Media Challenge for [Country/Region] Businesses in 2026
5. ## Why Most Social Media Tools Don't Work for African Markets — Stripe-only, USD only, no local context
6. ## How NativPost Solves This — Paystack integration, Naira/Cedi/etc pricing friction removed, brand voice for local voice
7. ## Getting Started: A Step-by-Step Guide for [Country] Businesses
8. ## Supported Platforms for [Country] Audiences — which platforms matter most in that market
9. ## NativPost vs Local Alternatives — honest comparison
10. ## FAQ — include "does NativPost work in Nigeria/Kenya/Ghana?", "can I pay in local currency?"
11. CTA: "Pay with Paystack — start your 7-day free trial today at app.nativpost.com"`;
  } else if (isPlatformAngle) {
    const platform = /linkedin/.test(kw) ? 'LinkedIn' : /instagram/.test(kw) ? 'Instagram' : /tiktok/.test(kw) ? 'TikTok' : /twitter|x\.com/.test(kw) ? 'Twitter/X' : /facebook/.test(kw) ? 'Facebook' : 'Social Media';
    structureGuide = `PLATFORM-SPECIFIC ARTICLE STRUCTURE (${platform}):
1. H1 with keyword — include 2026
2. Quick answer table or key stats block
3. Intro: what makes ${platform} content strategy different from other platforms
4. ## What Makes Great ${platform} Content in 2026 — algorithm signals, format preferences, optimal post length
5. ## How NativPost's ${platform} Voice Configuration Works — per-platform tone settings, caption length logic
6. ## ${platform} Content Templates and Modes — Normal, Concise, Controversial — with examples
7. ## Publishing and Scheduling to ${platform} via NativPost — step-by-step
8. ## ${platform} Analytics in NativPost — what engagement data syncs back
9. ## Tips from Top ${platform} Creators — 5-7 actionable tips backed by data
10. ## FAQ — minimum 4 Q&As specific to ${platform}
11. CTA: link to app.nativpost.com`;
  } else {
    structureGuide = `STANDARD ARTICLE STRUCTURE:
1. H1 with keyword — include "2026" naturally
2. FIRST element: a markdown comparison/summary table answering the core question — gets featured snippets
3. Intro (2-3 sentences): scenario or dilemma the reader is facing. Hook with tension. Don't open with a definition.
4. ## The Problem with Generic AI Social Media Tools — position the pain
5. ## How [Keyword Topic] Works with NativPost — specific mechanics, not vague marketing
6. ## Key Features That Make the Difference — brand profile setup, anti-slop filter, content modes
7. ## Getting Started: Step-by-Step — minimum 5 numbered steps
8. ## Pricing and Plans — full table
9. ## NativPost vs The Alternative — honest comparison with 1-2 named competitors
10. ## FAQ — minimum 4 Q&As
11. CTA: "7-day free trial — no credit card required"`;
  }

  return `You are a senior SaaS content strategist writing for NativPost (nativpost.com) — an AI-powered social media content platform. Your job is to produce a high-ranking, genuinely useful, conversion-optimized blog article that helps NativPost rank on Google and convert readers into trial users.

TARGET KEYWORD: "${keyword}"
TARGET WORD COUNT: ${wordTarget}–${wordTarget+400} words (HARD REQUIREMENT — count as you write)

NATIVPOST FACTS (never deviate from these):
${BUSINESS_FACTS}
${serpContext}
COMPETITOR CONTEXT FOR THIS TOPIC:
${competitorContext || 'Use general knowledge of the social media tool space.'}

SITE CONTEXT (scraped NativPost pages):
${siteContext || 'nativpost.com — AI social media content platform.'}

${structureGuide}

HEADLINE RULES:
- Never use generic format "[Keyword] | NativPost". Use a story hook or data hook.
- Examples: "Stop Sounding Like a Bot: How to Build a Brand Voice That Actually Converts" or "The Real Reason Your LinkedIn Posts Get No Engagement (And the AI Fix)" or "NativPost vs Ocoya in 2026: Which One Actually Learns Your Brand Voice?"
- Include "2026" in the title OR in the first H2.

WRITING RULES:
- OPENING PARAGRAPH: DO NOT open with a definition. Open with a SCENARIO or pain point the reader is experiencing right now.
- QUICK ANSWER TABLE: The FIRST visual element after the intro must be a markdown table that immediately answers the core question.
- ANTI-SLOP LANGUAGE: Eliminate these words entirely — leverage, synergy, disruptive, game-changing, cutting-edge, robust, seamlessly, in today's fast-paced world, revolutionize, holistic. If you find yourself using them, delete and rewrite.
- SPECIFICITY: Name specific features (anti-slop filter, content modes, tone sliders 1-10, 3 variants generated in parallel, SSE streaming, feedback loop, topic memory). Vague claims fail.
- YEAR REFERENCES: Include "in 2026" or "as of 2026" naturally in 3-5 places.
- INTERNAL LINKS: Include 3-5 internal links to other NativPost blog posts or pages (format: [anchor text](https://nativpost.com/blog/slug)).
- EXTERNAL LINK: Include exactly 1 external link to a credible third-party source (not a competitor). Place in a stats or methodology section.
- PRICING TABLE LINKS: All pricing/plan tables must use real markdown hyperlinks to app.nativpost.com/subscribe.
- CTA FORMAT: Conclusion = 2-3 sentences summarizing the key value, then: "Start your 7-day free trial at [app.nativpost.com](https://app.nativpost.com) — no credit card required."
- BRAND NAME: Include "NativPost" naturally at minimum 4-6 times. Include in title, at least one H2, the intro, and the conclusion.

ACCURACY RULES:
- Do NOT claim: free forever plan, unlimited posts on Starter, money-back guarantee, 30-day trial.
- DO say: 7-day free trial, $5 one-time setup fee, Starter is $19/mo, Growth is $39/mo.
- Do NOT invent features not in the NATIVPOST FACTS above.
- Africa pricing: NativPost accepts Paystack — this is a real differentiator. Mention it when relevant.

AI SEARCH OPTIMIZATION (critical for 2025+):
- Open with a 2-3 sentence "Quick Answer" paragraph that AI systems (Google AI Overviews, Perplexity) can cite directly.
- Use specific factual declarative statements with exact numbers (e.g. "NativPost's anti-slop filter scores every post on a 0–1 scale and auto-rejects anything below 0.7").
- Every FAQ answer must be self-contained and answer the question in the first sentence.

OUTPUT FORMAT — respond ONLY with valid JSON, no markdown fences, no preamble:
{
  "title": "H1 headline (the article title)",
  "slug": "url-slug-for-this-article",
  "meta_description": "Under 160 chars. Specific, answers searcher intent with entities.",
  "excerpt": "2-sentence summary for content feed",
  "body_markdown": "Full article body in markdown. ${wordTarget}-${wordTarget+400} words."
}`;
}

async function generateArticle(keyword, opts={}) {
  const prompt = buildNativPostArticlePrompt(keyword, opts);
  const useAnthropic = !!(process.env.ANTHROPIC_API_KEY);
  const useOpenAI    = !!(process.env.OPENAI_API_KEY);

  if (!useAnthropic && !useOpenAI) throw new Error('No AI API key set. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env.local');

  let text = '';
  if (useAnthropic) {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-5',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 180000 });
    text = r.data?.content?.[0]?.text || '';
  } else {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 180000 });
    text = r.data?.choices?.[0]?.message?.content || '';
  }

  text = text.trim().replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/```$/,'').trim();
  const parsed = JSON.parse(text);

  // Auto-repair common bad claims
  let body = String(parsed.body_markdown || '');
  body = body.replace(/30\s*[- ]?day\s+(free\s+)?trial/gi, '7-day free trial');
  body = body.replace(/money[- ]back\s+guarantee/gi, '7-day free trial');
  body = body.replace(/free\s+forever\s+plan/gi, '7-day free trial');
  parsed.body_markdown = body;

  // Quality score
  const aiBuzzwords = (body.match(/\b(leverage|synergy|disruptive|game[- ]changing|cutting[- ]edge|robust|seamlessly|holistic|revolutionize)\b/gi)||[]).length;
  const genericOpenings = /^(in today'?s|as (a|an) business|social media (is|has)|in the (world|era|age) of)/i.test(body.slice(0,150)) ? 1 : 0;
  const hasInternalLinks = (body.match(/nativpost\.com\/blog\//g)||[]).length;
  const hasCTA = /app\.nativpost\.com/.test(body) ? 1 : 0;
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const hasTable = /^\|.+\|$/m.test(body) ? 1 : 0;

  let score = 100;
  score -= aiBuzzwords * 4;
  score -= genericOpenings * 10;
  score += hasInternalLinks * 3;
  score += hasCTA * 5;
  score += hasTable * 5;
  if (wordCount < 800) score -= 20;
  if (wordCount < 1200) score -= 10;
  score = Math.max(0, Math.min(100, score));

  parsed.quality_score = score;
  parsed.word_count = wordCount;
  parsed.ai_buzzword_count = aiBuzzwords;
  return parsed;
}

// ── GSC Simulation / real GSC if credentials available ───────────────────────
async function fetchGSCData(siteUrl) {
  // Real GSC integration requires OAuth. This returns mock/cached data.
  // Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET in .env.local for real integration.
  return { clicks: 0, impressions: 0, avg_position: 0, ranking_keywords: 0 };
}

// ── Schema ────────────────────────────────────────────────────────────────────
async function ensureSchema() {
  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(120) NOT NULL UNIQUE,
    email VARCHAR(255) NULL,
    password_hash VARCHAR(255) NOT NULL,
    salt VARCHAR(64) NOT NULL,
    role VARCHAR(40) DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Seed default admin
  const uc = await one('SELECT COUNT(*) cnt FROM np_seo_users').catch(()=>({cnt:0}));
  if (!uc || Number(uc.cnt) === 0) {
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = await hashPassword('NativPost2026!', salt);
    await q('INSERT INTO np_seo_users (username,email,password_hash,salt,role) VALUES (?,?,?,?,?)',
      ['admin', 'admin@nativpost.com', hash, salt, 'admin']).catch(()=>{});
    console.log('[Auth] Default admin created — username: admin, password: NativPost2026!');
    console.log('[Auth] ⚠️  CHANGE THIS PASSWORD immediately after first login via /settings');
  }

  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_sites (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    url VARCHAR(500) NOT NULL,
    active TINYINT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  // Seed NativPost itself
  const sc = await one('SELECT COUNT(*) cnt FROM np_seo_sites').catch(()=>({cnt:0}));
  if (!sc || Number(sc.cnt) === 0) {
    await execSafe("INSERT INTO np_seo_sites (name, url) VALUES ('NativPost', 'https://nativpost.com')").catch(()=>{});
  }

  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_pages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    site_id INT NOT NULL,
    page_url VARCHAR(2000) NOT NULL,
    page_title VARCHAR(1000),
    meta_description TEXT,
    h1_text VARCHAR(1000),
    word_count INT DEFAULT 0,
    crawled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_page_url (page_url(500))
  )`);

  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_competitors (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    url VARCHAR(500) NOT NULL UNIQUE,
    tier VARCHAR(60) DEFAULT 'direct',
    note TEXT,
    active TINYINT DEFAULT 1,
    title VARCHAR(1000),
    meta_description TEXT,
    h1_text VARCHAR(1000),
    word_count INT DEFAULT 0,
    page_count INT DEFAULT 0,
    score INT DEFAULT 0,
    starting_price INT NULL,
    has_ai TINYINT DEFAULT 0,
    has_video TINYINT DEFAULT 0,
    has_scheduling TINYINT DEFAULT 0,
    has_brand_voice TINYINT DEFAULT 0,
    has_analytics TINYINT DEFAULT 0,
    last_audited_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Seed known competitors
  for (const c of KNOWN_COMPETITORS) {
    await execSafe('INSERT INTO np_seo_competitors (name,url,tier,note) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE name=name', [c.label, c.url, c.tier, c.note]);
  }

  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_keywords (
    id INT AUTO_INCREMENT PRIMARY KEY,
    site_id INT,
    keyword VARCHAR(500) NOT NULL,
    cluster_key VARCHAR(120),
    cluster_name VARCHAR(255),
    intent VARCHAR(60),
    volume INT,
    difficulty INT,
    priority_score INT DEFAULT 50,
    is_tracked TINYINT DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_kw (keyword(255))
  )`);

  // Seed keyword clusters
  for (const cluster of NATIVPOST_FEATURE_CLUSTERS) {
    for (const kw of cluster.keywords) {
      await execSafe('INSERT INTO np_seo_keywords (keyword, cluster_key, cluster_name, intent) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE cluster_key=cluster_key',
        [kw, cluster.key, cluster.label, kw.includes('best') || kw.includes('vs') ? 'commercial' : kw.includes('how') ? 'informational' : 'commercial']);
    }
  }

  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_articles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    site_id INT,
    keyword_id INT,
    title VARCHAR(1000),
    slug VARCHAR(500),
    meta_description TEXT,
    excerpt TEXT,
    body LONGTEXT,
    status VARCHAR(60) DEFAULT 'draft',
    primary_keyword VARCHAR(500),
    quality_score INT DEFAULT 0,
    word_count INT DEFAULT 0,
    published_url TEXT,
    published_at DATETIME,
    featured_image_url TEXT,
    featured_image_alt VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_serp_cache (
    keyword VARCHAR(500) PRIMARY KEY,
    result_json LONGTEXT,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_serp_results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    keyword VARCHAR(500),
    competitor_id INT,
    position INT,
    title VARCHAR(1000),
    url VARCHAR(2000),
    snippet TEXT,
    is_nativpost TINYINT DEFAULT 0,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_kw (keyword(200)),
    INDEX idx_comp (competitor_id)
  )`);

  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_backlinks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    site_id INT,
    source_url VARCHAR(2000),
    source_domain VARCHAR(500),
    target_url VARCHAR(2000),
    anchor_text VARCHAR(1000),
    domain_authority INT DEFAULT 0,
    status VARCHAR(60) DEFAULT 'opportunity',
    earned TINYINT DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_daily_brief (
    id INT AUTO_INCREMENT PRIMARY KEY,
    brief_date DATE NOT NULL,
    category VARCHAR(120),
    keyword VARCHAR(500),
    priority INT DEFAULT 50,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_date (brief_date)
  )`);

  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_gsc_data (
    id INT AUTO_INCREMENT PRIMARY KEY,
    site_id INT,
    date_range VARCHAR(60),
    clicks INT DEFAULT 0,
    impressions INT DEFAULT 0,
    avg_position DECIMAL(6,2) DEFAULT 0,
    ranking_keywords INT DEFAULT 0,
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await execSafe(`CREATE TABLE IF NOT EXISTS np_seo_competitor_keyword_gaps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    competitor_id INT NOT NULL,
    keyword VARCHAR(500) NOT NULL,
    competitor_position INT,
    nativpost_position INT,
    gap_score INT DEFAULT 0,
    found_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_comp_kw (competitor_id, keyword(200))
  )`);

  console.log('[Schema] NativPost SEO DB schema ensured.');
}

// ── Auto-publishing stub (Contentful / webhook) ───────────────────────────────
let _publishedToday = 0;
let _publishDay = '';
async function runAutoPublisher() {
  if (!AUTO_PUBLISH_ENABLED) return;
  const d = today();
  if (_publishDay !== d) { _publishDay = d; _publishedToday = 0; }
  if (_publishedToday >= AUTO_PUBLISH_DAILY_LIMIT) return;
  const article = await one(`SELECT id, title, slug, body FROM np_seo_articles WHERE status='approved' AND (published_at IS NULL) ORDER BY quality_score DESC LIMIT 1`);
  if (!article) return;
  console.log(`[AutoPublish] Would publish article #${article.id}: "${article.title}"`);
  // Integrate with NativPost's CMS (Contentful or direct blog API) here
  const publishUrl = NATIVPOST_SITE_URL + '/blog/' + (article.slug || article.id);
  await execSafe(`UPDATE np_seo_articles SET status='published', published_at=NOW(), published_url=? WHERE id=?`, [publishUrl, article.id]);
  _publishedToday++;
  console.log(`[AutoPublish] Published: ${publishUrl}`);
}
function startAutoPublisher() {
  if (!AUTO_PUBLISH_ENABLED) return;
  setInterval(runAutoPublisher, AUTO_PUBLISH_INTERVAL_MINUTES * 60 * 1000);
  console.log(`Auto-publisher enabled (every ${AUTO_PUBLISH_INTERVAL_MINUTES}min, max ${AUTO_PUBLISH_DAILY_LIMIT}/day)`);
}

// ── Daily brief generator ─────────────────────────────────────────────────────
async function generateDailyBrief() {
  const d = today();
  const existing = await one('SELECT COUNT(*) cnt FROM np_seo_daily_brief WHERE brief_date=?', [d]);
  if (existing && Number(existing.cnt) > 0) return;

  const brief = [];

  // 1. Keywords tracked but no article yet
  const uncovered = await q(`SELECT k.keyword, k.cluster_name, k.priority_score FROM np_seo_keywords k LEFT JOIN np_seo_articles a ON a.primary_keyword=k.keyword WHERE a.id IS NULL AND k.is_tracked=1 ORDER BY k.priority_score DESC LIMIT 5`);
  for (const k of uncovered) {
    brief.push({ category: 'coverage-gap', keyword: k.keyword, priority: k.priority_score || 50, reason: `No article yet for "${k.keyword}" — ${k.cluster_name} cluster` });
  }

  // 2. Competitor keyword gaps
  const compGaps = await q(`SELECT g.keyword, g.gap_score, c.name comp_name FROM np_seo_competitor_keyword_gaps g JOIN np_seo_competitors c ON c.id=g.competitor_id ORDER BY g.gap_score DESC LIMIT 3`);
  for (const g of compGaps) {
    brief.push({ category: 'competitor-gap', keyword: g.keyword, priority: g.gap_score, reason: `${g.comp_name} ranks for this — NativPost doesn't` });
  }

  // 3. Articles with low quality scores that need rewriting
  const lowQ = await q(`SELECT title, primary_keyword, quality_score FROM np_seo_articles WHERE quality_score < 70 AND status NOT IN ('published','rejected') ORDER BY quality_score ASC LIMIT 2`);
  for (const a of lowQ) {
    brief.push({ category: 'quality-flag', keyword: a.primary_keyword || a.title, priority: 30, reason: `Quality score ${a.quality_score}/100 — needs rewrite` });
  }

  if (!brief.length) brief.push({ category: 'general', keyword: 'ai social media content generator', priority: 60, reason: 'Core commercial keyword — always worth fresh content' });

  for (const item of brief) {
    await execSafe('INSERT INTO np_seo_daily_brief (brief_date, category, keyword, priority, reason) VALUES (?,?,?,?,?)',
      [d, item.category, item.keyword, item.priority, item.reason]);
  }
  console.log(`[DailyBrief] Generated ${brief.length} items for ${d}`);
}
function startDailyBriefRefresher() {
  setTimeout(generateDailyBrief, 60000);
  setInterval(generateDailyBrief, 24*60*60*1000);
  console.log('Daily brief refresher enabled.');
}

// ── Competitor weekly re-audit ────────────────────────────────────────────────
function startCompetitorRefresher() {
  const intervalMs = 7 * 24 * 60 * 60 * 1000;
  async function tick() {
    const comps = await q('SELECT id, url FROM np_seo_competitors WHERE active=1');
    if (!comps.length) return;
    console.log(`[Competitors] Weekly re-audit for ${comps.length} competitors...`);
    for (const c of comps) {
      try {
        const audit = await auditCompetitor(c.url);
        await saveCompetitorAudit(c.id, audit);
      } catch(e) { console.error(`[Competitors] Audit failed for ${c.url}:`, e.message); }
    }
    console.log('[Competitors] Weekly re-audit complete.');
  }
  setTimeout(tick, 20 * 60 * 1000); // first run 20min after boot
  setInterval(tick, intervalMs);
  console.log('Competitor weekly re-audit enabled.');
}

// ── Route helpers ─────────────────────────────────────────────────────────────
app.use(requireAuth);

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get('/login', (req,res) => res.render('login', { currentPath: '/login', error: null }));
app.post('/auth/login', async (req,res) => {
  const { username, password } = req.body;
  const user = await one('SELECT * FROM np_seo_users WHERE username=? OR email=?', [username, username]);
  if (!user) return res.render('login', { currentPath: '/login', error: 'Invalid username or password' });
  const ok = await verifyPassword(password, user.password_hash, user.salt);
  if (!ok) return res.render('login', { currentPath: '/login', error: 'Invalid username or password' });
  const sid = generateSessionId();
  const exp = new Date(Date.now() + SESSION_DURATION_MS);
  await q('INSERT INTO np_seo_sessions (id, user_id, expires_at) VALUES (?,?,?)', [sid, user.id, exp]);
  setSessionCookie(res, sid);
  res.redirect('/');
});
app.get('/auth/logout', async (req,res) => {
  const cookies = parseCookies(req);
  const sid = cookies['np_seo_session'];
  if (sid) await q('DELETE FROM np_seo_sessions WHERE id=?', [sid]).catch(()=>{});
  clearSessionCookie(res);
  res.redirect('/login');
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/', async (req,res,next) => {
  try {
    const site = await one('SELECT * FROM np_seo_sites WHERE active=1 LIMIT 1');
    const siteId = site?.id || null;

    const [pages, keywords, articles, competitors] = await Promise.all([
      one('SELECT COUNT(*) cnt FROM np_seo_pages WHERE ? IS NULL OR site_id=?', [siteId, siteId]),
      one('SELECT COUNT(*) cnt FROM np_seo_keywords'),
      q('SELECT status, COUNT(*) cnt FROM np_seo_articles GROUP BY status'),
      one('SELECT COUNT(*) cnt FROM np_seo_competitors WHERE active=1'),
    ]);

    const artMap = {};
    for (const a of articles) artMap[a.status] = Number(a.cnt);

    const gscRow = await one('SELECT clicks, impressions, avg_position FROM np_seo_gsc_data WHERE ? IS NULL OR site_id=? ORDER BY synced_at DESC LIMIT 1', [siteId, siteId]);
    const gsc = gscRow || { clicks:0, impressions:0, avg_position:0 };
    const blRow = await one('SELECT COUNT(*) cnt FROM np_seo_backlinks WHERE earned=1 AND (? IS NULL OR site_id=?)', [siteId, siteId]);
    const earnedBL = Number(blRow?.cnt || 0);

    const health = computeContentHealthScore({
      pages: Number(pages?.cnt||0),
      articles: artMap.published || 0,
      avgPos: Number(gsc.avg_position||0),
      clicks: Number(gsc.clicks||0),
      impressions: Number(gsc.impressions||0),
      earnedBL,
    });

    const compRanked = await q('SELECT id, name, url, tier, score, page_count, has_ai, has_video, has_brand_voice FROM np_seo_competitors WHERE active=1 ORDER BY score DESC LIMIT 8');

    // Competitor SERP counts
    for (const c of compRanked) {
      const serpRow = await one('SELECT COUNT(*) cnt, MIN(position) best_pos, AVG(position) avg_pos FROM np_seo_serp_results WHERE competitor_id=?', [c.id]);
      c.serpRankCount = Number(serpRow?.cnt||0);
      c.serpBestPos = serpRow?.best_pos || null;
      c.serpAvgPos = serpRow?.avg_pos || null;
      const gapRow = await one('SELECT COUNT(*) cnt FROM np_seo_competitor_keyword_gaps WHERE competitor_id=?', [c.id]);
      c.gapCount = Number(gapRow?.cnt||0);
    }

    const drafts = await q(`SELECT id, title, primary_keyword, status, quality_score FROM np_seo_articles WHERE status IN ('draft','pending_review') ORDER BY quality_score ASC LIMIT 6`);
    const opportunities = await q(`SELECT k.keyword, k.cluster_name, k.intent, k.volume, k.priority_score FROM np_seo_keywords k LEFT JOIN np_seo_articles a ON a.primary_keyword=k.keyword WHERE a.id IS NULL ORDER BY k.priority_score DESC LIMIT 6`);
    const dailyBrief = await q('SELECT * FROM np_seo_daily_brief WHERE brief_date=? ORDER BY priority DESC LIMIT 5', [today()]);

    const blOpps = await one('SELECT COUNT(*) cnt FROM np_seo_backlinks WHERE site_id=? AND earned=0', [siteId]);

    res.render('dashboard', {
      currentPath: '/',
      site,
      summary: {
        pages: Number(pages?.cnt||0),
        keywords: Number(keywords?.cnt||0),
        competitors: Number(competitors?.cnt||0),
        drafts: artMap.draft || 0,
        review: artMap.pending_review || 0,
        queued: artMap.approved || 0,
        published: artMap.published || 0,
      },
      health,
      gsc,
      earnedBL,
      blOpportunities: Number(blOpps?.cnt||0),
      compRanked,
      drafts,
      opportunities,
      dailyBrief,
      minQualityScore: MIN_QUALITY_SCORE,
    });
  } catch(e) { next(e); }
});

// ── Sites / Crawl ─────────────────────────────────────────────────────────────
app.get('/sites', async (req,res,next) => {
  try {
    const sites = await q('SELECT s.*, (SELECT COUNT(*) FROM np_seo_pages p WHERE p.site_id=s.id) page_count FROM np_seo_sites s ORDER BY s.id');
    res.render('sites', { currentPath: '/sites', sites });
  } catch(e) { next(e); }
});

app.post('/sites/crawl/:id', async (req,res,next) => {
  try {
    const site = await one('SELECT * FROM np_seo_sites WHERE id=?', [req.params.id]);
    if (!site) return res.redirect('/sites?error=not_found');
    const base = originOf(resolveCrawlUrl(site.url));
    const { html: homeHtml } = await fetchUrl(base, 15000);
    let links = extractLinks(homeHtml, base).filter(l => l.startsWith(base));
    // Also try /blog, /features, /pricing
    for (const page of ['/blog', '/features', '/pricing', '/about']) {
      const { html } = await fetchUrl(base + page, 10000);
      links.push(...extractLinks(html, base).filter(l => l.startsWith(base)));
    }
    links = [...new Set([base, ...links])].slice(0, 80);
    let crawled = 0;
    for (const url of links) {
      try {
        const { html, status } = await fetchUrl(url, 10000);
        if (!html || status >= 400) continue;
        const title = extractTitle(html);
        const meta = extractMeta(html, 'description') || extractMeta(html, 'og:description');
        const h1 = extractH1(html);
        const words = countWords(html);
        await execSafe(`INSERT INTO np_seo_pages (site_id,page_url,page_title,meta_description,h1_text,word_count) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE page_title=?,meta_description=?,h1_text=?,word_count=?,crawled_at=NOW()`,
          [site.id,url,title,meta,h1,words, title,meta,h1,words]);
        crawled++;
      } catch(e) {}
    }
    res.redirect('/sites?crawled=' + crawled);
  } catch(e) { next(e); }
});

// ── Keywords ──────────────────────────────────────────────────────────────────
app.get('/keywords', async (req,res,next) => {
  try {
    const cluster = req.query.cluster || '';
    const rows = await q(
      `SELECT k.*, (SELECT id FROM np_seo_articles a WHERE a.primary_keyword=k.keyword LIMIT 1) has_article
       FROM np_seo_keywords k WHERE (? = '' OR k.cluster_key=?) ORDER BY k.priority_score DESC, k.keyword`,
      [cluster, cluster]
    );
    const clusters = NATIVPOST_FEATURE_CLUSTERS;
    res.render('keywords', { currentPath: '/keywords', rows, clusters, selectedCluster: cluster });
  } catch(e) { next(e); }
});

app.post('/keywords/add', async (req,res,next) => {
  try {
    const { keyword, cluster_key, intent, volume } = req.body;
    const kw = String(keyword||'').trim().toLowerCase();
    if (!kw) return res.redirect('/keywords?error=empty');
    const cluster = NATIVPOST_FEATURE_CLUSTERS.find(c=>c.key===cluster_key);
    await execSafe('INSERT INTO np_seo_keywords (keyword, cluster_key, cluster_name, intent, volume) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE cluster_key=?',
      [kw, cluster_key, cluster?.label||'', intent||'informational', Number(volume)||0, cluster_key]);
    res.redirect('/keywords?added=1');
  } catch(e) { next(e); }
});

app.post('/keywords/serp/:id', async (req,res,next) => {
  try {
    const kw = await one('SELECT * FROM np_seo_keywords WHERE id=?', [req.params.id]);
    if (!kw) return res.redirect('/keywords?error=not_found');
    const results = await serpLookup(kw.keyword);

    // Save results and detect competitors
    await execSafe('DELETE FROM np_seo_serp_results WHERE keyword=?', [kw.keyword]);
    for (const r of results) {
      // check if this result belongs to NativPost or a known competitor
      const isNP = r.url.includes('nativpost.com') ? 1 : 0;
      let compId = null;
      for (const c of KNOWN_COMPETITORS) {
        if (r.url.includes(new URL(c.url).hostname)) { 
          const dbComp = await one('SELECT id FROM np_seo_competitors WHERE url=?', [c.url]);
          if (dbComp) { compId = dbComp.id; break; }
        }
      }
      await execSafe('INSERT INTO np_seo_serp_results (keyword, competitor_id, position, title, url, snippet, is_nativpost) VALUES (?,?,?,?,?,?,?)',
        [kw.keyword, compId, r.position, r.title, r.url, r.snippet||'', isNP]);

      // If competitor ranks here but NativPost doesn't — that's a keyword gap
      if (compId && !isNP) {
        const npPos = results.find(rr => rr.url.includes('nativpost.com'))?.position || 999;
        const gapScore = Math.max(0, 100 - r.position * 4);
        await execSafe('INSERT INTO np_seo_competitor_keyword_gaps (competitor_id, keyword, competitor_position, nativpost_position, gap_score) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE competitor_position=?, nativpost_position=?, gap_score=?',
          [compId, kw.keyword, r.position, npPos, gapScore, r.position, npPos, gapScore]);
      }
    }
    res.redirect('/keywords?serp_done=1');
  } catch(e) { next(e); }
});

// ── Competitors ───────────────────────────────────────────────────────────────
app.get('/competitors', async (req,res,next) => {
  try {
    const comps = await q('SELECT * FROM np_seo_competitors ORDER BY score DESC');
    for (const c of comps) {
      const g = await one('SELECT COUNT(*) cnt FROM np_seo_competitor_keyword_gaps WHERE competitor_id=?', [c.id]);
      c.gapCount = Number(g?.cnt||0);
    }
    res.render('competitors', { currentPath: '/competitors', comps, knownTiers: ['direct','scheduler','writing','enterprise'] });
  } catch(e) { next(e); }
});

app.post('/competitors/add', async (req,res,next) => {
  try {
    const { name, url, tier, note } = req.body;
    if (!url) return res.redirect('/competitors?error=empty');
    await execSafe('INSERT INTO np_seo_competitors (name,url,tier,note) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE name=?', [name||url, normalizeUrl(url), tier||'direct', note||'', name||url]);
    res.redirect('/competitors?added=1');
  } catch(e) { next(e); }
});

app.post('/competitors/audit/:id', async (req,res,next) => {
  try {
    const comp = await one('SELECT * FROM np_seo_competitors WHERE id=?', [req.params.id]);
    if (!comp) return res.redirect('/competitors?error=not_found');
    const audit = await auditCompetitor(comp.url);
    await saveCompetitorAudit(comp.id, audit);
    res.redirect('/competitors?audited=' + comp.name);
  } catch(e) { next(e); }
});

// ── Content Studio ────────────────────────────────────────────────────────────
app.get('/content-studio', async (req,res,next) => {
  try {
    const keywords = await q('SELECT k.*, (SELECT id FROM np_seo_articles a WHERE a.primary_keyword=k.keyword LIMIT 1) has_article FROM np_seo_keywords k ORDER BY k.priority_score DESC LIMIT 80');
    const clusters = NATIVPOST_FEATURE_CLUSTERS;
    res.render('content-studio', { currentPath: '/content-studio', keywords, clusters, minQualityScore: MIN_QUALITY_SCORE });
  } catch(e) { next(e); }
});

app.post('/content-studio/generate', async (req,res,next) => {
  try {
    const { keyword, word_target } = req.body;
    const kw = String(keyword||'').trim();
    if (!kw) return res.redirect('/content-studio?error=empty');

    // gather context
    const serpData = (await serpLookup(kw)).slice(0,5).map((r,i)=>`${i+1}. [${r.position}] ${r.title} — ${r.url}`).join('\n');
    const sitePages = await q('SELECT page_title, page_url, meta_description FROM np_seo_pages LIMIT 30');
    const siteContext = sitePages.map(p=>`${p.page_title||'page'} | ${p.page_url}`).join('\n');
    const compRows = await q('SELECT name, url, tier, note FROM np_seo_competitors WHERE active=1');
    const competitorContext = compRows.map(c=>`${c.name} (${c.tier}): ${c.note||''}`).join('\n');

    const wordTarget = Math.max(800, Math.min(3000, Number(word_target)||1400));
    const result = await generateArticle(kw, { serpData, siteContext, competitorContext, wordTarget });

    const site = await one('SELECT id FROM np_seo_sites WHERE active=1 LIMIT 1');
    const siteId = site?.id || null;
    const kwRow = await one('SELECT id FROM np_seo_keywords WHERE keyword=?', [kw]);

    const r = await q(`INSERT INTO np_seo_articles (site_id,keyword_id,title,slug,meta_description,excerpt,body,status,primary_keyword,quality_score,word_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [siteId, kwRow?.id||null, result.title, result.slug, result.meta_description, result.excerpt, result.body_markdown, result.quality_score >= MIN_QUALITY_SCORE ? 'pending_review' : 'draft', kw, result.quality_score, result.word_count]);
    const articleId = r.insertId || (await one('SELECT id FROM np_seo_articles ORDER BY id DESC LIMIT 1')).id;
    res.redirect('/articles/' + articleId + '?generated=1');
  } catch(e) {
    console.error('[Generate]', e.message);
    res.redirect('/content-studio?error=' + encodeURIComponent(e.message));
  }
});

// ── Articles ──────────────────────────────────────────────────────────────────
app.get('/articles', async (req,res,next) => {
  try {
    const status = req.query.status || '';
    const rows = await q(`SELECT a.*, k.cluster_name FROM np_seo_articles a LEFT JOIN np_seo_keywords k ON k.keyword=a.primary_keyword ${status ? 'WHERE a.status=?' : ''} ORDER BY a.updated_at DESC`, status ? [status] : []);
    res.render('articles', { currentPath: '/articles', rows, filterStatus: status, minQualityScore: MIN_QUALITY_SCORE });
  } catch(e) { next(e); }
});

app.get('/articles/:id', async (req,res,next) => {
  try {
    const article = await one('SELECT * FROM np_seo_articles WHERE id=?', [req.params.id]);
    if (!article) return res.status(404).render('error', { currentPath: '', message: 'Article not found' });
    const bodyHtml = markdownToHtml(article.body || '');
    res.render('article-preview', { currentPath: '/articles', article, bodyHtml, minQualityScore: MIN_QUALITY_SCORE });
  } catch(e) { next(e); }
});

app.get('/articles/:id/edit', async (req,res,next) => {
  try {
    const article = await one('SELECT * FROM np_seo_articles WHERE id=?', [req.params.id]);
    if (!article) return res.status(404).render('error', { currentPath: '', message: 'Article not found' });
    res.render('article-edit', { currentPath: '/articles', article, minQualityScore: MIN_QUALITY_SCORE });
  } catch(e) { next(e); }
});

app.post('/articles/:id/save', async (req,res,next) => {
  try {
    const { title, slug, meta_description, excerpt, body, status, featured_image_url, featured_image_alt } = req.body;
    const article = await one('SELECT * FROM np_seo_articles WHERE id=?', [req.params.id]);
    if (!article) return res.status(404).render('error', { currentPath:'', message:'Not found' });

    const wordCount = String(body||'').split(/\s+/).filter(Boolean).length;
    const newStatus = ['draft','pending_review','approved','published','rejected'].includes(status) ? status : article.status;
    await execSafe(`UPDATE np_seo_articles SET title=?,slug=?,meta_description=?,excerpt=?,body=?,status=?,featured_image_url=?,featured_image_alt=?,word_count=?,updated_at=NOW() WHERE id=?`,
      [title, slug, meta_description, excerpt, body, newStatus, featured_image_url||'', featured_image_alt||'', wordCount, req.params.id]);
    res.redirect('/articles/' + req.params.id + '?saved=1');
  } catch(e) { next(e); }
});

app.post('/articles/:id/approve', async (req,res,next) => {
  try {
    await execSafe(`UPDATE np_seo_articles SET status='approved', updated_at=NOW() WHERE id=?`, [req.params.id]);
    res.redirect('/articles?approved=1');
  } catch(e) { next(e); }
});

app.post('/articles/:id/reject', async (req,res,next) => {
  try {
    await execSafe(`UPDATE np_seo_articles SET status='rejected', updated_at=NOW() WHERE id=?`, [req.params.id]);
    res.redirect('/articles?rejected=1');
  } catch(e) { next(e); }
});

app.post('/articles/:id/delete', async (req,res,next) => {
  try {
    await execSafe('DELETE FROM np_seo_articles WHERE id=?', [req.params.id]);
    res.redirect('/articles?deleted=1');
  } catch(e) { next(e); }
});

// ── SERP Intelligence ─────────────────────────────────────────────────────────
app.get('/serp', async (req,res,next) => {
  try {
    const recent = await q('SELECT DISTINCT keyword, fetched_at FROM np_seo_serp_cache ORDER BY fetched_at DESC LIMIT 30');
    const results = req.query.keyword ? await serpLookup(req.query.keyword) : [];
    const kw = req.query.keyword || '';

    // Annotate with NativPost/competitor flags
    if (results.length) {
      for (const r of results) {
        r.isNativPost = r.url.includes('nativpost.com');
        r.competitor = KNOWN_COMPETITORS.find(c => r.url.includes(new URL(c.url).hostname));
      }
    }
    res.render('serp', { currentPath: '/serp', recent, results, keyword: kw });
  } catch(e) { next(e); }
});

// ── Backlinks ─────────────────────────────────────────────────────────────────
app.get('/backlinks', async (req,res,next) => {
  try {
    const site = await one('SELECT * FROM np_seo_sites WHERE active=1 LIMIT 1');
    const siteId = site?.id || null;
    const links = await q('SELECT * FROM np_seo_backlinks WHERE ? IS NULL OR site_id=? ORDER BY domain_authority DESC, earned DESC', [siteId, siteId]);
    const earned = links.filter(l=>l.earned).length;
    res.render('backlinks', { currentPath: '/backlinks', links, earned, siteId });
  } catch(e) { next(e); }
});

app.post('/backlinks/add', async (req,res,next) => {
  try {
    const { source_url, anchor_text, domain_authority, notes } = req.body;
    const site = await one('SELECT id FROM np_seo_sites WHERE active=1 LIMIT 1');
    const domain = (() => { try { return new URL(source_url).hostname; } catch { return source_url; } })();
    await execSafe('INSERT INTO np_seo_backlinks (site_id,source_url,source_domain,anchor_text,domain_authority,notes) VALUES (?,?,?,?,?,?)',
      [site?.id||null, source_url, domain, anchor_text||'', Number(domain_authority)||0, notes||'']);
    res.redirect('/backlinks?added=1');
  } catch(e) { next(e); }
});

app.post('/backlinks/:id/mark-earned', async (req,res,next) => {
  try {
    await execSafe('UPDATE np_seo_backlinks SET earned=1, status="earned" WHERE id=?', [req.params.id]);
    res.redirect('/backlinks?earned=1');
  } catch(e) { next(e); }
});

// ── Reports ───────────────────────────────────────────────────────────────────
app.get('/reports', async (req,res,next) => {
  try {
    const artStats = await q('SELECT status, COUNT(*) cnt FROM np_seo_articles GROUP BY status');
    const artMap = {};
    for (const a of artStats) artMap[a.status] = Number(a.cnt);

    const kwCoverage = await q(`SELECT k.cluster_key, k.cluster_name, COUNT(k.id) total, SUM(CASE WHEN a.id IS NOT NULL THEN 1 ELSE 0 END) covered FROM np_seo_keywords k LEFT JOIN np_seo_articles a ON a.primary_keyword=k.keyword GROUP BY k.cluster_key, k.cluster_name`);

    const topPublished = await q(`SELECT title, slug, primary_keyword, quality_score, word_count, published_at FROM np_seo_articles WHERE status='published' ORDER BY quality_score DESC LIMIT 10`);
    const serpGaps = await q(`SELECT g.keyword, g.competitor_position, g.nativpost_position, g.gap_score, c.name comp_name FROM np_seo_competitor_keyword_gaps g JOIN np_seo_competitors c ON c.id=g.competitor_id ORDER BY g.gap_score DESC LIMIT 15`);

    res.render('reports', { currentPath: '/reports', artMap, kwCoverage, topPublished, serpGaps });
  } catch(e) { next(e); }
});

// ── Daily Brief ───────────────────────────────────────────────────────────────
app.get('/daily-brief', async (req,res,next) => {
  try {
    const brief = await q('SELECT * FROM np_seo_daily_brief WHERE brief_date=? ORDER BY priority DESC', [today()]);
    res.render('daily-brief', { currentPath: '/daily-brief', brief, today: today() });
  } catch(e) { next(e); }
});

app.post('/daily-brief/generate/:idx', async (req,res,next) => {
  try {
    const brief = await q('SELECT * FROM np_seo_daily_brief WHERE brief_date=? ORDER BY priority DESC', [today()]);
    const item = brief[Number(req.params.idx)];
    if (!item) return res.redirect('/daily-brief?error=not_found');
    // redirect to content studio with keyword pre-filled
    res.redirect('/content-studio?keyword=' + encodeURIComponent(item.keyword));
  } catch(e) { next(e); }
});

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/settings', async (req,res,next) => {
  try {
    res.render('settings', {
      currentPath: '/settings',
      config: {
        autoPublishEnabled: AUTO_PUBLISH_ENABLED,
        autoPublishIntervalMinutes: AUTO_PUBLISH_INTERVAL_MINUTES,
        autoPublishDailyLimit: AUTO_PUBLISH_DAILY_LIMIT,
        minQualityScore: MIN_QUALITY_SCORE,
        dfsEnabled: DFS_ENABLED,
        dfsDailyCap: DFS_DAILY_CALL_CAP,
        dfsDailyUsed: _dfsDailyCallCount,
        anthropicKeySet: !!process.env.ANTHROPIC_API_KEY,
        openaiKeySet: !!process.env.OPENAI_API_KEY,
        nativpostSiteUrl: NATIVPOST_SITE_URL,
        nativpostAppUrl: NATIVPOST_APP_URL,
      }
    });
  } catch(e) { next(e); }
});

// ── Error handlers ────────────────────────────────────────────────────────────
app.use((req,res) => res.status(404).render('error', { currentPath: '', message: 'Page not found' }));
app.use((err,req,res,next) => { console.error(err); res.status(500).render('error', { currentPath: '', message: err.message || 'Unexpected error' }); });

// ── Start ─────────────────────────────────────────────────────────────────────
ensureSchema().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NativPost SEO Tool running on http://0.0.0.0:${PORT}`);
    console.log(`Default login: admin / NativPost2026! — CHANGE THIS IMMEDIATELY`);
    startAutoPublisher();
    startDailyBriefRefresher();
    startCompetitorRefresher();
  });
}).catch(err => { console.error('Failed to start:', err); process.exit(1); });
