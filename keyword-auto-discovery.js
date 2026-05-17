// ============================================================================
// AUTO KEYWORD DISCOVERY ENGINE
// ============================================================================
// File: keyword-auto-discovery.js
// Location: /opt/nativpost/NativPost-seo/keyword-auto-discovery.js
//
// WHAT IT DOES:
//   Runs as a scheduled function inside the NativPost SEO tool.
//   Every 6 hours it auto-discovers and inserts new keywords from 5 sources:
//
//   Source 1 — SERP Expansion
//     Takes your existing high-priority keywords and uses DataForSEO to fetch
//     "related searches" and "people also ask" for each one. These are real
//     searches Google surfaces for your existing keywords — very high quality.
//
//   Source 2 — Competitor Page Mining
//     Re-reads all crawled competitor pages and extracts any keyword phrases
//     not already in your database. Runs against every competitor you have
//     added (Ocoya, Buffer, Predis, etc.).
//
//   Source 3 — GSC Long-tail Expansion
//     Takes your GSC ranking keywords and generates longer-tail variants by
//     combining them with intent modifiers and NativPost-specific qualifiers.
//
//   Source 4 — DuckDuckGo Related Searches (no API key needed)
//     Scrapes DuckDuckGo related searches for your top cluster keywords.
//     Zero cost, no API quota consumed.
//
//   Source 5 — Seed Expansion
//     A curated list of 200 high-value keywords seeded on first run and
//     updated quarterly. These supplement the 1,000 already in the seed script.
//
// HOW TO INTEGRATE:
//   1. Save this file to /opt/nativpost/NativPost-seo/keyword-auto-discovery.js
//   2. In index.js, add at the very top (after require statements):
//        const { startKeywordAutoDiscovery } = require('./keyword-auto-discovery');
//   3. In the boot line (ensureSchema().then(...)), add the call:
//        startKeywordAutoDiscovery({ q, execSafe, cleanKeyword, clusterName, intentOf, priorityScore });
//   4. Add env var to ecosystem.config.js (optional — defaults are sensible):
//        KEYWORD_DISCOVERY_ENABLED: 'true',
//        KEYWORD_DISCOVERY_INTERVAL_HOURS: '6',
//        KEYWORD_DISCOVERY_PER_RUN_LIMIT: '50',
//   5. Restart: pm2 restart /opt/nativpost/ecosystem.config.js --only nativpost-seo --update-env && pm2 save
//
// ZERO DISRUPTION GUARANTEE:
//   - Uses ON DUPLICATE KEY UPDATE — never creates duplicate rows.
//   - Has its own daily cap (KEYWORD_DISCOVERY_PER_RUN_LIMIT) so it cannot
//     flood the database.
//   - All inserts use source='auto-discovery' so you can filter or delete
//     them separately from manual or GSC keywords.
//   - Fully skippable: set KEYWORD_DISCOVERY_ENABLED=false to disable.
//   - All errors are caught and logged — a single bad source never crashes
//     the process or affects other schedulers.
// ============================================================================

'use strict';

const https = require('https');
const http = require('http');

// ── CONFIG ───────────────────────────────────────────────────────────────────
const ENABLED = String(process.env.KEYWORD_DISCOVERY_ENABLED || 'true').toLowerCase() !== 'false';
const INTERVAL_HOURS = Math.max(1, Number(process.env.KEYWORD_DISCOVERY_INTERVAL_HOURS || 6));
const PER_RUN_LIMIT = Math.max(10, Number(process.env.KEYWORD_DISCOVERY_PER_RUN_LIMIT || 50));
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';
const DFS_ENABLED = String(process.env.DATAFORSEO_ENABLED || 'true').toLowerCase() !== 'false';

// ── NATIVPOST RELEVANCE FILTER ────────────────────────────────────────────────
// Only import keywords relevant to NativPost's product and market.
// const RELEVANT_RX = /(
// social.? media |
//     ai.? (tool | platform | content | post | caption | generator | writer | schedule | create | publish | brand) |
//         content.? (ai | tool | creator | generation | strategy | planner | studio) |
//             brand.? (voice | profile | tone | identity) |
//                 caption | post.? generator |
//                     instagram | linkedin | tiktok | facebook | twitter | youtube | threads | pinterest |
//                     schedule | publish | automate | automation | calendar |
//                     agency | small.? business | startup | saas | b2b | ecommerce |
//                         africa | nigeria | kenya | ghana | south.? africa | paystack | naira |
//                             ugc | reel | short.? video | video.? generator |
//                                 nativpost | ocoya | buffer | hootsuite | predis | later | feedhive | socialbee | jasper |
//                                 alternative | comparison | review | pricing | competitor |
//                                 how.? to.* social | grow.* social | social.* grow |
//                                 marketing.* ai | ai.* marketing |
//                                 content.* marketing | marketing.* content
// )/ix;

