require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const bootstrapSecrets = new Map();
function getBootstrapSecret(envKey, label, length = 18) {
  if (process.env[envKey]) return process.env[envKey];
  if (!bootstrapSecrets.has(envKey)) {
    const generated = crypto.randomBytes(length).toString('base64url');
    console.warn(`[security] ${label} not set. Generated one-time bootstrap value for this process.`);
    bootstrapSecrets.set(envKey, generated);
  }
  return bootstrapSecrets.get(envKey);
}
function normalizeCloseDate(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}
function isMarketBettingClosed(market, now = Date.now()) {
  if (!market) return true;
  if (market.status !== 'open') return true;
  if (!market.close_date) return false;
  const closeAt = Date.parse(market.close_date);
  return !Number.isNaN(closeAt) && closeAt <= now;
}

const JWT_SECRET = getBootstrapSecret('JWT_SECRET', 'JWT_SECRET');
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const POPUP_TAB_PASSWORD_KEY = 'popup_tab_password_hash';
const DEFAULT_POPUP_TAB_PASSWORD = getBootstrapSecret('POPUP_TAB_PASSWORD', 'POPUP_TAB_PASSWORD');
const POPUP_UNLOCK_TTL_MS = 1000 * 60 * 45;
const popupAdminUnlocks = new Map();
const UPLOAD_ROOT = path.join(__dirname, 'public', 'uploads', 'popups');
const assistanceStreams = new Map();
const LIVE_CACHE_TTL_MS = 15000;
let liveCache = { data: null, expiresAt: 0 };
const LEADERBOARD_CACHE_TTL_MS = 15000;
let leaderboardCache = { data: null, expiresAt: 0 };
const STORE_CACHE_TTL_MS = 60000;
let storeCache = { data: null, expiresAt: 0 };
const MESSAGES_USERS_CACHE_TTL_MS = 60000;
let messageUsersCache = { data: null, expiresAt: 0 };
const CASINO_BETS_CACHE_TTL_MS = 8000;
const casinoBetsCache = new Map();
const BETS_MINE_CACHE_TTL_MS = 10000;
const betsMineCache = new Map();
let betsSnapshotVersion = 0;
const CASINO_ENABLED = false;
const NOTIFICATIONS_CACHE_TTL_MS = 15000;
const notificationsListCache = new Map();
const notificationsUnreadCache = new Map();
const notificationVersions = new Map();
const POPUP_PENDING_CACHE_TTL_MS = 5000;
const popupPendingCache = new Map();
const popupVersions = new Map();
const ADMIN_LIST_CACHE_TTL_MS = 10000;
const adminTransactionsCache = new Map();
const adminCasinoCache = new Map();
const EXCHANGE_INTEREST_PERCENT = 5;
const EXCHANGE_MIN_TERM_DAYS = 1;
const EXCHANGE_MAX_TERM_DAYS = 30;
const EXCHANGE_MIN_ACCOUNT_AGE_MS = 1000 * 60 * 60 * 24 * 10;

app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use((req,res,next)=>{
  res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Content-Security-Policy',"frame-ancestors 'self'");
  next();
});
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;
const blackjackGames = new Map();
const minesGames = new Map();
const MINES_STALE_MS = 1000 * 60 * 20;

function attachDbHelpers(client){
  client.run = async (sql, args=[]) => { await client.execute({ sql, args }); };
  client.get = async (sql, args=[]) => { const r = await client.execute({ sql, args }); return r.rows[0] || null; };
  client.all = async (sql, args=[]) => { const r = await client.execute({ sql, args }); return r.rows; };
  client.exec = async (sql) => { for (const s of sql.split(';').map(s=>s.trim()).filter(Boolean)) await client.execute(s); };
  return client;
}

function isBlockedDbError(error){
  const text=String(error?.message||error?.cause?.message||'');
  return error?.code==='BLOCKED' || text.includes('SQL read operations are forbidden') || text.includes('Operation was blocked');
}
function isDbConnectionFallbackError(error){
  const text=String(error?.message||error?.cause?.message||'');
  return ['ENOTFOUND','ECONNREFUSED','ECONNRESET','ETIMEDOUT'].includes(error?.code)
    || text.includes('ENOTFOUND')
    || text.includes('ECONNREFUSED')
    || text.includes('ECONNRESET')
    || text.includes('ETIMEDOUT')
    || text.includes('fetch failed');
}
function toSafeNumber(value, fallback=0){
  if(value===null || value===undefined || value==='') return fallback;
  if(typeof value==='number') return Number.isFinite(value) ? value : fallback;
  if(typeof value==='bigint'){
    const max=BigInt(Number.MAX_SAFE_INTEGER);
    const min=BigInt(Number.MIN_SAFE_INTEGER);
    if(value>max) return Number.MAX_SAFE_INTEGER;
    if(value<min) return Number.MIN_SAFE_INTEGER;
    return Number(value);
  }
  const num=Number(value);
  if(!Number.isFinite(num)) return fallback;
  if(num>Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  if(num<Number.MIN_SAFE_INTEGER) return Number.MIN_SAFE_INTEGER;
  return num;
}
function withSafeCredits(row){
  if(!row) return row;
  if(Object.prototype.hasOwnProperty.call(row,'credits_text')){
    const { credits_text, ...rest } = row;
    return { ...rest, credits: toSafeNumber(credits_text, 0) };
  }
  return { ...row, credits: toSafeNumber(row.credits, 0) };
}
function getFreshCache(entry){
  return entry?.data && entry.expiresAt > Date.now() ? entry.data : null;
}
function setCacheValue(target, data, ttlMs){
  target.data = data;
  target.expiresAt = Date.now() + ttlMs;
  return data;
}
function invalidateCasinoBetsCache(userId){
  if(!userId) return;
  casinoBetsCache.delete(userId);
  adminCasinoCache.clear();
}
function bumpBetsSnapshotVersion(){
  betsSnapshotVersion++;
}
function invalidateBetsMineCache(userId){
  if(!userId) return;
  betsMineCache.delete(userId);
}
function getNotificationVersion(userId){
  return notificationVersions.get(userId) || 0;
}
function bumpNotificationVersion(userId){
  if(!userId) return;
  const next = getNotificationVersion(userId) + 1;
  notificationVersions.set(userId, next);
  notificationsListCache.delete(userId);
  notificationsUnreadCache.delete(userId);
}
function getPopupVersion(userId){
  return popupVersions.get(userId) || 0;
}
function bumpPopupVersion(userId){
  if(!userId) return;
  popupVersions.set(userId, getPopupVersion(userId) + 1);
  popupPendingCache.delete(userId);
}
function getAdminCacheKey(search, limit, offset){
  return JSON.stringify([search || '', limit || 0, offset || 0]);
}
function isDesktopCasinoRequest(req){
  return req.headers['x-jewshi-desktop']==='1';
}
function requireDesktopCasinoAccess(req,res,next){
  if(!CASINO_ENABLED) return res.status(404).json({error:'Casino is currently unavailable'});
  if(isDesktopCasinoRequest(req)) return next();
  return res.status(403).json({error:'Casino is only available in the Jewshi desktop app'});
}

async function initDB() {
  const localUrl = 'file:sclshi.db';
  const useRemoteDb = process.env.NODE_ENV === 'production' || process.env.USE_REMOTE_DB === '1';
  const primaryUrl = useRemoteDb
    ? (process.env.TURSO_DATABASE_URL || localUrl)
    : localUrl;
  let activeUrl = primaryUrl;
  db = attachDbHelpers(createClient({
    url: activeUrl,
    authToken: activeUrl===localUrl ? undefined : process.env.TURSO_AUTH_TOKEN,
  }));

  const bootstrap = async ()=>db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT NOT NULL,
      role TEXT DEFAULT 'student', credits INTEGER DEFAULT 200, grade TEXT DEFAULT '',
      school TEXT DEFAULT 'SCLSHI',
      email_verified INTEGER DEFAULT 1, on_email_list INTEGER DEFAULT 0, bio TEXT DEFAULT '',
      popup_access INTEGER DEFAULT 0,
      assistance_access INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      used INTEGER DEFAULT 0, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY, question TEXT NOT NULL, category TEXT,
      status TEXT DEFAULT 'open', close_date TEXT,
      yes_shares REAL DEFAULT 0, no_shares REAL DEFAULT 0,
      b_param REAL DEFAULT 100, pool INTEGER DEFAULT 0, created_at INTEGER,
      market_type TEXT DEFAULT 'binary', line REAL DEFAULT NULL,
      over_shares REAL DEFAULT 0, under_shares REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS bets (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, market_id TEXT NOT NULL,
      side TEXT NOT NULL, amount REAL NOT NULL, shares REAL NOT NULL,
      status TEXT DEFAULT 'active', payout REAL DEFAULT 0, timestamp INTEGER
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount REAL NOT NULL,
      type TEXT NOT NULL, reference_id TEXT, description TEXT, timestamp INTEGER
    );
    CREATE TABLE IF NOT EXISTS store_items (
      id TEXT PRIMARY KEY, name TEXT, icon TEXT, cost INTEGER, description TEXT
    );
    CREATE TABLE IF NOT EXISTS redemptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, item_id TEXT NOT NULL,
      cost INTEGER, timestamp INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS stripe_sessions (
      session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      credits INTEGER NOT NULL, fulfilled INTEGER DEFAULT 0, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
      text TEXT NOT NULL, is_read INTEGER DEFAULT 0, timestamp INTEGER
    );
    CREATE TABLE IF NOT EXISTS suggestions (
      id TEXT PRIMARY KEY, sender_id TEXT NOT NULL,
      text TEXT NOT NULL, timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      link TEXT DEFAULT '',
      is_read INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, caption TEXT NOT NULL,
      image TEXT DEFAULT NULL, timestamp INTEGER, repost_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS post_likes (
      id TEXT PRIMARY KEY, post_id TEXT NOT NULL, user_id TEXT NOT NULL, timestamp INTEGER
    );
    CREATE TABLE IF NOT EXISTS post_reposts (
      id TEXT PRIMARY KEY, post_id TEXT NOT NULL, user_id TEXT NOT NULL,
      caption TEXT DEFAULT '', timestamp INTEGER
    )

    ;CREATE TABLE IF NOT EXISTS pending_registrations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
      password TEXT NOT NULL, grade TEXT DEFAULT '', school TEXT DEFAULT 'SCLSHI',
      code TEXT NOT NULL, expires_at INTEGER NOT NULL,
      created_at INTEGER
    )
    ;CREATE TABLE IF NOT EXISTS spin_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      credits_won INTEGER NOT NULL,
      timestamp INTEGER NOT NULL
    )
    ;CREATE TABLE IF NOT EXISTS casino_bets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      game TEXT NOT NULL,
      bet_amount INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      payout INTEGER DEFAULT 0,
      profit INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL
    )
    ;CREATE TABLE IF NOT EXISTS online_matches (
      id TEXT PRIMARY KEY,
      game_type TEXT NOT NULL,
      host_id TEXT NOT NULL,
      guest_id TEXT DEFAULT NULL,
      status TEXT DEFAULT 'open',
      wager INTEGER DEFAULT 0,
      state TEXT NOT NULL,
      winner_id TEXT DEFAULT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
    ;CREATE TABLE IF NOT EXISTS popups (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      title TEXT DEFAULT '',
      message TEXT DEFAULT '',
      alert_text TEXT DEFAULT '',
      media_type TEXT DEFAULT NULL,
      media_url TEXT DEFAULT NULL,
      audio_url TEXT DEFAULT NULL,
      rave_enabled INTEGER DEFAULT 0,
      alert_enabled INTEGER DEFAULT 0,
      closeout_enabled INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      shown_at INTEGER DEFAULT NULL,
      stopped_at INTEGER DEFAULT NULL
    )
    ;CREATE TABLE IF NOT EXISTS popup_polls (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL,
      closed_at INTEGER DEFAULT NULL
    )
    ;CREATE TABLE IF NOT EXISTS popup_poll_recipients (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
    ;CREATE TABLE IF NOT EXISTS popup_poll_votes (
      id TEXT PRIMARY KEY,
      poll_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
    ;CREATE TABLE IF NOT EXISTS exchange_requests (
      id TEXT PRIMARY KEY,
      borrower_id TEXT NOT NULL,
      lender_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      interest_percent INTEGER NOT NULL DEFAULT 5,
      term_days INTEGER NOT NULL,
      note TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      decided_at INTEGER DEFAULT NULL,
      decided_by TEXT DEFAULT NULL,
      loan_id TEXT DEFAULT NULL
    )
    ;CREATE TABLE IF NOT EXISTS exchange_loans (
      id TEXT PRIMARY KEY,
      request_id TEXT DEFAULT NULL,
      borrower_id TEXT NOT NULL,
      lender_id TEXT NOT NULL,
      principal INTEGER NOT NULL,
      repayment_amount INTEGER NOT NULL,
      interest_percent INTEGER NOT NULL DEFAULT 5,
      repaid_amount INTEGER NOT NULL DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at INTEGER NOT NULL,
      approved_at INTEGER NOT NULL,
      due_at INTEGER NOT NULL,
      overdue_started_at INTEGER DEFAULT NULL,
      paid_at INTEGER DEFAULT NULL,
      updated_at INTEGER NOT NULL
    )
    ;CREATE TABLE IF NOT EXISTS exchange_repayments (
      id TEXT PRIMARY KEY,
      loan_id TEXT NOT NULL,
      borrower_id TEXT NOT NULL,
      lender_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      mode TEXT DEFAULT 'manual',
      created_at INTEGER NOT NULL
    )
    ;CREATE TABLE IF NOT EXISTS assistance_contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      helper_user_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      approved_at INTEGER DEFAULT NULL
    )
    ;CREATE TABLE IF NOT EXISTS assistance_sessions (
      id TEXT PRIMARY KEY,
      senior_user_id TEXT NOT NULL,
      helper_user_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      mode TEXT DEFAULT 'guide',
      guided_mode INTEGER DEFAULT 1,
      control_enabled INTEGER DEFAULT 0,
      voice_enabled INTEGER DEFAULT 1,
      recording_enabled INTEGER DEFAULT 1,
      created_at INTEGER NOT NULL,
      started_at INTEGER DEFAULT NULL,
      ended_at INTEGER DEFAULT NULL,
      stop_reason TEXT DEFAULT ''
    )
    ;CREATE TABLE IF NOT EXISTS assistance_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL
    )
    ;CREATE TABLE IF NOT EXISTS lucky_streaks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      boost_percent INTEGER NOT NULL DEFAULT 15,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )

  `);

  const finishBootstrap = async ()=>{
    await db.run("ALTER TABLE posts ADD COLUMN image TEXT DEFAULT NULL").catch(()=>{});
    await db.run("ALTER TABLE users ADD COLUMN popup_access INTEGER DEFAULT 0").catch(()=>{});
    await db.run("ALTER TABLE users ADD COLUMN assistance_access INTEGER DEFAULT 0").catch(()=>{});
    await db.run("ALTER TABLE users ADD COLUMN created_at INTEGER DEFAULT 0").catch(()=>{});
    await db.run("ALTER TABLE users ADD COLUMN school TEXT DEFAULT 'SCLSHI'").catch(()=>{});
    await db.run("ALTER TABLE pending_registrations ADD COLUMN school TEXT DEFAULT 'SCLSHI'").catch(()=>{});
    await db.run("ALTER TABLE popups ADD COLUMN rave_enabled INTEGER DEFAULT 0").catch(()=>{});
    await db.run("ALTER TABLE popups ADD COLUMN alert_enabled INTEGER DEFAULT 0").catch(()=>{});
    await db.run("ALTER TABLE popups ADD COLUMN alert_text TEXT DEFAULT ''").catch(()=>{});
    await db.run("ALTER TABLE popups ADD COLUMN closeout_enabled INTEGER DEFAULT 0").catch(()=>{});
    await db.run("UPDATE users SET created_at=0 WHERE created_at IS NULL").catch(()=>{});
    await db.run("UPDATE users SET school='SCLSHI' WHERE school IS NULL OR TRIM(school)=''").catch(()=>{});
    await db.run("UPDATE pending_registrations SET school='SCLSHI' WHERE school IS NULL OR TRIM(school)=''").catch(()=>{});
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_markets_status_created_at ON markets(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bets_user_status_timestamp ON bets(user_id, status, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_bets_status_timestamp ON bets(status, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_user_timestamp ON transactions(user_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_redemptions_user_timestamp ON redemptions(user_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_recipient_read_timestamp ON messages(recipient_id, is_read, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_sender_recipient_timestamp ON messages(sender_id, recipient_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_recipient_sender_timestamp ON messages(recipient_id, sender_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at ON notifications(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created_at ON notifications(user_id, is_read, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_timestamp ON posts(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_user_timestamp ON posts(user_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_post_likes_post_id ON post_likes(post_id);
      CREATE INDEX IF NOT EXISTS idx_post_likes_user_post ON post_likes(user_id, post_id);
      CREATE INDEX IF NOT EXISTS idx_casino_bets_user_timestamp ON casino_bets(user_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_casino_bets_game_timestamp ON casino_bets(game, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_popups_recipient_status_created_at ON popups(recipient_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_popups_status_created_at ON popups(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_spin_log_user_timestamp ON spin_log(user_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_assistance_contacts_user_status ON assistance_contacts(user_id, status);
      CREATE INDEX IF NOT EXISTS idx_assistance_contacts_helper_status ON assistance_contacts(helper_user_id, status);
      CREATE INDEX IF NOT EXISTS idx_assistance_sessions_senior_status_created_at ON assistance_sessions(senior_user_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assistance_sessions_helper_status_created_at ON assistance_sessions(helper_user_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_assistance_events_session_created_at ON assistance_events(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_lucky_streaks_user_expires_at ON lucky_streaks(user_id, expires_at DESC);
      CREATE INDEX IF NOT EXISTS idx_exchange_requests_status_created_at ON exchange_requests(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_exchange_requests_borrower_status ON exchange_requests(borrower_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_exchange_requests_lender_status ON exchange_requests(lender_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_exchange_loans_borrower_status_due_at ON exchange_loans(borrower_id, status, due_at ASC);
      CREATE INDEX IF NOT EXISTS idx_exchange_loans_lender_status_due_at ON exchange_loans(lender_id, status, due_at ASC);
      CREATE INDEX IF NOT EXISTS idx_exchange_repayments_loan_created_at ON exchange_repayments(loan_id, created_at DESC);
    `);
    fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
    await ensureProtectedSettings();
    await seedIfEmpty();
  };

  try{
    await bootstrap();
    await finishBootstrap();
  }catch(error){
    if(activeUrl!==localUrl && (isBlockedDbError(error) || isDbConnectionFallbackError(error))){
      console.warn(`Primary database unavailable on ${activeUrl}. Falling back to ${localUrl}.`);
      activeUrl=localUrl;
      db = attachDbHelpers(createClient({ url: localUrl }));
      await bootstrap();
      await finishBootstrap();
      return;
    }
    throw error;
  }
}

app.use('/api/casino', authMiddleware, requireDesktopCasinoAccess);
app.use('/api/admin/casino', authMiddleware, adminOnly, requireDesktopCasinoAccess);
app.use('/api/matches', authMiddleware, requireDesktopCasinoAccess);
app.use('/api/spin', authMiddleware, requireDesktopCasinoAccess);

async function ensureProtectedSettings() {
  const popupPassword = await db.get('SELECT value FROM settings WHERE key=?',[POPUP_TAB_PASSWORD_KEY]);
  if (!popupPassword?.value) {
    const hash = await bcrypt.hash(DEFAULT_POPUP_TAB_PASSWORD, 10);
    await db.run('INSERT INTO settings (key,value) VALUES (?,?)',[POPUP_TAB_PASSWORD_KEY, hash]);
  }
}

async function seedIfEmpty() {
  const row = await db.get('SELECT COUNT(*) as c FROM users');
  if (row.c > 0) return;
  const defaultAdminPassword = process.env.INITIAL_ADMIN_PASSWORD || 'Ozb!041611';
  const defaultAccessPassword = getBootstrapSecret('INITIAL_ACCESS_PASSWORD', 'INITIAL_ACCESS_PASSWORD');
  const users = [
    { id:'ADMIN', name:'Sclshi Admin', email:'admin@sclshi.com', password:defaultAdminPassword, role:'admin', credits:0, grade:'', school:'SCLSHI' },
  ];
  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await db.run('INSERT INTO users (id,name,email,password,role,credits,grade,school,email_verified,on_email_list,created_at) VALUES (?,?,?,?,?,?,?,?,1,0,0)',
      [u.id,u.name,u.email,hash,u.role,u.credits,u.grade,u.school]);
  }
  const items = [
    ['s1','Campus Cafe Voucher','🥪',150,'Redeemable at your school cafe'],
    ['s2','School Spirit Tee','👕',400,'Official Schoolshi spirit wear'],
    ['s3','Homework Pass','📘',300,'One assignment extension pass'],
    ['s4','Smoothie Voucher','🥤',100,'A smoothie from the student cafe'],
  ];
  for (const [id,name,icon,cost,desc] of items)
    await db.run('INSERT INTO store_items (id,name,icon,cost,description) VALUES (?,?,?,?,?)',[id,name,icon,cost,desc]);
  await db.run(`INSERT INTO markets (id,question,category,status,close_date,yes_shares,no_shares,b_param,pool,created_at,market_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['m1','Will the home team win the district championship?','Sports','open','2026-06-01',0,0,100,0,Date.now(),'binary']);
  await db.run(`INSERT INTO markets (id,question,category,status,close_date,yes_shares,no_shares,b_param,pool,created_at,market_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['m2','Will the spring showcase open on time?','School','open','2026-05-15',0,0,100,0,Date.now(),'binary']);
  await db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('volunteer_rate','100')");
  await db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('access_password',?)",[defaultAccessPassword]);
  await db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('casino_dice_odds','100')");
  await db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('casino_plinko_odds','100')");
  await db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('casino_blackjack_odds','100')");
  await db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('casino_mines_odds','100')");
  await db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('casino_roulette_odds','100')");
  await db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('casino_coinflip_odds','100')");
  console.log('Database seeded.');
}

async function appendToSheet(name, email, grade, school) {
  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_SHEET_ID) return;
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:E',
      valueInputOption: 'RAW',
      requestBody: { values: [[name, email, grade, school || 'SCLSHI', new Date().toLocaleString()]] },
    });
  } catch(e) { console.error('[Sheets] Error:', e.message); }
}

// Send email via Apps Script
async function sendViaAppsScript(type, payload) {
  try {
    if (!process.env.APPS_SCRIPT_URL) { console.log('[Email] APPS_SCRIPT_URL not set, skipping'); return 0; }
    const fetchImpl = globalThis.fetch
      ? globalThis.fetch.bind(globalThis)
      : (...args) => import('node-fetch').then(({default:f})=>f(...args));
    const res = await fetchImpl(process.env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...payload }),
    });
    if (!res.ok) {
      const text = await res.text().catch(()=>'');
      throw new Error(`Apps Script request failed (${res.status})${text ? `: ${text.slice(0,200)}` : ''}`);
    }
    const data = await res.json();
    return data.sent || 0;
  } catch(e) { console.error('[Email] Error:', e.message); return 0; }
}

