require('dotenv').config({ path: require('path').join(__dirname, '.env.local'), override: true });
// Safety shim for legacy template fragments.
global.i = 0;

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
function contentfulErrorDetails(data) {
  try {
    const parts = [];
    if (data?.message) parts.push(data.message);
    const errors = data?.details?.errors;
    if (Array.isArray(errors) && errors.length) {
      for (const e of errors.slice(0, 12)) {
        const path = Array.isArray(e.path) ? e.path.join('.') : (e.path || '');
        const name = e.name || e.type || e.details || 'error';
        const value = e.value !== undefined ? (' value=' + JSON.stringify(e.value).slice(0, 160)) : '';
        parts.push([path, name + value].filter(Boolean).join(' -> '));
      }
    }
    if (parts.length) return parts.join(' | ').slice(0, 1800);
    if (data?.sys?.id) return data.sys.id;
    if (typeof data === 'string') return data.slice(0, 1000);
    return JSON.stringify(data).slice(0, 1000);
  } catch (_) {
    return 'Unable to parse Contentful error details';
  }
}
axios.interceptors.response.use(
  response => response,
  error => {
    const status = error?.response?.status;
    const data = error?.response?.data;
    const requestId = error?.response?.headers?.['x-contentful-request-id'];
    const url = error?.config?.url || '';
    if (String(url).includes('contentful.com')) {
      let details = contentfulErrorDetails(data);
      if (status === 401) {
        error.message = 'Contentful 401 unauthorized. The app is reaching Contentful, but the Management API token being used is invalid, expired, revoked, or not authorized for this space/environment. Regenerate a Contentful Management API token and place it in CONTENTFUL_CMA_TOKEN in .env.local, then fully restart the AMP instance.' + (requestId ? ' Request ID: ' + requestId : '');
      } else {
        error.message = 'Contentful request failed' + (status ? ' with status ' + status : '') + (details ? ': ' + details : '') + (requestId ? ' Request ID: ' + requestId : '');
      }
    }
    return Promise.reject(error);
  }
);
const mysql = require('mysql2/promise');
const multer = require('multer');

const app = express();
const ENV_FILE_PATH = require('path').join(__dirname, '.env.local');
console.log('NativPost SEO Tool env loaded from ' + ENV_FILE_PATH + ' | Contentful space=' + (process.env.CONTENTFUL_SPACE_ID || 'missing') + ' | env=' + (process.env.CONTENTFUL_ENVIRONMENT_ID || 'master') + ' | content type=' + (process.env.CONTENTFUL_BLOG_CONTENT_TYPE_ID || process.env.CONTENTFUL_CONTENT_TYPE || 'missing') + ' | CMA token=' + (process.env.CONTENTFUL_CMA_TOKEN ? 'present' : 'missing'));
const PORT = Number(process.env.PORT || 9001);
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'America/Denver';

// CRAWL_BASE_URL: Override the domain used when crawling your own site.
// Useful when the public domain isn't live yet, or when the SEO tool and website
// are on the same machine and you want to crawl via internal address.
// Example: CRAWL_BASE_URL=http://localhost:3000
// Leave blank to crawl the public site URL normally (correct once site is live).
const CRAWL_BASE_URL = (process.env.CRAWL_BASE_URL || '').trim().replace(/\/$/, '');
process.env.TZ = APP_TIMEZONE;
const AUTO_PUBLISH_ENABLED = String(process.env.AUTO_PUBLISH_ENABLED || 'true').toLowerCase() !== 'false';
const AUTO_PUBLISH_INTERVAL_MINUTES = Math.max(1, Number(process.env.AUTO_PUBLISH_INTERVAL_MINUTES || 10));
const AUTO_PUBLISH_DAILY_LIMIT = Math.max(1, Number(process.env.AUTO_PUBLISH_DAILY_LIMIT || 1));
const MIN_QUALITY_SCORE = Math.max(1, Number(process.env.ADAPTIFY_MIN_QUALITY_SCORE || process.env.MIN_QUALITY_SCORE || 85));

// ── DataForSEO ─────────────────────────────────────────────────────────────────
const DFS_ENABLED = String(process.env.DATAFORSEO_ENABLED || 'true').toLowerCase() !== 'false'
  && !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN || '';
const DFS_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';
const DFS_LOCATION = Number(process.env.DATAFORSEO_LOCATION_CODE || 2840);
const DFS_LANGUAGE = process.env.DATAFORSEO_LANGUAGE_CODE || 'en';
const DFS_DEVICE = process.env.DATAFORSEO_DEVICE || 'desktop';
const DFS_MAX_RESULTS = Math.min(20, Math.max(5, Number(process.env.DATAFORSEO_MAX_RESULTS || 10)));
const DFS_CACHE_DAYS = Math.max(1, Number(process.env.DATAFORSEO_CACHE_DAYS || 14));
// ──────────────────────────────────────────────────────────────────────────────

// ── DataForSEO cost protection ──────────────────────────────────────────────
// Hard daily cap on live DFS API calls (not cache hits). Resets at midnight.
// At ~$0.0025/SERP call, 20 calls/day = ~$0.05/day = well within $5 trial.
const DFS_DAILY_CALL_CAP = Math.max(1, Number(process.env.DATAFORSEO_DAILY_CALL_CAP || 20));
let _dfsDailyCallCount = 0;
let _dfsDayKey = '';
function dfsCallAllowed() {
  const today = new Date().toISOString().slice(0, 10);
  if (_dfsDayKey !== today) { _dfsDayKey = today; _dfsDailyCallCount = 0; }
  if (_dfsDailyCallCount >= DFS_DAILY_CALL_CAP) {
    console.warn(`[DFS] Daily call cap (${DFS_DAILY_CALL_CAP}) reached. Falling back to DuckDuckGo or cache. Reset tomorrow.`);
    return false;
  }
  return true;
}
function dfsCallUsed() { _dfsDailyCallCount++; }
// ────────────────────────────────────────────────────────────────────────────

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // Trust nginx X-Forwarded-Proto for HTTPS detection

// ── AUTHENTICATION SYSTEM ──────────────────────────────────────────────────
// Session store in MySQL. Passwords hashed with crypto.scrypt (no external deps).

const SESSION_SECRET = process.env.SESSION_SECRET || 'nativpost-seo-secret-2026-change-me';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
if (SESSION_SECRET === 'nativpost-seo-secret-2026-change-me') {
  console.warn('⚠️  SESSION_SECRET is the built-in default. Rotate it before production use:');
  console.warn('   Generate one with: openssl rand -hex 32');
  console.warn('   Then set SESSION_SECRET=<value> in .env.local');
}

async function ensureAuthTables() {
  // NativPost: game_facts and live_games tables removed — NativPost is not a game hosting service.
  await execSafe(`CREATE TABLE IF NOT EXISTS auth_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(120) NOT NULL UNIQUE,
    email VARCHAR(255) NULL,
    password_hash VARCHAR(255) NOT NULL,
    salt VARCHAR(64) NOT NULL,
    role VARCHAR(40) DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await execSafe(`CREATE TABLE IF NOT EXISTS auth_sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id INT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await execSafe(`CREATE TABLE IF NOT EXISTS auth_reset_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(64) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    used TINYINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  // Seed default admin if no users exist
  const userCount = await one('SELECT COUNT(*) cnt FROM auth_users').catch(() => ({ cnt: 0 }));
  if (!userCount || Number(userCount.cnt) === 0) {
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = await hashPassword('NativPost2026!', salt);
    await q('INSERT INTO auth_users (username,email,password_hash,salt,role) VALUES (?,?,?,?,?)',
      ['admin', 'admin@nativpost.com', hash, salt, 'admin']).catch(() => { });
    console.log('[Auth] Default admin user created');
  }
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
    const session = await one('SELECT s.*, u.id user_id, u.username, u.email, u.role FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at > NOW()', [sid]);
    return session || null;
  } catch (e) { return null; }
}

// Auth middleware - protects all routes except /login and /auth/*
async function requireAuth(req, res, next) {
  const publicPaths = ['/login', '/auth/login', '/auth/logout', '/auth/reset-password', '/auth/do-reset', '/auth/forgot-password', '/auth/verify-reset-code', '/static', '/uploads'];
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


app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.json({ limit: '25mb' }));
app.use('/static', express.static(path.join(__dirname, 'public')));
const legacyUploadDir = path.join(__dirname, 'public', 'uploads');
const uploadDir = process.env.SEO_UPLOAD_DIR || path.resolve(__dirname, '..', 'SEOApp_uploads');
fs.mkdirSync(uploadDir, { recursive: true });
try {
  if (fs.existsSync(legacyUploadDir)) {
    for (const file of fs.readdirSync(legacyUploadDir)) {
      const src = path.join(legacyUploadDir, file);
      const dest = path.join(uploadDir, file);
      if (fs.statSync(src).isFile() && !fs.existsSync(dest)) fs.copyFileSync(src, dest);
    }
  }
} catch (e) { console.warn('Upload migration warning:', e.message); }
app.use('/uploads', express.static(uploadDir));
const upload = multer({ dest: uploadDir, limits: { fileSize: 8 * 1024 * 1024 } });

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'seoapp',
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  multipleStatements: false
});

// STOPWORDS: generic filler words only. DO NOT add SEO-relevant words like game/hosting/server/support/pricing.
const STOPWORDS = new Set('the and for with from your this that into about what when where why how over under near more have has was were use using our you can not are but all any get just like blog panel node amp play xbox ps5 windows linux content article rank seo title meta review publish queue dashboard keyword keywords competitor competitors backlinks page click learn also their there they them will would could should only very been much make makes than then each out off see seen initial website inventory being sorted everything ready soon available includes choosing need needs upgrade upgraded upgrading started getting looking great good better perfect ideal built-for designed optimized-for powered-by backed-by trusted-by loved used-by joined played-by running allows allowing provides providing offers offering supports supporting enables enabling ensures ensuring delivers delivering'.split(' '));
const GAME_ALIASES = [
  { key: 'palworld', label: 'Palworld', patterns: ['palworld'] },
  { key: 'minecraft', label: 'Minecraft', patterns: ['minecraft', 'minecraft java', 'minecraft bedrock'] },
  { key: 'ark', label: 'ARK / ARK Survival Ascended', patterns: ['ark', 'ark survival ascended', 'asa', 'ark sa'] },
  { key: 'rust', label: 'Rust', patterns: ['rust'] },
  { key: 'valheim', label: 'Valheim', patterns: ['valheim'] },
  { key: 'enshrouded', label: 'Enshrouded', patterns: ['enshrouded'] },
  { key: 'everwind', label: 'Everwind', patterns: ['everwind'] },
  { key: 'windrose', label: 'Windrose', patterns: ['windrose'] },
  { key: 'icarus', label: 'Icarus', patterns: ['icarus'] },
  { key: 'hytale', label: 'Hytale', patterns: ['hytale'] },
  { key: 'terraria', label: 'Terraria', patterns: ['terraria'] },
  { key: 'v rising', label: 'V Rising', patterns: ['v rising', 'vrising', 'v-rising'] },
  { key: 'project zomboid', label: 'Project Zomboid', patterns: ['project zomboid', 'zomboid'] },
  { key: 'dayz', label: 'DayZ', patterns: ['dayz', 'day z'] },
  { key: 'satisfactory', label: 'Satisfactory', patterns: ['satisfactory'] },
  { key: 'factorio', label: 'Factorio', patterns: ['factorio'] },
  { key: 'conan', label: 'Conan Exiles', patterns: ['conan', 'conan exiles'] },
  { key: '7 days to die', label: '7 Days to Die', patterns: ['7 days to die', '7dtd', 'seven days to die', 'seven-days-to-die'] },
  { key: 'voyagers of nera', label: 'Voyagers of Nera', patterns: ['voyagers of nera', 'voyagers-of-nera', 'voyagers nera'] },
  { key: 'space engineers', label: 'Space Engineers', patterns: ['space engineers'] },
  { key: 'eco', label: 'Eco', patterns: ['eco global survival', 'eco server'] },
  { key: 'ground branch', label: 'Ground Branch', patterns: ['ground branch'] },
  { key: 'sons of the forest', label: 'Sons of the Forest', patterns: ['sons of the forest', 'sons of forest'] },
  { key: 'the forest', label: 'The Forest', patterns: ['the forest server'] },
  { key: 'green hell', label: 'Green Hell', patterns: ['green hell'] },
  { key: 'core keeper', label: 'Core Keeper', patterns: ['core keeper'] },
];
const PRESS_KIT_SEEDS = {
  palworld: ['https://www.igdb.com/games/palworld/presskit', 'https://www.pocketpair.jp/en/games-en/palworld-en/', 'https://store.steampowered.com/app/1623730/Palworld/', 'https://steamdb.info/app/1623730/screenshots/'],
  everwind: ['https://everwind.net/', 'https://press.levelinfinite.com/Everwind'],
  windrose: [
    'https://store.steampowered.com/app/3041230/Windrose/',
    'https://steamdb.info/app/3041230/screenshots/',
    'https://playwindrose.com/',
    'https://playwindrose.com/media',
    'https://playwindrose.com/press',
    'https://www.igdb.com/games/windrose/presskit',
    'https://cdn.akamai.steamstatic.com/steam/apps/3041230/ss_1.jpg',
  ],
  valheim: ['https://www.valheimgame.com/press/', 'https://www.valheimgame.com/', 'https://store.steampowered.com/app/892970/Valheim/', 'https://steamdb.info/app/892970/screenshots/'],
  rust: ['https://facepunch.com/games/rust', 'https://rust.double11.com/press-kit'],
  minecraft: [
    'https://www.igdb.com/games/minecraft--1/presskit#images',
    'https://images.igdb.com/igdb/image/upload/t_720p/sc8d2m.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/sc8d2k.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/sc8d2n.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/sc8d2p.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/sc8d2o.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/sc8d2s.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/sc8d2q.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/sc10jch.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/sc10jcg.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/scz1fr.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/scz1fs.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/scz1ft.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/ar4nm5.png',
    'https://images.igdb.com/igdb/image/upload/t_720p/ar4nm4.png',
    'https://www.minecraft.net/en-us/collectibles',
    'https://www.minecraft.net/content/dam/minecraftnet/games/minecraft/key-art/Vanilla_bundle_2.png',
    'https://www.minecraft.net/content/dam/minecraftnet/games/minecraft/key-art/Vanilla_bundle_3.png',
    'https://www.minecraft.net/content/dam/minecraftnet/games/minecraft/key-art/Vanilla_bundle_1.png',
    'https://www.minecraft.net/content/dam/minecraftnet/community/events/cy2025/sandstorm/Wallpapers_Carousel_MCM-Vista_1110x624.jpg',
    'https://www.minecraft.net/content/dam/minecraftnet/games/minecraft/key-art/MC-Downloadables_Image-0_15th-Anniversary_1110x624.jpg',
    'https://www.minecraft.net/en-us',
    'https://www.minecraft.net/en-us/articles',
    'https://www.minecraft.net/en-us/usage-guidelines'
  ],
  ark: ['https://survivetheark.com/index.php?/media/'],
  enshrouded: ['https://enshrouded.zendesk.com/hc/en-us/articles/9295794827805-Press-Kit', 'https://www.igdb.com/games/enshrouded/presskit', 'https://www.terminals.io/games/enshrouded', 'https://enshrouded.com/', 'https://store.steampowered.com/app/1203620/Enshrouded/', 'https://steamdb.info/app/1203620/screenshots/'],
  dayz: ['https://dayz.com/presskit'],
  satisfactory: ['https://www.satisfactorygame.com/presskit'],
  icarus: ['https://store.steampowered.com/app/1149460/ICARUS/', 'https://steamdb.info/app/1149460/screenshots/', 'https://icarus.fandom.com/wiki/Social_media', 'https://www.igdb.com/games/icarus/presskit'],
  hytale: ['https://hytale.com/media', 'https://hytale.com/community', 'https://www.igdb.com/games/hytale/presskit'],
  'v rising': ['https://press.stunlock.com/category/vrising/', 'https://press.stunlock.com/v-rising-new-info-screenshots/', 'https://playvrising.com/', 'https://store.steampowered.com/app/1604030/V_Rising/', 'https://steamdb.info/app/1604030/screenshots/'],
  factorio: ['https://www.factorio.com/presskit'],
  terraria: ['https://terraria.org/media-kit'],
  conan: ['https://www.conanexiles.com/media/']
};
// Steam App ID map for direct screenshot API access
const STEAM_APP_IDS = {
  windrose: '3041230',
  palworld: '1623730',
  valheim: '892970',
  enshrouded: '1203620',
  'v rising': '1604030',
  icarus: '1149460',
  dayz: '221100',
  rust: '252490',
  'project zomboid': '108600',
  satisfactory: '526870',
  'conan': '440900',
  ark: '2399830',
  terraria: '105600',
  minecraft: null, // not on Steam
  hytale: null,    // not released
};

// Fetch real screenshots from Steam API (no JS required, returns JSON)
async function fetchSteamScreenshots(appId, game = '', limit = 6) {
  if (!appId) return [];
  try {
    const resp = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=screenshots`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NativPostSEOBot/1.0)' }
    });
    const data = resp.data?.[appId];
    if (!data?.success) return [];
    const screenshots = (data.data?.screenshots || []).slice(0, limit);
    return screenshots.map(s => ({
      url: s.path_full || s.path_thumbnail,
      alt: `${gameDisplay(game)} server screenshot`,
      label: `${gameDisplay(game)} Steam screenshot`,
      sourcePage: `https://store.steampowered.com/app/${appId}/`,
      sourceTitle: `${gameDisplay(game)} on Steam`,
      score: 90
    }));
  } catch (e) {
    console.log(`Steam API for ${game} (${appId}):`, e.message);
    return [];
  }
}

const DEFAULT_NP_SUPPORTED_GAMES = new Set(String(process.env.SUPPORTED_GAMES_EXACT || process.env.MANUAL_SUPPORTED_GAMES || '').split(',').map(x => x.trim()).filter(Boolean).map(x => detectGame(x) || normalizeGameName(x)));
const USE_LEGACY_SUPPORTED_GAMES_ENV = String(process.env.USE_LEGACY_SUPPORTED_GAMES_ENV || '').toLowerCase() === 'true';
const BUSINESS_FACTS = process.env.NATIVPOST_BUSINESS_FACTS || 'NativPost is an AI social media content platform. Brands define their voice once and NativPost generates posts across 9 platforms. Plans: Starter $19/mo (15 posts, 3 platforms), Growth $39/mo (40 posts, 6 platforms, video), Pro $79/mo (80 posts, unlimited platforms), Agency $149/mo (unlimited, 5 brand profiles). $5 setup fee on all plans. 7-day free trial (3 posts max, text only). Paystack for Africa. Anti-slop filter scores 0-1, auto-rejects below 0.7. Content modes: Normal, Concise, Controversial. Platforms: Instagram, Facebook, LinkedIn, Twitter/X, TikTok, Pinterest, YouTube, Threads, LinkedIn Pages. Video: Slideshow, Text Motion Card, Voiceover Slideshow, UGC Ad, Data Story. NEVER claim: free forever plan, unlimited posts on Starter, 30-day trial, money-back guarantee.'; const NP_MIN_PRICE = Number(process.env.NATIVPOST_MIN_PRICE || 19);
const NP_BASE_PLAN_PRICE = process.env.NATIVPOST_BASE_PLAN_PRICE || '$19/month (Starter)';
const NP_TRIAL_DAYS = Number(process.env.NATIVPOST_TRIAL_DAYS || 7);
const NP_REFUND_POLICY = process.env.NATIVPOST_REFUND_POLICY || 'NativPost offers a 7-day free trial with 3 posts max (text only). There is no money-back guarantee. Do not claim refunds.';
const NP_PACKAGE_RULES = process.env.NATIVPOST_PACKAGE_RULES || 'Starter $19/mo (20 posts, 3 platforms, $29 setup) / Growth $49/mo (40 posts, 5 platforms, $79 setup) / Pro $99/mo (80 posts, all platforms, team review, $149 setup) / Enterprise custom. 7-day free trial (3 posts max, text only). Source: nativpost.com/pricing';
const GAME_WORDS = GAME_ALIASES.map(g => g.key);
function gameDisplay(game = '') { const g = GAME_ALIASES.find(x => x.key === String(game).toLowerCase()); return g?.label || String(game || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); }
function gameKeywordName(game = '') { const key = String(game || '').toLowerCase(); if (key === 'ark') return 'ark survival ascended'; return gameDisplay(game).toLowerCase().replace(/\s*\/.*$/, '').trim(); }
function normalizeGameName(value = '') { return String(value || '').toLowerCase().replace(/server hosting|dedicated server|\bgame\b/g, ' ').replace(/[^a-z0-9\s-]/g, ' ').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim(); } // NativPost: keeps 'social media', 'content' etc
function gameFromGameUrl(url = '') { try { const u = new URL(normalizeUrl(url)); const m = u.pathname.toLowerCase().match(/\/game\/([^/?#]+)/); if (!m) return ''; let slug = m[1].replace(/-server-hosting.*$/, '').replace(/-hosting.*$/, '').replace(/-/g, ' ').trim(); return detectGame(slug) || normalizeGameName(slug); } catch { return ''; } }
function looksLikeOwnGameUrl(url = '') {
  try {
    const u = new URL(normalizeUrl(url));
    const p = u.pathname.toLowerCase();
    // Accept /game/[anything] OR /games/[anything] with any trailing path
    if (/\/games?\/[^/]+/.test(p)) return true;
    // Also accept product/slug patterns that contain known game names
    const gameInUrl = GAME_ALIASES.some(g => g.patterns.some(pat => p.includes(pat.toLowerCase().replace(/\s+/g, '-')) || p.includes(pat.toLowerCase().replace(/\s+/g, '_'))));
    if (gameInUrl && /hosting|server/.test(p)) return true;
    return false;
  } catch { return false; }
}
function pageLooksLikeAvailableGameHosting(html = '', url = '') {
  const t = String(html || '').toLowerCase().replace(/\s+/g, ' ');
  const u = String(url || '').toLowerCase();
  // Must be a game-related page
  const isGamePage = /\/games?\//.test(u) || GAME_ALIASES.some(g => g.patterns.some(p => u.includes(p.toLowerCase().replace(/\s+/g, '-'))));
  if (!isGamePage) return false;
  // Hard block: page explicitly says not available
  if (/coming soon|not available|unavailable|unsupported|not currently offered/.test(t)) return false;
  // Positive signal: buy/deploy/order language
  return /free trial|start now|get started|starting at|\$\d+|buy now|select plan|choose plan|per month|\/mo\b|subscribe|sign up/.test(t);
}
async function discoverSupportedGamesFromGamesPage(siteUrl = '') {
  const supported = new Set();
  try {
    const base = originOf(siteUrl || 'https://nativpost.com');
    const crawlBase = originOf(resolveCrawlUrl(base));
    const { html } = await fetchUrl(crawlBase + '/games', 12000);

    // Strategy 1: Follow game page links
    const links = [...new Set(extractLinks(html, base + '/games').filter(looksLikeOwnGameUrl))];
    for (const link of links) {
      const g = gameFromGameUrl(link) || detectGame(link);
      if (!g) continue;
      try {
        const pg = await fetchUrl(link, 10000);
        if (pageLooksLikeAvailableGameHosting(pg.html, link)) supported.add(g);
      } catch (e) {
        // If we can't fetch the individual page but the link looks valid, trust it
        if (g) supported.add(g);
      }
    }

    // Strategy 2: Scan the /games page HTML for known game names in tiles/cards/headings
    // This catches JS-heavy pages where links weren't extracted but game names appear in HTML
    if (supported.size === 0) {
      const textContent = html.toLowerCase();
      for (const game of GAME_ALIASES) {
        for (const pat of game.patterns) {
          if (textContent.includes(pat.toLowerCase())) {
            // Only add if page doesn't say "coming soon" near this game name
            const idx = textContent.indexOf(pat.toLowerCase());
            const nearby = textContent.slice(Math.max(0, idx - 200), idx + 300);
            if (!/coming soon|not available|unavailable/.test(nearby)) {
              supported.add(game.key);
              break;
            }
          }
        }
      }
    }
  } catch (e) { console.log('[GameDetect] /games page fetch failed:', e.message); }
  return supported;
}
function explicitSupportedGamesFromEnv() { const out = new Set(DEFAULT_NP_SUPPORTED_GAMES); if (USE_LEGACY_SUPPORTED_GAMES_ENV) { for (const x of String(process.env.KNOWN_NP_SUPPORTED_GAMES || process.env.SUPPORTED_GAMES || '').split(',')) { const v = x.trim(); if (v) out.add(detectGame(v) || normalizeGameName(v)); } } return out; }
function ownGamePageSignal(page = {}) { return false; } // NativPost: no game pages to signal


function dbSafeText(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  return value
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
function dbSafeParams(params = []) {
  return params.map(v => {
    if (typeof v === 'string') return dbSafeText(v);
    if (Array.isArray(v)) return dbSafeParams(v);
    return v;
  });
}


function offerFactsText() {
  return [
    BUSINESS_FACTS,
    `Trial: NativPost offers a ${NP_TRIAL_DAYS}-day free trial with 3 posts maximum (text only). Do not claim unlimited posts, free forever plan, or 30-day trial.`,
    `NativPost plan pricing: ${NP_PACKAGE_RULES}`,
    `Refund/trial policy: ${NP_REFUND_POLICY}`,
    'Accuracy rule: never invent plan features, refund terms, pricing, or capabilities not listed in the NativPost business facts above.'
  ].join('\n');
}
function forbiddenOfferClaims(text = '') {
  const t = String(text || '').toLowerCase();
  const issues = [];
  // NativPost: no RAM package validation needed
  if (/30\s*[- ]?day\s+(money\s*back|refund|guarantee)/.test(t) || /money\s*back\s*guarantee/.test(t)) issues.push('mentions money-back/refund guarantee');
  if (/\brefunds?\b/.test(t) && !/does not (advertise |offer )?refund/.test(t)) issues.push('mentions refunds in a way that may be inaccurate');
  return issues;
}
function repairOfferClaims(text = '') {
  let out = String(text || '');
  // NativPost: no RAM replacement rules needed
  out = out.replace(/30\s*[- ]?day\s+money\s*[- ]?back\s+guarantee/gi, `${NP_TRIAL_DAYS}-day free trial`);
  out = out.replace(/30\s*[- ]?day\s+refund\s+guarantee/gi, `${NP_TRIAL_DAYS}-day free trial`);
  out = out.replace(/money\s*[- ]?back\s+guarantee/gi, `${NP_TRIAL_DAYS}-day free trial`);
  return out;
}
function offerReviewNote(text = '') {
  const issues = forbiddenOfferClaims(text);
  if (!issues.length) return '';
  return `Offer accuracy repaired/needs review: ${issues.join('; ')}. Current offer facts: ${offerFactsText()}`;
}
async function scannedOfferFacts(siteId = null) {
  try {
    const rows = await q("SELECT page_url,page_title,meta_description,h1_text,word_count FROM site_pages WHERE (? IS NULL OR site_id<=>?) AND (page_url LIKE '%/pricing%' OR page_url LIKE '%/features%' OR page_url LIKE '%/blog%' OR page_url LIKE '%/about%' OR page_url LIKE '%/plans%' OR word_count > 200) ORDER BY word_count DESC LIMIT 30", [siteId, siteId]);
    return rows.map(r => `${r.page_title || 'NativPost page'} | ${r.page_url} | ${r.meta_description || ''}`).join('\n').slice(0, 6000);
  } catch { return ''; }
}

function today() { return new Date().toISOString().slice(0, 10); }
function truncate(s = '', n = 255) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) : s; }

function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function inlineMarkdown(s) {
  let out = escapeHtml(s);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a target="_blank" rel="noopener" href="$2">$1</a>');
  return out;
}
function markdownToHtml(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let html = '', inList = false, inOl = false, inTable = false, tableRows = [], para = [];
  const flushPara = () => { if (para.length) { html += '<p>' + inlineMarkdown(para.join(' ')) + '</p>\n'; para = []; } };
  const closeLists = () => { if (inList) { html += '</ul>\n'; inList = false; } if (inOl) { html += '</ol>\n'; inOl = false; } };
  const flushTable = () => {
    if (!tableRows.length) return;
    let t = '<table class="md-table">\n';
    tableRows.forEach((row, i) => {
      const cells = row.split('|').map(c => c.trim()).filter((_, ci, a) => ci > 0 && ci < a.length - 1);
      const isHeader = i === 0;
      const isSep = cells.every(c => /^[-:]+$/.test(c));
      if (isSep) { return; }
      const tag = isHeader ? 'th' : 'td';
      t += '<tr>' + cells.map(c => '<' + tag + '>' + inlineMarkdown(c) + '</' + tag + '>').join('') + '</tr>\n';
    });
    t += '</table>\n';
    html += t;
    tableRows = [];
    inTable = false;
  };
  for (const raw of lines) {
    const line = raw.trim();
    // Table detection
    if (line.startsWith('|') && line.endsWith('|')) {
      flushPara(); closeLists();
      inTable = true; tableRows.push(line); continue;
    }
    if (inTable) { flushTable(); }
    if (!line) { flushPara(); closeLists(); continue; }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) { flushPara(); closeLists(); const level = Math.min(6, h[1].length); html += '<h' + level + '>' + inlineMarkdown(h[2]) + '</h' + level + '>\n'; continue; }
    const ul = line.match(/^[-*]\s+(.+)$/);
    if (ul) { flushPara(); if (inOl) { html += '</ol>\n'; inOl = false; } if (!inList) { html += '<ul>\n'; inList = true; } html += '<li>' + inlineMarkdown(ul[1]) + '</li>\n'; continue; }
    const ol = line.match(/^\d+[.)]\s+(.+)$/);
    if (ol) { flushPara(); if (inList) { html += '</ul>\n'; inList = false; } if (!inOl) { html += '<ol>\n'; inOl = true; } html += '<li>' + inlineMarkdown(ol[1]) + '</li>\n'; continue; }
    para.push(line);
  }
  flushPara(); closeLists(); flushTable();
  return html;
}

function articlePreviewHtml(article = {}) {
  const img = normalizeImageUrl(article.featured_image_url || '');
  const body = markdownToHtml(article.body || article.content || '');
  const site = article.site_name || 'NativPost';
  const imageBlock = img ? `<img class="hero-img" src="${escapeHtml(img)}" alt="${escapeHtml(article.featured_image_alt || '')}" onerror="this.replaceWith(Object.assign(document.createElement('p'),{className:'empty',textContent:'Saved image file was not found. Re-upload the image from Edit Draft.'}))">` : '<p class="empty">No image selected.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(article.title || 'Article')}</title><link rel="stylesheet" href="/static/styles.css"><style>.sidebar{width:220px;flex-shrink:0;position:fixed;inset:0 auto 0 0;background:linear-gradient(180deg,#080a0d,#070810);border-right:1px solid rgba(134,79,254,.15);display:flex;flex-direction:column;z-index:10;overflow-y:auto}.sidebar::before{content:'';position:fixed;left:0;top:0;width:220px;height:3px;background:linear-gradient(90deg,transparent,#864FFE 40%,#22CFCF 60%,transparent);z-index:11}.main{margin-left:220px;width:calc(100% - 220px);padding:2rem}.brand{display:flex;align-items:center;gap:10px;padding:18px 16px 14px;border-bottom:1px solid rgba(134,79,254,.12)}.logo{width:32px;height:36px;border-radius:50%;background:#1A1A1C;display:grid;place-items:center;font-weight:900;font-size:10px;color:#fff;box-shadow:0 0 18px rgba(134,79,254,.35)}.brand-text strong{color:#fff;font-weight:800;font-size:13px;letter-spacing:.06em;text-transform:uppercase;display:block}.brand-text span{color:#864FFE;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.2em;opacity:.8}nav{padding:8px 10px;display:flex;flex-direction:column;gap:1px}nav a{color:rgba(165,176,184,.75);padding:6px 10px;border-radius:6px;font-size:12px;font-weight:500;display:block;border:1px solid transparent;transition:all .15s}nav a:hover{color:#e6ecee;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.06)}nav a.active{color:#864FFE;background:linear-gradient(135deg,rgba(134,79,254,.12),rgba(134,79,254,.06));border-color:rgba(134,79,254,.2);font-weight:600}.nav-section{margin:12px 0 3px;padding:0 8px;display:flex;align-items:center;gap:6px}.nav-section-line{flex:1;height:1px;background:linear-gradient(90deg,rgba(134,79,254,.25),rgba(134,79,254,.06))}.nav-section-label{font-size:9px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#864FFE;opacity:.7;white-space:nowrap}</style></head><body><div class="app"><aside class="sidebar"><div class="brand"><div class="logo">NP</div><div class="brand-text"><strong>NativPost</strong><span>NativPost SEO</span></div></div><nav><div class="nav-section"><span class="nav-section-label">Overview</span><span class="nav-section-line"></span></div><a href="/">Dashboard</a><a href="/reports">Reports</a><div class="nav-section"><span class="nav-section-label">Content</span><span class="nav-section-line"></span></div><a href="/content-studio">Content Studio</a><a class="active" href="/articles">Drafts &amp; Articles</a><a href="/review">Review Queue</a><a href="/publish">Publish Queue</a><div class="nav-section"><span class="nav-section-label">Research</span><span class="nav-section-line"></span></div><a href="/sites">Own Sites</a><a href="/competitors">Competitors</a><a href="/keywords">Keywords</a><a href="/serp">SERP Intelligence</a><div class="nav-section"><span class="nav-section-label">System</span><span class="nav-section-line"></span></div><a href="/settings">Settings</a><</nav></aside><main class="main"><section class="hero"><div><p class="eyebrow">${escapeHtml(article.status || 'draft')} article · quality ${escapeHtml(article.quality_score || 0)}</p><h1>${escapeHtml(article.title || 'Untitled')}</h1><p>${escapeHtml(article.primary_keyword || 'No keyword')} · ${escapeHtml(site)}</p></div><div class="actions"><a class="btn primary" href="/articles/${article.id}/edit">Edit Draft</a><form method="post" action="/articles/${article.id}/status"><button name="status" value="review" class="btn">Review</button></form><form method="post" action="/articles/${article.id}/status"><button name="status" value="approved" class="btn">Approve</button></form><form method="post" action="/articles/${article.id}/status"><button name="status" value="queued" class="btn">Queue</button></form></div></section><div class="grid two"><section class="card"><h2>SEO fields</h2><div class="metric-row"><strong>Slug</strong><span>${escapeHtml(article.slug || '')}</span></div><div class="metric-row"><strong>Meta title</strong><span>${escapeHtml(article.meta_title || '')}</span></div><div class="metric-row"><strong>Meta description</strong><span>${escapeHtml(article.meta_description || '')}</span></div><div class="metric-row"><strong>Image alt</strong><span>${escapeHtml(article.featured_image_alt || '')}</span></div><div class="metric-row"><strong>Published URL</strong><span>${article.published_url ? `<a target="_blank" href="${escapeHtml(article.published_url)}">${escapeHtml(article.published_url)}</a>` : 'Not published'}</span></div></section><section class="card"><h2>Featured image</h2>${imageBlock}</section></div><section class="card article-preview"><h2>Article body</h2><div class="rendered-article">${body}</div></section><section class="card danger-zone"><h2>Actions</h2><div class="actions"><form method="post" action="/publish/${article.id}"><input name="published_url" placeholder="Optional published URL"><button class="btn">Mark Published</button></form><form method="post" action="/articles/${article.id}/delete" onsubmit="return confirm('Delete this article?')"><button class="btn danger">Delete</button></form></div></section></main></div></body></html>`;
}

function bodyForPublishing(article) {
  const format = String(process.env.PUBLISH_BODY_FORMAT || 'html').toLowerCase();
  const body = article.body || article.content || '';
  if (format === 'markdown') return body;
  const html = markdownToHtml(body);
  // Embed JSON-LD inline so the schema ships with the article even when the
  // CMS has no dedicated JSON-LD field. Safe — Google parses script[type=ld+json]
  // anywhere in the document and most Contentful HTML renderers pass it through.
  if (String(process.env.EMBED_JSONLD_IN_BODY || 'true').toLowerCase() !== 'false') {
    const schemaJson = article.schema_json || buildArticleSchema(article);
    const tag = inlineJsonLdScript(schemaJson);
    if (tag) return tag + '\n' + html;
  }
  return html;
}

function slugify(input = '') { return String(input).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 180) || `article-${Date.now()}`; }
function safeArticleTitle(value, fallback = 'Untitled SEO Article') {
  let cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  // Strip competitor brand names from titles — they must never appear in NativPost article titles
  const competitorBrands = ['game host bros', 'gamehostbros', 'nitrado', 'gportal', 'g-portal',
    'shockbyte', 'bisecthosting', 'bisect hosting', 'hosthavoc', 'apexhosting', 'apex hosting',
    'scalacube', 'nodecraft', 'sparkedhost', 'sparked host', 'pingperfect', 'fragnet', 'gtxgaming'];
  for (const brand of competitorBrands) {
    // Remove "- Brand Alternative", "vs Brand", "Brand Alternative |", etc.
    cleaned = cleaned.replace(new RegExp('\\s*[-–]\\s*' + brand.replace(/[-]/g, '[-–]') + '(\\s+alternative)?', 'gi'), '');
    cleaned = cleaned.replace(new RegExp('\\bvs\\.?\\s*' + brand.replace(/[-]/g, '[-–]') + '(\\s+alternative)?\\s*\\|?', 'gi'), '');
    cleaned = cleaned.replace(new RegExp('\\b' + brand.replace(/[-]/g, '[-–]') + '(\\s+alternative)?\\s*[-–|]?', 'gi'), '');
  }
  // Clean up orphaned separators
  cleaned = cleaned.replace(/\s*[-–|]\s*$/, '').replace(/^\s*[-–|]\s*/, '').replace(/\s+/g, ' ').trim();
  // Ensure | NativPost is present if brand name was removed leaving trailing space
  return cleaned ? cleaned.slice(0, 500) : fallback;
}

function parseDbDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const raw = String(value).trim();
  if (!raw) return null;
  // MySQL DATETIME values in this app are treated as UTC for scheduling/storage.
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZone = /Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z';
  const d = new Date(withZone);
  return isNaN(d.getTime()) ? null : d;
}
function formatAppDateTime(value) {
  const d = parseDbDate(value);
  if (!d) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    weekday: 'short', month: 'short', day: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }).format(d);
}
function autoPublishWindowLabel() {
  return `auto-publishes on the next scheduler check, every ${AUTO_PUBLISH_INTERVAL_MINUTES} minute${AUTO_PUBLISH_INTERVAL_MINUTES === 1 ? '' : 's'}`;
}
function schedulePublishLabel(row = {}) {
  const value = scheduledValueFromRow(row);
  if (!value) return 'Due now — ' + autoPublishWindowLabel();
  const d = parseDbDate(value);
  if (!d) return 'Due now — ' + autoPublishWindowLabel();
  if (d.getTime() <= Date.now()) return 'Due now — ' + autoPublishWindowLabel();
  return 'Publishes ' + formatAppDateTime(value);
}
function publishedLabel(row = {}) {
  return row?.published_at ? 'Published ' + formatAppDateTime(row.published_at) : 'Published';
}

function scheduledValueFromRow(row = {}) { return row.scheduled_for || row.scheduled_date || null; }

// Rewrites a site URL to use CRAWL_BASE_URL when set.
// This lets the app crawl http://localhost:PORT while the public domain isn't live yet,
// while still storing the public URL (e.g. https://nativpost.com) as canonical.
function resolveCrawlUrl(publicUrl = '') {
  if (!CRAWL_BASE_URL || !publicUrl) return publicUrl;
  try {
    const u = new URL(normalizeUrl(publicUrl));
    const base = new URL(CRAWL_BASE_URL);
    u.protocol = base.protocol;
    u.hostname = base.hostname;
    u.port = base.port;
    return u.toString().replace(/\/$/, '');
  } catch { return publicUrl; }
}

function normalizeUrl(raw = '') {
  const value = String(raw || '').trim(); if (!value) return '';
  try { const u = new URL(value.includes('://') ? value : `https://${value}`); u.hash = ''; return u.toString().replace(/\/$/, ''); } catch { return value; }
}
function normalizeImageUrl(raw = '') {
  if (raw === null || raw === undefined) return '';
  let value = '';
  try { value = String(raw).trim(); } catch { return ''; }
  if (!value) return '';
  const lower = value.toLowerCase();
  if (lower.startsWith('data:')) return '';
  if (lower.startsWith('javascript:')) return '';
  if (lower.startsWith('http://') || lower.startsWith('https://')) return value;
  if (value.startsWith('/uploads/')) return value;
  if (value.startsWith('uploads/')) return '/' + value;
  if (value.startsWith('/static/uploads/')) return value.replace('/static/uploads/', '/uploads/');
  if (value.startsWith('static/uploads/')) return '/' + value.replace('static/uploads/', 'uploads/');
  if (value.startsWith('public/uploads/')) return value.replace('public/uploads/', '/uploads/');
  if (value.startsWith('/')) return value;
  return value;
}

function originOf(raw = '') { try { return new URL(normalizeUrl(raw)).origin; } catch { return normalizeUrl(raw); } }
function hostOf(raw = '') { try { return new URL(normalizeUrl(raw)).host.replace(/^www\./, ''); } catch { return String(raw || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]; } }
function pathOf(raw = '') { try { return new URL(normalizeUrl(raw)).pathname || '/'; } catch { return '/'; } }
function titleFromUrl(raw = '') { const pathname = pathOf(raw).replace(/^\/+|\/+$/g, ''); if (!pathname) return ''; const last = pathname.split('/').filter(Boolean).pop() || pathname; return last.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 500); }
function stripHtml(html = '') { return String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); }
function extractTitle(html = '') { return stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').slice(0, 500); }
function extractH1(html = '') { return stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').slice(0, 500); }
function extractMeta(html = '', key = 'description') {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${key}["']`, 'i'),
    new RegExp(`<meta[^>]+property=["']og:${key}["'][^>]+content=["']([^"']*)["']`, 'i')
  ];
  for (const p of patterns) { const m = String(html).match(p); if (m) return stripHtml(m[1]).slice(0, 500); }
  return '';
}
function extractCanonical(html = '', base = '') { try { const m = String(html).match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i); return m ? new URL(m[1], base).toString() : ''; } catch { return ''; } }
function extractLinks(html = '', base = '') {
  const out = [];
  for (const m of String(html).matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) {
    try {
      const href = m[1]; if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
      const u = new URL(href, base); if (/^https?:$/.test(u.protocol)) { u.hash = ''; out.push(u.toString().replace(/\/$/, '')); }
    } catch { }
  }
  return [...new Set(out)].slice(0, 600);
}
function extractImages(html = '', base = '') {
  const out = [];
  const seen = new Set();
  function add(raw = '', alt = '') {
    try {
      raw = String(raw || '').trim();
      if (!raw || /^data:image|base64|javascript:/i.test(raw)) return;
      if (raw.includes(',') && /\s\d+(w|x)(,|$)/i.test(raw)) {
        const parts = raw.split(',').map(x => x.trim()).filter(Boolean);
        raw = (parts[parts.length - 1] || '').split(/\s+/)[0] || raw;
      } else if (/\s\d+(w|x)$/i.test(raw)) {
        raw = raw.split(/\s+/)[0];
      }
      let url = new URL(raw, base).toString();
      try {
        const u = new URL(url);
        const nested = u.searchParams.get('url') || u.searchParams.get('src') || u.searchParams.get('image');
        if (nested && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(decodeURIComponent(nested))) {
          url = new URL(decodeURIComponent(nested), url).toString();
        }
      } catch { }
      if (/\.svg($|\?)|logo|favicon|tracking|pixel/i.test(url.toLowerCase())) return;
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ url, alt: stripHtml(alt || '').slice(0, 255) });
    } catch { }
  }
  const text = String(html || '');
  for (const m of text.matchAll(/<img[^>]*>/gi)) {
    const tag = m[0];
    const alt = tag.match(/alt=["']([^"']*)["']/i)?.[1] || tag.match(/title=["']([^"']*)["']/i)?.[1] || '';
    for (const a of ['data-full', 'data-original', 'data-large', 'data-src', 'src', 'data-lazy-src', 'data-url']) {
      const v = tag.match(new RegExp(`${a}=[\"']([^\"']+)[\"']`, 'i'))?.[1];
      if (v) add(v, alt);
    }
    const srcset = tag.match(/(?:srcset|data-srcset)=["']([^"']+)["']/i)?.[1];
    if (srcset) add(srcset, alt);
  }
  // Many official game/media pages, including Minecraft.net, put the real responsive images on <source> tags rather than <img>.
  for (const m of text.matchAll(/<source[^>]*>/gi)) {
    const tag = m[0];
    const srcset = tag.match(/(?:srcset|data-srcset)=["']([^"']+)["']/i)?.[1];
    if (srcset) add(srcset, 'official media screenshot');
    for (const a of ['data-src', 'src', 'data-url']) {
      const v = tag.match(new RegExp(`${a}=[\"']([^\"']+)[\"']`, 'i'))?.[1];
      if (v) add(v, 'official media screenshot');
    }
  }
  for (const m of text.matchAll(/(?:href|content|data-url|data-href)=["']([^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?)["']/gi)) add(m[1], '');
  for (const m of text.matchAll(/url\((["']?)([^)'"]+\.(?:jpg|jpeg|png|webp)(?:\?[^)'"]*)?)\)/gi)) add(m[2], '');
  for (const m of text.matchAll(/https?:\/\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]*)?/gi)) add(m[0], '');
  // Handle escaped JSON/Next.js image references such as \u002F_next\u002Fimage?url=... or https:\/\/cdn...\/file.jpg
  // Strip script tags before scanning for image URLs - prevents JS code from matching
  const noScripts = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const unescaped = noScripts.replace(/\u002F/g, '/').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  for (const m of unescaped.matchAll(/https?:\/\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]*)?/gi)) add(m[0], '');
  for (const m of unescaped.matchAll(/(?:url|src|image)=([^"'\s<>]+\.(?:jpg|jpeg|png|webp)(?:[^"'\s<>]*)?)/gi)) {
    try { add(decodeURIComponent(m[1]), 'official media screenshot'); } catch { add(m[1], 'official media screenshot'); }
  }
  for (const m of noScripts.matchAll(/\\\/(?:\\\/)?[^"']+\.(?:jpg|jpeg|png|webp)/gi)) {
    try { add(m[0].replace(/\\\//g, '/').replace(/^\/\//, 'https://'), ''); } catch { }
  }
  return out.slice(0, 120);
}
function looksLikePressImage(url = '', alt = '') {
  const x = `${url} ${alt}`.toLowerCase();
  if (!/^https?:\/\//i.test(String(url || ''))) return false;
  if (/\.svg($|\?)|logo|icon|favicon|esrb|rating|avatar|sprite|tracking|pixel|analytics/i.test(x)) return false;
  return /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url) || /image|screenshot|keyart|key-art|wallpaper|press|media|cdn|assets|uploads/i.test(x);
}
function imageScoreForGame(img = {}, game = '') {
  const x = `${img.url || ''} ${img.alt || ''}`.toLowerCase();
  let score = 0;
  if (game && x.includes(String(game).toLowerCase())) score += 25;
  if (/screenshot|screenshots/.test(x)) score += 20;
  if (/keyart|key-art|wallpaper|hero|press|media|assets|high.?res|1920|2560|3840/.test(x)) score += 15;
  if (/logo|icon|favicon|esrb|rating|thumbnail/.test(x)) score -= 30;
  if (/\.webp(\?|$)|\.jpg(\?|$)|\.jpeg(\?|$)|\.png(\?|$)/.test(x)) score += 8;
  return score;
}

function canonicalImageSourceUrl(url = '') {
  try {
    let raw = String(url || '').trim().replace(/&amp;/g, '&');
    const u = new URL(raw);
    for (const param of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']) u.searchParams.delete(param);
    const nested = u.searchParams.get('url') || u.searchParams.get('src') || u.searchParams.get('image');
    if (nested) {
      try { return canonicalImageSourceUrl(decodeURIComponent(nested)); } catch { }
    }
    u.hash = '';
    return u.toString();
  } catch {
    return String(url || '').trim();
  }
}
function sha256Text(value = '') { return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex'); }
function sha256Buffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function pressKitSeedsForGame(game = '') {
  const key = detectGame(game) || normalizeGameName(game);
  return [...new Set(PRESS_KIT_SEEDS[key] || [])].filter(Boolean);
}
async function discoverPressKitImages(game = '', options = {}) {
  const key = detectGame(game) || normalizeGameName(game);
  const found = [];
  // Try Steam API first — most reliable source of official screenshots
  const steamAppId = STEAM_APP_IDS[key] || STEAM_APP_IDS[game?.toLowerCase()?.trim()];
  if (steamAppId) {
    const steamImgs = await fetchSteamScreenshots(steamAppId, key || game, Number(options.limit || 8));
    found.push(...steamImgs);
    if (found.length >= Number(options.limit || 6)) {
      return found.slice(0, Number(options.limit || 6));
    }
  }
  const seeds = pressKitSeedsForGame(key || game).slice(0, Number(process.env.PRESS_KIT_SEED_LIMIT || 30));
  const visited = new Set();
  const queue = [...seeds];
  while (queue.length && visited.size < Number(process.env.PRESS_KIT_PAGE_LIMIT || 24) && found.length < Number(process.env.PRESS_KIT_IMAGE_LIMIT || 80)) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);
    try {
      // If a crawl link is already an image/download URL, keep it as a candidate instead of trying to parse it as HTML.
      if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(url) || /\b(download|wallpaper|screenshot|image)\b/i.test(url)) {
        found.push({ url, alt: `${gameDisplay(key || game)} official media screenshot`, label: `${gameDisplay(key || game)} press kit image`, sourcePage: url, sourceTitle: titleFromUrl(url), score: imageScoreForGame({ url, alt: 'official media screenshot' }, key) + 5 });
        if (/\.(jpg|jpeg|png|webp)(\?|$)/i.test(url)) continue;
      }
      const { html } = await fetchUrl(url, 14000);
      const title = extractTitle(html) || titleFromUrl(url);
      for (const img of extractImages(html, url)) {
        if (!looksLikePressImage(img.url, img.alt)) continue;
        found.push({ ...img, label: `${gameDisplay(key || game)} press kit image`, sourcePage: url, sourceTitle: title, score: imageScoreForGame(img, key) });
      }
      const links = extractLinks(html, url).filter(l => {
        const t = l.toLowerCase();
        if (visited.has(l)) return false;
        return /press|media|asset|kit|screenshot|screenshots|image|wallpaper|collectible|collectibles|download|minecraft\.net\/en-us\/(article|articles|collectibles)|google\.com\/drive|dropbox|cdn/.test(t);
      }).slice(0, 8);
      queue.push(...links);
    } catch (e) { }
  }
  const unique = [];
  const seen = new Set();
  for (const img of found.sort((a, b) => (b.score || 0) - (a.score || 0))) {
    if (seen.has(img.url)) continue;
    seen.add(img.url);
    unique.push(img);
  } let final = unique;
  if (key === 'minecraft') {
    final = final.filter(img => {
      const x = String(img.url + ' ' + img.alt + ' ' + img.sourcePage).toLowerCase();
      // Accept the verified IGDB Minecraft press-kit CDN plus official Minecraft/Mojang/Microsoft media hosts.
      if (!new RegExp('images\\.igdb\\.com|igdb\\.com/games/minecraft--1|minecraft\\.net|mojang|microsoft|xboxlive|akamaized|minecraft').test(x)) return false;
      // Keep base Minecraft only; reject spin-offs, merch, logos, and non-article shop assets.
      if (/dungeons|legends|education|movie|marketplace|skin|skins|apparel|plush|shop|logo|icon|profile/.test(x)) return false;
      return true;
    });
  }
  return final.slice(0, Number(options.limit || process.env.PRESS_KIT_SAVE_LIMIT || 12));
}
async function downloadImageToUploads(url, game = 'press-kit') {
  const safeGame = slugify(game || 'press-kit').replace(/[^a-z0-9-]/g, '') || 'press-kit';
  const sourceUrl = canonicalImageSourceUrl(url);
  const resp = await axios.get(sourceUrl, { timeout: 30000, responseType: 'arraybuffer', maxRedirects: 8, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NativPostSEOBot/1.0; +https://nativpost.com)', 'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8', 'Referer': originOf(sourceUrl) || 'https://nativpost.com/' }, validateStatus: st => st >= 200 && st < 400 });
  const type = String(resp.headers['content-type'] || '').toLowerCase();
  const buf = Buffer.from(resp.data || []);
  let ext = '.jpg';
  if (type.includes('png')) ext = '.png'; else if (type.includes('webp')) ext = '.webp'; else if (type.includes('jpeg') || type.includes('jpg')) ext = '.jpg';
  else if (/\.png(\?|$)/i.test(sourceUrl)) ext = '.png'; else if (/\.webp(\?|$)/i.test(sourceUrl)) ext = '.webp';
  if (!/^image\//.test(type) && !/\.(jpg|jpeg|png|webp)(\?|$)/i.test(sourceUrl)) throw new Error('Press kit URL did not return a supported image file.');
  if (buf.length < Number(process.env.PRESS_KIT_MIN_IMAGE_BYTES || 25000)) throw new Error('Press kit image was too small or incomplete.');
  const fileSha256 = sha256Buffer(buf);
  const finalName = `${safeGame}-presskit-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  const assetUrl = `/uploads/${finalName}`;
  fs.writeFileSync(path.join(uploadDir, finalName), buf);
  return { assetUrl, sourceUrl, fileSha256, bytes: buf.length, contentType: type };
}


function isLocalUploadUrl(url = '') {
  return String(url || '').startsWith('/uploads/');
}
function localUploadPath(url = '') {
  if (!isLocalUploadUrl(url)) return '';
  const clean = String(url).split('?')[0].replace(/^\/uploads\//, '');
  if (!clean || clean.includes('..') || clean.includes('/') || clean.includes('\\')) return '';
  return path.join(uploadDir, clean);
}
function localUploadFileOk(url = '', minBytes = 1000) { // Lowered from 12000 — user uploads can be small
  try {
    const fp = localUploadPath(url);
    if (!fp) return false;
    const st = fs.statSync(fp);
    return st.isFile() && st.size >= Number(minBytes || 12000);
  } catch { return false; }
}
async function cleanupBrokenLocalPressKitAssets() {
  try {
    const rows = await q("SELECT id,asset_url FROM article_assets WHERE asset_url LIKE '/uploads/%' AND LOWER(COALESCE(label,'')) LIKE '%press kit%'");
    for (const r of rows) {
      if (localUploadFileOk(r.asset_url, Number(process.env.PRESS_KIT_MIN_LOCAL_BYTES || 12000))) continue;
      await q('UPDATE articles SET featured_image_id=NULL, featured_image_url=NULL WHERE featured_image_id=? OR featured_image_url=?', [r.id, r.asset_url]);
      await q('DELETE FROM article_assets WHERE id=?', [r.id]);
    }
  } catch (e) { console.warn('Press-kit local image cleanup skipped:', e.message); }
}
async function dedupeExistingLocalPressKitAssets() {
  try {
    const rows = await q("SELECT id,game_slug,folder_name,asset_url,file_sha256 FROM article_assets WHERE asset_url LIKE '/uploads/%' ORDER BY id ASC");
    const seen = new Map();
    for (const r of rows) {
      if (!localUploadFileOk(r.asset_url, Number(process.env.PRESS_KIT_MIN_LOCAL_BYTES || 12000))) continue;
      const fp = localUploadPath(r.asset_url);
      let hash = r.file_sha256;
      if (!hash) {
        hash = sha256Buffer(fs.readFileSync(fp));
        await q('UPDATE article_assets SET file_sha256=? WHERE id=?', [hash, r.id]);
      }
      const gameKey = detectGame(r.game_slug || r.folder_name || '') || normalizeGameName(r.game_slug || r.folder_name || 'unknown');
      const key = gameKey + ':' + hash;
      if (!seen.has(key)) { seen.set(key, r); continue; }
      const keep = seen.get(key);
      await q('UPDATE articles SET featured_image_id=?, featured_image_url=? WHERE featured_image_id=? OR featured_image_url=?', [keep.id, keep.asset_url, r.id, r.asset_url]);
      await q('DELETE FROM article_assets WHERE id=?', [r.id]);
      try { fs.unlinkSync(fp); } catch { }
    }
  } catch (e) { console.warn('Press-kit duplicate cleanup skipped:', e.message); }
}
async function cleanupBrokenArticleImageRefs() {
  try {
    const rows = await q("SELECT id,featured_image_id,featured_image_url,primary_keyword,title FROM articles WHERE featured_image_url LIKE '/uploads/%'");
    for (const a of rows) {
      if (localUploadFileOk(a.featured_image_url, Number(process.env.PRESS_KIT_MIN_LOCAL_BYTES || 12000))) continue;
      await q('UPDATE articles SET featured_image_id=NULL, featured_image_url=NULL WHERE id=?', [a.id]);
    }
  } catch (e) { console.warn('Article image cleanup skipped:', e.message); }
}
async function imageUseCountsForGame(game = '') {
  const key = detectGame(game) || normalizeGameName(game);
  const rows = await q("SELECT featured_image_id id, COUNT(*) used FROM articles WHERE featured_image_id IS NOT NULL AND LOWER(COALESCE(primary_keyword,title,'')) LIKE ? GROUP BY featured_image_id", [`%${key}%`]);
  const m = new Map();
  for (const r of rows) m.set(Number(r.id), Number(r.used || 0));
  return m;
}
async function importPressKitAssets(game = '', siteId = null, limit = 3) {
  const key = detectGame(game) || normalizeGameName(game);
  if (!key) return [];
  const requested = Math.max(Number(limit || 3), 1);
  const images = await discoverPressKitImages(key, { limit: Math.max(requested * 4, 16) });
  const saved = [];
  for (const img of images) {
    if (saved.length >= requested) break;
    try {
      const sourceUrl = canonicalImageSourceUrl(img.url);
      const sourceHash = sha256Text(sourceUrl);
      const existingSource = await one('SELECT id FROM article_assets WHERE game_slug=? AND (source_hash=? OR source_url=?) LIMIT 1', [key, sourceHash, sourceUrl]);
      if (existingSource) continue;
      const downloaded = await downloadImageToUploads(sourceUrl, key);
      const existingFile = await one('SELECT id FROM article_assets WHERE game_slug=? AND file_sha256=? LIMIT 1', [key, downloaded.fileSha256]);
      if (existingFile) { try { fs.unlinkSync(localUploadPath(downloaded.assetUrl)); } catch { } continue; }
      const alt = truncate(img.alt || `${gameDisplay(key)} official press kit image`, 255);
      const label = truncate(`${gameDisplay(key)} press kit - ${img.sourceTitle || titleFromUrl(img.sourcePage || sourceUrl) || 'official image'}`, 255);
      const result = await q('INSERT INTO article_assets (site_id,label,game_slug,folder_name,asset_url,alt_text,source_url,source_hash,file_sha256,source_page) VALUES (?,?,?,?,?,?,?,?,?,?)', [siteId || null, label, key, key, downloaded.assetUrl, alt, sourceUrl, sourceHash, downloaded.fileSha256, img.sourcePage || null]);
      const row = await one('SELECT * FROM article_assets WHERE id=?', [result.insertId]);
      saved.push(row);
    } catch (e) { }
  }
  return saved;
}
// ── TOPIC IMAGE FETCHER ──────────────────────────────────────────────────────
// Fetches a relevant image from Unsplash Source for non-game articles.
// Unsplash Source is free, no API key required, just a redirect URL.
// We download and store the image locally so it persists.
// ─────────────────────────────────────────────────────────────────────────────
const TOPIC_IMAGE_TERMS = {
  'social media': 'social-media,marketing,content',
  'brand voice': 'brand-voice,ai,marketing',
  'content generator': 'ai,content,social-media',
  'ddos': 'cybersecurity,network,technology',
  'nativpost': 'ai,social-media,brand-voice',
  'social media tool': 'social-media,ai,marketing',
  'dedicated server': 'server,datacenter,hardware',
  'affordable': 'gaming,setup,computer',
  'performance': 'gaming,performance,computer',
  'lag': 'gaming,network,internet',
  'nvme': 'hardware,storage,technology',
  'free trial': 'gaming,computer,play',
  'guide': 'gaming,guide,computer',
  'setup': 'gaming,setup,computer',
  'default': 'gaming,server,esports'
};
function topicImageQuery(keyword = '') {
  const k = String(keyword || '').toLowerCase();
  for (const [term, query] of Object.entries(TOPIC_IMAGE_TERMS)) {
    if (k.includes(term)) return query;
  }
  return TOPIC_IMAGE_TERMS.default;
}
async function fetchTopicImageForKeyword(keyword = '', siteId = null) {
  try {
    const query = topicImageQuery(keyword);
    // Use Unsplash Source API - free redirect, no key needed
    const sourceUrl = `https://source.unsplash.com/featured/1200x630/?${encodeURIComponent(query)}`;
    const label = `${keyword} featured image`;
    const altText = `${keyword} - ai social media content`;
    // Check if we already have one stored for this keyword
    const existing = await one(
      "SELECT * FROM article_assets WHERE label=? AND asset_url LIKE '/uploads/%' ORDER BY id DESC LIMIT 1",
      [label]
    );
    if (existing && localUploadFileOk(existing.asset_url, 8000)) return existing;
    // Download via redirect
    const asset = await downloadImageToUploads(sourceUrl, 'topic-images');
    if (!asset) return null;
    const result = await q(
      'INSERT INTO article_assets (site_id,label,game_slug,folder_name,asset_url,alt_text) VALUES (?,?,?,?,?,?)',
      [siteId || null, label, null, 'topic-images', asset.localPath, altText]
    );
    return await one('SELECT * FROM article_assets WHERE id=?', [result.insertId]);
  } catch (e) {
    console.log('[TopicImage] Failed for "' + keyword + '":', e.message);
    return null;
  }
}

async function ensurePressKitAssetForGame(game = '', siteId = null) {
  const key = detectGame(game) || normalizeGameName(game);
  if (!key) return null;
  await cleanupBrokenLocalPressKitAssets();
  await dedupeExistingLocalPressKitAssets();
  await cleanupBrokenArticleImageRefs();

  async function getCandidates() {
    const rows = await q("SELECT * FROM article_assets WHERE (site_id=? OR site_id IS NULL) AND game_slug=? AND asset_url LIKE '/uploads/%' ORDER BY id DESC LIMIT 80", [siteId || null, key]);
    return rows.filter(r => localUploadFileOk(r.asset_url, Number(process.env.PRESS_KIT_MIN_LOCAL_BYTES || 12000)));
  }

  let candidates = await getCandidates();
  const desiredPool = key === 'minecraft' ? Number(process.env.PRESS_KIT_DESIRED_POOL_MINECRAFT || 12) : Number(process.env.PRESS_KIT_DESIRED_POOL_PER_GAME || 6);
  if (candidates.length < desiredPool) {
    await importPressKitAssets(key, siteId, Number(process.env.PRESS_KIT_AUTO_IMPORT_LIMIT || 10));
    candidates = await getCandidates();
  }
  if (!candidates.length) return null;

  const useCounts = await imageUseCountsForGame(key);
  candidates.sort((a, b) => (useCounts.get(Number(a.id)) || 0) - (useCounts.get(Number(b.id)) || 0) || Math.random() - 0.5);
  const leastUsed = useCounts.get(Number(candidates[0].id)) || 0;
  const pool = candidates.filter(c => (useCounts.get(Number(c.id)) || 0) === leastUsed).slice(0, 8);
  return pool[Math.floor(Math.random() * pool.length)] || candidates[0] || null;
}

function tokens(text = '') { return String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(x => x.length > 2 && !STOPWORDS.has(x)); }
function topTerms(texts = [], limit = 40) { const m = new Map(); for (const t of texts) for (const tok of tokens(t)) { const k = cleanKeyword(tok); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([keyword, count]) => ({ keyword, count })); }

const BAD_KEYWORDS = new Set(['nitrado', 'gportal', 'shockbyte', 'bisecthosting', 'hosthavoc', 'apex', 'und', 'oder', 'der', 'die', 'das', 'mieten', 'sofort', 'gameserver', 'spieleserver', 'nstig', 'gmbh', 'com', 'net', 'www']);
function isBadKeyword(keyword = '') {
  const k = String(keyword || '').toLowerCase().trim();
  if (!k || k.length < 5) return true;
  if (BAD_KEYWORDS.has(k)) return true;
  if (/^[0-9]+$/.test(k)) return true;
  // Reject single words unless they are a known game name
  const words = k.split(/\s+/).filter(Boolean);
  const isKnownGame = GAME_ALIASES.some(g => g.patterns.some(p => k === p || k.startsWith(p + ' ')));
  if (words.length < 2 && !isKnownGame) return true;
  if (/\b(nitrado|gportal|shockbyte|bisect|hosthavoc)\b/.test(k)) return true;
  if (/\b(und|oder|der|die|das|ein|eine|mieten|sofort|spieleserver|gameserver)\b/.test(k)) return true; // Remove non-English garbage keywords
  return false;
}
function cleanKeyword(keyword = '') {
  let k = String(keyword || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (isBadKeyword(k)) return '';
  // Accept any keyword related to social media, AI content, brand voice, or NativPost
  // NativPost: keep social media, AI, brand voice, and SaaS keywords. Block pure game hosting.
  const isGameHostingOnly = /^(ark|palworld|minecraft|rust|valheim|enshrouded|windrose|terraria|dayz|zomboid|conan|icarus|satisfactory|factorio|vrising|hytale|everwind)\s+(server hosting|hosting|server|dedicated server)/.test(k);
  if (isGameHostingOnly) return '';
  const isRelevant = /(social media|brand voice|content|caption|ai|nativpost|schedul|publish|instagram|linkedin|tiktok|twitter|facebook|youtube|threads|pinterest|africa|nigeria|kenya|ghana|smb|agency|marketing|ocoya|buffer|hootsuite|jasper|predis|feedhive|video|ugc|pricing|review|best|how|guide|tool|platform|automat)/i.test(k);
  if (!isRelevant && k.split(' ').length < 2) return '';
  return k.slice(0, 120);
}
function strategicFallbackTopics() {
  // NativPost core keywords — used as fallback when no keyword is specified
  return [
    'ai social media content generator',
    'brand voice ai tool',
    'social media scheduling tool',
    'ai caption generator instagram',
    'linkedin post generator ai',
    'nativpost vs ocoya',
    'social media tool for small business',
    'ai social media video generator',
    'social media tool nigeria',
    'ocoya alternative',
    'best ai social media tool 2026',
    'social media tool for agencies',
    'how to build a brand voice on social media',
  ];
}
function safeJsonParse(value, fallback = null) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function articleTitleFor(keyword = '') {
  const k = cleanKeyword(keyword) || 'ai social media content generator';
  const nice = k.replace(/\b\w/g, c => c.toUpperCase());
  // Comparison / alternative articles
  if (/vs\.?\s|versus|alternative/.test(k)) return `${nice} in 2026: The Honest Comparison`;
  // Best-of / listicles
  if (/^best /.test(k)) return `${nice} in 2026: Top Picks Compared`;
  // How-to / guide articles
  if (/how to|guide|tutorial|step/.test(k)) return `${nice}: Complete 2026 Guide`;
  // Review / pricing
  if (/review|pricing|cost|worth/.test(k)) return `${nice}: Is It Worth It in 2026?`;
  // Platform-specific
  if (/linkedin/.test(k)) return `${nice}: Grow Your LinkedIn Presence With AI in 2026`;
  if (/instagram/.test(k)) return `${nice}: Post Better on Instagram With AI`;
  if (/tiktok/.test(k)) return `${nice}: Create Viral TikTok Content With AI`;
  if (/africa|nigeria|kenya|ghana/.test(k)) return `${nice}: The Best Option for African Businesses in 2026`;
  if (/agency|agencies/.test(k)) return `${nice}: The Agency Guide to AI Social Media in 2026`;
  // Default — benefit-led
  return `${nice}: Stop Sounding Like AI in 2026`;
}
async function callOpenAIArticle({ site, keyword, ownPages = [], competitorPages = [], competitorTerms = [], imageHints = [], offerFacts = '', serp = null, extended = false }) {
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  if (!hasAnthropic && !hasOpenAI) return null;
  const target = cleanKeyword(keyword) || keyword || 'ai social media content';
  const serpAvgWords = Number(serp?.avg_words || 0);
  const wordTarget = Math.max(1600, serpAvgWords >= 800 ? serpAvgWords + 200 : 1600);
  const serpQuestions = (serp?.questions || []).slice(0, 10).join('\n- ');
  const serpFeatures = (serp?.serp_features || []).join(', ') || 'standard organic';
  const serpIntent = serp?.serp_intent || 'mixed';
  // Detect whether this is a game-specific article or a brand/company article
  const detectedGameInKw = detectGame(target);
  const isGameArticle = false; // NativPost: never a game article
  const prompt = [
    // BLOCK 1: Game facts - absolute highest priority, injected first
    offerFacts && offerFacts.includes('VERIFIED FACTS FOR') ? [
      '════════════════════════════════════════════════════════',
      'MANDATORY NATIVPOST FACTS — HIGHEST PRIORITY — READ BEFORE ANYTHING ELSE',
      'The following facts are verified and authoritative.',
      'You MUST use them exactly. Do NOT adjust based on your training data.',
      'Your training data about this game may be outdated or wrong. These facts are current.',
      '════════════════════════════════════════════════════════',
      offerFacts.slice(offerFacts.indexOf('VERIFIED FACTS FOR'), offerFacts.indexOf('\nACCURACY RULE') + offerFacts.slice(offerFacts.indexOf('\nACCURACY RULE')).indexOf('\n') + 1),
      '════════════════════════════════════════════════════════',
      '',
    ].join('\n') : '',

    // BLOCK 2: Article brief
    `You are writing for NativPost (nativpost.com), an AI-powered social media content platform. Create a finished SEO article meant to beat competitor pages and rank on Google. CRITICAL TITLE RULE: NEVER include competitor brand names (Ocoya, Buffer, Predis, Hootsuite, Jasper, Later) in the article title or slug unless it is a direct comparison article. The title must lead with the keyword and NativPost's angle.`,
    '',
    `Business: ${site?.name || 'NativPost'}`,
    `Primary keyword: ${target}`,
    `Site URL: ${site?.url || 'https://nativpost.com'}`,
    '',
    'Mandatory NativPost business facts:',
    offerFactsText(),
    '',

    // BLOCK 3: Live game context and offer page evidence (excludes the game facts already shown above)
    offerFacts ? 'NativPost offer context:\n' + offerFacts.trim() : '',
    '',

    `Existing internal pages to link naturally: ${ownPages.map(p => `${p.page_title || 'Page'} - ${p.page_url}`).slice(0, 10).join(' | ')}`,
    `Competitor pages observed: ${competitorPages.map(p => `${p.page_title || 'Untitled'} - ${p.page_url} (${p.word_count || 0} words)`).slice(0, 12).join(' | ')}`,
    `Competitor topical terms to cover, only if relevant: ${competitorTerms.filter(x => !isBadKeyword(x)).slice(0, 30).join(', ')}`,
    `Image hints available: ${imageHints.map(i => `${i.label || ''} ${i.game_slug || ''} ${i.alt_text || ''}`).slice(0, 8).join(' | ')}`,
    '',
    `SERP intelligence for "${target}":`,
    `- Search intent: ${serpIntent}`,
    `- SERP features present: ${serpFeatures}`,
    `- Top-ranking pages average word count: ${serpAvgWords || 'unknown'} words — target ${wordTarget}–${wordTarget + 400} words`,
    `- People Also Ask / questions to answer in FAQ:`,
    serpQuestions ? '- ' + serpQuestions : '(none captured — use common questions for this game/topic)',
    '',
    `Return strict JSON only with keys: title, slug, meta_title, meta_description, excerpt, body_markdown, featured_image_alt, review_notes. FIELD LIMITS (HARD): title must be ≤50 characters. excerpt must be ≤150 characters — it is a short teaser sentence, not a paragraph. meta_description must be ≤160 characters.`,
    `WRITING QUALITY RULES — READ FIRST:`,
    `- Write in flowing, confident prose. Avoid bullet-point walls. For lists WITHIN sections, use the inline bold term format: "**Term:** explanation sentence." — NOT bullet points. Reserve actual bullet/numbered lists only for step-by-step instructions.`,
    `- Do NOT pad with empty phrases like "In today's gaming world", "As gaming continues to evolve", or "unlock the ultimate experience". Write like an expert, not a marketing brochure.`,
    `- Use specific facts and numbers: anti-slop filter scores 0-1, rejects below 0.7; 3 variants generated in parallel via asyncio.gather(); topic memory prevents repetition; Paystack accepted in Africa. Vague filler fails the quality gate.`,
    `- Vary sentence length. Mix short punchy sentences with longer explanatory ones. Write for a real human who is deciding whether to invest in an AI social media tool.`,
    `- HEADLINE FORMAT: Never use "[Keyword] | NativPost" as the title. Use a story hook or data hook. Examples: "Stop Sounding Like a Bot: How NativPost Builds a Real Brand Voice" or "Why 73% of AI Social Media Content Gets Ignored (And How to Fix It)" or "Ocoya vs NativPost in 2026: Which One Actually Learns Your Brand?". The title should make someone want to click. CRITICAL: The title field MUST be 50 characters or fewer — count every character including spaces. If your hook runs long, shorten it. Titles over 50 characters will fail Contentful validation and block publishing.`,
    `- OPENING PARAGRAPH: Do NOT open with a definition or quick answer. Open with a SCENARIO or DILEMMA the reader is facing. Example: "When you first decide to take your world online, you face a fork in the road..." or "A single disgruntled player with a $5 booter service can knock your entire server offline in seconds." Hook them with tension, then resolve it.`,
    `- QUICK ANSWER TABLE: The FIRST element after the opening paragraph must be a markdown comparison table that immediately answers the core buying question. This gets featured snippets. For hosting: Plan | RAM | Players | Price. For guides: Method | Best For | Cost.`,
    `- TECHNICAL SPECIFICITY: Name specific tools, protocols, and features throughout. For NativPost: anti-slop filter (0-1 score, rejects below 0.7), content modes (Normal/Concise/Controversial), tone sliders (1-10), topic memory, asyncio.gather() parallel generation, Paystack (Africa billing). For brand voice: forbidden words, per-platform voice, content examples. Specific > generic. This specificity signals expertise.`,
    `- YEAR REFERENCES: Include "in 2026" or "as of 2026" naturally in 3-5 places including at least one H2 heading. Strong freshness signal.`,
    `- PRICING TABLE LINKS: In ALL pricing/plan tables, the Price column must use real markdown hyperlinks, never plain text. Format: [View Pricing](https://nativpost.com/game/GAME-server-hosting). Never write "See Current Pricing" or "Visit site" as plain text.`,
    `- INTERNAL LINKS REQUIREMENT: You MUST include exactly 3-5 internal links to NativPost blog posts or pages placed naturally mid-article. Not all at the end. Use descriptive anchor text. Example: "as we explain in our [guide to building a brand voice](https://nativpost.com/blog/brand-voice-guide)". All links must use full absolute URLs starting with https://nativpost.com/ or https://app.nativpost.com.`,
    `- EXTERNAL LINK REQUIREMENT: You MUST include exactly 1 external link to the game's official Steam page (format: https://store.steampowered.com/app/APPID/) or the developer's official website. Place it in the "What Makes [Game] Different" section. This is mandatory — missing it fails the quality gate.`,
    `- NAMED FEATURES: Always mention the anti-slop filter, content modes (Normal/Concise/Controversial), tone sliders (1-10), topic memory, and Paystack by name. Explain WHY each matters. Specific > generic.`,
    `- AFRICA ANGLE: When the keyword has African market intent (Nigeria, Kenya, Ghana, South Africa), prominently mention Paystack support and that NativPost is built for African businesses. This is a real differentiator no competitor offers.`,
    `- TRIAL LANGUAGE: Always say "7-day free trial" — never "30-day trial", "free forever", or "money-back guarantee". The trial includes 3 posts maximum, text only.`,
    `- CTA FORMAT: Conclusion should be 2-3 sentences summarizing the value, then one direct action: "Start your 7-day free trial at app.nativpost.com — no credit card required." Never say "7-day free trial" or "7-day free trial".`,
    ``,
    `Requirements:`,
    `- AI SEARCH OPTIMIZATION (critical for 2025+): Structure content so AI systems (Google AI Overviews, Perplexity) can cite NativPost directly. (1) Open with a 2-3 sentence Quick Answer stating what NativPost does and its starting price — LLMs extract this as a snippet. (2) Use specific factual statements with exact numbers (e.g. "NativPost's anti-slop filter scores every post 0-1 and auto-rejects below 0.7") — vague claims don't get cited. (3) Every FAQ answer must be self-contained and answer the question in the first sentence. (4) Include a clear "Why NativPost" section with specific differentiators. AI systems reward specificity.`,
    `- BRAND NAME RULE: Include "NativPost" naturally in the article title, at least one H2 heading, the intro paragraph, and the conclusion/CTA. Brand name must appear minimum 4-6 times in the body. CTA must always link to app.nativpost.com with "Start your 7-day free trial" language.`,
    `- Body must be a complete, high-converting article targeting ${wordTarget}–${wordTarget + 400} words. COUNT WORDS AS YOU WRITE.`,
    `- Search intent is ${serpIntent}. Answer the reader's core question immediately: what NativPost does, how it differs from Ocoya/Buffer/Jasper, what it costs, how to start the 7-day trial.`,
    isGameArticle ? `- GAME ARTICLE STRUCTURE (mandatory):
  1. H1 with keyword — use curiosity gap or data hook when possible. Include "2026" in title or first H2.
  2. FIRST ELEMENT after H1: a markdown comparison/summary table answering the core question (e.g. Tool | Best For | Price | Brand Voice Depth). This must come before any prose — it targets featured snippets.
  3. Intro paragraph (2-3 sentences): what NativPost does and why it solves the reader's exact problem. Include "as of 2026".
  4. ## What Makes [Game] Different to Host — 2-3 paragraphs: the game's engine, networking protocol (UDP/TCP/RakNet/Source), why it needs dedicated servers, what happens without proper hosting. External link to Steam/official site here.
  5. ## [Game] Server Requirements in 2026 — detailed breakdown using ONLY verified facts. Cover RAM per player count, OS, SteamCMD App ID, why NVMe matters vs HDD for this game specifically.
  6. ## NativPost Plans & Pricing — Starter $19, Growth $39, Pro $79, Agency $149. Explain what each plan unlocks. Link to app.nativpost.com/subscribe.
  7. ## Why NativPost in 2026 — anti-slop filter (0-1 scoring, auto-rejects below 0.7), brand voice config (tone sliders 1-10, forbidden words, per-platform voice), 3 variants in parallel, topic memory, Paystack for Africa. Place 1-2 internal links to related NativPost blog posts naturally.
  8. ## How to Get Started with NativPost — numbered steps: sign up → set up brand profile → connect social accounts → generate first content → approve and publish.
  9. Comparison table: Platform | NativPost Feature | How It Helps.
  10. ## FAQ — minimum 5 Q&A pairs as ### H3 questions. First sentence of each answer must directly answer the question. Use PAA data from SERP.
  11. Conclusion: 2-3 sentences + "Start your 7-day free trial at app.nativpost.com 7-day free trial and have your [game] server online in minutes" + direct link.` : `- BRAND/COMPANY ARTICLE STRUCTURE (mandatory):
  1. H1 with keyword in title
  2. FIRST ELEMENT: markdown comparison table answering the core question before any prose
  3. Intro paragraph: what is NativPost in 2-3 confident sentences. Include "as of 2026".
  4. ## What is NativPost — 3+ paragraphs. Who they are, what makes them different from generic hosts, their infrastructure focus. Do NOT mention a single game as the focus — mention several.
  5. ## Performance and Infrastructure in 2026 — NVMe SSDs (specific read speeds vs HDD), DDoS protection (name attack types: UDP floods, volumetric, L7), server locations (North America, Europe, Asia). Technical depth signals expertise.
  6. ## Platforms NativPost Supports — Instagram, Facebook, LinkedIn, Twitter/X, TikTok, Pinterest, YouTube, Threads. Per-platform voice configuration.
  7. ## Pricing and Plans — plan structure, Starter $19, Growth $39, Pro $79, Agency $149. What each plan unlocks. Link to app.nativpost.com.des.
  8. ## How to Get Started — numbered steps from signing up to server running. At least 5 steps.
  9. Feature comparison table: NativPost vs competitors (Ocoya, Buffer, Jasper) on key dimensions.
  10. ## FAQ — minimum 5 Q&A pairs as ### H3 questions with self-contained answers.
  11. Final CTA: direct and specific. Include "7-day free trial at app.nativpost.com".`,
    `- The body MUST be ${wordTarget}–${wordTarget + 400} words. This is non-negotiable. If you finish the structure and are under ${wordTarget} words, expand EVERY section by adding more specific sentences — do not add new filler sections.`,
    `- GEO/AI answer optimization: write facts as declarative citable sentences. Entity-clear phrasing. No vague pronouns.`,
    `- Include 3-5 internal markdown links to NativPost blog posts or pages (nativpost.com/blog/, app.nativpost.com). Place naturally in context.`,
    isGameArticle
      ? `- REQUIRED: 1 external link to the game's official Steam page or developer website. Place in the What is [Game] section. Without this the article fails quality gate.`
      : `- REQUIRED: 1 external link to a relevant authoritative source about AI, social media, content marketing, or the industry being discussed. Link to a reputable study, platform documentation, or relevant research. This is mandatory — missing it reduces quality score.`,
    `- Do not use fake stats. Do not promise guaranteed #1 rankings.`,
    `- Do not mention refunds, money-back guarantees, or 30-day guarantees. NativPost offers a ${NP_TRIAL_DAYS}-day free trial (3 posts max, text only).`,
    `- Do not claim NativPost offers unlimited posts on Starter or a free forever plan. Starter is 15 posts/mo at $19/mo with a $5 setup fee.`,
    `- For server RAM sections: use ONLY the RAM figures from the VERIFIED GAME FACTS above. Do not invent tiers.`,
    `- NATIVPOST PLAN DATA: Use these exact pricing facts for ALL plan claims. Starter $19/mo (20 posts, 3 platforms), Growth $49/mo (40 posts, 5 platforms), Pro $99/mo (80 posts, all platforms, team review). All plans include one-time setup fee. 7-day free trial (3 posts max, text only). Source: nativpost.com/pricing Source: ${NP_PACKAGE_RULES}`,
    `- LINK FORMAT: All pricing, CTA, and 'View Pricing' links MUST use full absolute URLs. Examples: [Start Free Trial](https://app.nativpost.com), [View Plans](https://nativpost.com/pricing), [NativPost Blog](https://nativpost.com/blog). Never use relative URLs.`,
    `- NEVER invent NativPost features not confirmed in the business facts. Do NOT claim: free forever plan, unlimited posts on Starter, 30-day trial, money-back guarantee, or any platform not in the supported list. Only claim features explicitly listed in the NativPost business facts above.`,
    isGameArticle
      ? `- Write specifically about the keyword topic. Every section must stay on topic.`
      : `- CRITICAL for brand article: this keyword is about NativPost as a platform. Write about NativPost's AI social media capabilities overall. You may compare to Ocoya, Buffer, and Jasper, but the article must be about NativPost — not a generic AI tool roundup.`,
    `- Do not write generic filler. Make it specific to the keyword intent, brand/content marketer pain points, and NativPost's actual confirmed features.`,
    `- Meta description must be under 160 characters. Clearly answer searcher intent with specific entities and trustworthy detail.`,
  ].filter(s => s !== '').join('\n');
  // Use Anthropic Claude as primary, OpenAI as fallback
  if (hasAnthropic) {
    try {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-5',
        max_tokens: 12000,
        messages: [{ role: 'user', content: prompt }]
      }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 180000 });
      const rawText = r.data?.content?.[0]?.text || '';
      if (rawText) {
        // Strip markdown fences if Claude wrapped the JSON
        const cleaned = rawText.trim()
          .replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
        try {
          const parsed = JSON.parse(cleaned);
          if (parsed.body_markdown) parsed.body_markdown = repairOfferClaims(parsed.body_markdown);
          if (parsed.excerpt) parsed.excerpt = repairOfferClaims(parsed.excerpt);
          if (parsed.meta_description) parsed.meta_description = truncate(repairOfferClaims(parsed.meta_description), 160);
          const issues = forbiddenOfferClaims(`${parsed.title || ''}\n${parsed.meta_description || ''}\n${parsed.excerpt || ''}\n${parsed.body_markdown || ''}`);
          if (issues.length) parsed.review_notes = `${parsed.review_notes || ''}\nAccuracy warning: ${issues.join('; ')}. Verify against NativPost pricing facts before publishing.`.trim();
          if (!parsed.body_markdown || wordCount(parsed.body_markdown) < 300) {
            console.warn('[Anthropic] Body missing/too short (' + wordCount(parsed.body_markdown || '') + ' words) — checking OpenAI fallback');
            if (!hasOpenAI) return null;
            // Fall through to OpenAI
          } else {
            // Extend if under target word count
            const wc = wordCount(parsed.body_markdown);
            if (wc < 1500 && !extended) {
              try {
                const extPrompt = `The following article body is ${wc} words. Expand it to at least 1500 words.\n\nAdd:\n1. 2-3 more detailed sentences to each existing section\n2. One additional ## section if the topic warrants it\n3. 2 more FAQ Q&A pairs with self-contained answers\n\nReturn ONLY the expanded body_markdown as plain text (no JSON wrapper, no code fences).\n\nCurrent article body:\n${parsed.body_markdown}`;
                const extR = await axios.post('https://api.anthropic.com/v1/messages', {
                  model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-5',
                  max_tokens: 8000,
                  messages: [{ role: 'user', content: extPrompt }]
                }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 120000 });
                const extText = (extR.data?.content?.[0]?.text || '').trim()
                  .replace(/^```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim();
                if (extText && wordCount(extText) > wc) {
                  parsed.body_markdown = extText;
                  console.log(`[Anthropic] Extended body from ${wc} to ${wordCount(extText)} words`);
                }
              } catch (extErr) { console.log('[Anthropic] Body extension failed:', extErr.message); }
            }
            return parsed;
          }
        } catch (parseErr) {
          console.error('[Anthropic] JSON parse error:', parseErr.message);
          console.error('[Anthropic] Response preview:', cleaned.slice(0, 300));
          if (!hasOpenAI) return null;
          // Fall through to OpenAI
        }
      }
    } catch (e) {
      console.error('[Anthropic] Article generation failed:', e.message);
      if (!hasOpenAI) throw e;
    }
  }
  if (!hasOpenAI) return null;
  const body = { model: process.env.OPENAI_MODEL || 'gpt-4.1', input: prompt, max_output_tokens: 12000 };
  try {
    const r = await axios.post('https://api.openai.com/v1/responses', body, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 120000 });
    let text = r.data.output_text || '';
    if (!text && Array.isArray(r.data.output)) text = r.data.output.flatMap(o => (o.content || []).map(c => c.text || '')).join('\n');
    text = text.trim().replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(text);
    if (parsed.body_markdown) parsed.body_markdown = repairOfferClaims(parsed.body_markdown);
    if (parsed.excerpt) parsed.excerpt = repairOfferClaims(parsed.excerpt);
    if (parsed.meta_description) parsed.meta_description = truncate(repairOfferClaims(parsed.meta_description), 160);
    const issues = forbiddenOfferClaims(`${parsed.title || ''}\n${parsed.meta_description || ''}\n${parsed.excerpt || ''}\n${parsed.body_markdown || ''}`);
    if (issues.length) parsed.review_notes = `${parsed.review_notes || ''}\nAccuracy warning: ${issues.join('; ')}. Verify against NativPost pricing facts before publishing.`.trim();
    if (!parsed.body_markdown || wordCount(parsed.body_markdown) < 500) return null;
    // If article is too thin, request an extension (one retry)
    const wc = wordCount(parsed.body_markdown);
    if (wc < 1500 && !extended) {
      try {
        const shortfall = 1600 - wc;
        const extPrompt = `The following article body is too short (${wc} words). It needs at least 1500 words minimum, ideally 1600+. You are ${shortfall} words short.\n\nExpand it by:\n1. Adding 2-3 more sentences of specific detail to each existing section\n2. Adding one more ## section if the topic warrants it\n3. Expanding the FAQ with 2 more Q&A pairs\n4. Adding more specific game/server detail in the performance section\n\nReturn ONLY the expanded body_markdown as a plain string (no JSON wrapper, no markdown fences).\n\nCurrent article body:\n${parsed.body_markdown}`;
        const extBody = { model: process.env.OPENAI_MODEL || 'gpt-4.1', input: extPrompt, max_output_tokens: 8000 };
        const extR = await axios.post('https://api.openai.com/v1/responses', extBody, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 90000 });
        let extText = extR.data.output_text || '';
        if (!extText && Array.isArray(extR.data.output)) extText = extR.data.output.flatMap(o => (o.content || []).map(c => c.text || '')).join('\n');
        extText = extText.trim().replace(/^```(?:markdown)?\s*/, '').replace(/```$/, '').trim();
        if (extText && wordCount(extText) > wc) {
          parsed.body_markdown = extText;
          console.log(`[Article] Extended from ${wc} to ${wordCount(extText)} words`);
        }
      } catch (extErr) { console.log('[Article] Extension failed:', extErr.message); }
    }
    return parsed;
  } catch (err) {
    console.error('OpenAI article generation failed:', err.response?.data || err.message);
    return null;
  }
}

function wordCount(text = '') { return String(text || '').split(/\s+/).filter(Boolean).length; }
function detectGame(text = '') {
  const lower = String(text || '').toLowerCase().replace(/[-_]+/g, ' ');
  for (const game of GAME_ALIASES) {
    if (game.patterns.some(p => lower.includes(String(p).toLowerCase().replace(/[-_]+/g, ' ')))) return game.key;
  }
  return '';
}
function intentOf(keyword = '') { const k = String(keyword).toLowerCase(); if (/buy|hosting|host|server rental|pricing|cheap|best|provider/.test(k)) return 'commercial'; if (/how|setup|configure|guide|install|mods|settings/.test(k)) return 'informational'; return 'mixed'; }
function clusterName(keyword = '') {
  const k = String(keyword || '').toLowerCase();
  // Brand cluster
  if (/nativpost|nativ post/.test(k)) return 'NativPost Brand';
  // Game-specific clusters
  const game = detectGame(k);
  if (game) return gameDisplay(game) + ' Hosting';
  // General hosting clusters
  if (/ai social media content/.test(k)) return 'AI Social Media';
  if (/dedicated server/.test(k)) return 'Dedicated Servers';
  if (/social media/.test(k)) return 'Social Media';
  if (/brand voice/.test(k)) return 'Brand Voice';
  if (/caption|post generator/.test(k)) return 'Content Generation';
  if (/scheduling|calendar|publish/.test(k)) return 'Scheduling';
  if (/ddos/.test(k)) return 'DDoS Protection';
  if (/how to.*server|setup.*server|server.*setup|server.*guide|install.*server/.test(k)) return 'Server Setup Guides';
  if (/mod|modded/.test(k)) return 'Modded Servers';
  if (/cheap|affordable|budget/.test(k)) return 'Budget Hosting';
  if (/best|top|review/.test(k)) return 'Best Hosting';
  // Fallback: first meaningful word + cluster
  const t = tokens(k).filter(x => !['server', 'servers', 'hosting', 'host', 'game', 'games', 'a', 'the', 'for', 'and', 'or', 'to', 'in', 'of'].includes(x));
  return (t.slice(0, 2).join(' ') || 'General') + ' Cluster';
}
function priorityScore({ impressions = 0, clicks = 0, position = 50, volume = 0, difficulty = 40, competitorCount = 0 } = {}) { return Math.max(1, Math.round((Number(impressions) || 0) * .03 + (Number(volume) || 0) * .2 + (60 - Math.min(Number(position) || 50, 60)) * 1.2 + Number(competitorCount || 0) * 5 - (Number(difficulty) || 0) * .4 - (Number(clicks) || 0) * .1)); }
function siteScore(s = {}) {
  // SERP component: only meaningful when avg_position < 50 (real GSC data)
  const serpScore = Number(s.avg_position || 0) > 0 ? Math.round((100 - Math.min(Number(s.avg_position), 100)) * 1.3 + Number(s.clicks || 0) * .3 + Number(s.impressions || 0) * .005) : 0;
  const contentScore = Math.round(Math.min(Number(s.articles || 0) / 500 * 100, 100) * 0.3); // 500 articles = 30 pts
  const keywordScore = Math.round(Math.min(Number(s.keyword_count || 0) / 200 * 100, 100) * 0.2); // 200 kw = 20 pts
  const crawlScore = Math.round(Math.min(Number(s.pages || 0) / 200 * 100, 100) * 0.2); // 200 pages = 20 pts
  const blScore = Math.round(Math.min(Number(s.backlinks || 0) / 50 * 100, 100) * 0.1); // 50 BL = 10 pts
  return Math.max(0, serpScore + contentScore + keywordScore + crawlScore + blScore);
}
function competitorScore(a = {}) { return Math.round((a.indexablePages || 0) * .9 + (a.contentPages || 0) * 5 + (a.keywordCount || 0) * 2.5 + (a.externalDomains || 0) * 2 + (a.hasTitle ? 10 : 0) + (a.hasMeta ? 10 : 0) + (a.hasH1 ? 8 : 0) + (a.hasRobots ? 7 : 0) + (a.hasSitemap ? 10 : 0) + Math.min(a.avgWords || 0, 2500) / 25); }
async function q(sql, params = []) { const [rows] = await pool.query(sql, dbSafeParams(params)); return rows; }
async function one(sql, params = []) { const rows = await q(sql, params); return rows[0] || null; }
async function execSafe(sql, params = []) { try { return await q(sql, params); } catch (e) { return null; } }
async function repairContentCalendarSchema() {
  await execSafe(`CREATE TABLE IF NOT EXISTS content_calendar (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, article_id INT NULL, title VARCHAR(500) NULL, target_keyword VARCHAR(255) NULL, reason TEXT NULL, status VARCHAR(80) DEFAULT 'planned', scheduled_for DATETIME NULL, scheduled_date DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN site_id INT NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN article_id INT NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN title VARCHAR(500) NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN target_keyword VARCHAR(255) NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN reason TEXT NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN status VARCHAR(80) DEFAULT 'planned'`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN scheduled_for DATETIME NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN scheduled_date DATETIME NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
  await execSafe(`ALTER TABLE content_calendar MODIFY site_id INT NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY article_id INT NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY title VARCHAR(500) NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY target_keyword VARCHAR(255) NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY reason TEXT NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY status VARCHAR(80) DEFAULT 'planned'`);
  await execSafe(`ALTER TABLE content_calendar MODIFY scheduled_for DATETIME NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY scheduled_date DATETIME NULL`);
  await execSafe(`UPDATE content_calendar SET scheduled_for=COALESCE(scheduled_for, scheduled_date), scheduled_date=COALESCE(scheduled_date, scheduled_for, created_at, NOW()) WHERE scheduled_for IS NULL OR scheduled_date IS NULL`);
}

async function insertCalendarItem({ site_id = null, title = '', target_keyword = '', reason = '', status = 'planned', scheduled_for = null } = {}) {
  await repairContentCalendarSchema();
  const scheduled = scheduled_for || scheduledDateForPlan(1);
  await q('INSERT INTO content_calendar (site_id,article_id,title,target_keyword,reason,status,scheduled_for,scheduled_date) VALUES (?,?,?,?,?,?,?,?)', [site_id || null, null, title || articleTitleFor(target_keyword || 'ai social media content'), target_keyword || title || 'ai social media content', reason || null, status || 'planned', scheduled, scheduled]);
}

// ── Theme preference helpers ─────────────────────────────────────────────
const VALID_THEMES = ['np-purple', 'classic-purple'];
async function getUserTheme(userId) {
  if (!userId) return 'np-purple';
  try {
    const row = await one('SELECT theme FROM user_preferences WHERE user_id=?', [userId]);
    const t = row?.theme || 'np-purple';
    return VALID_THEMES.includes(t) ? t : 'np-purple';
  } catch { return 'np-purple'; }
}
async function setUserTheme(userId, theme) {
  if (!userId) return;
  if (!VALID_THEMES.includes(theme)) theme = 'np-purple';
  await execSafe(
    'INSERT INTO user_preferences (user_id, theme) VALUES (?, ?) ON DUPLICATE KEY UPDATE theme=VALUES(theme)',
    [userId, theme]
  );
}

// Theme-injecting middleware — attaches the current user's theme to res.locals
// so every render() call gets userTheme without having to touch 20 routes.
// Note: registered after requireAuth, below. For the login page and pre-auth
// routes that use res.send() directly, the default theme is baked into CSS.
function injectUserTheme(req, res, next) {
  (async () => {
    try {
      res.locals.userTheme = req.user ? await getUserTheme(req.user.id) : 'np-purple';
    } catch { res.locals.userTheme = 'np-purple'; }
    next();
  })();
}

function render(res, view, data = {}) { const baseMonth = { label: 'Current Month', weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], cells: [] }; res.render(view, { i: /./, currentPath: '', message: null, aiConnected: !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY), openaiConnected: !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY), sites: [], pages: [], competitors: [], assets: [], keywords: [], articles: [], reports: [], metrics: [], backlinks: [], gaps: [], calendar: [], month: baseMonth, supportedGames: [], gameRecommendations: [], ownRanked: [], compRanked: [], stats: {}, env: {}, audit: {}, status: '', articleHtml: '', article: null, appTimezone: APP_TIMEZONE, autoPublishIntervalMinutes: AUTO_PUBLISH_INTERVAL_MINUTES, autoPublishDailyLimit: AUTO_PUBLISH_DAILY_LIMIT, minQualityScore: MIN_QUALITY_SCORE, autoPublishEnabled: AUTO_PUBLISH_ENABLED, formatAppDateTime, schedulePublishLabel, publishedLabel, userTheme: res.locals?.userTheme || 'np-purple', currentUser: res.locals?.currentUser || null, ...data, currentPath: data.currentPath || '', message: data.message || null }); }

async function ensureSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS sites (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, url TEXT NOT NULL, gsc_property VARCHAR(500) NULL, ga4_property_id VARCHAR(120) NULL, cms_type VARCHAR(80) DEFAULT 'contentful', active TINYINT DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS site_pages (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NOT NULL, page_url TEXT NOT NULL, page_title VARCHAR(500) NULL, meta_description TEXT NULL, h1_text VARCHAR(500) NULL, page_type VARCHAR(80) DEFAULT 'page', word_count INT DEFAULT 0, status_code INT DEFAULT 200, last_scanned_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uniq_site_page (site_id, page_url(450)))`,
    `CREATE TABLE IF NOT EXISTS competitors (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, name VARCHAR(255) NULL, url TEXT NULL, competitor_name VARCHAR(255) NULL, competitor_url TEXT NULL, homepage_title VARCHAR(500) NULL, audit_score DECIMAL(10,2) DEFAULT 0, snapshot_json LONGTEXT NULL, last_audited_at DATETIME NULL, active TINYINT DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS competitor_pages (id INT AUTO_INCREMENT PRIMARY KEY, competitor_id INT NOT NULL, page_url TEXT NOT NULL, page_title VARCHAR(500) NULL, meta_description TEXT NULL, h1_text VARCHAR(500) NULL, page_type VARCHAR(80) DEFAULT 'page', word_count INT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uniq_comp_page (competitor_id, page_url(450)))`,
    `CREATE TABLE IF NOT EXISTS articles (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, keyword_id INT NULL, title VARCHAR(500) NULL, slug VARCHAR(500) NULL, status VARCHAR(50) DEFAULT 'draft', primary_keyword VARCHAR(255) NULL, meta_title VARCHAR(500) NULL, meta_description TEXT NULL, excerpt TEXT NULL, body LONGTEXT NULL, content LONGTEXT NULL, featured_image_id INT NULL, featured_image_url TEXT NULL, featured_image_alt VARCHAR(255) NULL, review_notes TEXT NULL, quality_score DECIMAL(10,2) DEFAULT 0, contentful_entry_id VARCHAR(128) NULL, published_url TEXT NULL, scheduled_for DATETIME NULL, reviewed_at DATETIME NULL, published_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS article_assets (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, label VARCHAR(255) NOT NULL, game_slug VARCHAR(120) NULL, folder_name VARCHAR(120) NULL, asset_url TEXT NOT NULL, alt_text VARCHAR(255) NULL, contentful_asset_id VARCHAR(120) NULL, source_url TEXT NULL, source_hash VARCHAR(64) NULL, file_sha256 VARCHAR(64) NULL, source_page TEXT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS keywords (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, keyword VARCHAR(500) NOT NULL, cluster_name VARCHAR(255) NULL, volume INT DEFAULT 0, difficulty DECIMAL(10,2) DEFAULT 0, priority_score DECIMAL(10,2) DEFAULT 0, source VARCHAR(120) DEFAULT 'manual', intent VARCHAR(80) NULL, last_updated DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uniq_site_keyword (site_id, keyword(255)))`,
    `CREATE TABLE IF NOT EXISTS rankings (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, keyword VARCHAR(500) NOT NULL, page_url TEXT NULL, position DECIMAL(10,2) NULL, clicks INT DEFAULT 0, impressions INT DEFAULT 0, ctr DECIMAL(8,4) DEFAULT 0, recorded_on DATE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS backlinks (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, competitor_id INT NULL, source_domain VARCHAR(255) NULL, source_url TEXT NULL, target_url TEXT NULL, anchor_text VARCHAR(255) NULL, authority_score DECIMAL(10,2) DEFAULT 0, status VARCHAR(80) DEFAULT 'opportunity', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS content_calendar (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, article_id INT NULL, title VARCHAR(500) NULL, target_keyword VARCHAR(255) NULL, reason TEXT NULL, status VARCHAR(80) DEFAULT 'planned', scheduled_for DATETIME NULL, scheduled_date DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS game_recommendations (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, game VARCHAR(120) NULL, title VARCHAR(500) NULL, source_url TEXT NULL, source_title VARCHAR(500) NULL, reason TEXT NULL, opportunity_score DECIMAL(10,2) DEFAULT 0, status VARCHAR(80) DEFAULT 'recommended', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uniq_game_reco (site_id, game))`,
    `CREATE TABLE IF NOT EXISTS page_metrics (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, page_path VARCHAR(1024) NOT NULL, page_title VARCHAR(500) NULL, sessions INT DEFAULT 0, views INT DEFAULT 0, engagement_rate DECIMAL(10,4) DEFAULT 0, report_date DATE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS seo_report_snapshots (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, snapshot_type VARCHAR(80) NOT NULL, score DECIMAL(10,2) DEFAULT 0, payload_json LONGTEXT NULL, recorded_on DATE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS automations (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, name VARCHAR(255) NOT NULL, kind VARCHAR(80) NOT NULL, enabled TINYINT DEFAULT 1, settings_json LONGTEXT NULL, last_run_at DATETIME NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS serp_results (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, keyword VARCHAR(255) NOT NULL, query_text VARCHAR(500) NULL, result_title VARCHAR(500) NULL, result_url TEXT NULL, snippet TEXT NULL, headings_json LONGTEXT NULL, questions_json LONGTEXT NULL, entities_json LONGTEXT NULL, word_count INT DEFAULT 0, position INT DEFAULT 0, provider VARCHAR(80) DEFAULT 'duckduckgo', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS serp_cache (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, keyword VARCHAR(255) NOT NULL, provider VARCHAR(80) NOT NULL DEFAULT 'dataforseo', summary_json LONGTEXT NULL, fetched_at DATETIME NOT NULL, expires_at DATETIME NOT NULL, search_volume INT DEFAULT 0, keyword_difficulty DECIMAL(5,2) DEFAULT 0, serp_features_json LONGTEXT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uniq_serp_cache (site_id, keyword(250), provider))`,
    `CREATE TABLE IF NOT EXISTS topic_clusters (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, cluster_name VARCHAR(255) NOT NULL, primary_keyword VARCHAR(255) NULL, intent VARCHAR(80) NULL, status VARCHAR(80) DEFAULT 'active', notes TEXT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY uniq_cluster (site_id, cluster_name))`
  ];
  for (const s of statements) await execSafe(s);
  await repairContentCalendarSchema();
  await execSafe(`ALTER DATABASE \`${process.env.DB_NAME || 'seoapp'}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  for (const t of ['sites', 'site_pages', 'competitors', 'competitor_pages', 'articles', 'article_assets', 'keywords', 'rankings', 'backlinks', 'content_calendar', 'game_recommendations', 'page_metrics', 'seo_report_snapshots', 'automations', 'serp_results', 'serp_cache', 'topic_clusters']) {
    await execSafe(`ALTER TABLE ${t} CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  }
  await execSafe(`ALTER TABLE competitors MODIFY homepage_title VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL`);
  await execSafe(`ALTER TABLE competitors MODIFY snapshot_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL`);
  await execSafe(`ALTER TABLE competitor_pages MODIFY page_title VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL`);
  // v86+ migrations — safe to run repeatedly, execSafe ignores "duplicate column" errors
  await execSafe(`ALTER TABLE serp_results ADD COLUMN position INT DEFAULT 0`);
  await execSafe(`ALTER TABLE serp_results ADD COLUMN provider VARCHAR(80) DEFAULT 'duckduckgo'`);
  await execSafe(`ALTER TABLE rankings ADD COLUMN page_url TEXT NULL`);
  await execSafe(`ALTER TABLE rankings ADD COLUMN ctr DECIMAL(8,4) DEFAULT 0`);
  await execSafe(`ALTER TABLE backlinks ADD COLUMN domain_rating DECIMAL(5,2) DEFAULT 0`);
  await execSafe(`ALTER TABLE backlinks ADD COLUMN outreach_notes TEXT NULL`);
  await execSafe(`ALTER TABLE backlinks ADD COLUMN last_contacted_at DATETIME NULL`);
  // np_package_cache — caches scraped pricing data from NativPost pages (24h TTL)
  await execSafe(`CREATE TABLE IF NOT EXISTS igh_package_cache (
    id INT AUTO_INCREMENT PRIMARY KEY,
    game_key VARCHAR(120) NOT NULL UNIQUE,
    page_url VARCHAR(500) NOT NULL,
    packages_text TEXT NULL,
    raw_prices TEXT NULL,
    fetched_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL
  )`);
  // ranking_history — per-day position snapshots for trend charts
  await execSafe(`CREATE TABLE IF NOT EXISTS ranking_history (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, keyword VARCHAR(500) NOT NULL, page_url TEXT NULL, position DECIMAL(10,2) NULL, clicks INT DEFAULT 0, impressions INT DEFAULT 0, recorded_on DATE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uniq_rh (site_id, keyword(250), recorded_on))`);
  await execSafe(`ALTER TABLE serp_results ADD COLUMN provider VARCHAR(80) DEFAULT 'duckduckgo'`);
  await execSafe(`ALTER TABLE competitor_pages MODIFY meta_description TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL`);
  await execSafe(`ALTER TABLE competitor_pages MODIFY h1_text VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL`);
  const alters = [
    ['sites', 'cms_type', `ALTER TABLE sites ADD COLUMN cms_type VARCHAR(80) DEFAULT 'contentful'`], ['sites', 'active', `ALTER TABLE sites ADD COLUMN active TINYINT DEFAULT 1`],
    ['competitors', 'name', `ALTER TABLE competitors ADD COLUMN name VARCHAR(255) NULL`], ['competitors', 'url', `ALTER TABLE competitors ADD COLUMN url TEXT NULL`], ['competitors', 'homepage_title', `ALTER TABLE competitors ADD COLUMN homepage_title VARCHAR(500) NULL`], ['competitors', 'audit_score', `ALTER TABLE competitors ADD COLUMN audit_score DECIMAL(10,2) DEFAULT 0`], ['competitors', 'snapshot_json', `ALTER TABLE competitors ADD COLUMN snapshot_json LONGTEXT NULL`], ['competitors', 'last_audited_at', `ALTER TABLE competitors ADD COLUMN last_audited_at DATETIME NULL`], ['competitors', 'active', `ALTER TABLE competitors ADD COLUMN active TINYINT DEFAULT 1`],
    ['articles', 'primary_keyword', `ALTER TABLE articles ADD COLUMN primary_keyword VARCHAR(255) NULL`], ['articles', 'body', `ALTER TABLE articles ADD COLUMN body LONGTEXT NULL`], ['articles', 'content', `ALTER TABLE articles ADD COLUMN content LONGTEXT NULL`], ['articles', 'quality_score', `ALTER TABLE articles ADD COLUMN quality_score DECIMAL(10,2) DEFAULT 0`], ['articles', 'featured_image_id', `ALTER TABLE articles ADD COLUMN featured_image_id INT NULL`], ['articles', 'featured_image_alt', `ALTER TABLE articles ADD COLUMN featured_image_alt VARCHAR(255) NULL`], ['articles', 'review_notes', `ALTER TABLE articles ADD COLUMN review_notes TEXT NULL`], ['articles', 'scheduled_for', `ALTER TABLE articles ADD COLUMN scheduled_for DATETIME NULL`],
    ['keywords', 'intent', `ALTER TABLE keywords ADD COLUMN intent VARCHAR(80) NULL`], ['keywords', 'source', `ALTER TABLE keywords ADD COLUMN source VARCHAR(120) DEFAULT 'manual'`], ['keywords', 'cluster_name', `ALTER TABLE keywords ADD COLUMN cluster_name VARCHAR(255) NULL`], ['keywords', 'priority_score', `ALTER TABLE keywords ADD COLUMN priority_score DECIMAL(10,2) DEFAULT 0`], ['keywords', 'volume', `ALTER TABLE keywords ADD COLUMN volume INT DEFAULT 0`], ['keywords', 'difficulty', `ALTER TABLE keywords ADD COLUMN difficulty DECIMAL(10,2) DEFAULT 0`], ['keywords', 'last_updated', `ALTER TABLE keywords ADD COLUMN last_updated DATETIME NULL`],
    ['site_pages', 'page_type', `ALTER TABLE site_pages ADD COLUMN page_type VARCHAR(80) DEFAULT 'page'`], ['site_pages', 'word_count', `ALTER TABLE site_pages ADD COLUMN word_count INT DEFAULT 0`], ['site_pages', 'status_code', `ALTER TABLE site_pages ADD COLUMN status_code INT DEFAULT 200`], ['site_pages', 'last_scanned_at', `ALTER TABLE site_pages ADD COLUMN last_scanned_at DATETIME NULL`], ['site_pages', 'meta_description', `ALTER TABLE site_pages ADD COLUMN meta_description TEXT NULL`], ['site_pages', 'h1_text', `ALTER TABLE site_pages ADD COLUMN h1_text VARCHAR(500) NULL`],
    ['competitor_pages', 'page_type', `ALTER TABLE competitor_pages ADD COLUMN page_type VARCHAR(80) DEFAULT 'page'`], ['competitor_pages', 'word_count', `ALTER TABLE competitor_pages ADD COLUMN word_count INT DEFAULT 0`], ['competitor_pages', 'meta_description', `ALTER TABLE competitor_pages ADD COLUMN meta_description TEXT NULL`], ['competitor_pages', 'h1_text', `ALTER TABLE competitor_pages ADD COLUMN h1_text VARCHAR(500) NULL`]
  ];
  for (const [, , sql] of alters) await execSafe(sql);

  await execSafe(`ALTER TABLE competitors MODIFY site_id INT NULL`);
  await execSafe(`ALTER TABLE articles MODIFY site_id INT NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY site_id INT NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY article_id INT NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY title VARCHAR(500) NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY target_keyword VARCHAR(255) NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY reason TEXT NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY status VARCHAR(80) DEFAULT 'planned'`);
  await execSafe(`ALTER TABLE content_calendar MODIFY scheduled_for DATETIME NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN scheduled_date DATETIME NULL`);
  await execSafe(`ALTER TABLE content_calendar MODIFY scheduled_date DATETIME NULL`);
  await execSafe(`ALTER TABLE articles ADD COLUMN keyword_id INT NULL`);
  await execSafe(`ALTER TABLE articles ADD COLUMN meta_title VARCHAR(500) NULL`);
  await execSafe(`ALTER TABLE articles ADD COLUMN meta_description TEXT NULL`);
  await execSafe(`ALTER TABLE articles ADD COLUMN excerpt TEXT NULL`);
  await execSafe(`ALTER TABLE articles ADD COLUMN featured_image_url TEXT NULL`);
  await execSafe(`ALTER TABLE articles ADD COLUMN contentful_entry_id VARCHAR(128) NULL`);
  await execSafe(`ALTER TABLE articles ADD COLUMN published_url TEXT NULL`);
  await execSafe(`ALTER TABLE articles ADD COLUMN reviewed_at DATETIME NULL`);
  await execSafe(`ALTER TABLE articles ADD COLUMN published_at DATETIME NULL`);
  await execSafe(`ALTER TABLE articles ADD COLUMN schema_json LONGTEXT NULL`);
  await execSafe(`ALTER TABLE articles ADD COLUMN cannibalization_penalty DECIMAL(10,2) DEFAULT 0`);
  // Internal link suggestions — each row is an opportunity to insert a link FROM
  // an old published article TO a newer one. Status = pending | applied | rejected.
  await execSafe(`CREATE TABLE IF NOT EXISTS internal_link_suggestions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    source_article_id INT NOT NULL,
    target_article_id INT NOT NULL,
    match_phrase VARCHAR(255) NOT NULL,
    anchor_text VARCHAR(255) NULL,
    target_url TEXT NULL,
    status VARCHAR(40) DEFAULT 'pending',
    reason VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    applied_at DATETIME NULL,
    UNIQUE KEY uniq_link_suggestion (source_article_id, target_article_id, match_phrase(180))
  )`);
  await execSafe(`CREATE INDEX idx_ils_status ON internal_link_suggestions (status)`);
  await execSafe(`CREATE INDEX idx_ils_target ON internal_link_suggestions (target_article_id)`);
  await execSafe(`CREATE TABLE IF NOT EXISTS daily_brief (
    id INT AUTO_INCREMENT PRIMARY KEY,
    brief_date DATE NOT NULL,
    recommendations_json LONGTEXT NOT NULL,
    summary TEXT NULL,
    generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_brief_date (brief_date)
  )`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN site_id INT NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN title VARCHAR(500) NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN article_id INT NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN target_keyword VARCHAR(255) NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN status VARCHAR(80) DEFAULT 'planned'`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN reason TEXT NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN scheduled_for DATETIME NULL`);
  await execSafe(`ALTER TABLE content_calendar ADD COLUMN scheduled_date DATETIME NULL`);
  await execSafe(`ALTER TABLE article_assets ADD COLUMN source_url TEXT NULL`);
  await execSafe(`ALTER TABLE article_assets ADD COLUMN source_hash VARCHAR(64) NULL`);
  await execSafe(`ALTER TABLE article_assets ADD COLUMN file_sha256 VARCHAR(64) NULL`);
  await execSafe(`ALTER TABLE article_assets ADD COLUMN source_page TEXT NULL`);
  await execSafe(`CREATE INDEX idx_article_assets_game_source_hash ON article_assets (game_slug, source_hash)`);
  await execSafe(`CREATE INDEX idx_article_assets_game_file_hash ON article_assets (game_slug, file_sha256)`);
  await execSafe(`CREATE TABLE IF NOT EXISTS game_recommendations (id INT AUTO_INCREMENT PRIMARY KEY, site_id INT NULL, game VARCHAR(120) NULL, title VARCHAR(500) NULL, source_url TEXT NULL, source_title VARCHAR(500) NULL, reason TEXT NULL, opportunity_score DECIMAL(10,2) DEFAULT 0, status VARCHAR(80) DEFAULT 'recommended', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uniq_game_reco (site_id, game))`);
  await execSafe(`ALTER TABLE game_recommendations ADD COLUMN site_id INT NULL`);
  await execSafe(`ALTER TABLE game_recommendations ADD COLUMN game VARCHAR(120) NULL`);
  await execSafe(`ALTER TABLE game_recommendations ADD COLUMN title VARCHAR(500) NULL`);
  await execSafe(`ALTER TABLE game_recommendations ADD COLUMN source_url TEXT NULL`);
  await execSafe(`ALTER TABLE game_recommendations ADD COLUMN source_title VARCHAR(500) NULL`);
  await execSafe(`ALTER TABLE game_recommendations ADD COLUMN reason TEXT NULL`);
  await execSafe(`ALTER TABLE game_recommendations ADD COLUMN opportunity_score DECIMAL(10,2) DEFAULT 0`);
  await execSafe(`ALTER TABLE game_recommendations ADD COLUMN status VARCHAR(80) DEFAULT 'recommended'`);
  await execSafe(`ALTER TABLE game_recommendations ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
  await execSafe(`ALTER TABLE game_recommendations MODIFY site_id INT NULL`);
  await execSafe(`ALTER TABLE game_recommendations MODIFY game VARCHAR(120) NULL`);
  await execSafe(`ALTER TABLE game_recommendations MODIFY title VARCHAR(500) NULL`);
  await execSafe(`UPDATE competitors SET name=COALESCE(name, competitor_name), url=COALESCE(url, competitor_url) WHERE name IS NULL OR url IS NULL`);
  await execSafe(`UPDATE articles SET body=COALESCE(body, content), primary_keyword=COALESCE(primary_keyword, (SELECT keyword FROM keywords WHERE keywords.id=articles.keyword_id LIMIT 1)) WHERE body IS NULL OR primary_keyword IS NULL`);
  await cleanupDuplicates();
  // Fix primary_keywords that contain competitor brand names from early bad generations
  await execSafe(`UPDATE articles SET primary_keyword = TRIM(REGEXP_REPLACE(primary_keyword, ' - (game host bros|gamehostbros|nitrado|gportal|shockbyte|bisecthosting|bisect hosting|hosthavoc|nodecraft).*$', '')) WHERE primary_keyword REGEXP '(game host bros|gamehostbros|nitrado|gportal|shockbyte|bisecthosting|bisect hosting|hosthavoc|nodecraft)'`);
  await cleanupBrokenLocalPressKitAssets();
  await cleanupBrokenArticleImageRefs();
  await ensureAuthTables();

  // ── v107 additions ─────────────────────────────────────────────────────
  // Per-user preferences (theme, notifications, etc). Keyed by user_id.
  await execSafe(`CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INT PRIMARY KEY,
    theme VARCHAR(40) DEFAULT 'np-purple',
    prefs_json LONGTEXT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);

  // Email-verified reset codes (replaces the old token-on-screen flow).
  await execSafe(`CREATE TABLE IF NOT EXISTS auth_reset_codes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    code_hash VARCHAR(128) NOT NULL,
    email VARCHAR(255) NOT NULL,
    expires_at DATETIME NOT NULL,
    attempts INT DEFAULT 0,
    used TINYINT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_arc_user (user_id),
    INDEX idx_arc_expires (expires_at)
  )`);

  // Keyword Opportunity Radar — auto-populated from SERP and competitor crawls.
  await execSafe(`CREATE TABLE IF NOT EXISTS game_expansion_radar (
    id INT AUTO_INCREMENT PRIMARY KEY,
    game_key VARCHAR(120) NOT NULL UNIQUE,
    game_label VARCHAR(255) NOT NULL,
    steam_app_id VARCHAR(40) NULL,
    release_date VARCHAR(40) NULL,
    source VARCHAR(40) DEFAULT 'steam',
    signal_score DECIMAL(10,2) DEFAULT 0,
    serp_competition DECIMAL(10,2) DEFAULT 0,
    search_volume INT DEFAULT 0,
    opportunity_score DECIMAL(10,2) DEFAULT 0,
    reason TEXT NULL,
    evidence_json LONGTEXT NULL,
    status VARCHAR(40) DEFAULT 'pending',
    dismissed_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_gxr_status (status),
    INDEX idx_gxr_score (opportunity_score)
  )`);

  // Backlink prospects from DataForSEO discovery. Separate from manual backlinks
  // CRM so we don't pollute earned/opportunity tracking with raw discovery data.
  await execSafe(`CREATE TABLE IF NOT EXISTS backlink_prospects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    site_id INT NULL,
    source_domain VARCHAR(255) NOT NULL,
    domain_rank INT DEFAULT 0,
    backlinks_count INT DEFAULT 0,
    referring_pages INT DEFAULT 0,
    linked_competitors TEXT NULL,
    competitor_count INT DEFAULT 0,
    first_seen DATE NULL,
    spam_score INT DEFAULT 0,
    prospect_score DECIMAL(10,2) DEFAULT 0,
    discovery_source VARCHAR(40) DEFAULT 'link_gap',
    status VARCHAR(40) DEFAULT 'new',
    notes TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_prospect (site_id, source_domain(240)),
    INDEX idx_bp_status (status),
    INDEX idx_bp_score (prospect_score)
  )`);

  // API balance snapshot cache — we cache for 5 minutes so the Reports page
  // renders instantly without hammering vendor balance endpoints.
  await execSafe(`CREATE TABLE IF NOT EXISTS api_balance_cache (
    service VARCHAR(40) PRIMARY KEY,
    balance DECIMAL(12,4) NULL,
    currency VARCHAR(10) DEFAULT 'USD',
    status VARCHAR(40) DEFAULT 'unknown',
    details_json LONGTEXT NULL,
    fetched_at DATETIME NOT NULL,
    error_message TEXT NULL
  )`);
}

async function cleanupDuplicates() {
  await execSafe(`DELETE s1 FROM sites s1 JOIN sites s2 ON LOWER(TRIM(TRAILING '/' FROM s1.url))=LOWER(TRIM(TRAILING '/' FROM s2.url)) AND s1.id>s2.id`);
  await execSafe(`UPDATE sites SET name='NativPost' WHERE LOWER(url) LIKE '%nativpost%' -- LOWER(name) IN ('everwind','igh','initial website')`);
  await execSafe(`DELETE c1 FROM competitors c1 JOIN competitors c2 ON LOWER(TRIM(TRAILING '/' FROM COALESCE(c1.url,c1.competitor_url)))=LOWER(TRIM(TRAILING '/' FROM COALESCE(c2.url,c2.competitor_url))) AND c1.id>c2.id`);
  await execSafe(`DELETE FROM sites WHERE LOWER(name)='everwind' AND LOWER(url) LIKE '%nativpost%'`);
  // Remove NativPost itself from competitors list — it should never be tracked as a competitor
  await execSafe(`DELETE FROM competitors WHERE LOWER(COALESCE(url,competitor_url,'')) LIKE '%nativpost.com%'`);
  await execSafe(`DELETE sp1 FROM site_pages sp1 JOIN site_pages sp2 ON sp1.site_id=sp2.site_id AND sp1.page_url=sp2.page_url AND sp1.id>sp2.id`);
  await execSafe(`DELETE cp1 FROM competitor_pages cp1 JOIN competitor_pages cp2 ON cp1.competitor_id=cp2.competitor_id AND cp1.page_url=cp2.page_url AND cp1.id>cp2.id`);
  await execSafe(`DELETE r1 FROM seo_report_snapshots r1 JOIN seo_report_snapshots r2 ON r1.site_id<=>r2.site_id AND r1.snapshot_type=r2.snapshot_type AND r1.recorded_on=r2.recorded_on AND r1.id<r2.id`);
  // Purge garbage single-word keywords and known-bad terms from keyword table
  await execSafe(`DELETE FROM keywords WHERE LOWER(keyword) IN ('nitrado','gportal','shockbyte','und','oder','mieten','sofort','gameserver','spieleserver','nstig','inventory','being','sorted','everything','ready','soon','available','features','includes','plans','pricing','choose','compare')`);
  // Delete any keyword that is a single word and doesn't contain a game name or hosting term
  // NativPost: keep all multi-word keywords — no game-specific filtering
  await execSafe(`UPDATE articles a JOIN article_assets aa ON aa.id=a.featured_image_id SET a.featured_image_id=NULL, a.featured_image_url=NULL WHERE LOWER(COALESCE(aa.label,'')) LIKE '%press kit%' AND aa.asset_url NOT LIKE '/uploads/%'`);
  await execSafe(`DELETE FROM article_assets WHERE LOWER(COALESCE(label,'')) LIKE '%press kit%' AND asset_url NOT LIKE '/uploads/%'`);
}


async function fetchUrl(url, timeout = 14000) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
  };
  // When crawling via localhost, nginx needs the real Host header to route correctly.
  // Without it, nginx returns 404 because it doesn't know which vhost to serve.
  const isInternal = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i.test(url);
  if (isInternal && CRAWL_BASE_URL) {
    // Use SITE_HOST env if set, otherwise extract from the first active site URL in DB
    // APP_URL is the SEO tool itself — never use it as the crawl Host header
    const siteHost = process.env.SITE_HOST || 'nativpost.com';
    headers['Host'] = siteHost;
  }
  const httpsAgent = isInternal ? new (require('https').Agent)({ rejectUnauthorized: false }) : undefined;
  try {
    const { data, status } = await axios.get(url, { timeout, maxRedirects: 8, headers, validateStatus: s => s >= 200 && s < 600, decompress: true, httpsAgent });
    if (status === 403 || status === 429 || status === 503) {
      await new Promise(r => setTimeout(r, 1500));
      const r2 = await axios.get(url, { timeout: timeout + 5000, maxRedirects: 8, headers: { ...headers, 'Referer': 'https://www.google.com/', 'Sec-Fetch-Site': 'cross-site' }, validateStatus: s => s >= 200 && s < 600, decompress: true, httpsAgent });
      return { html: String(r2.data || ''), status: r2.status };
    }
    return { html: String(data || ''), status };
  } catch (e) {
    if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') throw new Error('Site unreachable: ' + e.code);
    if (e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED') throw new Error('Connection timed out');
    throw e;
  }
}
async function discoverFromSitemap(root) {
  const base = originOf(root); const urls = [];
  for (const p of ['/sitemap.xml', '/sitemap_index.xml', '/post-sitemap.xml', '/page-sitemap.xml']) {
    try {
      const { html } = await fetchUrl(base + p, 7000);
      for (const m of html.matchAll(/<loc>([^<]+)<\/loc>/gi)) urls.push(m[1].trim());
      if (urls.length) break;
    } catch { }
  }
  return [...new Set(urls)].slice(0, 100);
}
function classifyPage(url = '', title = '', text = '') {
  const x = (url + ' ' + title + ' ' + text.slice(0, 200)).toLowerCase();
  if (/blog|article|guide|knowledge|news|post|tutorial|how-to|settings/.test(x)) return 'blog';
  if (/pricing|store|cart|order|buy|checkout/.test(x)) return 'money';
  if (/support|contact|billing|faq|help|ticket/.test(x)) return 'support';
  // Catch game pages: any known game name near hosting/server context, or /game/ URL pattern
  const hasGameName = GAME_ALIASES.some(g => g.patterns.some(p => x.includes(p.toLowerCase())));
  if (hasGameName || /\/games?\/|server-hosting|game-server|dedicated.server/.test(x)) return 'game';
  if (/hosting|vps|cloud|server|deploy/.test(x)) return 'money';
  return 'page';
}
async function crawlWebsite(root, maxPages = 30) {
  const start = normalizeUrl(root);
  const rootHost = hostOf(start);
  // When CRAWL_BASE_URL is set, we crawl via localhost but store public URLs.
  // publicHost = nativpost.com, crawlHost = localhost
  const crawlOrigin = CRAWL_BASE_URL ? originOf(CRAWL_BASE_URL) : null;
  const crawlHost = crawlOrigin ? hostOf(crawlOrigin) : rootHost;
  const publicOrigin = crawlOrigin ? originOf(start.replace(crawlOrigin, '') ? start : start) : null;

  // Rewrite a public URL to its crawl equivalent
  function toCrawlUrl(url) {
    if (!crawlOrigin) return url;
    try {
      const u = new URL(url);
      const publicHost = crawlOrigin ? hostOf(process.env.SITE_HOST || 'nativpost.com') : rootHost;
      // Convert both localhost URLs and public domain URLs to the crawl base
      if (u.hostname === rootHost || u.hostname === publicHost || u.hostname === (process.env.SITE_HOST || '')) {
        u.protocol = new URL(crawlOrigin).protocol;
        u.hostname = new URL(crawlOrigin).hostname;
        u.port = new URL(crawlOrigin).port;
        return u.toString();
      }
    } catch { }
    return url;
  }

  // Rewrite a crawl URL back to public for storage
  function toPublicUrl(url) {
    if (!crawlOrigin || !publicOrigin) return url;
    try {
      const u = new URL(url);
      if (u.hostname === crawlHost || u.hostname === 'localhost') {
        const pub = new URL(start);
        u.protocol = pub.protocol;
        u.hostname = pub.hostname;
        u.port = pub.port || '';
        return u.toString().replace(/\/$/, '');
      }
    } catch { }
    return url;
  }

  // Seed queue with known pages — critical for Vite/React SPAs with no extractable links
  const sitemapUrls = await discoverFromSitemap(start);
  const knownGameUrls = [];
  try {
    // ONLY use live_games table — NativPost platforms/features
    const liveRows = Promise.resolve([]);
    for (const r of liveRows) {
      const publicGameUrl = r.igh_page_url ||
        `${publicOrigin || originOf(start)}/game/${r.game_key.replace(/\s+/g, '-')}-server-hosting`;
      // toCrawlUrl converts public URL to https://localhost/... so it passes rootHost check
      knownGameUrls.push(toCrawlUrl(publicGameUrl));
    }
    // Standard non-game pages as crawl URLs
    for (const p of ['/games', '/about', '/blog', '/affiliate', '/terms', '/privacy', '/support']) {
      knownGameUrls.push(`${originOf(start)}${p}`);
    }
  } catch (e) { }
  const rawQueue = [start, ...sitemapUrls, ...knownGameUrls];
  // Deduplicate by path only — ignore whether URL uses localhost or public domain
  // since toCrawlUrl converts both to localhost anyway
  const seenPaths = new Set();
  const queue = rawQueue.filter(u => {
    try {
      const path = new URL(normalizeUrl(u)).pathname.toLowerCase().replace(/\/$/, '') || '/';
      if (seenPaths.has(path)) return false;
      seenPaths.add(path);
      return true;
    } catch { return false; }
  }).map(u => toCrawlUrl(normalizeUrl(u))); // convert all to crawl URLs upfront
  const seen = new Set(); // fresh - queue dedup handled by seenInit filter above
  const pages = [];
  const allText = [];
  let homepage = null;
  let images = [];
  let externalDomains = new Set();

  while (queue.length && pages.length < maxPages) {
    const rawUrl = queue.shift();
    if (!rawUrl) continue;
    // Normalise to public URL for dedup/storage, crawl URL for fetching
    const publicUrl = toPublicUrl(normalizeUrl(rawUrl));
    const fetchTarget = toCrawlUrl(publicUrl);
    if (!publicUrl || seen.has(publicUrl)) continue;
    seen.add(publicUrl);
    // Only crawl pages on our own domain (localhost when CRAWL_BASE_URL set, or public host)
    const siteHost = process.env.SITE_HOST || 'nativpost.com';
    if (hostOf(publicUrl) !== rootHost && hostOf(publicUrl) !== siteHost) continue;
    try {
      const { html, status } = await fetchUrl(fetchTarget, 12000);
      const text = stripHtml(html);
      const title = extractTitle(html);
      const h1 = extractH1(html);
      const meta = extractMeta(html);
      const links = extractLinks(html, fetchTarget);
      if (!homepage) homepage = { html, text, title, h1, meta, status };
      try { images = images.concat(extractImages(html, fetchTarget)); } catch (imgErr) { /* image extraction failed - non-fatal */ }
      for (const l of links) {
        const lPublic = toPublicUrl(normalizeUrl(l));
        if (hostOf(lPublic) === rootHost && !seen.has(lPublic) && queue.length < maxPages * 6) {
          queue.push(lPublic);
        } else if (hostOf(lPublic) !== rootHost) {
          externalDomains.add(hostOf(lPublic));
        }
      }
      const canonical = extractCanonical(html, publicUrl);
      const derivedTitle = title || h1 || titleFromUrl(publicUrl) || publicUrl;
      pages.push({ page_url: publicUrl, page_title: derivedTitle, meta_description: meta, h1_text: h1, page_type: classifyPage(publicUrl, derivedTitle, text), word_count: wordCount(text), status_code: status, sample: text.slice(0, 1500), canonical });
      allText.push(`${derivedTitle} ${h1} ${meta} ${text.slice(0, 3000)}`);
    } catch (e) {
      console.error(`[Crawl] Error on ${publicUrl}: ${e.message}\n${e.stack}`);
      pages.push({ page_url: publicUrl, page_title: 'Crawl failed', meta_description: e.message + (e.stack ? ' | ' + e.stack.split('\n')[1] : ''), h1_text: '', page_type: 'error', word_count: 0, status_code: 0, sample: '' });
    }
  }
  let hasRobots = false, hasSitemap = false;
  const crawlBase = crawlOrigin || originOf(start);
  try { const { html } = await fetchUrl(crawlBase + '/robots.txt', 5000); hasRobots = /user-agent/i.test(html); hasSitemap = /sitemap:/i.test(html); } catch { }
  if (!hasSitemap) { try { const { html } = await fetchUrl(crawlBase + '/sitemap.xml', 5000); hasSitemap = /<urlset|<sitemapindex/i.test(html); } catch { } }
  const cleanPages = []; const seenUrls = new Set();
  for (const p of pages) {
    const key = normalizeUrl(p.page_url); if (seenUrls.has(key)) continue; seenUrls.add(key);
    if (homepage?.title && p.page_title === homepage.title && pathOf(p.page_url) !== '/' && pathOf(p.page_url) !== '') p.page_title = titleFromUrl(p.page_url) || p.page_title;
    if (!p.meta_description && p.sample) p.meta_description = p.sample.slice(0, 220);
    cleanPages.push(p);
  }
  const keywords = topTerms(allText, 40);
  const contentPages = cleanPages.filter(p => ['blog', 'game', 'money'].includes(p.page_type));
  return { url: start, homepageTitle: homepage?.title || '', homepageMeta: homepage?.meta || '', homepageH1: homepage?.h1 || '', hasTitle: !!homepage?.title, hasMeta: !!homepage?.meta, hasH1: !!homepage?.h1, hasRobots, hasSitemap, indexablePages: cleanPages.filter(p => p.status_code >= 200 && p.status_code < 400).length, contentPages: contentPages.length, keywordCount: keywords.length, avgWords: cleanPages.length ? Math.round(cleanPages.reduce((a, b) => a + (b.word_count || 0), 0) / cleanPages.length) : 0, externalDomains: externalDomains.size, externalDomainList: [...externalDomains].filter(Boolean).slice(0, 50), keywords, pages: cleanPages, imageCandidates: images.filter((v, i, a) => a.findIndex(x => x.url === v.url) === i).slice(0, 30) };
}
async function auditCompetitor(url) { const audit = await crawlWebsite(url, Number(process.env.CRAWL_PAGE_LIMIT || 35)); audit.score = competitorScore(audit); return audit; }
async function saveCompetitorAudit(competitorId, audit) {
  await q('UPDATE competitors SET homepage_title=?, audit_score=?, snapshot_json=?, last_audited_at=NOW(), name=COALESCE(name,?), url=COALESCE(url,?) WHERE id=?', [dbSafeText(audit.homepageTitle || null), audit.score || 0, dbSafeText(JSON.stringify(audit)), hostOf(audit.url), audit.url, competitorId]);
  await q('DELETE FROM competitor_pages WHERE competitor_id=?', [competitorId]);
  for (const p of audit.pages || []) await execSafe('INSERT INTO competitor_pages (competitor_id,page_url,page_title,meta_description,h1_text,page_type,word_count) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE page_title=VALUES(page_title), meta_description=VALUES(meta_description), h1_text=VALUES(h1_text), page_type=VALUES(page_type), word_count=VALUES(word_count)', [competitorId, p.page_url, dbSafeText(truncate(p.page_title, 500)), dbSafeText(p.meta_description), dbSafeText(p.h1_text), p.page_type, p.word_count || 0]);
  const comp = await one('SELECT site_id FROM competitors WHERE id=?', [competitorId]);
  for (const k of audit.keywords || []) {
    const ck = cleanKeyword(k.keyword);
    if (!ck) continue;
    // Only store competitor keywords that are genuinely useful for NativPost content planning:
    // must relate to games we host OR general hosting terms. Skip competitor brands,
    // location-specific terms, and niche games we don't offer.
    const isUseful = /social media|ai content|brand voice|content generator|scheduling|caption|linkedin|instagram|tiktok|twitter|facebook|threads|pinterest|youtube|content creation|marketing tool|saas|smb|agency|content studio|ai writing|post generator|content calendar|publish|analytics|nativpost|ocoya|buffer|hootsuite|jasper|predis|feedhive|africa|nigeria|kenya|ghana/i.test(ck);
    // Block game hosting keywords regardless of source
    const isGameKeyword = /server hosting|game server|minecraft|palworld|ark|rust server|valheim|enshrouded|windrose|terraria|dayz|zomboid|conan|icarus|satisfactory|factorio|vrising|v rising|hytale|everwind|eco server/i.test(ck);
    if (!isUseful || isGameKeyword) continue;
    await execSafe('INSERT INTO keywords (site_id,keyword,cluster_name,volume,difficulty,priority_score,source,intent,last_updated) VALUES (?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE priority_score=GREATEST(priority_score, VALUES(priority_score)), source=VALUES(source), last_updated=NOW()',
      [comp?.site_id || null, ck, clusterName(ck), 0, 35, priorityScore({ competitorCount: k.count, difficulty: 35 }), 'competitor-crawl', intentOf(ck)]);
  }
  for (const d of audit.externalDomainList || []) { const bScore = scoreBacklinkOpportunity(d); await execSafe('INSERT INTO backlinks (site_id,competitor_id,source_domain,status,authority_score,domain_rating) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM backlinks WHERE competitor_id<=>? AND source_domain=?)', [comp?.site_id || null, competitorId, d, 'competitor-opportunity', bScore, bScore, competitorId, d]); }
}
async function saveOwnSiteScan(siteId, scan) {
  const newPages = scan.pages || [];
  console.log(`[Scan] saveOwnSiteScan: ${newPages.length} pages to save for site ${siteId}`);
  // Only wipe and replace if we actually found pages — prevents data loss on empty scans
  if (newPages.length === 0) {
    console.warn('[Scan] Crawl returned 0 pages — keeping existing site_pages data');
    return;
  }
  await q('DELETE FROM site_pages WHERE site_id=?', [siteId]);
  for (const p of newPages) await execSafe('INSERT INTO site_pages (site_id,page_url,page_title,meta_description,h1_text,page_type,word_count,status_code,last_scanned_at) VALUES (?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE page_title=VALUES(page_title), meta_description=VALUES(meta_description), h1_text=VALUES(h1_text), page_type=VALUES(page_type), word_count=VALUES(word_count), status_code=VALUES(status_code), last_scanned_at=NOW()', [siteId, p.page_url, truncate(p.page_title, 500), p.meta_description, p.h1_text, p.page_type, p.word_count || 0, p.status_code || 0]);
  for (const img of scan.imageCandidates || []) {
    // NativPost: save all candidate images from site crawl
    await execSafe('INSERT INTO article_assets (site_id,label,game_slug,folder_name,asset_url,alt_text) VALUES (?,?,?,?,?,?)', [siteId, truncate(img.alt || `${game || 'site'} image`, 255), game, game || 'site-images', img.url, img.alt || `${game || 'Game server'} hosting image`]);
  }
  const payload = { ...scan, pages: (scan.pages || []).slice(0, 50) };
  await q('INSERT INTO seo_report_snapshots (site_id,snapshot_type,score,payload_json,recorded_on) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE score=VALUES(score), payload_json=VALUES(payload_json), created_at=CURRENT_TIMESTAMP', [siteId, 'site-crawl', competitorScore(scan), JSON.stringify(payload), today()]);
}

async function siteOptions() { return await q('SELECT id,name,url FROM sites WHERE active=1 ORDER BY name ASC'); }
async function assetOptions(siteId = null, gameFilter = '') {
  const game = detectGame(gameFilter || '') || normalizeGameName(gameFilter || '');
  if (game) return await q(`SELECT id,label,game_slug,folder_name,asset_url,alt_text FROM article_assets WHERE (${siteId ? 'site_id=? OR site_id IS NULL' : '1=1'}) AND (game_slug IS NULL OR game_slug='' OR LOWER(CONCAT_WS(' ',game_slug,folder_name,label,alt_text)) LIKE ?) ORDER BY folder_name,label ASC`, siteId ? [siteId, `%${game}%`] : [`%${game}%`]);
  return await q(`SELECT id,label,game_slug,folder_name,asset_url,alt_text FROM article_assets ${siteId ? 'WHERE site_id=? OR site_id IS NULL' : ''} ORDER BY folder_name,label ASC`, siteId ? [siteId] : []);
}
async function dashboardData() {
  const summary = {
    sites: (await one('SELECT COUNT(DISTINCT LOWER(TRIM(TRAILING \'/\' FROM url))) count FROM sites WHERE active=1'))?.count || 0,
    pages: (await one('SELECT COUNT(*) count FROM site_pages'))?.count || 0,
    competitors: (await one('SELECT COUNT(*) count FROM competitors WHERE active=1'))?.count || 0,
    drafts: (await one("SELECT COUNT(*) count FROM articles WHERE status='draft'"))?.count || 0,
    review: (await one("SELECT COUNT(*) count FROM articles WHERE status='review'"))?.count || 0,
    queued: (await one("SELECT COUNT(*) count FROM articles WHERE status IN ('approved','queued')"))?.count || 0,
    published: (await one("SELECT COUNT(*) count FROM articles WHERE status='published'"))?.count || 0,
    keywords: (await one('SELECT COUNT(*) count FROM keywords'))?.count || 0,
    backlinks: (await one('SELECT COUNT(*) count FROM backlinks'))?.count || 0
  };
  // Our own SERP presence count
  const ownSerpCount = await one("SELECT COUNT(DISTINCT keyword) cnt FROM serp_results WHERE result_url LIKE '%nativpost%' AND position <= 20").catch(() => ({ cnt: 0 }));
  const own = await q(`SELECT s.id,s.name,s.url,COALESCE(k.keyword_count,0) keyword_count,COALESCE(r.avg_position,0) avg_position,COALESCE(r.clicks,0) clicks,COALESCE(r.impressions,0) impressions,COALESCE(r.ranking_rows,0) ranking_rows,COALESCE(a.articles,0) articles,COALESCE(b.backlinks,0) backlinks,COALESCE(b.earned_backlinks,0) earned_backlinks,COALESCE(p.pages,0) pages,MAX(p2.last_scanned_at) last_scanned_at
    FROM sites s
    LEFT JOIN (SELECT site_id,COUNT(*) keyword_count FROM keywords GROUP BY site_id) k ON k.site_id=s.id
    LEFT JOIN (SELECT site_id,AVG(position) avg_position,SUM(clicks) clicks,SUM(impressions) impressions,COUNT(*) ranking_rows FROM rankings WHERE recorded_on >= DATE_SUB(CURDATE(), INTERVAL 45 DAY) GROUP BY site_id) r ON r.site_id=s.id
    LEFT JOIN (SELECT site_id,COUNT(*) articles FROM articles GROUP BY site_id) a ON a.site_id=s.id
    LEFT JOIN (SELECT site_id,COUNT(*) backlinks,SUM(CASE WHEN status='earned' THEN 1 ELSE 0 END) earned_backlinks FROM backlinks GROUP BY site_id) b ON b.site_id=s.id
    LEFT JOIN (SELECT site_id,COUNT(*) pages FROM site_pages GROUP BY site_id) p ON p.site_id=s.id
    LEFT JOIN site_pages p2 ON p2.site_id=s.id
    WHERE s.active=1 GROUP BY s.id ORDER BY s.name ASC`);
  const ownRanked = own.map(x => ({ ...x, kind: 'Own Site', score: siteScore(x) })).sort((a, b) => b.score - a.score);
  const competitors = await q('SELECT id,COALESCE(name,competitor_name) name,COALESCE(url,competitor_url) url,homepage_title,audit_score,last_audited_at,snapshot_json FROM competitors WHERE active=1 ORDER BY audit_score DESC, id DESC');
  // Enrich competitors with page counts and keyword gap counts
  const ourArticleKeywords = new Set((await q("SELECT LOWER(primary_keyword) kw FROM articles WHERE status IN ('published','queued','approved','review','draft') AND primary_keyword IS NOT NULL")).map(r => r.kw));
  const compRanked = await Promise.all(competitors.map(async c => {
    const snap = c.snapshot_json ? (() => { try { return JSON.parse(c.snapshot_json); } catch (e) { return {}; } })() : {};
    const pageCount = await one('SELECT COUNT(*) cnt FROM competitor_pages WHERE competitor_id=?', [c.id]);
    const compKws = (snap.keywords || []).map(k => (k.keyword || '').toLowerCase().trim()).filter(Boolean);
    const gapCount = compKws.filter(kw => !ourArticleKeywords.has(kw)).length;
    // SERP presence: how many of our tracked keywords does this competitor appear in?
    const compHost = hostOf(c.url || c.competitor_url || '');
    const serpPresence = compHost ? await one(
      `SELECT COUNT(DISTINCT keyword) cnt FROM serp_results WHERE result_url LIKE ? OR result_url LIKE ?`,
      ['%' + compHost + '%', '%www.' + compHost + '%']
    ) : null;
    const serpAvgPos = compHost ? await one(
      `SELECT AVG(NULLIF(position,0)) avg_pos, MIN(CASE WHEN position > 0 THEN position END) best_pos FROM serp_results WHERE (result_url LIKE ? OR result_url LIKE ?)`,
      ['%' + compHost + '%', '%www.' + compHost + '%']
    ) : null;
    const serpRankCount = serpPresence?.cnt || 0;
    // Our own SERP presence for same keywords (for comparison)
    return {
      ...c, kind: 'Competitor', score: Math.round(Number(c.audit_score || 0)),
      contentPages: snap.contentPages || 0, pageCount: pageCount?.cnt || 0,
      gapCount, avgWords: snap.avgWords || 0, keywordCount: snap.keywordCount || 0,
      externalDomains: snap.externalDomains || 0, serpRankCount, serpAvgPos: serpAvgPos?.avg_pos || null, serpBestPos: serpAvgPos?.best_pos || null
    };
  }));
  const leaderboard = [];
  const drafts = await q("SELECT id,title,primary_keyword,status,quality_score,updated_at FROM articles WHERE status IN ('draft','review') ORDER BY updated_at DESC, id DESC LIMIT 8");
  const opportunities = await q("SELECT keyword,cluster_name,priority_score,volume,difficulty,intent FROM keywords WHERE keyword LIKE '% %' AND (keyword LIKE '%social media%' OR keyword LIKE '%brand voice%' OR keyword LIKE '%content%' OR keyword LIKE '%caption%' OR keyword LIKE '%ai%' OR keyword LIKE '%nativpost%' OR keyword LIKE '%marketing%' OR keyword LIKE '%publish%' OR keyword LIKE '%schedule%' OR keyword LIKE '%instagram%' OR keyword LIKE '%linkedin%' OR keyword LIKE '%tiktok%' OR keyword LIKE '%africa%' OR keyword LIKE '%agency%') ORDER BY priority_score DESC, volume DESC LIMIT 12");
  const radarOpportunities = await getTopRadarOpportunities(3);
  // Daily brief — top 3 recommendations shown on dashboard
  let dailyBrief = [];
  try { dailyBrief = (await generateDailyBrief(null)).slice(0, 3); } catch (e) { }
  return { summary, ownRanked, compRanked, leaderboard, drafts, opportunities, radarOpportunities, ownSerpCount: ownSerpCount?.cnt || 0, dailyBrief };
}
// ══════════════════════════════════════════════════════════════════════════════
// WEEKLY CHANGE REPORT — compares current rankings vs 7 days ago
// Returns top movers (up/down), new keywords, lost keywords
// ══════════════════════════════════════════════════════════════════════════════
async function buildWeeklyChangeReport(siteId = null) {
  const report = { movers_up: [], movers_down: [], new_keywords: [], lost_keywords: [], summary: {} };
  try {
    const today = new Date();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const todayStr = today.toISOString().slice(0, 10);
    const weekAgoStr = weekAgo.toISOString().slice(0, 10);

    const siteFilter = siteId ? 'AND site_id=?' : '';
    const params = siteId ? [siteId] : [];

    // Current snapshot: best position per keyword in last 3 days
    const current = await q(
      `SELECT keyword, MIN(position) position, SUM(clicks) clicks, SUM(impressions) impressions
       FROM rankings
       WHERE recorded_on >= DATE_SUB(CURDATE(), INTERVAL 3 DAY) ${siteFilter}
       GROUP BY keyword`, params);

    // Previous snapshot: best position per keyword 7-10 days ago
    const previous = await q(
      `SELECT keyword, MIN(position) position
       FROM rankings
       WHERE recorded_on BETWEEN DATE_SUB(CURDATE(), INTERVAL 10 DAY) AND DATE_SUB(CURDATE(), INTERVAL 6 DAY) ${siteFilter}
       GROUP BY keyword`, params);

    const prevMap = new Map(previous.map(r => [r.keyword, Number(r.position || 50)]));
    const currMap = new Map(current.map(r => [r.keyword, { pos: Number(r.position || 50), clicks: r.clicks, impressions: r.impressions }]));

    for (const row of current) {
      const keyword = row.keyword;
      const currPos = Number(row.position || 50);
      if (!cleanKeyword(keyword)) continue;
      if (prevMap.has(keyword)) {
        const prevPos = prevMap.get(keyword);
        const delta = prevPos - currPos; // positive = moved up (lower position = better)
        if (delta >= 2) report.movers_up.push({ keyword, position: currPos, prev_position: prevPos, delta, clicks: row.clicks, impressions: row.impressions });
        else if (delta <= -2) report.movers_down.push({ keyword, position: currPos, prev_position: prevPos, delta, clicks: row.clicks, impressions: row.impressions });
      } else {
        report.new_keywords.push({ keyword, position: currPos, clicks: row.clicks, impressions: row.impressions });
      }
    }
    for (const row of previous) {
      if (!currMap.has(row.keyword) && cleanKeyword(row.keyword)) {
        report.lost_keywords.push({ keyword: row.keyword, prev_position: Number(row.position || 50) });
      }
    }

    report.movers_up.sort((a, b) => b.delta - a.delta).splice(20);
    report.movers_down.sort((a, b) => a.delta - b.delta).splice(20);
    report.new_keywords.sort((a, b) => a.position - b.position).splice(20);
    report.lost_keywords.splice(20);
    report.summary = {
      improved: report.movers_up.length,
      declined: report.movers_down.length,
      new: report.new_keywords.length,
      lost: report.lost_keywords.length
    };
  } catch (e) { console.error('Weekly change report error:', e.message); }
  return report;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTENT DECAY DETECTION — finds published articles losing traffic over time
// Compares recent GA4 data vs older GA4 data to flag declining pages
// ══════════════════════════════════════════════════════════════════════════════
async function detectContentDecay(siteId = null) {
  const decaying = [];
  try {
    const siteFilter = siteId ? 'AND site_id=?' : '';
    const params = siteId ? [siteId] : [];
    // Get pages with views in last 30 days AND 60-90 days ago
    const recent = await q(
      `SELECT page_path, page_title, SUM(views) views, SUM(sessions) sessions
       FROM page_metrics
       WHERE report_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) ${siteFilter}
       GROUP BY page_path`, params);
    const older = await q(
      `SELECT page_path, SUM(views) views
       FROM page_metrics
       WHERE report_date BETWEEN DATE_SUB(CURDATE(), INTERVAL 90 DAY) AND DATE_SUB(CURDATE(), INTERVAL 60 DAY) ${siteFilter}
       GROUP BY page_path`, params);

    const olderMap = new Map(older.map(r => [r.page_path, Number(r.views || 0)]));

    for (const row of recent) {
      const oldViews = olderMap.get(row.page_path);
      if (!oldViews || oldViews < 10) continue; // no baseline
      const recentViews = Number(row.views || 0);
      const dropPct = Math.round((oldViews - recentViews) / oldViews * 100);
      if (dropPct >= 25) { // 25%+ drop = decaying
        decaying.push({
          page_path: row.page_path,
          page_title: row.page_title || row.page_path,
          recent_views: recentViews,
          older_views: oldViews,
          drop_pct: dropPct,
          severity: dropPct >= 50 ? 'critical' : 'warning'
        });
      }
    }
    decaying.sort((a, b) => b.drop_pct - a.drop_pct).splice(20);
  } catch (e) { console.error('Content decay detection error:', e.message); }
  return decaying;
}

// ══════════════════════════════════════════════════════════════════════════════
// POSITION HISTORY — sparkline data for top keywords over last 30 days
// ══════════════════════════════════════════════════════════════════════════════
async function getPositionHistory(siteId = null, limit = 10) {
  try {
    const siteFilter = siteId ? 'AND site_id=?' : '';
    const relevanceFilter = `AND (
      keyword REGEXP 'nitrado|gportal|gameserver|spieleserver|bisect|shockbyte|apexhost'
    ) AND keyword NOT REGEXP 'nitrado|gportal|shockbyte|bisect|hosthavoc|freakhost|scalacube|nodecraft|sparkedhost|pingperfect|aternos|minehut'
    AND keyword NOT REGEXP 'dallas|miami|houston|chicago|london|toronto|sydney|berlin|paris|amsterdam|seattle|denver|atlanta|phoenix|portland|austin|discord|reddit|youtube|twitter|facebook|instagram'
    AND LENGTH(keyword) > 4`;
    const params = siteId ? [siteId] : [];
    const topKws = await q(
      `SELECT keyword, MIN(position) best_position, SUM(clicks) total_clicks, SUM(impressions) total_impressions
       FROM rankings
       WHERE recorded_on >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) ${siteFilter} ${relevanceFilter}
       GROUP BY keyword
       HAVING total_clicks > 0 OR MIN(position) <= 30
       ORDER BY total_clicks DESC, MIN(position) ASC, total_impressions DESC
       LIMIT ?`,
      [...params, limit * 3]);
    if (!topKws.length) return [];
    // Deduplicate near-identical keywords — keep the one with more clicks
    const deduped = [];
    const seenBases = new Set();
    for (const row of topKws) {
      const base = row.keyword.toLowerCase()
        .replace(/\b(server|hosting|host|servers|best|cheap|fast|good|affordable|dedicated|managed)\b/g, '')
        .replace(/\s+/g, ' ').trim();
      if (!seenBases.has(base) || base.length < 4) {
        seenBases.add(base);
        deduped.push(row);
      }
      if (deduped.length >= limit) break;
    }
    const kwList = deduped.map(r => r.keyword);
    const placeholders = kwList.map(() => '?').join(',');
    const historyFilter = siteId ? 'AND site_id=?' : '';
    const history = await q(
      `SELECT keyword, MIN(position) position, recorded_on
       FROM ranking_history
       WHERE keyword IN (${placeholders}) ${historyFilter}
       AND recorded_on >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
       GROUP BY keyword, recorded_on
       ORDER BY keyword, recorded_on ASC`,
      [...kwList, ...(siteId ? [siteId] : [])]);
    const grouped = new Map();
    for (const row of history) {
      if (!grouped.has(row.keyword)) grouped.set(row.keyword, []);
      grouped.get(row.keyword).push({ date: row.recorded_on instanceof Date ? row.recorded_on.toISOString().slice(0, 10) : String(row.recorded_on || '').slice(0, 10), position: Number(row.position || 50) });
    }
    return kwList.map(kw => ({ keyword: kw, history: grouped.get(kw) || [] }));
  } catch (e) { console.error('Position history error:', e.message); return []; }
}

// ══════════════════════════════════════════════════════════════════════════════
// BACKLINK OPPORTUNITY SCORER — scores backlink prospects by relevance
// ══════════════════════════════════════════════════════════════════════════════
function scoreBacklinkOpportunity(domain = '') {
  const d = String(domain || '').toLowerCase();
  let score = 0;
  // Social media / content marketing related domains get high scores
  if (/social|media|content|brand|marketing|creator|agency|ai|saas|startup/.test(d)) score += 40;
  // Review/directory sites
  if (/review|compare|best|top|rank|list|direct|hub|index/.test(d)) score += 25;
  // Known high-value domains
  if (/reddit\.com|discord\.com|github\.com|youtube\.com/.test(d)) score += 30;
  // Community/wiki sites
  if (/wiki|forum|community|subreddit|fandom/.test(d)) score += 20;
  // Tech blogs
  if (/blog|guide|how|tutorial|learn|news/.test(d)) score += 15;
  // Penalize obvious spam patterns
  if (/casino|loan|insurance|pharma|adult|porn|xxx|seo-link|backlink/.test(d)) score -= 100;
  return Math.max(0, Math.min(100, score));
}

// ══════════════════════════════════════════════════════════════════════════════
// TECHNICAL SEO AUDIT ENGINE
// Reads from site_pages (already crawled) — no new HTTP calls, no API cost.
// Returns an array of issue objects: { type, severity, url, title, detail }
// severity: 'critical' | 'warning' | 'info'
// ══════════════════════════════════════════════════════════════════════════════
async function runTechnicalSEOAudit(siteId = null) {
  const issues = [];
  const where = siteId ? 'WHERE sp.site_id=?' : 'WHERE 1=1';
  const params = siteId ? [siteId] : [];

  const pages = await q(
    `SELECT sp.*, s.name site_name, s.url site_url
     FROM site_pages sp JOIN sites s ON s.id=sp.site_id
     ${where} ORDER BY sp.page_type, sp.word_count DESC LIMIT 500`,
    params
  );
  if (!pages.length) return issues;

  // — Title checks —
  const titleMap = new Map();
  for (const p of pages) {
    const t = (p.page_title || '').trim();
    if (!t) {
      issues.push({ type: 'missing_title', severity: 'critical', url: p.page_url, title: 'Missing page title', detail: `${p.page_url} has no title tag. Google uses this as the primary ranking signal and click text.` });
    } else {
      if (t.length < 30) issues.push({ type: 'short_title', severity: 'warning', url: p.page_url, title: 'Title too short', detail: `"${t.slice(0, 80)}" (${t.length} chars). Titles under 30 chars waste ranking opportunity — aim for 50–60.` });
      if (t.length > 65) issues.push({ type: 'long_title', severity: 'warning', url: p.page_url, title: 'Title too long', detail: `"${t.slice(0, 80)}…" (${t.length} chars). Google truncates at ~60 chars — the keyword may be cut off in results.` });
      const key = t.toLowerCase().trim();
      if (titleMap.has(key)) {
        issues.push({ type: 'duplicate_title', severity: 'critical', url: p.page_url, title: 'Duplicate title tag', detail: `"${t.slice(0, 80)}" is identical to ${titleMap.get(key)}. Duplicate titles confuse Google about which page to rank.` });
      } else {
        titleMap.set(key, p.page_url);
      }
    }
  }

  // — Meta description checks —
  const metaMap = new Map();
  for (const p of pages) {
    const m = (p.meta_description || '').trim();
    if (!m) {
      issues.push({ type: 'missing_meta', severity: 'warning', url: p.page_url, title: 'Missing meta description', detail: `${p.page_url} has no meta description. Google may auto-generate one that doesn't reflect your message.` });
    } else {
      if (m.length > 165) issues.push({ type: 'long_meta', severity: 'info', url: p.page_url, title: 'Meta description too long', detail: `(${m.length} chars) Google truncates at ~155 chars. Trim to keep the CTA visible in search results.` });
      const key = m.toLowerCase().trim().slice(0, 100);
      if (metaMap.has(key)) {
        issues.push({ type: 'duplicate_meta', severity: 'warning', url: p.page_url, title: 'Duplicate meta description', detail: `Same meta as ${metaMap.get(key)}. Unique descriptions improve CTR significantly.` });
      } else {
        metaMap.set(key, p.page_url);
      }
    }
  }

  // — H1 checks —
  for (const p of pages) {
    const h = (p.h1_text || '').trim();
    if (!h) {
      issues.push({ type: 'missing_h1', severity: 'critical', url: p.page_url, title: 'Missing H1', detail: `${p.page_url} has no H1 heading. H1 is one of the strongest on-page ranking signals.` });
    } else if (h.length < 15) {
      issues.push({ type: 'weak_h1', severity: 'warning', url: p.page_url, title: 'H1 too short or vague', detail: `"${h}" — a short H1 often means the primary keyword isn't in it. Make it descriptive and keyword-rich.` });
    }
  }

  // — Thin content —
  for (const p of pages) {
    // Skip low-content pages — NativPost app uses a Next.js SPA that delivers minimal HTML server-side,
    // so all game pages show ~13 words even though they have full content client-side
    if (['money', 'blog', 'support'].includes(p.page_type) && Number(p.word_count || 0) < 300 && Number(p.word_count || 0) > 0) {
      issues.push({ type: 'thin_content', severity: 'warning', url: p.page_url, title: 'Thin content page', detail: `${p.page_url} (${p.word_count} words). Pages under 300 words rarely rank — expand or consolidate.` });
    }
  }

  // — Orphan pages (no internal links detected pointing in) —
  // We approximate by checking if any OTHER page_url contains a link to this URL
  // Since we don't store full link graphs, flag pages with zero word_count as likely orphaned
  for (const p of pages) {
    if (p.page_type === 'blog' && Number(p.word_count || 0) === 0) {
      issues.push({ type: 'orphan_suspect', severity: 'info', url: p.page_url, title: 'Possible orphan page', detail: `${p.page_url} was detected as a blog page but shows 0 words. It may be orphaned or unscanned — re-scan or add internal links to it.` });
    }
  }

  // — Blog posts not linking to money pages —
  const moneyPages = pages.filter(p => p.page_type === 'money' || p.page_type === 'game');
  const blogPages = pages.filter(p => p.page_type === 'blog');
  if (moneyPages.length && blogPages.length) {
    const articles = await q("SELECT title, body, slug, primary_keyword FROM articles WHERE status='published' ORDER BY id DESC LIMIT 200");
    const moneyUrls = moneyPages.map(p => p.page_url.toLowerCase());
    let blogsMissingLink = 0;
    for (const a of articles) {
      const body = String(a.body || '').toLowerCase();
      const hasMoneyLink = moneyUrls.some(mu => body.includes(mu) || (a.slug && mu.includes(a.slug)));
      if (!hasMoneyLink) blogsMissingLink++;
    }
    if (blogsMissingLink > 0) {
      issues.push({ type: 'blog_no_money_link', severity: 'warning', url: 'multiple', title: `${blogsMissingLink} published articles may not link to money pages`, detail: `${blogsMissingLink} of your published articles don't appear to link to any NativPost pricing or feature page. Internal links to money pages pass PageRank and increase conversion chances.` });
    }
  }

  // — Sort: critical first, then warning, then info —
  const order = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => (order[a.severity] || 2) - (order[b.severity] || 2));
  return issues;
}
// ══════════════════════════════════════════════════════════════════════════════

function extractMarkdownLinks(md = '') {
  return [...String(md || '').matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi)].map(m => ({ text: m[1], url: m[2] }));
}
function countHeadings(md = '') { return [...String(md || '').matchAll(/^##\s+.+$/gim)].length; }
function hasAnswerFirst(md = '') { return /## (Quick Answer|TL.DR|Short Answer|Answer|What is|In Short)/im.test(String(md || '')) || /\*\*(Quick Answer|TL.DR|Short Answer)\*\*/im.test(String(md || '')); }
function hasTableOrChecklist(md = '') { return /\|.+\|.+\|/.test(String(md || '')) || /(?:^|\n)(?:-|\*)\s+/.test(String(md || '')); }
function qualityBreakdown(article = {}) {
  const body = String(article.body || article.content || '');
  const bodyWords = wordCount(body);
  const links = extractMarkdownLinks(body);
  const internalLinks = links.filter(l => /nativpost\.com/i.test(l.url) || /^\/(?!\/)/.test(l.url));
  const outboundLinks = links.filter(l => !/nativpost\.com/i.test(l.url) && /^https?:\/\//i.test(l.url));
  // Also check for bare external URLs not wrapped in markdown links (e.g. steam pages mentioned in text)
  const bareExternalUrls = [...String(body || '').matchAll(/https?:\/\/(?!nativpost)[^\s)\]]+/gi)].map(m => m[0]);
  const hasExternalUrl = outboundLinks.length > 0 || bareExternalUrls.length > 0;
  const game = detectGame(`${article.title || ''} ${article.primary_keyword || ''} ${body}`);
  const notes = [];
  let score = 0;
  if ((article.title || '').length >= 35 && (article.title || '').length <= 50) score += 10; else notes.push('Title should be 35-50 characters.');
  if (article.primary_keyword && new RegExp(article.primary_keyword.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(`${article.title || ''} ${body.slice(0, 300)}`)) score += 10; else notes.push('Primary keyword is not prominent enough in the title/opening.');
  if ((article.meta_description || '').length >= 120 && (article.meta_description || '').length <= 160) score += 10; else notes.push('Meta description should be 120-160 characters.');
  if (bodyWords >= 1500) score += 14; else if (bodyWords >= 1200) score += 10; else notes.push('Article is too thin; target 1200+ words, ideally 1500+.');
  const h2Count = countHeadings(body);
  if (h2Count >= 5) score += 8; else notes.push('Needs at least 5 useful H2 sections.');
  if (hasAnswerFirst(body)) score += 8; else notes.push('Needs an answer-first section for search and AI answers.');
  if (/## FAQ/i.test(body)) score += 7; else notes.push('Needs an FAQ section.');
  if (hasTableOrChecklist(body)) score += 7; else notes.push('Needs a table or checklist for snippet-readiness.');
  if (internalLinks.length >= 2) score += 8; else notes.push('Needs at least two internal NativPost links.');
  if (hasExternalUrl) score += 4; else notes.push('Needs at least one authoritative outbound source link (e.g. official platform docs, industry research, or relevant authority site).');
  if (article.featured_image_url) score += 5; else notes.push('Needs a featured image.');
  if ((article.featured_image_alt || '').length >= 8) score += 3; else notes.push('Needs better featured image alt text.');
  if (/NativPost/i.test(body) && /free trial|brand voice|anti-slop|7-day/i.test(body)) score += 6; else notes.push('Needs a stronger NativPost CTA — mention 7-day free trial and brand voice.');
  if (game && new RegExp(game.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(body)) score += 4;
  const duplicatePenalty = Number(article.cannibalization_penalty || 0);
  score = Math.max(1, Math.min(100, Math.round(score - duplicatePenalty)));
  return { score, notes, bodyWords, h2Count, internalLinks: internalLinks.length, outboundLinks: outboundLinks.length, game };
}
function contentQuality(article = {}) { return qualityBreakdown(article).score; }
function dedupeByUrl(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const url = normalizeUrl(row.url || row.result_url || row.page_url || '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...row, url });
  }
  return out;
}
function entityTermsFromRows(rows = []) {
  const bag = [];
  for (const r of rows || []) {
    const t = `${r.title || r.result_title || ''} ${r.snippet || r.meta_description || ''} ${(r.headings || []).join(' ')} ${r.url || r.result_url || ''}`;
    bag.push(...tokens(t));
  }
  return [...new Set(bag.filter(Boolean))].slice(0, 40);
}
async function httpGetText(url, timeout = 25000) {
  const r = await axios.get(url, { timeout, headers: { 'User-Agent': process.env.SEO_USER_AGENT || 'Mozilla/5.0 (compatible; NativPostSEO/1.0; +https://nativpost.com)' } });
  return typeof r.data === 'string' ? r.data : JSON.stringify(r.data || {});
}
// ══════════════════════════════════════════════════════════════════════════════
// SERP INTELLIGENCE ENGINE — DataForSEO (primary) + DuckDuckGo (fallback)
// ══════════════════════════════════════════════════════════════════════════════

function dfsAuthHeader() {
  return 'Basic ' + Buffer.from(`${DFS_LOGIN}:${DFS_PASSWORD}`).toString('base64');
}
async function dfsPost(endpoint, payload) {
  const r = await axios.post(`https://api.dataforseo.com/v3/${endpoint}`, payload, {
    headers: { Authorization: dfsAuthHeader(), 'Content-Type': 'application/json' }, timeout: 45000
  });
  return r.data;
}
async function dfsGet(endpoint) {
  const r = await axios.get(`https://api.dataforseo.com/v3/${endpoint}`, {
    headers: { Authorization: dfsAuthHeader() }, timeout: 30000
  });
  return r.data;
}
// Fetch live DataForSEO balance + per-API usage. Costs $0 (user_data is a free endpoint).
// Returns { balance, currency, details, raw } or throws on failure.
async function fetchDataForSEOBalance() {
  if (!DFS_ENABLED || !DFS_LOGIN || !DFS_PASSWORD) {
    throw new Error('DataForSEO credentials not configured');
  }
  const data = await dfsGet('appendix/user_data');
  if (data?.status_code !== 20000) {
    throw new Error('DataForSEO user_data failed: ' + (data?.status_message || 'unknown'));
  }
  const userData = data.tasks?.[0]?.result?.[0] || {};
  const money = userData.money || {};
  const rates = userData.rates || {};
  return {
    balance: Number(money.balance || 0),
    currency: money.currency || 'USD',
    totalSpent: Number(money.total || 0),
    priceRates: rates,
    raw: userData
  };
}
// Single place to refresh all API balance caches. Called from a route and from
// a periodic background refresher so the Reports page is always instant.
async function refreshApiBalances(serviceFilter = null) {
  const services = serviceFilter ? [serviceFilter] : ['dataforseo', 'contentful', 'anthropic', 'openai', 'google'];
  const results = {};
  for (const svc of services) {
    try {
      if (svc === 'dataforseo') {
        const d = await fetchDataForSEOBalance();
        const status = d.balance < 3 ? 'critical' : (d.balance < 10 ? 'warning' : 'ok');
        const details = { currency: d.currency, totalSpent: d.totalSpent, backlinksSubscription: !!d.raw?.money?.backlinks_subscription };
        await execSafe(
          `INSERT INTO api_balance_cache (service,balance,currency,status,details_json,fetched_at,error_message)
           VALUES (?,?,?,?,?,NOW(),NULL)
           ON DUPLICATE KEY UPDATE balance=VALUES(balance),currency=VALUES(currency),status=VALUES(status),details_json=VALUES(details_json),fetched_at=NOW(),error_message=NULL`,
          ['dataforseo', d.balance, d.currency, status, JSON.stringify(details)]
        );
        results.dataforseo = { balance: d.balance, currency: d.currency, status };
      } else if (svc === 'contentful') {
        // Contentful doesn't expose a usage-quota API publicly; we just confirm the token works.
        if (!contentfulReady()) throw new Error('Contentful env vars missing');
        const space = process.env.CONTENTFUL_SPACE_ID;
        const token = contentfulToken();
        const r = await axios.get(`https://api.contentful.com/spaces/${space}`, {
          headers: { Authorization: `Bearer ${token}` }, timeout: 10000
        });
        const details = { space: r.data?.name || space, id: r.data?.sys?.id || space };
        await execSafe(
          `INSERT INTO api_balance_cache (service,balance,currency,status,details_json,fetched_at,error_message)
           VALUES (?,NULL,?,?,?,NOW(),NULL)
           ON DUPLICATE KEY UPDATE balance=NULL,currency=VALUES(currency),status=VALUES(status),details_json=VALUES(details_json),fetched_at=NOW(),error_message=NULL`,
          ['contentful', 'n/a', 'ok', JSON.stringify(details)]
        );
        results.contentful = { status: 'ok', details };
      } else if (svc === 'anthropic') {
        if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
        const r = await axios.get('https://api.anthropic.com/v1/models', {
          headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 15000
        });
        const details = { note: 'Anthropic Claude API connected. Check console.anthropic.com/settings/billing for usage.' };
        await execSafe('INSERT INTO api_balances (service,balance_usd,credits_remaining,status,detail_json) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE balance_usd=VALUES(balance_usd),credits_remaining=VALUES(credits_remaining),status=VALUES(status),detail_json=VALUES(detail_json),checked_at=NOW()',
          ['anthropic', 'n/a', 'ok', JSON.stringify(details)]);
        results.anthropic = { status: 'ok', note: details.note };
      } else if (svc === 'openai') {
        // OpenAI has no public prepaid-balance endpoint. We verify the key works
        // via a zero-cost model list call. Balance itself is marked 'unavailable'.
        if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
        await axios.get('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, timeout: 15000
        });
        const details = { note: 'OpenAI does not expose a prepaid credit balance via API. Check platform.openai.com/usage.' };
        await execSafe(
          `INSERT INTO api_balance_cache (service,balance,currency,status,details_json,fetched_at,error_message)
           VALUES (?,NULL,?,?,?,NOW(),NULL)
           ON DUPLICATE KEY UPDATE balance=NULL,currency=VALUES(currency),status=VALUES(status),details_json=VALUES(details_json),fetched_at=NOW(),error_message=NULL`,
          ['openai', 'n/a', 'ok', JSON.stringify(details)]
        );
        results.openai = { status: 'ok', note: details.note };
      } else if (svc === 'google') {
        const connected = await googleConnected().catch(() => false);
        const status = connected ? 'ok' : 'warning';
        const details = { connected };
        await execSafe(
          `INSERT INTO api_balance_cache (service,balance,currency,status,details_json,fetched_at,error_message)
           VALUES (?,NULL,?,?,?,NOW(),NULL)
           ON DUPLICATE KEY UPDATE balance=NULL,currency=VALUES(currency),status=VALUES(status),details_json=VALUES(details_json),fetched_at=NOW(),error_message=NULL`,
          ['google', 'n/a', status, JSON.stringify(details)]
        );
        results.google = { status, connected };
      }
    } catch (e) {
      await execSafe(
        `INSERT INTO api_balance_cache (service,balance,currency,status,details_json,fetched_at,error_message)
         VALUES (?,NULL,NULL,?,NULL,NOW(),?)
         ON DUPLICATE KEY UPDATE balance=NULL,status=VALUES(status),fetched_at=NOW(),error_message=VALUES(error_message)`,
        [svc, 'error', String(e.message || e).slice(0, 500)]
      );
      results[svc] = { status: 'error', error: String(e.message || e) };
    }
  }
  return results;
}
async function getCachedApiBalances() {
  const rows = await q('SELECT * FROM api_balance_cache').catch(() => []);
  const out = {};
  for (const r of rows) {
    let details = null;
    try { details = r.details_json ? JSON.parse(r.details_json) : null; } catch { }
    out[r.service] = {
      balance: r.balance === null ? null : Number(r.balance),
      currency: r.currency,
      status: r.status,
      details,
      fetched_at: r.fetched_at,
      error: r.error_message
    };
  }
  return out;
}

// ── Email sender ─────────────────────────────────────────────────────────
// Supports Resend (EMAIL_PROVIDER=resend + RESEND_API_KEY) or SMTP2GO
// (EMAIL_PROVIDER=smtp2go + SMTP2GO_API_KEY). Both have free tiers.
// Falls back to console logging so reset codes still work during local dev
// or when no provider is configured — the code will appear in the server log.
async function sendEmail({ to, subject, text, html }) {
  const provider = String(process.env.EMAIL_PROVIDER || '').toLowerCase();
  const fromName = process.env.EMAIL_FROM_NAME || 'NativPost SEO';
  const fromAddr = process.env.EMAIL_FROM_ADDRESS || 'noreply@nativpost.com';
  if (provider === 'resend' && process.env.RESEND_API_KEY) {
    await axios.post('https://api.resend.com/emails', {
      from: `${fromName} <${fromAddr}>`, to: Array.isArray(to) ? to : [to], subject, text, html
    }, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    return { sent: true, provider: 'resend' };
  }
  if (provider === 'smtp2go' && process.env.SMTP2GO_API_KEY) {
    await axios.post('https://api.smtp2go.com/v3/email/send', {
      api_key: process.env.SMTP2GO_API_KEY,
      sender: `${fromName} <${fromAddr}>`,
      to: [to], subject, text_body: text, html_body: html
    }, { timeout: 15000 });
    return { sent: true, provider: 'smtp2go' };
  }
  // Fallback: log to console so reset codes are still readable from server logs
  console.warn('[Email] No provider configured — logging email instead');
  console.warn('[Email] To:', to, '| Subject:', subject);
  console.warn('[Email] Body:', text);
  return { sent: false, provider: 'console-fallback', logged: true };
}
function generateResetCode() {
  // 6-digit numeric code, cryptographically random
  const n = crypto.randomBytes(3).readUIntBE(0, 3) % 1000000;
  return String(n).padStart(6, '0');
}
async function hashResetCode(code) {
  // Simple SHA-256 is fine for a 6-digit, 15-minute-lifetime code with a 5-attempt cap
  return crypto.createHash('sha256').update(String(code || '') + (process.env.SESSION_SECRET || 'nativpost-reset-salt-2026')).digest('hex');
}

// ── Game Expansion Radar ─────────────────────────────────────────────────
// Finds keywords NativPost hasn't covered yet but probably should. Pulls from Steam's
// public API (free, no auth), filters for server-relevant genre tags, cross-
// references with NativPost keyword list and existing radar rows, then
// (optionally) measures SERP competition via DataForSEO to score opportunity.
//
// The magic: by running this on a schedule, the next Windrose gets flagged
// before competitors cover it, so your articles land first with minimal
// competition — exactly what you asked for.

const SERVER_RELEVANT_STEAM_TAGS = [
  // Genre / mechanic tags that strongly indicate "this game will want dedicated
  // server hosting." Steam's tag IDs are stable. If Steam changes them, update here.
  'Survival', 'Multiplayer', 'Co-op', 'Online Co-Op', 'Open World Survival Craft',
  'Sandbox', 'Base Building', 'PvE', 'PvP', 'MMO', 'Open World', 'Early Access'
];

async function steamFetchFeatured() {
  // Steam's featured endpoint lists items currently highlighted on the front page.
  // Free, no auth needed. Includes new releases, popular, etc.
  try {
    const r = await axios.get('https://store.steampowered.com/api/featuredcategories/', {
      headers: { 'User-Agent': 'NativPostSEOBot/1.0' }, timeout: 12000
    });
    return r.data || {};
  } catch (e) { return {}; }
}
async function steamFetchAppDetails(appId) {
  try {
    const r = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}`, {
      headers: { 'User-Agent': 'NativPostSEOBot/1.0' }, timeout: 12000
    });
    const entry = r.data?.[appId];
    return (entry?.success && entry.data) ? entry.data : null;
  } catch (e) { return null; }
}
function steamAppScoreForRadar(app) {
  // Heuristic: higher score = more likely to want dedicated server hosting.
  if (!app) return 0;
  const genres = (app.genres || []).map(g => String(g.description || '').toLowerCase());
  const categories = (app.categories || []).map(c => String(c.description || '').toLowerCase());
  const blob = (genres.join(' ') + ' ' + categories.join(' ')).toLowerCase();
  let score = 0;
  if (blob.includes('multiplayer')) score += 30;
  if (blob.includes('co-op') || blob.includes('online co-op')) score += 20;
  if (blob.includes('massively multiplayer') || blob.includes('mmo')) score += 25;
  if (blob.includes('pvp')) score += 10;
  if (blob.includes('sandbox') || blob.includes('survival')) score += 20;
  if (blob.includes('early access')) score += 15; // new releases = first-mover advantage for SEO
  if (blob.includes('single-player') && !blob.includes('multiplayer')) score -= 50; // not relevant
  // Check if the game actually supports dedicated servers via categories
  const hasDedicatedServer = categories.some(c => c.includes('dedicated') || c === 'lan co-op' || c.includes('remote play together'));
  if (hasDedicatedServer) score += 25;
  return Math.max(0, score);
}
async function fetchSerpCompetitionScore(keyword) {
  // Low score = less competition = bigger opportunity for NativPost content.
  // Uses your existing DataForSEO SERP cache. 0 = no competition, 100 = saturated.
  if (!DFS_ENABLED) return 50; // unknown — assume medium
  try {
    const cached = await getSerpCache(null, keyword, 'dataforseo');
    if (cached) {
      const rows = cached.rows || [];
      // Competition = how many top-10 results are established SEO players. Rough heuristic:
      // big hosting brands in top 10 = high competition.
      const hostingGiants = ['nitrado.net', 'shockbyte.com', 'gportal.com', 'apexminecrafthosting.com', 'bisecthosting.com', 'scalacube.com'];
      let bigPlayerHits = 0;
      for (const r of rows) {
        const host = hostOf(r.url || '');
        if (hostingGiants.some(g => host.includes(g))) bigPlayerHits++;
      }
      return Math.min(100, bigPlayerHits * 15); // 0-90 range typically
    }
    // No cache — fetch live (costs DFS credits, so only run for the top candidates)
    const serp = await fetchSerpViaDataForSEO(keyword);
    if (!serp) return 50;
    const hostingGiants = ['nitrado.net', 'shockbyte.com', 'gportal.com', 'apexminecrafthosting.com', 'bisecthosting.com', 'scalacube.com'];
    let bigPlayerHits = 0;
    for (const r of (serp.rows || [])) {
      const host = hostOf(r.url || '');
      if (hostingGiants.some(g => host.includes(g))) bigPlayerHits++;
    }
    return Math.min(100, bigPlayerHits * 15);
  } catch (e) { return 50; }
}
async function refreshGameExpansionRadar() {
  // NativPost: Game expansion radar disabled. NativPost is not a game hosting service.
  // This function previously scanned Steam for new keyword opportunities for NativPost.
  // For NativPost, keyword opportunities come from SERP data and competitor crawls instead.
  console.log('[Radar] Game expansion radar disabled for NativPost — skipping.');
  return;
}
async function getTopRadarOpportunities(limit = 10) {
  return await q(
    `SELECT * FROM game_expansion_radar WHERE status='pending' ORDER BY opportunity_score DESC, signal_score DESC LIMIT ?`,
    [limit]
  ).catch(() => []);
}

// ── Backlinks API (DataForSEO Backlinks) ─────────────────────────────────
// All endpoints use the same base as DFS SERP (api.dataforseo.com/v3/backlinks/*)
// plus an optional SANDBOX override for free testing without the $100/mo subscription.
// To use free sandbox: set DFS_BACKLINKS_MODE=sandbox in .env.local. Real data
// requires activating Backlinks API access ($100/mo minimum commitment).
function dfsBacklinksBaseUrl() {
  const mode = String(process.env.DFS_BACKLINKS_MODE || 'live').toLowerCase();
  return mode === 'sandbox' ? 'https://sandbox.dataforseo.com/v3/backlinks' : 'https://api.dataforseo.com/v3/backlinks';
}
async function dfsBacklinksPost(path, payload) {
  const url = dfsBacklinksBaseUrl() + '/' + path;
  const r = await axios.post(url, payload, {
    headers: { Authorization: dfsAuthHeader(), 'Content-Type': 'application/json' }, timeout: 60000
  });
  return r.data;
}
// domain_intersection = domains linking to competitors but not to our target.
// This is the "link gap" Adaptify, Ahrefs etc surface. Gold for outreach.
async function findLinkGap({ ourTarget, competitorTargets = [], limit = 50 }) {
  if (!ourTarget) throw new Error('ourTarget required');
  if (!competitorTargets.length) throw new Error('At least one competitor target required');
  // DataForSEO expects targets numbered starting from 1; our site is in `exclude_targets`.
  const targetsObj = {};
  competitorTargets.slice(0, 5).forEach((t, i) => { targetsObj[String(i + 1)] = t; });
  const payload = [{
    targets: targetsObj,
    exclude_targets: [ourTarget],
    include_subdomains: false,
    exclude_internal_backlinks: true,
    backlinks_filters: ['dofollow', '=', true],
    limit: Math.min(1000, limit),
    order_by: ['1.backlinks,desc']
  }];
  const data = await dfsBacklinksPost('domain_intersection/live', payload);
  if (data?.status_code !== 20000) {
    throw new Error('DataForSEO link-gap failed: ' + (data?.status_message || 'unknown') + ' (' + data?.status_code + ')');
  }
  const items = data?.tasks?.[0]?.result?.[0]?.items || [];
  // Each item has a `domain_intersection` object keyed 1..N, one per competitor target.
  // We aggregate: for each referring domain, count how many competitors it links to.
  const referring = new Map();
  for (const it of items) {
    const di = it.domain_intersection || {};
    let anyDomain = null;
    let backlinksSum = 0;
    let competitorsHit = 0;
    for (const k of Object.keys(di)) {
      const entry = di[k];
      if (!entry) continue;
      competitorsHit++;
      // Rip the referring domain from the first non-null entry
      if (!anyDomain) anyDomain = entry.domain_from || entry.referring_domain || entry.target || null;
      backlinksSum += Number(entry.backlinks || 0);
    }
    if (!anyDomain) continue;
    const existing = referring.get(anyDomain) || { domain: anyDomain, backlinks: 0, competitor_count: 0, rank: 0, spam_score: 0, competitors: new Set() };
    existing.backlinks += backlinksSum;
    existing.competitor_count = Math.max(existing.competitor_count, competitorsHit);
    // Pick rank from whichever competitor entry had the highest
    for (const k of Object.keys(di)) {
      const e = di[k]; if (!e) continue;
      existing.rank = Math.max(existing.rank, Number(e.rank || 0));
      existing.spam_score = Math.max(existing.spam_score, Number(e.backlinks_spam_score || 0));
      existing.competitors.add(competitorTargets[Number(k) - 1] || 'unknown');
    }
    referring.set(anyDomain, existing);
  }
  return [...referring.values()].map(r => ({ ...r, competitors: [...r.competitors] }));
}
function scoreBacklinkProspect({ competitor_count = 0, rank = 0, backlinks = 0, spam_score = 0 }) {
  // Prospect score: higher = better outreach target.
  // Heavy weight on competitor overlap (a domain linking to 4/5 competitors is a near-certain pickup),
  // moderate weight on domain rank, penalty for high spam scores.
  let score = 0;
  score += competitor_count * 25;
  score += Math.min(50, rank / 20); // rank 0-1000 scale
  score += Math.min(20, Math.log10(1 + backlinks) * 5);
  score -= Math.min(40, spam_score); // spam 0-17 scale
  return Math.max(0, Math.round(score));
}
async function runLinkGapDiscovery({ siteId = null, maxCompetitors = 5 } = {}) {
  // Pull our site + competitors, run link-gap, save prospects.
  const site = siteId
    ? await one('SELECT * FROM sites WHERE id=?', [siteId])
    : await one("SELECT * FROM sites WHERE active=1 AND LOWER(url) LIKE '%nativpost%' LIMIT 1");
  if (!site) throw new Error('No site configured for link gap (add your site under Own Sites first)');
  const ourHost = hostOf(site.url);
  const comps = await q('SELECT COALESCE(url, competitor_url) url FROM competitors WHERE active=1 ORDER BY audit_score DESC LIMIT ?', [maxCompetitors]);
  if (!comps.length) throw new Error('No competitors configured. Add some under Competitors first.');
  const competitorHosts = comps.map(c => hostOf(c.url)).filter(Boolean);
  const items = await findLinkGap({ ourTarget: ourHost, competitorTargets: competitorHosts });
  let saved = 0;
  for (const it of items) {
    const score = scoreBacklinkProspect(it);
    try {
      await q(
        `INSERT INTO backlink_prospects (site_id,source_domain,domain_rank,backlinks_count,linked_competitors,competitor_count,spam_score,prospect_score,discovery_source,status)
         VALUES (?,?,?,?,?,?,?,?,?,'new')
         ON DUPLICATE KEY UPDATE domain_rank=VALUES(domain_rank),backlinks_count=VALUES(backlinks_count),linked_competitors=VALUES(linked_competitors),competitor_count=VALUES(competitor_count),spam_score=VALUES(spam_score),prospect_score=VALUES(prospect_score),updated_at=NOW()`,
        [site.id, it.domain, it.rank, it.backlinks, it.competitors.join(', '), it.competitor_count, it.spam_score, score, 'link_gap']
      );
      saved++;
    } catch (e) { /* unique conflict, skip */ }
  }
  return { saved, total: items.length, ourHost, competitorHosts };
}
async function getSerpCache(siteId, keyword, provider = 'dataforseo') {
  try {
    // Get most recent row for this keyword+provider — check expiry in JS to avoid timezone issues
    const row = await one(
      'SELECT * FROM serp_cache WHERE keyword=? AND provider=? ORDER BY fetched_at DESC LIMIT 1',
      [keyword, provider]
    );
    if (!row) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
    return safeJsonParse(row.summary_json, null);
  } catch { return null; }
}
async function setSerpCache(siteId, keyword, provider, summary, volumeData = {}) {
  const expires = new Date(Date.now() + DFS_CACHE_DAYS * 86400 * 1000);
  const expiresStr = expires.toISOString().slice(0, 19).replace('T', ' ');
  // DELETE first then INSERT — avoids NULL unique key ambiguity in MySQL
  await execSafe('DELETE FROM serp_cache WHERE site_id<=>? AND keyword=? AND provider=?', [siteId || null, keyword, provider]);
  await execSafe(
    `INSERT INTO serp_cache (site_id,keyword,provider,summary_json,fetched_at,expires_at,search_volume,keyword_difficulty,serp_features_json)
     VALUES (?,?,?,?,NOW(),?,?,?,?)`,
    [siteId || null, keyword, provider, JSON.stringify(summary), expiresStr, volumeData.volume || 0, volumeData.difficulty || 0, JSON.stringify(volumeData.features || [])]
  );
}
async function fetchSerpViaDataForSEO(keyword) {
  if (!DFS_ENABLED) return null;
  if (!dfsCallAllowed()) return null;
  try {
    dfsCallUsed();
    const data = await dfsPost('serp/google/organic/live/advanced', [{
      keyword, location_code: DFS_LOCATION, language_code: DFS_LANGUAGE, device: DFS_DEVICE, depth: DFS_MAX_RESULTS
    }]);
    const task = data?.tasks?.[0];
    if (!task || task.status_code !== 20000) { console.warn('[SERP] DataForSEO task failed:', task?.status_message); return null; }
    const items = task?.result?.[0]?.items || [];
    const rows = []; const serpFeatures = []; const paaQuestions = []; const relatedSearches = [];
    for (const item of items) {
      if (item.type === 'organic') {
        rows.push({ url: normalizeUrl(item.url || ''), title: item.title || titleFromUrl(item.url || ''), snippet: item.description || item.snippet || '', position: item.rank_absolute || rows.length + 1, word_count: 0 });
      } else if (item.type === 'people_also_ask') {
        for (const q of (item.items || [])) { const t = q.title || q.question || ''; if (t) paaQuestions.push(t); }
      } else if (item.type === 'related_searches') {
        for (const s of (item.items || [])) { if (typeof s === 'string') relatedSearches.push(s); }
      } else if (item.type) {
        serpFeatures.push(item.type);
      }
    }
    // Use related searches as bonus questions if PAA is empty
    const allQuestions = paaQuestions.length ? paaQuestions : relatedSearches;
    return { rows: dedupeByUrl(rows).slice(0, DFS_MAX_RESULTS), paaQuestions: allQuestions.slice(0, 20), serpFeatures: [...new Set(serpFeatures)] };
  } catch (err) { console.warn('[SERP] DataForSEO error:', err.message); return null; }
}
async function fetchKeywordMetricsViaDataForSEO(keyword) {
  if (!DFS_ENABLED) return {};
  if (!dfsCallAllowed()) return {};
  try {
    dfsCallUsed();
    const data = await dfsPost('keywords_data/google_ads/search_volume/live', [{ keywords: [keyword], location_code: DFS_LOCATION, language_code: DFS_LANGUAGE }]);
    const item = data?.tasks?.[0]?.result?.[0];
    return item ? { volume: item.search_volume || 0, competition: item.competition_index || 0 } : {};
  } catch { return {}; }
}
async function fetchSerpResultsViaDuckDuckGo(query = '') {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const html = await httpGetText(url, 25000);
    const rows = [];
    for (const m of html.matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const rawUrl = stripHtml(m[1] || ''); const title = stripHtml(m[2] || '');
      if (!rawUrl || !title) continue;
      rows.push({ url: normalizeUrl(rawUrl), title, snippet: '', position: rows.length + 1, word_count: 0 });
      if (rows.length >= 10) break;
    }
    return dedupeByUrl(rows);
  } catch { return []; }
}
async function enrichSerpPage(url, timeoutMs = 12000) {
  try {
    const html = await httpGetText(url, timeoutMs);
    const headings = [...String(html || '').matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)].map(m => stripHtml(m[1])).filter(Boolean).slice(0, 12);
    const questions = headings.filter(h => /\?$/.test(h) || /^(how|what|why|when|where|can|does|is)\b/i.test(h)).slice(0, 8);
    const bodyText = stripHtml(html || '').replace(/\s+/g, ' ').trim();
    return { headings, questions, word_count: wordCount(bodyText) };
  } catch { return null; }
}
function detectSerpIntent(serpFeatures = [], questions = []) {
  const f = serpFeatures.map(x => String(x).toLowerCase());
  if (f.some(x => /shopping|price|buy|product/.test(x))) return 'commercial';
  if (f.some(x => /answer|knowledge|featured_snippet|definition/.test(x)) || questions.length > 3) return 'informational';
  return 'mixed';
}
async function purgeSerpCache(siteId = null, keyword = null) {
  if (keyword) {
    const qword = cleanKeyword(keyword) || keyword;
    // Delete all rows for this keyword regardless of site_id to prevent stale rows accumulating
    await execSafe('DELETE FROM serp_cache WHERE keyword=?', [qword]);
    await execSafe('DELETE FROM serp_results WHERE keyword=?', [qword]);
  } else if (siteId) {
    await execSafe('DELETE FROM serp_cache WHERE site_id=?', [siteId]);
    await execSafe('DELETE FROM serp_results WHERE site_id=?', [siteId]);
  } else {
    // No filter — purge everything
    await execSafe('DELETE FROM serp_cache WHERE 1=1');
    await execSafe('DELETE FROM serp_results WHERE 1=1');
  }
}
async function analyzeSerpForKeyword({ siteId = null, keyword = '', siteUrl = '' }) {
  const qword = cleanKeyword(keyword) || String(keyword || '').trim() || 'ai social media content';
  const provider = DFS_ENABLED ? 'dataforseo' : 'duckduckgo';
  const cached = await getSerpCache(siteId, qword, provider);
  if (cached) { console.log(`[SERP] Cache hit: "${qword}"`); return cached; }
  console.log(`[SERP] Fetching: "${qword}" via ${provider}`);
  let rows = [], paaQuestions = [], serpFeatures = [], volumeData = {};
  if (DFS_ENABLED) {
    const dfs = await fetchSerpViaDataForSEO(qword);
    if (dfs) { rows = dfs.rows; paaQuestions = dfs.paaQuestions; serpFeatures = dfs.serpFeatures; }
    fetchKeywordMetricsViaDataForSEO(qword).then(m => { volumeData = m; }).catch(() => { });
  }
  if (!rows.length) { try { rows = await fetchSerpResultsViaDuckDuckGo(qword); } catch { } }
  if (!rows.length) {
    const fallback = await q("SELECT cp.page_url url, cp.page_title title, cp.meta_description snippet, cp.word_count FROM competitor_pages cp JOIN competitors c ON c.id=cp.competitor_id WHERE c.active=1 ORDER BY cp.word_count DESC LIMIT 10");
    rows = fallback.map((r, i) => ({ url: r.url || r.page_url, title: r.title || r.page_title || titleFromUrl(r.url || r.page_url), snippet: r.snippet || r.meta_description || '', position: i + 1, word_count: r.word_count || 0 }));
  }
  rows = dedupeByUrl(rows).slice(0, DFS_MAX_RESULTS);
  const enriched = [];
  // Always save every row — enrich with headings/word count where possible, fall back gracefully
  const enrichResults = await Promise.allSettled(rows.slice(0, 8).map(row => enrichSerpPage(row.url, 12000).then(e => ({ row, e }))));
  const enrichMap = new Map();
  for (const r of enrichResults) {
    if (r.status === 'fulfilled' && r.value?.e) enrichMap.set(r.value.row.url, r.value.e);
  }
  for (const row of rows) {
    const e = enrichMap.get(row.url) || null;
    enriched.push({ keyword: qword, query: qword, url: row.url, title: row.title || titleFromUrl(row.url), snippet: row.snippet || '', position: row.position || 0, headings: e?.headings || [], questions: e?.questions || [], word_count: e?.word_count || row.word_count || 0, provider });
  }
  const allHeadings = [...new Set(enriched.flatMap(r => r.headings || []).filter(Boolean))].slice(0, 30);
  const allQuestions = [...new Set([...paaQuestions, ...enriched.flatMap(r => r.questions || []).filter(Boolean)])].slice(0, 24);
  const allEntities = entityTermsFromRows(enriched).slice(0, 40);
  const wordCounts = enriched.map(r => Number(r.word_count || 0)).filter(n => n > 0);
  const avgWords = wordCounts.length ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length) : 0;
  const serpIntent = detectSerpIntent(serpFeatures, allQuestions);
  await execSafe('DELETE FROM serp_results WHERE site_id<=>? AND keyword=?', [siteId || null, qword]);
  for (const row of enriched) {
    await execSafe('INSERT INTO serp_results (site_id,keyword,query_text,result_title,result_url,snippet,headings_json,questions_json,entities_json,word_count,position,provider) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [siteId || null, qword, qword, row.title || '', row.url || '', row.snippet || '', JSON.stringify(row.headings || []), JSON.stringify(row.questions || []), JSON.stringify(allEntities), Number(row.word_count || 0), Number(row.position || 0), provider]);
  }
  if (volumeData.volume) await execSafe('UPDATE keywords SET volume=?,last_updated=NOW() WHERE (site_id<=>? OR site_id IS NULL) AND LOWER(keyword)=LOWER(?) AND (volume=0 OR volume IS NULL)', [volumeData.volume, siteId || null, qword]);
  const summary = { keyword: qword, query: qword, provider, results: enriched, headings: allHeadings, questions: allQuestions, entities: allEntities, avg_words: avgWords, serp_features: serpFeatures, serp_intent: serpIntent, search_volume: volumeData.volume || 0, keyword_difficulty: volumeData.competition || 0 };
  await setSerpCache(siteId, qword, provider, summary, { volume: volumeData.volume || 0, difficulty: volumeData.competition || 0, features: serpFeatures });
  console.log(`[SERP] Done: "${qword}" — ${enriched.length} results, avg ${avgWords} words, ${allQuestions.length} questions, intent: ${serpIntent}`);
  return summary;
}
// ══════════════════════════════════════════════════════════════════════════════
async function upsertTopicCluster(siteId, keyword, serp = {}) {
  const ck = cleanKeyword(keyword) || keyword;
  if (!ck) return null;
  const cluster = clusterName(ck);
  const note = `SERP avg words: ${Number(serp.avg_words || 0)}. Questions: ${(serp.questions || []).slice(0, 6).join(' | ')}`.slice(0, 2000);
  await execSafe('INSERT INTO topic_clusters (site_id,cluster_name,primary_keyword,intent,status,notes) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE primary_keyword=VALUES(primary_keyword), intent=VALUES(intent), status=VALUES(status), notes=VALUES(notes)', [siteId || null, cluster, ck, intentOf(ck), 'active', note]);
  return cluster;
}
async function cannibalizationPenalty(siteId, keyword, slug = '') {
  const ck = cleanKeyword(keyword) || keyword;
  if (!ck) return 0;
  const existing = await q("SELECT id,title,slug,primary_keyword,status FROM articles WHERE (? IS NULL OR site_id<=>?) AND LOWER(COALESCE(primary_keyword,''))=LOWER(?) AND status NOT IN ('rejected')", [siteId || null, siteId || null, ck]);
  const others = existing.filter(r => String(r.slug || '') !== String(slug || ''));
  return others.length ? Math.min(18, others.length * 6) : 0;
}
function buildArticleSchema(article = {}) {
  const siteUrl = originOf(article.site_url || article.url || 'https://nativpost.com');
  const url = article.published_url || article.canonical_url || `${siteUrl}/blog/${article.slug || slugify(article.title || '')}`;
  const image = article.featured_image_url ? (String(article.featured_image_url).startsWith('http') ? article.featured_image_url : `${siteUrl}${article.featured_image_url}`) : '';
  const body = String(article.body || article.content || '');
  const faq = [];
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const qline = lines[i].trim();
    // H3 FAQ style with paragraph answer below
    if (/^###\s+/.test(qline)) {
      const q = qline.replace(/^###\s+/, '').trim();
      if (/\?$/.test(q) || /^(how|what|why|when|where|can|does|is|do|will|should)\b/i.test(q)) {
        // Collect the paragraph(s) that follow until next heading or blank-blank
        const answerParts = [];
        for (let j = i + 1; j < lines.length && j < i + 8; j++) {
          const next = lines[j].trim();
          if (!next) { if (answerParts.length) break; else continue; }
          if (/^#{1,6}\s+/.test(next)) break;
          answerParts.push(next.replace(/^[-*]\s+/, ''));
        }
        const answer = answerParts.join(' ').replace(/\s+/g, ' ').trim();
        if (q && answer) faq.push({ question: q, answer });
      }
    }
  }
  const detectedGame = detectGame(`${article.title || ''} ${article.primary_keyword || ''}`);
  const gameLabel = detectedGame ? gameDisplay(detectedGame) : '';
  const publishedAt = article.published_at || article.created_at || new Date().toISOString();
  const modifiedAt = article.updated_at || publishedAt;
  const graph = [];
  // WebPage anchors the URL and connects everything
  graph.push({
    '@context': 'https://schema.org', '@type': 'WebPage',
    '@id': `${url}#webpage`,
    url, name: article.title || '',
    description: article.meta_description || article.excerpt || '',
    isPartOf: { '@id': `${siteUrl}#website` },
    inLanguage: 'en-US',
    datePublished: publishedAt, dateModified: modifiedAt,
    primaryImageOfPage: image ? { '@type': 'ImageObject', url: image } : undefined
  });
  graph.push({
    '@context': 'https://schema.org', '@type': 'Article',
    '@id': `${url}#article`,
    headline: (article.title || '').slice(0, 110),
    description: article.meta_description || article.excerpt || '',
    image: image ? [image] : undefined,
    datePublished: publishedAt, dateModified: modifiedAt,
    author: { '@type': 'Organization', name: 'NativPost', url: siteUrl },
    publisher: {
      '@type': 'Organization', name: 'NativPost', url: siteUrl,
      logo: { '@type': 'ImageObject', url: `${siteUrl}/logo.png` }
    },
    mainEntityOfPage: { '@id': `${url}#webpage` },
    keywords: [article.primary_keyword || '', gameLabel].filter(Boolean).join(', '),
    articleSection: 'SEO',
    isPartOf: { '@id': `${url}#webpage` }
  });
  // Organization/Website is referenced but may already exist on the site — safe to restate
  graph.push({
    '@context': 'https://schema.org', '@type': 'WebSite',
    '@id': `${siteUrl}#website`,
    url: siteUrl, name: 'NativPost',
    potentialAction: { '@type': 'SearchAction', target: `${siteUrl}/?s={search_term_string}`, 'query-input': 'required name=search_term_string' }
  });
  // If this article targets a NativPost feature or product, add Product schema for the hosting offer.
  // This is the highest-value schema type for ranking in game-hosting SERPs.
  const isLiveHostingArticle = detectedGame && /host|server|rental|dedicated/i.test(`${article.title || ''} ${article.primary_keyword || ''}`);
  const excludedGames = []; // NativPost: no game exclusion list needed
  if (isLiveHostingArticle && !excludedGames.includes(detectedGame)) {
    const basePrice = String(process.env.NATIVPOST_BASE_PLAN_PRICE || '$19/month (Starter)').replace(/[^0-9.]/g, '') || '11';
    graph.push({
      '@context': 'https://schema.org', '@type': 'Product',
      '@id': `${url}#product`,
      name: `${gameLabel} Server Hosting`,
      description: `NativPost AI social media content platform — brand voice AI, anti-slop filter, and instant deployment. ${String(process.env.NATIVPOST_TRIAL_DAYS || 7)}-day free trial.`,
      image: image ? [image] : undefined,
      brand: { '@type': 'Brand', name: 'NativPost' },
      category: 'Social Media SEO',
      offers: {
        '@type': 'Offer',
        url: `${siteUrl}/game/${detectedGame.replace(/\s+/g, '-')}-server-hosting`,
        priceCurrency: 'USD', price: basePrice,
        priceValidUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        availability: 'https://schema.org/InStock',
        seller: { '@type': 'Organization', name: 'NativPost' }
      }
    });
  }
  if (faq.length >= 2) {
    graph.push({
      '@context': 'https://schema.org', '@type': 'FAQPage',
      '@id': `${url}#faq`,
      mainEntity: faq.slice(0, 10).map(item => ({
        '@type': 'Question', name: item.question,
        acceptedAnswer: { '@type': 'Answer', text: item.answer.slice(0, 1000) }
      }))
    });
  }
  // Speakable schema — tells Google AI Overviews and voice assistants which
  // parts to read aloud or cite. Covers h1, h2 headings and first paragraphs.
  graph.push({
    '@context': 'https://schema.org', '@type': 'WebPage',
    '@id': `${url}#webpage`,
    name: article.title || '',
    url: url,
    speakable: {
      '@type': 'SpeakableSpecification',
      cssSelector: ['h1', 'h2', 'p']
    }
  });
  graph.push({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    '@id': `${url}#breadcrumb`,
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${siteUrl}/blog` },
      { '@type': 'ListItem', position: 3, name: article.title || '', item: url }
    ]
  });
  return JSON.stringify(graph, null, 2);
}

// Wrap a JSON-LD graph as an inline <script> tag safe for embedding in HTML body.
// Escapes </script> to prevent breakout, and </ to avoid HTML parser issues.
function inlineJsonLdScript(schemaJson = '') {
  const safe = String(schemaJson || '').replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  if (!safe.trim()) return '';
  return `<script type="application/ld+json">${safe}</script>`;
}
function draftBody({ title, keyword, siteName, competitorTerms = [], ownPages = [], serp = null }) {
  const game = detectGame(`${title} ${keyword}`); const terms = competitorTerms.slice(0, 10).join(', '); const internal = ownPages.slice(0, 6).map(p => `- ${p.page_title || p.page_url}: ${p.page_url}`).join('\n'); const serpQs = (serp?.questions || []).slice(0, 5).map(q => `- ${q}`).join('\n');
  return `# ${title}

## Quick Answer
NativPost is an AI-powered social media content platform. Brands define their voice once — then NativPost generates studio-quality posts, graphics, and videos across Instagram, LinkedIn, TikTok, Twitter/X, Facebook, Pinterest, YouTube, and Threads. Starting at $19/month with a 7-day free trial.

## Why NativPost Stands Out
Unlike tools that bolt a ChatGPT wrapper onto a scheduler, NativPost uses a real brand voice engine — tone sliders (1–10), forbidden words, per-platform personality, and an anti-slop filter that scores every post 0–1 and auto-rejects anything below 0.7.

## NativPost vs Competitors
| Feature | NativPost | Ocoya | Buffer | Jasper |
|---|---|---|---|---|
| Deep brand voice config | ✓ | Shallow | ✗ | ✓ |
| Anti-slop filter | ✓ | ✗ | ✗ | ✗ |
| Content modes | ✓ | ✗ | ✗ | ✗ |
| Video generation | ✓ | ✗ | ✗ | ✗ |
| Paystack (Africa) | ✓ | ✗ | ✗ | ✗ |
| Starting price | $19/mo | $15/mo | $6/mo | $59/mo |

## Getting Started
1. Sign up at app.nativpost.com — 7-day free trial, no credit card required
2. Complete the Brand Profile (tone sliders, forbidden words, per-platform voice)
3. Connect your social accounts (Instagram, LinkedIn, TikTok, etc.)
4. Generate your first 3 content variants — review and approve the best one
5. Schedule and publish directly from the dashboard

## NativPost Plans
| Plan | Posts/mo | Platforms | Price |
|---|---|---|---|
| Starter | 15 | 3 | $19/mo |
| Growth | 40 | 6 | $39/mo |
| Pro | 80 | Unlimited | $79/mo |
| Agency | Unlimited | Unlimited | $149/mo |

All plans include a $5 one-time setup fee. 7-day free trial with 3 posts maximum.

## Competitor Gap To Beat
${terms ? `Competitor and SERP coverage show these relevant topic terms: ${terms}. Cover them naturally and more clearly than competing pages.` : 'Run competitor audits so the tool can widen topical coverage even further.'}

## FAQ
### Does NativPost work for African businesses?
Yes — NativPost accepts Paystack, making it the only AI social media tool with native African market billing support.

### Can NativPost learn my brand voice?
Yes. The Brand Profile lets you configure tone (formality/humor/energy 1–10), forbidden words, platform-specific voice, content examples, and anti-patterns. The feedback loop improves with every approval.

### What's the anti-slop filter?
Every generated post is scored 0–1 for AI-sounding language (em-dash overuse, generic openings, corporate buzzwords). Posts scoring below 0.7 are automatically rejected and regenerated.

## Get Started
Start your 7-day free trial at [app.nativpost.com](https://app.nativpost.com) — no credit card required.`
}

// ── LIVE GAMES MANAGEMENT ─────────────────────────────────────────────────
async function getLiveGamesFromDB() {
  try {
    const rows = Promise.resolve([]);
    return rows;
  } catch (e) { return []; }
}

async function refreshLiveGamesFromIGH(siteUrl = 'https://nativpost.com') {
  return { confirmed: [], debug: [] }; /* NativPost: not a game host */
  const confirmed = [];
  const debug = [];
  try {
    const base = originOf(siteUrl);
    const crawlBase = originOf(resolveCrawlUrl(base));

    // STRATEGY: Parse the Vite JS bundle directly.
    // NativPost app is a fully client-side Next.js SPA — the server returns an empty
    // <div id="root"> for every URL. All game data lives in the JS bundle.
    // We fetch the homepage, extract the bundle filename, then parse slugs from it.

    // Step 1: Get the homepage HTML to find the current bundle filename
    let bundleUrl = null;
    try {
      const { html: homeHtml } = await fetchUrl(crawlBase + '/', 10000);
      debug.push(`Homepage HTML length: ${homeHtml.length}`);
      // Extract bundle path using indexOf to avoid regex quote escaping issues
      const srcMarker = 'src="/assets/';
      const srcIdx = homeHtml.indexOf(srcMarker);
      if (srcIdx !== -1) {
        const afterSrc = homeHtml.slice(srcIdx + 5); // skip src="
        const quoteEnd = afterSrc.indexOf('"');
        if (quoteEnd !== -1) {
          const assetPath = afterSrc.slice(0, quoteEnd);
          if (assetPath.endsWith('.js')) {
            bundleUrl = crawlBase + assetPath;
            debug.push(`Found bundle: ${assetPath}`);
          }
        }
      }
      if (!bundleUrl) {
        // Try single-quote variant
        const srcMarker2 = "src='/assets/";
        const srcIdx2 = homeHtml.indexOf(srcMarker2);
        if (srcIdx2 !== -1) {
          const after = homeHtml.slice(srcIdx2 + 5);
          const end = after.indexOf("'");
          if (end !== -1) {
            const p = after.slice(0, end);
            if (p.endsWith('.js')) { bundleUrl = crawlBase + p; debug.push(`Found bundle (sq): ${p}`); }
          }
        }
      }
      if (!bundleUrl) debug.push('Bundle not found. HTML sample: ' + homeHtml.slice(0, 200).replace(/\n/g, ' '));
    } catch (e) {
      debug.push(`Homepage fetch failed: ${e.message}`);
    }

    if (!bundleUrl) {
      debug.push('Cannot detect games without bundle URL');
      return { confirmed, debug };
    }

    // Step 2: Fetch the JS bundle and extract game slugs
    let bundleJs = '';
    try {
      const { html } = await fetchUrl(bundleUrl, 30000);
      bundleJs = html;
      debug.push(`Bundle fetched: ${Math.round(bundleJs.length / 1024)}KB`);
    } catch (e) {
      debug.push(`Bundle fetch failed: ${e.message}`);
      return { confirmed, debug };
    }

    // Step 3: Extract unique game slugs from the bundle
    // Pattern: slug:"[game-name]-server-hosting" OR "/game/[game-name]-server-hosting"
    const slugSet = new Set();
    for (const m of bundleJs.matchAll(/slug:"([a-z0-9-]+)-server-hosting"/g)) slugSet.add(m[1]);
    for (const m of bundleJs.matchAll(/"\/game\/([a-z0-9-]+)-server-hosting"/g)) slugSet.add(m[1]);
    // Remove anchor variants (#pricing etc already stripped by regex above)
    debug.push(`Found ${slugSet.size} unique game slugs: ${[...slugSet].join(', ')}`);

    // Step 4: Map each slug to a game key and store as live
    for (const slug of slugSet) {
      // Convert slug to display name: "seven-days-to-die" -> "seven days to die"
      const slugText = slug.replace(/-/g, ' ');
      // Try to match against GAME_ALIASES
      let gameKey = detectGame(slugText) || detectGame(slug);
      // If no alias match, use the slug itself as the key (e.g. "voyagers-of-nera")
      if (!gameKey) gameKey = slugText;
      const label = gameDisplay(gameKey) || slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const publicUrl = `${base}/game/${slug}-server-hosting`;
      // NativPost: live_games insert skipped — table removed.
    }

    debug.push(`Done: ${confirmed.length} live games detected`);
  } catch (e) {
    debug.push(`Refresh failed: ${e.message}`);
    console.error('[LiveGames] refresh error:', e.message);
  }
  return { confirmed, debug };
}

// ══════════════════════════════════════════════════════════════════════════════
// DAILY SEO BRIEF — Smart article recommendation engine
// Analyzes: ranking gaps, competitor coverage, GSC impressions vs clicks,
// published article gaps per game, keyword clusters, and recent momentum.
// Produces a ranked list of specific article recommendations with reasoning.
// ══════════════════════════════════════════════════════════════════════════════
async function generateDailyBrief(siteId = null) {
  const today = new Date().toISOString().slice(0, 10);
  const existing = await one('SELECT * FROM daily_brief WHERE brief_date=?', [today]).catch(() => null);
  if (existing) {
    try { return JSON.parse(existing.recommendations_json); } catch (e) { }
  }

  const recommendations = [];

  function addRec(keyword, reason, score, category, evidence = []) {
    // Deduplicate — don't recommend something we've already planned
    const kl = keyword.toLowerCase().trim();
    if (recommendations.some(r => r.keyword.toLowerCase() === kl)) return;
    // Check coverage by both keyword and game name extracted from keyword
    if (covered.has(kl)) return;
    const gameInKw = detectGame(keyword);
    if (gameInKw && isGameCovered(gameKeywordName(gameInKw))) return;
    recommendations.push({ keyword, reason, score: Math.round(score), category, evidence });
  }

  const sid = siteId;

  // 1. Our published articles - build coverage from BOTH primary_keyword AND title
  const published = await q("SELECT primary_keyword, title, slug FROM articles WHERE status='published' AND primary_keyword IS NOT NULL").catch(() => []);
  const publishedKeywords = new Set(published.map(a => a.primary_keyword.toLowerCase().trim()));
  // Also extract game names from titles for articles with bad/old primary_keywords
  const publishedTitles = new Set(published.map(a => (a.title || '').toLowerCase().trim()));

  // 2. Also pull from Contentful — articles published directly (e.g. by Adaptify) bypassing local DB
  try {
    const cfSpace = process.env.CONTENTFUL_SPACE_ID;
    const cfToken = process.env.CONTENTFUL_CDA_TOKEN;
    const cfCt = process.env.CONTENTFUL_BLOG_CONTENT_TYPE_ID || 'pageBlogPost';
    if (cfSpace && cfToken) {
      const cfResp = await axios.get(
        `https://cdn.contentful.com/spaces/${cfSpace}/environments/master/entries?content_type=${cfCt}&select=fields.title,fields.slug&limit=200&access_token=${cfToken}`,
        { timeout: 8000 }
      );
      for (const item of (cfResp.data?.items || [])) {
        const f = item.fields || {};
        const title = typeof f.title === 'object' ? Object.values(f.title)[0] : f.title;
        const slug = typeof f.slug === 'object' ? Object.values(f.slug)[0] : f.slug;
        if (title) publishedTitles.add(String(title).toLowerCase().trim());
        if (slug) publishedKeywords.add(String(slug).toLowerCase().replace(/-/g, ' ').trim());
      }
    }
  } catch (e) { /* non-fatal */ }

  // 3. Our queued/drafted articles
  const inProgress = await q("SELECT primary_keyword, title FROM articles WHERE status IN ('draft','review','approved','queued') AND primary_keyword IS NOT NULL").catch(() => []);
  const inProgressKeywords = new Set(inProgress.map(a => a.primary_keyword.toLowerCase().trim()));
  const inProgressTitles = new Set(inProgress.map(a => (a.title || '').toLowerCase().trim()));

  const covered = new Set([...publishedKeywords, ...inProgressKeywords]);
  const coveredTitles = new Set([...publishedTitles, ...inProgressTitles]);

  // Helper: check if a game is covered by keyword OR title
  function isGameCovered(kwName) {
    const kn = kwName.toLowerCase();
    if ([...covered].some(c => c.includes(kn))) return true;
    if ([...coveredTitles].some(t => t.includes(kn))) return true;
    return false;
  }

  // 3. Live games we offer
  const liveGameRows = Promise.resolve([]);
  const liveGames = liveGameRows.map(g => g.game_key);

  // 4. Current rankings - keywords with high impressions but low clicks (high CTR opportunity)
  const rankingGaps = await q(`
    SELECT keyword, MIN(position) position, SUM(clicks) clicks, SUM(impressions) impressions,
           SUM(clicks)/NULLIF(SUM(impressions),0) ctr
    FROM rankings
    WHERE recorded_on >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    AND (keyword LIKE '%social media%' OR keyword LIKE '%ai%' OR keyword LIKE '%brand%' OR keyword LIKE '%content%' OR keyword LIKE '%nativpost%' OR keyword LIKE '%instagram%' OR keyword LIKE '%linkedin%' OR keyword LIKE '%tiktok%' OR keyword LIKE '%schedule%' OR keyword LIKE '%africa%')
    GROUP BY keyword
    HAVING MIN(position) BETWEEN 4 AND 30
    ORDER BY SUM(impressions) DESC
    LIMIT 50
  `).catch(() => []);

  // 5. Competitor keyword gaps - keywords competitors rank for but we don't have articles for
  const competitorGaps = await q(`
    SELECT cp.page_title, cp.page_url, cp.word_count,
           COALESCE(c.name, c.competitor_name) comp_name, c.audit_score
    FROM competitor_pages cp
    JOIN competitors c ON c.id=cp.competitor_id
    WHERE c.active=1
    AND cp.page_type IN ('game','blog','money')
    AND cp.word_count > 500
    ORDER BY c.audit_score DESC, cp.word_count DESC
    LIMIT 100
  `).catch(() => []);

  // 6. Keywords with high priority scores we haven't written about
  const untappedKeywords = await q(`
    SELECT keyword, priority_score, volume, difficulty, intent, source
    FROM keywords
    WHERE priority_score > 50
    AND keyword LIKE '% %'
    ORDER BY priority_score DESC, volume DESC
    LIMIT 100
  `).catch(() => []);

  // --- ANALYSIS & SCORING ---

  // CATEGORY A: Ranking position 4-10 with high impressions but we have no article
  // These are keywords Google already shows us for — an article would improve CTR dramatically
  for (const row of rankingGaps) {
    const kl = row.keyword.toLowerCase();
    if (covered.has(kl)) continue;
    const pos = Number(row.position);
    const impressions = Number(row.impressions);
    const clicks = Number(row.clicks);
    const ctr = clicks / Math.max(1, impressions);
    // Score: high impressions + low position number + low CTR = highest priority
    const score = (impressions / 10) + ((30 - pos) * 8) + ((0.15 - Math.min(ctr, 0.15)) * 200);
    addRec(
      row.keyword,
      `Currently ranking #${pos.toFixed(0)} with ${impressions.toLocaleString()} impressions but only ${clicks} clicks (${(ctr * 100).toFixed(1)}% CTR). A dedicated article targeting this exact keyword would push ranking higher and dramatically increase clicks.`,
      score,
      'ranking-gap',
      [`Position: #${pos.toFixed(0)}`, `Impressions/mo: ${impressions}`, `Clicks: ${clicks}`, `CTR: ${(ctr * 100).toFixed(1)}%`]
    );
  }

  // CATEGORY B: Live games with NO published article at all
  for (const gameKey of liveGames) {
    const label = gameDisplay(gameKey);
    const kwName = gameKeywordName(gameKey);
    const kw = `${kwName}`; // NativPost: use keyword as-is, no 'server hosting' suffix
    if (isGameCovered(kwName)) continue;
    const score = 220;
    addRec(
      kw,
      `NativPost has no published content for this keyword yet. This is a direct organic traffic gap — anyone searching "${kw}" won't find NativPost content.`,
      score,
      'game-coverage',
      [`Live game: ${label}`, `Article coverage: none`, `Priority: high`]
    );
  }

  // CATEGORY C: Competitor content gaps — they have it, we don't
  for (const page of competitorGaps) {
    const pageGame = detectGame(`${page.page_url || ''} ${page.page_title || ''}`);
    if (pageGame && !liveGames.includes(pageGame)) continue;
    // Clean the page title to extract a usable keyword — strip competitor names
    let rawKw = cleanKeyword(page.page_title || '');
    if (!rawKw) continue;
    // Strip competitor brand names from the keyword
    const compBrands = ['game host bros', 'gamehostbros', 'nitrado', 'gportal', 'shockbyte',
      'bisecthosting', 'bisect hosting', 'hosthavoc', 'nodecraft', 'scalacube', 'sparkedhost',
      'pingperfect', 'fragnet', 'gtxgaming', 'pinehosting', 'dathost', 'ghostcap', 'qonzer'];
    for (const brand of compBrands) {
      rawKw = rawKw.replace(new RegExp('\\s*[-–]?\\s*' + brand + '.*$', 'i'), '').trim();
      rawKw = rawKw.replace(new RegExp(brand, 'gi'), '').trim();
    }
    rawKw = rawKw.replace(/\s*[-–]\s*$/, '').replace(/\s+/g, ' ').trim();
    if (!rawKw || rawKw.length < 8) continue;
    if (covered.has(rawKw.toLowerCase())) continue;
    const score = 80 + (Number(page.audit_score || 0) / 5) + Math.min(50, Number(page.word_count || 0) / 40);
    addRec(
      rawKw,
      `Top competitors cover this topic with ${page.word_count.toLocaleString()}-word articles and we have nothing equivalent. Writing a stronger, more detailed article on this keyword directly attacks their ranking advantage.`,
      score,
      'competitor-gap',
      [`Competitor audit score: ${page.audit_score}`, `Their word count: ${page.word_count}`, `Gap type: missing coverage`]
    );
  }

  // CATEGORY D: High-priority keywords from our keyword table we haven't written about
  for (const kw of untappedKeywords) {
    if (covered.has(kw.keyword.toLowerCase())) continue;
    const score = Number(kw.priority_score || 0) * 0.6 + Number(kw.volume || 0) * 0.1;
    if (score < 40) continue;
    addRec(
      kw.keyword,
      `High-priority ${kw.intent || 'commercial'} keyword from ${kw.source || 'research'} (priority score: ${Number(kw.priority_score).toFixed(0)}${kw.volume ? ', volume: ' + kw.volume : ''}). No article written yet.`,
      score,
      'keyword-opportunity',
      [`Source: ${kw.source}`, `Intent: ${kw.intent}`, `Priority score: ${Number(kw.priority_score).toFixed(0)}`]
    );
  }

  // CATEGORY E: Secondary articles for games that only have 1 article
  for (const gameKey of liveGames) {
    const label = gameDisplay(gameKey);
    const kwName = gameKeywordName(gameKey);
    const gameArticles = published.filter(a =>
      (a.primary_keyword || '').toLowerCase().includes(kwName) ||
      (a.title || '').toLowerCase().includes(kwName)
    );
    if (gameArticles.length === 0) continue; // Handled in Category B
    if (gameArticles.length >= 4) continue; // Already well-covered

    // Suggest missing secondary articles
    const secondaryTargets = [
      { kw: `best ${kwName} tool`, note: 'comparison/review — catches buyer searches' },
      { kw: `${kwName} server setup guide`, note: 'how-to — captures informational traffic' },
      { kw: `cheap ${kwName} server hosting`, note: 'price-intent — high buying intent' },
      { kw: `${kwName} dedicated server hosting`, note: 'dedicated server variant — different buyer intent' },
    ];
    for (const t of secondaryTargets) {
      if (covered.has(t.kw.toLowerCase())) continue;
      addRec(
        t.kw,
        `${label} only has ${gameArticles.length} article(s). Adding a ${t.note} article builds topical authority and captures related searches.`,
        65 + (4 - gameArticles.length) * 10,
        'topical-depth',
        [`Game: ${label}`, `Existing articles: ${gameArticles.length}`, `Gap type: ${t.note}`]
      );
    }
  }

  // Sort by score and take top 10
  recommendations.sort((a, b) => b.score - a.score);
  const top = recommendations.slice(0, 10);

  // Build summary
  const summary = `${top.length} recommendations: ${top.filter(r => r.category === 'ranking-gap').length} ranking gaps, ${top.filter(r => r.category === 'game-coverage').length} game coverage gaps, ${top.filter(r => r.category === 'competitor-gap').length} competitor gaps, ${top.filter(r => r.category === 'topical-depth').length} topical depth opportunities.`;

  // Store in DB
  await execSafe('INSERT INTO daily_brief (brief_date, recommendations_json, summary, generated_at) VALUES (?,?,?,NOW()) ON DUPLICATE KEY UPDATE recommendations_json=VALUES(recommendations_json), summary=VALUES(summary), generated_at=NOW()',
    [today, JSON.stringify(top), summary]);

  return top;
}

function startDailyBriefRefresher() {
  // Regenerate the brief once per day at 7am app timezone
  async function tick() {
    try {
      // Clear yesterday's brief so today's gets freshly generated
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await execSafe('DELETE FROM daily_brief WHERE brief_date < ?', [yesterday]);
      await generateDailyBrief(null);
      console.log('[DailyBrief] Daily brief generated.');
    } catch (e) { console.error('[DailyBrief] Generation failed:', e.message); }
  }
  // Run first at 7am, then every 24h
  const now = new Date();
  const next7am = new Date(now);
  next7am.setHours(7, 0, 0, 0);
  if (next7am <= now) next7am.setDate(next7am.getDate() + 1);
  const msUntil7am = next7am - now;
  setTimeout(() => { tick(); setInterval(tick, 24 * 60 * 60 * 1000); }, msUntil7am);
  // Also generate on boot after 2 minutes
  setTimeout(tick, 2 * 60 * 1000);
  console.log(`Daily brief scheduler enabled. Next run in ${Math.round(msUntil7am / 60000)}min.`);
}
// Fetches the NativPost pricing page and extracts real pricing / RAM packages.
// Caches result for 24 hours so it only re-fetches when stale.
// Injected into every article prompt so the AI knows exactly what NativPost offers.
// ══════════════════════════════════════════════════════════════════════════════
async function fetchLivePackagesForGame(gameKey = '', siteUrl = 'https://nativpost.com') {
  // NativPost: returns static plan facts instead of scraping game pages
  return 'NativPost plans: Starter $19/mo (15 posts, 3 platforms) | Growth $39/mo (40 posts, 6 platforms, video) | Pro $79/mo (80 posts, unlimited platforms) | Agency $149/mo (unlimited posts, 5 brand profiles). $5 one-time setup fee. 7-day free trial (3 posts max, text only). Paystack accepted for African markets.';
}

async function getLiveGamesFacts() {
  // NativPost: returns platform/feature facts instead of game availability
  return 'NATIVPOST PLATFORM FACTS: Supported platforms: Instagram, Facebook, LinkedIn, LinkedIn Pages, Twitter/X, TikTok, Pinterest, YouTube, Threads. Content modes: Normal (balanced), Concise (max 3 sentences), Controversial (strategic provocation). Video formats: Slideshow, Text Motion Card, Voiceover Slideshow, UGC Ad, Data Story. Anti-slop filter: scores every post 0-1, auto-rejects below 0.7. Brand voice: tone sliders 1-10, forbidden words, per-platform voice, topic memory. Paystack accepted for Africa.';
}


// ── GAME KNOWLEDGE BASE — NativPost: game_facts table removed, stub returns null ───────────
async function getGameFacts(gameKey) {
  // NativPost is not a game hosting service — game_facts table removed.
  return null;
}

function buildGameFactsPrompt(facts, gameKey) {
  if (!facts) return '';
  const lines = [];
  lines.push(`VERIFIED FACTS FOR ${(facts.game_key || gameKey).toUpperCase()} (use these EXACTLY — do not invent or adjust):`);
  if (facts.dedicated_server_available === 0) {
    lines.push(`⚠ CRITICAL: Dedicated servers DO NOT exist for this game yet. Do NOT write as if hosting is available to purchase. Write anticipation/preview content only.`);
    if (facts.custom_facts) lines.push(facts.custom_facts);
    return lines.join('\n');
  }
  if (facts.max_players) lines.push(`- Maximum players per server: ${facts.max_players} (do NOT say more than this)`);
  if (facts.min_players) lines.push(`- Minimum recommended players: ${facts.min_players}`);
  if (facts.ram_min_gb) lines.push(`- Minimum RAM: ${facts.ram_min_gb}GB`);
  if (facts.ram_notes) lines.push(`- RAM guide: ${facts.ram_notes}`);
  if (facts.engine) lines.push(`- Game engine: ${facts.engine}`);
  if (facts.server_os) lines.push(`- Server OS: ${facts.server_os}`);
  if (facts.steamcmd_app_id) lines.push(`- SteamCMD/Dedicated Server App ID: ${facts.steamcmd_app_id}`);
  if (facts.steam_app_id) lines.push(`- Steam App ID: ${facts.steam_app_id}`);
  if (facts.steam_url) lines.push(`- Official Steam page: ${facts.steam_url}`);
  if (facts.official_site) lines.push(`- Official website: ${facts.official_site}`);
  if (facts.release_status) lines.push(`- Release status: ${facts.release_status}`);
  if (facts.release_date) lines.push(`- Release date: ${facts.release_date}`);
  if (facts.genre) lines.push(`- Genre: ${facts.genre}`);
  if (facts.developer) lines.push(`- Developer: ${facts.developer}`);
  if (facts.custom_facts) lines.push(`- Additional facts: ${facts.custom_facts}`);
  lines.push(`ACCURACY RULE: Only state facts from the list above. Do not invent player counts, RAM tiers, or setup steps not listed here.`);
  return lines.join('\n');
}

async function makeDraftFromKeyword(keywordRow, siteId) {
  const site = await one('SELECT * FROM sites WHERE id=?', [siteId || keywordRow.site_id]) || await one('SELECT * FROM sites WHERE active=1 ORDER BY id LIMIT 1');
  const rawKeyword = cleanKeyword(keywordRow.keyword) || strategicFallbackTopics()[0];
  let ownPages = await q("SELECT page_url,page_title,page_type,word_count FROM site_pages WHERE site_id=? ORDER BY FIELD(page_type,'money','game','blog','support','page'), word_count DESC LIMIT 12", [site?.id]);
  // Fallback: if crawl failed and we have no pages, provide known NativPost URLs so articles can include internal links
  if (!ownPages || ownPages.length === 0 || ownPages.every(p => p.page_title === 'Crawl failed')) {
    const siteBase = originOf(site?.url || 'https://nativpost.com');
    ownPages = [
      { page_url: siteBase + '/pricing', page_title: 'NativPost Pricing — Starter, Growth, Pro, Agency', page_type: 'money', word_count: 500 },
      { page_url: siteBase + '/game/windrose-server-hosting', page_title: 'Windrose Server Hosting', page_type: 'money', word_count: 400 },
      { page_url: siteBase + '/features', page_title: 'NativPost Features — Brand Voice, AI Content, Video', page_type: 'money', word_count: 400 },
      { page_url: siteBase + '/game/valheim-server-hosting', page_title: 'Valheim Server Hosting', page_type: 'money', word_count: 400 },
      { page_url: siteBase + '/game/minecraft-server-hosting', page_title: 'Minecraft Server Hosting', page_type: 'money', word_count: 400 },
      { page_url: siteBase + '/game/rust-server-hosting', page_title: 'Rust Server Hosting', page_type: 'money', word_count: 400 },
      { page_url: siteBase + '/support', page_title: 'Support & Setup Help', page_type: 'support', word_count: 200 },
      { page_url: siteBase + '/blog', page_title: 'Game Server Blog & Guides', page_type: 'blog', word_count: 200 },
    ];
    // Also add any live games from DB
    try {
      const liveG = Promise.resolve([]);
      for (const g of liveG) {
        const pageUrl = g.igh_page_url || (siteBase + '/game/' + g.game_key.replace(/\s+/g, '-') + '-server-hosting');
        if (!ownPages.find(p => p.page_url === pageUrl)) {
          ownPages.push({ page_url: pageUrl, page_title: g.game_label + ' Server Hosting', page_type: 'money', word_count: 400 });
        }
      }
    } catch (e) { }
  }
  const compPages = await q("SELECT cp.page_url,cp.page_title,cp.page_type,cp.word_count,cp.meta_description FROM competitor_pages cp JOIN competitors c ON c.id=cp.competitor_id WHERE c.active=1 AND (c.site_id<=>? OR c.site_id IS NULL) ORDER BY cp.word_count DESC LIMIT 20", [site?.id || null]);
  const comps = await q('SELECT snapshot_json FROM competitors WHERE active=1 AND (site_id<=>? OR site_id IS NULL) AND snapshot_json IS NOT NULL ORDER BY audit_score DESC LIMIT 5', [site?.id || null]);
  let terms = []; for (const c of comps) { const j = safeJsonParse(c.snapshot_json, {}); terms = terms.concat((j.keywords || []).map(k => k.keyword)); }
  terms = [...new Set(terms.map(cleanKeyword).filter(Boolean))];
  const imageHints = await q('SELECT * FROM article_assets WHERE (site_id=? OR site_id IS NULL) ORDER BY id DESC LIMIT 20', [site?.id || null]);
  const offerFacts = await scannedOfferFacts(site?.id || null);
  const liveGamesFacts = await getLiveGamesFacts();
  // Fetch per-game knowledge base facts
  const detectedGame = detectGame(rawKeyword) || detectGame(keywordRow.keyword || '');
  const gameFacts = detectedGame ? await getGameFacts(detectedGame) : null;
  const gameFactsPrompt = buildGameFactsPrompt(gameFacts, detectedGame);
  // Live-scrape the NativPost pricing page for real package/pricing data
  const siteBase = originOf(site?.url || 'https://nativpost.com');
  const livePackageFacts = detectedGame ? await fetchLivePackagesForGame(detectedGame, siteBase) : '';
  let serp = await analyzeSerpForKeyword({ siteId: site?.id || null, keyword: rawKeyword, siteUrl: site?.url || '' });
  if (!serp || typeof serp !== 'object') serp = { keyword: rawKeyword, query: rawKeyword, results: [], headings: [], questions: [], entities: [], avg_words: 0 };
  serp.results = Array.isArray(serp.results) ? serp.results : [];
  serp.entities = Array.isArray(serp.entities) ? serp.entities : [];
  serp.headings = Array.isArray(serp.headings) ? serp.headings : [];
  serp.questions = Array.isArray(serp.questions) ? serp.questions : [];
  const cluster = await upsertTopicCluster(site?.id || null, rawKeyword, serp);
  const ai = await callOpenAIArticle({ site, keyword: rawKeyword, ownPages, competitorPages: compPages.concat(serp.results.map(r => ({ page_url: r.url || r.result_url, page_title: r.title || r.result_title, word_count: r.word_count, page_type: 'serp' }))), competitorTerms: [...terms, ...serp.entities], imageHints, offerFacts: [offerFacts, liveGamesFacts, gameFactsPrompt, livePackageFacts].filter(Boolean).join('\n'), serp });
  let title, body, meta, excerpt, imageAlt, notes;
  if (ai) {
    title = truncate(ai.title || articleTitleFor(rawKeyword), 50);  // Contentful shortDescription max is 50 chars
    body = ai.body_markdown;
    meta = truncate(ai.meta_description || `Learn how ${rawKeyword} works and why NativPost is the best AI social media content platform in 2026.`, 160);
    excerpt = truncate(ai.excerpt || meta, 150);  // Contentful shortDescription max is 224 chars; use 150 for safety
    imageAlt = ai.featured_image_alt || `${rawKeyword} hosting image`;
    notes = `AI generated from crawl data, competitor pages, live SERP results, internal links, and keyword gaps. ${ai.review_notes || ''}`;
  } else {
    // OpenAI failed or not connected — throw a clear error instead of saving garbage fallback content
    if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      throw new Error('No AI API key set. Add ANTHROPIC_API_KEY (primary) or OPENAI_API_KEY (fallback) to ecosystem.config.js.');
    }
    throw new Error('OpenAI returned no content for "' + rawKeyword + '". Check your API key, model name, and usage limits. Try again — transient failures are common.');
  }
  body = repairOfferClaims(body);
  meta = truncate(repairOfferClaims(meta), 160);
  excerpt = truncate(repairOfferClaims(excerpt), 150);
  const offerNote = offerReviewNote(`${title}\n${meta}\n${excerpt}\n${body}`);
  if (offerNote) notes = `${notes}\n${offerNote}`.trim();
  const game = detectGame(rawKeyword);
  let asset = game ? await ensurePressKitAssetForGame(game, site?.id || null) : null;
  // Fallback: fetch a relevant topic image from Unsplash Source for non-game or no-image articles
  if (!asset) {
    try { asset = await fetchTopicImageForKeyword(rawKeyword, site?.id || null); } catch (e) { console.log('[Image] Topic fallback failed:', e.message); }
  }
  if (!asset) notes = `${notes}\nImage needed: no image found for "${rawKeyword}". Upload a relevant image from the Image Library or re-generate.`.trim();
  const slug = slugify((ai?.slug || title || rawKeyword));
  const penalty = await cannibalizationPenalty(site?.id || null, rawKeyword, slug);
  const result = await q('INSERT INTO articles (site_id,keyword_id,title,slug,status,primary_keyword,meta_title,meta_description,excerpt,body,content,featured_image_id,featured_image_url,featured_image_alt,review_notes,cannibalization_penalty,quality_score) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [site?.id || null, keywordRow.id || null, title, slug, 'draft', rawKeyword, truncate(ai?.meta_title || title, 500), meta, excerpt, body, body, asset?.id || null, normalizeImageUrl(asset?.asset_url) || null, imageAlt || asset?.alt_text || null, notes, penalty, 0]);
  const article = await one('SELECT a.*, s.url site_url FROM articles a LEFT JOIN sites s ON s.id=a.site_id WHERE a.id=?', [result.insertId]);
  const breakdown = qualityBreakdown(article);
  const schemaJson = buildArticleSchema(article);
  const finalNotes = [notes, `Cluster: ${cluster || clusterName(rawKeyword)}.`, `SERP avg words: ${serp.avg_words || 0}.`, breakdown.notes.length ? `Quality gate ${breakdown.score}/${MIN_QUALITY_SCORE}: ${breakdown.notes.join(' ')}` : `Quality gate ${breakdown.score}/${MIN_QUALITY_SCORE}: Ready.`].filter(Boolean).join('\n');
  await q('UPDATE articles SET quality_score=?, review_notes=?, schema_json=?, status=? WHERE id=?', [breakdown.score, finalNotes, schemaJson, breakdown.score >= MIN_QUALITY_SCORE ? 'review' : 'draft', result.insertId]);
  for (const r of serp.results.slice(0, 6)) await execSafe('INSERT INTO backlinks (site_id,competitor_id,source_domain,source_url,target_url,anchor_text,authority_score,status) VALUES (?,?,?,?,?,?,?,?)', [site?.id || null, null, hostOf(r.url || ''), r.url || '', `${originOf(site?.url || 'https://nativpost.com')}/blog/${slug}`, rawKeyword, 0, 'prospect']);
  return result.insertId;
}

function contentfulToken() { return process.env.CONTENTFUL_CMA_TOKEN || process.env.CONTENTFUL_MANAGEMENT_TOKEN || ''; }
function contentfulContentType() { return process.env.CONTENTFUL_BLOG_CONTENT_TYPE_ID || process.env.CONTENTFUL_CONTENT_TYPE || 'pageBlogPost'; }
function contentfulReady() { return !!(process.env.CONTENTFUL_SPACE_ID && contentfulToken() && contentfulContentType()); }
function publishModeAllowsContentful() {
  const m = String(process.env.PUBLISH_MODE || 'contentful').toLowerCase().replace(/_/g, '');
  // Any mode containing 'manual', 'off', or 'disabled' prevents auto-contentful publish
  if (/manual|off|disabled/.test(m)) return false;
  return contentfulReady();
}
function googleCredentialsStatus() { const serviceAccount = !!(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) || !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !!process.env.GOOGLE_APPLICATION_CREDENTIALS; const oauth = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET); return { serviceAccount, oauth, configured: serviceAccount || oauth, label: serviceAccount ? 'Service account configured' : (oauth ? 'OAuth client configured' : 'Missing') }; }

// ── GOOGLE OAUTH + GSC + GA4 ──────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI || ('http://localhost:' + (process.env.PORT || 7783) + '/api/auth/google/callback');
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly';

async function ensureGoogleTokenTable() {
  await execSafe(`CREATE TABLE IF NOT EXISTS google_oauth_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    access_token TEXT NULL,
    refresh_token TEXT NULL,
    expiry_date BIGINT DEFAULT 0,
    scope TEXT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
}

async function getStoredGoogleToken() {
  await ensureGoogleTokenTable();
  return one('SELECT * FROM google_oauth_tokens ORDER BY id DESC LIMIT 1');
}

async function saveGoogleToken(tokens) {
  await ensureGoogleTokenTable();
  const existing = await one('SELECT id FROM google_oauth_tokens LIMIT 1');
  if (existing) {
    await q('UPDATE google_oauth_tokens SET access_token=?, refresh_token=COALESCE(?,refresh_token), expiry_date=?, scope=? WHERE id=?',
      [tokens.access_token || null, tokens.refresh_token || null, tokens.expiry_date || 0, tokens.scope || null, existing.id]);
  } else {
    await q('INSERT INTO google_oauth_tokens (access_token,refresh_token,expiry_date,scope) VALUES (?,?,?,?)',
      [tokens.access_token || null, tokens.refresh_token || null, tokens.expiry_date || 0, tokens.scope || null]);
  }
}

async function getValidAccessToken() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return null;
  const stored = await getStoredGoogleToken().catch(() => null);
  if (!stored || !stored.refresh_token) return null;
  const now = Date.now();
  if (stored.access_token && stored.expiry_date && (stored.expiry_date - now) > 60000) return stored.access_token;
  try {
    const resp = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: stored.refresh_token, grant_type: 'refresh_token'
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const newTokens = { ...stored, access_token: resp.data.access_token, expiry_date: now + (resp.data.expires_in || 3600) * 1000 };
    await saveGoogleToken(newTokens);
    return newTokens.access_token;
  } catch (e) { console.error('Google token refresh failed:', e.message); return null; }
}

async function googleConnected() {
  try { const t = await getStoredGoogleToken(); return !!(t && t.refresh_token); } catch (e) { return false; }
}

async function syncGSCData(siteId, gscProperty) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('No valid Google token — connect Google in Settings first.');
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = 'https://searchconsole.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(gscProperty) + '/searchAnalytics/query';
  const resp = await axios.post(url, { startDate, endDate, dimensions: ['page', 'query'], rowLimit: 5000, startRow: 0 },
    { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
  const rows = resp.data.rows || [];
  let imported = 0;

  // Competitor brand names — filter these OUT of rankings, they are not our keywords
  const COMPETITOR_BRANDS = ['ocoya', 'predis', 'buffer', 'hootsuite', 'sprout social', 'later',
    'feedhive', 'socialbee', 'contentstudio', 'postbridge', 'jasper', 'copy.ai', 'writesonic',
    'semrush', 'ahrefs', 'hubspot', 'mailchimp', 'canva', 'planoly', 'tailwind app',
    'nitrado', 'gportal', 'g-portal', 'shockbyte', 'bisecthosting', 'hosthavoc', 'apexhosting',
    'apex hosting', 'scalacube', 'nodecraft', 'sparkedhost', 'pingperfect', 'fragnet'];

  function isRelevantGSCKeyword(kw) {
    const k = String(kw || '').toLowerCase().trim();
    if (!k || k.length < 3) return false;
    for (const brand of COMPETITOR_BRANDS) { if (k.includes(brand)) return false; }
    if (/[^\u0000-\u007f]{3,}/.test(k)) return false; // non-English garbage
    // Block clearly irrelevant navigational/unrelated queries
    if (/\b(crack|torrent|porn|xxx|casino|gambling|betting|keygen|warez)\b/.test(k)) return false;
    // NativPost branded queries — always keep
    if (/nativpost/.test(k)) return true;
    // Core NativPost product topics: social media, AI content, brand voice, scheduling
    if (/(social media|content|brand|caption|post|schedule|publish|automate|automation)/.test(k)) return true;
    if (/(instagram|linkedin|tiktok|twitter|facebook|youtube|threads|pinterest)/.test(k)) return true;
    if (/(ai.*(tool|platform|writer|generator|content|post|caption)|content.*ai|brand.*voice|brand.*profile|anti.slop|tone|voice)/.test(k)) return true;
    if (/(agency|freelancer|creator|influencer|startup|saas|b2b|ecommerce|marketing|copywriting)/.test(k)) return true;
    // Africa / Paystack markets
    if (/(africa|nigeria|kenya|ghana|south.africa|paystack|naira)/.test(k)) return true;
    // If GSC reports it, it landed on nativpost.com — keep everything not already blocked above
    return true;
  }

  for (const row of rows) {
    const pageUrl = (row.keys[0] || '').slice(0, 1023);
    const keyword = (row.keys[1] || '').slice(0, 499);
    const clicks = Math.round(row.clicks || 0);
    const impressions = Math.round(row.impressions || 0);
    const position = parseFloat((row.position || 50).toFixed(2));
    const ctr = parseFloat((row.ctr || 0).toFixed(6));
    if (!keyword || !pageUrl) continue;
    if (!isRelevantGSCKeyword(keyword)) continue;
    await execSafe('INSERT INTO rankings (site_id,keyword,page_url,position,clicks,impressions,ctr,recorded_on) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE position=VALUES(position),clicks=VALUES(clicks),impressions=VALUES(impressions),ctr=VALUES(ctr)',
      [siteId, keyword, pageUrl, position, clicks, impressions, ctr, endDate]);
    await execSafe('INSERT INTO ranking_history (site_id,keyword,page_url,position,clicks,impressions,recorded_on) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE position=VALUES(position),clicks=VALUES(clicks),impressions=VALUES(impressions)',
      [siteId, keyword, pageUrl, position, clicks, impressions, endDate]);
    const ck = cleanKeyword(keyword);
    if (ck) await execSafe('INSERT INTO keywords (site_id,keyword,cluster_name,volume,difficulty,priority_score,source,intent,last_updated) VALUES (?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE priority_score=GREATEST(priority_score,VALUES(priority_score)),source=VALUES(source),last_updated=NOW()',
      [siteId, ck, clusterName(ck), impressions, 30, priorityScore({ impressions, clicks, position }), 'gsc', intentOf(ck)]);
    imported++;
  }
  // Clean up previously-imported competitor brand keywords
  for (const brand of COMPETITOR_BRANDS) {
    await execSafe('DELETE FROM rankings WHERE keyword LIKE ?', ['%' + brand + '%']);
    await execSafe('DELETE FROM ranking_history WHERE keyword LIKE ?', ['%' + brand + '%']);
    await execSafe("DELETE FROM keywords WHERE keyword LIKE ? AND source='gsc'", ['%' + brand + '%']);
  }
  return imported;
}

async function syncGA4Data(siteId, propertyId) {
  const token = await getValidAccessToken();
  if (!token) throw new Error('No valid Google token — connect Google in Settings first.');
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = 'https://analyticsdata.googleapis.com/v1beta/properties/' + propertyId + ':runReport';
  const resp = await axios.post(url, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'engagementRate' }],
    limit: 5000
  }, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
  const rows = resp.data.rows || [];
  let imported = 0;
  for (const row of rows) {
    const pagePath = ((row.dimensionValues[0] || {}).value || '').slice(0, 1023);
    const pageTitle = ((row.dimensionValues[1] || {}).value || '').slice(0, 499);
    const views = Math.round(Number((row.metricValues[0] || {}).value || 0));
    const sessions = Math.round(Number((row.metricValues[1] || {}).value || 0));
    const engRate = parseFloat((Number((row.metricValues[2] || {}).value || 0)).toFixed(6));
    if (!pagePath) continue;
    await execSafe('INSERT INTO page_metrics (site_id,page_path,page_title,views,sessions,engagement_rate,report_date) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE views=VALUES(views),sessions=VALUES(sessions),engagement_rate=VALUES(engagement_rate)',
      [siteId, pagePath, pageTitle, views, sessions, engRate, endDate]);
    imported++;
  }
  return imported;
}
function markdownToContentfulRichText(md) {
  const blocks = [];
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let tableRows = [], inTable = false, inList = false, listItems = [], inOl = false;

  function flushList() {
    if (!listItems.length) return;
    const listType = inOl ? 'ordered-list' : 'unordered-list';
    blocks.push({
      nodeType: listType, data: {}, content: listItems.map(text => ({
        nodeType: 'list-item', data: {}, content: [{ nodeType: 'paragraph', data: {}, content: inlineNodes(text) }]
      }))
    });
    listItems = []; inList = false; inOl = false;
  }

  function flushTable() {
    if (!tableRows.length) { inTable = false; return; }
    // Parse rows: filter out separator rows (---|---), extract cells
    const parsed = tableRows.map(row => row.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1));
    const dataRows = parsed.filter(cells => !cells.every(c => /^[-:]+$/.test(c)));
    if (!dataRows.length) { tableRows = []; inTable = false; return; }
    const tableContent = dataRows.map((cells, ri) => ({
      nodeType: 'table-row', data: {}, content: cells.map(cell => ({
        nodeType: ri === 0 ? 'table-header-cell' : 'table-cell', data: {},
        content: [{ nodeType: 'paragraph', data: {}, content: inlineNodes(cell) }]
      }))
    }));
    blocks.push({ nodeType: 'table', data: {}, content: tableContent });
    tableRows = []; inTable = false;
  }

  function inlineNodes(text = '') {
    // Convert **bold**, *italic*, and [text](url) links to Contentful inline nodes
    const nodes = [];
    // Split on bold, italic, and markdown links
    const parts = String(text || '').split(/(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith('**') && part.endsWith('**')) {
        nodes.push({ nodeType: 'text', value: part.slice(2, -2), marks: [{ type: 'bold' }], data: {} });
      } else if (part.startsWith('*') && part.endsWith('*') && !part.startsWith('**')) {
        nodes.push({ nodeType: 'text', value: part.slice(1, -1), marks: [{ type: 'italic' }], data: {} });
      } else if (/^\[[^\]]+\]\([^)]+\)$/.test(part)) {
        // Markdown link — convert to Contentful hyperlink node
        const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          const [, linkText, linkUrl] = linkMatch;
          nodes.push({
            nodeType: 'hyperlink',
            data: { uri: linkUrl },
            content: [{ nodeType: 'text', value: linkText, marks: [], data: {} }]
          });
        }
      } else {
        if (part) nodes.push({ nodeType: 'text', value: part, marks: [], data: {} });
      }
    }
    return nodes.length ? nodes : [{ nodeType: 'text', value: String(text || ''), marks: [], data: {} }];
  }

  for (const raw of lines) {
    const line = raw.trim();

    // Table
    if (line.startsWith('|') && line.endsWith('|')) {
      flushList();
      inTable = true;
      tableRows.push(line);
      continue;
    }
    if (inTable) flushTable();

    if (!line) { flushList(); continue; }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      flushList();
      const level = Math.min(6, h[1].length);
      blocks.push({ nodeType: 'heading-' + level, data: {}, content: inlineNodes(h[2]) });
      continue;
    }

    // Unordered list
    const ul = line.match(/^[-*]\s+(.+)$/);
    if (ul) { inList = true; inOl = false; listItems.push(ul[1]); continue; }

    // Ordered list
    const ol = line.match(/^\d+[.)]\s+(.+)$/);
    if (ol) { inList = true; inOl = true; listItems.push(ol[1]); continue; }

    // Horizontal rule — skip
    if (/^[-*_]{3,}$/.test(line)) { flushList(); continue; }

    // Paragraph
    flushList();
    blocks.push({ nodeType: 'paragraph', data: {}, content: inlineNodes(line) });
  }

  flushList();
  if (inTable) flushTable();
  if (!blocks.length) blocks.push({ nodeType: 'paragraph', data: {}, content: [{ nodeType: 'text', value: '', marks: [], data: {} }] });
  return { nodeType: 'document', data: {}, content: blocks };
}
function bodyForContentful(article) {
  const format = String(process.env.PUBLISH_BODY_FORMAT || 'richtext').toLowerCase(); // pageBlogPost.content is Rich Text
  const body = article.body || article.content || '';
  if (format === 'markdown') {
    // Markdown formats in CF get JSON-LD as an HTML comment fence — most markdown
    // renderers pass raw HTML through, so the <script> tag will survive to the page.
    if (String(process.env.EMBED_JSONLD_IN_BODY || 'true').toLowerCase() !== 'false') {
      const schemaJson = article.schema_json || buildArticleSchema(article);
      const tag = inlineJsonLdScript(schemaJson);
      if (tag) return tag + '\n\n' + body;
    }
    return body;
  }
  if (format === 'html') {
    const html = markdownToHtml(body);
    if (String(process.env.EMBED_JSONLD_IN_BODY || 'true').toLowerCase() !== 'false') {
      const schemaJson = article.schema_json || buildArticleSchema(article);
      const tag = inlineJsonLdScript(schemaJson);
      if (tag) return tag + '\n' + html;
    }
    return html;
  }
  // richtext path — Contentful strips <script> tags from rich text, so we can't
  // embed JSON-LD here. The dedicated CONTENTFUL_FIELD_SCHEMA_JSONLD field handles it.
  return markdownToContentfulRichText(body);
}

function mimeTypeFromUrl(url = '') {
  const lower = String(url || '').toLowerCase().split('?')[0];
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}
function fileNameFromUrl(url = '', fallback = 'featured-image.jpg') {
  try {
    const last = new URL(url, 'https://local.invalid').pathname.split('/').pop();
    return (last && /\.[a-z0-9]{2,5}$/i.test(last)) ? last : fallback;
  } catch { return fallback; }
}
async function createContentfulAssetFromArticleAsset(asset) {
  if (!asset || asset.contentful_asset_id) return asset?.contentful_asset_id || '';
  if (!contentfulReady()) return '';
  const space = process.env.CONTENTFUL_SPACE_ID, env = process.env.CONTENTFUL_ENVIRONMENT_ID || 'master', token = contentfulToken();
  const locale = process.env.CONTENTFUL_LOCALE || 'en-US';
  let uploadUrl = normalizeImageUrl(asset.asset_url || '');
  if (!uploadUrl) return '';
  if (uploadUrl.startsWith('/uploads/')) {
    const localPath = path.join(uploadDir, path.basename(uploadUrl));
    if (!fs.existsSync(localPath)) return '';
    const uploadResp = await axios.post(`https://upload.contentful.com/spaces/${space}/uploads`, fs.readFileSync(localPath), { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' } });
    uploadUrl = { sys: { type: 'Link', linkType: 'Upload', id: uploadResp.data.sys.id } };
  }
  const file = typeof uploadUrl === 'string'
    ? { contentType: mimeTypeFromUrl(uploadUrl), fileName: fileNameFromUrl(uploadUrl, `${slugify(asset.label || 'featured-image')}.jpg`), upload: uploadUrl }
    : { contentType: mimeTypeFromUrl(asset.asset_url), fileName: fileNameFromUrl(asset.asset_url, `${slugify(asset.label || 'featured-image')}.jpg`), uploadFrom: uploadUrl };
  const base = `https://api.contentful.com/spaces/${space}/environments/${env}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.contentful.management.v1+json' };
  const created = await axios.post(`${base}/assets`, { fields: { title: { [locale]: asset.label || 'Article featured image' }, description: { [locale]: asset.alt_text || '' }, file: { [locale]: file } } }, { headers });
  const assetId = created.data.sys.id;
  let version = created.data.sys.version;
  await axios.put(`${base}/assets/${assetId}/files/${locale}/process`, {}, { headers: { Authorization: `Bearer ${token}`, 'X-Contentful-Version': version } });
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 900));
    const check = await axios.get(`${base}/assets/${assetId}`, { headers: { Authorization: `Bearer ${token}` } });
    version = check.data.sys.version;
    if (check.data.fields?.file?.[locale]?.url) break;
  }
  await axios.put(`${base}/assets/${assetId}/published`, {}, { headers: { Authorization: `Bearer ${token}`, 'X-Contentful-Version': version } });
  if (asset.id) await q('UPDATE article_assets SET contentful_asset_id=? WHERE id=?', [assetId, asset.id]);
  return assetId;
}
async function ensureArticleHasContentfulAsset(article) {
  let asset = null;
  if (article.featured_image_id) asset = await one('SELECT * FROM article_assets WHERE id=?', [article.featured_image_id]);
  if (!asset && article.featured_image_url) asset = { id: null, label: article.title || 'Article image', alt_text: article.featured_image_alt || '', asset_url: article.featured_image_url };
  if (!asset) return '';
  return article.contentful_asset_id || asset.contentful_asset_id || await createContentfulAssetFromArticleAsset(asset);
}
function contentfulEnabledField(id = '') {
  const v = String(id || '').trim();
  if (!v) return '';
  if (/^(not_present|none|null|false|disabled)$/i.test(v)) return '';
  return v;
}
async function getContentfulTypeDefinition(typeId) {
  const space = process.env.CONTENTFUL_SPACE_ID, env = process.env.CONTENTFUL_ENVIRONMENT_ID || 'master', token = contentfulToken();
  const base = `https://api.contentful.com/spaces/${space}/environments/${env}`;
  const res = await axios.get(`${base}/content_types/${typeId}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

async function findFirstContentfulEntryForContentType(typeId) {
  typeId = contentfulEnabledField(typeId);
  if (!typeId) return '';
  const space = process.env.CONTENTFUL_SPACE_ID, env = process.env.CONTENTFUL_ENVIRONMENT_ID || 'master', token = contentfulToken();
  const base = `https://api.contentful.com/spaces/${space}/environments/${env}`;
  const res = await axios.get(`${base}/entries`, { headers: { Authorization: `Bearer ${token}` }, params: { content_type: typeId, limit: 1, order: '-sys.updatedAt' } });
  return res.data?.items?.[0]?.sys?.id || '';
}
function contentfulLinkContentType(fieldDef) {
  const validations = fieldDef?.validations || [];
  for (const v of validations) if (Array.isArray(v.linkContentType) && v.linkContentType.length) return v.linkContentType[0];
  const itemValidations = fieldDef?.items?.validations || [];
  for (const v of itemValidations) if (Array.isArray(v.linkContentType) && v.linkContentType.length) return v.linkContentType[0];
  return '';
}
function symbolMaxLength(fieldDef, fallback) {
  const validations = fieldDef?.validations || [];
  for (const v of validations) {
    if (v.size && Number.isFinite(Number(v.size.max))) return Number(v.size.max);
  }
  return fallback;
}

function contentfulFieldHasUniqueValidation(fieldDef) {
  return Array.isArray(fieldDef?.validations) && fieldDef.validations.some(v => v && v.unique === true);
}
function makeContentfulSafeUniqueSuffix(parts = []) {
  const raw = parts.filter(Boolean).map(v => String(v)).join('-') || Date.now().toString();
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return cleaned || Date.now().toString(36);
}
function appendContentfulUniqueSuffix(value, suffix, maxLen = 255) {
  value = String(value || '').trim() || 'SEO fields';
  suffix = String(suffix || '').trim() || Date.now().toString(36);
  const tag = ' [auto-' + suffix + ']';
  if (value.endsWith(tag)) return truncate(value, maxLen);
  const room = Math.max(1, Number(maxLen || 255) - tag.length);
  return truncate(value, room).replace(/\s+$/, '') + tag;
}

function makeLocalized(locale, value) { return { [locale]: value }; }
function fieldHasValue(fields, id, locale) {
  return fields[id] && fields[id][locale] !== undefined && fields[id][locale] !== null && fields[id][locale] !== '';
}
async function waitForProcessedAsset(base, token, assetId, locale) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const got = await axios.get(`${base}/assets/${assetId}`, { headers: { Authorization: `Bearer ${token}` } });
    const file = got.data?.fields?.file?.[locale];
    if (file?.url) return got.data;
    await new Promise(r => setTimeout(r, 900));
  }
  return (await axios.get(`${base}/assets/${assetId}`, { headers: { Authorization: `Bearer ${token}` } })).data;
}
async function createEntryComponentForAsset(componentType, assetId, altText) {
  componentType = contentfulEnabledField(componentType);
  if (!componentType || !assetId) return '';
  const space = process.env.CONTENTFUL_SPACE_ID, env = process.env.CONTENTFUL_ENVIRONMENT_ID || 'master', token = contentfulToken();
  const locale = process.env.CONTENTFUL_LOCALE || 'en-US';
  const def = await getContentfulTypeDefinition(componentType);
  const fields = {};
  for (const fd of (def.fields || [])) {
    const id = fd.id;
    if (!id) continue;
    const lower = id.toLowerCase();
    if (fd.type === 'Link' && fd.linkType === 'Asset') fields[id] = makeLocalized(locale, { sys: { type: 'Link', linkType: 'Asset', id: assetId } });
    else if (fd.required && (fd.type === 'Symbol' || fd.type === 'Text')) fields[id] = makeLocalized(locale, truncate(lower.includes('alt') ? (altText || 'Game server hosting image') : (altText || 'Featured image'), symbolMaxLength(fd, fd.type === 'Symbol' ? 255 : 5000)));
    else if (fd.required && fd.type === 'Boolean') fields[id] = makeLocalized(locale, true);
    else if (fd.required && fd.type === 'Date') fields[id] = makeLocalized(locale, new Date().toISOString());
  }
  const base = `https://api.contentful.com/spaces/${space}/environments/${env}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.contentful.management.v1+json', 'X-Contentful-Content-Type': componentType };
  const created = await axios.post(`${base}/entries`, { fields }, { headers });
  const entryId = created.data.sys.id;
  await axios.put(`${base}/entries/${entryId}/published`, {}, { headers: { Authorization: `Bearer ${token}`, 'X-Contentful-Version': created.data.sys.version } });
  return entryId;
}
async function fillMissingRequiredContentfulFields({ fields, fieldDefs, locale, article, publishTitle }) {
  for (const fd of fieldDefs) {
    if (!fd || !fd.id || !fd.required || fieldHasValue(fields, fd.id, locale)) continue;
    const id = fd.id, type = fd.type;
    const fallbackText = id === 'internalName' ? publishTitle : (id.toLowerCase().includes('title') ? publishTitle : (article.excerpt || article.meta_description || publishTitle));
    if (['Symbol', 'Text'].includes(type)) { fields[id] = { [locale]: truncate(fallbackText, symbolMaxLength(fd, type === 'Symbol' ? 255 : 5000)) }; continue; }
    if (type === 'Date') { fields[id] = { [locale]: new Date().toISOString() }; continue; }
    if (type === 'Boolean') { fields[id] = { [locale]: true }; continue; }
    if (type === 'Integer' || type === 'Number') { fields[id] = { [locale]: 0 }; continue; }
    if (type === 'RichText') { fields[id] = { [locale]: bodyForContentful(article) }; continue; }
    if (type === 'Link' && fd.linkType === 'Asset') {
      const assetId = article.contentful_asset_id || article.featured_image_contentful_id || await ensureArticleHasContentfulAsset(article);
      if (assetId) fields[id] = { [locale]: { sys: { type: 'Link', linkType: 'Asset', id: assetId } } };
      continue;
    }
    if (type === 'Link' && fd.linkType === 'Entry') {
      let entryId = '';
      if (id === contentfulEnabledField(process.env.CONTENTFUL_FIELD_AUTHOR || '')) entryId = contentfulEnabledField(process.env.CONTENTFUL_DEFAULT_AUTHOR_ENTRY_ID || '');
      if (!entryId) entryId = await findFirstContentfulEntryForContentType(contentfulLinkContentType(fd));
      if (entryId) fields[id] = { [locale]: { sys: { type: 'Link', linkType: 'Entry', id: entryId } } };
      continue;
    }
    if (type === 'Array') { fields[id] = { [locale]: [] }; continue; }
  }
}
function missingRequiredContentfulFields(fields, fieldDefs) {
  return (fieldDefs || []).filter(fd => fd.required && !fields[fd.id]).map(fd => fd.id);
}


function isContentfulUniqueValidationError(err) {
  const errors = err?.response?.data?.details?.errors;
  return Array.isArray(errors) && errors.some(e => String(e.name || e.type || '').toLowerCase().includes('unique'));
}
function localizedValue(fields, fieldId, locale) {
  const v = fields?.[fieldId];
  if (!v) return undefined;
  if (v[locale] !== undefined) return v[locale];
  const firstKey = Object.keys(v)[0];
  return firstKey ? v[firstKey] : undefined;
}
async function findContentfulEntryByLocalizedField(typeId, fieldId, value) {
  typeId = contentfulEnabledField(typeId);
  fieldId = contentfulEnabledField(fieldId);
  value = String(value || '').trim();
  if (!typeId || !fieldId || !value) return null;
  const space = process.env.CONTENTFUL_SPACE_ID, env = process.env.CONTENTFUL_ENVIRONMENT_ID || 'master', token = contentfulToken();
  const locale = process.env.CONTENTFUL_LOCALE || 'en-US';
  const base = `https://api.contentful.com/spaces/${space}/environments/${env}`;

  const exactParams = { content_type: typeId, limit: 1 };
  exactParams[`fields.${fieldId}`] = value;
  try {
    const exact = await axios.get(`${base}/entries`, { headers: { Authorization: `Bearer ${token}` }, params: exactParams });
    if (exact.data?.items?.[0]?.sys?.id) return exact.data.items[0];
  } catch (_) { }

  try {
    let skip = 0;
    for (let page = 0; page < 20; page++) {
      const res = await axios.get(`${base}/entries`, { headers: { Authorization: `Bearer ${token}` }, params: { content_type: typeId, limit: 100, skip, order: '-sys.updatedAt' } });
      const items = res.data?.items || [];
      for (const item of items) {
        const got = localizedValue(item.fields || {}, fieldId, locale);
        if (String(got || '').trim().toLowerCase() === value.toLowerCase()) return item;
      }
      if (!items.length || items.length < 100) break;
      skip += 100;
    }
  } catch (_) { }
  return null;
}

function uniqueValidationFieldValues(err) {
  const out = [];
  const errors = err?.response?.data?.details?.errors;
  if (!Array.isArray(errors)) return out;
  for (const e of errors) {
    const name = String(e.name || e.type || '').toLowerCase();
    if (!name.includes('unique')) continue;
    const rawPath = Array.isArray(e.path) ? e.path.join('.') : String(e.path || '');
    const m = rawPath.match(/fields\.([^\.]+)\./);
    const fieldId = m ? m[1] : (e.field || e.fieldId || '');
    const value = e.value !== undefined ? e.value : e.details?.value;
    if (fieldId && value !== undefined && value !== null && String(value).trim()) out.push({ fieldId, value: String(value).trim() });
  }
  return out;
}

async function findContentfulEntryFromUniqueError(typeId, err) {
  for (const pair of uniqueValidationFieldValues(err)) {
    const existing = await findContentfulEntryByLocalizedField(typeId, pair.fieldId, pair.value);
    if (existing?.sys?.id) return existing;
  }
  return null;
}

async function updateAndPublishContentfulEntry({ entryId, fields, contentType }) {
  const space = process.env.CONTENTFUL_SPACE_ID, env = process.env.CONTENTFUL_ENVIRONMENT_ID || 'master', token = contentfulToken();
  const base = `https://api.contentful.com/spaces/${space}/environments/${env}`;
  const get = await axios.get(`${base}/entries/${entryId}`, { headers: { Authorization: `Bearer ${token}` } });
  const merged = { ...(get.data.fields || {}) };
  for (const [k, v] of Object.entries(fields || {})) merged[k] = v;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.contentful.management.v1+json', 'X-Contentful-Version': get.data.sys.version };
  if (contentType) headers['X-Contentful-Content-Type'] = contentType;
  const updated = await axios.put(`${base}/entries/${entryId}`, { fields: merged }, { headers });
  await axios.put(`${base}/entries/${entryId}/published`, {}, { headers: { Authorization: `Bearer ${token}`, 'X-Contentful-Version': updated.data.sys.version } });
  return updated.data;
}

async function ensureContentfulAuthorEntry(authorFieldDef) {
  const explicitId = contentfulEnabledField(process.env.CONTENTFUL_DEFAULT_AUTHOR_ENTRY_ID || '');
  const desiredName = String(process.env.CONTENTFUL_DEFAULT_AUTHOR_NAME || 'NativPost Team').trim() || 'NativPost Team';
  const authorType = contentfulEnabledField(process.env.CONTENTFUL_AUTHOR_CONTENT_TYPE || contentfulLinkContentType(authorFieldDef));
  if (!authorType) return explicitId || '';
  const space = process.env.CONTENTFUL_SPACE_ID, env = process.env.CONTENTFUL_ENVIRONMENT_ID || 'master', token = contentfulToken();
  const locale = process.env.CONTENTFUL_LOCALE || 'en-US';
  const def = await getContentfulTypeDefinition(authorType);
  const fieldDefs = def.fields || [];
  const candidateNameFields = ['name', 'fullName', 'displayName', 'title', 'internalName'];

  for (const fieldId of candidateNameFields) {
    if (fieldDefs.some(f => f.id === fieldId)) {
      const found = await findContentfulEntryByLocalizedField(authorType, fieldId, desiredName);
      if (found?.sys?.id) return found.sys.id;
    }
  }

  if (explicitId) {
    try {
      const base = `https://api.contentful.com/spaces/${space}/environments/${env}`;
      const got = await axios.get(`${base}/entries/${explicitId}`, { headers: { Authorization: `Bearer ${token}` } });
      if (got?.data?.sys?.id) return explicitId;
    } catch (_) { }
  }

  const fields = {};
  for (const fd of fieldDefs) {
    if (!fd?.id) continue;
    const id = fd.id;
    const lower = id.toLowerCase();
    const isLikelyName = candidateNameFields.includes(id) || lower.includes('name') || lower.includes('author');
    if ((fd.required || isLikelyName) && ['Symbol', 'Text'].includes(fd.type)) {
      let value = isLikelyName ? desiredName : desiredName;
      if (contentfulFieldHasUniqueValidation(fd)) value = appendContentfulUniqueSuffix(value, makeContentfulSafeUniqueSuffix(['author', desiredName]), symbolMaxLength(fd, fd.type === 'Symbol' ? 255 : 5000));
      else value = truncate(value, symbolMaxLength(fd, fd.type === 'Symbol' ? 255 : 5000));
      fields[id] = { [locale]: value };
      continue;
    }
    if (fd.required && fd.type === 'Boolean') fields[id] = { [locale]: true };
    else if (fd.required && fd.type === 'Date') fields[id] = { [locale]: new Date().toISOString() };
    else if (fd.required && (fd.type === 'Integer' || fd.type === 'Number')) fields[id] = { [locale]: 0 };
    else if (fd.required && fd.type === 'Array') fields[id] = { [locale]: [] };
  }

  if (!Object.keys(fields).length) return explicitId || await findFirstContentfulEntryForContentType(authorType);

  const base = `https://api.contentful.com/spaces/${space}/environments/${env}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.contentful.management.v1+json', 'X-Contentful-Content-Type': authorType };
  try {
    const created = await axios.post(`${base}/entries`, { fields }, { headers });
    const entryId = created.data.sys.id;
    await axios.put(`${base}/entries/${entryId}/published`, {}, { headers: { Authorization: `Bearer ${token}`, 'X-Contentful-Version': created.data.sys.version } });
    return entryId;
  } catch (err) {
    const existing = await findContentfulEntryFromUniqueError(authorType, err);
    if (existing?.sys?.id) return existing.sys.id;
    if (explicitId) return explicitId;
    throw err;
  }
}

async function createSeoComponentEntry({ title, description, articleId, slug }) {
  const seoType = contentfulEnabledField(process.env.CONTENTFUL_SEO_COMPONENT_CONTENT_TYPE);
  if (!seoType) return '';
  const space = process.env.CONTENTFUL_SPACE_ID, env = process.env.CONTENTFUL_ENVIRONMENT_ID || 'master', token = contentfulToken();
  const locale = process.env.CONTENTFUL_LOCALE || 'en-US';
  const seoDef = await getContentfulTypeDefinition(seoType);
  const fieldDefs = seoDef.fields || [];
  const allowed = new Set(fieldDefs.map(f => f.id));
  const titleField = contentfulEnabledField(process.env.CONTENTFUL_SEO_COMPONENT_FIELD_META_TITLE || 'pageTitle');
  const descField = contentfulEnabledField(process.env.CONTENTFUL_SEO_COMPONENT_FIELD_META_DESCRIPTION || 'pageDescription');
  const baseTitle = String(title || 'SEO fields').trim();
  const baseDescription = String(description || '').trim();

  const existingCandidates = [];
  if (titleField && allowed.has(titleField)) existingCandidates.push(await findContentfulEntryByLocalizedField(seoType, titleField, baseTitle));
  if (allowed.has('internalName')) existingCandidates.push(await findContentfulEntryByLocalizedField(seoType, 'internalName', baseTitle));
  const existing = existingCandidates.find(x => x?.sys?.id);
  if (existing?.sys?.id) return existing.sys.id;

  const uniqueSuffix = makeContentfulSafeUniqueSuffix([articleId, slug, Date.now().toString(36)]);
  const fields = {};

  if (titleField && allowed.has(titleField)) {
    const fd = fieldDefs.find(f => f.id === titleField);
    const max = symbolMaxLength(fd, 255);
    const value = contentfulFieldHasUniqueValidation(fd) ? appendContentfulUniqueSuffix(baseTitle, uniqueSuffix, max) : truncate(baseTitle, max);
    fields[titleField] = { [locale]: value };
  }
  if (descField && allowed.has(descField)) {
    const fd = fieldDefs.find(f => f.id === descField);
    fields[descField] = { [locale]: truncate(baseDescription, symbolMaxLength(fd, 255)) };
  }

  for (const fd of fieldDefs) {
    if (!fd?.id || !fd.required || fieldHasValue(fields, fd.id, locale)) continue;
    const id = fd.id;
    if (['Symbol', 'Text'].includes(fd.type)) {
      const max = symbolMaxLength(fd, fd.type === 'Symbol' ? 255 : 5000);
      let fallback = id === 'internalName' ? baseTitle : (id.toLowerCase().includes('title') ? baseTitle : (baseDescription || baseTitle));
      if (contentfulFieldHasUniqueValidation(fd)) fallback = appendContentfulUniqueSuffix(fallback, uniqueSuffix, max);
      else fallback = truncate(fallback, max);
      fields[id] = { [locale]: fallback };
      continue;
    }
    if (fd.type === 'Date') { fields[id] = { [locale]: new Date().toISOString() }; continue; }
    if (fd.type === 'Boolean') {
      // For SEO component boolean fields: noindex/noFollow/excludeFromSitemap must be FALSE
      // Setting these to true tells Google to ignore the page — the opposite of what we want
      const fieldLower = id.toLowerCase();
      const isNoindexField = /noindex|nofollow|exclude|hide|robot|disallow/.test(fieldLower);
      fields[id] = { [locale]: !isNoindexField }; // noindex fields = false, others = true
      continue;
    }
    if (fd.type === 'Integer' || fd.type === 'Number') { fields[id] = { [locale]: 0 }; continue; }
    if (fd.type === 'RichText') { fields[id] = { [locale]: bodyForContentful({ body: baseDescription, content: baseDescription }) }; continue; }
  }

  if (!Object.keys(fields).length) return '';
  const base = 'https://api.contentful.com/spaces/' + space + '/environments/' + env;
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/vnd.contentful.management.v1+json', 'X-Contentful-Content-Type': seoType };
  try {
    const created = await axios.post(base + '/entries', { fields }, { headers });
    const entryId = created.data.sys.id;
    const version = created.data.sys.version;
    await axios.put(base + '/entries/' + entryId + '/published', {}, { headers: { Authorization: 'Bearer ' + token, 'X-Contentful-Version': version } });
    return entryId;
  } catch (err) {
    if (isContentfulUniqueValidationError(err)) {
      for (const pair of uniqueValidationFieldValues(err)) {
        const fd = fieldDefs.find(f => f.id === pair.fieldId);
        if (fd && ['Symbol', 'Text'].includes(fd.type)) {
          fields[pair.fieldId] = { [locale]: appendContentfulUniqueSuffix(pair.value, makeContentfulSafeUniqueSuffix([articleId, slug, Date.now().toString(36), pair.fieldId]), symbolMaxLength(fd, fd.type === 'Symbol' ? 255 : 5000)) };
        }
      }
      const retry = await axios.post(base + '/entries', { fields }, { headers });
      const entryId = retry.data.sys.id;
      await axios.put(base + '/entries/' + entryId + '/published', {}, { headers: { Authorization: 'Bearer ' + token, 'X-Contentful-Version': retry.data.sys.version } });
      return entryId;
    }
    throw err;
  }
}

// ── INTERNAL LINKING RECOMMENDER ──────────────────────────────────────────────
// When a new article publishes, scan older published articles. If an older
// article mentions the new article's primary keyword (or game name) but doesn't
// already link to it, surface a suggestion. Apply = insert one natural markdown
// link into the old body and re-publish.

// Build candidate match phrases for a target article, ordered most specific first.
function internalLinkMatchPhrases(article = {}) {
  const phrases = new Set();
  const pk = String(article.primary_keyword || '').trim().toLowerCase();
  if (pk && pk.length >= 5) phrases.add(pk);
  // Drop common suffixes to also match shorter forms
  if (pk) {
    const shorter = pk.replace(/\b(hosting|server hosting|dedicated server|servers?)\b/g, '').replace(/\s+/g, ' ').trim();
    if (shorter && shorter.length >= 5 && shorter !== pk) phrases.add(shorter);
  }
  const detectedGame = detectGame(`${article.title || ''} ${pk}`);
  if (detectedGame) {
    const gameLabel = gameDisplay(detectedGame).toLowerCase();
    // Pair the game with hosting-relevant nouns — these are the high-intent phrases
    // where an internal link actually helps rankings, not just brand mentions.
    phrases.add(`${gameLabel} server hosting`);
    phrases.add(`${gameLabel} dedicated server`);
    phrases.add(`${gameLabel} server`);
    phrases.add(`host ${gameLabel}`);
  }
  return [...phrases].filter(p => p && p.length >= 5 && p.length <= 80).sort((a, b) => b.length - a.length);
}

// Does the body already link to this url (absolute or relative slug)?
function bodyAlreadyLinksTo(body = '', targetUrl = '', slug = '') {
  const b = String(body || '');
  if (targetUrl && b.includes(targetUrl)) return true;
  // Match markdown link targets that end with the slug segment.
  if (slug) {
    const re = new RegExp('\\]\\([^)]*' + slug.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '[^)]*\\)', 'i');
    if (re.test(b)) return true;
  }
  return false;
}

// Find the first occurrence of `phrase` in `body` that sits in a regular paragraph
// (not inside a heading, list item, code block, table row, or existing markdown link).
// Returns {index, matched} or null. Case-insensitive, whole-phrase match.
function findLinkablePhraseOccurrence(body = '', phrase = '') {
  const text = String(body || '');
  const needle = String(phrase || '').trim();
  if (!needle) return null;
  // Word-boundary case-insensitive regex over the full body.
  const safe = needle.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp('(^|[^\\w])(' + safe + ')([^\\w]|$)', 'i');
  let pos = 0;
  while (pos < text.length) {
    const slice = text.slice(pos);
    const m = slice.match(re);
    if (!m) return null;
    const absoluteIdx = pos + m.index + m[1].length;
    // Check the line this match sits on — skip if it's a heading, list, table, or code.
    const lineStart = text.lastIndexOf('\n', absoluteIdx) + 1;
    const lineEnd = text.indexOf('\n', absoluteIdx); const lineEndSafe = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(lineStart, lineEndSafe);
    const isHeading = /^#{1,6}\s+/.test(line);
    const isList = /^(\s*)([-*+]|\d+[.)])\s+/.test(line);
    const isTable = /^\s*\|/.test(line);
    const isCodeFence = /^\s*```/.test(line);
    // Skip if already inside a markdown link: [...text...](url)
    // Scan backward from match to see if we're between [ and ](
    const beforeSlice = text.slice(Math.max(0, absoluteIdx - 200), absoluteIdx);
    const openBracket = beforeSlice.lastIndexOf('[');
    const closeBracket = beforeSlice.lastIndexOf(']');
    const insideLinkText = openBracket > closeBracket;
    if (!isHeading && !isList && !isTable && !isCodeFence && !insideLinkText) {
      return { index: absoluteIdx, matched: m[2] };
    }
    pos = absoluteIdx + m[2].length;
  }
  return null;
}

// Scan all published articles for opportunities to link to `targetArticle`.
// Persists pending suggestions into internal_link_suggestions. Returns count.
async function findInternalLinkOpportunities(targetArticle) {
  if (!targetArticle || !targetArticle.id) return 0;
  const targetUrl = targetArticle.published_url || '';
  const targetSlug = targetArticle.slug || '';
  if (!targetUrl && !targetSlug) return 0;
  const phrases = internalLinkMatchPhrases(targetArticle);
  if (!phrases.length) return 0;
  // Only consider published articles with body content, excluding self.
  const candidates = await q(
    "SELECT id, title, slug, primary_keyword, body, content, published_url, contentful_entry_id FROM articles WHERE status='published' AND id<>? AND (body IS NOT NULL OR content IS NOT NULL)",
    [targetArticle.id]
  );
  let created = 0;
  for (const src of candidates) {
    const srcBody = String(src.body || src.content || '');
    if (!srcBody.trim()) continue;
    if (bodyAlreadyLinksTo(srcBody, targetUrl, targetSlug)) continue;
    // Pick the first phrase that has a linkable occurrence in this source.
    let chosen = null;
    for (const phrase of phrases) {
      const hit = findLinkablePhraseOccurrence(srcBody, phrase);
      if (hit) { chosen = { phrase, hit }; break; }
    }
    if (!chosen) continue;
    const reason = 'Old article mentions "' + chosen.phrase + '" but does not link to the new article.';
    try {
      await q(
        'INSERT IGNORE INTO internal_link_suggestions (source_article_id, target_article_id, match_phrase, anchor_text, target_url, status, reason) VALUES (?,?,?,?,?,?,?)',
        [src.id, targetArticle.id, chosen.phrase.slice(0, 250), chosen.hit.matched.slice(0, 250), targetUrl || ('/blog/' + targetSlug), 'pending', reason.slice(0, 250)]
      );
      created++;
    } catch (_) { /* unique constraint — already suggested */ }
  }
  return created;
}

// Apply a pending suggestion: insert one markdown link into the source body at
// the first linkable occurrence, update the article, and re-publish to Contentful.
async function applyInternalLinkSuggestion(suggestionId) {
  const s = await one('SELECT * FROM internal_link_suggestions WHERE id=?', [suggestionId]);
  if (!s) return { ok: false, error: 'Suggestion not found' };
  if (s.status === 'applied') return { ok: false, error: 'Already applied' };
  const source = await one('SELECT * FROM articles WHERE id=?', [s.source_article_id]);
  const target = await one('SELECT * FROM articles WHERE id=?', [s.target_article_id]);
  if (!source) return { ok: false, error: 'Source article missing' };
  if (!target) return { ok: false, error: 'Target article missing' };
  const body = String(source.body || source.content || '');
  const hit = findLinkablePhraseOccurrence(body, s.match_phrase);
  if (!hit) {
    await q("UPDATE internal_link_suggestions SET status='stale' WHERE id=?", [suggestionId]);
    return { ok: false, error: 'Match phrase no longer found in source body (it may have been edited).' };
  }
  // Build link URL — prefer the live published_url, fall back to slug path.
  let linkUrl = s.target_url || target.published_url || '';
  if (!linkUrl && target.slug) linkUrl = '/blog/' + target.slug;
  if (!linkUrl) return { ok: false, error: 'No target URL available' };
  const anchor = hit.matched;
  const before = body.slice(0, hit.index);
  const after = body.slice(hit.index + anchor.length);
  const newBody = before + '[' + anchor + '](' + linkUrl + ')' + after;
  await q('UPDATE articles SET body=?, content=?, updated_at=NOW() WHERE id=?', [newBody, newBody, source.id]);
  await q("UPDATE internal_link_suggestions SET status='applied', applied_at=NOW() WHERE id=?", [suggestionId]);
  // If Contentful is configured and source was published there, re-publish to push the edit live.
  let republished = false;
  if (publishModeAllowsContentful() && source.contentful_entry_id) {
    try {
      const refreshed = await one('SELECT a.*, aa.contentful_asset_id FROM articles a LEFT JOIN article_assets aa ON aa.id=a.featured_image_id WHERE a.id=?', [source.id]);
      if (refreshed) await publishToContentful(refreshed);
      republished = true;
    } catch (e) {
      await q('UPDATE articles SET review_notes=? WHERE id=?', ['Internal link applied locally but Contentful re-publish failed: ' + e.message, source.id]);
    }
  }
  return { ok: true, republished, sourceId: source.id, targetId: target.id, anchor, linkUrl };
}

async function publishToContentful(article) {
  if (!contentfulReady()) throw new Error('Contentful env vars are missing. Add CONTENTFUL_SPACE_ID, CONTENTFUL_CMA_TOKEN or CONTENTFUL_MANAGEMENT_TOKEN, and CONTENTFUL_BLOG_CONTENT_TYPE_ID or CONTENTFUL_CONTENT_TYPE.');
  const space = process.env.CONTENTFUL_SPACE_ID, env = process.env.CONTENTFUL_ENVIRONMENT_ID || 'master', token = contentfulToken(), contentType = contentfulContentType();
  const locale = process.env.CONTENTFUL_LOCALE || 'en-US';
  const typeDef = await getContentfulTypeDefinition(contentType);
  const fieldDefs = typeDef.fields || [];
  const allowed = new Set(fieldDefs.map(f => f.id));
  const fields = {};
  const setField = (id, value) => { id = contentfulEnabledField(id); if (id && allowed.has(id) && value !== undefined && value !== null && value !== '') fields[id] = { [locale]: value }; };
  const publishTitle = safeArticleTitle(article.title, articleTitleFor(article.primary_keyword || 'ai social media content'));
  setField(process.env.CONTENTFUL_FIELD_TITLE || 'title', publishTitle);
  setField(process.env.CONTENTFUL_FIELD_SLUG || 'slug', article.slug || slugify(publishTitle));
  // Rebuild schema now that we know the final URL and publish time — this version
  // carries the true published_url into mainEntityOfPage and Product.offers.url.
  const siteUrlForSchema = originOf((await one('SELECT url FROM sites WHERE id=?', [article.site_id]))?.url || process.env.PUBLIC_SITE_URL || 'https://nativpost.com');
  const freshSchema = buildArticleSchema({
    ...article,
    site_url: siteUrlForSchema,
    published_url: article.published_url || `${siteUrlForSchema}/blog/${article.slug || slugify(publishTitle)}`,
    published_at: article.published_at || new Date().toISOString()
  });
  // Stash back onto the article object so bodyForContentful embeds the fresh version.
  article.schema_json = freshSchema;
  setField(process.env.CONTENTFUL_FIELD_BODY || 'content', bodyForContentful(article));
  // Optional dedicated JSON-LD field — create a Symbol/Text field in Contentful named
  // e.g. "schemaJsonLd" and set CONTENTFUL_FIELD_SCHEMA_JSONLD=schemaJsonLd in .env.local.
  // This is the cleanest path for rich-text body formats which strip script tags.
  setField(process.env.CONTENTFUL_FIELD_SCHEMA_JSONLD || '', freshSchema);
  setField(process.env.CONTENTFUL_FIELD_EXCERPT || 'shortDescription', truncate(article.excerpt || article.meta_description || '', 150));
  setField(process.env.CONTENTFUL_FIELD_META_DESCRIPTION || '', article.meta_description || '');
  setField(process.env.CONTENTFUL_FIELD_PUBLISH_DATE || 'publishedDate', new Date().toISOString());
  const contentfulAssetId = article.contentful_asset_id || article.featured_image_contentful_id || await ensureArticleHasContentfulAsset(article);
  const fieldImage = contentfulEnabledField(process.env.CONTENTFUL_FIELD_FEATURED_IMAGE || 'featuredImage');
  const imageDef = fieldDefs.find(f => f.id === fieldImage);
  if (contentfulAssetId && fieldImage && allowed.has(fieldImage)) {
    if (imageDef?.type === 'Link' && imageDef?.linkType === 'Entry') {
      const componentId = await createEntryComponentForAsset(contentfulLinkContentType(imageDef), contentfulAssetId, article.featured_image_alt || article.title || publishTitle);
      if (componentId) fields[fieldImage] = { [locale]: { sys: { type: 'Link', linkType: 'Entry', id: componentId } } };
    } else {
      fields[fieldImage] = { [locale]: { sys: { type: 'Link', linkType: 'Asset', id: contentfulAssetId } } };
    }
  }
  const seoRefField = contentfulEnabledField(process.env.CONTENTFUL_FIELD_SEO_REFERENCE || 'seoFields');
  if (seoRefField && allowed.has(seoRefField)) {
    const seoId = await createSeoComponentEntry({ title: article.meta_title || publishTitle, description: article.meta_description || article.excerpt || '', articleId: article.id, slug: article.slug || slugify(publishTitle) });
    if (seoId) fields[seoRefField] = { [locale]: { sys: { type: 'Link', linkType: 'Entry', id: seoId } } };
  }
  const authorField = contentfulEnabledField(process.env.CONTENTFUL_FIELD_AUTHOR || 'author');
  if (authorField && allowed.has(authorField)) {
    const authorDef = fieldDefs.find(f => f.id === authorField);
    const authorId = await ensureContentfulAuthorEntry(authorDef);
    if (authorId) fields[authorField] = { [locale]: { sys: { type: 'Link', linkType: 'Entry', id: authorId } } };
  }
  await fillMissingRequiredContentfulFields({ fields, fieldDefs, locale, article, publishTitle });
  const missing = missingRequiredContentfulFields(fields, fieldDefs);
  if (missing.length) throw new Error('Contentful publish blocked because required fields are missing and could not be auto-filled: ' + missing.join(', ') + '. Add env mappings/default entry IDs for these fields.');
  if (!Object.keys(fields).length) throw new Error('No Contentful fields were set. Check CONTENTFUL_FIELD_* env mappings against the pageBlogPost content type.');
  const base = `https://api.contentful.com/spaces/${space}/environments/${env}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.contentful.management.v1+json', 'X-Contentful-Content-Type': contentType };
  const slugField = contentfulEnabledField(process.env.CONTENTFUL_FIELD_SLUG || 'slug');
  const slugValue = article.slug || slugify(publishTitle);
  const existingBySlug = slugField ? await findContentfulEntryByLocalizedField(contentType, slugField, slugValue) : null;
  let entryId;
  if (existingBySlug?.sys?.id) {
    await updateAndPublishContentfulEntry({ entryId: existingBySlug.sys.id, fields, contentType });
    entryId = existingBySlug.sys.id;
  } else {
    try {
      const created = await axios.post(`${base}/entries`, { fields }, { headers });
      entryId = created.data.sys.id; const version = created.data.sys.version;
      await axios.put(`${base}/entries/${entryId}/published`, {}, { headers: { Authorization: `Bearer ${token}`, 'X-Contentful-Version': version } });
    } catch (err) {
      if (isContentfulUniqueValidationError(err)) {
        const existingFromError = await findContentfulEntryFromUniqueError(contentType, err);
        const existing = existingFromError || (slugField ? await findContentfulEntryByLocalizedField(contentType, slugField, slugValue) : null);
        if (existing?.sys?.id) {
          await updateAndPublishContentfulEntry({ entryId: existing.sys.id, fields, contentType });
          entryId = existing.sys.id;
        } else {
          throw new Error(err.message + ' | v60 note: Contentful says one or more fields must be unique, but the duplicate entry could not be found by slug/internalName/title. Rename the local article or remove the duplicate in Contentful.');
        }
      } else throw err;
    }
  }
  const siteUrl = originOf((await one('SELECT url FROM sites WHERE id=?', [article.site_id]))?.url || process.env.PUBLIC_SITE_URL || 'https://nativpost.com');
  const publishedUrl = article.published_url || `${siteUrl}/blog/${article.slug || slugify(article.title)}`;
  // Ping IndexNow to request fast indexing by Bing/Yandex/DuckDuckGo/Yahoo.
  // To activate: add INDEXNOW_KEY=your-key to .env.local
  const indexNowKey = process.env.INDEXNOW_KEY || '';
  if (indexNowKey) {
    const pingUrl = encodeURIComponent(publishedUrl);
    const indexNowPings = [
      `https://www.bing.com/indexnow?url=${pingUrl}&key=${indexNowKey}`,
      `https://api.indexnow.org/indexnow?url=${pingUrl}&key=${indexNowKey}`,
    ];
    for (const ping of indexNowPings) {
      axios.get(ping, { timeout: 5000 }).catch(() => { });
    }
    console.log(`[IndexNow] Pinged Bing/Yandex for: ${publishedUrl}`);
  }

  // Ping Google via GSC URL Inspection API to request immediate crawl.
  // Uses the same OAuth token already connected for GSC data sync — no extra setup.
  setImmediate(async () => {
    try {
      const token = await getValidAccessToken();
      if (token && publishedUrl) {
        await axios.post(
          'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
          { inspectionUrl: publishedUrl, siteUrl: process.env.GSC_PROPERTY_NATIVPOST || 'https://nativpost.com/' },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        console.log(`[GSC] Requested Google index for: ${publishedUrl}`);
      }
    } catch (e) {
      // Non-fatal — Google will crawl it naturally, this just speeds it up
      console.log(`[GSC] Index ping skipped: ${e.message}`);
    }
  });
  // Auto-generate internal link suggestions so older articles can link to this new one
  setImmediate(async () => {
    try {
      const fullArticle = await one('SELECT * FROM articles WHERE id=?', [article.id]);
      if (fullArticle) {
        const count = await findInternalLinkOpportunities({ ...fullArticle, published_url: publishedUrl });
        if (count > 0) console.log(`[InternalLinks] Generated ${count} suggestions for "${article.title}"`);
      }
    } catch (e) { console.error('[InternalLinks] post-publish scan failed:', e.message); }
  });
  return { entryId, publishedUrl };
}

function isArticleDueForAutoPublish(row = {}) {
  const scheduled = scheduledValueFromRow(row);
  if (!scheduled) return true;
  const d = parseDbDate(scheduled);
  if (!d) return false;
  return d.getTime() <= Date.now();
}

function tzDayKey(dateLike) {
  const d = dateLike ? new Date(dateLike) : new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
async function countPublishedToday() {
  const rows = await q("SELECT published_at FROM articles WHERE published_at IS NOT NULL ORDER BY published_at DESC LIMIT 200");
  const today = tzDayKey(new Date());
  return rows.filter(r => r.published_at && tzDayKey(r.published_at) === today).length;
}
async function autoPublishApproved(options = {}) {
  const candidates = await q("SELECT a.*, aa.contentful_asset_id, s.url site_url FROM articles a LEFT JOIN article_assets aa ON aa.id=a.featured_image_id LEFT JOIN sites s ON s.id=a.site_id WHERE a.status IN ('approved','queued') ORDER BY COALESCE(a.scheduled_for,a.updated_at) ASC LIMIT 200");
  const futureRows = candidates.filter(a => !isArticleDueForAutoPublish(a));
  const rows = candidates.filter(isArticleDueForAutoPublish).slice(0, 25);
  const results = [];
  let publishedToday = await countPublishedToday();
  for (const skipped of futureRows) results.push({ id: skipped.id, title: skipped.title, status: 'skipped', reason: 'scheduled_for_future', scheduled_for: scheduledValueFromRow(skipped) });
  for (const a of rows) {
    const breakdown = qualityBreakdown(a);
    const wasForceApprovedAuto = (a.review_notes || '').includes('Force-approved');
    if (breakdown.score < MIN_QUALITY_SCORE && !wasForceApprovedAuto) {
      await q("UPDATE articles SET status='review', review_notes=? WHERE id=?", [`Quality gate ${breakdown.score}/${MIN_QUALITY_SCORE}. ${breakdown.notes.join(' ')}`.trim(), a.id]);
      results.push({ id: a.id, title: a.title, status: 'failed', error: 'quality_gate' });
      continue;
    }
    if (publishedToday >= AUTO_PUBLISH_DAILY_LIMIT && !options.force) {
      results.push({ id: a.id, title: a.title, status: 'skipped', reason: 'daily_cap' });
      continue;
    }
    try {
      let publishedUrl = a.published_url;
      if (publishModeAllowsContentful()) { const r = await publishToContentful(a); publishedUrl = r.publishedUrl; await q("UPDATE articles SET contentful_entry_id=?, status='published', published_at=NOW(), published_url=?, review_notes=NULL, schema_json=COALESCE(schema_json,?) WHERE id=?", [r.entryId, publishedUrl, buildArticleSchema(a), a.id]); }
      else { publishedUrl = publishedUrl || `${originOf((await one('SELECT url FROM sites WHERE id=?', [a.site_id]))?.url || '')}/blog/${a.slug || slugify(a.title)}`; await q("UPDATE articles SET status='published', published_at=NOW(), published_url=?, review_notes=NULL, schema_json=COALESCE(schema_json,?) WHERE id=?", [publishedUrl, buildArticleSchema(a), a.id]); }
      await q("UPDATE content_calendar SET status='published' WHERE article_id=?", [a.id]);
      publishedToday += 1;
      results.push({ id: a.id, title: a.title, status: 'published' });
      // Scan for internal link opportunities from older articles to this newly published one.
      try {
        const fresh = await one('SELECT id, title, slug, primary_keyword, published_url FROM articles WHERE id=?', [a.id]);
        if (fresh) {
          const count = await findInternalLinkOpportunities(fresh);
          if (count > 0) console.log(`[InternalLinks] Auto-publish created ${count} suggestion(s) for article #${fresh.id}`);
        }
      } catch (e) { console.warn('[InternalLinks] auto-publish scan failed:', e.message); }
    } catch (e) { await q('UPDATE articles SET review_notes=? WHERE id=?', [`Auto-publish failed: ${e.message}`, a.id]); results.push({ id: a.id, title: a.title, status: 'failed', error: e.message }); }
  }
  return results;
}

function startWeeklyGSCSync() {
  // Auto-sync GSC once per day (86400000ms) if Google is connected
  const intervalMs = 24 * 60 * 60 * 1000; // 24 hours
  let running = false;
  async function runGSCSyncTick() {
    if (running) return;
    const connected = await googleConnected().catch(() => false);
    if (!connected) return;
    running = true;
    try {
      const sites = await q('SELECT * FROM sites WHERE active=1');
      let total = 0;
      for (const site of sites) {
        const prop = site.gsc_property || process.env['GSC_PROPERTY_' + (site.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')] || process.env.GSC_PROPERTY_NATIVPOST;
        if (prop && prop !== 'NOT_SET_YET') {
          try { total += await syncGSCData(site.id, prop); } catch (e) { console.error('Auto GSC sync error:', e.message); }
        }
        if (site.ga4_property_id && site.ga4_property_id !== 'NOT_SET_YET') {
          try { await syncGA4Data(site.id, site.ga4_property_id); } catch (e) { console.error('Auto GA4 sync error:', e.message); }
        }
      }
      if (total > 0) {
        console.log(`Auto GSC/GA4 daily sync complete. Rows imported: ${total}`);
        // After GSC sync, automatically recluster keywords and refresh live games
        // so the content plan stays current without manual intervention
        try {
          await q('UPDATE keywords SET cluster_name=NULL WHERE cluster_name IS NOT NULL');
          const allKws = await q('SELECT id, keyword FROM keywords LIMIT 5000');
          for (const k of allKws) {
            await execSafe('UPDATE keywords SET cluster_name=?, intent=? WHERE id=?',
              [clusterName(k.keyword), intentOf(k.keyword), k.id]);
          }
          console.log(`Auto recluster complete. ${allKws.length} keywords updated.`);
        } catch (e) { console.error('Auto recluster failed:', e.message); }
        // NativPost: no live game refresh needed
        try {
          const site = await one("SELECT url FROM sites WHERE active=1 AND LOWER(url) LIKE '%nativpost%' LIMIT 1") || { url: 'https://nativpost.com' };
          const { confirmed, debug } = await refreshLiveGamesFromIGH(site.url);
          if (confirmed.length) console.log(`Auto live-game refresh: ${confirmed.join(', ')}`);
        } catch (e) { console.error('Auto live-game refresh failed:', e.message); }
      }
    } catch (e) { console.error('Auto GSC/GA4 sync failed:', e.message); }
    finally { running = false; }
  }
  // Run first sync after 5 minutes (give app time to fully start), then every 24h
  setTimeout(runGSCSyncTick, 5 * 60 * 1000);
  setInterval(runGSCSyncTick, intervalMs);
  console.log('Auto GSC/GA4 daily sync scheduler enabled.');
}

function startAutoPublisher() {
  if (!AUTO_PUBLISH_ENABLED) {
    console.log('Auto publish scheduler disabled by AUTO_PUBLISH_ENABLED=false');
    return;
  }
  const intervalMs = AUTO_PUBLISH_INTERVAL_MINUTES * 60 * 1000;
  let running = false;
  async function runAutoPublishTick() {
    if (running) return;
    running = true;
    lastAutoPublishRunAt = new Date();
    nextAutoPublishRunAt = new Date(Date.now() + intervalMs);
    try {
      const results = await autoPublishApproved({ force: false });
      const published = results.filter(r => r.status === 'published').length;
      const failed = results.filter(r => r.status === 'failed').length;
      if (published || failed) console.log(`Auto publish scheduler complete. Published=${published}, Failed=${failed}`);
    } catch (e) {
      console.error('Auto publish scheduler failed:', e.message);
    } finally {
      running = false;
    }
  }
  nextAutoPublishRunAt = new Date(Date.now() + intervalMs);
  console.log(`Auto publish scheduler enabled. Due queued posts check every ${AUTO_PUBLISH_INTERVAL_MINUTES} minute(s). Daily cap=${AUTO_PUBLISH_DAILY_LIMIT}.`);
  setTimeout(runAutoPublishTick, Math.min(60000, intervalMs));
  setInterval(runAutoPublishTick, intervalMs);
}

// ── AUTH MIDDLEWARE + ROUTES ──────────────────────────────────────────────────
app.use(requireAuth);
app.use(injectUserTheme);

// Login page
app.get('/login', async (req, res) => {
  const user = await getSessionUser(req);
  if (user) return res.redirect('/');
  const error = req.query.error || '';
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NativPost SEO — Login</title><link rel="stylesheet" href="/static/styles.css"><style>body{display:flex;align-items:center;justify-content:center;min-height:100vh;background:radial-gradient(circle at top left,#1e1b4b 0,#070b16 38%,#050712 100%)}.login-box{background:rgba(16,24,39,.95);border:1px solid #253147;border-radius:28px;padding:40px;width:100%;max-width:420px;box-shadow:0 24px 60px rgba(0,0,0,.4)}.login-logo{width:52px;height:52px;border-radius:18px;background:linear-gradient(135deg,#7c3aed,#00d4ff);display:grid;place-items:center;font-weight:900;font-size:1.2rem;color:#fff;margin:0 auto 20px}.login-title{text-align:center;color:#ecf3ff;font-size:1.5rem;font-weight:800;margin-bottom:6px}.login-sub{text-align:center;color:#9fb0c8;font-size:.85rem;margin-bottom:28px}.login-field{margin-bottom:16px}label{display:block;color:#9fb0c8;font-size:.8rem;margin-bottom:6px}input[type=text],input[type=password]{width:100%;background:#0b1220;border:1px solid #253147;border-radius:13px;color:#ecf3ff;padding:12px 14px;font-size:.95rem;box-sizing:border-box}.login-btn{width:100%;padding:13px;border-radius:14px;background:linear-gradient(135deg,#7c3aed,#2563eb);border:none;color:#fff;font-size:1rem;font-weight:700;cursor:pointer;margin-top:8px}.login-btn:hover{opacity:.9}.error-msg{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#fca5a5;border-radius:12px;padding:10px 14px;margin-bottom:16px;font-size:.85rem;text-align:center}.forgot{text-align:center;margin-top:14px;font-size:.8rem;color:#9fb0c8}<\/style><\/head><body><div class="login-box"><div class="login-logo">NP<\/div><div class="login-title">NativPost SEO<\/div><div class="login-sub">AI Content Pipeline<\/div>${error ? '<div class="error-msg">' + error + '<\/div>' : ''}<form method="post" action="/auth/login"><div class="login-field"><label>Username<\/label><input type="text" name="username" autocomplete="username" required autofocus><\/div><div class="login-field"><label>Password<\/label><input type="password" name="password" autocomplete="current-password" required><\/div><button class="login-btn" type="submit">Sign in<\/button><\/form><div class="forgot"><a href="/auth/reset-password" style="color:#93c5fd">Forgot password?<\/a><\/div><\/div><\/body><\/html>`);
});

// Login POST
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.redirect('/login?error=Username+and+password+required');
  try {
    await ensureAuthTables(); // Safety: ensure tables exist on first login attempt
    const user = await one('SELECT * FROM auth_users WHERE LOWER(username)=LOWER(?)', [username.trim()]);
    if (!user) return res.redirect('/login?error=Invalid+username+or+password');
    const valid = await verifyPassword(password, user.password_hash, user.salt);
    if (!valid) return res.redirect('/login?error=Invalid+username+or+password');
    const sid = generateSessionId();
    const expires = new Date(Date.now() + SESSION_DURATION_MS);
    await q('INSERT INTO auth_sessions (id,user_id,expires_at) VALUES (?,?,?)', [sid, user.id, expires.toISOString().slice(0, 19).replace('T', ' ')]);
    setSessionCookie(res, sid);
    res.redirect('/');
  } catch (e) { res.redirect('/login?error=' + encodeURIComponent('Login error: ' + e.message)); }
});

// Logout
app.get('/auth/logout', async (req, res) => {
  const cookies = parseCookies(req);
  const sid = cookies['np_seo_session'];
  if (sid) await q('DELETE FROM auth_sessions WHERE id=?', [sid]).catch(() => { });
  clearSessionCookie(res);
  res.redirect('/login');
});
app.post('/auth/logout', async (req, res) => {
  const cookies = parseCookies(req);
  const sid = cookies['np_seo_session'];
  if (sid) await q('DELETE FROM auth_sessions WHERE id=?', [sid]).catch(() => { });
  clearSessionCookie(res);
  res.redirect('/login');
});

// Reset password page
// ── Password reset — email-verified code flow (v107) ──────────────────────
// Flow: user enters username → server looks up email on file, generates a
// 6-digit code, stores its hash (not plaintext), emails the code to the
// address on file, redirects user to code-entry page. User enters code +
// new password; we verify against hash, mark used, reset password.
//
// Rate-limited to 5 failed attempts per code. Codes expire in 15 minutes.
// If no email provider is configured, the code is logged to the server
// console (for local/dev or emergency admin recovery).

app.get('/auth/reset-password', (req, res) => {
  // Backward-compat redirect for any old bookmarks
  res.redirect('/auth/forgot-password' + (req.query.msg ? '?msg=' + encodeURIComponent(req.query.msg) : ''));
});

app.get('/auth/forgot-password', (req, res) => {
  const msg = req.query.msg || '';
  const error = req.query.error || '';
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Forgot password — NativPost SEO</title><link rel="stylesheet" href="/static/styles.css"></head><body class="auth-page"><div class="auth-box"><div class="auth-logo">NP</div><h2>Forgot your password?</h2><p class="auth-sub">Enter your username. We'll email a 6-digit verification code to the address on file.</p>${msg ? '<div class="auth-msg good">' + msg + '</div>' : ''}${error ? '<div class="auth-msg bad">' + error + '</div>' : ''}<form method="post" action="/auth/forgot-password"><input type="text" name="username" placeholder="Your username" required autofocus><button type="submit">Send verification code</button></form><a href="/login" class="auth-back">Back to login</a></div></body></html>`);
});

app.post('/auth/forgot-password', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    if (!username) return res.redirect('/auth/forgot-password?error=Username+required');
    const user = await one('SELECT * FROM auth_users WHERE LOWER(username)=LOWER(?)', [username]).catch(() => null);
    // To prevent username-enumeration, always tell the user "if that username exists, an email was sent" —
    // but only actually send if the user exists AND has an email on file.
    if (user && user.email) {
      const code = generateResetCode();
      const codeHash = await hashResetCode(code);
      const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
      // Invalidate any existing unused codes for this user
      await execSafe("UPDATE auth_reset_codes SET used=1 WHERE user_id=? AND used=0", [user.id]);
      await q(
        'INSERT INTO auth_reset_codes (user_id, code_hash, email, expires_at) VALUES (?,?,?,?)',
        [user.id, codeHash, user.email, expires.toISOString().slice(0, 19).replace('T', ' ')]
      );
      const subject = 'NativPost SEO — password reset code';
      const text = `Your password reset code is: ${code}\n\nThis code expires in 15 minutes. If you did not request this, you can ignore this email.\n\n— NativPost SEO`;
      const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;background:#0b0d10;color:#e6ecee;border-radius:12px"><h2 style="color:#22ff44;margin:0 0 16px">NativPost SEO password reset</h2><p>Your verification code:</p><div style="font-size:32px;font-weight:800;letter-spacing:6px;background:#12161b;padding:16px 20px;border-radius:8px;color:#22ff44;text-align:center;font-family:ui-monospace,monospace">${code}</div><p style="color:#a5b0b8;font-size:14px;margin-top:20px">This code expires in 15 minutes. If you did not request this reset, ignore this email and your password stays the same.</p></div>`;
      try {
        await sendEmail({ to: user.email, subject, text, html });
      } catch (e) {
        console.error('[Reset] Email send failed:', e.message);
      }
    }
    // Redirect to code entry page regardless, so we never leak which usernames exist
    const username_token = Buffer.from(username).toString('base64url');
    res.redirect('/auth/verify-reset-code?u=' + username_token + '&msg=' + encodeURIComponent('If that username exists and has an email on file, a 6-digit code has been sent. Enter it below within 15 minutes.'));
  } catch (e) {
    console.error('[Reset] forgot-password error:', e.message);
    res.redirect('/auth/forgot-password?error=Something+went+wrong.+Please+try+again.');
  }
});

app.get('/auth/verify-reset-code', (req, res) => {
  const u = req.query.u || '';
  const msg = req.query.msg || '';
  const error = req.query.error || '';
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Enter code — NativPost SEO</title><link rel="stylesheet" href="/static/styles.css"></head><body class="auth-page"><div class="auth-box"><div class="auth-logo">NP</div><h2>Enter your verification code</h2><p class="auth-sub">Check your email for a 6-digit code, then set a new password.</p>${msg ? '<div class="auth-msg good">' + msg + '</div>' : ''}${error ? '<div class="auth-msg bad">' + error + '</div>' : ''}<form method="post" action="/auth/do-reset"><input type="hidden" name="u" value="${u}"><label>6-digit code</label><input type="text" name="code" maxlength="6" pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code" required autofocus placeholder="000000"><label>New password (min 8 chars)</label><input type="password" name="password" minlength="8" required placeholder="New password"><button type="submit">Reset password</button></form><a href="/auth/forgot-password" class="auth-back">Resend code</a></div></body></html>`);
});

app.post('/auth/do-reset', async (req, res) => {
  try {
    const uToken = String(req.body.u || '');
    const code = String(req.body.code || '').trim();
    const password = String(req.body.password || '');
    if (!uToken || !code || !password) {
      return res.redirect('/auth/verify-reset-code?u=' + encodeURIComponent(uToken) + '&error=All+fields+required');
    }
    if (!/^\d{6}$/.test(code)) {
      return res.redirect('/auth/verify-reset-code?u=' + encodeURIComponent(uToken) + '&error=Code+must+be+6+digits');
    }
    if (password.length < 8) {
      return res.redirect('/auth/verify-reset-code?u=' + encodeURIComponent(uToken) + '&error=Password+must+be+at+least+8+characters');
    }
    let username = '';
    try { username = Buffer.from(uToken, 'base64url').toString('utf8'); } catch { }
    if (!username) return res.redirect('/auth/forgot-password?error=Invalid+request');
    const user = await one('SELECT * FROM auth_users WHERE LOWER(username)=LOWER(?)', [username]).catch(() => null);
    if (!user) {
      // Don't reveal whether the user exists — just say the code is invalid
      return res.redirect('/auth/verify-reset-code?u=' + encodeURIComponent(uToken) + '&error=Invalid+or+expired+code');
    }
    const codeHash = await hashResetCode(code);
    const record = await one(
      "SELECT * FROM auth_reset_codes WHERE user_id=? AND used=0 AND expires_at > NOW() ORDER BY id DESC LIMIT 1",
      [user.id]
    ).catch(() => null);
    if (!record) {
      return res.redirect('/auth/verify-reset-code?u=' + encodeURIComponent(uToken) + '&error=No+active+code.+Request+a+new+one.');
    }
    if (Number(record.attempts) >= 5) {
      await q("UPDATE auth_reset_codes SET used=1 WHERE id=?", [record.id]);
      return res.redirect('/auth/forgot-password?error=Too+many+failed+attempts.+Request+a+new+code.');
    }
    if (record.code_hash !== codeHash) {
      await q("UPDATE auth_reset_codes SET attempts=attempts+1 WHERE id=?", [record.id]);
      const left = 5 - (Number(record.attempts) + 1);
      return res.redirect('/auth/verify-reset-code?u=' + encodeURIComponent(uToken) + '&error=Invalid+code.+' + Math.max(0, left) + '+attempts+remaining.');
    }
    // Code is valid — reset the password
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = await hashPassword(password, salt);
    await q('UPDATE auth_users SET password_hash=?, salt=?, updated_at=NOW() WHERE id=?', [hash, salt, user.id]);
    await q("UPDATE auth_reset_codes SET used=1 WHERE id=?", [record.id]);
    // Invalidate any other outstanding sessions for safety
    await execSafe('DELETE FROM auth_sessions WHERE user_id=?', [user.id]);
    res.redirect('/login?error=Password+reset+successful.+Please+sign+in.');
  } catch (e) {
    console.error('[Reset] do-reset error:', e.message);
    res.redirect('/auth/forgot-password?error=Something+went+wrong.');
  }
});

app.get('/', async (req, res, next) => { try { render(res, 'dashboard', { currentPath: '/', ...(await dashboardData()) }); } catch (e) { next(e); } });

app.get('/sites', async (req, res, next) => { try { render(res, 'sites', { currentPath: '/sites', sites: await q('SELECT * FROM sites WHERE active=1 ORDER BY name ASC'), pages: await q('SELECT sp.*,s.name site_name FROM site_pages sp JOIN sites s ON s.id=sp.site_id GROUP BY sp.site_id, sp.page_url ORDER BY sp.last_scanned_at DESC, FIELD(sp.page_type,\'money\',\'game\',\'blog\',\'support\',\'page\'), sp.word_count DESC LIMIT 120') }); } catch (e) { next(e); } });
app.post('/sites', async (req, res, next) => { try { const url = normalizeUrl(req.body.url); const existing = await one('SELECT id FROM sites WHERE LOWER(TRIM(TRAILING \'/\' FROM url))=LOWER(TRIM(TRAILING \'/\' FROM ?))', [url]); if (existing) await q('UPDATE sites SET name=?,url=?,gsc_property=?,ga4_property_id=?,cms_type=?,active=1 WHERE id=?', [req.body.name, url, req.body.gsc_property || null, req.body.ga4_property_id || null, req.body.cms_type || 'contentful', existing.id]); else await q('INSERT INTO sites (name,url,gsc_property,ga4_property_id,cms_type) VALUES (?,?,?,?,?)', [req.body.name, url, req.body.gsc_property || null, req.body.ga4_property_id || null, req.body.cms_type || 'contentful']); res.redirect('/sites'); } catch (e) { next(e); } });
app.post('/sites/:id', async (req, res, next) => { try { await q('UPDATE sites SET name=?,url=?,gsc_property=?,ga4_property_id=?,cms_type=? WHERE id=?', [req.body.name, normalizeUrl(req.body.url), req.body.gsc_property || null, req.body.ga4_property_id || null, req.body.cms_type || 'contentful', req.params.id]); res.redirect('/sites'); } catch (e) { next(e); } });
app.post('/sites/:id/delete', async (req, res, next) => { try { await q('UPDATE sites SET active=0 WHERE id=?', [req.params.id]); res.redirect('/sites'); } catch (e) { next(e); } });
app.post('/sites/:id/scan', async (req, res, next) => { try { const site = await one('SELECT * FROM sites WHERE id=?', [req.params.id]); const crawlUrl = resolveCrawlUrl(site.url); console.log(`[Scan] Starting crawl for site ${site.id}: ${crawlUrl}`); const scan = await crawlWebsite(crawlUrl, Number(req.body.limit || process.env.CRAWL_PAGE_LIMIT || 80)); console.log(`[Scan] Crawl complete: ${(scan.pages || []).length} pages found`); await saveOwnSiteScan(site.id, scan); res.redirect('/sites'); } catch (e) { console.error('[Scan] Error:', e.message); next(e); } });
app.post('/sites/scan-all', async (req, res, next) => { try { const sites = await q('SELECT * FROM sites WHERE active=1'); for (const s of sites) { try { await saveOwnSiteScan(s.id, await crawlWebsite(resolveCrawlUrl(s.url), Number(process.env.CRAWL_PAGE_LIMIT || 80))); } catch (err) { } } res.redirect('/sites'); } catch (e) { next(e); } });

app.get('/competitors', async (req, res, next) => { try { render(res, 'competitors', { currentPath: '/competitors', sites: await siteOptions(), competitors: await q('SELECT c.id,c.site_id,COALESCE(c.name,c.competitor_name) name,COALESCE(c.url,c.competitor_url) url,c.homepage_title,c.audit_score,c.last_audited_at,c.snapshot_json,s.name site_name FROM competitors c LEFT JOIN sites s ON s.id=c.site_id WHERE c.active=1 ORDER BY c.audit_score DESC,c.id DESC') }); } catch (e) { next(e); } });
app.post('/competitors', async (req, res, next) => {
  try {
    const url = normalizeUrl(req.body.url); const name = req.body.name || hostOf(url); const sid = (req.body.site_id && req.body.site_id !== 'all') ? req.body.site_id : null;
    const existing = await one("SELECT id FROM competitors WHERE LOWER(TRIM(TRAILING '/' FROM COALESCE(url,competitor_url)))=LOWER(TRIM(TRAILING '/' FROM ?))", [url]);
    const id = existing?.id || (await q('INSERT INTO competitors (site_id,name,url,competitor_name,competitor_url) VALUES (?,?,?,?,?)', [sid, name, url, name, url])).insertId;
    if (existing) await q('UPDATE competitors SET site_id=?,name=?,url=?,competitor_name=?,competitor_url=?,active=1 WHERE id=?', [sid, name, url, name, url, id]);
    try { const audit = await auditCompetitor(url); await saveCompetitorAudit(id, audit); } catch (err) { await q('UPDATE competitors SET snapshot_json=?, last_audited_at=NOW() WHERE id=?', [JSON.stringify({ error: err.message, url }), id]); }
    res.redirect(`/competitors/${id}`);
  } catch (e) { next(e); }
});
app.post('/competitors/:id/audit', async (req, res, next) => { try { const c = await one('SELECT COALESCE(url,competitor_url) url FROM competitors WHERE id=?', [req.params.id]); const audit = await auditCompetitor(c.url); await saveCompetitorAudit(req.params.id, audit); res.redirect(`/competitors/${req.params.id}`); } catch (e) { next(e); } });
app.post('/competitors/audit-all', async (req, res, next) => { try { const rows = await q('SELECT id,COALESCE(url,competitor_url) url FROM competitors WHERE active=1'); for (const c of rows) { try { await saveCompetitorAudit(c.id, await auditCompetitor(c.url)); } catch (err) { await q('UPDATE competitors SET snapshot_json=?,last_audited_at=NOW() WHERE id=?', [JSON.stringify({ error: err.message, url: c.url }), c.id]); } } res.redirect('/competitors'); } catch (e) { next(e); } });
app.post('/competitors/:id/delete', async (req, res, next) => { try { await q('UPDATE competitors SET active=0 WHERE id=?', [req.params.id]); res.redirect('/competitors'); } catch (e) { next(e); } });
app.get('/competitors/:id', async (req, res, next) => { try { const competitor = await one('SELECT c.*,COALESCE(c.name,c.competitor_name) display_name,COALESCE(c.url,c.competitor_url) display_url,s.name site_name FROM competitors c LEFT JOIN sites s ON s.id=c.site_id WHERE c.id=?', [req.params.id]); if (!competitor) return res.status(404).render('error', { message: 'Competitor not found', currentPath: '/competitors' }); let audit = null; try { audit = competitor.snapshot_json ? JSON.parse(competitor.snapshot_json) : null; } catch { } const pages = await q('SELECT * FROM competitor_pages WHERE competitor_id=? ORDER BY page_type, word_count DESC', [req.params.id]); render(res, 'competitor-view', { currentPath: '/competitors', competitor, audit, pages }); } catch (e) { next(e); } });

app.get('/articles', async (req, res, next) => { try { res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); await cleanupBrokenArticleImageRefs(); const status = req.query.status || ''; const where = status ? 'WHERE a.status=?' : 'WHERE 1=1'; const articles = await q(`SELECT a.*,COALESCE(a.body,a.content) body,s.name site_name FROM articles a LEFT JOIN sites s ON s.id=a.site_id ${where} AND a.title IS NOT NULL ORDER BY a.updated_at DESC,a.id DESC`, status ? [status] : []); render(res, 'articles', { currentPath: '/articles', articles, status, message: req.query.message || null, query: req.query }); } catch (e) { next(e); } });

// IMPORTANT: this static bulk-delete route must stay BEFORE /articles/:id POST routes.
// Otherwise Express treats "delete-drafts" as an article id and the delete button appears to do nothing.
app.post('/articles/delete-drafts', async (req, res, next) => {
  try {
    const before = await one("SELECT COUNT(*) count FROM articles WHERE status IN ('draft','review','rejected')");
    await q("UPDATE content_calendar c JOIN articles a ON a.id=c.article_id SET c.article_id=NULL,c.status='planned' WHERE a.status IN ('draft','review','rejected')");
    await q("DELETE FROM articles WHERE status IN ('draft','review','rejected')");
    res.redirect('/articles?message=' + encodeURIComponent(`Deleted ${Number(before?.count || 0)} draft/review/rejected article(s).`));
  } catch (e) { next(e); }
});

app.get('/articles/new', async (req, res, next) => { try { render(res, 'article-edit', { currentPath: '/articles', article: null, sites: await siteOptions(), assets: await assetOptions() }); } catch (e) { next(e); } });
app.post('/articles/new', upload.any(), async (req, res, next) => {
  try {
    const asset = req.body.featured_image_id ? await one('SELECT * FROM article_assets WHERE id=?', [req.body.featured_image_id]) : null;
    const body = repairOfferClaims(req.body.body || '');
    const title = safeArticleTitle(req.body.title, articleTitleFor(req.body.primary_keyword || 'ai social media content'));
    const slug = req.body.slug || slugify(title);
    const status = ['draft', 'review', 'approved', 'queued', 'published'].includes(String(req.body.status || '')) ? req.body.status : 'draft';
    const result = await q('INSERT INTO articles (site_id,title,slug,status,primary_keyword,meta_title,meta_description,excerpt,body,content,featured_image_id,featured_image_url,featured_image_alt,review_notes,quality_score,scheduled_for) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [req.body.site_id || null, title, slug, status, req.body.primary_keyword || null, safeArticleTitle(req.body.meta_title, title), repairOfferClaims(req.body.meta_description || '') || null, repairOfferClaims(req.body.excerpt || '') || null, body, body, asset?.id || null, normalizeImageUrl(asset?.asset_url || req.body.featured_image_url) || null, req.body.featured_image_alt || asset?.alt_text || null, req.body.review_notes || null, 0, req.body.scheduled_for || null]);
    const article = await one('SELECT * FROM articles WHERE id=?', [result.insertId]); await q('UPDATE articles SET quality_score=? WHERE id=?', [contentQuality(article), result.insertId]); res.redirect(`/articles/${result.insertId}/edit`);
  } catch (e) { next(e); }
});
app.get('/articles/:id', async (req, res, next) => { try { const article = await one('SELECT a.*,COALESCE(a.body,a.content) body,s.name site_name,aa.contentful_asset_id FROM articles a LEFT JOIN sites s ON s.id=a.site_id LEFT JOIN article_assets aa ON aa.id=a.featured_image_id WHERE a.id=?', [req.params.id]); if (!article) return res.status(404).render('error', { message: 'Article not found', currentPath: '/articles' }); article.featured_image_url = normalizeImageUrl(article.featured_image_url); return res.send(articlePreviewHtml(article)); } catch (e) { next(e); } });
app.get('/articles/:id/edit', async (req, res, next) => { try { const article = await one('SELECT *,COALESCE(body,content) body FROM articles WHERE id=?', [req.params.id]); if (!article) return res.status(404).render('error', { message: 'Article not found', currentPath: '/articles' }); render(res, 'article-edit', { currentPath: '/articles', article, sites: await siteOptions(), assets: await assetOptions(article.site_id, `${article.primary_keyword || ''} ${article.title || ''}`) }); } catch (e) { next(e); } });
app.post('/articles/:id', upload.any(), async (req, res, next) => {
  try {
    const existing = await one('SELECT * FROM articles WHERE id=?', [req.params.id]);
    if (!existing) return res.status(404).render('error', { message: 'Article not found', currentPath: '/articles' });
    const asset = req.body.featured_image_id ? await one('SELECT * FROM article_assets WHERE id=?', [req.body.featured_image_id]) : null;
    const body = repairOfferClaims(req.body.body ?? existing.body ?? existing.content ?? '');
    const title = safeArticleTitle(req.body.title, existing.title || articleTitleFor(req.body.primary_keyword || existing.primary_keyword || 'ai social media content'));
    const slug = req.body.slug || existing.slug || slugify(title);
    const status = ['draft', 'review', 'approved', 'queued', 'published', 'rejected'].includes(String(req.body.status || '')) ? req.body.status : (existing.status || 'draft');
    const scheduledFor = req.body.scheduled_for || existing.scheduled_for || null;
    const articleTemp = { ...existing, ...req.body, title, slug, status, body, featured_image_url: normalizeImageUrl(asset?.asset_url || req.body.featured_image_url || existing.featured_image_url), featured_image_alt: req.body.featured_image_alt || asset?.alt_text || existing.featured_image_alt };
    await q('UPDATE articles SET site_id=?,title=?,slug=?,status=?,primary_keyword=?,meta_title=?,meta_description=?,excerpt=?,body=?,content=?,featured_image_id=?,featured_image_url=?,featured_image_alt=?,review_notes=?,scheduled_for=?,quality_score=? WHERE id=?', [req.body.site_id || existing.site_id || null, title, slug, status, req.body.primary_keyword || existing.primary_keyword || null, safeArticleTitle(req.body.meta_title, title), repairOfferClaims(req.body.meta_description ?? existing.meta_description ?? '') || null, repairOfferClaims(req.body.excerpt ?? existing.excerpt ?? '') || null, body, body, asset?.id || req.body.current_featured_image_id || existing.featured_image_id || null, normalizeImageUrl(asset?.asset_url || req.body.featured_image_url || existing.featured_image_url) || null, req.body.featured_image_alt || asset?.alt_text || existing.featured_image_alt || null, req.body.review_notes ?? existing.review_notes ?? null, scheduledFor, contentQuality(articleTemp), req.params.id]);
    res.redirect(`/articles/${req.params.id}`);
  } catch (e) { next(e); }
});
app.post('/articles/:id/status', upload.any(), async (req, res, next) => {
  try {
    const allowed = new Set(['draft', 'review', 'approved', 'queued', 'published']);
    const statusRaw = Array.isArray(req.body.status) ? req.body.status[req.body.status.length - 1] : req.body.status;
    const status = allowed.has(String(statusRaw || '')) ? String(statusRaw) : 'draft';
    const forceApprove = req.body.force === '1' || req.body.force === 'true'; // "Approve anyway" sets this
    const current = await one('SELECT a.*, s.url site_url FROM articles a LEFT JOIN sites s ON s.id=a.site_id WHERE a.id=?', [req.params.id]);
    if (!current) return res.redirect('/articles');
    const score = contentQuality(current);
    const breakdown = qualityBreakdown(current);
    const cal = await one('SELECT COALESCE(scheduled_for,scheduled_date) scheduled_for FROM content_calendar WHERE article_id=? ORDER BY id DESC LIMIT 1', [req.params.id]);
    // Quality gate: block if below threshold UNLESS force=1 (Approve anyway)
    if (!forceApprove && ['approved', 'queued', 'published'].includes(status) && score < MIN_QUALITY_SCORE) {
      await q("UPDATE articles SET `status`='review', quality_score=?, review_notes=? WHERE id=?", [score, `Quality gate ${score}/${MIN_QUALITY_SCORE}. ${breakdown.notes.join(' ')}`.trim(), req.params.id]);
      return res.redirect('/review');
    }
    if (status === 'approved') await q('UPDATE articles SET `status`=?, reviewed_at=NOW(), scheduled_for=COALESCE(scheduled_for,?), quality_score=?, schema_json=COALESCE(schema_json,?) WHERE id=?', ['queued', cal?.scheduled_for || null, score, buildArticleSchema(current), req.params.id]);
    else if (status === 'queued') await q('UPDATE articles SET `status`=?, scheduled_for=COALESCE(scheduled_for,?), quality_score=?, schema_json=COALESCE(schema_json,?) WHERE id=?', [status, cal?.scheduled_for || null, score, buildArticleSchema(current), req.params.id]);
    else if (status === 'published') await q('UPDATE articles SET `status`=?, published_at=NOW(), quality_score=?, schema_json=COALESCE(schema_json,?) WHERE id=?', [status, score, buildArticleSchema(current), req.params.id]);
    else await q('UPDATE articles SET `status`=?, quality_score=?, schema_json=COALESCE(schema_json,?) WHERE id=?', [status, score, buildArticleSchema(current), req.params.id]);
    if (status === 'approved' || status === 'queued' || status === 'published') return res.redirect('/publish');
    if (status === 'review') return res.redirect('/review');
    res.redirect(req.get('referer') || `/articles/${req.params.id}`);
  } catch (e) { next(e); }
});

// Force-approve route — bypasses quality gate. Used by "Approve anyway" button in review queue.
app.post('/articles/:id/force-approve', async (req, res, next) => {
  try {
    const current = await one('SELECT a.*, s.url site_url FROM articles a LEFT JOIN sites s ON s.id=a.site_id WHERE a.id=?', [req.params.id]);
    if (!current) return res.redirect('/review');
    const score = contentQuality(current);
    const cal = await one('SELECT COALESCE(scheduled_for,scheduled_date) scheduled_for FROM content_calendar WHERE article_id=? ORDER BY id DESC LIMIT 1', [req.params.id]);
    await q('UPDATE articles SET `status`=?, reviewed_at=NOW(), scheduled_for=COALESCE(scheduled_for,?), quality_score=?, schema_json=COALESCE(schema_json,?), review_notes=? WHERE id=?',
      ['queued', cal?.scheduled_for || null, score, buildArticleSchema(current),
        `Force-approved at score ${score}/${MIN_QUALITY_SCORE}.`, req.params.id]);
    await q("UPDATE content_calendar SET status='queued' WHERE article_id=?", [req.params.id]);
    console.log(`[Approve] Article #${req.params.id} force-approved at score ${score}`);
    res.redirect('/publish');
  } catch (e) { next(e); }
});
app.post('/articles/:id/delete', async (req, res, next) => {
  try {
    const articleId = Number(req.params.id);
    if (!Number.isFinite(articleId)) return res.redirect('/articles?message=' + encodeURIComponent('Delete skipped: invalid article id.'));
    await q("UPDATE content_calendar SET article_id=NULL,status='planned' WHERE article_id=?", [articleId]);
    const result = await q('DELETE FROM articles WHERE id=?', [articleId]);
    const deleted = Number(result?.affectedRows || 0);
    res.redirect('/articles?message=' + encodeURIComponent(deleted ? 'Article deleted.' : 'Article was already gone.'));
  } catch (e) { next(e); }
});
app.post('/articles/:id/reject-regenerate', upload.any(), async (req, res, next) => {
  try {
    const a = await one('SELECT * FROM articles WHERE id=?', [req.params.id]);
    if (!a) return res.redirect('/review');
    const oldId = req.params.id;
    const keyword = a.primary_keyword || a.title || 'ai social media content';
    const siteId = a.site_id || null;
    // Generate replacement first
    const newId = await makeDraftFromKeyword({ id: null, site_id: siteId, keyword }, siteId);
    // Update calendar to point to new article
    await q("UPDATE content_calendar SET article_id=?, status='draft-created' WHERE article_id=?", [newId, oldId]);
    // Delete the old article entirely so it doesn't clutter the list
    await q('DELETE FROM articles WHERE id=?', [oldId]);
    res.redirect(`/articles/${newId}/edit`);
  } catch (e) { next(e); }
});
app.post('/articles/regenerate-low-quality', async (req, res, next) => {
  try {
    const rows = await q("SELECT id,site_id,primary_keyword,title FROM articles WHERE status IN ('draft','review') AND COALESCE(quality_score,0) < ? ORDER BY id ASC LIMIT 30", [Number(req.body.threshold || MIN_QUALITY_SCORE)]);
    for (const a of rows) {
      await q("UPDATE articles SET status='rejected', review_notes=CONCAT(COALESCE(review_notes,''), '\nRejected by bulk low-quality regeneration.') WHERE id=?", [a.id]);
      const newId = await makeDraftFromKeyword({ id: null, site_id: a.site_id || null, keyword: a.primary_keyword || a.title || 'ai social media content' }, a.site_id || null);
      await q("UPDATE content_calendar SET article_id=?, status='draft-created' WHERE article_id=?", [newId, a.id]);
    }
    res.redirect('/review');
  } catch (e) { next(e); }
});
app.post('/articles/approve-all-waiting', async (req, res, next) => {
  try {
    await q("UPDATE articles a LEFT JOIN content_calendar c ON c.article_id=a.id SET a.status='queued', a.reviewed_at=NOW(), a.scheduled_for=COALESCE(a.scheduled_for,c.scheduled_for,c.scheduled_date) WHERE a.status IN ('draft','review') AND COALESCE(a.quality_score,0)>=?", [MIN_QUALITY_SCORE]);
    res.redirect('/publish');
  } catch (e) { next(e); }
});
app.post('/articles/:id/upload-image', upload.single('image'), async (req, res, next) => {
  try {
    const a = await one('SELECT * FROM articles WHERE id=?', [req.params.id]);
    if (!a) return res.redirect('/articles');
    if (!req.file) throw new Error('Choose an image file first.');
    const ext = path.extname(req.file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
    const finalName = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`;
    const finalPath = path.join(uploadDir, finalName);
    fs.renameSync(req.file.path, finalPath);
    const game = detectGame(`${req.body.game_slug || ''} ${a.primary_keyword || ''} ${a.title || ''}`) || req.body.game_slug || null;
    const assetUrl = `/uploads/${finalName}`;
    const label = req.body.label || `${a.title || 'Article'} image`;
    const alt = req.body.alt_text || `${a.primary_keyword || a.title || 'NativPost social media content'} image`;
    const result = await q('INSERT INTO article_assets (site_id,label,game_slug,folder_name,asset_url,alt_text) VALUES (?,?,?,?,?,?)', [a.site_id || null, label, game, game || 'article-images', assetUrl, alt]);
    await q('UPDATE articles SET featured_image_id=?, featured_image_url=?, featured_image_alt=? WHERE id=?', [result.insertId, assetUrl, alt, req.params.id]);
    // Recalculate quality score now that image is attached
    const refreshed = await one('SELECT * FROM articles WHERE id=?', [req.params.id]);
    if (refreshed) {
      const newScore = contentQuality(refreshed);
      await q('UPDATE articles SET quality_score=? WHERE id=?', [newScore, req.params.id]);
    }
    res.redirect(`/articles/${req.params.id}/edit`);
  } catch (e) { next(e); }
});




function addPlanCandidate(map, keyword, reason, score = 50, siteId = null) {
  const ck = cleanKeyword(keyword);
  if (!ck) return;
  const key = ck.toLowerCase();
  const current = map.get(key);
  const item = { keyword: ck, site_id: siteId || null, title: articleTitleFor(ck), reason: reason || 'SEO opportunity', score: Number(score || 0) };
  if (!current || item.score > current.score) map.set(key, item);
}
function keywordsFromPageForPlan(page = {}) {
  // NativPost: Extract social media / AI content keywords from competitor pages only.
  // Game hosting keywords are NEVER generated regardless of page content.
  const raw = `${page.page_title || ''} ${page.h1_text || ''} ${page.meta_description || ''} ${page.page_url || ''}`.toLowerCase();
  const out = [];

  // Social media platform angles
  if (/linkedin/.test(raw)) out.push('linkedin content generator ai');
  if (/instagram/.test(raw)) out.push('instagram caption generator ai');
  if (/tiktok/.test(raw)) out.push('tiktok caption generator ai');
  if (/twitter|\bx\.com\b/.test(raw)) out.push('twitter post generator ai');
  if (/facebook/.test(raw)) out.push('facebook post generator ai');
  if (/pinterest/.test(raw)) out.push('pinterest caption generator');
  if (/threads/.test(raw)) out.push('threads post generator ai');

  // Brand voice
  if (/brand voice|tone of voice|voice guide/.test(raw)) out.push('brand voice ai tool');
  if (/brand voice|tone/.test(raw)) out.push('consistent brand voice social media');

  // Content generation
  if (/caption|post|content.generat/.test(raw)) out.push('ai social media caption generator');
  if (/ai.writing|content.ai|write.*post/.test(raw)) out.push('ai social media content generator');
  if (/schedule|calendar|plan.*post/.test(raw)) out.push('social media scheduling tool');
  if (/publish|auto.post/.test(raw)) out.push('auto publish social media');

  // Audience angles
  if (/small.bus|smb|startup/.test(raw)) out.push('social media tool for small business');
  if (/agenc/.test(raw)) out.push('social media tool for agencies');
  if (/africa|nigeria|kenya|ghana|south africa/.test(raw)) out.push('social media tool africa');

  // Competitor comparisons
  if (/ocoya/.test(raw)) out.push('ocoya alternative');
  if (/buffer/.test(raw)) out.push('buffer alternative ai social media');
  if (/hootsuite/.test(raw)) out.push('hootsuite alternative small business');
  if (/jasper/.test(raw)) out.push('jasper alternative social media scheduling');
  if (/predis/.test(raw)) out.push('predis alternative brand voice');
  if (/later\.com|later app/.test(raw)) out.push('later alternative ai content');

  // Pricing
  if (/pricing|price|cost|affordable|cheap/.test(raw)) out.push('affordable social media management tool');

  // Video
  if (/video|reel|ugc|short.form/.test(raw)) out.push('ai social media video generator');

  // Review/comparison
  if (/review|comparison|vs\.?\s|versus|alternative|compare/.test(raw)) out.push('best ai social media tool 2026');

  // Deduplicate and return
  return [...new Set(out)];
}

async function supportedGamesForSite(siteId = null) {
  // Priority order for supported games:
  // 1. NativPost features list (no longer uses live_games table)
  // 2. Explicit env config (SUPPORTED_GAMES_EXACT)
  // 3. Auto-discovered from /games page crawl
  // 4. site_pages table (previously crawled game URLs)
  const supported = explicitSupportedGamesFromEnv();

  // 1. NativPost features — admin-configured
  try {
    const liveRows = Promise.resolve([]);
    for (const r of liveRows) {
      const g = detectGame(r.game_key) || r.game_key;
      if (g) supported.add(g);
    }
  } catch (e) { }

  const site = siteId
    ? await one('SELECT * FROM sites WHERE id=?', [siteId])
    : (await one("SELECT * FROM sites WHERE active=1 AND LOWER(url) LIKE '%nativpost%' ORDER BY id LIMIT 1") || await one('SELECT * FROM sites WHERE active=1 ORDER BY id LIMIT 1'));
  const sid = site?.id || siteId || null;

  // 2. Auto-discover NativPost feature pages
  if (supported.size === 0 && site?.url) {
    for (const g of await discoverSupportedGamesFromGamesPage(site.url)) supported.add(g);
  }

  // 3. site_pages — previously crawled game URLs
  const rows = await q(`SELECT sp.*, s.url site_url FROM site_pages sp LEFT JOIN sites s ON s.id=sp.site_id WHERE (? IS NULL OR sp.site_id<=>?) LIMIT 1200`, [sid, sid]);
  for (const p of rows) {
    const url = String(p.page_url || '');
    if (!looksLikeOwnGameUrl(url)) continue;
    const g = gameFromGameUrl(url) || detectGame(`${p.page_title || ''} ${p.h1_text || ''}`);
    if (g) supported.add(g);
  }
  return supported;
}
async function saveGameRecommendation({ site_id = null, game = '', source_url = '', source_title = '', reason = '', score = 80 } = {}) {
  const g = detectGame(game) || String(game || '').toLowerCase().trim();
  if (!g) return;
  const title = `Consider adding ${gameDisplay(g)} server hosting`;
  await q(`INSERT INTO game_recommendations (site_id,game,title,source_url,source_title,reason,opportunity_score,status)
           VALUES (?,?,?,?,?,?,?, 'recommended')
           ON DUPLICATE KEY UPDATE source_url=VALUES(source_url), source_title=VALUES(source_title), reason=VALUES(reason), opportunity_score=GREATEST(opportunity_score, VALUES(opportunity_score)), status='recommended'`,
    [site_id || null, g, title, source_url || null, source_title || null, reason || `Competitors have content for ${gameDisplay(g)}, but NativPost has not yet published content for this keyword.`, Number(score || 80)]);
}
function candidateAllowedForSupportedGames(keyword = '', supportedGames = new Set()) {
  // NativPost: All non-game keywords are allowed. Game hosting keywords are always blocked.
  const kw = String(keyword || '').toLowerCase();
  const isGameKeyword = /server hosting|game server|\bark\b|\brust\b|valheim|minecraft|palworld|enshrouded|windrose|terraria|dayz|zomboid|conan|icarus|satisfactory|factorio|vrising|v rising|hytale|everwind|eco server/i.test(kw);
  if (isGameKeyword) return false;
  return true;
}
function supportedFallbackTopics(supported = new Set()) {
  const base = ['best ai social media content', 'ai social media content with ddos protection', 'high performance ai social media content', 'affordable ai social media content'];
  for (const g of supported) {
    const label = gameKeywordName(g);
    base.push(`${label} server hosting`, `best ${label} server hosting`, `${label} server setup guide`);
  }
  return [...new Set(base)];
}

async function buildStrategicPlanCandidates(siteId = null, limit = 30) {
  const site = siteId
    ? await one('SELECT * FROM sites WHERE id=?', [siteId])
    : (await one("SELECT * FROM sites WHERE active=1 AND LOWER(url) LIKE '%nativpost%' ORDER BY id LIMIT 1") || await one('SELECT * FROM sites WHERE active=1 ORDER BY id LIMIT 1'));
  const sid = site?.id || null;
  const candidates = [];
  const seen = new Set();

  // Block duplicates
  const existingArticles = await q('SELECT LOWER(COALESCE(primary_keyword,title)) k FROM articles WHERE (? IS NULL OR site_id<=>?)', [sid, sid]);
  const existingCalendar = await q('SELECT LOWER(COALESCE(target_keyword,title)) k FROM content_calendar WHERE (? IS NULL OR site_id<=>?)', [sid, sid]);
  const blocked = new Set([...existingArticles, ...existingCalendar].map(x => String(x.k || '').toLowerCase().trim()).filter(Boolean));

  function addCandidate(keyword, title, reason, score) {
    const kw = cleanKeyword(keyword);
    if (!kw) return;
    const key = kw.toLowerCase();
    if (blocked.has(key) || seen.has(key)) return;
    seen.add(key);
    candidates.push({ keyword: kw, title: title || articleTitleFor(kw), reason, score, site_id: sid });
  }

  // TIER 1: SERP-researched keywords with real volume (highest priority)
  const serpCached = await q(
    'SELECT keyword, search_volume, keyword_difficulty FROM serp_cache ORDER BY search_volume DESC, fetched_at DESC LIMIT 100'
  ).catch(() => []);
  for (const row of serpCached) {
    const vol = Number(row.search_volume || 0);
    const diff = Number(row.keyword_difficulty || 50);
    const score = vol > 0 ? (vol / 10) - (diff * 0.5) + 200 : 150;
    addCandidate(row.keyword, null, `High-volume SERP keyword (${vol.toLocaleString()} searches/mo, difficulty ${diff})`, score);
  }

  // TIER 2: Tracked keywords from keyword table (GSC + competitor crawl)
  // Filter to NativPost-relevant topics only
  const keywords = await q(
    `SELECT keyword, priority_score, volume, difficulty, intent, source
     FROM keywords
     WHERE (? IS NULL OR site_id<=>?)
       AND keyword LIKE '% %'
       AND (
         keyword LIKE '%social media%' OR keyword LIKE '%brand voice%' OR keyword LIKE '%content%'
         OR keyword LIKE '%caption%' OR keyword LIKE '%scheduling%' OR keyword LIKE '%instagram%'
         OR keyword LIKE '%linkedin%' OR keyword LIKE '%tiktok%' OR keyword LIKE '%twitter%'
         OR keyword LIKE '%facebook%' OR keyword LIKE '%ai%' OR keyword LIKE '%nativpost%'
         OR keyword LIKE '%ocoya%' OR keyword LIKE '%buffer%' OR keyword LIKE '%hootsuite%'
         OR keyword LIKE '%jasper%' OR keyword LIKE '%predis%' OR keyword LIKE '%publish%'
         OR keyword LIKE '%africa%' OR keyword LIKE '%nigeria%' OR keyword LIKE '%kenya%'
         OR keyword LIKE '%agency%' OR keyword LIKE '%smb%' OR keyword LIKE '%marketing%'
       )
     ORDER BY priority_score DESC, volume DESC LIMIT 200`,
    [sid, sid]
  );
  for (const k of keywords) {
    const score = Number(k.priority_score || 0) + Number(k.volume || 0) / 100 + 100;
    addCandidate(k.keyword, null, `Tracked keyword — ${k.intent || 'mixed'} intent, source: ${k.source || 'manual'}`, score);
  }

  // TIER 3: Competitor gap keywords (from actual competitor page crawls)
  const compPages = await q(
    `SELECT cp.page_url, cp.page_title, cp.meta_description, cp.word_count,
            COALESCE(c.name,c.competitor_name) competitor_name, c.audit_score
     FROM competitor_pages cp
     JOIN competitors c ON c.id=cp.competitor_id
     WHERE c.active=1 ORDER BY c.audit_score DESC, cp.word_count DESC LIMIT 200`
  );
  for (const p of compPages) {
    // Only use competitor pages relevant to social media / AI content tools
    const text = ((p.page_url || '') + ' ' + (p.page_title || '') + ' ' + (p.meta_description || '')).toLowerCase();
    const isRelevant = /social media|brand voice|content|caption|ai|scheduling|instagram|linkedin|tiktok|marketing|publish|agency|small business/.test(text);
    if (!isRelevant) continue;
    for (const kw of keywordsFromPageForPlan(p)) {
      addCandidate(kw, null, `Competitor gap from ${p.competitor_name}: "${p.page_title || p.page_url}"`, 90 + Math.min(40, Number(p.word_count || 0) / 30));
    }
  }

  // TIER 4: NativPost core commercial keywords (always include these)
  const coreTopics = [
    // AI Social Media — primary category
    { kw: 'ai social media content generator', reason: 'Primary category keyword — highest commercial intent', score: 185 },
    { kw: 'ai social media tool', reason: 'Core category — broad reach + high intent', score: 180 },
    { kw: 'ai social media management', reason: 'Category-level commercial keyword', score: 175 },
    { kw: 'social media content generator', reason: 'High-volume category keyword', score: 170 },
    // Brand Voice — NativPost's #1 differentiator
    { kw: 'brand voice ai', reason: 'NativPost primary differentiator — brand voice config', score: 168 },
    { kw: 'ai brand voice generator', reason: 'Brand voice keyword cluster', score: 162 },
    { kw: 'consistent brand voice social media', reason: 'Pain-point keyword — brand consistency', score: 155 },
    { kw: 'brand voice tool', reason: 'Tool-intent brand voice keyword', score: 150 },
    // Comparisons (high buying intent)
    { kw: 'nativpost vs ocoya', reason: 'Direct comparison — high buying intent', score: 148 },
    { kw: 'ocoya alternative', reason: 'Competitor alternative keyword — captures switching intent', score: 145 },
    { kw: 'buffer alternative ai', reason: 'Competitor alternative — captures Buffer churn', score: 140 },
    { kw: 'hootsuite alternative small business', reason: 'Competitor alternative — SMB segment', score: 135 },
    { kw: 'jasper alternative social media', reason: 'Jasper users looking for scheduling', score: 130 },
    // Content generation
    { kw: 'ai caption generator instagram', reason: 'Platform-specific — high volume', score: 145 },
    { kw: 'ai instagram post generator', reason: 'Instagram content generation keyword', score: 140 },
    { kw: 'linkedin post generator ai', reason: 'LinkedIn content — high commercial intent', score: 138 },
    { kw: 'ai tiktok caption generator', reason: 'TikTok content keyword', score: 130 },
    { kw: 'social media caption generator', reason: 'Broad caption generation keyword', score: 128 },
    // Scheduling
    { kw: 'social media scheduling tool', reason: 'Scheduling — core use case', score: 125 },
    { kw: 'auto publish social media', reason: 'Auto-publish feature keyword', score: 120 },
    { kw: 'social media calendar tool', reason: 'Calendar/planning keyword', score: 115 },
    // Video
    { kw: 'ai social media video generator', reason: 'Video generation — NativPost differentiator', score: 135 },
    { kw: 'ugc ad generator ai', reason: 'UGC Ad format — specific NativPost feature', score: 128 },
    // Africa market
    { kw: 'social media tool nigeria', reason: 'Africa market — Paystack differentiator, no competitors here', score: 140 },
    { kw: 'social media management kenya', reason: 'Africa market — underserved, low competition', score: 135 },
    { kw: 'best social media tool south africa', reason: 'Africa market — Paystack angle', score: 130 },
    { kw: 'ai social media tool africa', reason: 'Africa market — broad', score: 125 },
    // SMB / Agency
    { kw: 'social media tool for small business', reason: 'SMB segment — primary ICP', score: 132 },
    { kw: 'social media tool for agencies', reason: 'Agency segment — Agency plan upsell', score: 128 },
    { kw: 'affordable social media management tool', reason: 'Price-sensitive SMB buyers', score: 120 },
    // Pricing / reviews
    { kw: 'nativpost review', reason: 'Brand review keyword — trust signals', score: 118 },
    { kw: 'nativpost pricing', reason: 'Pricing intent — bottom of funnel', score: 115 },
    { kw: 'best ai social media tool 2026', reason: 'Year-specific best-of keyword', score: 110 },
    // How-to
    { kw: 'how to create consistent social media content', reason: 'How-to — top of funnel educational', score: 108 },
    { kw: 'how to build a brand voice on social media', reason: 'How-to — brand voice education', score: 105 },
    { kw: 'how to use ai for social media marketing', reason: 'How-to — broad educational', score: 100 },
    { kw: 'social media content strategy small business', reason: 'Strategy keyword — SMB ICP', score: 98 },
  ];
  for (const t of coreTopics) addCandidate(t.kw, null, t.reason, t.score);

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}
function scheduledDateForPlan(offsetDays) {
  // Spread articles across weekdays only (Mon-Fri), 2-3 per week
  // offsetDays here means "Nth article in the plan", not literal days offset
  const n = Number(offsetDays || 1);
  // Target: publish Tue, Thu, and optionally Sat — 2-3 per week
  // Week number and position within week
  const articlesPerWeek = 2;
  const weekNum = Math.floor((n - 1) / articlesPerWeek);
  const posInWeek = (n - 1) % articlesPerWeek;
  // Publish days: Tuesday=2, Friday=5
  const publishDays = [2, 5]; // Tue, Fri
  const d = new Date();
  // Start from next Monday
  const dayOfWeek = d.getDay();
  const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek) % 7 || 7;
  d.setDate(d.getDate() + daysUntilMonday + (weekNum * 7) + publishDays[posInWeek]);
  d.setHours(9, 0, 0, 0);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function buildContentMonth(calendarRows = []) {
  const now = new Date();
  const year = now.getFullYear();
  const monthIndex = now.getMonth();
  const first = new Date(year, monthIndex, 1);
  const last = new Date(year, monthIndex + 1, 0);
  const label = first.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push({ empty: true, day: '', items: [] });
  for (let day = 1; day <= last.getDate(); day++) {
    const key = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const items = (calendarRows || []).filter(row => {
      const raw = row.scheduled_for || row.scheduled_date || row.created_at;
      if (!raw) return false;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return false;
      return d.toISOString().slice(0, 10) === key;
    });
    cells.push({ empty: false, day, items });
  }
  while (cells.length % 7 !== 0) cells.push({ empty: true, day: '', items: [] });
  return { label, weekdays, cells };
}
async function loadContentCalendar() {
  await repairContentCalendarSchema();
  const rows = await q('SELECT c.*, a.status article_status, s.name site_name FROM content_calendar c LEFT JOIN articles a ON a.id=c.article_id LEFT JOIN sites s ON s.id=c.site_id LIMIT 200');
  return rows.sort((a, b) => {
    const ad = new Date(a.scheduled_for || a.scheduled_date || a.created_at || 0).getTime();
    const bd = new Date(b.scheduled_for || b.scheduled_date || b.created_at || 0).getTime();
    return (ad - bd) || ((a.id || 0) - (b.id || 0));
  }).slice(0, 90);
}

app.get('/daily-brief', async (req, res, next) => {
  try {
    const brief = await generateDailyBrief(null);
    const today = new Date().toISOString().slice(0, 10);
    const briefRow = await one('SELECT * FROM daily_brief WHERE brief_date=?', [today]).catch(() => null);
    render(res, 'daily-brief', {
      currentPath: '/daily-brief',
      brief,
      summary: briefRow?.summary || '',
      generatedAt: briefRow?.generated_at || new Date(),
      today
    });
  } catch (e) { next(e); }
});

app.post('/daily-brief/refresh', async (req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await execSafe('DELETE FROM daily_brief WHERE brief_date=?', [today]);
    await generateDailyBrief(null);
    res.redirect('/daily-brief?refreshed=1');
  } catch (e) { next(e); }
});

app.post('/daily-brief/generate/:index', async (req, res, next) => {
  try {
    const brief = await generateDailyBrief(null);
    const idx = parseInt(req.params.index);
    const rec = brief[idx];
    if (!rec) return res.redirect('/daily-brief');

    // Immediately reserve this keyword as a placeholder draft so the brief
    // won't recommend it again on next refresh while generation is in progress
    const defaultSite = await one('SELECT id FROM sites WHERE active=1 LIMIT 1');
    const siteId = defaultSite?.id || null;
    await execSafe(
      `INSERT INTO articles (site_id, primary_keyword, title, status, body, created_at, updated_at)
       VALUES (?, ?, ?, 'draft', '', NOW(), NOW())`,
      [siteId, rec.keyword, `[Generating] ${rec.keyword}`]
    );

    // Invalidate today's brief cache so it regenerates fresh on next visit
    const today = new Date().toISOString().slice(0, 10);
    await execSafe('DELETE FROM daily_brief WHERE brief_date=?', [today]);

    // Redirect immediately — generation runs in background
    res.redirect('/articles?generating=' + encodeURIComponent(rec.keyword));

    setImmediate(async () => {
      try {
        const keyword = { id: null, site_id: null, keyword: rec.keyword };
        await makeDraftFromKeyword(keyword, null);
        console.log(`[DailyBrief] Generated article for: ${rec.keyword}`);
        // Clean up the placeholder row — makeDraftFromKeyword creates the real one
        await execSafe(
          `DELETE FROM articles WHERE primary_keyword=? AND title=? AND (body IS NULL OR body='') AND status='draft'`,
          [rec.keyword, `[Generating] ${rec.keyword}`]
        );
      } catch (e) {
        console.error('[DailyBrief] Generation failed:', e.message);
        // On failure, remove placeholder so the brief can recommend it again
        await execSafe(
          `DELETE FROM articles WHERE primary_keyword=? AND title=?`,
          [rec.keyword, `[Generating] ${rec.keyword}`]
        );
      }
    });
  } catch (e) { next(e); }
});

app.get('/content-studio', async (req, res, next) => {
  try {
    const calendar = await loadContentCalendar();
    const month = buildContentMonth(calendar);
    const supportedGames = await supportedGamesForSite(null);
    const rawGameRecommendations = await q("SELECT gr.*,s.name site_name FROM game_recommendations gr LEFT JOIN sites s ON s.id=gr.site_id WHERE gr.status='recommended' ORDER BY gr.opportunity_score DESC, gr.id DESC LIMIT 200");
    const gameRecommendations = rawGameRecommendations.filter(r => !supportedGames.has(detectGame(r.game || r.title || r.reason || ''))).slice(0, 60);
    render(res, 'content-studio', { currentPath: '/content-studio', aiConnected: !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY), openaiConnected: !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY), sites: await siteOptions(), assets: await assetOptions(), calendar, month, supportedGames: [...supportedGames].map(gameDisplay).sort(), keywords: await q("SELECT k.*,s.name site_name FROM keywords k LEFT JOIN sites s ON s.id=k.site_id WHERE k.keyword NOT REGEXP 'nitrado|gportal|gameserver|spieleserver' ORDER BY k.priority_score DESC, k.volume DESC LIMIT 200"), competitors: await q('SELECT id,COALESCE(name,competitor_name) name,audit_score FROM competitors WHERE active=1 ORDER BY audit_score DESC LIMIT 100'), gameRecommendations, gaps: await q(`SELECT k.* FROM keywords k LEFT JOIN articles a ON a.site_id<=>k.site_id AND LOWER(a.primary_keyword)=LOWER(k.keyword) WHERE a.id IS NULL AND k.keyword NOT REGEXP 'nitrado|gportal|gameserver|spieleserver' ORDER BY k.priority_score DESC LIMIT 50`) });
  } catch (e) { next(e); }
});
app.post('/content-studio/refresh-supported-games', async (req, res, next) => {
  try {
    const sites = await q("SELECT * FROM sites WHERE active=1 AND LOWER(url) LIKE '%nativpost%' ORDER BY id");
    for (const s of sites) {
      const games = await discoverSupportedGamesFromGamesPage(s.url);
      for (const g of games) {
        const url = `${originOf(s.url)}/game/${gameKeywordName(g).replace(/\s+/g, '-')}-server-hosting`;
        await execSafe('INSERT INTO site_pages (site_id,page_url,page_title,page_type,word_count,status_code,last_scanned_at) VALUES (?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE page_title=VALUES(page_title), page_type=VALUES(page_type), last_scanned_at=NOW()', [s.id, url, `${gameDisplay(g)} Server Hosting`, 'game', 0, 200]);
      }
    }
    await cleanupDuplicates();
    res.redirect('/content-studio?supportedRefreshed=1');
  } catch (e) { next(e); }
});
app.post('/content-studio/generate', async (req, res, next) => { try { const keyword = { id: null, site_id: req.body.site_id || null, keyword: req.body.keyword || 'ai social media content' }; const id = await makeDraftFromKeyword(keyword, req.body.site_id); res.redirect(`/articles/${id}/edit`); } catch (e) { next(e); } });
app.post('/content-studio/generate-gap/:keywordId', async (req, res, next) => { try { const k = await one('SELECT * FROM keywords WHERE id=?', [req.params.keywordId]); if (!k || !cleanKeyword(k.keyword)) return res.redirect('/content-studio'); const id = await makeDraftFromKeyword(k, k.site_id); res.redirect(`/articles/${id}/edit`); } catch (e) { next(e); } });
app.post('/content-studio/generate-top', async (req, res, next) => {
  try {
    let planned = await q("SELECT * FROM content_calendar WHERE article_id IS NULL AND status='planned' ORDER BY COALESCE(scheduled_for,scheduled_date,created_at), id LIMIT 5");
    if (!planned.length) {
      const candidates = await buildStrategicPlanCandidates(null, 30);
      let day = 1;
      for (const c of candidates) {
        await insertCalendarItem({ site_id: c.site_id || null, title: c.title || articleTitleFor(c.keyword || 'ai social media content'), target_keyword: c.keyword || c.title || 'ai social media content', reason: c.reason || null, status: 'planned', scheduled_for: scheduledDateForPlan(day) });
        day += 1;
      }
      planned = await q("SELECT * FROM content_calendar WHERE article_id IS NULL AND status='planned' ORDER BY COALESCE(scheduled_for,scheduled_date,created_at), id LIMIT 5");
    }
    for (const row of planned.slice(0, 5)) {
      const articleId = await makeDraftFromKeyword({ id: null, site_id: row.site_id || null, keyword: row.target_keyword || row.title }, row.site_id || null);
      await q("UPDATE articles SET status='review', scheduled_for=COALESCE(scheduled_for,?) WHERE id=?", [scheduledValueFromRow(row), articleId]);
      await q('UPDATE content_calendar SET article_id=?, status=? WHERE id=?', [articleId, 'draft-created', row.id]);
    }
    res.redirect('/review');
  } catch (e) { next(e); }
});
app.post('/content-studio/build-plan', async (req, res, next) => {
  try {
    const rawSiteId = req.body.site_id || null;
    const siteId = rawSiteId && rawSiteId !== 'all' ? rawSiteId : null;
    await repairContentCalendarSchema();
    await q("DELETE FROM content_calendar WHERE status='planned' AND article_id IS NULL AND (? IS NULL OR site_id<=>?)", [siteId, siteId]);
    const candidates = await buildStrategicPlanCandidates(siteId, 30);
    let day = 1;
    for (const c of candidates) {
      await insertCalendarItem({ site_id: c.site_id || siteId || null, title: c.title || articleTitleFor(c.keyword || 'ai social media content'), target_keyword: c.keyword || c.title || 'ai social media content', reason: c.reason || null, status: 'planned', scheduled_for: scheduledDateForPlan(day) });
      day += 1;
    }
    res.redirect('/content-studio?planned=' + candidates.length);
  } catch (e) { next(e); }
});
app.post('/content-studio/approve-plan', async (req, res, next) => {
  try {
    await repairContentCalendarSchema();
    await q("UPDATE content_calendar SET status='approved-plan' WHERE article_id IS NULL AND status='planned'");
    res.redirect('/content-studio');
  } catch (e) { next(e); }
});
app.post('/content-studio/generate-month', async (req, res, next) => {
  try {
    await repairContentCalendarSchema();
    const rows = await q("SELECT * FROM content_calendar WHERE article_id IS NULL AND status IN ('planned','approved-plan') ORDER BY COALESCE(scheduled_for,scheduled_date,created_at), id LIMIT 30");
    for (const row of rows) {
      const articleId = await makeDraftFromKeyword({ id: null, site_id: row.site_id || null, keyword: row.target_keyword || row.title }, row.site_id || null);
      await q("UPDATE articles SET status='review', scheduled_for=COALESCE(scheduled_for,?) WHERE id=?", [scheduledValueFromRow(row), articleId]);
      await q('UPDATE content_calendar SET article_id=?, status=? WHERE id=?', [articleId, 'draft-created', row.id]);
    }
    res.redirect('/review');
  } catch (e) { next(e); }
});
app.post('/content-studio/calendar/:id/generate', async (req, res, next) => { try { const row = await one('SELECT * FROM content_calendar WHERE id=?', [req.params.id]); if (!row) return res.redirect('/content-studio'); const keyword = { id: null, site_id: row.site_id || null, keyword: row.target_keyword || row.title || 'ai social media content' }; const articleId = await makeDraftFromKeyword(keyword, row.site_id || null); await q("UPDATE articles SET status='review', scheduled_for=COALESCE(scheduled_for,?) WHERE id=?", [scheduledValueFromRow(row), articleId]); await q('UPDATE content_calendar SET article_id=?, status=? WHERE id=?', [articleId, 'draft-created', req.params.id]); res.redirect(`/articles/${articleId}/edit`); } catch (e) { next(e); } });
app.post('/content-studio/calendar/delete-all', async (req, res, next) => {
  try {
    await repairContentCalendarSchema();
    await q('DELETE FROM content_calendar');
    res.redirect('/content-studio?planDeleted=1');
  } catch (e) { next(e); }
});
app.post('/content-studio/calendar/:id/delete', async (req, res, next) => { try { await q('DELETE FROM content_calendar WHERE id=?', [req.params.id]); res.redirect('/content-studio'); } catch (e) { next(e); } });

app.get('/review', async (req, res, next) => { try { render(res, 'review', { currentPath: '/review', articles: await q("SELECT a.*,COALESCE(a.body,a.content) body,s.name site_name FROM articles a LEFT JOIN sites s ON s.id=a.site_id WHERE a.status IN ('draft','review') ORDER BY a.quality_score DESC,a.updated_at DESC") }); } catch (e) { next(e); } });
app.post('/review/approve-ready', async (req, res, next) => { try { await q("UPDATE articles a LEFT JOIN content_calendar c ON c.article_id=a.id SET a.status='queued', a.reviewed_at=NOW(), a.scheduled_for=COALESCE(a.scheduled_for,c.scheduled_for,c.scheduled_date) WHERE a.status IN ('draft','review') AND COALESCE(a.quality_score,0)>=?", [MIN_QUALITY_SCORE]); res.redirect('/publish'); } catch (e) { next(e); } });
app.get('/publish', async (req, res, next) => { try { render(res, 'publish', { currentPath: '/publish', published: Number(req.query.published || 0), failed: Number(req.query.failed || 0), skipped: Number(req.query.skipped || 0), articles: await q("SELECT a.*,s.name site_name FROM articles a LEFT JOIN sites s ON s.id=a.site_id WHERE a.status IN ('approved','queued','published') ORDER BY FIELD(a.status,'queued','approved','published'), COALESCE(a.scheduled_for,a.updated_at) DESC") }); } catch (e) { next(e); } });
app.post('/publish/auto', async (req, res, next) => {
  try {
    const results = await autoPublishApproved({ force: false });
    const published = results.filter(r => r.status === 'published').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const future = results.filter(r => r.reason === 'scheduled_for_future').length;
    const skipped = published === 0 && failed === 0 ? 1 : 0;
    res.redirect('/publish?published=' + published + '&failed=' + failed + '&skipped=' + skipped + '&future=' + future);
  } catch (e) { next(e); }
});

app.post('/publish/:id', async (req, res, next) => {
  try {
    if (String(req.params.id) === 'auto') return res.redirect('/publish');
    const a = await one('SELECT a.*, aa.contentful_asset_id FROM articles a LEFT JOIN article_assets aa ON aa.id=a.featured_image_id WHERE a.id=?', [req.params.id]);
    if (!a) return res.status(404).render('error', { message: 'Article not found', currentPath: '/publish' });
    const score = contentQuality(a);
    const breakdown = qualityBreakdown(a);
    // Manual publish: bypass quality gate if article is already queued (was force-approved)
    // Only apply gate to articles not yet approved (still in draft/review status)
    const wasForceApproved = a.status === 'queued' && (a.review_notes || '').includes('Force-approved');
    if (score < MIN_QUALITY_SCORE && !wasForceApproved && a.status !== 'queued') {
      await q("UPDATE articles SET status='review', quality_score=?, review_notes=? WHERE id=?", [score, `Quality gate ${score}/${MIN_QUALITY_SCORE}. ${breakdown.notes.join(' ')}`.trim(), req.params.id]);
      return res.redirect('/review');
    }
    let finalUrl = req.body.published_url || a.published_url || '';
    if (publishModeAllowsContentful()) {
      const r = await publishToContentful(a);
      finalUrl = finalUrl || r.publishedUrl;
      await q("UPDATE articles SET contentful_entry_id=?, status='published', published_at=NOW(), published_url=?, review_notes=NULL, schema_json=COALESCE(schema_json,?), quality_score=? WHERE id=?", [r.entryId, finalUrl, buildArticleSchema(a), score, req.params.id]);
      await q("UPDATE content_calendar SET status='published' WHERE article_id=?", [req.params.id]);
    } else {
      let siteUrl = '';
      if (a.site_id) {
        const site = await one('SELECT url FROM sites WHERE id=?', [a.site_id]);
        siteUrl = site?.url || '';
      }
      const base = originOf(siteUrl || process.env.PUBLIC_SITE_URL || process.env.DEFAULT_SITE_URL || 'https://nativpost.com');
      finalUrl = finalUrl || base + '/blog/' + (a.slug || slugify(a.title || 'article'));
      await q("UPDATE articles SET status='published', published_at=NOW(), published_url=?, review_notes=NULL, schema_json=COALESCE(schema_json,?), quality_score=? WHERE id=?", [finalUrl, buildArticleSchema(a), score, req.params.id]);
      await q("UPDATE content_calendar SET status='published' WHERE article_id=?", [req.params.id]);
    }
    // Scan for internal link opportunities from older articles to this one.
    // Non-blocking — errors here never fail the publish response.
    try {
      const fresh = await one('SELECT id, title, slug, primary_keyword, published_url FROM articles WHERE id=?', [req.params.id]);
      if (fresh) {
        const count = await findInternalLinkOpportunities(fresh);
        if (count > 0) console.log(`[InternalLinks] Created ${count} suggestion(s) for article #${fresh.id} "${fresh.title}"`);
      }
    } catch (e) { console.warn('[InternalLinks] scan failed:', e.message); }
    res.redirect('/publish?published=1');
  } catch (e) {
    console.error('[Publish] Failed for article #' + req.params.id + ':', e.message);
    try { await q('UPDATE articles SET review_notes=? WHERE id=?', [`Publish failed: ${e.message}`.slice(0, 1000), req.params.id]); } catch { }
    res.redirect('/publish?published=0&failed=1&failed_id=' + encodeURIComponent(req.params.id));
  }
});


app.post('/articles/repair-images', async (req, res, next) => {
  try {
    await cleanupBrokenLocalPressKitAssets();
    await cleanupBrokenArticleImageRefs();
    const rows = await q("SELECT * FROM articles WHERE status IN ('draft','review','queued','approved') ORDER BY id DESC LIMIT 300");
    let fixed = 0;
    let checked = 0;
    for (const a of rows) {
      const game = detectGame(`${a.primary_keyword || ''} ${a.title || ''} ${a.slug || ''}`);
      if (!game) continue;
      checked++;
      const currentOk = a.featured_image_url && isLocalUploadUrl(a.featured_image_url) && localUploadFileOk(a.featured_image_url, Number(process.env.PRESS_KIT_MIN_LOCAL_BYTES || 12000));
      if (currentOk && a.featured_image_id) continue;
      const asset = await ensurePressKitAssetForGame(game, a.site_id || null);
      if (!asset) continue;
      await q('UPDATE articles SET featured_image_id=?, featured_image_url=?, featured_image_alt=? WHERE id=?', [asset.id, normalizeImageUrl(asset.asset_url), asset.alt_text || `${gameDisplay(game)} official press kit image`, a.id]);
      fixed++;
    }
    res.redirect('/articles?message=' + encodeURIComponent(`Checked ${checked} game article(s). Repaired ${fixed} missing/broken image(s).`));
  } catch (e) { next(e); }
});

app.post('/assets/import-press-kits', async (req, res, next) => {
  try {
    const games = String(req.body.games || '').split(',').map(x => detectGame(x) || normalizeGameName(x)).filter(Boolean);
    const targets = games.length ? games : GAME_ALIASES.map(g => g.key);
    const siteId = req.body.site_id || null;
    let saved = 0;
    for (const game of targets) {
      const rows = await importPressKitAssets(game, siteId, Number(req.body.limit || (game === 'minecraft' ? 12 : 6)));
      saved += rows.length;
    }
    await dedupeExistingLocalPressKitAssets();
    res.redirect('/assets?imported=' + saved);
  } catch (e) { next(e); }
});



app.get(['/api/press-kit/diagnostics', '/press-kit/diagnostics'], async (req, res) => {
  try {
    const game = detectGame(req.query.game || '') || normalizeGameName(req.query.game || '');
    if (!game) return res.status(400).json({ ok: false, error: 'Add ?game=palworld, ?game=icarus, ?game=hytale, etc.' });
    const seeds = pressKitSeedsForGame(game);
    const discovered = await discoverPressKitImages(game, { limit: Number(req.query.limit || 12) });
    const local = await q("SELECT id,label,game_slug,asset_url,alt_text FROM article_assets WHERE game_slug=? AND asset_url LIKE '/uploads/%' ORDER BY id DESC LIMIT 50", [game]);
    res.json({ ok: true, game, display: gameDisplay(game), seeds, discovered_count: discovered.length, discovered: discovered.slice(0, 12).map(x => ({ url: x.url, sourcePage: x.sourcePage, score: x.score, alt: x.alt })), local_count: local.length, local: local.map(x => ({ ...x, file_ok: localUploadFileOk(x.asset_url, Number(process.env.PRESS_KIT_MIN_LOCAL_BYTES || 12000)) })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get(['/api/contentful/diagnostics', '/contentful/diagnostics'], async (req, res) => {
  const rawToken = contentfulToken();
  const cleanedToken = String(rawToken || '').trim().replace(/^['\"]|['\"]$/g, '').replace(/^Bearer\s+/i, '').replace(/[\u200B-\u200D\uFEFF]/g, '');
  const space = process.env.CONTENTFUL_SPACE_ID || '';
  const env = process.env.CONTENTFUL_ENVIRONMENT_ID || 'master';
  const contentType = contentfulContentType();
  const tokenInfo = {
    present: !!cleanedToken,
    prefix: cleanedToken ? cleanedToken.slice(0, 6) + '...' : '',
    length: cleanedToken.length,
    looks_like_cma_personal_access_token: cleanedToken.startsWith('CFPAT-')
  };
  const headers = cleanedToken ? { Authorization: `Bearer ${cleanedToken}` } : {};
  async function probe(label, url) {
    try {
      const r = await axios.get(url, { headers, validateStatus: () => true });
      return {
        label,
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        statusText: r.statusText,
        request_id: r.headers?.['x-contentful-request-id'] || null,
        message: r.data?.message || r.data?.sys?.type || null,
        details: r.data?.details || null
      };
    } catch (e) {
      return { label, ok: false, status: 0, message: e.message };
    }
  }
  const probes = [];
  if (cleanedToken) {
    probes.push(await probe('Management API token identity: /users/me', 'https://api.contentful.com/users/me'));
    if (space && env) {
      probes.push(await probe('Target environment', `https://api.contentful.com/spaces/${encodeURIComponent(space)}/environments/${encodeURIComponent(env)}`));
      if (contentType) probes.push(await probe('Blog content type', `https://api.contentful.com/spaces/${encodeURIComponent(space)}/environments/${encodeURIComponent(env)}/content_types/${encodeURIComponent(contentType)}`));
    }
  }
  res.type('application/json').send(JSON.stringify({
    loaded_env_path: path.join(__dirname, '.env.local'),
    contentful_space_id: space,
    contentful_environment_id: env,
    contentful_blog_content_type_id: contentType,
    token: tokenInfo,
    probes,
    next_step: probes.some(r => r.status === 401) ? '401 means Contentful rejected the token. The app loaded a token, but Contentful says it is not valid for Management API access.' : 'If all probes are OK, retry publishing and send the publish error if it fails.'
  }, null, 2));
});
app.get('/assets', async (req, res, next) => {
  try {
    const assets = await q('SELECT a.*,s.name site_name FROM article_assets a LEFT JOIN sites s ON s.id=a.site_id ORDER BY a.game_slug,a.folder_name,a.label');
    // Build per-game press-kit diagnostics
    const gameStats = {};
    for (const a of assets) {
      const g = a.game_slug || 'unknown';
      if (!gameStats[g]) gameStats[g] = { game: g, count: 0, saved: 0, sourceUrls: new Set(), lastImport: null, failed: 0 };
      gameStats[g].count++;
      if (a.local_path || a.asset_url) gameStats[g].saved++;
      if (a.source_url) gameStats[g].sourceUrls.add(a.source_url);
      if (a.created_at) { const d = new Date(a.created_at); if (!gameStats[g].lastImport || d > gameStats[g].lastImport) gameStats[g].lastImport = d; }
    }
    const pressKitDiagnostics = Object.values(gameStats).map(g => ({ ...g, sourceUrls: [...g.sourceUrls].slice(0, 3) })).sort((a, b) => b.count - a.count);
    render(res, 'assets', { currentPath: '/assets', imported: Number(req.query.imported || 0), sites: await siteOptions(), assets, pressKitDiagnostics });
  } catch (e) { next(e); }
});
app.post('/assets', upload.single('image'), async (req, res, next) => {
  try {
    let assetUrl = normalizeImageUrl(req.body.asset_url);
    if (req.file) {
      const ext = path.extname(req.file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      const finalName = `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`;
      const finalPath = path.join(uploadDir, finalName);
      fs.renameSync(req.file.path, finalPath);
      assetUrl = `/uploads/${finalName}`;
    }
    if (!assetUrl) throw new Error('Paste an image URL or choose an image file.');
    const game = req.body.game_slug || detectGame(`${req.body.label || ''} ${req.body.alt_text || ''}`) || null;
    await q('INSERT INTO article_assets (site_id,label,game_slug,folder_name,asset_url,alt_text,contentful_asset_id) VALUES (?,?,?,?,?,?,?)', [req.body.site_id || null, req.body.label || 'Uploaded image', game, req.body.folder_name || game || null, assetUrl, req.body.alt_text || null, req.body.contentful_asset_id || null]);
    res.redirect('/assets');
  } catch (e) { next(e); }
});
app.post('/assets/:id/delete', async (req, res, next) => { try { await q('DELETE FROM article_assets WHERE id=?', [req.params.id]); res.redirect('/assets'); } catch (e) { next(e); } });

app.get('/keywords', async (req, res, next) => { try { render(res, 'keywords', { currentPath: '/keywords', sites: await siteOptions(), keywords: await q('SELECT k.*,s.name site_name FROM keywords k LEFT JOIN sites s ON s.id=k.site_id ORDER BY k.priority_score DESC,k.volume DESC,k.id DESC') }); } catch (e) { next(e); } });
app.post('/keywords', async (req, res, next) => { try { const p = priorityScore({ volume: req.body.volume, difficulty: req.body.difficulty, position: req.body.position || 50 }); await q('INSERT INTO keywords (site_id,keyword,cluster_name,volume,difficulty,priority_score,source,intent,last_updated) VALUES (?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE volume=VALUES(volume),difficulty=VALUES(difficulty),priority_score=VALUES(priority_score),cluster_name=VALUES(cluster_name),intent=VALUES(intent),last_updated=NOW()', [req.body.site_id || null, req.body.keyword, req.body.cluster_name || clusterName(req.body.keyword), req.body.volume || 0, req.body.difficulty || 35, p, req.body.source || 'manual', req.body.intent || intentOf(req.body.keyword)]); res.redirect('/keywords'); } catch (e) { next(e); } });
app.post('/keywords/cluster', async (req, res, next) => { try { const rows = await q('SELECT * FROM keywords'); for (const k of rows) await q('UPDATE keywords SET cluster_name=?,intent=?,priority_score=GREATEST(priority_score,?) WHERE id=?', [clusterName(k.keyword), intentOf(k.keyword), priorityScore({ volume: k.volume, difficulty: k.difficulty, position: 50 }), k.id]); res.redirect('/keywords'); } catch (e) { next(e); } });

app.get('/backlinks', async (req, res, next) => { try { render(res, 'backlinks', { currentPath: '/backlinks', sites: await siteOptions(), competitors: await q('SELECT id,COALESCE(name,competitor_name) name FROM competitors WHERE active=1 ORDER BY name'), backlinks: await q('SELECT b.*,s.name site_name,COALESCE(c.name,c.competitor_name) competitor_name FROM backlinks b LEFT JOIN sites s ON s.id=b.site_id LEFT JOIN competitors c ON c.id=b.competitor_id ORDER BY FIELD(b.status,\'opportunity\',\'competitor-opportunity\',\'outreach\',\'earned\'), b.authority_score DESC,b.id DESC') }); } catch (e) { next(e); } });
app.post('/backlinks', async (req, res, next) => { try { await q('INSERT INTO backlinks (site_id,competitor_id,source_domain,source_url,target_url,anchor_text,authority_score,status) VALUES (?,?,?,?,?,?,?,?)', [req.body.site_id || null, req.body.competitor_id || null, req.body.source_domain || hostOf(req.body.source_url), req.body.source_url || null, req.body.target_url || null, req.body.anchor_text || null, req.body.authority_score || 0, req.body.status || 'opportunity']); res.redirect('/backlinks'); } catch (e) { next(e); } });
app.post('/backlinks/:id/status', async (req, res, next) => { try { await q('UPDATE backlinks SET status=? WHERE id=?', [req.body.status, req.params.id]); res.redirect('/backlinks'); } catch (e) { next(e); } });
app.post('/backlinks/:id/notes', async (req, res, next) => {
  try {
    await q('UPDATE backlinks SET outreach_notes=?, last_contacted_at=CASE WHEN ? IS NOT NULL AND ? != \'\' THEN NOW() ELSE last_contacted_at END WHERE id=?',
      [req.body.outreach_notes || null, req.body.outreach_notes, req.body.outreach_notes, req.params.id]);
    res.redirect('/backlinks');
  } catch (e) { next(e); }
});
app.post('/backlinks/score-all', async (req, res, next) => {
  try {
    const rows = await q('SELECT id, source_domain FROM backlinks WHERE domain_rating=0 OR domain_rating IS NULL');
    for (const r of rows) {
      const score = scoreBacklinkOpportunity(r.source_domain || '');
      await execSafe('UPDATE backlinks SET authority_score=GREATEST(authority_score,?), domain_rating=? WHERE id=?', [score, score, r.id]);
    }
    res.redirect('/backlinks?scored=1');
  } catch (e) { next(e); }
});

app.get('/reports', async (req, res, next) => {
  try {
    const siteId = req.query.site_id || null;
    const [techIssues, rankingTop, weeklyChange, decayPages, positionHistory] = await Promise.all([
      runTechnicalSEOAudit(siteId || null),
      q("SELECT keyword, MIN(position) position, SUM(clicks) clicks, SUM(impressions) impressions, MAX(recorded_on) recorded_on FROM rankings WHERE recorded_on >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) AND (keyword LIKE '%social media%' OR keyword LIKE '%ai%' OR keyword LIKE '%brand%' OR keyword LIKE '%content%' OR keyword LIKE '%caption%' OR keyword LIKE '%nativpost%' OR keyword LIKE '%instagram%' OR keyword LIKE '%linkedin%' OR keyword LIKE '%tiktok%' OR keyword LIKE '%schedule%' OR keyword LIKE '%publish%' OR keyword LIKE '%africa%') GROUP BY keyword ORDER BY SUM(clicks) DESC, SUM(impressions) DESC LIMIT 20").catch(() => []),
      buildWeeklyChangeReport(siteId || null),
      detectContentDecay(siteId || null),
      getPositionHistory(siteId || null, 8)
    ]);
    render(res, 'reports', {
      currentPath: '/reports',
      reports: await q('SELECT r.*,s.name site_name FROM seo_report_snapshots r LEFT JOIN sites s ON s.id=r.site_id ORDER BY r.recorded_on DESC,r.id DESC LIMIT 100'),
      metrics: await q('SELECT p.*,s.name site_name FROM page_metrics p LEFT JOIN sites s ON s.id=p.site_id ORDER BY p.report_date DESC,p.views DESC LIMIT 100'),
      pages: await q("SELECT sp.*,s.name site_name FROM site_pages sp JOIN sites s ON s.id=sp.site_id GROUP BY sp.site_id, sp.page_url ORDER BY FIELD(sp.page_type,'money','game','blog','support','page'), sp.word_count DESC LIMIT 100"),
      articles: await q('SELECT id,title,primary_keyword,status,quality_score,review_notes,scheduled_for,updated_at FROM articles ORDER BY updated_at DESC LIMIT 200'),
      keywords: await q('SELECT keyword,cluster_name,priority_score,volume,intent FROM keywords ORDER BY priority_score DESC LIMIT 200'),
      gaps: await q("SELECT keyword,cluster_name,priority_score,volume,intent FROM keywords WHERE source IN ('competitor-crawl','serp') AND keyword LIKE '% %' AND (keyword LIKE '%social media%' OR keyword LIKE '%brand voice%' OR keyword LIKE '%content%' OR keyword LIKE '%caption%' OR keyword LIKE '%ai%' OR keyword LIKE '%nativpost%' OR keyword LIKE '%marketing%' OR keyword LIKE '%publish%' OR keyword LIKE '%schedule%' OR keyword LIKE '%instagram%' OR keyword LIKE '%linkedin%' OR keyword LIKE '%tiktok%' OR keyword LIKE '%africa%' OR keyword LIKE '%agency%') ORDER BY priority_score DESC LIMIT 50"),
      backlinks: await q('SELECT b.*,COALESCE(c.name,c.competitor_name) competitor_name FROM backlinks b LEFT JOIN competitors c ON c.id=b.competitor_id ORDER BY b.authority_score DESC, b.domain_rating DESC, b.id DESC LIMIT 100').catch(() => []),
      competitors: await q('SELECT id,COALESCE(name,competitor_name) name,COALESCE(url,competitor_url) url,audit_score,last_audited_at FROM competitors WHERE active=1 ORDER BY audit_score DESC'),
      serpItems: await q('SELECT keyword, provider, search_volume, fetched_at FROM serp_cache ORDER BY fetched_at DESC LIMIT 30').catch(() => []),
      techIssues, rankingTop, weeklyChange, decayPages, positionHistory
    });
  } catch (e) { next(e); }
});
app.get('/settings', async (req, res, next) => {
  try {
    const gscConnected = await googleConnected();
    const sites = await q('SELECT id,name,gsc_property,ga4_property_id FROM sites WHERE active=1');
    const lastGscSync = await one("SELECT MAX(recorded_on) last_sync FROM rankings").catch(() => null);
    const rankingCount = await one("SELECT COUNT(*) cnt FROM rankings").catch(() => ({ cnt: 0 }));
    render(res, 'settings', {
      currentPath: '/settings',
      query: req.query,
      gscConnected, googleClientConfigured: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
      gscSynced: Number(req.query.gsc_sync || 0), ga4Synced: Number(req.query.ga4_sync || 0),
      googleMsg: req.query.google || '', errorMsg: req.query.error || '', infoMsg: req.query.msg || '',
      sites,
      lastGscSync: lastGscSync?.last_sync || null,
      rankingCount: Number(rankingCount?.cnt || 0),
      dfsCallsToday: _dfsDailyCallCount,
      dfsDailyCap: DFS_DAILY_CALL_CAP,
      env: {
        hasAI: !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY), hasOpenAI: !!process.env.OPENAI_API_KEY, hasAnthropic: !!process.env.ANTHROPIC_API_KEY, hasGoogle: googleCredentialsStatus().configured,
        googleStatus: gscConnected ? 'Connected — refresh token stored' : googleCredentialsStatus().label,
        googleServiceAccount: googleCredentialsStatus().serviceAccount, googleOAuth: googleCredentialsStatus().oauth,
        hasContentful: contentfulReady(), contentfulActive: publishModeAllowsContentful(),
        contentfulType: contentfulContentType(), publishMode: process.env.PUBLISH_MODE || 'manual',
        crawlLimit: process.env.CRAWL_PAGE_LIMIT || 35, crawlBaseUrl: CRAWL_BASE_URL || '', port: PORT,
        minRam: NP_MIN_PRICE, basePrice: NP_BASE_PLAN_PRICE, trialDays: NP_TRIAL_DAYS,
        packageRules: NP_PACKAGE_RULES, refundPolicy: NP_REFUND_POLICY
      }
    });
  } catch (e) { next(e); }
});

app.post('/maintenance/cleanup', async (req, res, next) => { try { await cleanupDuplicates(); await cleanupBrokenLocalPressKitAssets(); await cleanupBrokenArticleImageRefs(); res.redirect('/'); } catch (e) { next(e); } });
app.post('/maintenance/run-all', async (req, res, next) => { try { await cleanupDuplicates(); const sites = await q('SELECT * FROM sites WHERE active=1'); for (const s of sites) { try { await saveOwnSiteScan(s.id, await crawlWebsite(resolveCrawlUrl(s.url), Number(process.env.CRAWL_PAGE_LIMIT || 35))); } catch (err) { } } const comps = await q('SELECT id,COALESCE(url,competitor_url) url FROM competitors WHERE active=1'); for (const c of comps) { try { await saveCompetitorAudit(c.id, await auditCompetitor(c.url)); } catch (err) { } } res.redirect('/'); } catch (e) { next(e); } });

// ── SERP Intelligence routes ──────────────────────────────────────────────────
app.get('/serp', async (req, res, next) => {
  try {
    const siteId = req.query.site_id || null;
    const sites = await siteOptions();
    const rawCached = await q(
      `SELECT sc.keyword, sc.provider, sc.search_volume, sc.keyword_difficulty,
            sc.fetched_at, sc.expires_at, sc.serp_features_json, sc.summary_json
     FROM serp_cache sc
     ORDER BY sc.fetched_at DESC LIMIT 120`
    );
    // Derive result_count and avg_words from the stored summary JSON — avoids dependency on serp_results table
    const cached = rawCached.map(row => {
      const summary = safeJsonParse(row.summary_json, {});
      const results = Array.isArray(summary.results) ? summary.results : [];
      const wordCounts = results.map(r => Number(r.word_count || 0)).filter(n => n > 0);
      const avg_words = wordCounts.length ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length) : 0;
      return { ...row, result_count: results.length, avg_words: avg_words || null };
    });
    const providerStatus = DFS_ENABLED
      ? `DataForSEO active — US / English / ${DFS_DEVICE} / top ${DFS_MAX_RESULTS} results / ${DFS_CACHE_DAYS}-day cache`
      : 'DuckDuckGo fallback active — add DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD to .env.local and set DATAFORSEO_ENABLED=true to upgrade';
    render(res, 'serp', { currentPath: '/serp', sites, siteId, cached, providerStatus, dfsEnabled: DFS_ENABLED });
  } catch (e) { next(e); }
});

app.post('/serp/analyze', async (req, res, next) => {
  try {
    const keyword = String(req.body.keyword || '').trim();
    const siteId = req.body.site_id || null;
    if (!keyword) return res.redirect('/serp');
    await purgeSerpCache(siteId, keyword);
    await analyzeSerpForKeyword({ siteId, keyword, siteUrl: '' });
    res.redirect('/serp' + (siteId ? '?site_id=' + encodeURIComponent(siteId) : ''));
  } catch (e) { next(e); }
});

app.post('/serp/analyze-batch', async (req, res, next) => {
  try {
    const siteId = req.body.site_id || null;
    const keywords = [...new Set(String(req.body.keywords || '').split('\n').map(l => l.trim()).filter(Boolean))].slice(0, 20);
    for (const kw of keywords) {
      await purgeSerpCache(siteId, kw);
      try { await analyzeSerpForKeyword({ siteId, keyword: kw, siteUrl: '' }); } catch (e) { console.warn('[SERP batch]', kw, e.message); }
    }
    res.redirect('/serp' + (siteId ? '?site_id=' + encodeURIComponent(siteId) : ''));
  } catch (e) { next(e); }
});

app.post('/serp/purge', async (req, res, next) => {
  try {
    await purgeSerpCache(req.body.site_id || null, req.body.keyword || null);
    res.redirect('/serp' + (req.body.site_id ? '?site_id=' + encodeURIComponent(req.body.site_id) : ''));
  } catch (e) { next(e); }
});

app.get('/serp/:keyword/results', async (req, res, next) => {
  try {
    const keyword = decodeURIComponent(req.params.keyword || '');
    const qword = cleanKeyword(keyword) || keyword;
    const cache = await one('SELECT * FROM serp_cache WHERE keyword=? ORDER BY fetched_at DESC LIMIT 1', [qword]);
    if (!cache) return res.json({ keyword, provider: 'unknown', fetched_at: null, expires_at: null, search_volume: 0, keyword_difficulty: 0, serp_features: [], results: [] });
    const summary = safeJsonParse(cache.summary_json, {});
    res.json({
      keyword,
      provider: cache.provider || 'unknown',
      fetched_at: cache.fetched_at || null,
      expires_at: cache.expires_at || null,
      search_volume: cache.search_volume || 0,
      keyword_difficulty: cache.keyword_difficulty || 0,
      serp_features: safeJsonParse(cache.serp_features_json, []),
      results: (summary.results || []).map(r => ({
        position: r.position || 0,
        url: r.url || r.result_url || '',
        title: r.title || r.result_title || '',
        snippet: r.snippet || '',
        word_count: r.word_count || 0,
        headings: r.headings || [],
        questions: r.questions || []
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message || 'Failed to load results' }); }
});
// ─────────────────────────────────────────────────────────────────────────────

// ── GOOGLE OAUTH ROUTES ───────────────────────────────────────────────────────
app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.redirect('/settings?error=no_google_client');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent'
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/settings?error=no_code');
  try {
    const resp = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code'
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const tokens = resp.data;
    await saveGoogleToken({
      access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000, scope: tokens.scope
    });
    // Auto-sync GSC data immediately after connecting
    try {
      const allSites = await q('SELECT * FROM sites WHERE active=1');
      let autoSynced = 0;
      for (const site of allSites) {
        const prop = site.gsc_property || process.env['GSC_PROPERTY_' + (site.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')] || process.env.GSC_PROPERTY_NATIVPOST;
        if (prop && prop !== 'NOT_SET_YET') {
          try { autoSynced += await syncGSCData(site.id, prop); } catch (e) { console.error('Auto GSC sync error:', e.message); }
        }
      }
      console.log('Auto GSC sync after connect:', autoSynced, 'rows');
    } catch (e) { console.error('Auto sync failed:', e.message); }
    res.redirect('/settings?google=connected');
  } catch (e) {
    console.error('Google OAuth callback error:', e.message);
    res.redirect('/settings?error=oauth_failed&detail=' + encodeURIComponent(e.message));
  }
});

app.post('/api/auth/google/disconnect', async (req, res) => {
  try { await execSafe('DELETE FROM google_oauth_tokens'); } catch (e) { }
  res.redirect('/settings?google=disconnected');
});

app.post('/api/gsc/sync', async (req, res, next) => {
  try {
    const sites = await q('SELECT * FROM sites WHERE active=1');
    let total = 0;
    const results = [];
    for (const site of sites) {
      const prop = site.gsc_property || process.env['GSC_PROPERTY_' + (site.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')] || process.env.GSC_PROPERTY_NATIVPOST;
      if (!prop || prop === 'NOT_SET_YET') { results.push({ name: site.name, skipped: true, reason: 'No GSC property configured' }); continue; }
      try {
        const n = await syncGSCData(site.id, prop);
        total += n;
        results.push({ name: site.name, imported: n, property: prop });
      } catch (e) { results.push({ name: site.name, error: e.message }); }
    }
    res.redirect('/settings?gsc_sync=' + total + '&msg=' + encodeURIComponent('Synced ' + total + ' GSC rows'));
  } catch (e) { next(e); }
});

app.post('/api/ga4/sync', async (req, res, next) => {
  try {
    const sites = await q('SELECT * FROM sites WHERE active=1');
    let total = 0;
    const errors = [];
    for (const site of sites) {
      const prop = site.ga4_property_id || process.env['GA4_PROPERTY_ID_' + (site.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')] || process.env.GA4_PROPERTY_ID_NATIVPOST;
      if (!prop || prop === 'NOT_SET_YET') { errors.push(site.name + ': no GA4 property ID configured — set ga4_property_id on the site record in Own Sites'); continue; }
      try { const n = await syncGA4Data(site.id, prop); total += n; } catch (e) { errors.push(site.name + ': ' + e.message); console.error('GA4 sync error:', e.message); }
    }
    const msg = total > 0 ? 'GA4 sync complete — ' + total + ' rows imported' : (errors.length ? 'GA4 sync attempted. Issues: ' + errors.join(' | ') : 'GA4 sync ran but returned 0 rows — check your GA4 property ID in Own Sites');
    res.redirect('/settings?ga4_sync=' + Math.max(total, 1) + '&msg=' + encodeURIComponent(msg));
  } catch (e) { next(e); }
});

app.post('/reports/run-audit', async (req, res, next) => {
  try {
    const siteId = req.body.site_id || null;
    const issues = await runTechnicalSEOAudit(siteId || null);
    const critical = issues.filter(i => i.severity === 'critical').length;
    const warning = issues.filter(i => i.severity === 'warning').length;
    const score = Math.max(0, 100 - critical * 10 - warning * 3);
    await execSafe(
      'INSERT INTO seo_report_snapshots (site_id,snapshot_type,score,payload_json,recorded_on) VALUES (?,?,?,?,CURDATE()) ON DUPLICATE KEY UPDATE score=VALUES(score),payload_json=VALUES(payload_json)',
      [siteId || null, 'technical_audit', score, JSON.stringify(issues)]
    );
    res.redirect('/reports?audited=1');
  } catch (e) { next(e); }
});

app.get('/reports/competitor-gaps', async (req, res, next) => {
  try {
    // Keywords competitors rank for that we don't have content for
    const gaps = await q(`
      SELECT k.keyword, k.cluster_name, k.intent, k.priority_score, k.volume,
             GROUP_CONCAT(DISTINCT COALESCE(c.name,c.competitor_name) ORDER BY c.id SEPARATOR ', ') AS found_at_competitors,
             (SELECT COUNT(*) FROM articles a WHERE a.primary_keyword=k.keyword AND a.status IN ('published','queued','approved')) AS we_have
      FROM keywords k
      LEFT JOIN competitors c ON c.active=1
      WHERE k.source IN ('competitor-crawl','serp','gsc')
      GROUP BY k.id
      HAVING we_have = 0
      ORDER BY k.priority_score DESC, k.volume DESC
      LIMIT 100
    `);
    const [cgTechIssues, cgWeeklyChange, cgDecayPages, cgPositionHistory, cgRankingTop] = await Promise.all([
      runTechnicalSEOAudit(null),
      buildWeeklyChangeReport(null),
      detectContentDecay(null),
      getPositionHistory(null, 8),
      q("SELECT keyword, MIN(position) position, SUM(clicks) clicks, SUM(impressions) impressions, MAX(recorded_on) recorded_on FROM rankings WHERE recorded_on >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) AND (keyword LIKE '%social media%' OR keyword LIKE '%ai%' OR keyword LIKE '%brand%' OR keyword LIKE '%content%' OR keyword LIKE '%caption%' OR keyword LIKE '%nativpost%' OR keyword LIKE '%instagram%' OR keyword LIKE '%linkedin%' OR keyword LIKE '%tiktok%' OR keyword LIKE '%schedule%' OR keyword LIKE '%publish%' OR keyword LIKE '%africa%') GROUP BY keyword ORDER BY SUM(clicks) DESC, SUM(impressions) DESC LIMIT 20").catch(() => [])
    ]);
    render(res, 'reports', {
      currentPath: '/reports', competitorGaps: gaps,
      reports: await q('SELECT r.*,s.name site_name FROM seo_report_snapshots r LEFT JOIN sites s ON s.id=r.site_id ORDER BY r.recorded_on DESC LIMIT 100'),
      metrics: await q('SELECT p.*,s.name site_name FROM page_metrics p LEFT JOIN sites s ON s.id=p.site_id ORDER BY p.report_date DESC,p.views DESC LIMIT 100'),
      pages: await q("SELECT sp.*,s.name site_name FROM site_pages sp JOIN sites s ON s.id=sp.site_id GROUP BY sp.site_id, sp.page_url ORDER BY FIELD(sp.page_type,'money','game','blog','support','page'), sp.word_count DESC LIMIT 100"),
      articles: await q('SELECT id,title,primary_keyword,status,quality_score,review_notes,scheduled_for,updated_at FROM articles ORDER BY updated_at DESC LIMIT 200'),
      keywords: await q('SELECT keyword,cluster_name,priority_score,volume,intent FROM keywords ORDER BY priority_score DESC LIMIT 200'),
      gaps: await q("SELECT keyword,cluster_name,priority_score,volume,intent FROM keywords WHERE source IN ('competitor-crawl','serp') AND keyword LIKE '% %' AND (keyword LIKE '%social media%' OR keyword LIKE '%brand voice%' OR keyword LIKE '%content%' OR keyword LIKE '%caption%' OR keyword LIKE '%ai%' OR keyword LIKE '%nativpost%' OR keyword LIKE '%marketing%' OR keyword LIKE '%publish%' OR keyword LIKE '%schedule%' OR keyword LIKE '%instagram%' OR keyword LIKE '%linkedin%' OR keyword LIKE '%tiktok%' OR keyword LIKE '%africa%' OR keyword LIKE '%agency%') ORDER BY priority_score DESC LIMIT 50"),
      backlinks: await q('SELECT b.*,COALESCE(c.name,c.competitor_name) competitor_name FROM backlinks b LEFT JOIN competitors c ON c.id=b.competitor_id ORDER BY b.authority_score DESC, b.id DESC LIMIT 100').catch(() => []),
      competitors: await q('SELECT id,COALESCE(name,competitor_name) name,COALESCE(url,competitor_url) url,audit_score,last_audited_at FROM competitors WHERE active=1 ORDER BY audit_score DESC'),
      serpItems: await q('SELECT keyword, provider, search_volume, fetched_at FROM serp_cache ORDER BY fetched_at DESC LIMIT 30').catch(() => []),
      techIssues: cgTechIssues, rankingTop: cgRankingTop,
      weeklyChange: cgWeeklyChange, decayPages: cgDecayPages, positionHistory: cgPositionHistory
    });
  } catch (e) { next(e); }
});


// ── INTERNAL LINKING ROUTES ───────────────────────────────────────────────
// Review pending link suggestions, apply them one-by-one or in bulk, and
// manually re-run the scan for every published article (backfill).
app.get('/reports/internal-links', async (req, res, next) => {
  try {
    const status = req.query.status || 'pending';
    const allowedStatuses = ['pending', 'applied', 'rejected', 'stale', 'all'];
    const filterStatus = allowedStatuses.includes(status) ? status : 'pending';
    const where = filterStatus === 'all' ? '' : 'WHERE ils.status=?';
    const params = filterStatus === 'all' ? [] : [filterStatus];
    const rows = await q(
      'SELECT ils.*, ' +
      'sa.title AS source_title, sa.slug AS source_slug, sa.published_url AS source_url, ' +
      'ta.title AS target_title, ta.slug AS target_slug, ta.published_url AS target_published_url, ' +
      'ta.primary_keyword AS target_keyword ' +
      'FROM internal_link_suggestions ils ' +
      'LEFT JOIN articles sa ON sa.id=ils.source_article_id ' +
      'LEFT JOIN articles ta ON ta.id=ils.target_article_id ' +
      (where ? where + ' ' : '') +
      'ORDER BY FIELD(ils.status,\'pending\',\'stale\',\'applied\',\'rejected\'), ils.created_at DESC LIMIT 500',
      params
    );
    const counts = {
      pending: (await one("SELECT COUNT(*) c FROM internal_link_suggestions WHERE status='pending'"))?.c || 0,
      applied: (await one("SELECT COUNT(*) c FROM internal_link_suggestions WHERE status='applied'"))?.c || 0,
      rejected: (await one("SELECT COUNT(*) c FROM internal_link_suggestions WHERE status='rejected'"))?.c || 0,
      stale: (await one("SELECT COUNT(*) c FROM internal_link_suggestions WHERE status='stale'"))?.c || 0,
      total: (await one('SELECT COUNT(*) c FROM internal_link_suggestions'))?.c || 0
    };
    render(res, 'internal-links', {
      currentPath: '/reports/internal-links',
      suggestions: rows,
      counts,
      filterStatus,
      message: req.query.message || null
    });
  } catch (e) { next(e); }
});

app.post('/reports/internal-links/:id/apply', async (req, res, next) => {
  try {
    const result = await applyInternalLinkSuggestion(req.params.id);
    const msg = result.ok
      ? `Linked "${result.anchor}" in article #${result.sourceId} → #${result.targetId}${result.republished ? ' (republished to Contentful)' : ''}`
      : `Could not apply: ${result.error}`;
    res.redirect('/reports/internal-links?message=' + encodeURIComponent(msg));
  } catch (e) { next(e); }
});

app.post('/reports/internal-links/:id/reject', async (req, res, next) => {
  try {
    await q("UPDATE internal_link_suggestions SET status='rejected' WHERE id=?", [req.params.id]);
    res.redirect('/reports/internal-links');
  } catch (e) { next(e); }
});

app.post('/reports/internal-links/apply-all', async (req, res, next) => {
  try {
    const pending = await q("SELECT id FROM internal_link_suggestions WHERE status='pending' ORDER BY created_at ASC LIMIT 100");
    let applied = 0, failed = 0;
    for (const row of pending) {
      const r = await applyInternalLinkSuggestion(row.id);
      if (r.ok) applied++; else failed++;
    }
    res.redirect('/reports/internal-links?message=' + encodeURIComponent(`Applied ${applied} link${applied === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`));
  } catch (e) { next(e); }
});

app.post('/reports/internal-links/rescan', async (req, res, next) => {
  try {
    // Rescan all published articles as potential targets. This backfills suggestions
    // for articles that were published before the recommender existed.
    const targets = await q("SELECT id, title, slug, primary_keyword, published_url FROM articles WHERE status='published' ORDER BY published_at DESC LIMIT 300");
    let totalCreated = 0;
    for (const t of targets) {
      try { totalCreated += await findInternalLinkOpportunities(t); } catch (e) { /* skip individual failures */ }
    }
    res.redirect('/reports/internal-links?message=' + encodeURIComponent(`Rescan complete — ${totalCreated} new suggestion${totalCreated === 1 ? '' : 's'} found across ${targets.length} published articles`));
  } catch (e) { next(e); }
});

// ── USER MANAGEMENT (admin only) ──────────────────────────────────────────
app.get('/admin/users', async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== 'admin') return res.status(403).render('error', { message: 'Admin access required', currentPath: '' });
    const users = await q('SELECT id,username,email,role,created_at FROM auth_users ORDER BY id ASC');
    const msg = req.query.msg ? String(req.query.msg) : '';
    let rows = users.map(u => {
      const created = new Date(u.created_at).toLocaleDateString();
      const roleStyle = u.role === 'admin' ? 'background:rgba(124,58,237,.2)' : 'background:rgba(255,255,255,.07)';
      const deleteMsg = 'Delete user ' + u.username + '?';
      const deleteBtn = u.username !== 'admin'
        ? '<form method="post" action="/admin/users/' + u.id + '/delete" onsubmit="return confirm(this.dataset.msg)" data-msg="' + deleteMsg + '"><button class="mini danger">Delete</button></form>'
        : '<span style="font-size:.72rem;color:var(--muted)">Protected</span>';
      return '<tr style="border-bottom:1px solid rgba(255,255,255,.05)">'
        + '<td style="padding:.4rem .5rem"><strong>' + u.username + '</strong></td>'
        + '<td style="padding:.4rem .5rem;color:var(--muted)">' + (u.email || '—') + '</td>'
        + '<td style="padding:.4rem .5rem"><span style="padding:2px 8px;border-radius:999px;font-size:.72rem;' + roleStyle + '">' + u.role + '</span></td>'
        + '<td style="padding:.4rem .5rem;color:var(--muted);font-size:.75rem">' + created + '</td>'
        + '<td style="padding:.4rem .5rem">' + deleteBtn + '</td></tr>';
    }).join('');
    const msgHtml = msg ? '<div class="notice-good">' + msg + '</div>' : '';
    res.send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>User Management - NativPost SEO</title><link rel="stylesheet" href="/static/styles.css"></head><body><div class="app">'
      + '<aside class="sidebar"><div class="brand"><div class="logo">NP</div><div><strong>NativPost SEO</strong><span>Admin</span></div></div>'
      + '<nav><div class="nav-group-label">Navigation</div><a href="/">Dashboard</a><a href="/admin/users" class="active">User Management</a></nav>'
      + '<div class="sidebar-footer"><a href="/auth/logout" class="sidebar-logout">Sign out</a></div></aside>'
      + '<main class="main"><section class="hero"><div><p class="eyebrow">Administration</p><h1>User Management</h1>'
      + '<p>Manage who can access the SEO Command Center. Only admin users can create or delete accounts.</p></div></section>'
      + msgHtml
      + '<section class="card"><h2>Add new user</h2>'
      + '<form class="stack" method="post" action="/admin/users/create">'
      + '<div class="grid two" style="gap:10px">'
      + '<label>Username<input name="username" required></label>'
      + '<label>Email (for password reset)<input type="email" name="email"></label>'
      + '<label>Password (8+ chars)<input type="password" name="password" required minlength="8"></label>'
      + '<label>Role<select name="role"><option value="user">User</option><option value="admin">Admin</option></select></label>'
      + '</div><button class="btn primary" style="width:auto">Create user</button></form></section>'
      + '<section class="card"><h2>All users (' + users.length + ')</h2>'
      + '<table style="width:100%;border-collapse:collapse;font-size:.85rem">'
      + '<thead><tr style="border-bottom:1px solid var(--line)">'
      + '<th style="padding:.4rem .5rem;text-align:left">Username</th>'
      + '<th style="padding:.4rem .5rem;text-align:left">Email</th>'
      + '<th style="padding:.4rem .5rem;text-align:left">Role</th>'
      + '<th style="padding:.4rem .5rem;text-align:left">Created</th>'
      + '<th style="padding:.4rem .5rem"></th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>'
      + '<p class="hint" style="margin-top:.75rem">Password reset: go to <a href="/auth/reset-password">/auth/reset-password</a> and enter the username to generate a reset token.</p>'
      + '</section></main></div></body></html>');
  } catch (e) { next(e); }
});

app.post('/admin/users/create', async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { username, email, password, role } = req.body;
    if (!username || !password || password.length < 8) return res.redirect('/admin/users?msg=Username+and+password+(8%2B+chars)+required');
    const salt = crypto.randomBytes(32).toString('hex');
    const hash = await hashPassword(password, salt);
    await q('INSERT INTO auth_users (username,email,password_hash,salt,role) VALUES (?,?,?,?,?)', [username.trim(), email || null, hash, salt, role || 'user']);
    res.redirect('/admin/users?msg=User+' + encodeURIComponent(username) + '+created+successfully');
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.redirect('/admin/users?msg=Username+already+exists');
    next(e);
  }
});

app.post('/admin/users/:id/delete', async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const user = await one('SELECT username FROM auth_users WHERE id=?', [req.params.id]);
    if (!user) return res.redirect('/admin/users?msg=User+not+found');
    if (user.username === 'admin') return res.redirect('/admin/users?msg=Cannot+delete+the+primary+admin');
    await q('DELETE FROM auth_sessions WHERE user_id=?', [req.params.id]);
    await q('DELETE FROM auth_users WHERE id=? AND username != ?', [req.params.id, 'admin']);
    res.redirect('/admin/users?msg=User+deleted');
  } catch (e) { next(e); }
});


// ── LIVE GAMES ROUTES ─────────────────────────────────────────────────────
app.get('/admin/live-games', (req, res) => res.redirect('/keywords'));

app.post('/admin/live-games/refresh', (req, res) => res.redirect('/keywords'));

app.post('/admin/live-games/set', (req, res) => res.redirect('/keywords'));

app.post('/admin/live-games/:key/delete', (req, res) => res.redirect('/keywords'));

app.post('/content-studio/refresh-supported-games', (req, res) => res.redirect('/content-studio'));


// NativPost: game-facts admin routes removed (IGH game hosting feature).
app.get('/admin/game-facts', (req, res) => res.redirect('/keywords'));
app.post('/admin/game-facts/:key/update', (req, res) => res.redirect('/keywords'));

// ── v107 routes: API Balances, Game Radar, Backlink Prospects, Themes ──
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).render('error', { message: 'Admin access required', currentPath: '' });
  }
  next();
}

// API Balances — admin-only. Fetches live balance on demand, or serves cached.
app.get('/admin/api-balances', requireAdmin, async (req, res, next) => {
  try {
    const balances = await getCachedApiBalances();
    const msg = req.query.msg || '';
    res.render('api-balances', {
      currentPath: '/admin/api-balances',
      balances, msg,
      userTheme: res.locals.userTheme || 'np-purple',
      currentUser: res.locals.currentUser
    });
  } catch (e) { next(e); }
});
app.post('/admin/api-balances/refresh', requireAdmin, async (req, res, next) => {
  try {
    const svc = req.body.service || null;
    const results = await refreshApiBalances(svc);
    const summary = Object.entries(results).map(([k, v]) => `${k}:${v.status}`).join(', ');
    res.redirect('/admin/api-balances?msg=' + encodeURIComponent('Refreshed — ' + summary));
  } catch (e) { next(e); }
});

// Game Expansion Radar — admin-only manage page + refresh button
// NativPost: game-radar /keywords override removed — using the real keywords route defined above.
// NativPost: game-radar routes removed (IGH Steam expansion feature).
app.post('/admin/game-radar/refresh', requireAdmin, (req, res) => res.redirect('/keywords'));
app.post('/admin/game-radar/:id/dismiss', requireAdmin, (req, res) => res.redirect('/keywords'));
app.post('/admin/game-radar/:id/plan', requireAdmin, (req, res) => res.redirect('/keywords'));

// Backlink prospects — view + discover
app.get('/backlinks/prospects', async (req, res, next) => {
  try {
    const prospects = await q(
      'SELECT * FROM backlink_prospects WHERE status IN (?,?) ORDER BY prospect_score DESC LIMIT 300',
      ['new', 'reviewed']
    ).catch(() => []);
    res.render('backlink-prospects', {
      currentPath: '/backlinks/prospects',
      prospects,
      dfsMode: String(process.env.DFS_BACKLINKS_MODE || 'live'),
      msg: req.query.msg || '',
      userTheme: res.locals.userTheme || 'np-purple',
      currentUser: res.locals.currentUser
    });
  } catch (e) { next(e); }
});
app.post('/backlinks/prospects/discover', async (req, res, next) => {
  try {
    const result = await runLinkGapDiscovery({ maxCompetitors: 5 });
    res.redirect('/backlinks/prospects?msg=' + encodeURIComponent(`Link gap scan complete — ${result.saved} prospects saved from ${result.competitorHosts.length} competitors`));
  } catch (e) {
    res.redirect('/backlinks/prospects?msg=' + encodeURIComponent('Discovery failed: ' + (e.message || e)));
  }
});
app.post('/backlinks/prospects/:id/status', async (req, res, next) => {
  try {
    const allowed = ['new', 'reviewed', 'contacted', 'earned', 'rejected'];
    const s = allowed.includes(req.body.status) ? req.body.status : 'reviewed';
    await q('UPDATE backlink_prospects SET status=?, updated_at=NOW() WHERE id=?', [s, req.params.id]);
    res.redirect('/backlinks/prospects');
  } catch (e) { next(e); }
});

// Theme preference — per-user, any authenticated user can set their own
app.post('/preferences/theme', async (req, res, next) => {
  try {
    const theme = String(req.body.theme || '').trim();
    if (!VALID_THEMES.includes(theme)) {
      if (req.xhr || req.headers.accept?.includes('application/json')) return res.status(400).json({ error: 'Invalid theme' });
      return res.redirect((req.body.redirect || '/settings') + '?theme_error=1');
    }
    if (req.user) await setUserTheme(req.user.id, theme);
    // fetch() call from JS — just return 200, no redirect needed
    if (req.headers['content-type']?.includes('application/x-www-form-urlencoded') && !req.body.redirect) {
      return res.json({ ok: true });
    }
    res.redirect((req.body.redirect || '/settings') + '?theme_saved=1#appearance');
  } catch (e) { next(e); }
});

// Background refreshers — run on boot + on interval
function startBalanceRefresher() {
  const intervalMs = 15 * 60 * 1000; // 15 min
  async function tick() {
    try { await refreshApiBalances(); }
    catch (e) { console.error('[Balances] refresh failed:', e.message); }
  }
  // First tick 90s after boot, then every 15min
  setTimeout(tick, 90000);
  setInterval(tick, intervalMs);
  console.log('API balance refresher enabled (every 15 min).');
}
function startCompetitorRefresher() {
  // Re-crawl and re-audit all active competitors once per week.
  // This keeps competitor gap keywords and scores current without manual action.
  const intervalMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  async function tick() {
    try {
      const comps = await q('SELECT id, COALESCE(url, competitor_url) url FROM competitors WHERE active=1');
      if (!comps.length) return;
      console.log(`[Competitors] Weekly re-audit starting for ${comps.length} competitors...`);
      for (const c of comps) {
        try {
          if (!c.url) continue;
          const audit = await auditCompetitor(c.url);
          await saveCompetitorAudit(c.id, audit);
        } catch (e) { console.error(`[Competitors] Audit failed for ${c.url}:`, e.message); }
      }
      console.log(`[Competitors] Weekly re-audit complete.`);
    } catch (e) { console.error('[Competitors] Weekly refresh failed:', e.message); }
  }
  // First run 30 minutes after boot (avoid startup congestion), then every 7 days
  setTimeout(tick, 30 * 60 * 1000);
  setInterval(tick, intervalMs);
  console.log('Competitor weekly re-audit scheduler enabled.');
}

function startRadarRefresher() {
  // Game Expansion Radar runs once every 24 hours. Steam featured data barely
  // changes more often than that, and each run bounds Steam API calls to 40.
  const intervalMs = 24 * 60 * 60 * 1000;
  async function tick() {
    try {
      const stats = await refreshGameExpansionRadar();
      if (stats.added > 0) console.log(`[Radar] Daily scan: added ${stats.added} new game opportunity rows`);
    } catch (e) { console.error('[Radar] refresh failed:', e.message); }
  }
  setTimeout(tick, 10 * 60 * 1000); // first run 10 min after boot
  setInterval(tick, intervalMs);
  console.log('Game Expansion Radar refresher enabled (every 24h).');
}

app.use((req, res) => res.status(404).render('error', { currentPath: '', message: 'Page not found' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).render('error', { currentPath: '', message: err.message || 'Unexpected app error' }); });


async function syncContentfulArticlesToDB() {
  // Ensure all known published blog articles exist in local DB so the brief
  // and coverage detection work correctly. Includes articles published by Adaptify
  // directly to Contentful without going through this SEO tool.
  try {
    const siteId = (await one("SELECT id FROM sites WHERE active=1 LIMIT 1"))?.id || null;
    const baseUrl = 'https://nativpost.com/blog/';

    // Try Contentful CDA API first
    let cfSlugs = [];
    try {
      const space = process.env.CONTENTFUL_SPACE_ID;
      const token = process.env.CONTENTFUL_CDA_TOKEN;
      const ct = process.env.CONTENTFUL_BLOG_CONTENT_TYPE_ID || 'pageBlogPost';
      if (space && token) {
        // Use preview token as fallback since CDA token may have restricted access
        const tokens = [token, process.env.CONTENTFUL_PREVIEW_TOKEN].filter(Boolean);
        for (const t of tokens) {
          try {
            const resp = await axios.get(
              `https://cdn.contentful.com/spaces/${space}/environments/master/entries?content_type=${ct}&select=fields.title,fields.slug&limit=500&access_token=${t}`,
              { timeout: 10000 }
            );
            const items = resp.data?.items || [];
            if (items.length > 0) {
              for (const item of items) {
                const f = item.fields || {};
                const getVal = (v) => typeof v === 'object' && v !== null ? Object.values(v)[0] : v;
                const slug = getVal(f.slug);
                const title = getVal(f.title);
                if (slug) cfSlugs.push({ slug: String(slug), title: String(title || slug) });
              }
              console.log(`[ContentfulSync] Fetched ${cfSlugs.length} entries from Contentful API.`);
              break;
            }
          } catch (e) { /* try next token */ }
        }
      }
    } catch (e) { /* fall through to hardcoded list */ }

    // If API failed, use known published slugs as fallback
    if (cfSlugs.length === 0) {
      console.log('[ContentfulSync] API unavailable - using known article list.');
      cfSlugs = [
        { slug: 'icarus-modded-server-hosting', title: 'Icarus Modded Server Hosting' },
        { slug: 'affordable-v-rising-server-hosting', title: 'Affordable V Rising Server Hosting' },
        { slug: 'enshrouded-server-setup-guide', title: 'Enshrouded Server Setup Guide' },
        { slug: 'hytale-server-setup-guide', title: 'Hytale Server Setup Guide' },
        { slug: 'ddos-protection-for-game-servers', title: 'DDoS Protection for Game Servers' },
        { slug: 'how-to-buy-a-minecraft-java-server', title: 'How to Buy a Minecraft Java Server' },
      ];
    }

    let synced = 0;
    for (const { slug, title } of cfSlugs) {
      const cfUrl = `${baseUrl}${slug}`;
      const kwFromSlug = slug.toLowerCase().replace(/-/g, ' ').trim();
      const existing = await one("SELECT id FROM articles WHERE slug=? OR published_url=?", [slug, cfUrl]).catch(() => null);
      if (!existing) {
        await execSafe(
          `INSERT INTO articles (site_id, title, primary_keyword, slug, status, published_url, published_at, body, created_at, updated_at) VALUES (?, ?, ?, ?, 'published', ?, NOW(), '', NOW(), NOW())`,
          [siteId, title, kwFromSlug, slug, cfUrl]
        );
        synced++;
      }
    }
    if (synced > 0) console.log(`[ContentfulSync] Imported ${synced} Contentful articles to local DB.`);
    else console.log(`[ContentfulSync] DB already up to date.`);
  } catch (e) {
    console.error('[ContentfulSync] Failed:', e.message);
  }
}

ensureSchema().then(() => app.listen(PORT, '0.0.0.0', () => { console.log(`NativPost SEO Tool running on 0.0.0.0:${PORT}`); startAutoPublisher(); startWeeklyGSCSync(); startBalanceRefresher(); startRadarRefresher(); startCompetitorRefresher(); startDailyBriefRefresher(); setTimeout(syncContentfulArticlesToDB, 30000); })).catch(err => { console.error('Failed to start SEO tool:', err); process.exit(1); });