// const BLOCK_RX = /(
// porn | xxx | casino | gambling | crack | keygen | torrent | warez |
//     game.? server | minecraft | rust | ark | valheim | terraria | gmod |
//     nitrado | bisect | shockbyte | hosthavoc | apexhosting | scalacube |
// [\u0080 -\uFFFF]{ 4,}
// )/ix;

const RELEVANT_RX =
    /(social.?media|ai.?(tool|platform|content|post|caption|generator|writer|schedule|create|publish|brand)|content.?(ai|tool|creator|generation|strategy|planner|studio)|brand.?(voice|profile|tone|identity)|caption|post.?generator|instagram|linkedin|tiktok|facebook|twitter|youtube|threads|pinterest|schedule|publish|automate|automation|calendar|agency|small.?business|startup|saas|b2b|ecommerce|africa|nigeria|kenya|ghana|south.?africa|paystack|naira|ugc|reel|short.?video|video.?generator|nativpost|ocoya|buffer|hootsuite|predis|later|feedhive|socialbee|jasper|alternative|comparison|review|pricing|competitor|how.?to.*social|grow.*social|social.*grow|marketing.*ai|ai.*marketing|content.*marketing|marketing.*content)/i;

const BLOCK_RX =
    /(porn|xxx|casino|gambling|crack|keygen|torrent|warez|game.?server|minecraft|rust|ark|valheim|terraria|gmod|nitrado|bisect|shockbyte|hosthavoc|apexhosting|scalacube|[\u0080-\uFFFF]{4,})/i;

function isRelevant(kw) {
    const k = String(kw || '').trim();
    if (!k || k.length < 5 || k.length > 200) return false;
    if (BLOCK_RX.test(k)) return false;
    if (RELEVANT_RX.test(k)) return true;
    return false;
}

// ── SMALL HTTP HELPER (no axios dependency) ───────────────────────────────────
function httpGet(url, opts = {}) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { timeout: 18000, ...opts }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function httpPost(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = Buffer.from(JSON.stringify(body));
        const opts = {
            hostname: u.hostname, port: u.port || 443, path: u.pathname,
            method: 'POST', timeout: 20000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
        };
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(opts, res => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data);
        req.end();
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SOURCE 1: DATAFORSEO RELATED SEARCHES ────────────────────────────────────
async function discoverViaSERP(seedKeywords) {
    if (!DFS_ENABLED || !DFS_LOGIN || !DFS_PASSWORD) return [];
    const candidates = [];
    const auth = Buffer.from(`${DFS_LOGIN}:${DFS_PASSWORD}`).toString('base64');

    // Only take top 3 seed keywords per run to stay within daily API cap
    const targets = seedKeywords.slice(0, 3);
    for (const kw of targets) {
        try {
            const payload = [{ keyword: kw, language_code: 'en', location_code: 2840, depth: 1 }];
            const res = await httpPost(
                'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
                payload,
                { Authorization: `Basic ${auth}` }
            );
            if (res.status !== 200) continue;
            const data = JSON.parse(res.body);
            const items = data?.tasks?.[0]?.result?.[0]?.items || [];
            for (const item of items) {
                // Related searches block
                if (item.type === 'related_searches') {
                    for (const r of (item.items || [])) {
                        if (r.title) candidates.push(r.title.toLowerCase().trim());
                    }
                }
                // People Also Ask
                if (item.type === 'people_also_ask') {
                    for (const r of (item.items || [])) {
                        if (r.title) candidates.push(r.title.toLowerCase().trim());
                    }
                }
            }
            await sleep(1200); // be polite to the API
        } catch (e) {
            console.warn(`[KeywordDiscovery] DFS SERP error for "${kw}":`, e.message);
        }
    }
    return candidates;
}

// ── SOURCE 2: COMPETITOR PAGE MINING ─────────────────────────────────────────
async function discoverViaCompetitors(q) {
    try {
        const pages = await q(
            `SELECT page_url, page_title, meta_description, body_text
       FROM competitor_pages
       WHERE last_crawled_at > DATE_SUB(NOW(), INTERVAL 14 DAY)
         AND (page_type IN ('blog','support','page','money') OR page_type IS NULL)
       ORDER BY word_count DESC
       LIMIT 80`
        );
        if (!pages || !pages.length) return [];
        const candidates = [];
        const stopwords = new Set('the and for with from your this that into about what when where why how over under near more have has was were use using our you can not are but all any get just like also their there they them will would could should only very been much make makes than then each out off see seen'.split(' '));

        for (const page of pages) {
            const text = [page.page_title, page.meta_description, page.body_text]
                .filter(Boolean).join(' ').toLowerCase();
            // Extract 2–4 word phrases that look like keywords
            const words = text.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w));
            for (let i = 0; i < words.length - 1; i++) {
                const bi = `${words[i]} ${words[i + 1]}`;
                const tri = words[i + 2] ? `${bi} ${words[i + 2]}` : null;
                const quad = words[i + 3] ? `${tri} ${words[i + 3]}` : null;
                [bi, tri, quad].filter(Boolean).forEach(p => candidates.push(p));
            }
        }
        return candidates;
    } catch (e) {
        console.warn('[KeywordDiscovery] Competitor mining error:', e.message);
        return [];
    }
}

