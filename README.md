# NativPost SEO Command Center

An AI-powered SEO content engine built specifically for **nativpost.com** — mirroring the architecture of the IGH SEO Tool but tuned entirely for NativPost's market: AI social media tools, brand voice, SMBs, and the African market.

---

## What It Does

| Feature | Details |
|---|---|
| **Site crawler** | Crawls nativpost.com, indexes up to 80 pages for AI context |
| **Competitor intelligence** | Pre-loaded: Ocoya, Predis, Buffer, Hootsuite, Jasper, Later, FeedHive + auto weekly re-audit |
| **Keyword clusters** | 12 pre-seeded clusters: AI Social Media, Brand Voice, Scheduling, Video, LinkedIn, Instagram, Africa Market, Pricing, Comparisons, and more |
| **SERP lookup** | DataForSEO (paid) or DuckDuckGo (free) — cached 14 days |
| **Gap analysis** | Auto-detects keywords competitors rank for that NativPost doesn't |
| **AI article generation** | Claude (Anthropic) or GPT-4o fallback — auto-detects article type |
| **6 article types** | Comparison, Pricing Review, How-To, Africa Market, Platform Guide, General |
| **Anti-slop rules** | Bans: leverage, synergy, disruptive, game-changing, cutting-edge, robust, seamlessly |
| **Quality gate** | Score 0-100 — below threshold = Draft, above = Pending Review |
| **Article workflow** | Draft → Pending Review → Approved → Published |
| **Auto-publisher** | Publishes approved articles automatically (configurable rate) |
| **Daily brief** | Auto-generated daily list of top 5 SEO priorities |
| **Backlink tracker** | Track opportunities, mark earned, DA scoring |
| **Reports** | Pipeline stats, cluster coverage, competitor gaps, published articles |

---

## Quick Start

### 1. Prerequisites
- Node.js 18+
- MariaDB or MySQL (same VPS as your other services — already running at `69.48.201.43`)
- An Anthropic API key (same one NativPost's engine uses — `claude-opus-4-5`)

### 2. Create the database
```sql
CREATE DATABASE nativpost_seo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 3. Install dependencies
```bash
cd /opt/nativpost/NativPost-SEO-Tool   # or wherever you deploy
npm install
```

### 4. Configure environment
```bash
cp .env.example .env.local
nano .env.local   # fill in DB credentials and ANTHROPIC_API_KEY
```

**Minimum required in `.env.local`:**
```
DB_HOST=127.0.0.1
DB_USER=root
DB_PASSWORD=your-password
DB_NAME=nativpost_seo
ANTHROPIC_API_KEY=sk-ant-...
SESSION_SECRET=$(openssl rand -hex 32)
```

### 5. Start the tool
```bash
node index.js
# OR with PM2 (recommended):
pm2 start index.js --name nativpost-seo
pm2 save
```

### 6. Access the dashboard
```
http://your-server-ip:7784
```

**Default login:**
- Username: `admin`
- Password: `NativPost2026!`
- ⚠️ **Change this immediately via Settings**

---

## PM2 on the Existing VPS

Since the NativPost VPS (`69.48.201.43`) already runs PM2, add this to `/opt/nativpost/ecosystem.config.js`:

```javascript
{
  name: 'nativpost-seo',
  script: 'index.js',
  cwd: '/opt/nativpost/NativPost-SEO-Tool',
  env: {
    PORT: 7784,
    NODE_ENV: 'production',
    DB_HOST: '127.0.0.1',
    DB_PORT: 3306,
    DB_USER: 'root',
    DB_PASSWORD: 'your-db-password',
    DB_NAME: 'nativpost_seo',
    ANTHROPIC_API_KEY: 'sk-ant-...',
    SESSION_SECRET: 'your-64-char-hex',
    NATIVPOST_SITE_URL: 'https://nativpost.com',
    NATIVPOST_APP_URL: 'https://app.nativpost.com',
    MIN_QUALITY_SCORE: 90,
    AUTO_PUBLISH_ENABLED: 'false',
    AUTO_PUBLISH_DAILY_LIMIT: 1,
    DATAFORSEO_DAILY_CALL_CAP: 20,
  }
}
```

Then:
```bash
pm2 restart /opt/nativpost/ecosystem.config.js --only nativpost-seo --update-env
pm2 save
```

### Nginx Config (add to existing nginx setup)
```nginx
server {
  server_name seo.nativpost.com;   # or use an internal IP
  location / {
    proxy_pass http://localhost:7784;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 180s;   # article generation can take 60-90s
    proxy_send_timeout 180s;
    client_max_body_size 10m;
  }
}
```

Then: `certbot --nginx -d seo.nativpost.com`

---

## Workflow: How to Use It

### Week 1 — Setup
1. Login → **Own Site** → Crawl nativpost.com
2. **Competitors** → Audit all pre-loaded competitors (Ocoya, Buffer, etc.)
3. **Keywords** → Review the 12 pre-seeded clusters — add any missing keywords
4. **SERP Intel** → Look up your 10 most important keywords

### Daily workflow
1. Check **Daily Brief** — it shows your top 5 priorities each morning
2. Pick a keyword → **Content Studio** → Generate
3. Read the generated article → **Edit** if needed → **Approve**
4. Article auto-publishes when `AUTO_PUBLISH_ENABLED=true`

### Content types by keyword (auto-detected)
| Keyword contains | Article type |
|---|---|
| `vs` / `alternative` / `compare` | Head-to-head comparison with feature matrix |
| `pricing` / `cost` / `review` | Full pricing breakdown |
| `how to` / `guide` / `tutorial` | Step-by-step instructional |
| `africa` / `nigeria` / `kenya` | Africa-market localized article |
| `linkedin` / `instagram` / `tiktok` | Platform-specific strategy guide |
| anything else | Standard commercial/informational |

---

## What Makes This NativPost-Specific

**Pre-loaded knowledge:**
- NativPost pricing: Starter $19, Growth $39, Pro $79, Agency $149
- Trial: 7-day, 3 posts, text-only — never claims "free forever"
- Paystack: mentioned whenever Africa-market keywords detected
- Anti-slop banned words calibrated to NativPost's tone
- All CTAs point to `app.nativpost.com` with "7-day free trial"
- Competitor matrix pre-loaded: Ocoya, Predis, Buffer, Jasper, Later, FeedHive, Hootsuite

**12 pre-seeded keyword clusters:**
1. AI Social Media
2. Brand Voice AI ← NativPost's biggest differentiator
3. Scheduling & Publishing
4. Content Generation
5. Video Generation
6. LinkedIn Content
7. Instagram Content
8. SMB / Small Business
9. Agency
10. Africa Market ← Paystack angle
11. Competitor Comparisons (vs Ocoya, vs Buffer, etc.)
12. Pricing & Reviews

---

## Security Notes
- Default password must be changed immediately
- `SESSION_SECRET` must be rotated from the default value
- Never commit `.env.local` to git
- The tool is for internal use only — protect with nginx auth or VPN if needed

---

## Architecture
```
NativPost SEO Tool (Node.js/Express)     Port: 7784
├── index.js          Main server (routes + AI generation + crawlers)
├── views/            EJS templates (dashboard, articles, competitors, etc.)
├── package.json
└── .env.local        All secrets (not committed to git)

Database: MariaDB — nativpost_seo
AI: Anthropic Claude API (same model as NativPost content engine)
SERP: DataForSEO (optional) or DuckDuckGo fallback
```

Built with the same architecture as the IGH SEO Tool — same patterns, same reliability, tuned for NativPost's market and brand.