function generateId(p='') { return p+Date.now()+Math.random().toString(36).slice(2,6); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function clampNumber(value, min, max){
  return Math.min(max, Math.max(min, value));
}
function issuePopupUnlockToken(userId){
  const token = crypto.randomBytes(24).toString('hex');
  popupAdminUnlocks.set(userId, { token, expiresAt: Date.now()+POPUP_UNLOCK_TTL_MS });
  return token;
}
async function hasPopupTabAccess(userId){
  if(userId==='ADMIN') return true;
  const user=await db.get('SELECT popup_access FROM users WHERE id=?',[userId]);
  return !!user?.popup_access;
}
async function hasAssistanceAccess(userId){
  if(userId==='ADMIN') return true;
  const user=await db.get('SELECT assistance_access FROM users WHERE id=?',[userId]);
  return !!user?.assistance_access;
}
function isAssistanceUserOnline(userId){
  return !!assistanceStreams.get(userId)?.size;
}
function isAssistanceSessionLive(session, now=Date.now()){
  if(!session) return false;
  const seniorOnline = isAssistanceUserOnline(session.senior_user_id);
  const helperOnline = isAssistanceUserOnline(session.helper_user_id);
  if(session.status==='active') return seniorOnline && helperOnline;
  if(session.status==='pending'){
    const recentPending = (now - Number(session.created_at||0)) < 10*60*1000;
    return recentPending && (seniorOnline || helperOnline);
  }
  return false;
}
async function cleanupStaleAssistanceSessions(whereClause='1=1', args=[]){
  const sessions = await db.all(
    `SELECT id, senior_user_id, helper_user_id, status, created_at
     FROM assistance_sessions
     WHERE status IN ('pending','active')
       AND (${whereClause})`,
    args
  );
  const now = Date.now();
  const staleSessions = sessions.filter(session=>!isAssistanceSessionLive(session, now));
  for(const session of staleSessions){
    await db.run(
      'UPDATE assistance_sessions SET status=?, ended_at=?, stop_reason=? WHERE id=? AND status IN (\'pending\',\'active\')',
      ['stopped', now, 'connection expired', session.id]
    );
  }
  const staleIds = new Set(staleSessions.map(session=>session.id));
  return sessions.filter(session=>!staleIds.has(session.id));
}
async function hasAssistanceSessionVisibility(userId){
  await cleanupStaleAssistanceSessions('senior_user_id=?', [userId]);
  if(await hasAssistanceAccess(userId)) return true;
  const session = await db.get(
    `SELECT id FROM assistance_sessions
     WHERE senior_user_id=? AND status IN ('pending','active')
     LIMIT 1`,
    [userId]
  );
  return !!session;
}
async function requirePopupAdminUnlocked(req,res,next){
  if(!(await hasPopupTabAccess(req.user.id))) return res.status(403).json({error:'You do not have Pop-up tab access'});
  const headerToken = req.headers['x-popup-unlock'];
  const session = popupAdminUnlocks.get(req.user.id);
  if(!headerToken || !session || session.token!==headerToken || session.expiresAt<Date.now()){
    popupAdminUnlocks.delete(req.user.id);
    return res.status(401).json({error:'Pop-up tab is locked. Unlock it again.'});
  }
  next();
}
function getFileExtension(name='', mime=''){
  const ext = path.extname(name || '').toLowerCase();
  if(ext && ext.length <= 8) return ext;
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/wav': '.wav',
  };
  return map[mime] || '';
}
function saveDataUrlToFile(dataUrl, originalName, allowedKinds){
  if(!dataUrl) return null;
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if(!match) throw new Error('Invalid file upload');
  const mime = match[1].toLowerCase();
  const kind = mime.split('/')[0];
  if(!allowedKinds.includes(kind) && !allowedKinds.includes(mime)) throw new Error('Unsupported file type');
  const buffer = Buffer.from(match[2], 'base64');
  const maxBytes = kind==='audio' ? 6 * 1024 * 1024 : 18 * 1024 * 1024;
  if(buffer.length > maxBytes) throw new Error(`${kind==='audio'?'Audio':'Media'} file is too large`);
  const ext = getFileExtension(originalName, mime);
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_ROOT, filename), buffer);
  return `/uploads/popups/${filename}`;
}
function shuffle(arr){
  const copy=[...arr];
  for(let i=copy.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [copy[i],copy[j]]=[copy[j],copy[i]];
  }
  return copy;
}
function makeDeck(){
  const suits=['♠','♥','♦','♣'];
  const vals=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  return shuffle(suits.flatMap(s=>vals.map(v=>({v,s}))));
}
function cardPoints(card){
  if(card.v==='A') return 11;
  if(['J','Q','K'].includes(card.v)) return 10;
  return parseInt(card.v,10);
}
function handTotal(cards){
  let total=0, aces=0;
  for(const card of cards){
    total+=cardPoints(card);
    if(card.v==='A') aces++;
  }
  while(total>21 && aces>0){ total-=10; aces--; }
  return total;
}
function isBlackjack(cards){ return cards.length===2 && handTotal(cards)===21; }
function canSplitHand(hand){
  if(hand.length!==2) return false;
  return cardPoints(hand[0])===cardPoints(hand[1]);
}
function getActiveBlackjackGame(userId){
  const game=blackjackGames.get(userId);
  if(!game) return null;
  if(game.done){
    blackjackGames.delete(userId);
    return null;
  }
  return game;
}
function getVisibleBlackjackState(game){
  return {
    dealerCards: game.done ? game.dealerCards : [game.dealerCards[0], {v:'?',s:'?'}],
    playerHands: game.playerHands,
    activeHand: game.activeHand,
    results: game.results,
    done: game.done,
    bets: game.bets,
  };
}
function getCurrentHand(game){ return game.playerHands[game.activeHand]; }
function getActiveMinesGame(userId){
  const game=minesGames.get(userId);
  if(!game) return null;
  const lastTouched=Number(game.lastActionAt || game.startedAt || 0);
  if(game.status!=='active' || (lastTouched && Date.now()-lastTouched > MINES_STALE_MS)){
    minesGames.delete(userId);
    return null;
  }
  return game;
}
function parseMatchState(raw){
  try{ return JSON.parse(raw||'{}'); }catch{ return {}; }
}
function buildDeck52(){
  const suits=['S','H','D','C'];
  const vals=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  return shuffle(suits.flatMap(s=>vals.map(v=>({v,s}))));
}
function cardRankValue(v){
  if(v==='A') return 14;
  if(v==='K') return 13;
  if(v==='Q') return 12;
  if(v==='J') return 11;
  return parseInt(v,10);
}
function sortDesc(nums){ return [...nums].sort((a,b)=>b-a); }
function evaluatePokerHand(hand){
  const ranks=sortDesc(hand.map(card=>cardRankValue(card.v)));
  const counts={};
  hand.forEach(card=>{ counts[card.v]=(counts[card.v]||0)+1; });
  const grouped=Object.entries(counts)
    .map(([v,count])=>({ value:cardRankValue(v), count }))
    .sort((a,b)=>b.count-a.count||b.value-a.value);
  const flush=hand.every(card=>card.s===hand[0].s);
  const unique=[...new Set(ranks)].sort((a,b)=>a-b);
  let straight=false;
  let straightHigh=Math.max(...ranks);
  if(unique.length===5){
    if(unique[4]-unique[0]===4) straight=true;
    else if(JSON.stringify(unique)===JSON.stringify([2,3,4,5,14])){ straight=true; straightHigh=5; }
  }
  if(straight&&flush) return { score:[8,straightHigh], label:'Straight Flush' };
  if(grouped[0].count===4) return { score:[7,grouped[0].value,grouped[1].value], label:'Four of a Kind' };
  if(grouped[0].count===3&&grouped[1].count===2) return { score:[6,grouped[0].value,grouped[1].value], label:'Full House' };
  if(flush) return { score:[5,...ranks], label:'Flush' };
  if(straight) return { score:[4,straightHigh], label:'Straight' };
  if(grouped[0].count===3) return { score:[3,grouped[0].value,...grouped.slice(1).map(g=>g.value)], label:'Three of a Kind' };
  if(grouped[0].count===2&&grouped[1].count===2){
    const highPair=Math.max(grouped[0].value, grouped[1].value);
    const lowPair=Math.min(grouped[0].value, grouped[1].value);
    return { score:[2,highPair,lowPair,grouped[2].value], label:'Two Pair' };
  }
  if(grouped[0].count===2) return { score:[1,grouped[0].value,...grouped.slice(1).map(g=>g.value).sort((a,b)=>b-a)], label:'Pair' };
  return { score:[0,...ranks], label:'High Card' };
}
function compareScoreArrays(a,b){
  const len=Math.max(a.length,b.length);
  for(let i=0;i<len;i++){
    const av=a[i]||0, bv=b[i]||0;
    if(av>bv) return 1;
    if(av<bv) return -1;
  }
  return 0;
}
function makeOnlineDreidelState(hostId, guestId){
  return {
    players:[hostId, guestId],
    tokens:{ [hostId]:7, [guestId]:7 },
    pot:2,
    turnUserId:hostId,
    log:['Both players anted 1 token to start the pot.'],
    lastSpin:null,
    phase:'active',
  };
}
function refillDreidelPot(state){
  state.players.forEach(userId=>{
    if((state.tokens[userId]||0)>0){
      state.tokens[userId]-=1;
      state.pot+=1;
    }
  });
}
function applyDreidelSpin(state, userId, spin){
  if(state.turnUserId!==userId) throw new Error('It is not your turn');
  const name = {N:'Nun',G:'Gimel',H:'Hey',S:'Shin'}[spin] || spin;
  if(spin==='G'){
    state.tokens[userId]=(state.tokens[userId]||0)+state.pot;
    state.pot=0;
    refillDreidelPot(state);
  }else if(spin==='H'){
    const gain=Math.max(1,Math.ceil(state.pot/2));
    const actual=Math.min(gain,state.pot);
    state.tokens[userId]=(state.tokens[userId]||0)+actual;
    state.pot-=actual;
  }else if(spin==='S'){
    if((state.tokens[userId]||0)>0){
      state.tokens[userId]-=1;
      state.pot+=1;
    }
  }
  state.lastSpin={userId,spin,name};
  state.log.unshift(`${userId} spun ${name}.`);
  const opponent=state.players.find(id=>id!==userId);
  const totalTokens=(state.tokens[userId]||0)+(state.tokens[opponent]||0)+state.pot;
  if((state.tokens[userId]||0)===totalTokens){
    state.phase='finished';
    state.winnerId=userId;
  }else if((state.tokens[opponent]||0)===totalTokens){
    state.phase='finished';
    state.winnerId=opponent;
  }else{
    state.turnUserId=opponent;
  }
  return state;
}
function makeOnlinePokerState(hostId, guestId){
  const deck=buildDeck52();
  return {
    players:[hostId, guestId],
    phase:'draw',
    deck,
    hands:{
      [hostId]:deck.splice(0,5),
      [guestId]:deck.splice(0,5),
    },
    drawsSubmitted:{ [hostId]:false, [guestId]:false },
    revealed:false,
    log:['Cards dealt. Each player may discard up to 3 cards once.'],
  };
}
function applyPokerDraw(state, userId, discardIndexes=[]){
  if(state.phase!=='draw') throw new Error('This poker hand is already resolved');
  if(state.drawsSubmitted[userId]) throw new Error('You already submitted your draw');
  const indexes=[...new Set((Array.isArray(discardIndexes)?discardIndexes:[]).map(Number).filter(n=>n>=0&&n<5))];
  if(indexes.length>3) throw new Error('You may discard at most 3 cards');
  const hand=[...state.hands[userId]];
  indexes.forEach(index=>{
    hand[index]=state.deck.shift();
  });
  state.hands[userId]=hand;
  state.drawsSubmitted[userId]=true;
  state.log.unshift(`${userId} ${indexes.length?`drew ${indexes.length} card${indexes.length===1?'':'s'}`:'stood pat'}.`);
  if(state.players.every(id=>state.drawsSubmitted[id])){
    const a=state.players[0], b=state.players[1];
    const evalA=evaluatePokerHand(state.hands[a]);
    const evalB=evaluatePokerHand(state.hands[b]);
    const cmp=compareScoreArrays(evalA.score, evalB.score);
    state.phase='finished';
    state.revealed=true;
    state.results={ [a]:evalA, [b]:evalB };
    state.winnerId=cmp===0?null:(cmp>0?a:b);
    state.log.unshift(cmp===0?`Showdown ended in a tie: ${evalA.label}.`:`${state.winnerId} won with ${cmp>0?evalA.label:evalB.label}.`);
  }
  return state;
}
async function fetchOnlineMatch(matchId){
  const match=await db.get(`SELECT m.*,
    host.name as host_name,
    guest.name as guest_name
    FROM online_matches m
    JOIN users host ON host.id=m.host_id
    LEFT JOIN users guest ON guest.id=m.guest_id
    WHERE m.id=?`, [matchId]);
  if(!match) return null;
  return { ...match, state:parseMatchState(match.state) };
}
async function saveOnlineMatch(matchId, state, extra={}){
  const fields=['state=?','updated_at=?'];
  const args=[JSON.stringify(state), Date.now()];
  Object.entries(extra).forEach(([key,val])=>{
    fields.push(`${key}=?`);
    args.push(val);
  });
  args.push(matchId);
  await db.run(`UPDATE online_matches SET ${fields.join(', ')} WHERE id=?`, args);
  return fetchOnlineMatch(matchId);
}
function sanitizeOnlineMatchForUser(match, userId){
  const state=JSON.parse(JSON.stringify(match.state||{}));
  if(match.game_type==='poker' && state.phase==='draw' && state.hands){
    Object.keys(state.hands).forEach(playerId=>{
      if(playerId!==userId){
        state.hands[playerId]=state.hands[playerId].map(()=>({v:'?',s:'?'}));
      }
    });
  }
  return { ...match, state };
}
async function settleOnlineMatch(match, winnerId){
  const wager=Number(match.wager||0);
  if(match.status==='finished') return fetchOnlineMatch(match.id);
  if(winnerId){
    await db.run('UPDATE users SET credits=credits+? WHERE id=?',[wager*2,winnerId]);
    await recordTx(winnerId,wager,'online_match_win',match.id,`${match.game_type} match won`);
    const loserId=match.host_id===winnerId?match.guest_id:match.host_id;
    if(loserId) await recordTx(loserId,-wager,'online_match_loss',match.id,`${match.game_type} match lost`);
    return saveOnlineMatch(match.id, match.state, { status:'finished', winner_id:winnerId });
  }
  const split=Math.floor(wager);
  await db.run('UPDATE users SET credits=credits+? WHERE id=?',[split,match.host_id]);
  if(match.guest_id) await db.run('UPDATE users SET credits=credits+? WHERE id=?',[split,match.guest_id]);
  await recordTx(match.host_id,0,'online_match_tie',match.id,`${match.game_type} match tied`);
  if(match.guest_id) await recordTx(match.guest_id,0,'online_match_tie',match.id,`${match.game_type} match tied`);
  return saveOnlineMatch(match.id, match.state, { status:'finished', winner_id:null });
}
async function finishBlackjackGame(userId){
  const game=blackjackGames.get(userId);
  if(!game) throw new Error('No active blackjack game');
  const { effective } = await getCasinoConfig(userId);
  const blackjackOdds = effective.blackjackOdds;
  const dealerStandThreshold = clampNumber(Math.round(17 + ((blackjackOdds - 100) / 50)), 16, 18);

  while(handTotal(game.dealerCards)<dealerStandThreshold){
    game.dealerCards.push(game.deck.pop());
  }

  const dealerTotal=handTotal(game.dealerCards);
  let totalPayout=0;
  let totalBet=0;
  const results=game.playerHands.map((hand,idx)=>{
    const bet=game.bets[idx];
    const total=handTotal(hand);
    totalBet+=bet;
    if(total>21) return 'bust';
    if(isBlackjack(hand)){
      const payout=Math.floor(bet*2.5);
      totalPayout+=payout;
      return 'blackjack';
    }
    if(dealerTotal>21 || total>dealerTotal){
      const payout=Math.floor(bet*2);
      totalPayout+=payout;
      return 'win';
    }
    if(total===dealerTotal){
      totalPayout+=bet;
      return 'push';
    }
    return 'loss';
  });

  if(totalPayout>0){
    await db.run('UPDATE users SET credits=credits+? WHERE id=?',[totalPayout,userId]);
  }

  const profit=totalPayout-totalBet;
  const outcome=profit>0?'win':profit<0?'loss':'push';
  const betId=generateId('cbj');
  await db.run('INSERT INTO casino_bets (id,user_id,game,bet_amount,outcome,payout,profit,timestamp) VALUES (?,?,?,?,?,?,?,?)',
    [betId,userId,'blackjack',totalBet,outcome,totalPayout,profit,Date.now()]);
  await recordTx(userId, profit, 'casino_blackjack', betId, `Blackjack: ${outcome} on ⬡${totalBet}`);
  invalidateCasinoBetsCache(userId);

  game.done=true;
  game.results=results;
  blackjackGames.delete(userId);
  const updated=await db.get('SELECT credits FROM users WHERE id=?',[userId]);
  return {
    state:getVisibleBlackjackState(game),
    result:results.includes('blackjack')?'blackjack':outcome,
    profit,
    dealerTotal,
    newBalance:Math.floor(updated.credits),
  };
}

function clampExchangeTermDays(value){
  return clampNumber(Math.floor(Number(value)||7), EXCHANGE_MIN_TERM_DAYS, EXCHANGE_MAX_TERM_DAYS);
}
function isExchangeEligibleUser(user){
  const createdAt=Number(user?.created_at||0);
  return createdAt===0 || createdAt <= Date.now() - EXCHANGE_MIN_ACCOUNT_AGE_MS;
}
function getExchangeRepaymentAmount(principal, interestPercent=EXCHANGE_INTEREST_PERCENT){
  const safePrincipal=Math.max(0, Math.floor(Number(principal)||0));
  return Math.round(safePrincipal * (1 + (Number(interestPercent)||0) / 100));
}
function clampShekelScore(value){
  return clampNumber(Math.round(Number(value)||650), 300, 850);
}
function getShekelBand(score){
  if(score>=780) return 'Trusted';
  if(score>=700) return 'Reliable';
  if(score>=620) return 'Watch';
  return 'Risk';
}
async function syncExchangeLoanStatuses(now=Date.now()){
  await db.run(
    "UPDATE exchange_loans SET status='paid', paid_at=COALESCE(paid_at, ?), updated_at=? WHERE status!='paid' AND repaid_amount>=repayment_amount",
    [now, now]
  );
  await db.run(
    "UPDATE exchange_loans SET status='overdue', overdue_started_at=COALESCE(overdue_started_at, ?), updated_at=? WHERE status='active' AND repaid_amount<repayment_amount AND due_at<=?",
    [now, now, now]
  );
}
async function insertExchangeTx(userId, amount, type, refId, desc){
  await db.run(
    'INSERT INTO transactions (id,user_id,amount,type,reference_id,description,timestamp) VALUES (?,?,?,?,?,?,?)',
    [generateId('tx'), userId, amount, type, refId, desc, Date.now()]
  );
  adminTransactionsCache.clear();
}
async function applyExchangeRepayment(loan, amount, mode='manual'){
  const repayment=Math.max(0, Math.floor(Number(amount)||0));
  if(!repayment) return null;
  const remaining=Math.max(0, Number(loan.repayment_amount||0) - Number(loan.repaid_amount||0));
  const applied=Math.min(remaining, repayment);
  if(!applied) return null;
  const now=Date.now();
  await db.run('UPDATE users SET credits=credits-? WHERE id=?',[applied,loan.borrower_id]);
  await db.run('UPDATE users SET credits=credits+? WHERE id=?',[applied,loan.lender_id]);
  const nextRepaid=Number(loan.repaid_amount||0) + applied;
  const paidInFull=nextRepaid >= Number(loan.repayment_amount||0);
  const overdue = !paidInFull && Number(loan.due_at||0) <= now;
  await db.run(
    'UPDATE exchange_loans SET repaid_amount=?, status=?, overdue_started_at=CASE WHEN ? THEN COALESCE(overdue_started_at, ?) ELSE overdue_started_at END, paid_at=?, updated_at=? WHERE id=?',
    [nextRepaid, paidInFull?'paid':(overdue?'overdue':'active'), overdue?1:0, now, paidInFull?now:null, now, loan.id]
  );
  await db.run(
    'INSERT INTO exchange_repayments (id,loan_id,borrower_id,lender_id,amount,mode,created_at) VALUES (?,?,?,?,?,?,?)',
    [generateId('xrp'), loan.id, loan.borrower_id, loan.lender_id, applied, mode, now]
  );
  await insertExchangeTx(loan.borrower_id, -applied, mode==='auto'?'exchange_auto_collect':'exchange_repayment', loan.id, `Exchange repayment to ${loan.lender_name||loan.lender_id}`);
  await insertExchangeTx(loan.lender_id, applied, mode==='auto'?'exchange_auto_collect_credit':'exchange_repayment_credit', loan.id, `Exchange repayment from ${loan.borrower_name||loan.borrower_id}`);
  if(mode==='auto'){
    await createNotification(
      loan.borrower_id,
      'exchange',
      'Overdue loan auto-collected',
      `Sclshi automatically collected ⬡${applied.toLocaleString()} toward your overdue exchange loan.`,
      '/app/exchange'
    );
  }
  if(paidInFull){
    await createNotification(
      loan.borrower_id,
      'exchange',
      'Exchange loan paid off',
      `Your loan from ${loan.lender_name||loan.lender_id} is fully repaid.`,
      '/app/exchange'
    );
    await createNotification(
      loan.lender_id,
      'exchange',
      'Exchange loan repaid',
      `${loan.borrower_name||loan.borrower_id} has fully repaid your loan.`,
      '/app/exchange'
    );
  }
  return applied;
}
async function collectOverdueExchangeDebtForUser(userId){
  if(!userId) return 0;
  await syncExchangeLoanStatuses();
  const user=await db.get('SELECT CAST(credits AS TEXT) as credits_text FROM users WHERE id=?',[userId]);
  let available=toSafeNumber(user?.credits_text,0);
  if(available<=0) return 0;
  const now=Date.now();
  const loans=await db.all(`
    SELECT l.*,
      borrower.name as borrower_name,
      lender.name as lender_name
    FROM exchange_loans l
    JOIN users borrower ON borrower.id=l.borrower_id
    JOIN users lender ON lender.id=l.lender_id
    WHERE l.borrower_id=? AND l.status IN ('active','overdue') AND l.due_at<=?
    ORDER BY l.due_at ASC, l.created_at ASC
  `,[userId, now]);
  let collected=0;
  for(const loan of loans){
    if(available<=0) break;
    const remaining=Math.max(0, Number(loan.repayment_amount||0) - Number(loan.repaid_amount||0));
    if(!remaining) continue;
    const applied=await applyExchangeRepayment(loan, Math.min(available, remaining), 'auto');
    if(applied){
      available-=applied;
      collected+=applied;
    }
  }
  return collected;
}
async function buildExchangeDashboardData(lenderUserId){
  await syncExchangeLoanStatuses();
  const users=await db.all("SELECT id,name,role,grade,CAST(credits AS TEXT) as credits_text,created_at FROM users WHERE role='admin' AND id!=? ORDER BY name ASC",[lenderUserId]);
  const lenderUser=await db.get('SELECT id,name,role,CAST(credits AS TEXT) as credits_text FROM users WHERE id=?',[lenderUserId]);
  const eligibleUsers=users.filter(isExchangeEligibleUser);
  const requests=await db.all(`
    SELECT r.*,
      borrower.name as borrower_name,
      lender.name as lender_name
    FROM exchange_requests r
    JOIN users borrower ON borrower.id=r.borrower_id
    JOIN users lender ON lender.id=r.lender_id
    WHERE r.lender_id=?
    ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END, r.created_at DESC
  `,[lenderUserId]);
  const loans=await db.all(`
    SELECT l.*,
      borrower.name as borrower_name,
      lender.name as lender_name
    FROM exchange_loans l
    JOIN users borrower ON borrower.id=l.borrower_id
    JOIN users lender ON lender.id=l.lender_id
    WHERE l.lender_id=?
    ORDER BY CASE WHEN l.status IN ('overdue','active') THEN 0 ELSE 1 END, l.due_at ASC, l.created_at DESC
  `,[lenderUserId]);
  const scoreMap=new Map();
  users.forEach(user=>{
    scoreMap.set(user.id,{
      userId:user.id,
      name:user.name,
      grade:user.grade||'',
      credits:toSafeNumber(user.credits_text,0),
      totalBorrowed:0,
      totalLent:0,
      activeDebt:0,
      overdueDebt:0,
      completedLoans:0,
      onTimeLoans:0,
      latePaidLoans:0,
      overdueLoans:0,
      defaults:0,
    });
  });
  const now=Date.now();
  loans.forEach(loan=>{
    const borrower=scoreMap.get(loan.borrower_id);
    const lender=scoreMap.get(loan.lender_id);
    const remaining=Math.max(0, Number(loan.repayment_amount||0) - Number(loan.repaid_amount||0));
    if(borrower){
      borrower.totalBorrowed += Number(loan.principal||0);
      if(remaining>0) borrower.activeDebt += remaining;
      if(remaining>0 && Number(loan.due_at||0)<=now){
        borrower.overdueDebt += remaining;
        borrower.overdueLoans += 1;
      }
      if(String(loan.status)==='paid'){
        borrower.completedLoans += 1;
        if(Number(loan.paid_at||0) && Number(loan.paid_at||0) <= Number(loan.due_at||0)) borrower.onTimeLoans += 1;
        else borrower.latePaidLoans += 1;
      }
    }
    if(lender) lender.totalLent += Number(loan.principal||0);
  });
  const usersWithScores=eligibleUsers.map(user=>{
    const metrics=scoreMap.get(user.id);
    let score=650;
    score += Math.min(metrics.onTimeLoans * 24, 120);
    score += Math.min(metrics.completedLoans * 8, 48);
    score += Math.min(Math.floor(metrics.credits / 300), 18);
    score -= Math.min(Math.round(metrics.activeDebt * 0.02), 38);
    score -= Math.min(Math.round(metrics.overdueDebt * 0.08), 180);
    score -= metrics.overdueLoans * 35;
    score -= metrics.latePaidLoans * 12;
    score -= metrics.defaults * 80;
    score=clampShekelScore(score);
    return {
      id:user.id,
      name:user.name,
      grade:user.grade||'',
      createdAt:Number(user.created_at||0),
      credits:metrics.credits,
      shekelScore:score,
      band:getShekelBand(score),
      totalBorrowed:metrics.totalBorrowed,
      totalLent:metrics.totalLent,
      activeDebt:metrics.activeDebt,
      overdueDebt:metrics.overdueDebt,
      completedLoans:metrics.completedLoans,
      onTimeLoans:metrics.onTimeLoans,
      latePaidLoans:metrics.latePaidLoans,
      overdueLoans:metrics.overdueLoans,
    };
  });
  const userSummaryMap=new Map(usersWithScores.map(user=>[user.id,user]));
  const pendingRequests=requests.filter(row=>String(row.status)==='pending').map(row=>({
    ...row,
    amount:Number(row.amount||0),
    interest_percent:Number(row.interest_percent||EXCHANGE_INTEREST_PERCENT),
    term_days:Number(row.term_days||7),
    borrower_score:userSummaryMap.get(row.borrower_id)?.shekelScore||650,
    lender_score:userSummaryMap.get(row.lender_id)?.shekelScore||650,
  }));
  const loanRows=loans.map(row=>{
    const remaining=Math.max(0, Number(row.repayment_amount||0) - Number(row.repaid_amount||0));
    return {
      ...row,
      principal:Number(row.principal||0),
      repayment_amount:Number(row.repayment_amount||0),
      repaid_amount:Number(row.repaid_amount||0),
      remaining,
      borrower_score:userSummaryMap.get(row.borrower_id)?.shekelScore||650,
      lender_score:userSummaryMap.get(row.lender_id)?.shekelScore||650,
      is_overdue: remaining>0 && Number(row.due_at||0)<=now,
    };
  });
  const activeLoans=loanRows.filter(row=>['active','overdue'].includes(String(row.status)));
  const overdueLoans=activeLoans.filter(row=>row.is_overdue || row.status==='overdue');
  const totalOutstanding=activeLoans.reduce((sum,row)=>sum+row.remaining,0);
  const avgScore=usersWithScores.length ? Math.round(usersWithScores.reduce((sum,row)=>sum+row.shekelScore,0)/usersWithScores.length) : 650;
  let lenderShekelScore=690;
  lenderShekelScore += Math.min(loanRows.filter(row=>row.status==='paid').length * 10, 60);
  lenderShekelScore += Math.min(Math.floor(toSafeNumber(lenderUser?.credits_text,0)/500), 24);
  lenderShekelScore -= overdueLoans.length * 14;
  lenderShekelScore=clampShekelScore(lenderShekelScore);
  return {
    settings:{interestPercent:EXCHANGE_INTEREST_PERCENT},
    lender:{
      id:lenderUser?.id||lenderUserId,
      name:lenderUser?.name||lenderUserId,
      credits:toSafeNumber(lenderUser?.credits_text,0),
      shekelScore:lenderShekelScore,
      band:getShekelBand(lenderShekelScore),
    },
    summary:{
      avgScore,
      activeDebt:totalOutstanding,
      overdueDebt:overdueLoans.reduce((sum,row)=>sum+row.remaining,0),
      pendingRequests:pendingRequests.length,
      activeLoans:activeLoans.length,
    },
    users:usersWithScores,
    requests:pendingRequests,
    loans:loanRows,
  };
}