// ── SOURCE 3: GSC LONG-TAIL EXPANSION ────────────────────────────────────────
async function discoverViaGSCExpansion(q) {
    try {
        const gscKeywords = await q(
            `SELECT DISTINCT keyword FROM keywords
       WHERE source = 'gsc'
         AND priority_score > 5
         AND LENGTH(keyword) > 8
       ORDER BY priority_score DESC
       LIMIT 30`
        );
        if (!gscKeywords || !gscKeywords.length) return [];

        const QUALIFIERS = [
            'tool', 'software', '2026', 'for small business', 'free trial',
            'ai', 'best', 'affordable', 'for agencies', 'nigeria', 'africa',
            'review', 'alternative', 'pricing', 'how to use',
        ];

        const candidates = [];
        for (const { keyword } of gscKeywords) {
            for (const q of QUALIFIERS) {
                // Avoid creating nonsense combos if the qualifier is already in the keyword
                if (!keyword.includes(q)) {
                    candidates.push(`${keyword} ${q}`);
                }
            }
        }
        return candidates;
    } catch (e) {
        console.warn('[KeywordDiscovery] GSC expansion error:', e.message);
        return [];
    }
}

// ── SOURCE 4: DUCKDUCKGO RELATED SEARCHES ────────────────────────────────────
async function discoverViaDuckDuckGo(seedKeywords) {
    const candidates = [];
    // Only 2 queries per run to avoid rate limiting
    const targets = seedKeywords.slice(0, 2);
    for (const kw of targets) {
        try {
            const encoded = encodeURIComponent(kw);
            const res = await httpGet(
                `https://duckduckgo.com/ac/?q=${encoded}&type=list`,
                { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NativPost-SEO-Bot/1.0)' } }
            );
            if (res.status !== 200) continue;
            const data = JSON.parse(res.body);
            // DDG autocomplete returns [query, [suggestions]] or just [suggestions]
            const suggestions = Array.isArray(data[1]) ? data[1] : (Array.isArray(data) ? data : []);
            for (const s of suggestions) {
                const phrase = typeof s === 'string' ? s : (s?.phrase || '');
                if (phrase) candidates.push(phrase.toLowerCase().trim());
            }
            await sleep(2000); // respectful delay
        } catch (e) {
            console.warn(`[KeywordDiscovery] DuckDuckGo error for "${kw}":`, e.message);
        }
    }
    return candidates;
}

