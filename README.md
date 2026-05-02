# NativPost SEO Command Center v2

A **true full-feature clone** of the IGH SEO Tool, rebuilt specifically for **nativpost.com**.  
Same 6,400-line architecture — every feature ported and adapted for NativPost's market.

---

## What's in v2 (vs the earlier v1 stub)

| Feature | v1 (stub) | v2 (full clone) |
|---|---|---|
| Contentful publish pipeline | ✗ | ✅ Full publish to NativPost blog |
| Google Search Console sync | ✗ | ✅ Real GSC data for nativpost.com |
| GA4 analytics sync | ✗ | ✅ Page views, sessions, engagement |
| Password reset via email | ✗ | ✅ 6-digit code flow (Resend/SMTP2GO) |
| Article quality scoring | Basic | ✅ Full anti-slop, internal link, CTA checks |
| DataForSEO SERP | Basic | ✅ Full live SERP + PAA + related searches |
| SERP enrichment (headings/questions) | ✗ | ✅ Crawls top 8 results for structure |
| Link gap analysis | ✗ | ✅ DFS Backlinks API / sandbox mode |
| Backlink prospects | ✗ | ✅ Full prospect discovery + scoring |
| Internal link suggestions | ✗ | ✅ Auto-detects opportunities between articles |
| Press kit / image assets | ✗ | ✅ Image library with upload management |
| Article JSON-LD schema | ✗ | ✅ Auto-generates for rich results |
| Auto-publish scheduler | Stub | ✅ Full Contentful publish pipeline |
| Weekly competitor re-audit | ✗ | ✅ Background job, 30min after boot |
| Daily brief auto-generation | Basic | ✅ Full priority scoring + categories |
| API balance monitoring | ✗ | ✅ DataForSEO + OpenAI/Anthropic balance |
| Contentful article sync | ✗ | ✅ Syncs existing blog posts to local DB |
| User themes | ✗ | ✅ NativPost purple theme |

---

## Quick Start

### 1. Database setup (MariaDB on port 3307)

```bash
mysql -u root -p -P 3307 -h 127.0.0.1
```

```sql
CREATE DATABASE nativpost_seo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'nativpostseo'@'%' IDENTIFIED BY 'NativPostSEO123!';
GRANT ALL PRIVILEGES ON nativpost_seo.* TO 'nativpostseo'@'%';
FLUSH PRIVILEGES;
EXIT;
```

### 2. Clone repo and install

```bash
cd /opt/nativpost
git clone https://YOUR_TOKEN@github.com/AppexNexis/NativPost-seo.git NativPost-seo
cd NativPost-seo
npm install
cp .env.example .env.local
nano .env.local  # fill in all values
```

### 3. Add to ecosystem.config.js

```javascript
{
  name: 'nativpost-seo',
  script: 'index.js',
  cwd: '/opt/nativpost/NativPost-seo',
  env: {
    PORT: 9001,
    NODE_ENV: 'production',
    // ... all vars from .env.local
  }
}
```

### 4. Start

```bash
pm2 start /opt/nativpost/ecosystem.config.js --only nativpost-seo --update-env
pm2 logs nativpost-seo --lines 30 --nostream
pm2 save
```

### 5. Default login

```
URL:      https://seo.nativpost.com
Username: admin
Password: NativPost2026!
⚠️  Change this immediately via Settings
```

---

## What to configure first

After first login, in this order:

1. **Settings → Google** — Connect Google account for GSC data
2. **Settings → Contentful** — Test connection to NativPost Contentful space
3. **Own Site → Scan** — Crawl nativpost.com for page context
4. **Competitors** — Pre-loaded: Ocoya, Predis, Buffer, Hootsuite, Jasper, Later, FeedHive + more
5. **Keywords** — Review seeded clusters (Brand Voice, AI Social Media, Africa, etc.)
6. **Daily Brief** — Auto-generates 60 seconds after startup

---

## NativPost-specific customizations

**Article AI prompt includes:**
- Starter $19 / Growth $39 / Pro $79 / Agency $149 — hardcoded, AI cannot invent prices
- 7-day trial, 3 posts max, text only — AI cannot claim "free forever" or "30-day trial"
- Paystack for Africa — automatically mentioned for Africa-market keywords
- Anti-slop banned words: leverage, synergy, disruptive, game-changing, seamlessly
- All CTAs point to `app.nativpost.com` with "7-day free trial"

**Competitor filters:**
- Removed: game hosting brands (Nitrado, Bisect, etc.)
- Added: Ocoya, Predis, Buffer, Hootsuite, Jasper, Later, FeedHive, SocialBee, ContentStudio

**GSC keyword filters:**
- Keeps: social media, AI content, brand voice, scheduling, LinkedIn, Instagram, TikTok, Africa
- Filters out: competitor brand names (Ocoya, Buffer, etc.)

---

## Nginx config

```nginx
server {
    server_name seo.nativpost.com;
    location / {
        proxy_pass http://localhost:9001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
        client_max_body_size 10m;
    }
    listen 80;
}
```

Then: `certbot --nginx -d seo.nativpost.com`

---

## Architecture

```
NativPost SEO Tool v2 (Node.js/Express)     Port: 9001
├── index.js         6,400+ line main server (IGH clone, NativPost-adapted)
├── views/           22 EJS templates
├── public/          CSS with NativPost purple theme
├── package.json
└── .env.local       All secrets (never commit)

Database:  MariaDB port 3307 — nativpost_seo
AI:        Anthropic Claude API (primary) or OpenAI (fallback)
Publish:   Contentful CMA → nativpost.com/blog/
SERP:      DataForSEO (shared with IGH) or DuckDuckGo fallback
Analytics: Google Search Console + GA4
```