async function recordTx(userId, amount, type, refId=null, desc='') {
  await db.run('INSERT INTO transactions (id,user_id,amount,type,reference_id,description,timestamp) VALUES (?,?,?,?,?,?,?)',
    [generateId('tx'),userId,amount,type,refId,desc,Date.now()]);
  adminTransactionsCache.clear();
  if(userId && Number(amount)>0 && !String(type||'').startsWith('exchange_')){
    await collectOverdueExchangeDebtForUser(userId).catch(()=>{});
  }
}
async function createNotification(userId, type, title, body, link='') {
  if(!userId) return;
  await db.run('INSERT INTO notifications (id,user_id,type,title,body,link,is_read,created_at) VALUES (?,?,?,?,?,?,0,?)',
    [generateId('ntf'),userId,type,String(title||'').slice(0,160),String(body||'').slice(0,500),String(link||'').slice(0,120),Date.now()]);
  bumpNotificationVersion(userId);
}
async function getCasinoStatsBaseline() {
  const rows = await db.all("SELECT key,value FROM settings WHERE key IN ('casino_stats_baseline_wagered','casino_stats_baseline_profit')");
  const settings = Object.fromEntries(rows.map(row=>[row.key, row.value]));
  return {
    wagered: Number(settings.casino_stats_baseline_wagered || 0),
    profit: Number(settings.casino_stats_baseline_profit || 0),
  };
}
async function getActiveLuckyStreak(userId){
  if(!userId) return null;
  const row = await db.get(
    `SELECT ls.*,u.name as granted_by_name
     FROM lucky_streaks ls
     LEFT JOIN users u ON u.id=ls.granted_by
     WHERE ls.user_id=? AND ls.expires_at>?
     ORDER BY ls.expires_at DESC
     LIMIT 1`,
    [userId, Date.now()]
  );
  if(!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    grantedBy: row.granted_by,
    grantedByName: row.granted_by_name || row.granted_by,
    boostPercent: Number(row.boost_percent || 0),
    expiresAt: Number(row.expires_at || 0),
    active: true,
  };
}
async function getCasinoConfig(userId=null) {
  const rows = await db.all("SELECT key,value FROM settings WHERE key IN ('casino_dice_odds','casino_plinko_odds','casino_blackjack_odds','casino_mines_odds','casino_roulette_odds','casino_coinflip_odds')");
  const settings = Object.fromEntries(rows.map(row=>[row.key, row.value]));
  const base = {
    diceOdds: clampNumber(Number(settings.casino_dice_odds || 100), 0, 200),
    plinkoOdds: clampNumber(Number(settings.casino_plinko_odds || 100), 0, 200),
    blackjackOdds: clampNumber(Number(settings.casino_blackjack_odds || 100), 0, 200),
    minesOdds: clampNumber(Number(settings.casino_mines_odds || 100), 0, 200),
    rouletteOdds: clampNumber(Number(settings.casino_roulette_odds || 100), 0, 200),
    coinflipOdds: clampNumber(Number(settings.casino_coinflip_odds || 100), 0, 200),
  };
  const luckyStreak = await getActiveLuckyStreak(userId);
  const effective = luckyStreak ? {
    diceOdds: clampNumber(base.diceOdds + luckyStreak.boostPercent, 0, 200),
    plinkoOdds: clampNumber(base.plinkoOdds + luckyStreak.boostPercent, 0, 200),
    blackjackOdds: clampNumber(base.blackjackOdds + luckyStreak.boostPercent, 0, 200),
    minesOdds: clampNumber(base.minesOdds + luckyStreak.boostPercent, 0, 200),
    rouletteOdds: clampNumber(base.rouletteOdds + luckyStreak.boostPercent, 0, 200),
    coinflipOdds: clampNumber(base.coinflipOdds + luckyStreak.boostPercent, 0, 200),
  } : { ...base };
  return { ...base, effective, luckyStreak };
}
function parsePage(value, fallback, min, max){
  const num = Math.floor(Number(value));
  if(!Number.isFinite(num)) return fallback;
  return clampNumber(num, min, max);
}
function combination(n, k){
  if(k<0 || k>n) return 0;
  const limit = Math.min(k, n-k);
  let result = 1;
  for(let i=1;i<=limit;i++){
    result = (result * (n - limit + i)) / i;
  }
  return result;
}
function getMinesMultiplier(revealedCount, mineCount){
  if(revealedCount<=0) return 1;
  const safeTiles = 25 - mineCount;
  const fair = combination(25, revealedCount) / combination(safeTiles, revealedCount);
  return Number((fair * 0.97).toFixed(4));
}
const ROULETTE_RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const ROULETTE_NUMBERS = Array.from({length:37}, (_, i)=>i);
function getRoulettePayoutMultiplier(betType){
  if(betType==='number') return 36;
  if(['red','black','even','odd','low','high'].includes(betType)) return 2;
  if(['dozen1','dozen2','dozen3'].includes(betType)) return 3;
  return 0;
}
function getRouletteWinningNumbers(betType, value){
  if(betType==='number') return new Set([clampNumber(Math.floor(Number(value||0)), 0, 36)]);
  if(betType==='red') return new Set([...ROULETTE_RED_NUMBERS]);
  if(betType==='black') return new Set(ROULETTE_NUMBERS.filter(n=>n!==0 && !ROULETTE_RED_NUMBERS.has(n)));
  if(betType==='even') return new Set(ROULETTE_NUMBERS.filter(n=>n!==0 && n%2===0));
  if(betType==='odd') return new Set(ROULETTE_NUMBERS.filter(n=>n%2===1));
  if(betType==='low') return new Set(ROULETTE_NUMBERS.filter(n=>n>=1 && n<=18));
  if(betType==='high') return new Set(ROULETTE_NUMBERS.filter(n=>n>=19 && n<=36));
  if(betType==='dozen1') return new Set(ROULETTE_NUMBERS.filter(n=>n>=1 && n<=12));
  if(betType==='dozen2') return new Set(ROULETTE_NUMBERS.filter(n=>n>=13 && n<=24));
  if(betType==='dozen3') return new Set(ROULETTE_NUMBERS.filter(n=>n>=25 && n<=36));
  return new Set();
}
function getRouletteMeta(number){
  if(number===0) return {label:'0', color:'green'};
  return {
    label:String(number),
    color:ROULETTE_RED_NUMBERS.has(number)?'red':'black',
  };
}
function pickRouletteNumber(winningSet, odds){
  const winNumbers=[...winningSet];
  const loseNumbers=ROULETTE_NUMBERS.filter(n=>!winningSet.has(n));
  const useWin = odds<=0 ? false : odds>=200 ? true : Math.random() < (odds/200);
  const pool=(useWin?winNumbers:loseNumbers).length ? (useWin?winNumbers:loseNumbers) : (useWin?loseNumbers:winNumbers);
  return pool[Math.floor(Math.random()*pool.length)];
}
function makeMineSet(mineCount){
  const pool = Array.from({length:25}, (_, idx)=>idx);
  for(let i=pool.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [pool[i],pool[j]]=[pool[j],pool[i]];
  }
  return new Set(pool.slice(0, mineCount));
}
function getAdjustedSafeChance(baseSafeChance, slider, mineCount=0){
  if(slider<=0) return 0;
  if(slider>=200) return 1;
  if(mineCount>=20) return baseSafeChance;
  if(slider<100) return baseSafeChance * (slider/100);
  const boost = 0.06 + (((slider - 100) / 100) * 0.94);
  const cappedBoost = mineCount>=15 ? Math.min(boost, 0.18) : boost;
  return Math.min(1, baseSafeChance + (1 - baseSafeChance) * cappedBoost);
}
function serializeMinesState(game, revealAll=false){
  const revealed = new Set(game.revealedSafe || []);
  if(revealAll){
    (game.mineSet || []).forEach(idx=>revealed.add(idx));
  }
  const currentMultiplier = getMinesMultiplier(game.revealedSafe.size, game.mineCount);
  const nextMultiplier = game.revealedSafe.size < (25 - game.mineCount)
    ? getMinesMultiplier(game.revealedSafe.size + 1, game.mineCount)
    : currentMultiplier;
  return {
    status: game.status,
    mineCount: game.mineCount,
    revealedSafeCount: game.revealedSafe.size,
    currentMultiplier,
    nextMultiplier,
    potentialPayout: Math.floor(game.betAmount * currentMultiplier),
    betAmount: game.betAmount,
    board: Array.from({length:25}, (_, idx)=>({
      index: idx,
      revealed: revealed.has(idx),
      type: revealAll || revealed.has(idx) ? (game.mineSet.has(idx) ? 'mine' : 'safe') : null,
    })),
  };
}
function flipMineCell(game, index, shouldBeSafe){
  if(shouldBeSafe === !game.mineSet.has(index)) return true;
  const candidates = [];
  for(let idx=0;idx<25;idx++){
    if(idx===index) continue;
    if(game.revealedSafe.has(idx)) continue;
    if(shouldBeSafe ? !game.mineSet.has(idx) : game.mineSet.has(idx)) candidates.push(idx);
  }
  if(!candidates.length) return false;
  const swapIndex = candidates[Math.floor(Math.random()*candidates.length)];
  if(shouldBeSafe){
    game.mineSet.delete(index);
    game.mineSet.add(swapIndex);
  }else{
    game.mineSet.delete(swapIndex);
    game.mineSet.add(index);
  }
  return true;
}
function authMiddleware(req,res,next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({error:'No token'});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({error:'Invalid token'}); }
}
function assistanceStreamAuth(req,res,next) {
  const token = req.query.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({error:'No token'});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({error:'Invalid token'}); }
}
async function adminOnly(req,res,next) {
  const user = await db.get('SELECT role FROM users WHERE id=?',[req.user.id]);
  if (!user||user.role!=='admin') return res.status(403).json({error:'Admin only'});
  next();
}
async function requireAssistanceAccess(req,res,next){
  if(!(await hasAssistanceAccess(req.user.id))) return res.status(403).json({error:'You do not have Assistance access'});
  next();
}
async function requireAssistanceVisibility(req,res,next){
  if(!(await hasAssistanceSessionVisibility(req.user.id))) return res.status(403).json({error:'Assistance is not available for this account'});
  next();
}
function isGrose(req) { return req.user.id === 'ADMIN'; }
function isAdminUser(user) { return user?.role === 'admin'; }
async function canGrantLuckyStreak(userId){
  if(userId === 'ADMIN') return true;
  const user = await db.get('SELECT role FROM users WHERE id=?',[userId]);
  return user?.role === 'admin';
}
function lmsrCost(qYes, qNo, b) {
  return b * Math.log(Math.exp(qYes/b) + Math.exp(qNo/b));
}
function lmsrYesPrice(qYes, qNo, b) {
  const eY = Math.exp(qYes/b), eN = Math.exp(qNo/b);
  return Math.round((eY/(eY+eN))*100);
}
function lmsrNoPrice(qYes, qNo, b) {
  return 100 - lmsrYesPrice(qYes, qNo, b);
}
function lmsrBuyCost(qYes, qNo, b, side, contracts) {
  const newY = side==='YES' ? qYes+contracts : qYes;
  const newN = side==='NO' ? qNo+contracts : qNo;
  return Math.round(lmsrCost(newY,newN,b) - lmsrCost(qYes,qNo,b));
}
function lmsrSellReturn(qYes, qNo, b, side, contracts) {
  const newY = side==='YES' ? qYes-contracts : qYes;
  const newN = side==='NO' ? qNo-contracts : qNo;
  return Math.round(lmsrCost(qYes,qNo,b) - lmsrCost(newY,newN,b));
}
const BANNED_WORDS = [
  'fuck','shit','ass','bitch','damn','crap','hell','bastard','dick','cunt',
  'pussy','cock','piss','fag','faggot','nigger','nigga','retard','whore',
  'slut','rape','homo','dyke','tranny','kike','spic','chink','gook','wetback',
  'asshole','motherfucker','bullshit','jackass','dumbass','dipshit','shithead',
  'douchebag','prick','twat','wanker','bollocks','bloody','arse','tosser',
  'fucker','slutty','bitchy','crackhead','druggie','stoner','junkie','pussy','penis','cum',
];
function censorText(text) {
  let t = text;
  BANNED_WORDS.forEach(w => {
    const re = new RegExp(w, 'gi');
    t = t.replace(re, '*'.repeat(w.length));
  });
  return t;
}
function getYesPercent(m) { const t=(m.yes_shares||0)+(m.no_shares||0); return t===0?50:Math.round((m.yes_shares/t)*100); }
function getOverPercent(m) { const t=(m.over_shares||0)+(m.under_shares||0); return t===0?50:Math.round((m.over_shares/t)*100); }
function toBool(value){
  return value===true || value===1 || value==='1' || value==='true';
}
function writeSse(res, payload){
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function emitAssistance(userIds, type, payload={}){
  const targets = [...new Set((Array.isArray(userIds)?userIds:[userIds]).filter(Boolean))];
  const message = { type, payload, at: Date.now() };
  targets.forEach(userId=>{
    const streams = assistanceStreams.get(userId);
    if(!streams) return;
    streams.forEach(res=>writeSse(res, message));
  });
}
async function fetchAssistanceSession(sessionId){
  return db.get(`SELECT s.*,
    senior.name as senior_name, senior.role as senior_role, senior.grade as senior_grade,
    helper.name as helper_name, helper.role as helper_role, helper.grade as helper_grade
    FROM assistance_sessions s
    JOIN users senior ON senior.id=s.senior_user_id
    JOIN users helper ON helper.id=s.helper_user_id
    WHERE s.id=?`, [sessionId]);
}
async function logAssistanceEvent(sessionId, actorUserId, eventType, payload={}){
  const id = generateId('ae');
  const createdAt = Date.now();
  await db.run(
    'INSERT INTO assistance_events (id,session_id,actor_user_id,event_type,payload,created_at) VALUES (?,?,?,?,?,?)',
    [id, sessionId, actorUserId, eventType, JSON.stringify(payload||{}), createdAt]
  );
  return { id, session_id: sessionId, actor_user_id: actorUserId, event_type: eventType, payload, created_at: createdAt };
}
async function emitAssistanceSessionRefresh(sessionId, type='assistance-session', extra={}){
  const session = await fetchAssistanceSession(sessionId);
  if(!session) return;
  emitAssistance([session.senior_user_id, session.helper_user_id], type, { sessionId, ...extra });
}
async function getAssistanceStateForUser(userId){
  await cleanupStaleAssistanceSessions('(senior_user_id=? OR helper_user_id=?)', [userId, userId]);
  const [contacts, incomingRequests, helperFor, currentSessions, recentSessions] = await Promise.all([
    db.all(`SELECT c.*,u.name as helper_name,u.role as helper_role,u.grade as helper_grade
      FROM assistance_contacts c
      JOIN users u ON u.id=c.helper_user_id
      WHERE c.user_id=?
      ORDER BY c.created_at DESC`, [userId]),
    db.all(`SELECT c.*,u.name as senior_name,u.role as senior_role,u.grade as senior_grade
      FROM assistance_contacts c
      JOIN users u ON u.id=c.user_id
      WHERE c.helper_user_id=? AND c.status='pending'
      ORDER BY c.created_at DESC`, [userId]),
    db.all(`SELECT c.*,u.name as senior_name,u.role as senior_role,u.grade as senior_grade
      FROM assistance_contacts c
      JOIN users u ON u.id=c.user_id
      WHERE c.helper_user_id=? AND c.status='approved'
      ORDER BY u.name ASC`, [userId]),
    db.all(`SELECT s.*,
      senior.name as senior_name, senior.role as senior_role,
      helper.name as helper_name, helper.role as helper_role
      FROM assistance_sessions s
      JOIN users senior ON senior.id=s.senior_user_id
      JOIN users helper ON helper.id=s.helper_user_id
      WHERE (s.senior_user_id=? OR s.helper_user_id=?)
        AND s.status IN ('pending','active')
      ORDER BY s.created_at DESC`, [userId, userId]),
    db.all(`SELECT s.*,
      senior.name as senior_name,
      helper.name as helper_name
      FROM assistance_sessions s
      JOIN users senior ON senior.id=s.senior_user_id
      JOIN users helper ON helper.id=s.helper_user_id
      WHERE (s.senior_user_id=? OR s.helper_user_id=?)
        AND s.status='stopped'
      ORDER BY COALESCE(s.ended_at,s.created_at) DESC
      LIMIT 12`, [userId, userId]),
  ]);
  return { contacts, incomingRequests, helperFor, currentSessions, recentSessions };
}
// ── EMAIL VERIFICATION ──
app.post('/api/auth/verify-code', async(req,res)=>{
  try{
    const {pendingId,code}=req.body;
    if(!pendingId||!code) return res.status(400).json({error:'Missing fields'});
    const pending=await db.get('SELECT * FROM pending_registrations WHERE id=?',[pendingId]);
    if(!pending) return res.status(400).json({error:'Registration not found. Please register again.'});
    if(pending.expires_at<Date.now()){
      await db.run('DELETE FROM pending_registrations WHERE id=?',[pendingId]);
      return res.status(400).json({error:'Code expired. Please register again.'});
    }
    if(pending.code!==code.trim()) return res.status(400).json({error:'Invalid code. Try again.'});
    if(await db.get('SELECT id FROM users WHERE LOWER(email)=?',[pending.email]))
      return res.status(409).json({error:'An account with that email already exists'});
    const uid=generateId('U');
    await db.run('INSERT INTO users (id,name,email,password,role,credits,grade,school,email_verified,on_email_list,created_at) VALUES (?,?,?,?,?,?,?,?,1,0,?)',
      [uid,pending.name,pending.email,pending.password,'student',200,pending.grade,pending.school || 'SCLSHI',Date.now()]);
    await db.run('DELETE FROM pending_registrations WHERE id=?',[pendingId]);
    await recordTx(uid,200,'signup_bonus',null,'Welcome bonus');
    appendToSheet(pending.name,pending.email,pending.grade,pending.school);
    const token=jwt.sign({id:uid,role:'student'},JWT_SECRET,{expiresIn:'30d'});
    const user=await db.get('SELECT id,name,email,role,credits,grade,school,on_email_list FROM users WHERE id=?',[uid]);
    res.json({token,user,message:'Account created!'});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/resend-code', async(req,res)=>{
  try{
    const {pendingId}=req.body;
    const pending=await db.get('SELECT * FROM pending_registrations WHERE id=?',[pendingId]);
    if(!pending) return res.status(400).json({error:'Registration not found. Please register again.'});
    const code=Math.floor(100000+Math.random()*900000).toString();
    await db.run('UPDATE pending_registrations SET code=?,expires_at=? WHERE id=?',[code,Date.now()+600000,pendingId]);
    await sendViaAppsScript('verify_code',{email:pending.email,name:pending.name,code,siteUrl:CLIENT_URL});
    res.json({message:'New code sent!'});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── ACCESS PASSWORD ──
app.post('/api/access/verify', async(req,res)=>{
  const {password}=req.body;
  const row=await db.get("SELECT value FROM settings WHERE key='access_password'");
  if(!row?.value) return res.status(503).json({error:'Access password is not configured'});
  if(password===row.value) res.json({success:true});
  else res.status(401).json({error:'Wrong password'});
});

app.post('/api/admin/access-password', authMiddleware, adminOnly, async(req,res)=>{
  try{
    if(!isGrose(req)) return res.status(403).json({error:'Only the primary admin can change the access password'});
    const {password}=req.body;
    if(!password||password.length<4) return res.status(400).json({error:'Password too short'});
    await db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('access_password',?)",[password]);
    // Email verified users the new password
    const emailUsers=await db.all("SELECT email,name FROM users WHERE on_email_list=1 AND role='student'");
    const emails=emailUsers.map(u=>({email:u.email,name:u.name}));
    const sent=await sendViaAppsScript('access_password_changed',{emails,newPassword:password,siteUrl:CLIENT_URL});
    res.json({success:true,emailsSent:sent});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/popup-auth', authMiddleware, async(req,res)=>{
  try{
    if(!(await hasPopupTabAccess(req.user.id))) return res.status(403).json({error:'You do not have Pop-up tab access'});
    const {password}=req.body;
    if(!password) return res.status(400).json({error:'Password required'});
    const row=await db.get('SELECT value FROM settings WHERE key=?',[POPUP_TAB_PASSWORD_KEY]);
    if(!row?.value) return res.status(500).json({error:'Pop-up tab password is not configured'});
    const ok=await bcrypt.compare(password,row.value);
    if(!ok) return res.status(401).json({error:'Incorrect Pop-up tab password'});
    const unlockToken = issuePopupUnlockToken(req.user.id);
    res.json({success:true,unlockToken,expiresInMs:POPUP_UNLOCK_TTL_MS});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/popup-password', authMiddleware, async(req,res)=>{
  try{
    if(!isGrose(req)) return res.status(403).json({error:'Only the primary admin can change the Pop-up tab password'});
    const {currentPassword,newPassword}=req.body;
    if(!currentPassword||!newPassword) return res.status(400).json({error:'Missing fields'});
    if(newPassword.length<6) return res.status(400).json({error:'New password must be at least 6 characters'});
    const row=await db.get('SELECT value FROM settings WHERE key=?',[POPUP_TAB_PASSWORD_KEY]);
    if(!row?.value) return res.status(500).json({error:'Pop-up tab password is not configured'});
    const ok=await bcrypt.compare(currentPassword,row.value);
    if(!ok) return res.status(401).json({error:'Current Pop-up tab password is incorrect'});
    const nextHash=await bcrypt.hash(newPassword,10);
    await db.run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)',[POPUP_TAB_PASSWORD_KEY,nextHash]);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/popups', authMiddleware, requirePopupAdminUnlocked, async(req,res)=>{
  try{
    const {recipientId,recipientIds,title,message,alertText,mediaDataUrl,mediaName,audioDataUrl,audioName,raveEnabled,alertEnabled,closeoutEnabled}=req.body;
    const targets = [...new Set(
      (Array.isArray(recipientIds) ? recipientIds : [recipientId]).filter(Boolean)
    )];
    if(!targets.length) return res.status(400).json({error:'At least one recipient is required'});
    if(!title?.trim() && !message?.trim() && !mediaDataUrl && !audioDataUrl) return res.status(400).json({error:'Add a title, message, media, or audio first'});
    const mediaUrl = mediaDataUrl ? saveDataUrlToFile(mediaDataUrl, mediaName, ['image','video']) : null;
    const audioUrl = audioDataUrl ? saveDataUrlToFile(audioDataUrl, audioName, ['audio','audio/mpeg','audio/mp3']) : null;
    const mediaType = mediaDataUrl ? String(mediaDataUrl).slice(5, String(mediaDataUrl).indexOf(';')) : null;
    const recipients = [];
    for(const targetId of targets){
      const recipient = await db.get('SELECT id,name,role FROM users WHERE id=?',[targetId]);
      if(!recipient) return res.status(404).json({error:`Recipient not found: ${targetId}`});
      if(recipient.id==='ADMIN') return res.status(400).json({error:'The primary admin cannot be targeted by Pop-up messages'});
      recipients.push(recipient);
    }
    const created = [];
    for(const recipient of recipients){
      await db.run("UPDATE popups SET status='stopped', stopped_at=? WHERE recipient_id=? AND status IN ('pending','active')",[Date.now(),recipient.id]);
      bumpPopupVersion(recipient.id);
      const id = generateId('popup');
      await db.run(`INSERT INTO popups (id,sender_id,recipient_id,title,message,alert_text,media_type,media_url,audio_url,rave_enabled,alert_enabled,closeout_enabled,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id,req.user.id,recipient.id,title?.trim()||'',message?.trim()||'',alertText?.trim()||'',mediaType,mediaUrl,audioUrl,raveEnabled?1:0,alertEnabled?1:0,closeoutEnabled?1:0,'pending',Date.now()]);
      bumpPopupVersion(recipient.id);
      created.push(await db.get('SELECT * FROM popups WHERE id=?',[id]));
    }
    res.json({count:created.length,popups:created});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/admin/popups/active', authMiddleware, requirePopupAdminUnlocked, async(req,res)=>{
  try{
    const popups = await db.all(`SELECT p.*,u.name as recipient_name
      FROM popups p JOIN users u ON p.recipient_id=u.id
      WHERE p.status IN ('pending','active')
      ORDER BY p.created_at DESC LIMIT 20`);
    res.json(popups);
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/popups/stop-all', authMiddleware, requirePopupAdminUnlocked, async(req,res)=>{
  try{
    const popups = await db.all("SELECT recipient_id FROM popups WHERE status IN ('pending','active')");
    const row = { c: popups.length };
    await db.run("UPDATE popups SET status='stopped', stopped_at=? WHERE status IN ('pending','active')",[Date.now()]);
    popups.forEach(popup=>bumpPopupVersion(popup.recipient_id));
    res.json({success:true,stopped:row?.c||0});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/popups/:id/stop', authMiddleware, requirePopupAdminUnlocked, async(req,res)=>{
  try{
    const popup = await db.get('SELECT * FROM popups WHERE id=?',[req.params.id]);
    if(!popup) return res.status(404).json({error:'Pop-up not found'});
    if(!['pending','active'].includes(popup.status)) return res.json({success:true});
    await db.run("UPDATE popups SET status='stopped', stopped_at=? WHERE id=?",[Date.now(),req.params.id]);
    bumpPopupVersion(popup.recipient_id);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/popup-polls', authMiddleware, requirePopupAdminUnlocked, async(req,res)=>{
  try{
    const {recipientIds,question,options}=req.body;
    const targets=[...new Set((Array.isArray(recipientIds)?recipientIds:[]).filter(Boolean))];
    const cleanedOptions=(Array.isArray(options)?options:[]).map(opt=>String(opt||'').trim()).filter(Boolean).slice(0,4);
    if(!targets.length) return res.status(400).json({error:'At least one recipient is required'});
    if(!question?.trim()) return res.status(400).json({error:'Question is required'});
    if(cleanedOptions.length<2) return res.status(400).json({error:'Add at least two options'});
    const recipients=[];
    for(const targetId of targets){
      const recipient=await db.get('SELECT id,name FROM users WHERE id=?',[targetId]);
      if(!recipient) return res.status(404).json({error:`Recipient not found: ${targetId}`});
      if(recipient.id==='ADMIN') return res.status(400).json({error:'The primary admin cannot be targeted by Pop-up polls'});
      recipients.push(recipient);
    }
    const pollId=generateId('ppoll');
    const createdAt=Date.now();
    await db.run('INSERT INTO popup_polls (id,sender_id,question,options_json,status,created_at) VALUES (?,?,?,?,?,?)',[
      pollId,
      req.user.id,
      question.trim(),
      JSON.stringify(cleanedOptions),
      'active',
      createdAt
    ]);
    for(const recipient of recipients){
      await db.run('INSERT INTO popup_poll_recipients (id,poll_id,recipient_id,created_at) VALUES (?,?,?,?)',[
        generateId('ppr'),
        pollId,
        recipient.id,
        createdAt
      ]);
    }
    res.json({success:true,poll:await db.get('SELECT * FROM popup_polls WHERE id=?',[pollId])});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/admin/popup-polls', authMiddleware, requirePopupAdminUnlocked, async(req,res)=>{
  try{
    const polls=await db.all(`SELECT p.*,
      (SELECT COUNT(*) FROM popup_poll_recipients r WHERE r.poll_id=p.id) as recipient_count,
      (SELECT COUNT(*) FROM popup_poll_votes v WHERE v.poll_id=p.id) as vote_count
      FROM popup_polls p
      ORDER BY p.created_at DESC
      LIMIT 20`);
    const results=[];
    for(const poll of polls){
      const options=JSON.parse(poll.options_json||'[]');
      const votes=await db.all(`SELECT v.option_index,u.name as voter_name,u.id as voter_id,v.created_at
        FROM popup_poll_votes v
        JOIN users u ON u.id=v.recipient_id
        WHERE v.poll_id=?
        ORDER BY v.created_at DESC`,[poll.id]);
      results.push({
        ...poll,
        options,
        votesByOption:options.map((label,idx)=>({
          label,
          count:votes.filter(vote=>vote.option_index===idx).length,
          voters:votes.filter(vote=>vote.option_index===idx),
        })),
        votes,
      });
    }
    res.json(results);
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/popup-polls/:id/close', authMiddleware, requirePopupAdminUnlocked, async(req,res)=>{
  try{
    await db.run("UPDATE popup_polls SET status='closed', closed_at=? WHERE id=? AND status='active'",[Date.now(),req.params.id]);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/popup-polls', authMiddleware, async(req,res)=>{
  try{
    if(!await userHasPopupAccess(req.user.id)) return res.json([]);
    const polls=await db.all(`SELECT p.*,
      r.created_at as assigned_at,
      v.option_index as selected_option,
      v.created_at as voted_at
      FROM popup_poll_recipients r
      JOIN popup_polls p ON p.id=r.poll_id
      LEFT JOIN popup_poll_votes v ON v.poll_id=p.id AND v.recipient_id=r.recipient_id
      WHERE r.recipient_id=?
      ORDER BY p.created_at DESC`,[req.user.id]);
    res.json(polls.map(poll=>({
      ...poll,
      options:JSON.parse(poll.options_json||'[]')
    })));
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/popup-polls/:id/vote', authMiddleware, async(req,res)=>{
  try{
    if(!await userHasPopupAccess(req.user.id)) return res.status(403).json({error:'No access'});
    const optionIndex=Math.floor(Number(req.body.optionIndex));
    const poll=await db.get(`SELECT p.*,r.recipient_id
      FROM popup_polls p
      JOIN popup_poll_recipients r ON r.poll_id=p.id
      WHERE p.id=? AND r.recipient_id=?`,[req.params.id,req.user.id]);
    if(!poll) return res.status(404).json({error:'Poll not found'});
    if(poll.status!=='active') return res.status(400).json({error:'This poll is closed'});
    const options=JSON.parse(poll.options_json||'[]');
    if(optionIndex<0||optionIndex>=options.length) return res.status(400).json({error:'Invalid option'});
    const existing=await db.get('SELECT id FROM popup_poll_votes WHERE poll_id=? AND recipient_id=?',[poll.id,req.user.id]);
    if(existing){
      await db.run('UPDATE popup_poll_votes SET option_index=?, created_at=? WHERE id=?',[optionIndex,Date.now(),existing.id]);
    }else{
      await db.run('INSERT INTO popup_poll_votes (id,poll_id,recipient_id,option_index,created_at) VALUES (?,?,?,?,?)',[
        generateId('ppv'),
        poll.id,
        req.user.id,
        optionIndex,
        Date.now()
      ]);
    }
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/popups/pending', authMiddleware, async(req,res)=>{
  try{
    const version = getPopupVersion(req.user.id);
    const cached = popupPendingCache.get(req.user.id);
    if(cached && cached.expiresAt > Date.now() && cached.version === version){
      return res.json(cached.data);
    }
    const popup = await db.get(`SELECT * FROM popups
      WHERE recipient_id=? AND status IN ('pending','active')
      ORDER BY created_at DESC LIMIT 1`,[req.user.id]);
    if(!popup){
      const data = {popup:null};
      popupPendingCache.set(req.user.id, { data, expiresAt: Date.now() + POPUP_PENDING_CACHE_TTL_MS, version });
      return res.json(data);
    }
    if(popup.status==='pending'){
      await db.run("UPDATE popups SET status='active', shown_at=? WHERE id=?",[Date.now(),popup.id]);
      popup.status='active';
      popup.shown_at=Date.now();
      bumpPopupVersion(req.user.id);
    }
    const data = {popup};
    popupPendingCache.set(req.user.id, { data, expiresAt: Date.now() + POPUP_PENDING_CACHE_TTL_MS, version: getPopupVersion(req.user.id) });
    res.json(data);
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/popups/:id/dismiss', authMiddleware, async(req,res)=>{
  try{
    const popup=await db.get('SELECT * FROM popups WHERE id=?',[req.params.id]);
    if(!popup) return res.status(404).json({error:'Pop-up not found'});
    if(popup.recipient_id!==req.user.id) return res.status(403).json({error:'Not your pop-up'});
    if(!popup.closeout_enabled) return res.status(400).json({error:'This pop-up cannot be closed by the recipient'});
    await db.run("UPDATE popups SET status='stopped', stopped_at=? WHERE id=?",[Date.now(),req.params.id]);
    bumpPopupVersion(req.user.id);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── LIVE FEED ──
app.get('/api/live', async(req,res)=>{
  try{
    if(liveCache.data && liveCache.expiresAt > Date.now()){
      return res.json(liveCache.data);
    }
    const totalCredits=toSafeNumber((await db.get("SELECT CAST(SUM(credits) AS TEXT) as s FROM users WHERE role='student'")).s,0);
    const activePlayers=(await db.get("SELECT COUNT(*) as c FROM users WHERE role='student'")).c||0;
    const markets=await db.all("SELECT id,question,category,close_date,pool,yes_shares,no_shares,over_shares,under_shares,market_type,line,status FROM markets WHERE status='open' ORDER BY created_at DESC");
    const totalBets=(await db.get("SELECT COUNT(*) as c FROM bets WHERE status='active'")).c||0;
    liveCache = {
      data: { totalCredits,activePlayers,markets,totalBets },
      expiresAt: Date.now() + LIVE_CACHE_TTL_MS,
    };
    res.json(liveCache.data);
  }catch(e){res.status(500).json({error:e.message});}
});

// ── STRIPE ──
app.post('/api/credits/checkout', authMiddleware, async(req,res)=>{
  try{
    const {amountCents}=req.body;
    if(!amountCents||amountCents<100) return res.status(400).json({error:'Minimum purchase is $1.00'});
    const credits=Math.floor(amountCents/100)*100;
    const session=await stripe.checkout.sessions.create({
      payment_method_types:['card'],
      line_items:[{price_data:{currency:'usd',unit_amount:amountCents,product_data:{name:`Sclshi Markets — ${credits.toLocaleString()} Credits`}},quantity:1}],
      mode:'payment',
      success_url:`${CLIENT_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:`${CLIENT_URL}/?cancelled=1`,
      metadata:{user_id:req.user.id,credits:String(credits)},
    });
    await db.run('INSERT INTO stripe_sessions (session_id,user_id,credits,fulfilled,created_at) VALUES (?,?,?,0,?)',
      [session.id,req.user.id,credits,Date.now()]);
    res.json({url:session.url});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/stripe-webhook', async(req,res)=>{
  const sig=req.headers['stripe-signature'];
  let event;
  try{event=stripe.webhooks.constructEvent(req.body,sig,process.env.STRIPE_WEBHOOK_SECRET);}
  catch(e){return res.status(400).send(`Webhook Error: ${e.message}`);}
  if(event.type==='checkout.session.completed'){
    const session=event.data.object;
    const {user_id,credits}=session.metadata;
    const creditsNum=parseInt(credits);
    const existing=await db.get('SELECT fulfilled FROM stripe_sessions WHERE session_id=?',[session.id]);
    if(!existing||existing.fulfilled) return res.json({received:true});
    await db.run('UPDATE users SET credits=credits+? WHERE id=?',[creditsNum,user_id]);
    await recordTx(user_id,creditsNum,'purchase',session.id,`Purchased ${creditsNum} credits`);
    await db.run('UPDATE stripe_sessions SET fulfilled=1 WHERE session_id=?',[session.id]);
  }
  res.json({received:true});
});

app.get('/api/credits/verify/:sessionId', authMiddleware, async(req,res)=>{
  const row=await db.get('SELECT fulfilled,credits FROM stripe_sessions WHERE session_id=? AND user_id=?',
    [req.params.sessionId,req.user.id]);
  if(!row) return res.status(404).json({error:'Session not found'});
  res.json({fulfilled:!!row.fulfilled,credits:row.credits});
});

// ── AUTH ──
app.post('/api/auth/login', async(req,res)=>{
  try{
    const {email,password,identifier}=req.body;
    const lookup=(identifier||email||'').trim();
    if(!lookup||!password) return res.status(400).json({error:'Missing fields'});
    const user=await db.get('SELECT * FROM users WHERE LOWER(email)=LOWER(?) OR LOWER(name)=LOWER(?) OR LOWER(id)=LOWER(?)',[lookup,lookup,lookup]);
    if(!user) return res.status(401).json({error:'Invalid email/username or password'});
    if(!await bcrypt.compare(password,user.password)) return res.status(401).json({error:'Invalid email/username or password'});
    const token=jwt.sign({id:user.id,role:user.role},JWT_SECRET,{expiresIn:'30d'});
    const {password:_,...safe}=user;
    res.json({token,user:safe});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/register', async(req,res)=>{
  try{
    const {name,email,password,grade,school}=req.body;
    if(!name||!email||!password||!school) return res.status(400).json({error:'Missing fields'});
    const trimmedEmail=email.trim().toLowerCase();
    if(await db.get('SELECT id FROM users WHERE LOWER(email)=?',[trimmedEmail]))
      return res.status(409).json({error:'An account with that email already exists'});
    if(password.length<6) return res.status(400).json({error:'Password must be at least 6 characters'});
    const hash=await bcrypt.hash(password,10);
    const code=Math.floor(100000+Math.random()*900000).toString();
    const id=generateId('pending');
    await db.run('DELETE FROM pending_registrations WHERE email=?',[trimmedEmail]);
    await db.run('INSERT INTO pending_registrations (id,name,email,password,grade,school,code,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id,name.trim(),trimmedEmail,hash,grade||'',school.trim(),code,Date.now()+600000,Date.now()]);
    await sendViaAppsScript('verify_code',{email:trimmedEmail,name:name.trim(),code,siteUrl:CLIENT_URL});
    res.json({message:'Verification code sent to your email.',pendingId:id});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/forgot-password', async(req,res)=>{
  try{
    const {email}=req.body;
    const user=await db.get('SELECT * FROM users WHERE LOWER(email)=LOWER(?)',[email?.trim()]);
    if(user){
      const token=generateToken();
      const resetUrl=`${CLIENT_URL}/reset-password.html?token=${token}`;
      await db.run('INSERT INTO password_reset_tokens (token,user_id,expires_at,used,created_at) VALUES (?,?,?,0,?)',
        [token,user.id,Date.now()+3600000,Date.now()]);
      const sent=await sendViaAppsScript('reset_password',{
        email:user.email,
        name:user.name||user.id,
        resetUrl,
        siteUrl:CLIENT_URL,
      });
      console.log(`[Dev] Reset: ${resetUrl}`);
      if(!sent) console.log('[Email] Reset email was not confirmed as sent by Apps Script.');
    }
    res.json({message:'If that email has an account, a reset link has been sent.'});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/reset-password', async(req,res)=>{
  try{
    const {token,password}=req.body;
    if(!token||!password||password.length<6) return res.status(400).json({error:'Invalid request'});
    const row=await db.get('SELECT * FROM password_reset_tokens WHERE token=? AND used=0',[token]);
    if(!row||row.expires_at<Date.now()) return res.status(400).json({error:'Invalid or expired link'});
    const hash=await bcrypt.hash(password,10);
    await db.run('UPDATE users SET password=? WHERE id=?',[hash,row.user_id]);
    await db.run('UPDATE password_reset_tokens SET used=1 WHERE token=?',[token]);
    res.json({message:'Password updated!'});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── USER ──
app.get('/api/me', authMiddleware, async(req,res)=>{
  await collectOverdueExchangeDebtForUser(req.user.id).catch(()=>{});
  const user=await db.get('SELECT id,name,email,role,CAST(credits AS TEXT) as credits_text,grade,school,on_email_list,bio,popup_access,assistance_access FROM users WHERE id=?',[req.user.id]);
  if(!user) return res.status(404).json({error:'User not found'});
  const safeUser=withSafeCredits(user);
  safeUser.lucky_streak = await getActiveLuckyStreak(req.user.id);
  res.json(safeUser);
});
app.get('/api/assistance/stream', assistanceStreamAuth, async(req,res)=>{
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if(res.flushHeaders) res.flushHeaders();
  const userId = req.user.id;
  const streams = assistanceStreams.get(userId) || new Set();
  streams.add(res);
  assistanceStreams.set(userId, streams);
  writeSse(res, { type:'connected', payload:{ userId }, at:Date.now() });
  const heartbeat = setInterval(()=>res.write(': keep-alive\n\n'), 25000);
  req.on('close', ()=>{
    clearInterval(heartbeat);
    const activeStreams = assistanceStreams.get(userId);
    if(!activeStreams) return;
    activeStreams.delete(res);
    if(!activeStreams.size) assistanceStreams.delete(userId);
  });
});
app.get('/api/assistance/users', authMiddleware, requireAssistanceAccess, async(req,res)=>{
  const users=await db.all("SELECT id,name,role,grade,school FROM users WHERE id!=? ORDER BY role DESC, name ASC",[req.user.id]);
  res.json(users.map(user=>({
    ...user,
    online: !!assistanceStreams.get(user.id)?.size,
  })));
});
app.get('/api/assistance/state', authMiddleware, async(req,res)=>{
  res.json(await getAssistanceStateForUser(req.user.id));
});
app.post('/api/assistance/contacts', authMiddleware, requireAssistanceAccess, async(req,res)=>{
  try{
    const helperUserId = String(req.body.helperUserId || '').trim();
    if(!helperUserId) return res.status(400).json({error:'Choose a helper first'});
    if(helperUserId===req.user.id) return res.status(400).json({error:'You cannot add yourself as a helper'});
    const helper = await db.get('SELECT id FROM users WHERE id=?',[helperUserId]);
    if(!helper) return res.status(404).json({error:'Helper not found'});
    const existing = await db.get('SELECT * FROM assistance_contacts WHERE user_id=? AND helper_user_id=?',[req.user.id, helperUserId]);
    if(existing?.status==='approved') return res.json({success:true});
    if(existing){
      await db.run('UPDATE assistance_contacts SET status=?, created_at=?, approved_at=NULL WHERE id=?',['pending', Date.now(), existing.id]);
      emitAssistance(helperUserId, 'assistance-contact', { kind:'request', contactId:existing.id, fromUserId:req.user.id });
      return res.json({success:true});
    }
    const id = generateId('ac');
    await db.run('INSERT INTO assistance_contacts (id,user_id,helper_user_id,status,created_at,approved_at) VALUES (?,?,?,?,?,NULL)',
      [id, req.user.id, helperUserId, 'pending', Date.now()]);
    emitAssistance(helperUserId, 'assistance-contact', { kind:'request', contactId:id, fromUserId:req.user.id });
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/assistance/contacts/:id/approve', authMiddleware, requireAssistanceAccess, async(req,res)=>{
  try{
    const contact = await db.get('SELECT * FROM assistance_contacts WHERE id=?',[req.params.id]);
    if(!contact) return res.status(404).json({error:'Request not found'});
    if(contact.helper_user_id!==req.user.id) return res.status(403).json({error:'Not your request'});
    await db.run('UPDATE assistance_contacts SET status=?, approved_at=? WHERE id=?',['approved', Date.now(), contact.id]);
    emitAssistance([contact.user_id, contact.helper_user_id], 'assistance-contact', { kind:'approved', contactId:contact.id });
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/assistance/contacts/:id', authMiddleware, requireAssistanceAccess, async(req,res)=>{
  try{
    const contact = await db.get('SELECT * FROM assistance_contacts WHERE id=?',[req.params.id]);
    if(!contact) return res.status(404).json({error:'Request not found'});
    if(contact.user_id!==req.user.id && contact.helper_user_id!==req.user.id)
      return res.status(403).json({error:'Not allowed'});
    await db.run('DELETE FROM assistance_contacts WHERE id=?',[contact.id]);
    emitAssistance([contact.user_id, contact.helper_user_id], 'assistance-contact', { kind:'removed', contactId:contact.id });
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/assistance/sessions', authMiddleware, requireAssistanceAccess, async(req,res)=>{
  try{
    const seniorUserId = String(req.body.seniorUserId || '').trim();
    const mode = ['observe','guide','assist'].includes(req.body.mode) ? req.body.mode : 'assist';
    const guidedMode = toBool(req.body.guidedMode ?? false);
    const voiceEnabled = toBool(req.body.voiceEnabled ?? true);
    const recordingEnabled = toBool(req.body.recordingEnabled ?? true);
    if(!seniorUserId) return res.status(400).json({error:'Choose who you want to help'});
    if(seniorUserId===req.user.id) return res.status(400).json({error:'Use another account as the helper'});
    const seniorUser = await db.get('SELECT id FROM users WHERE id=?',[seniorUserId]);
    if(!seniorUser) return res.status(404).json({error:'User not found'});
    const managedByHelper = true;
    const conflictingSessions = await cleanupStaleAssistanceSessions(
      'senior_user_id=? OR helper_user_id=?',
      [seniorUserId, seniorUserId]
    );
    let liveConflict = null;
    conflictingSessions.forEach(session=>{
      if(!liveConflict) liveConflict = session;
    });
    if(liveConflict) return res.status(400).json({error:'That person is already in an assistance session'});
    const id = generateId('as');
    await db.run(`INSERT INTO assistance_sessions
      (id,senior_user_id,helper_user_id,status,mode,guided_mode,control_enabled,voice_enabled,recording_enabled,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, seniorUserId, req.user.id, managedByHelper?'active':'pending', mode, guidedMode?1:0, managedByHelper?1:0, voiceEnabled?1:0, recordingEnabled?1:0, Date.now()]);
    if(managedByHelper){
      await db.run('UPDATE assistance_sessions SET started_at=? WHERE id=?',[Date.now(), id]);
      await logAssistanceEvent(id, req.user.id, 'session_started', { mode, guidedMode, voiceEnabled, recordingEnabled, autoApproved:true, controlEnabled:true, observerOnly:false });
      emitAssistance([seniorUserId, req.user.id], 'assistance-session', { kind:'started', sessionId:id });
    }else{
      await logAssistanceEvent(id, req.user.id, 'session_requested', { mode, guidedMode, voiceEnabled, recordingEnabled });
      emitAssistance([seniorUserId, req.user.id], 'assistance-session', { kind:'requested', sessionId:id });
    }
    res.json({session:await fetchAssistanceSession(id)});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/assistance/sessions/:id/respond', authMiddleware, requireAssistanceAccess, async(req,res)=>{
  try{
    const approve = toBool(req.body.approve);
    const session = await fetchAssistanceSession(req.params.id);
    if(!session) return res.status(404).json({error:'Session not found'});
    if(session.senior_user_id!==req.user.id) return res.status(403).json({error:'Only the assisted user can approve'});
    if(session.status!=='pending') return res.status(400).json({error:'This request is no longer pending'});
    if(approve){
      await db.run('UPDATE assistance_sessions SET status=?, started_at=? WHERE id=?',['active', Date.now(), session.id]);
      await logAssistanceEvent(session.id, req.user.id, 'session_approved', {});
      await emitAssistanceSessionRefresh(session.id, 'assistance-session', { kind:'approved' });
      return res.json({success:true});
    }
    await db.run('UPDATE assistance_sessions SET status=?, ended_at=?, stop_reason=? WHERE id=?',['stopped', Date.now(), 'declined', session.id]);
    await logAssistanceEvent(session.id, req.user.id, 'session_declined', {});
    await emitAssistanceSessionRefresh(session.id, 'assistance-session', { kind:'declined' });
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/assistance/sessions/:id/stop', authMiddleware, requireAssistanceAccess, async(req,res)=>{
  try{
    const reason = String(req.body.reason || 'stopped').slice(0,140);
    const session = await fetchAssistanceSession(req.params.id);
    if(!session) return res.status(404).json({error:'Session not found'});
    if(session.senior_user_id!==req.user.id && session.helper_user_id!==req.user.id)
      return res.status(403).json({error:'Not your session'});
    if(session.status==='stopped') return res.json({success:true});
    await db.run('UPDATE assistance_sessions SET status=?, ended_at=?, stop_reason=? WHERE id=?',['stopped', Date.now(), reason, session.id]);
    await logAssistanceEvent(session.id, req.user.id, 'session_stopped', { reason });
    await emitAssistanceSessionRefresh(session.id, 'assistance-session', { kind:'stopped', reason });
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/assistance/sessions/:id/mode', authMiddleware, requireAssistanceAccess, async(req,res)=>{
  try{
    const session = await fetchAssistanceSession(req.params.id);
    if(!session) return res.status(404).json({error:'Session not found'});
    if(session.status!=='active') return res.status(400).json({error:'Session is not active'});
    if(session.senior_user_id!==req.user.id && session.helper_user_id!==req.user.id)
      return res.status(403).json({error:'Not your session'});
    const nextMode = ['observe','guide','assist'].includes(req.body.mode) ? req.body.mode : session.mode;
    const guidedMode = req.body.guidedMode===undefined ? session.guided_mode : (toBool(req.body.guidedMode)?1:0);
    const voiceEnabled = req.body.voiceEnabled===undefined ? session.voice_enabled : (toBool(req.body.voiceEnabled)?1:0);
    const recordingEnabled = req.body.recordingEnabled===undefined ? session.recording_enabled : (toBool(req.body.recordingEnabled)?1:0);
    let controlEnabled = session.control_enabled;
    if(req.body.controlEnabled!==undefined){
      if(session.senior_user_id!==req.user.id) return res.status(403).json({error:'Only the assisted user can grant control'});
      controlEnabled = toBool(req.body.controlEnabled) ? 1 : 0;
    }
    await db.run(`UPDATE assistance_sessions
      SET mode=?, guided_mode=?, voice_enabled=?, recording_enabled=?, control_enabled=?
      WHERE id=?`,
      [nextMode, guidedMode, voiceEnabled, recordingEnabled, controlEnabled, session.id]);
    await logAssistanceEvent(session.id, req.user.id, 'mode_changed', {
      mode: nextMode,
      guidedMode: !!guidedMode,
      voiceEnabled: !!voiceEnabled,
      recordingEnabled: !!recordingEnabled,
      controlEnabled: !!controlEnabled,
    });
    await emitAssistanceSessionRefresh(session.id, 'assistance-session', { kind:'mode-changed' });
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/assistance/sessions/:id/event', authMiddleware, requireAssistanceVisibility, async(req,res)=>{
  try{
    const session = await fetchAssistanceSession(req.params.id);
    if(!session) return res.status(404).json({error:'Session not found'});
    if(session.status!=='active') return res.status(400).json({error:'Session is not active'});
    if(session.senior_user_id!==req.user.id && session.helper_user_id!==req.user.id)
      return res.status(403).json({error:'Not your session'});
    const type = String(req.body.type || '').trim();
    const payload = req.body.payload && typeof req.body.payload==='object' ? req.body.payload : {};
    const helperOnlyTypes = new Set(['cursor','highlight','narration','navigate','control_request','click','input','keypress']);
    const seniorOnlyTypes = new Set(['snapshot']);
    const controlTypes = new Set(['click','input','keypress']);
    const transientTypes = new Set(['cursor','snapshot']);
    if(!type) return res.status(400).json({error:'Missing event type'});
    if(helperOnlyTypes.has(type) && session.helper_user_id!==req.user.id)
      return res.status(403).json({error:'Only the helper can send that event'});
    if(seniorOnlyTypes.has(type) && session.senior_user_id!==req.user.id)
      return res.status(403).json({error:'Only the assisted user can send that event'});
    if(controlTypes.has(type) && !session.control_enabled)
      return res.status(403).json({error:'Control has not been granted'});
    const event = transientTypes.has(type)
      ? { id:generateId('ae'), session_id:session.id, actor_user_id:req.user.id, event_type:type, payload, created_at:Date.now() }
      : await logAssistanceEvent(session.id, req.user.id, type, payload);
    emitAssistance([session.senior_user_id, session.helper_user_id], 'assistance-event', {
      sessionId: session.id,
      event,
    });
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/assistance/sessions/:id/recording', authMiddleware, requireAssistanceAccess, async(req,res)=>{
  try{
    const session = await fetchAssistanceSession(req.params.id);
    if(!session) return res.status(404).json({error:'Session not found'});
    if(session.senior_user_id!==req.user.id && session.helper_user_id!==req.user.id && req.user.role!=='admin')
      return res.status(403).json({error:'Not your recording'});
    const events = await db.all(`SELECT e.*,u.name as actor_name
      FROM assistance_events e
      JOIN users u ON u.id=e.actor_user_id
      WHERE e.session_id=?
      ORDER BY e.created_at ASC`, [session.id]);
    res.json({
      session,
      events: events.map(event=>({
        ...event,
        payload: (()=>{ try{return JSON.parse(event.payload||'{}');}catch{return {}; } })(),
      })),
    });
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/users', authMiddleware, adminOnly, async(req,res)=>{
  const users = await db.all("SELECT id,name,email,role,CAST(credits AS TEXT) as credits_text,grade,school,on_email_list,popup_access,assistance_access FROM users WHERE id!=?",[req.user.id]);
  const withLuck = await Promise.all(users.map(async rawUser=>{
    const user=withSafeCredits(rawUser);
    return {
      ...user,
      lucky_streak: await getActiveLuckyStreak(user.id),
    };
  }));
  res.json(withLuck);
});
app.get('/api/admin/exchange', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const overdueBorrowers=await db.all("SELECT DISTINCT borrower_id FROM exchange_loans WHERE lender_id=? AND status IN ('active','overdue') AND due_at<=? AND repaid_amount<repayment_amount",[req.user.id, Date.now()]);
    for(const row of overdueBorrowers){
      await collectOverdueExchangeDebtForUser(row.borrower_id).catch(()=>{});
    }
    res.json(await buildExchangeDashboardData(req.user.id));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/exchange/requests', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const borrowerId=String(req.body.borrowerId||'').trim();
    const amount=Math.floor(Number(req.body.amount));
    const termDays=clampExchangeTermDays(req.body.termDays);
    const note=String(req.body.note||'').trim().slice(0,220);
    if(!borrowerId) return res.status(400).json({error:'Choose who should receive the loan'});
    if(borrowerId===req.user.id) return res.status(400).json({error:'You cannot lend to yourself'});
    if(!amount || amount<1) return res.status(400).json({error:'Enter a valid amount'});
    const [borrower,lender]=await Promise.all([
      db.get("SELECT id,name,role,created_at FROM users WHERE id=? AND role='admin'",[borrowerId]),
      db.get("SELECT id,name,role,CAST(credits AS TEXT) as credits_text FROM users WHERE id=?",[req.user.id]),
    ]);
    if(!borrower || !lender) return res.status(404).json({error:'Borrower or lender not found'});
    if(!isExchangeEligibleUser(borrower)) return res.status(400).json({error:'Accounts must be at least 10 days old to use Exchange'});
    if(toSafeNumber(lender.credits_text,0) < amount) return res.status(400).json({error:'Lender does not have enough credits'});
    await db.run(
      'INSERT INTO exchange_requests (id,borrower_id,lender_id,amount,interest_percent,term_days,note,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [generateId('xrq'), borrowerId, req.user.id, amount, EXCHANGE_INTEREST_PERCENT, termDays, note, 'pending', Date.now()]
    );
    await createNotification(borrowerId,'exchange','Exchange offer pending',`${lender.name||'An admin'} prepared a credit exchange offer worth ⬡${amount.toLocaleString()}.`,'/app/exchange');
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/exchange/requests/:id/approve', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const request=await db.get('SELECT * FROM exchange_requests WHERE id=?',[req.params.id]);
    if(!request) return res.status(404).json({error:'Request not found'});
    if(request.status!=='pending') return res.status(400).json({error:'Request is no longer pending'});
    if(request.lender_id!==req.user.id) return res.status(403).json({error:'This is not your exchange request'});
    const [borrower,lender]=await Promise.all([
      db.get('SELECT id,name FROM users WHERE id=?',[request.borrower_id]),
      db.get('SELECT id,name,CAST(credits AS TEXT) as credits_text FROM users WHERE id=?',[request.lender_id]),
    ]);
    if(!borrower || !lender) return res.status(404).json({error:'Borrower or lender not found'});
    if(toSafeNumber(lender.credits_text,0) < Number(request.amount||0)) return res.status(400).json({error:'Lender no longer has enough credits'});
    const now=Date.now();
    const termDays=clampExchangeTermDays(request.term_days);
    const dueAt=now + termDays * 86400000;
    const loanId=generateId('xln');
    const repaymentAmount=getExchangeRepaymentAmount(request.amount, request.interest_percent);
    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[request.amount, request.lender_id]);
    await db.run('UPDATE users SET credits=credits+? WHERE id=?',[request.amount, request.borrower_id]);
    await db.run(
      'INSERT INTO exchange_loans (id,request_id,borrower_id,lender_id,principal,repayment_amount,interest_percent,repaid_amount,status,created_at,approved_at,due_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [loanId, request.id, request.borrower_id, request.lender_id, request.amount, repaymentAmount, request.interest_percent, 0, 'active', now, now, dueAt, now]
    );
    await db.run("UPDATE exchange_requests SET status='approved', decided_at=?, decided_by=?, loan_id=? WHERE id=?",[now, req.user.id, loanId, request.id]);
    await recordTx(request.lender_id, -Number(request.amount||0), 'exchange_loan_funded', loanId, `Loan funded to ${borrower.name}`);
    await recordTx(request.borrower_id, Number(request.amount||0), 'exchange_loan_received', loanId, `Loan received from ${lender.name}`);
    await createNotification(request.borrower_id,'exchange','Credit request approved',`${lender.name} approved your request for ⬡${Number(request.amount||0).toLocaleString()}. Repay ⬡${repaymentAmount.toLocaleString()} by ${new Date(dueAt).toLocaleString()}.`,'/app/exchange');
    await createNotification(request.lender_id,'exchange','Loan funded',`You funded ⬡${Number(request.amount||0).toLocaleString()} to ${borrower.name}.`,'/app/exchange');
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/exchange/requests/:id/decline', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const request=await db.get('SELECT * FROM exchange_requests WHERE id=?',[req.params.id]);
    if(!request) return res.status(404).json({error:'Request not found'});
    if(request.status!=='pending') return res.status(400).json({error:'Request is no longer pending'});
    if(request.lender_id!==req.user.id) return res.status(403).json({error:'This is not your exchange request'});
    await db.run("UPDATE exchange_requests SET status='declined', decided_at=?, decided_by=? WHERE id=?",[Date.now(), req.user.id, request.id]);
    await createNotification(request.borrower_id,'exchange','Credit request declined','Your exchange request was declined.','/app/exchange');
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/exchange/loans/:id/repay', authMiddleware, adminOnly, async(req,res)=>{
  try{
    await syncExchangeLoanStatuses();
    const amount=Math.floor(Number(req.body.amount));
    const loan=await db.get(`
      SELECT l.*,
        borrower.name as borrower_name,
        lender.name as lender_name,
        CAST(borrower.credits AS TEXT) as borrower_credits_text
      FROM exchange_loans l
      JOIN users borrower ON borrower.id=l.borrower_id
      JOIN users lender ON lender.id=l.lender_id
      WHERE l.id=?
    `,[req.params.id]);
    if(!loan) return res.status(404).json({error:'Loan not found'});
    if(loan.lender_id!==req.user.id) return res.status(403).json({error:'This is not your loan'});
    if(loan.status==='paid') return res.status(400).json({error:'Loan is already paid'});
    if(!amount || amount<1) return res.status(400).json({error:'Enter a repayment amount'});
    const available=toSafeNumber(loan.borrower_credits_text,0);
    if(available<1) return res.status(400).json({error:'Borrower has no available credits'});
    const applied=await applyExchangeRepayment(loan, Math.min(amount, available), 'manual');
    if(!applied) return res.status(400).json({error:'Nothing left to repay'});
    res.json({success:true, applied});
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/popup/users', authMiddleware, async(req,res)=>{
  if(!(await hasPopupTabAccess(req.user.id))) return res.status(403).json({error:'You do not have Pop-up tab access'});
  res.json(await db.all("SELECT id,name,role FROM users WHERE id!=? AND id!='ADMIN' ORDER BY name ASC",[req.user.id]));
});
app.post('/api/users/:id/add-credits', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {amount}=req.body;
    if(!amount||amount<=0) return res.status(400).json({error:'Invalid amount'});
    const actor=await db.get('SELECT id,name FROM users WHERE id=?',[req.user.id]);
    const target=await db.get('SELECT id,name FROM users WHERE id=?',[req.params.id]);
    if(!target) return res.status(404).json({error:'User not found'});
    await db.run('UPDATE users SET credits=credits+? WHERE id=?',[amount,req.params.id]);
    await recordTx(req.params.id,amount,'admin_grant',null,`${actor?.name||actor?.id||req.user.id} added ${amount} to ${target.name||target.id}`);
    res.json(await db.get('SELECT id,name,credits FROM users WHERE id=?',[req.params.id]));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/users/:id/remove-credits', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {amount}=req.body;
    if(!amount||amount<=0) return res.status(400).json({error:'Invalid amount'});
    const actor=await db.get('SELECT id,name FROM users WHERE id=?',[req.user.id]);
    const target=await db.get('SELECT id,name FROM users WHERE id=?',[req.params.id]);
    if(!target) return res.status(404).json({error:'User not found'});
    await db.run('UPDATE users SET credits=MAX(0,credits-?) WHERE id=?',[amount,req.params.id]);
    await recordTx(req.params.id,-amount,'admin_deduct',null,`${actor?.name||actor?.id||req.user.id} removed ${amount} from ${target.name||target.id}`);
    res.json(await db.get('SELECT id,name,credits FROM users WHERE id=?',[req.params.id]));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/users/:id/make-admin', authMiddleware, adminOnly, async(req,res)=>{
  if(!isGrose(req)) return res.status(403).json({error:'Only the primary admin can promote users'});
  await db.run("UPDATE users SET role='admin' WHERE id=?",[req.params.id]);
  res.json({success:true});
});
app.post('/api/users/:id/make-student', authMiddleware, adminOnly, async(req,res)=>{
  if(!isGrose(req)) return res.status(403).json({error:'Only the primary admin can demote users'});
  if(req.params.id==='ADMIN') return res.status(400).json({error:'Cannot demote primary admin'});
  await db.run("UPDATE users SET role='student' WHERE id=?",[req.params.id]);
  res.json({success:true});
});
app.post('/api/users/:id/toggle-email-list', authMiddleware, adminOnly, async(req,res)=>{
  if(!isGrose(req)) return res.status(403).json({error:'Only the primary admin can manage the email list'});
  const user=await db.get('SELECT on_email_list FROM users WHERE id=?',[req.params.id]);
  if(!user) return res.status(404).json({error:'User not found'});
  const newVal=user.on_email_list?0:1;
  await db.run('UPDATE users SET on_email_list=? WHERE id=?',[newVal,req.params.id]);
  res.json({on_email_list:newVal});
});
app.post('/api/users/:id/toggle-popup-access', authMiddleware, adminOnly, async(req,res)=>{
  if(!isGrose(req)) return res.status(403).json({error:'Only the primary admin can manage Pop-up access'});
  if(req.params.id==='ADMIN') return res.status(400).json({error:'The primary admin always has Pop-up access'});
  const user=await db.get('SELECT popup_access FROM users WHERE id=?',[req.params.id]);
  if(!user) return res.status(404).json({error:'User not found'});
  const newVal=user.popup_access?0:1;
  await db.run('UPDATE users SET popup_access=? WHERE id=?',[newVal,req.params.id]);
  popupAdminUnlocks.delete(req.params.id);
  res.json({popup_access:newVal});
});
app.post('/api/users/:id/toggle-assistance-access', authMiddleware, adminOnly, async(req,res)=>{
  if(!isGrose(req)) return res.status(403).json({error:'Only the primary admin can manage Assistance access'});
  if(req.params.id==='ADMIN') return res.status(400).json({error:'The primary admin always has Assistance access'});
  const user=await db.get('SELECT assistance_access FROM users WHERE id=?',[req.params.id]);
  if(!user) return res.status(404).json({error:'User not found'});
  const newVal=user.assistance_access?0:1;
  await db.run('UPDATE users SET assistance_access=? WHERE id=?',[newVal,req.params.id]);
  res.json({assistance_access:newVal});
});
app.post('/api/users/:id/lucky-streak', authMiddleware, requireDesktopCasinoAccess, async(req,res)=>{
  try{
    if(!(await canGrantLuckyStreak(req.user.id))) return res.status(403).json({error:'Only approved admin accounts can grant Lucky Streak'});
    const target=await db.get('SELECT id,name FROM users WHERE id=?',[req.params.id]);
    if(!target) return res.status(404).json({error:'User not found'});
    const boostPercent = 15;
    const expiresAt = Date.now() + (5 * 60 * 1000);
    await db.run(
      'INSERT INTO lucky_streaks (id,user_id,granted_by,boost_percent,expires_at,created_at) VALUES (?,?,?,?,?,?)',
      [generateId('luck'), req.params.id, req.user.id, boostPercent, expiresAt, Date.now()]
    );
    await recordTx(req.params.id,0,'lucky_streak',null,`${req.user.id} granted Lucky Streak (+${boostPercent}% casino odds) for 5 minutes`);
    res.json({success:true, lucky_streak: await getActiveLuckyStreak(req.params.id)});
  }catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/users/:id', authMiddleware, adminOnly, async(req,res)=>{
  const {id}=req.params;
  if(id==='ADMIN') return res.status(400).json({error:'Cannot delete primary admin'});
  await db.run('DELETE FROM bets WHERE user_id=?',[id]);
  await db.run('DELETE FROM transactions WHERE user_id=?',[id]);
  await db.run('DELETE FROM redemptions WHERE user_id=?',[id]);
  await db.run('DELETE FROM stripe_sessions WHERE user_id=?',[id]);
  await db.run('DELETE FROM messages WHERE sender_id=? OR recipient_id=?',[id,id]);
  await db.run('DELETE FROM suggestions WHERE sender_id=?',[id]);
  await db.run('DELETE FROM notifications WHERE user_id=?',[id]);
  await db.run('DELETE FROM post_likes WHERE user_id=?',[id]);
  await db.run('DELETE FROM post_reposts WHERE user_id=?',[id]);
  await db.run('DELETE FROM lucky_streaks WHERE user_id=? OR granted_by=?',[id,id]);
  await db.run('DELETE FROM assistance_events WHERE session_id IN (SELECT id FROM assistance_sessions WHERE senior_user_id=? OR helper_user_id=?)',[id,id]);
  await db.run('DELETE FROM assistance_sessions WHERE senior_user_id=? OR helper_user_id=?',[id,id]);
  await db.run('DELETE FROM assistance_contacts WHERE user_id=? OR helper_user_id=?',[id,id]);
  await db.run('DELETE FROM users WHERE id=?',[id]);
  res.json({success:true});
});

// ── PROFILE ──
app.get('/api/users/:id/profile', authMiddleware, async(req,res)=>{
  try{
    const user=await db.get('SELECT id,name,grade,school,role,credits,bio,on_email_list FROM users WHERE id=? AND on_email_list=1',[req.params.id]);
    if(!user) return res.status(404).json({error:'Profile not found'});
    const betsWon=(await db.get("SELECT COUNT(*) as c FROM bets WHERE user_id=? AND status='won'",[req.params.id])).c;
    const betsTotal=(await db.get("SELECT COUNT(*) as c FROM bets WHERE user_id=?",[req.params.id])).c;
    res.json({...user,betsWon,betsTotal});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── MARKETS ──
app.get('/api/markets', authMiddleware, async(req,res)=>{
  const {category}=req.query;
  res.json(category
    ?await db.all('SELECT * FROM markets WHERE category=? ORDER BY created_at DESC',[category])
    :await db.all('SELECT * FROM markets ORDER BY created_at DESC'));
});
app.get('/api/markets/:id', authMiddleware, async(req,res)=>{
  const m=await db.get('SELECT * FROM markets WHERE id=?',[req.params.id]);
  if(!m) return res.status(404).json({error:'Not found'});
  res.json(m);
});
app.post('/api/markets', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {question,category,closeDate,market_type,line}=req.body;
    if(!question||!closeDate) return res.status(400).json({error:'Missing fields'});
    if(market_type==='overunder'&&(line===undefined||line===null)) return res.status(400).json({error:'Line required'});
    const normalizedCloseDate=normalizeCloseDate(closeDate);
    if(!normalizedCloseDate) return res.status(400).json({error:'Invalid close date'});
    const id=generateId('m');
    if(market_type==='overunder'){
      await db.run(`INSERT INTO markets (id,question,category,status,close_date,yes_shares,no_shares,b_param,pool,created_at,market_type,line,over_shares,under_shares) VALUES (?,?,?,'open',?,0,0,100,0,?,?,?,0,0)`,
        [id,question,category||'Sports',normalizedCloseDate,Date.now(),'overunder',line]);
    } else {
      await db.run(`INSERT INTO markets (id,question,category,status,close_date,yes_shares,no_shares,b_param,pool,created_at,market_type) VALUES (?,?,?,'open',?,0,0,100,0,?,'binary')`,
        [id,question,category||'General',normalizedCloseDate,Date.now()]);
    }
    res.json(await db.get('SELECT * FROM markets WHERE id=?',[id]));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/markets/:id/resolve', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {outcome}=req.body;
    if(!['YES','NO'].includes(outcome)) return res.status(400).json({error:'Bad outcome'});
    const m=await db.get('SELECT * FROM markets WHERE id=?',[req.params.id]);
    if(!m||!['open','closed'].includes(m.status)) return res.status(400).json({error:'Market is already resolved'});
    await db.run('UPDATE markets SET status=? WHERE id=?',[outcome==='YES'?'resolved-yes':'resolved-no',m.id]);
    const wins=await db.all("SELECT * FROM bets WHERE market_id=? AND side=? AND status='active'",[m.id,outcome]);
    const total=wins.reduce((s,b)=>s+b.amount,0);
    for(const b of wins){
      const pay=total>0?Math.round((b.amount/total)*m.pool):0;
      await db.run("UPDATE bets SET status='won',payout=? WHERE id=?",[pay,b.id]);
      await db.run('UPDATE users SET credits=credits+? WHERE id=?',[pay,b.user_id]);
      await recordTx(b.user_id,pay,'bet_won',b.id,`Won: ${m.question}`);
      await createNotification(b.user_id,'bet_win','Bet Won',`${m.question} resolved ${outcome}. You won ⬡${pay}.`,'portfolio');
    }
    await db.run("UPDATE bets SET status='lost' WHERE market_id=? AND side!=? AND status='active'",[m.id,outcome]);
    bumpBetsSnapshotVersion();
    res.json({success:true,outcome,pool:m.pool,wins:wins.map(b=>({id:b.id,user_id:b.user_id,amount:b.amount,payout:Math.round((b.amount/total)*m.pool)}))});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/markets/:id/resolve-overunder', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {actual}=req.body;
    if(actual===undefined) return res.status(400).json({error:'Actual result required'});
    const m=await db.get('SELECT * FROM markets WHERE id=?',[req.params.id]);
    if(!m||!['open','closed'].includes(m.status)) return res.status(400).json({error:'Market is already resolved'});
    const outcome=parseFloat(actual)>parseFloat(m.line)?'OVER':'UNDER';
    await db.run('UPDATE markets SET status=? WHERE id=?',[`resolved-${outcome.toLowerCase()}`,m.id]);
    const wins=await db.all("SELECT * FROM bets WHERE market_id=? AND side=? AND status='active'",[m.id,outcome]);
    const total=wins.reduce((s,b)=>s+b.amount,0);
    for(const b of wins){
      const pay=total>0?Math.round((b.amount/total)*m.pool):0;
      await db.run("UPDATE bets SET status='won',payout=? WHERE id=?",[pay,b.id]);
      await db.run('UPDATE users SET credits=credits+? WHERE id=?',[pay,b.user_id]);
      await recordTx(b.user_id,pay,'bet_won',b.id,`Won O/U: ${m.question}`);
      await createNotification(b.user_id,'bet_win','Bet Won',`${m.question} resolved ${outcome}. You won ⬡${pay}.`,'portfolio');
    }
    await db.run("UPDATE bets SET status='lost' WHERE market_id=? AND side!=? AND status='active'",[m.id,outcome]);
    bumpBetsSnapshotVersion();
    res.json({success:true,outcome,actual,line:m.line});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/markets/:id/close', authMiddleware, adminOnly, async(req,res)=>{
  await db.run("UPDATE markets SET status='closed' WHERE id=?",[req.params.id]);
  bumpBetsSnapshotVersion();
  res.json({success:true});
});
app.post('/api/markets/:id/close-date', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {closeDate}=req.body;
    const normalizedCloseDate=normalizeCloseDate(closeDate);
    if(!normalizedCloseDate) return res.status(400).json({error:'Invalid close date'});
    const market=await db.get('SELECT * FROM markets WHERE id=?',[req.params.id]);
    if(!market) return res.status(404).json({error:'Market not found'});
    if(!['open','closed'].includes(market.status)) return res.status(400).json({error:'Resolved markets cannot be edited'});
    await db.run('UPDATE markets SET close_date=? WHERE id=?',[normalizedCloseDate,req.params.id]);
    bumpBetsSnapshotVersion();
    res.json(await db.get('SELECT * FROM markets WHERE id=?',[req.params.id]));
  }catch(e){res.status(500).json({error:e.message});}
});

app.delete('/api/markets/:id', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const m=await db.get('SELECT id FROM markets WHERE id=?',[req.params.id]);
    if(!m) return res.status(404).json({error:'Market not found'});
    const activeBets=await db.all("SELECT * FROM bets WHERE market_id=? AND status='active'",[req.params.id]);
    for(const b of activeBets){
      await db.run('UPDATE users SET credits=credits+? WHERE id=?',[b.amount,b.user_id]);
      await db.run("UPDATE bets SET status='refunded' WHERE id=?",[b.id]);
      await recordTx(b.user_id,b.amount,'refund',b.id,`Market deleted — refund`);
    }
    await db.run('DELETE FROM markets WHERE id=?',[req.params.id]);
    res.json({success:true, refunded:activeBets.length});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── BETS ──
app.post('/api/bets', authMiddleware, async(req,res)=>{
  try{
    const {marketId,side,amount}=req.body;
    if(!marketId||!side||!amount||amount<=0) return res.status(400).json({error:'Invalid bet'});
    const user=await db.get('SELECT * FROM users WHERE id=?',[req.user.id]);
    if(user.credits<amount) return res.status(400).json({error:'Insufficient credits'});
    const m=await db.get('SELECT * FROM markets WHERE id=?',[marketId]);
    if(!m||m.status!=='open') return res.status(400).json({error:'Market not available'});
    if(isMarketBettingClosed(m)) return res.status(400).json({error:'Betting is closed for this market'});
    if(m.market_type==='overunder'&&!['OVER','UNDER'].includes(side)) return res.status(400).json({error:'Side must be OVER or UNDER'});
    if(m.market_type==='binary'&&!['YES','NO'].includes(side)) return res.status(400).json({error:'Side must be YES or NO'});
    const betCount = await db.get('SELECT COUNT(*) as c FROM bets WHERE user_id=? AND market_id=?', [req.user.id, marketId]);
    if (betCount.c >= 5) return res.status(400).json({ error: 'You can only place up to 5 bets on a single market.' });
    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[amount,user.id]);
    if(m.market_type==='overunder'){
      if(side==='OVER') await db.run('UPDATE markets SET over_shares=over_shares+?,pool=pool+? WHERE id=?',[amount,amount,m.id]);
      else await db.run('UPDATE markets SET under_shares=under_shares+?,pool=pool+? WHERE id=?',[amount,amount,m.id]);
    } else {
      if(side==='YES') await db.run('UPDATE markets SET yes_shares=yes_shares+?,pool=pool+? WHERE id=?',[amount,amount,m.id]);
      else await db.run('UPDATE markets SET no_shares=no_shares+?,pool=pool+? WHERE id=?',[amount,amount,m.id]);
    }
    const betId=generateId('b');
    await db.run("INSERT INTO bets (id,user_id,market_id,side,amount,shares,status,timestamp) VALUES (?,?,?,?,?,?,'active',?)",
      [betId,user.id,marketId,side,amount,amount,Date.now()]);
    await recordTx(user.id,-amount,'bet_placed',betId,`Bet ${side} on: ${m.question}`);
    invalidateBetsMineCache(user.id);
    bumpBetsSnapshotVersion();
    res.json({betId,shares:amount,newBalance:user.credits-amount});
  }catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/bets/mine', authMiddleware, async(req,res)=>{
  const cached = betsMineCache.get(req.user.id);
  if(cached && cached.expiresAt > Date.now() && cached.version === betsSnapshotVersion){
    return res.json(cached.data);
  }
  const data = await db.all(`SELECT b.*,m.question,m.category,m.status as market_status,m.yes_shares,m.no_shares,m.b_param,m.market_type,m.line,m.over_shares,m.under_shares FROM bets b JOIN markets m ON b.market_id=m.id WHERE b.user_id=? ORDER BY b.timestamp DESC`,[req.user.id]);
  betsMineCache.set(req.user.id, { data, expiresAt: Date.now() + BETS_MINE_CACHE_TTL_MS, version: betsSnapshotVersion });
  res.json(data);
});

// ── ONLINE MATCHES ──
app.get('/api/matches', authMiddleware, async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Online matches are private for admin development right now'});
  try{
    const rows=await db.all(`SELECT m.*,
      host.name as host_name,
      guest.name as guest_name
      FROM online_matches m
      JOIN users host ON host.id=m.host_id
      LEFT JOIN users guest ON guest.id=m.guest_id
      WHERE m.status IN ('open','active')
         OR m.host_id=? OR m.guest_id=?
      ORDER BY m.updated_at DESC
      LIMIT 40`, [req.user.id, req.user.id]);
    const game=req.query.game ? String(req.query.game) : '';
    const matches=rows
      .filter(row=>!game || row.game_type===game)
      .map(row=>sanitizeOnlineMatchForUser({ ...row, state:parseMatchState(row.state) }, req.user.id));
    res.json(matches);
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/matches', authMiddleware, async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Online matches are private for admin development right now'});
  try{
    const gameType = ['dreidel','poker'].includes(req.body.gameType) ? req.body.gameType : null;
    const wager = Math.max(1, Math.floor(Number(req.body.wager)||0));
    if(!gameType) return res.status(400).json({error:'Choose a supported game'});
    const user=await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    if(!user||Math.floor(user.credits)<wager) return res.status(400).json({error:'Insufficient credits'});
    const existing=await db.get(`SELECT id FROM online_matches WHERE (host_id=? OR guest_id=?) AND status IN ('open','active') LIMIT 1`, [req.user.id, req.user.id]);
    if(existing) return res.status(400).json({error:'Finish your current online match first'});
    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[wager, req.user.id]);
    await recordTx(req.user.id, -wager, 'online_match_buyin', null, `Opened ${gameType} match`);
    const id=generateId('om');
    const baseState={ phase:'open', log:['Waiting for an opponent.'] };
    await db.run(`INSERT INTO online_matches (id,game_type,host_id,guest_id,status,wager,state,winner_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, gameType, req.user.id, null, 'open', wager, JSON.stringify(baseState), null, Date.now(), Date.now()]);
    res.json(await fetchOnlineMatch(id));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/matches/:id/join', authMiddleware, async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Online matches are private for admin development right now'});
  try{
    const match=await fetchOnlineMatch(req.params.id);
    if(!match) return res.status(404).json({error:'Match not found'});
    if(match.status!=='open') return res.status(400).json({error:'That match is no longer open'});
    if(match.host_id===req.user.id) return res.status(400).json({error:'You cannot join your own match'});
    const existing=await db.get(`SELECT id FROM online_matches WHERE (host_id=? OR guest_id=?) AND status IN ('open','active') LIMIT 1`, [req.user.id, req.user.id]);
    if(existing) return res.status(400).json({error:'Finish your current online match first'});
    const user=await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    if(!user||Math.floor(user.credits)<Number(match.wager||0)) return res.status(400).json({error:'Insufficient credits'});
    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[match.wager, req.user.id]);
    await recordTx(req.user.id, -match.wager, 'online_match_buyin', match.id, `Joined ${match.game_type} match`);
    const state=match.game_type==='dreidel'
      ? makeOnlineDreidelState(match.host_id, req.user.id)
      : makeOnlinePokerState(match.host_id, req.user.id);
    const updated=await saveOnlineMatch(match.id, state, { guest_id:req.user.id, status:'active' });
    res.json(sanitizeOnlineMatchForUser(updated, req.user.id));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/matches/:id/cancel', authMiddleware, async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Online matches are private for admin development right now'});
  try{
    const match=await fetchOnlineMatch(req.params.id);
    if(!match) return res.status(404).json({error:'Match not found'});
    if(match.host_id!==req.user.id) return res.status(403).json({error:'Only the host can cancel'});
    if(match.status!=='open') return res.status(400).json({error:'Only open lobbies can be cancelled'});
    await db.run('UPDATE users SET credits=credits+? WHERE id=?',[match.wager, req.user.id]);
    await recordTx(req.user.id, match.wager, 'online_match_refund', match.id, `Cancelled ${match.game_type} lobby`);
    const updated=await saveOnlineMatch(match.id, { ...match.state, phase:'cancelled' }, { status:'cancelled' });
    res.json(updated);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/matches/:id', authMiddleware, async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Online matches are private for admin development right now'});
  try{
    const match=await fetchOnlineMatch(req.params.id);
    if(!match) return res.status(404).json({error:'Match not found'});
    if(match.host_id!==req.user.id && match.guest_id!==req.user.id) return res.status(403).json({error:'Not your match'});
    res.json(sanitizeOnlineMatchForUser(match, req.user.id));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/matches/:id/action', authMiddleware, async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Online matches are private for admin development right now'});
  try{
    let match=await fetchOnlineMatch(req.params.id);
    if(!match) return res.status(404).json({error:'Match not found'});
    if(match.host_id!==req.user.id && match.guest_id!==req.user.id) return res.status(403).json({error:'Not your match'});
    if(match.status!=='active') return res.status(400).json({error:'This match is not active'});
    const action=String(req.body.action||'').trim();
    const state=match.state||{};
    if(match.game_type==='dreidel'){
      if(action!=='spin') return res.status(400).json({error:'Unsupported dreidel action'});
      const spins=['N','G','H','S'];
      const spin=spins[Math.floor(Math.random()*spins.length)];
      applyDreidelSpin(state, req.user.id, spin);
      match=await saveOnlineMatch(match.id, state);
      if(state.phase==='finished'){
        match.state=state;
        match=await settleOnlineMatch(match, state.winnerId||null);
      }
      return res.json(sanitizeOnlineMatchForUser(match, req.user.id));
    }
    if(match.game_type==='poker'){
      if(action!=='draw') return res.status(400).json({error:'Unsupported poker action'});
      applyPokerDraw(state, req.user.id, req.body.discardIndexes||[]);
      match=await saveOnlineMatch(match.id, state);
      if(state.phase==='finished'){
        match.state=state;
        match=await settleOnlineMatch(match, state.winnerId||null);
      }
      return res.json(sanitizeOnlineMatchForUser(match, req.user.id));
    }
    res.status(400).json({error:'Unknown game'});
  }catch(e){res.status(400).json({error:e.message});}
});

// ── LEADERBOARD ──
app.get('/api/leaderboard', authMiddleware, async(req,res)=>{
  try{
    const cached = getFreshCache(leaderboardCache);
    if(cached) return res.json(cached);
    const rows=await db.all("SELECT id,name,grade,school,CAST(credits AS TEXT) as credits_text,on_email_list FROM users WHERE role='student' ORDER BY credits DESC");
    res.json(setCacheValue(leaderboardCache, rows.map(withSafeCredits), LEADERBOARD_CACHE_TTL_MS));
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

// ── STORE ──
app.get('/api/store', authMiddleware, async(req,res)=>{
  const cached = getFreshCache(storeCache);
  if(cached) return res.json(cached);
  res.json(setCacheValue(storeCache, await db.all('SELECT * FROM store_items'), STORE_CACHE_TTL_MS));
});
app.post('/api/store', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {name,icon,cost,description}=req.body;
    if(!name||!cost) return res.status(400).json({error:'Missing fields'});
    const id=generateId('s');
    await db.run('INSERT INTO store_items (id,name,icon,cost,description) VALUES (?,?,?,?,?)',[id,name,icon||'🎁',cost,description||'']);
    storeCache = { data: null, expiresAt: 0 };
    res.json(await db.get('SELECT * FROM store_items WHERE id=?',[id]));
  }catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/store/:id', authMiddleware, adminOnly, async(req,res)=>{
  await db.run('DELETE FROM store_items WHERE id=?',[req.params.id]);
  storeCache = { data: null, expiresAt: 0 };
  res.json({success:true});
});
app.post('/api/store/:id/redeem', authMiddleware, async(req,res)=>{
  try{
    const item=await db.get('SELECT * FROM store_items WHERE id=?',[req.params.id]);
    if(!item) return res.status(404).json({error:'Item not found'});
    const user=await db.get('SELECT * FROM users WHERE id=?',[req.user.id]);
    if(user.credits<item.cost) return res.status(400).json({error:'Insufficient credits'});
    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[item.cost,user.id]);
    const rId=generateId('r');
    await db.run('INSERT INTO redemptions (id,user_id,item_id,cost,timestamp) VALUES (?,?,?,?,?)',[rId,user.id,item.id,item.cost,Date.now()]);
    await recordTx(user.id,-item.cost,'redemption',rId,`Redeemed: ${item.name}`);
    res.json({newBalance:user.credits-item.cost});
  }catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/store/redemptions/mine', authMiddleware, async(req,res)=>{
  res.json(await db.all(`SELECT r.*,s.name,s.icon FROM redemptions r JOIN store_items s ON r.item_id=s.id WHERE r.user_id=? ORDER BY r.timestamp DESC`,[req.user.id]));
});

// ── MESSAGES ──
app.post('/api/messages', authMiddleware, async(req,res)=>{
  try{
    const {recipientId,text}=req.body;
    if(!recipientId||!text||!text.trim()) return res.status(400).json({error:'Missing fields'});
    const recipient=await db.get('SELECT id FROM users WHERE id=?',[recipientId]);
    if(!recipient) return res.status(404).json({error:'User not found'});
    const id=generateId('msg');
    await db.run('INSERT INTO messages (id,sender_id,recipient_id,text,is_read,timestamp) VALUES (?,?,?,?,0,?)',
      [id,req.user.id,recipientId,text.trim(),Date.now()]);
    await createNotification(recipientId,'message','New Message',`${req.user.name||req.user.id}: ${text.trim().slice(0,120)}`,'messages');
    res.json({id,success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/messages/conversations', authMiddleware, async(req,res)=>{
  try{
    const rows=await db.all(`
      WITH scoped_messages AS (
        SELECT
          CASE WHEN sender_id=? THEN recipient_id ELSE sender_id END AS other_id,
          id,
          sender_id,
          recipient_id,
          text,
          is_read,
          timestamp,
          ROW_NUMBER() OVER (
            PARTITION BY CASE WHEN sender_id=? THEN recipient_id ELSE sender_id END
            ORDER BY timestamp DESC, id DESC
          ) AS rn
        FROM messages
        WHERE sender_id=? OR recipient_id=?
      ),
      unread_counts AS (
        SELECT sender_id AS other_id, COUNT(*) AS unread_count
        FROM messages
        WHERE recipient_id=? AND is_read=0
        GROUP BY sender_id
      )
      SELECT
        u.id AS other_id,
        u.name AS other_name,
        u.grade AS other_grade,
        u.role AS other_role,
        s.id AS message_id,
        s.sender_id,
        s.recipient_id,
        s.text,
        s.is_read,
        s.timestamp,
        COALESCE(unread_counts.unread_count, 0) AS unread_count
      FROM scoped_messages s
      JOIN users u ON u.id=s.other_id
      LEFT JOIN unread_counts ON unread_counts.other_id=s.other_id
      WHERE s.rn=1
      ORDER BY s.timestamp DESC, s.id DESC
    `,[req.user.id,req.user.id,req.user.id,req.user.id,req.user.id]);
    const conversations=rows.map(row=>({
      other:{
        id:row.other_id,
        name:row.other_name,
        grade:row.other_grade,
        role:row.other_role,
      },
      lastMessage:{
        id:row.message_id,
        sender_id:row.sender_id,
        recipient_id:row.recipient_id,
        text:row.text,
        is_read:row.is_read,
        timestamp:row.timestamp,
      },
      unreadCount:row.unread_count||0,
    }));
    res.json(conversations);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/messages/thread/:userId', authMiddleware, async(req,res)=>{
  try{
    const other=req.params.userId;
    const messages=await db.all(`SELECT m.*,u.name as sender_name FROM messages m JOIN users u ON m.sender_id=u.id WHERE (m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?) ORDER BY m.timestamp ASC`,
      [req.user.id,other,other,req.user.id]);
    await db.run('UPDATE messages SET is_read=1 WHERE sender_id=? AND recipient_id=?',[other,req.user.id]);
    res.json(messages);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/messages/unread-count', authMiddleware, async(req,res)=>{
  const row=await db.get('SELECT COUNT(*) as c FROM messages WHERE recipient_id=? AND is_read=0',[req.user.id]);
  res.json({count:row.c});
});
app.get('/api/messages/users', authMiddleware, async(req,res)=>{
  let users = getFreshCache(messageUsersCache);
  if(!users){
    users = await db.all("SELECT id,name,grade,school,role FROM users ORDER BY name ASC");
    setCacheValue(messageUsersCache, users, MESSAGES_USERS_CACHE_TTL_MS);
  }
  res.json(users.filter(user=>user.id!==req.user.id));
});

// ── SUGGESTIONS ──
app.get('/api/suggestions', authMiddleware, async(req,res)=>{
  try{
    if(isAdminUser(req.user)){
      const received = await db.all(`SELECT s.*,u.name as sender_name,u.role as sender_role
        FROM suggestions s
        JOIN users u ON u.id=s.sender_id
        ORDER BY s.timestamp DESC
        LIMIT 100`);
      return res.json({received, sent:[]});
    }
    const sent = await db.all(`SELECT s.*,u.name as sender_name,u.role as sender_role
      FROM suggestions s
      JOIN users u ON u.id=s.sender_id
      WHERE s.sender_id=?
      ORDER BY s.timestamp DESC
      LIMIT 50`, [req.user.id]);
    res.json({received:[], sent});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/suggestions', authMiddleware, async(req,res)=>{
  try{
    const text = String(req.body.text || '').trim();
    if(!text) return res.status(400).json({error:'Write a suggestion first'});
    if(text.length > 1000) return res.status(400).json({error:'Suggestion is too long'});
    const dayStart = new Date();
    dayStart.setHours(0,0,0,0);
    const sentToday = await db.get('SELECT COUNT(*) as c FROM suggestions WHERE sender_id=? AND timestamp>=?',[req.user.id, dayStart.getTime()]);
    if((sentToday?.c||0) >= 2) return res.status(429).json({error:'Daily limit reached. You can send up to 2 suggestions per day.'});
    const id = generateId('sug');
    const timestamp = Date.now();
    await db.run('INSERT INTO suggestions (id,sender_id,text,timestamp) VALUES (?,?,?,?)',[id, req.user.id, text, timestamp]);
    res.json({
      success:true,
      suggestion:{
        id,
        sender_id:req.user.id,
        sender_name:req.user.name,
        sender_role:req.user.role,
        text,
        timestamp,
      }
    });
  }catch(e){res.status(500).json({error:e.message});}
});

// ── NOTIFICATIONS ──
app.get('/api/notifications', authMiddleware, async(req,res)=>{
  try{
    const version = getNotificationVersion(req.user.id);
    const cached = notificationsListCache.get(req.user.id);
    if(cached && cached.expiresAt > Date.now() && cached.version === version){
      return res.json(cached.data);
    }
    const items = await db.all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100',[req.user.id]);
    const unread = await db.get('SELECT COUNT(*) as c FROM notifications WHERE user_id=? AND is_read=0',[req.user.id]);
    const data = {items, unreadCount:unread?.c||0};
    notificationsListCache.set(req.user.id, { data, expiresAt: Date.now() + NOTIFICATIONS_CACHE_TTL_MS, version });
    res.json(data);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/notifications/unread-count', authMiddleware, async(req,res)=>{
  try{
    const version = getNotificationVersion(req.user.id);
    const cached = notificationsUnreadCache.get(req.user.id);
    if(cached && cached.expiresAt > Date.now() && cached.version === version){
      return res.json(cached.data);
    }
    const unread = await db.get('SELECT COUNT(*) as c FROM notifications WHERE user_id=? AND is_read=0',[req.user.id]);
    const data = {unreadCount:unread?.c||0};
    notificationsUnreadCache.set(req.user.id, { data, expiresAt: Date.now() + NOTIFICATIONS_CACHE_TTL_MS, version });
    res.json(data);
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/notifications/read-all', authMiddleware, async(req,res)=>{
  try{
    await db.run('UPDATE notifications SET is_read=1 WHERE user_id=?',[req.user.id]);
    bumpNotificationVersion(req.user.id);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/notifications/:id/read', authMiddleware, async(req,res)=>{
  try{
    await db.run('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?',[req.params.id, req.user.id]);
    bumpNotificationVersion(req.user.id);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── POSTS / FEED ──
app.get('/api/feed', authMiddleware, async(req,res)=>{
  try{
    const posts = await db.all(`SELECT p.*,u.name as author_name,u.role as author_role FROM posts p JOIN users u ON p.user_id=u.id ORDER BY p.timestamp DESC LIMIT 50`);
    if(!posts.length) return res.json([]);
    const postIds = posts.map(post=>post.id);
    const placeholders = postIds.map(()=>'?').join(',');
    const [allLikes, likedRows] = await Promise.all([
      db.all(`SELECT post_id, COUNT(*) as c FROM post_likes WHERE post_id IN (${placeholders}) GROUP BY post_id`, postIds),
      db.all(`SELECT post_id FROM post_likes WHERE user_id=? AND post_id IN (${placeholders})`, [req.user.id, ...postIds]),
    ]);

    const userLikes=new Set(likedRows.map(r=>r.post_id));
    const likeCounts=Object.fromEntries(allLikes.map(r=>[r.post_id,r.c]));

    const feed=posts.map(p=>({
      ...p,
      feed_type:'post',
      feed_time:p.timestamp,
      like_count:likeCounts[p.id]||0,
      user_liked:userLikes.has(p.id),
    }));

    res.json(feed);
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/posts', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {caption,image}=req.body;
    if(!caption||!caption.trim()) return res.status(400).json({error:'Caption required'});
    if(image&&image.length>2800000) return res.status(400).json({error:'Image too large'});
    const id=generateId('post');
    await db.run('INSERT INTO posts (id,user_id,caption,image,timestamp,repost_count) VALUES (?,?,?,?,?,0)',
      [id,req.user.id,caption.trim(),image||null,Date.now()]);
    const recipients = await db.all('SELECT id FROM users WHERE id!=?',[req.user.id]);
    for(const recipient of recipients){
      await createNotification(recipient.id,'sclgram_post','New SclGram Post',`${req.user.name||req.user.id} posted: ${caption.trim().slice(0,120)}`,'feed');
    }
    res.json(await db.get('SELECT * FROM posts WHERE id=?',[id]));
  }catch(e){res.status(500).json({error:e.message});}
});

app.delete('/api/posts/:id', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const id=req.params.id;
    await db.run('DELETE FROM post_likes WHERE post_id=?',[id]);
    await db.run('DELETE FROM post_reposts WHERE post_id=?',[id]);
    await db.run('DELETE FROM posts WHERE id=?',[id]);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/posts/:id/like', authMiddleware, async(req,res)=>{
  try{
    const post = await db.get('SELECT p.id,p.user_id,p.caption,u.name as author_name FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?',[req.params.id]);
    if(!post) return res.status(404).json({error:'Post not found'});
    const existing=await db.get('SELECT id FROM post_likes WHERE post_id=? AND user_id=?',[req.params.id,req.user.id]);
    if(existing){
      await db.run('DELETE FROM post_likes WHERE post_id=? AND user_id=?',[req.params.id,req.user.id]);
      res.json({liked:false});
    } else {
      await db.run('INSERT INTO post_likes (id,post_id,user_id,timestamp) VALUES (?,?,?,?)',
        [generateId('lk'),req.params.id,req.user.id,Date.now()]);
      if(post.user_id!==req.user.id){
        await createNotification(post.user_id,'sclgram_like','SclGram Like',`${req.user.name||req.user.id} liked your post: ${String(post.caption||'').slice(0,120)}`,'feed');
      }
      res.json({liked:true});
    }
  }catch(e){res.status(500).json({error:e.message});}
});

// ── ADMIN ──
app.post('/api/admin/distribute-credits', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {amount}=req.body;
    if(!amount||amount<=0) return res.status(400).json({error:'Invalid amount'});
    const students=await db.all("SELECT id FROM users WHERE role='student'");
    for(const s of students){
      await db.run('UPDATE users SET credits=credits+? WHERE id=?',[amount,s.id]);
      await recordTx(s.id,amount,'weekly_distribution',null,`Weekly: +${amount}`);
    }
    res.json({distributed:students.length});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/volunteer-rate', authMiddleware, adminOnly, async(req,res)=>{
  const {rate}=req.body;
  if(!rate||rate<=0) return res.status(400).json({error:'Invalid rate'});
  await db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('volunteer_rate',?)",[String(rate)]);
  res.json({rate});
});
app.get('/api/admin/volunteer-rate', authMiddleware, async(req,res)=>{
  const row=await db.get("SELECT value FROM settings WHERE key='volunteer_rate'");
  res.json({rate:parseInt(row?.value||'100')});
});
app.get('/api/admin/transactions', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const search = String(req.query.search || '').trim();
    const limit = parsePage(req.query.limit, 100, 20, 500);
    const offset = parsePage(req.query.offset, 0, 0, 100000);
    const cacheKey = getAdminCacheKey(search, limit, offset);
    const cached = adminTransactionsCache.get(cacheKey);
    if(cached && cached.expiresAt > Date.now()) return res.json(cached.data);
    if(search){
      const like = `%${search}%`;
      const items = await db.all(
        `SELECT t.*,u.name as user_name
         FROM transactions t
         JOIN users u ON t.user_id=u.id
         WHERE LOWER(t.user_id) LIKE LOWER(?) OR LOWER(COALESCE(u.name,'')) LIKE LOWER(?) OR LOWER(COALESCE(t.description,'')) LIKE LOWER(?) OR LOWER(COALESCE(t.type,'')) LIKE LOWER(?)
         ORDER BY t.timestamp DESC
         LIMIT ? OFFSET ?`,
        [like,like,like,like,limit,offset]
      );
      const totalRow = await db.get(
        `SELECT COUNT(*) as c
         FROM transactions t
         JOIN users u ON t.user_id=u.id
         WHERE LOWER(t.user_id) LIKE LOWER(?) OR LOWER(COALESCE(u.name,'')) LIKE LOWER(?) OR LOWER(COALESCE(t.description,'')) LIKE LOWER(?) OR LOWER(COALESCE(t.type,'')) LIKE LOWER(?)`,
        [like,like,like,like]
      );
      const data = {items,total:totalRow?.c||0,hasMore:offset + items.length < (totalRow?.c||0)};
      adminTransactionsCache.set(cacheKey, { data, expiresAt: Date.now() + ADMIN_LIST_CACHE_TTL_MS });
      return res.json(data);
    }
    const items = await db.all(
      `SELECT t.*,u.name as user_name
       FROM transactions t
       JOIN users u ON t.user_id=u.id
       ORDER BY t.timestamp DESC
       LIMIT ? OFFSET ?`,
      [limit,offset]
    );
    const totalRow = await db.get(`SELECT COUNT(*) as c FROM transactions`);
    const data = {items,total:totalRow?.c||0,hasMore:offset + items.length < (totalRow?.c||0)};
    adminTransactionsCache.set(cacheKey, { data, expiresAt: Date.now() + ADMIN_LIST_CACHE_TTL_MS });
    res.json(data);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/admin/stats', authMiddleware, adminOnly, async(req,res)=>{
  const students=(await db.get("SELECT COUNT(*) as c FROM users WHERE role='student'")).c;
  const openMarkets=(await db.get("SELECT COUNT(*) as c FROM markets WHERE status='open'")).c;
  const totalBets=(await db.get('SELECT COUNT(*) as c FROM bets')).c;
  const circ=toSafeNumber((await db.get("SELECT CAST(SUM(credits) AS TEXT) as s FROM users WHERE role='student'")).s,0);
  res.json({
    students,
    openMarkets,
    totalBets,
    pendingVol:0,
    totalCreditsInCirculation:circ,
    mailConfigured:!!process.env.APPS_SCRIPT_URL,
  });
});

app.post('/api/admin/send-digest', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const emailUsers=await db.all("SELECT email,name FROM users WHERE on_email_list=1 AND role='student'");
    if(!emailUsers.length) return res.status(400).json({error:'No users on email list yet'});
    const [leaderboard,markets,bigWins,creditsRow,accessRow]=await Promise.all([
      db.all("SELECT id,name,CAST(credits AS TEXT) as credits_text FROM users WHERE role='student' ORDER BY credits DESC LIMIT 5"),
      db.all("SELECT * FROM markets WHERE status='open' ORDER BY created_at DESC"),
      db.all(`SELECT b.payout,u.name,m.question FROM bets b JOIN users u ON b.user_id=u.id JOIN markets m ON b.market_id=m.id WHERE b.status='won' AND b.payout>100 ORDER BY b.payout DESC LIMIT 3`),
      db.get("SELECT SUM(amount) as s FROM transactions WHERE type='weekly_distribution'"),
      db.get("SELECT value FROM settings WHERE key='access_password'"),
    ]);
    const newUsersCount=(await db.get("SELECT COUNT(*) as c FROM users WHERE role='student'")).c;
    const payload={
      emails:emailUsers.map(u=>({email:u.email,name:u.name})),
      leaderboard:leaderboard.map(withSafeCredits),
      markets:markets.map(m=>({
        question:m.question,
        pct:m.market_type==='overunder'?`OVER ${getOverPercent(m)}%`:`YES ${getYesPercent(m)}%`,
        pool:m.pool||0,
        closeDate:m.close_date,
        line:m.line||null,
        market_type:m.market_type,
      })),
      bigWins,
      newUsers:newUsersCount||0,
      creditsDistributed:creditsRow?.s||0,
      accessPassword:accessRow?.value||'',
      siteUrl:CLIENT_URL,
    };
    const sent=await sendViaAppsScript('weekly_digest',payload);
    res.json({success:true,sent});
  }catch(e){console.error('Digest error:',e);res.status(500).json({error:e.message});}
});

app.get('/api/casino/config', authMiddleware, async(req,res)=>{
  try{
    res.json(await getCasinoConfig(req.user.id));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/casino/config', authMiddleware, adminOnly, async(req,res)=>{
  try{
    if(!isGrose(req)) return res.status(403).json({error:'Only the primary admin can update casino odds'});
    const diceOdds = clampNumber(Math.round(Number(req.body.diceOdds ?? 100)), 0, 200);
    const plinkoOdds = clampNumber(Math.round(Number(req.body.plinkoOdds ?? 100)), 0, 200);
    const blackjackOdds = clampNumber(Math.round(Number(req.body.blackjackOdds ?? 100)), 0, 200);
    const minesOdds = clampNumber(Math.round(Number(req.body.minesOdds ?? 100)), 0, 200);
    const rouletteOdds = clampNumber(Math.round(Number(req.body.rouletteOdds ?? 100)), 0, 200);
    const coinflipOdds = clampNumber(Math.round(Number(req.body.coinflipOdds ?? 100)), 0, 200);
    await db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('casino_dice_odds',?)",[String(diceOdds)]);
    await db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('casino_plinko_odds',?)",[String(plinkoOdds)]);
    await db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('casino_blackjack_odds',?)",[String(blackjackOdds)]);
    await db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('casino_mines_odds',?)",[String(minesOdds)]);
    await db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('casino_roulette_odds',?)",[String(rouletteOdds)]);
    await db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('casino_coinflip_odds',?)",[String(coinflipOdds)]);
    res.json(await getCasinoConfig());
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/admin/casino/reset-stats', authMiddleware, adminOnly, async(req,res)=>{
  try{
    if(!isGrose(req)) return res.status(403).json({error:'Only the primary admin can reset casino stats'});
    const stats = await db.get(`SELECT COALESCE(SUM(bet_amount),0) as total_wagered, COALESCE(SUM(profit),0) as house_profit FROM casino_bets`);
    const baselineWagered = Number(stats?.total_wagered || 0);
    const baselineProfit = Number(stats?.house_profit || 0);
    await db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('casino_stats_baseline_wagered',?)",[String(baselineWagered)]);
    await db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('casino_stats_baseline_profit',?)",[String(baselineProfit)]);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});


// ── CANCEL BET ──
app.post('/api/bets/:id/cancel', authMiddleware, async(req,res)=>{
  try{
    const bet=await db.get('SELECT * FROM bets WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
    if(!bet) return res.status(404).json({error:'Bet not found'});
    if(bet.status!=='active') return res.status(400).json({error:'Bet is no longer active'});
    const age=Date.now()-bet.timestamp;
    if(age>300000) return res.status(400).json({error:'Cancellation window has expired (5 minutes)'});
    const m=await db.get('SELECT * FROM markets WHERE id=?',[bet.market_id]);
    if(!m||m.status!=='open') return res.status(400).json({error:'Market is no longer open'});
    const fee=Math.round(bet.amount*0.05);
    const refund=bet.amount-fee;
    await db.run('UPDATE users SET credits=credits+? WHERE id=?',[refund,req.user.id]);
    await db.run("UPDATE bets SET status='cancelled' WHERE id=?",[bet.id]);
    if(m.market_type==='overunder'){
      if(bet.side==='OVER') await db.run('UPDATE markets SET over_shares=over_shares-?,pool=pool-? WHERE id=?',[bet.amount,refund,m.id]);
      else await db.run('UPDATE markets SET under_shares=under_shares-?,pool=pool-? WHERE id=?',[bet.amount,refund,m.id]);
    } else {
      if(bet.side==='YES') await db.run('UPDATE markets SET yes_shares=yes_shares-?,pool=pool-? WHERE id=?',[bet.amount,refund,m.id]);
      else await db.run('UPDATE markets SET no_shares=no_shares-?,pool=pool-? WHERE id=?',[bet.amount,refund,m.id]);
    }
    await recordTx(req.user.id,refund,'bet_cancelled',bet.id,`Cancelled bet on: ${m.question} (5% fee kept)`);
    invalidateBetsMineCache(req.user.id);
    bumpBetsSnapshotVersion();
    res.json({success:true,refund,fee});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── DAILY SPIN ROUTES ──
app.get('/api/spin/status', authMiddleware, async(req,res)=>{
  try{
    const last=await db.get('SELECT timestamp FROM spin_log WHERE user_id=? ORDER BY timestamp DESC LIMIT 1',[req.user.id]);
    if(!last) return res.json({canSpin:true,nextSpin:null});
    const midnight=new Date();
    midnight.setUTCHours(0,0,0,0);
    const canSpin=last.timestamp<midnight.getTime();
    const next=canSpin?null:new Date(midnight.getTime()+86400000).getTime();
    res.json({canSpin,nextSpin:next});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── CASINO ──
app.post('/api/casino/blackjack/deal', authMiddleware, async(req,res)=>{
  try{
    const amount=Math.floor(Number(req.body.betAmount));
    if(!amount || amount<1) return res.status(400).json({error:'Minimum bet is ⬡1'});
    const existingGame=getActiveBlackjackGame(req.user.id);
    if(existingGame) return res.status(400).json({error:'Finish your current blackjack hand first'});
    const user=await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    if(Math.floor(user.credits)<amount) return res.status(400).json({error:'Insufficient credits'});

    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[amount,req.user.id]);
    const deck=makeDeck();
    const playerHand=[deck.pop(),deck.pop()];
    const dealerCards=[deck.pop(),deck.pop()];
    const game={
      deck,
      dealerCards,
      playerHands:[playerHand],
      bets:[amount],
      activeHand:0,
      results:[],
      done:false,
    };
    blackjackGames.set(req.user.id,game);

    const updated=await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    if(isBlackjack(playerHand)){
      const result=await finishBlackjackGame(req.user.id);
      return res.json(result);
    }

    res.json({
      state:getVisibleBlackjackState(game),
      canSplit:canSplitHand(playerHand),
      canDouble:Math.floor(updated.credits)>=amount,
      newBalance:Math.floor(updated.credits),
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/casino/blackjack/hit', authMiddleware, async(req,res)=>{
  try{
    const game=getActiveBlackjackGame(req.user.id);
    if(!game) return res.status(400).json({error:'No active blackjack game'});

    const hand=getCurrentHand(game);
    hand.push(game.deck.pop());
    if(handTotal(hand)>21){
      game.results[game.activeHand]='bust';
      while(game.activeHand<game.playerHands.length && game.results[game.activeHand]) game.activeHand++;
      if(game.activeHand>=game.playerHands.length){
        return res.json(await finishBlackjackGame(req.user.id));
      }
    }

    res.json({state:getVisibleBlackjackState(game)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/casino/blackjack/stand', authMiddleware, async(req,res)=>{
  try{
    const game=getActiveBlackjackGame(req.user.id);
    if(!game) return res.status(400).json({error:'No active blackjack game'});

    while(game.activeHand<game.playerHands.length && game.results[game.activeHand]) game.activeHand++;
    if(game.activeHand<game.playerHands.length) game.activeHand++;
    while(game.activeHand<game.playerHands.length && game.results[game.activeHand]) game.activeHand++;

    if(game.activeHand>=game.playerHands.length){
      return res.json(await finishBlackjackGame(req.user.id));
    }

    const currentBet=game.bets[game.activeHand];
    const user=await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    res.json({
      state:getVisibleBlackjackState(game),
      nextHand:true,
      canSplit:canSplitHand(getCurrentHand(game)),
      canDouble:Math.floor(user.credits)>=currentBet,
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/casino/blackjack/double', authMiddleware, async(req,res)=>{
  try{
    const game=getActiveBlackjackGame(req.user.id);
    if(!game) return res.status(400).json({error:'No active blackjack game'});
    const hand=getCurrentHand(game);
    const extraBet=game.bets[game.activeHand];
    if(hand.length!==2) return res.status(400).json({error:'Can only double on first two cards'});

    const user=await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    if(Math.floor(user.credits)<extraBet) return res.status(400).json({error:'Insufficient credits'});

    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[extraBet,req.user.id]);
    game.bets[game.activeHand]+=extraBet;
    hand.push(game.deck.pop());
    if(handTotal(hand)>21) game.results[game.activeHand]='bust';
    game.activeHand++;
    while(game.activeHand<game.playerHands.length && game.results[game.activeHand]) game.activeHand++;

    if(game.activeHand>=game.playerHands.length){
      return res.json(await finishBlackjackGame(req.user.id));
    }

    const updated=await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    res.json({
      state:getVisibleBlackjackState(game),
      newBalance:Math.floor(updated.credits),
      canSplit:canSplitHand(getCurrentHand(game)),
      canDouble:Math.floor(updated.credits)>=game.bets[game.activeHand],
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/casino/blackjack/split', authMiddleware, async(req,res)=>{
  try{
    const game=getActiveBlackjackGame(req.user.id);
    if(!game) return res.status(400).json({error:'No active blackjack game'});
    const hand=getCurrentHand(game);
    if(!canSplitHand(hand)) return res.status(400).json({error:'Hand cannot be split'});
    if(game.playerHands.length>=4) return res.status(400).json({error:'Maximum number of split hands reached'});

    const extraBet=game.bets[game.activeHand];
    const user=await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    if(Math.floor(user.credits)<extraBet) return res.status(400).json({error:'Insufficient credits'});

    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[extraBet,req.user.id]);
    const [first,second]=hand;
    const newHandA=[first, game.deck.pop()];
    const newHandB=[second, game.deck.pop()];
    game.playerHands.splice(game.activeHand,1,newHandA,newHandB);
    game.bets.splice(game.activeHand,1,extraBet,extraBet);
    game.results.splice(game.activeHand,1,'','');

    const updated=await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    res.json({
      state:getVisibleBlackjackState(game),
      newBalance:Math.floor(updated.credits),
      canSplit:canSplitHand(getCurrentHand(game)),
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/casino/dice', authMiddleware, async(req,res)=>{
  try{
    const {betAmount, target, direction} = req.body;
    const amount = Math.floor(Number(betAmount));
    const visibleTarget = Number(target);
    if(!amount || amount < 1) return res.status(400).json({error:'Minimum bet is ⬡1'});
    if(!['over','under'].includes(direction)) return res.status(400).json({error:'Invalid direction'});
    if(target===undefined||visibleTarget<2||visibleTarget>98) return res.status(400).json({error:'Target must be between 2 and 98'});
    const user = await db.get('SELECT * FROM users WHERE id=?',[req.user.id]);
    if(Math.floor(user.credits) < amount) return res.status(400).json({error:'Insufficient credits'});
    const { effective } = await getCasinoConfig(req.user.id);
    const diceOdds = effective.diceOdds;
    const oddsBias = ((diceOdds - 100) / 100) * 10;
    const adjustedTarget = direction==='over'
      ? clampNumber(visibleTarget - oddsBias, 2, 98)
      : clampNumber(visibleTarget + oddsBias, 2, 98);
    const randomBetween=(min,max)=>parseFloat((min + Math.random()*(max-min)).toFixed(2));
    const forceDisplayedLossRoll=()=>{
      if(direction==='over') return randomBetween(0, Math.max(0, visibleTarget));
      return randomBetween(Math.min(100, visibleTarget), 100);
    };
    const forceDisplayedWinRoll=()=>{
      if(direction==='over') return randomBetween(Math.min(100, visibleTarget+0.01), 100);
      return randomBetween(0, Math.max(0, visibleTarget-0.01));
    };
    let roll;
    if(diceOdds<=0){
      roll=forceDisplayedLossRoll();
    }else if(diceOdds>=200){
      roll=forceDisplayedWinRoll();
    }else{
      const effectiveWinChance = direction==='over'
        ? (100 - adjustedTarget) / 100
        : adjustedTarget / 100;
      const won = Math.random() < effectiveWinChance;
      roll = won ? forceDisplayedWinRoll() : forceDisplayedLossRoll();
    }
    const won = direction==='over' ? roll>visibleTarget : roll<visibleTarget;
    const winChance = direction==='over' ? 100-visibleTarget : visibleTarget;
    const multiplier = 99/winChance;
    const payout = won ? Math.floor(amount*multiplier) : 0;
    const profit = payout - amount;
    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[amount,req.user.id]);
    if(won) await db.run('UPDATE users SET credits=credits+? WHERE id=?',[payout,req.user.id]);
    const betId = generateId('cbd');
    await db.run('INSERT INTO casino_bets (id,user_id,game,bet_amount,outcome,payout,profit,timestamp) VALUES (?,?,?,?,?,?,?,?)',
      [betId,req.user.id,'dice',amount,won?'win':'loss',payout,profit,Date.now()]);
    await recordTx(req.user.id, profit, 'casino_dice', betId, `Dice: ${direction} ${visibleTarget} — ${won?'won':'lost'} ⬡${amount}`);
    invalidateCasinoBetsCache(req.user.id);
    const updated = await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    res.json({roll, won, payout, profit, multiplier:parseFloat(multiplier.toFixed(4)), adjustedTarget:parseFloat(Number(adjustedTarget).toFixed(2)), newBalance:Math.floor(updated.credits)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/casino/plinko', authMiddleware, async(req,res)=>{
  try{
    const {betAmount, risk='low'} = req.body;
    const amount = Math.floor(Number(betAmount));
    if(!amount || amount < 1) return res.status(400).json({error:'Minimum bet is ⬡1'});
    const riskTables = {
      low:[3.2,1.6,1.15,0.92,0.75,0.92,1.15,1.6,3.2],
      medium:[6,2.5,1.2,0.8,0.4,0.8,1.2,2.5,6],
      high:[12,4.5,1.6,0.6,0.2,0.6,1.6,4.5,12],
    };
    if(!riskTables[risk]) return res.status(400).json({error:'Invalid risk'});
    const user = await db.get('SELECT * FROM users WHERE id=?',[req.user.id]);
    if(Math.floor(user.credits) < amount) return res.status(400).json({error:'Insufficient credits'});
    const { effective } = await getCasinoConfig(req.user.id);
    const plinkoOdds = effective.plinkoOdds;

    const multipliers = riskTables[risk];
    let slotIndex = 0;
    if(plinkoOdds<=0){
      let worstValue = Infinity;
      const worstIndexes = [];
      multipliers.forEach((multiplier, idx)=>{
        if(multiplier < worstValue){
          worstValue = multiplier;
          worstIndexes.length = 0;
          worstIndexes.push(idx);
        }else if(multiplier === worstValue){
          worstIndexes.push(idx);
        }
      });
      slotIndex = worstIndexes[Math.floor(Math.random()*worstIndexes.length)];
    }else if(plinkoOdds>=200){
      let bestValue = -Infinity;
      const bestIndexes = [];
      multipliers.forEach((multiplier, idx)=>{
        if(multiplier > bestValue){
          bestValue = multiplier;
          bestIndexes.length = 0;
          bestIndexes.push(idx);
        }else if(multiplier === bestValue){
          bestIndexes.push(idx);
        }
      });
      slotIndex = bestIndexes[Math.floor(Math.random()*bestIndexes.length)];
    }else{
      const baseWeights = [1,8,28,56,70,56,28,8,1];
      const oddsPower = (plinkoOdds - 100) / 50;
      const weighted = multipliers.map((multiplier, idx)=>baseWeights[idx] * Math.pow(Math.max(multiplier, 0.05), oddsPower));
      const totalWeight = weighted.reduce((sum, value)=>sum + value, 0);
      let pick = Math.random() * totalWeight;
      for(let i=0;i<weighted.length;i++){
        pick -= weighted[i];
        if(pick <= 0){
          slotIndex = i;
          break;
        }
      }
    }
    const path = Array.from({length:8}, (_, idx)=>idx < slotIndex ? 1 : 0);
    for(let i=path.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [path[i],path[j]]=[path[j],path[i]];
    }

    const multiplier = multipliers[slotIndex];
    const payout = Math.floor(amount * multiplier);
    const profit = payout - amount;
    const won = profit >= 0;

    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[amount,req.user.id]);
    if(payout > 0) await db.run('UPDATE users SET credits=credits+? WHERE id=?',[payout,req.user.id]);

    const betId = generateId('cbp');
    await db.run('INSERT INTO casino_bets (id,user_id,game,bet_amount,outcome,payout,profit,timestamp) VALUES (?,?,?,?,?,?,?,?)',
      [betId,req.user.id,'plinko',amount,won?'win':'loss',payout,profit,Date.now()]);
    await recordTx(req.user.id, profit, 'casino_plinko', betId, `Plinko ${risk}: slot ${slotIndex+1} at ${multiplier}x on ⬡${amount}`);
    invalidateCasinoBetsCache(req.user.id);

    const updated = await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    res.json({
      path,
      slotIndex,
      risk,
      multiplier,
      payout,
      profit,
      won,
      newBalance: Math.floor(updated.credits)
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/casino/mines/start', authMiddleware, async(req,res)=>{
  try{
    const amount = Math.floor(Number(req.body.betAmount));
    const mineCount = clampNumber(Math.floor(Number(req.body.mineCount || 3)), 1, 24);
    if(!amount || amount < 1) return res.status(400).json({error:'Minimum bet is ⬡1'});
    const existingGame = getActiveMinesGame(req.user.id);
    if(existingGame){
      return res.status(400).json({error:'Finish or cash out your current Mines game first'});
    }
    const user = await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    if(Math.floor(user.credits) < amount) return res.status(400).json({error:'Insufficient credits'});
    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[amount,req.user.id]);
    const game = {
      betAmount: amount,
      mineCount,
      mineSet: makeMineSet(mineCount),
      revealedSafe: new Set(),
      status: 'active',
      startedAt: Date.now(),
      lastActionAt: Date.now(),
    };
    minesGames.set(req.user.id, game);
    const updated = await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    res.json({state:serializeMinesState(game), newBalance:Math.floor(updated.credits)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/casino/mines/current', authMiddleware, async(req,res)=>{
  try{
    const game = getActiveMinesGame(req.user.id);
    if(!game){
      return res.json({active:false});
    }
    const updated = await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    res.json({
      active:true,
      state:serializeMinesState(game),
      newBalance:Math.floor(updated.credits),
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/casino/mines/reveal', authMiddleware, async(req,res)=>{
  try{
    const game = getActiveMinesGame(req.user.id);
    if(!game) return res.status(400).json({error:'No active Mines game'});
    const maxSafeReveals = 25 - game.mineCount;
    if(game.revealedSafe.size >= maxSafeReveals) return res.status(400).json({error:'No safe tiles remain. Cash out your run.'});
    const index = Math.floor(Number(req.body.index));
    if(index<0 || index>24) return res.status(400).json({error:'Invalid tile'});
    if(game.revealedSafe.has(index)) return res.status(400).json({error:'Tile already revealed'});
    const { effective } = await getCasinoConfig(req.user.id);
    const minesOdds = effective.minesOdds;
    const remainingSafe = 25 - game.mineCount - game.revealedSafe.size;
    const remainingTiles = 25 - game.revealedSafe.size;
    const desiredSafe = remainingSafe>0 && Math.random() < getAdjustedSafeChance(remainingSafe/remainingTiles, minesOdds, game.mineCount);
    flipMineCell(game, index, desiredSafe);
    const hitMine = game.mineSet.has(index);
    if(hitMine){
      minesGames.delete(req.user.id);
      const betId = generateId('cbm');
      await db.run('INSERT INTO casino_bets (id,user_id,game,bet_amount,outcome,payout,profit,timestamp) VALUES (?,?,?,?,?,?,?,?)',
        [betId,req.user.id,'mines',game.betAmount,'loss',0,-game.betAmount,Date.now()]);
      await recordTx(req.user.id, -game.betAmount, 'casino_mines', betId, `Mines: hit a mine with ${game.mineCount} mine${game.mineCount===1?'':'s'}`);
      invalidateCasinoBetsCache(req.user.id);
      game.status='lost';
      return res.json({
        hitMine:true,
        state:serializeMinesState(game,true),
        payout:0,
        profit:-game.betAmount,
        newBalance:Math.floor((await db.get('SELECT credits FROM users WHERE id=?',[req.user.id])).credits),
      });
    }
    game.revealedSafe.add(index);
    game.lastActionAt = Date.now();
    const state = serializeMinesState(game);
    res.json({
      hitMine:false,
      state,
      payout:state.potentialPayout,
      profit:state.potentialPayout - game.betAmount,
      newBalance:Math.floor((await db.get('SELECT credits FROM users WHERE id=?',[req.user.id])).credits),
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/casino/mines/cashout', authMiddleware, async(req,res)=>{
  try{
    const game = getActiveMinesGame(req.user.id);
    if(!game) return res.status(400).json({error:'No active Mines game'});
    if(game.revealedSafe.size<1) return res.status(400).json({error:'Reveal at least one safe tile before cashing out'});
    const multiplier = getMinesMultiplier(game.revealedSafe.size, game.mineCount);
    const payout = Math.floor(game.betAmount * multiplier);
    const profit = payout - game.betAmount;
    await db.run('UPDATE users SET credits=credits+? WHERE id=?',[payout,req.user.id]);
    const betId = generateId('cbm');
    await db.run('INSERT INTO casino_bets (id,user_id,game,bet_amount,outcome,payout,profit,timestamp) VALUES (?,?,?,?,?,?,?,?)',
      [betId,req.user.id,'mines',game.betAmount,'win',payout,profit,Date.now()]);
    await recordTx(req.user.id, profit, 'casino_mines', betId, `Mines: cashed out after ${game.revealedSafe.size} safe pick${game.revealedSafe.size===1?'':'s'} with ${game.mineCount} mine${game.mineCount===1?'':'s'}`);
    invalidateCasinoBetsCache(req.user.id);
    game.status='cashed';
    minesGames.delete(req.user.id);
    const updated = await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    res.json({
      state:serializeMinesState(game,true),
      payout,
      profit,
      multiplier,
      newBalance:Math.floor(updated.credits),
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/casino/coinflip', authMiddleware, async(req,res)=>{
  try{
    const amount = Math.floor(Number(req.body.betAmount));
    const side = String(req.body.side||'heads').toLowerCase();
    if(!amount || amount < 1) return res.status(400).json({error:'Minimum bet is ⬡1'});
    if(!['heads','tails'].includes(side)) return res.status(400).json({error:'Choose heads or tails'});
    const user = await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    if(Math.floor(user.credits) < amount) return res.status(400).json({error:'Insufficient credits'});
    const { effective } = await getCasinoConfig(req.user.id);
    const coinflipOdds = effective.coinflipOdds;
    const landed = coinflipOdds<=0
      ? (side==='heads'?'tails':'heads')
      : coinflipOdds>=200
        ? side
        : (Math.random() < (coinflipOdds/200) ? side : (side==='heads'?'tails':'heads'));
    const won = landed===side;
    const payout = won ? amount*2 : 0;
    const profit = payout - amount;
    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[amount,req.user.id]);
    if(won) await db.run('UPDATE users SET credits=credits+? WHERE id=?',[payout,req.user.id]);
    const betId=generateId('cbc');
    await db.run('INSERT INTO casino_bets (id,user_id,game,bet_amount,outcome,payout,profit,timestamp) VALUES (?,?,?,?,?,?,?,?)',
      [betId,req.user.id,'coinflip',amount,won?'win':'loss',payout,profit,Date.now()]);
    await recordTx(req.user.id, profit, 'casino_coinflip', betId, `Coin Flip: ${side} — ${won?'won':'lost'} ⬡${amount}`);
    invalidateCasinoBetsCache(req.user.id);
    const updated = await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    res.json({landed, won, payout, profit, newBalance:Math.floor(updated.credits)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/casino/roulette', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const amount = Math.floor(Number(req.body.betAmount));
    const betType = String(req.body.betType||'red').toLowerCase();
    const value = req.body.value;
    const validTypes = new Set(['red','black','even','odd','low','high','dozen1','dozen2','dozen3','number']);
    if(!amount || amount < 1) return res.status(400).json({error:'Minimum bet is ⬡1'});
    if(!validTypes.has(betType)) return res.status(400).json({error:'Invalid roulette bet'});
    if(betType==='number' && (value===undefined || Number(value)<0 || Number(value)>36)) return res.status(400).json({error:'Choose a number from 0 to 36'});
    const winningSet = getRouletteWinningNumbers(betType, value);
    if(!winningSet.size) return res.status(400).json({error:'Choose at least one valid number'});
    const user = await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    if(Math.floor(user.credits) < amount) return res.status(400).json({error:'Insufficient credits'});
    const multiplier = getRoulettePayoutMultiplier(betType);
    const { effective } = await getCasinoConfig(req.user.id);
    const number = pickRouletteNumber(winningSet, effective.rouletteOdds);
    const won = winningSet.has(number);
    const payout = won ? Math.floor(amount * multiplier) : 0;
    const profit = payout - amount;
    const meta = getRouletteMeta(number);
    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[amount,req.user.id]);
    if(won) await db.run('UPDATE users SET credits=credits+? WHERE id=?',[payout,req.user.id]);
    const betId=generateId('cbr');
    await db.run('INSERT INTO casino_bets (id,user_id,game,bet_amount,outcome,payout,profit,timestamp) VALUES (?,?,?,?,?,?,?,?)',
      [betId,req.user.id,'roulette',amount,won?'win':'loss',payout,profit,Date.now()]);
    const selectionLabel=betType==='number' ? `number ${value}` : betType;
    await recordTx(req.user.id, profit, 'casino_roulette', betId, `Roulette: ${selectionLabel} — ${won?'won':'lost'} ⬡${amount}`);
    invalidateCasinoBetsCache(req.user.id);
    const updated = await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    res.json({
      number,
      color: meta.color,
      label: meta.label,
      won,
      payout,
      profit,
      multiplier,
      newBalance: Math.floor(updated.credits),
    });
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/casino/my-bets', authMiddleware, async(req,res)=>{
  try{
    const cached = casinoBetsCache.get(req.user.id);
    if(cached && cached.expiresAt > Date.now()) return res.json(cached.data);
    const bets = await db.all('SELECT * FROM casino_bets WHERE user_id=? ORDER BY timestamp DESC LIMIT 20',[req.user.id]);
    casinoBetsCache.set(req.user.id, { data: bets, expiresAt: Date.now() + CASINO_BETS_CACHE_TTL_MS });
    res.json(bets);
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/admin/casino', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const search = String(req.query.search || '').trim();
    const limit = parsePage(req.query.limit, 100, 20, 500);
    const offset = parsePage(req.query.offset, 0, 0, 100000);
    const cacheKey = getAdminCacheKey(search, limit, offset);
    const cached = adminCasinoCache.get(cacheKey);
    if(cached && cached.expiresAt > Date.now()) return res.json(cached.data);
    let bets;
    let totalRow;
    if(search){
      const like = `%${search}%`;
      bets = await db.all(
        `SELECT cb.*,u.name as user_name
         FROM casino_bets cb
         JOIN users u ON cb.user_id=u.id
         WHERE LOWER(cb.user_id) LIKE LOWER(?) OR LOWER(COALESCE(u.name,'')) LIKE LOWER(?) OR LOWER(COALESCE(cb.game,'')) LIKE LOWER(?) OR LOWER(COALESCE(cb.outcome,'')) LIKE LOWER(?)
         ORDER BY cb.timestamp DESC
         LIMIT ? OFFSET ?`,
        [like,like,like,like,limit,offset]
      );
      totalRow = await db.get(
        `SELECT COUNT(*) as c
         FROM casino_bets cb
         JOIN users u ON cb.user_id=u.id
         WHERE LOWER(cb.user_id) LIKE LOWER(?) OR LOWER(COALESCE(u.name,'')) LIKE LOWER(?) OR LOWER(COALESCE(cb.game,'')) LIKE LOWER(?) OR LOWER(COALESCE(cb.outcome,'')) LIKE LOWER(?)`,
        [like,like,like,like]
      );
    }else{
      bets = await db.all(
        `SELECT cb.*,u.name as user_name
         FROM casino_bets cb
         JOIN users u ON cb.user_id=u.id
         ORDER BY cb.timestamp DESC
         LIMIT ? OFFSET ?`,
        [limit,offset]
      );
      totalRow = await db.get(`SELECT COUNT(*) as c FROM casino_bets`);
    }
    const stats = await db.get(`SELECT COUNT(*) as total_bets, SUM(bet_amount) as total_wagered, SUM(profit) as house_profit FROM casino_bets`);
    const baseline = await getCasinoStatsBaseline();
    const adjustedStats = {
      ...stats,
      total_wagered: Math.max(0, Number(stats?.total_wagered || 0) - baseline.wagered),
      house_profit: Number(stats?.house_profit || 0) - baseline.profit,
    };
    const data = {bets, stats:adjustedStats, total:totalRow?.c||0, hasMore:offset + bets.length < (totalRow?.c||0)};
    adminCasinoCache.set(cacheKey, { data, expiresAt: Date.now() + ADMIN_LIST_CACHE_TTL_MS });
    res.json(data);
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/users/:id/round-credits', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const user = await db.get('SELECT id,name,credits FROM users WHERE id=?',[req.params.id]);
    if(!user) return res.status(404).json({error:'User not found'});
    const floored = Math.floor(user.credits);
    await db.run('UPDATE users SET credits=? WHERE id=?',[floored,req.params.id]);
    await recordTx(req.params.id, floored-user.credits, 'admin_round', null, `Credits rounded down from ${user.credits} to ${floored}`);
    res.json({success:true, before:user.credits, after:floored});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/spin', authMiddleware, async(req,res)=>{
  try{
    const midnight=new Date();
    midnight.setUTCHours(0,0,0,0);
    const last=await db.get('SELECT timestamp FROM spin_log WHERE user_id=? ORDER BY timestamp DESC LIMIT 1',[req.user.id]);
    if(last&&last.timestamp>=midnight.getTime())
      return res.status(400).json({error:'Already spun today'});
    const prizes=[
      {credits:5,   weight:35},
      {credits:10,  weight:28},
      {credits:25,  weight:18},
      {credits:50,  weight:10},
      {credits:100, weight:6},
      {credits:200, weight:3},
    ];
    const total=prizes.reduce((s,p)=>s+p.weight,0);
    let r=Math.random()*total,winner=prizes[0];
    for(const p of prizes){r-=p.weight;if(r<=0){winner=p;break;}}
    await db.run('UPDATE users SET credits=credits+? WHERE id=?',[winner.credits,req.user.id]);
    await db.run('INSERT INTO spin_log (id,user_id,credits_won,timestamp) VALUES (?,?,?,?)',
      [generateId('spin'),req.user.id,winner.credits,Date.now()]);
    await recordTx(req.user.id,winner.credits,'daily_spin',null,`Daily spin: won ${winner.credits} credits`);
    const user=await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    res.json({credits:winner.credits,newBalance:user.credits});
  }catch(e){res.status(500).json({error:e.message});}
});

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Upload too large. Try a smaller image, video, or MP3.' });
  }
  if (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
  next();
});

initDB().then(()=>{
  app.listen(PORT,()=>{
    console.log(`\n🚀 Sclshi Markets running at http://localhost:${PORT}\n`);
  });
}).catch(err=>{console.error('DB init failed:',err);process.exit(1);});