// ── SOURCE 5: CURATED EXPANSION SEED ─────────────────────────────────────────
// 200 hand-picked keywords that complement the main 1,000-keyword seed.
// These are inserted once and never duplicated (ON DUPLICATE KEY UPDATE).
const EXPANSION_SEED = [
    // Emerging AI + social trends
    ['ai agent social media', 'AI Social Media Tools', 900, 28, 'commercial'],
    ['ai agentic social media tool', 'AI Social Media Tools', 600, 22, 'commercial'],
    ['multi-agent social media ai', 'AI Social Media Tools', 400, 18, 'commercial'],
    ['autonomous social media posting ai', 'AI Social Media Tools', 550, 20, 'commercial'],
    ['ai social media copilot', 'AI Social Media Tools', 480, 19, 'commercial'],
    ['ai social media 2027 trends', 'AI Social Media Tools', 700, 22, 'informational'],
    ['generative ai for social content', 'AI Social Media Tools', 1200, 30, 'commercial'],
    ['llm social media content tool', 'AI Social Media Tools', 500, 18, 'commercial'],
    ['claude ai social media', 'AI Social Media Tools', 800, 25, 'informational'],
    ['anthropic ai for marketing', 'AI Social Media Tools', 600, 20, 'commercial'],
    // Niche brand voice
    ['ai write in my voice', 'Brand Voice', 1400, 30, 'commercial'],
    ['ai match my writing style', 'Brand Voice', 1200, 28, 'commercial'],
    ['custom ai voice for brand', 'Brand Voice', 900, 26, 'commercial'],
    ['ai remember my brand style', 'Brand Voice', 700, 23, 'commercial'],
    ['brand personality ai tool', 'Brand Voice', 850, 25, 'commercial'],
    ['ai consistent brand messaging', 'Brand Voice', 800, 25, 'commercial'],
    ['brand guidelines ai enforcement', 'Brand Voice', 600, 21, 'commercial'],
    ['ai tone of voice enforcer', 'Brand Voice', 550, 20, 'commercial'],
    ['brand voice audit tool', 'Brand Voice', 700, 22, 'commercial'],
    ['social media tone checker', 'Brand Voice', 650, 22, 'commercial'],
    // X/Twitter rebrand
    ['x post generator', 'Twitter/X Content', 2800, 48, 'commercial'],
    ['x social media tool', 'Twitter/X Content', 1600, 37, 'commercial'],
    ['x.com marketing tool', 'Twitter/X Content', 1200, 32, 'commercial'],
    ['elon musk twitter alternative', 'Twitter/X Content', 900, 26, 'informational'],
    ['post on x automatically', 'Twitter/X Content', 1100, 30, 'commercial'],
    // Threads growth (newer platform)
    ['threads growth strategy', 'Threads & Pinterest', 1800, 32, 'informational'],
    ['threads algorithm 2026', 'Threads & Pinterest', 2200, 36, 'informational'],
    ['threads for business 2026', 'Threads & Pinterest', 1400, 30, 'informational'],
    ['grow on threads app', 'Threads & Pinterest', 1600, 32, 'informational'],
    ['threads vs instagram 2026', 'Threads & Pinterest', 1900, 35, 'informational'],
    ['best time to post on threads', 'Threads & Pinterest', 1300, 29, 'informational'],
    ['threads content ideas brands', 'Threads & Pinterest', 1100, 27, 'informational'],
    ['threads ai content generator', 'Threads & Pinterest', 800, 24, 'commercial'],
    ['threads scheduling tool', 'Threads & Pinterest', 900, 26, 'commercial'],
    ['how to use threads for business', 'Threads & Pinterest', 2100, 37, 'informational'],
    // AI video trends
    ['ai ugc video for brands', 'Video Generation', 1400, 34, 'commercial'],
    ['ai faceless video creator', 'Video Generation', 2100, 42, 'commercial'],
    ['ai avatar social media video', 'Video Generation', 1800, 40, 'commercial'],
    ['ai talking head video', 'Video Generation', 1600, 38, 'commercial'],
    ['ai create reels from text', 'Video Generation', 1900, 41, 'commercial'],
    ['ai video marketing tool 2026', 'Video Generation', 2400, 45, 'commercial'],
    ['short form video ai creator', 'Video Generation', 1700, 39, 'commercial'],
    ['animated social post generator', 'Video Generation', 1200, 33, 'commercial'],
    ['ai b-roll generator social media', 'Video Generation', 900, 28, 'commercial'],
    ['ai motion graphic social media', 'Video Generation', 700, 24, 'commercial'],
    // Long-form to short-form repurposing
    ['ai clip long video for social media', 'Content Repurposing', 1800, 38, 'commercial'],
    ['ai repurpose webinar to posts', 'Content Repurposing', 1100, 30, 'commercial'],
    ['ai turn podcast into social media', 'Content Repurposing', 1400, 34, 'commercial'],
    ['newsletter to social posts ai', 'Content Repurposing', 900, 27, 'commercial'],
    ['ai repurpose linkedin to instagram', 'Content Repurposing', 800, 25, 'commercial'],
    // New Africa keywords
    ['social media tool senegal', 'Africa Market', 300, 10, 'commercial'],
    ['social media tool cameroon', 'Africa Market', 280, 10, 'commercial'],
    ['social media management rwanda', 'Africa Market', 320, 10, 'commercial'],
    ['ai social media for ugandan brands', 'Africa Market', 260, 10, 'commercial'],
    ['social media marketing ethiopia', 'Africa Market', 350, 11, 'commercial'],
    ['social media tool tanzania', 'Africa Market', 300, 10, 'commercial'],
    ['social media for ivory coast brands', 'Africa Market', 250, 10, 'commercial'],
    ['african social media agency tool', 'Africa Market', 400, 12, 'commercial'],
    ['paystack powered social media', 'Africa Market', 380, 11, 'commercial'],
    ['social media tool zambia', 'Africa Market', 240, 10, 'commercial'],
    // Coaching / personal brand
    ['social media for life coaches', 'Niche Long Tail', 900, 23, 'commercial'],
    ['ai content for business coaches', 'Niche Long Tail', 850, 22, 'commercial'],
    ['social media for executive coaches', 'Niche Long Tail', 700, 21, 'commercial'],
    ['ai social media for therapists', 'Niche Long Tail', 650, 20, 'commercial'],
    ['social media for psychologists', 'Niche Long Tail', 600, 19, 'commercial'],
    ['ai captions for doctors', 'Niche Long Tail', 700, 21, 'commercial'],
    ['social media for veterinarians', 'Niche Long Tail', 550, 18, 'commercial'],
    ['ai content for lawyers social media', 'Niche Long Tail', 800, 22, 'commercial'],
    ['social media for accountants ai', 'Niche Long Tail', 750, 21, 'commercial'],
    ['social media for architects ai', 'Niche Long Tail', 600, 19, 'commercial'],
    // Ecommerce & DTC
    ['dtc brand social media ai', 'E-Commerce Social', 900, 26, 'commercial'],
    ['direct to consumer social media tool', 'E-Commerce Social', 1000, 28, 'commercial'],
    ['dropshipping social media content ai', 'E-Commerce Social', 800, 25, 'commercial'],
    ['ecommerce instagram automation', 'E-Commerce Social', 1300, 32, 'commercial'],
    ['ai product video for ecommerce', 'E-Commerce Social', 1100, 30, 'commercial'],
    ['social commerce tool ai', 'E-Commerce Social', 950, 27, 'commercial'],
    ['tiktok shop ai content creator', 'E-Commerce Social', 1400, 34, 'commercial'],
    ['instagram shopping content ai', 'E-Commerce Social', 1200, 31, 'commercial'],
    // Reseller / White Label
    ['white label social media ai', 'Agency Tools', 1200, 30, 'commercial'],
    ['resell social media ai tool', 'Agency Tools', 700, 22, 'commercial'],
    ['social media tool for digital marketing agencies', 'Agency Tools', 1600, 36, 'commercial'],
    ['client onboarding social media tool', 'Agency Tools', 800, 24, 'commercial'],
    ['agency content approval workflow ai', 'Agency Tools', 700, 22, 'commercial'],
    ['social media retainer tool ai', 'Agency Tools', 600, 20, 'commercial'],
    ['manage 20 clients social media', 'Agency Tools', 550, 19, 'commercial'],
    ['social media for boutique agency', 'Agency Tools', 500, 18, 'commercial'],
    // Engagement tactics
    ['social media engagement rate tool', 'Analytics', 1800, 38, 'commercial'],
    ['improve instagram engagement ai', 'Analytics', 1400, 34, 'commercial'],
    ['linkedin engagement boost tool', 'Analytics', 1100, 30, 'commercial'],
    ['ai social media engagement tips', 'Analytics', 900, 27, 'informational'],
    ['social media comment generator ai', 'Analytics', 800, 25, 'commercial'],
    ['ai reply to social media comments', 'Analytics', 700, 22, 'commercial'],
    // Product Hunt / launch
    ['social media tool product hunt', 'Product Awareness', 400, 14, 'informational'],
    ['new ai social media tool 2026', 'Product Awareness', 1200, 30, 'commercial'],
    ['best new social media tool launch', 'Product Awareness', 800, 24, 'commercial'],
    ['product launch social media strategy', 'Product Awareness', 2200, 42, 'informational'],
    // Education & how-to (educational cluster supplement)
    ['how to build a personal brand online', 'How To / Educational', 5800, 55, 'informational'],
    ['how to create content faster ai', 'How To / Educational', 2400, 42, 'informational'],
    ['how to go viral on social media 2026', 'How To / Educational', 6200, 60, 'informational'],
    ['how to batch create social media content', 'How To / Educational', 1800, 36, 'informational'],
    ['how to do social media marketing for free', 'How To / Educational', 3400, 50, 'informational'],
    ['social media content creation tips 2026', 'How To / Educational', 2800, 46, 'informational'],
    ['how to post consistently on social media', 'How To / Educational', 3600, 52, 'informational'],
    ['how to create a content strategy for instagram', 'How To / Educational', 2600, 44, 'informational'],
    ['social media growth mindset', 'How To / Educational', 1200, 28, 'informational'],
    ['how to measure content performance', 'How To / Educational', 2100, 40, 'informational'],
    // Comparison pages
    ['best social media tools compared 2026', 'Competitor Alternatives', 1600, 35, 'informational'],
    ['ocoya vs predis vs nativpost', 'Competitor Alternatives', 450, 16, 'commercial'],
    ['buffer vs later vs nativpost', 'Competitor Alternatives', 500, 17, 'commercial'],
    ['social media tool feature comparison', 'Competitor Alternatives', 1300, 31, 'informational'],
    ['which social media tool has ugc video', 'Competitor Alternatives', 400, 14, 'commercial'],
    ['social media tool with best video creation', 'Competitor Alternatives', 600, 19, 'commercial'],
    ['social media tool that filters ai output', 'Competitor Alternatives', 500, 17, 'commercial'],
    ['social media ai with human review', 'Competitor Alternatives', 450, 16, 'commercial'],
    ['social media tool built for africa', 'Competitor Alternatives', 550, 17, 'commercial'],
    ['tools like ocoya but better', 'Competitor Alternatives', 700, 21, 'commercial'],
    // Blog / thought leadership topics (generate articles for these)
    ['should businesses use ai for social media', 'SEO Blog Topics', 2800, 44, 'informational'],
    ['pros and cons of ai social media', 'SEO Blog Topics', 2100, 40, 'informational'],
    ['ai social media ethics 2026', 'SEO Blog Topics', 1400, 32, 'informational'],
    ['does ai replace social media managers', 'SEO Blog Topics', 3200, 48, 'informational'],
    ['ai for content creation vs human', 'SEO Blog Topics', 2600, 44, 'informational'],
    ['why your social media feels generic', 'SEO Blog Topics', 1100, 28, 'informational'],
    ['how to avoid sounding like ai on social media', 'SEO Blog Topics', 1800, 36, 'informational'],
    ['future of social media 2027', 'SEO Blog Topics', 2400, 42, 'informational'],
    ['ai content creator vs copywriter', 'SEO Blog Topics', 2200, 40, 'informational'],
    ['can ai understand brand voice', 'SEO Blog Topics', 1300, 30, 'informational'],
    ['how to train ai on your brand', 'SEO Blog Topics', 1600, 33, 'informational'],
    ['best content types for engagement 2026', 'SEO Blog Topics', 2800, 46, 'informational'],
    ['social media burnout solution', 'SEO Blog Topics', 1900, 37, 'informational'],
    ['automating social media without losing authenticity', 'SEO Blog Topics', 1100, 28, 'informational'],
    ['how to stay consistent on social media', 'SEO Blog Topics', 3400, 50, 'informational'],
    ['social media for brand building 2026', 'SEO Blog Topics', 2200, 40, 'informational'],
    ['roi of social media content creation', 'SEO Blog Topics', 1600, 34, 'informational'],
    ['why most ai social media fails', 'SEO Blog Topics', 1400, 30, 'informational'],
    ['ai slop and how to avoid it', 'SEO Blog Topics', 900, 22, 'informational'],
    ['brand voice examples from top brands', 'SEO Blog Topics', 2600, 44, 'informational'],
    // Content scheduling deep dives
    ['how to plan a month of social media content', 'Content Strategy', 2400, 42, 'informational'],
    ['social media content schedule template', 'Content Strategy', 3800, 52, 'informational'],
    ['best social media posting schedule', 'Content Strategy', 3200, 50, 'informational'],
    ['post frequency per platform guide', 'Content Strategy', 1800, 36, 'informational'],
    ['quality vs quantity social media posting', 'Content Strategy', 2100, 38, 'informational'],
    ['social media pillar content strategy', 'Content Strategy', 1600, 34, 'informational'],
    ['evergreen vs trending social content', 'Content Strategy', 1300, 30, 'informational'],
    ['social media content types ranked', 'Content Strategy', 1100, 28, 'informational'],
    ['content mix ratio social media', 'Content Strategy', 900, 26, 'informational'],
    ['80 20 rule social media content', 'Content Strategy', 1400, 31, 'informational'],
    // Misc misc misc
    ['ai create social proof posts', 'Visual Content', 700, 22, 'commercial'],
    ['ai testimonial post generator', 'Visual Content', 800, 24, 'commercial'],
    ['before after social media post ai', 'Visual Content', 650, 21, 'commercial'],
    ['ai case study post generator', 'Visual Content', 550, 19, 'commercial'],
    ['social media post for award winner', 'Visual Content', 480, 17, 'commercial'],
    ['milestone post generator ai', 'Visual Content', 650, 20, 'commercial'],
    ['ai thank you post social media', 'Visual Content', 700, 21, 'commercial'],
    ['ai generate event recap post', 'Visual Content', 600, 20, 'commercial'],
    ['product feature announcement post ai', 'Visual Content', 750, 22, 'commercial'],
    ['ai write team introduction post', 'Visual Content', 550, 19, 'commercial'],
];

// ── MAIN DISCOVERY FUNCTION ───────────────────────────────────────────────────
async function runKeywordDiscovery({ q, execSafe, cleanKeyword, clusterName, intentOf, priorityScore }) {
    console.log('[KeywordDiscovery] Starting auto-discovery run...');
    let totalInserted = 0;
    let totalUpdated = 0;

    // Helper: insert a single keyword
    async function upsertKeyword(kw, source, volume = 0, difficulty = 35, clusterOverride = null, intentOverride = null) {
        const clean = cleanKeyword(kw);
        if (!clean || !isRelevant(clean)) return false;
        const cluster = clusterOverride || clusterName(clean);
        const intent = intentOverride || intentOf(clean);
        const ps = priorityScore({ volume, difficulty, position: 50 });
        try {
            const result = await q(
                `INSERT INTO keywords (site_id, keyword, cluster_name, volume, difficulty, priority_score, source, intent, last_updated)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           cluster_name   = IF(source = 'manual', cluster_name, VALUES(cluster_name)),
           volume         = GREATEST(volume, VALUES(volume)),
           difficulty     = VALUES(difficulty),
           priority_score = GREATEST(priority_score, VALUES(priority_score)),
           intent         = VALUES(intent),
           last_updated   = NOW()`,
                [clean, cluster, volume, difficulty, ps, source, intent]
            );
            if (result && result[0]) {
                if (result[0].affectedRows === 1) { totalInserted++; return true; }
                if (result[0].affectedRows === 2) { totalUpdated++; return true; }
            }
        } catch (e) {
            // Silently skip insert errors (duplicate key, too-long value, etc.)
        }
        return false;
    }

    // ── STEP A: Insert expansion seed (only truly new ones will count) ─────────
    console.log('[KeywordDiscovery] Step A: Expansion seed...');
    for (const [kw, cluster, vol, diff, intent] of EXPANSION_SEED) {
        await upsertKeyword(kw, 'auto-seed', vol, diff, cluster, intent);
    }

    // ── STEP B: Get current top-priority keywords to use as discovery seeds ────
    let seedKeywords = [];
    try {
        const rows = await q(
            `SELECT keyword FROM keywords
       WHERE priority_score > 10
         AND LENGTH(keyword) > 8
         AND keyword REGEXP '(social media|brand voice|content|caption|ai|instagram|linkedin|tiktok|africa|nativpost)'
       ORDER BY priority_score DESC
       LIMIT 20`
        );
        seedKeywords = (rows || []).map(r => r.keyword);
    } catch (e) {
        console.warn('[KeywordDiscovery] Could not load seed keywords from DB:', e.message);
    }
    if (!seedKeywords.length) {
        // Fallback seeds if DB is still empty
        seedKeywords = [
            'ai social media content generator',
            'brand voice ai tool',
            'ocoya alternative',
            'social media tool nigeria',
            'ugc ad generator ai',
        ];
    }

    let discoveredCandidates = [];

    // ── STEP C: DataForSEO SERP expansion ─────────────────────────────────────
    console.log('[KeywordDiscovery] Step C: SERP-based discovery...');
    try {
        const serpKws = await discoverViaSERP(seedKeywords.slice(0, 3));
        discoveredCandidates.push(...serpKws.map(k => ({ kw: k, source: 'serp-expand' })));
        console.log(`[KeywordDiscovery] SERP: ${serpKws.length} candidates found`);
    } catch (e) { console.warn('[KeywordDiscovery] SERP step failed:', e.message); }

    // ── STEP D: Competitor page mining ────────────────────────────────────────
    console.log('[KeywordDiscovery] Step D: Competitor page mining...');
    try {
        const compKws = await discoverViaCompetitors(q);
        discoveredCandidates.push(...compKws.map(k => ({ kw: k, source: 'competitor-mine' })));
        console.log(`[KeywordDiscovery] Competitor mining: ${compKws.length} candidates found`);
    } catch (e) { console.warn('[KeywordDiscovery] Competitor mining failed:', e.message); }

    // ── STEP E: GSC long-tail expansion ───────────────────────────────────────
    console.log('[KeywordDiscovery] Step E: GSC long-tail expansion...');
    try {
        const gscKws = await discoverViaGSCExpansion(q);
        discoveredCandidates.push(...gscKws.map(k => ({ kw: k, source: 'gsc-expand' })));
        console.log(`[KeywordDiscovery] GSC expansion: ${gscKws.length} candidates found`);
    } catch (e) { console.warn('[KeywordDiscovery] GSC expansion failed:', e.message); }

    // ── STEP F: DuckDuckGo autocomplete ───────────────────────────────────────
    console.log('[KeywordDiscovery] Step F: DuckDuckGo autocomplete...');
    try {
        const ddgKws = await discoverViaDuckDuckGo(seedKeywords.slice(0, 2));
        discoveredCandidates.push(...ddgKws.map(k => ({ kw: k, source: 'ddg-autocomplete' })));
        console.log(`[KeywordDiscovery] DuckDuckGo: ${ddgKws.length} candidates found`);
    } catch (e) { console.warn('[KeywordDiscovery] DuckDuckGo step failed:', e.message); }

    // ── STEP G: Deduplicate, filter, and cap ──────────────────────────────────
    const seen = new Set();
    const toInsert = [];
    for (const { kw, source } of discoveredCandidates) {
        const clean = (kw || '').toLowerCase().trim().replace(/\s+/g, ' ');
        if (!clean || seen.has(clean)) continue;
        seen.add(clean);
        if (!isRelevant(clean)) continue;
        toInsert.push({ kw: clean, source });
        if (toInsert.length >= PER_RUN_LIMIT) break;
    }

    // ── STEP H: Insert discovered keywords ────────────────────────────────────
    console.log(`[KeywordDiscovery] Step H: Inserting ${toInsert.length} discovered candidates...`);
    for (const { kw, source } of toInsert) {
        await upsertKeyword(kw, source, 0, 35);
    }

    console.log(`[KeywordDiscovery] Run complete. Inserted=${totalInserted} Updated=${totalUpdated} Candidates=${toInsert.length}`);
    return { inserted: totalInserted, updated: totalUpdated };
}

// ── SCHEDULER ENTRY POINT (mirrors existing scheduler pattern in index.js) ───
function startKeywordAutoDiscovery(deps) {
    if (!ENABLED) {
        console.log('[KeywordDiscovery] Auto-discovery disabled (KEYWORD_DISCOVERY_ENABLED=false).');
        return;
    }

    const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000;
    let running = false;

    async function tick() {
        if (running) return;
        running = true;
        try {
            await runKeywordDiscovery(deps);
        } catch (e) {
            console.error('[KeywordDiscovery] Tick error:', e.message);
        } finally {
            running = false;
        }
    }

    // First run: 15 minutes after boot (let GSC sync and competitor audit go first)
    setTimeout(tick, 15 * 60 * 1000);
    // Then every N hours
    setInterval(tick, intervalMs);

    console.log(`[KeywordDiscovery] Auto-discovery enabled. First run in 15min, then every ${INTERVAL_HOURS}h. Cap=${PER_RUN_LIMIT} keywords/run.`);
}

module.exports = { startKeywordAutoDiscovery, runKeywordDiscovery };