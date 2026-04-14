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
const JWT_SECRET = process.env.JWT_SECRET || 'jewshi-secret-change-in-production';
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const POPUP_TAB_PASSWORD_KEY = 'popup_tab_password_hash';
const DEFAULT_POPUP_TAB_PASSWORD = process.env.POPUP_TAB_PASSWORD || 'BryceB0mb!';
const POPUP_UNLOCK_TTL_MS = 1000 * 60 * 45;
const popupAdminUnlocks = new Map();
const UPLOAD_ROOT = path.join(__dirname, 'public', 'uploads', 'popups');

app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let db;
const blackjackGames = new Map();

async function initDB() {
  db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  db.run = async (sql, args=[]) => { await db.execute({ sql, args }); };
  db.get = async (sql, args=[]) => { const r = await db.execute({ sql, args }); return r.rows[0] || null; };
  db.all = async (sql, args=[]) => { const r = await db.execute({ sql, args }); return r.rows; };
  db.exec = async (sql) => { for (const s of sql.split(';').map(s=>s.trim()).filter(Boolean)) await db.execute(s); };

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT NOT NULL,
      role TEXT DEFAULT 'student', credits INTEGER DEFAULT 200, grade TEXT DEFAULT '',
      email_verified INTEGER DEFAULT 1, on_email_list INTEGER DEFAULT 0, bio TEXT DEFAULT '',
      popup_access INTEGER DEFAULT 0
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
      password TEXT NOT NULL, grade TEXT DEFAULT '',
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
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      shown_at INTEGER DEFAULT NULL,
      stopped_at INTEGER DEFAULT NULL
    )

  `);
  await db.run("ALTER TABLE posts ADD COLUMN image TEXT DEFAULT NULL").catch(()=>{});
  await db.run("ALTER TABLE users ADD COLUMN popup_access INTEGER DEFAULT 0").catch(()=>{});
  await db.run("ALTER TABLE popups ADD COLUMN rave_enabled INTEGER DEFAULT 0").catch(()=>{});
  await db.run("ALTER TABLE popups ADD COLUMN alert_enabled INTEGER DEFAULT 0").catch(()=>{});
  await db.run("ALTER TABLE popups ADD COLUMN alert_text TEXT DEFAULT ''").catch(()=>{});
  fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
  await ensureProtectedSettings();
  await seedIfEmpty();
}

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
  const users = [
    { id:'GROSE',       name:'Administrator', email:'grose@emeryweiner.org', password:'BryceB0mb!', role:'admin',   credits:0,   grade:'' },
    { id:'STUDENT-001', name:'Blake Gubitz',  email:'blake@jewshi.com',      password:'daren',      role:'student', credits:500, grade:'' },
    { id:'STUDENT-002', name:'Student 002',   email:'student2@jewshi.com',   password:'Hello123',   role:'student', credits:500, grade:'' },
    { id:'STUDENT-003', name:'Student 003',   email:'student3@jewshi.com',   password:'BigIce',     role:'student', credits:500, grade:'' },
  ];
  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await db.run('INSERT INTO users (id,name,email,password,role,credits,grade,email_verified,on_email_list) VALUES (?,?,?,?,?,?,?,1,0)',
      [u.id,u.name,u.email,hash,u.role,u.credits,u.grade]);
  }
  const items = [
    ['s1','Café Sandwich','🥪',150,'Redeemable at school café'],
    ['s2','EW Spirit Shirt','👕',400,'Official school wear'],
    ['s3','Free Dress Day Pass','👔',300,'One day dress-code waiver'],
    ['s4','Smoothie Voucher','🥤',100,'Any smoothie from café'],
  ];
  for (const [id,name,icon,cost,desc] of items)
    await db.run('INSERT INTO store_items (id,name,icon,cost,description) VALUES (?,?,?,?,?)',[id,name,icon,cost,desc]);
  await db.run(`INSERT INTO markets (id,question,category,status,close_date,yes_shares,no_shares,b_param,pool,created_at,market_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['m1','Will the Eagles win the district championship?','Sports','open','2025-06-01',0,0,100,0,Date.now(),'binary']);
  await db.run(`INSERT INTO markets (id,question,category,status,close_date,yes_shares,no_shares,b_param,pool,created_at,market_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['m2','Will the school play open on time?','School','open','2025-05-15',0,0,100,0,Date.now(),'binary']);
  await db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('volunteer_rate','100')");
  await db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('access_password','jewshi2025')");
  console.log('Database seeded.');
}

async function appendToSheet(name, email, grade) {
  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_SHEET_ID) return;
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:D',
      valueInputOption: 'RAW',
      requestBody: { values: [[name, email, grade, new Date().toLocaleString()]] },
    });
  } catch(e) { console.error('[Sheets] Error:', e.message); }
}

// Send email via Apps Script
async function sendViaAppsScript(type, payload) {
  try {
    if (!process.env.APPS_SCRIPT_URL) { console.log('[Email] APPS_SCRIPT_URL not set, skipping'); return 0; }
    const fetch = (...args) => import('node-fetch').then(({default:f})=>f(...args));
    const res = await fetch(process.env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...payload }),
    });
    const data = await res.json();
    return data.sent || 0;
  } catch(e) { console.error('[Email] Error:', e.message); return 0; }
}

function generateId(p='') { return p+Date.now()+Math.random().toString(36).slice(2,6); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function issuePopupUnlockToken(userId){
  const token = crypto.randomBytes(24).toString('hex');
  popupAdminUnlocks.set(userId, { token, expiresAt: Date.now()+POPUP_UNLOCK_TTL_MS });
  return token;
}
async function hasPopupTabAccess(userId){
  if(userId==='GROSE') return true;
  const user=await db.get('SELECT popup_access FROM users WHERE id=?',[userId]);
  return !!user?.popup_access;
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
async function finishBlackjackGame(userId){
  const game=blackjackGames.get(userId);
  if(!game) throw new Error('No active blackjack game');

  while(handTotal(game.dealerCards)<17){
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
      const payout=bet*2;
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

async function recordTx(userId, amount, type, refId=null, desc='') {
  await db.run('INSERT INTO transactions (id,user_id,amount,type,reference_id,description,timestamp) VALUES (?,?,?,?,?,?,?)',
    [generateId('tx'),userId,amount,type,refId,desc,Date.now()]);
}
function authMiddleware(req,res,next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({error:'No token'});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({error:'Invalid token'}); }
}
async function adminOnly(req,res,next) {
  const user = await db.get('SELECT role FROM users WHERE id=?',[req.user.id]);
  if (!user||user.role!=='admin') return res.status(403).json({error:'Admin only'});
  next();
}
function isGrose(req) { return req.user.id === 'GROSE'; }
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
    await db.run('INSERT INTO users (id,name,email,password,role,credits,grade,email_verified,on_email_list) VALUES (?,?,?,?,?,?,?,1,0)',
      [uid,pending.name,pending.email,pending.password,'student',200,pending.grade]);
    await db.run('DELETE FROM pending_registrations WHERE id=?',[pendingId]);
    await recordTx(uid,200,'signup_bonus',null,'Welcome bonus');
    appendToSheet(pending.name,pending.email,pending.grade);
    const token=jwt.sign({id:uid,role:'student'},JWT_SECRET,{expiresIn:'30d'});
    const user=await db.get('SELECT id,name,email,role,credits,grade,on_email_list FROM users WHERE id=?',[uid]);
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
  if(password===(row?.value||'jewshi2025')) res.json({success:true});
  else res.status(401).json({error:'Wrong password'});
});

app.post('/api/admin/access-password', authMiddleware, adminOnly, async(req,res)=>{
  try{
    if(!isGrose(req)) return res.status(403).json({error:'Only GROSE can change the access password'});
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
    if(!isGrose(req)) return res.status(403).json({error:'Only GROSE can change the Pop-up tab password'});
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
    const {recipientId,recipientIds,title,message,alertText,mediaDataUrl,mediaName,audioDataUrl,audioName,raveEnabled,alertEnabled}=req.body;
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
      if(recipient.id==='GROSE') return res.status(400).json({error:'GROSE cannot be targeted by Pop-up messages'});
      recipients.push(recipient);
    }
    const created = [];
    for(const recipient of recipients){
      await db.run("UPDATE popups SET status='stopped', stopped_at=? WHERE recipient_id=? AND status IN ('pending','active')",[Date.now(),recipient.id]);
      const id = generateId('popup');
      await db.run(`INSERT INTO popups (id,sender_id,recipient_id,title,message,alert_text,media_type,media_url,audio_url,rave_enabled,alert_enabled,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id,req.user.id,recipient.id,title?.trim()||'',message?.trim()||'',alertText?.trim()||'',mediaType,mediaUrl,audioUrl,raveEnabled?1:0,alertEnabled?1:0,'pending',Date.now()]);
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
    const row = await db.get("SELECT COUNT(*) as c FROM popups WHERE status IN ('pending','active')");
    await db.run("UPDATE popups SET status='stopped', stopped_at=? WHERE status IN ('pending','active')",[Date.now()]);
    res.json({success:true,stopped:row?.c||0});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/popups/:id/stop', authMiddleware, requirePopupAdminUnlocked, async(req,res)=>{
  try{
    const popup = await db.get('SELECT * FROM popups WHERE id=?',[req.params.id]);
    if(!popup) return res.status(404).json({error:'Pop-up not found'});
    if(!['pending','active'].includes(popup.status)) return res.json({success:true});
    await db.run("UPDATE popups SET status='stopped', stopped_at=? WHERE id=?",[Date.now(),req.params.id]);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/popups/pending', authMiddleware, async(req,res)=>{
  try{
    const popup = await db.get(`SELECT * FROM popups
      WHERE recipient_id=? AND status IN ('pending','active')
      ORDER BY created_at DESC LIMIT 1`,[req.user.id]);
    if(!popup) return res.json({popup:null});
    if(popup.status==='pending'){
      await db.run("UPDATE popups SET status='active', shown_at=? WHERE id=?",[Date.now(),popup.id]);
      popup.status='active';
      popup.shown_at=Date.now();
    }
    res.json({popup});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── LIVE FEED ──
app.get('/api/live', async(req,res)=>{
  try{
    const totalCredits=(await db.get("SELECT SUM(credits) as s FROM users WHERE role='student'")).s||0;
    const activePlayers=(await db.get("SELECT COUNT(*) as c FROM users WHERE role='student'")).c||0;
    const markets=await db.all("SELECT id,question,category,close_date,pool,yes_shares,no_shares,over_shares,under_shares,market_type,line,status FROM markets WHERE status='open' ORDER BY created_at DESC");
    const totalBets=(await db.get("SELECT COUNT(*) as c FROM bets WHERE status='active'")).c||0;
    res.json({totalCredits,activePlayers,markets,totalBets});
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
      line_items:[{price_data:{currency:'usd',unit_amount:amountCents,product_data:{name:`Jewshi Markets — ${credits.toLocaleString()} Credits`}},quantity:1}],
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
    const {email,password}=req.body;
    if(!email||!password) return res.status(400).json({error:'Missing fields'});
    const user=await db.get('SELECT * FROM users WHERE LOWER(email)=LOWER(?)',[email.trim()]);
    if(!user) return res.status(401).json({error:'Invalid email or password'});
    if(!await bcrypt.compare(password,user.password)) return res.status(401).json({error:'Invalid email or password'});
    const token=jwt.sign({id:user.id,role:user.role},JWT_SECRET,{expiresIn:'30d'});
    const {password:_,...safe}=user;
    res.json({token,user:safe});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/register', async(req,res)=>{
  try{
    const {name,email,password,grade}=req.body;
    if(!name||!email||!password) return res.status(400).json({error:'Missing fields'});
    const trimmedEmail=email.trim().toLowerCase();
    if(await db.get('SELECT id FROM users WHERE LOWER(email)=?',[trimmedEmail]))
      return res.status(409).json({error:'An account with that email already exists'});
    if(password.length<6) return res.status(400).json({error:'Password must be at least 6 characters'});
    const hash=await bcrypt.hash(password,10);
    const code=Math.floor(100000+Math.random()*900000).toString();
    const id=generateId('pending');
    await db.run('DELETE FROM pending_registrations WHERE email=?',[trimmedEmail]);
    await db.run('INSERT INTO pending_registrations (id,name,email,password,grade,code,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [id,name.trim(),trimmedEmail,hash,grade||'',code,Date.now()+600000,Date.now()]);
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
      await db.run('INSERT INTO password_reset_tokens (token,user_id,expires_at,used,created_at) VALUES (?,?,?,0,?)',
        [token,user.id,Date.now()+3600000,Date.now()]);
      console.log(`[Dev] Reset: ${CLIENT_URL}/reset-password.html?token=${token}`);
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
  const user=await db.get('SELECT id,name,email,role,credits,grade,on_email_list,bio,popup_access FROM users WHERE id=?',[req.user.id]);
  if(!user) return res.status(404).json({error:'User not found'});
  res.json(user);
});
app.get('/api/users', authMiddleware, adminOnly, async(req,res)=>{
  res.json(await db.all("SELECT id,name,email,role,credits,grade,on_email_list,popup_access FROM users WHERE id!=?",[req.user.id]));
});
app.get('/api/popup/users', authMiddleware, async(req,res)=>{
  if(!(await hasPopupTabAccess(req.user.id))) return res.status(403).json({error:'You do not have Pop-up tab access'});
  res.json(await db.all("SELECT id,name,role FROM users WHERE id!=? AND id!='GROSE' ORDER BY name ASC",[req.user.id]));
});
app.post('/api/users/:id/add-credits', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {amount}=req.body;
    if(!amount||amount<=0) return res.status(400).json({error:'Invalid amount'});
    await db.run('UPDATE users SET credits=credits+? WHERE id=?',[amount,req.params.id]);
    await recordTx(req.params.id,amount,'admin_grant',null,`Admin added ${amount}`);
    res.json(await db.get('SELECT id,name,credits FROM users WHERE id=?',[req.params.id]));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/users/:id/remove-credits', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {amount}=req.body;
    if(!amount||amount<=0) return res.status(400).json({error:'Invalid amount'});
    await db.run('UPDATE users SET credits=MAX(0,credits-?) WHERE id=?',[amount,req.params.id]);
    await recordTx(req.params.id,-amount,'admin_deduct',null,`Admin removed ${amount}`);
    res.json(await db.get('SELECT id,name,credits FROM users WHERE id=?',[req.params.id]));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/users/:id/make-admin', authMiddleware, adminOnly, async(req,res)=>{
  if(!isGrose(req)) return res.status(403).json({error:'Only GROSE can promote users'});
  await db.run("UPDATE users SET role='admin' WHERE id=?",[req.params.id]);
  res.json({success:true});
});
app.post('/api/users/:id/make-student', authMiddleware, adminOnly, async(req,res)=>{
  if(!isGrose(req)) return res.status(403).json({error:'Only GROSE can demote users'});
  if(req.params.id==='GROSE') return res.status(400).json({error:'Cannot demote primary admin'});
  await db.run("UPDATE users SET role='student' WHERE id=?",[req.params.id]);
  res.json({success:true});
});
app.post('/api/users/:id/toggle-email-list', authMiddleware, adminOnly, async(req,res)=>{
  if(!isGrose(req)) return res.status(403).json({error:'Only GROSE can manage email list'});
  const user=await db.get('SELECT on_email_list FROM users WHERE id=?',[req.params.id]);
  if(!user) return res.status(404).json({error:'User not found'});
  const newVal=user.on_email_list?0:1;
  await db.run('UPDATE users SET on_email_list=? WHERE id=?',[newVal,req.params.id]);
  res.json({on_email_list:newVal});
});
app.post('/api/users/:id/toggle-popup-access', authMiddleware, adminOnly, async(req,res)=>{
  if(!isGrose(req)) return res.status(403).json({error:'Only GROSE can manage Pop-up access'});
  if(req.params.id==='GROSE') return res.status(400).json({error:'GROSE always has Pop-up access'});
  const user=await db.get('SELECT popup_access FROM users WHERE id=?',[req.params.id]);
  if(!user) return res.status(404).json({error:'User not found'});
  const newVal=user.popup_access?0:1;
  await db.run('UPDATE users SET popup_access=? WHERE id=?',[newVal,req.params.id]);
  popupAdminUnlocks.delete(req.params.id);
  res.json({popup_access:newVal});
});
app.delete('/api/users/:id', authMiddleware, adminOnly, async(req,res)=>{
  const {id}=req.params;
  if(id==='GROSE') return res.status(400).json({error:'Cannot delete primary admin'});
  await db.run('DELETE FROM bets WHERE user_id=?',[id]);
  await db.run('DELETE FROM transactions WHERE user_id=?',[id]);
  await db.run('DELETE FROM redemptions WHERE user_id=?',[id]);
  await db.run('DELETE FROM stripe_sessions WHERE user_id=?',[id]);
  await db.run('DELETE FROM messages WHERE sender_id=? OR recipient_id=?',[id,id]);
  await db.run('DELETE FROM post_likes WHERE user_id=?',[id]);
  await db.run('DELETE FROM post_reposts WHERE user_id=?',[id]);
  await db.run('DELETE FROM users WHERE id=?',[id]);
  res.json({success:true});
});

// ── PROFILE ──
app.get('/api/users/:id/profile', authMiddleware, async(req,res)=>{
  try{
    const user=await db.get('SELECT id,name,grade,role,credits,bio,on_email_list FROM users WHERE id=? AND on_email_list=1',[req.params.id]);
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
    const id=generateId('m');
    if(market_type==='overunder'){
      await db.run(`INSERT INTO markets (id,question,category,status,close_date,yes_shares,no_shares,b_param,pool,created_at,market_type,line,over_shares,under_shares) VALUES (?,?,?,'open',?,0,0,100,0,?,?,?,0,0)`,
        [id,question,category||'Sports',closeDate,Date.now(),'overunder',line]);
    } else {
      await db.run(`INSERT INTO markets (id,question,category,status,close_date,yes_shares,no_shares,b_param,pool,created_at,market_type) VALUES (?,?,?,'open',?,0,0,100,0,?,'binary')`,
        [id,question,category||'General',closeDate,Date.now()]);
    }
    res.json(await db.get('SELECT * FROM markets WHERE id=?',[id]));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/markets/:id/resolve', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {outcome}=req.body;
    if(!['YES','NO'].includes(outcome)) return res.status(400).json({error:'Bad outcome'});
    const m=await db.get('SELECT * FROM markets WHERE id=?',[req.params.id]);
    if(!m||m.status!=='open') return res.status(400).json({error:'Not open'});
    await db.run('UPDATE markets SET status=? WHERE id=?',[outcome==='YES'?'resolved-yes':'resolved-no',m.id]);
    const wins=await db.all("SELECT * FROM bets WHERE market_id=? AND side=? AND status='active'",[m.id,outcome]);
    const total=wins.reduce((s,b)=>s+b.amount,0);
    for(const b of wins){
      const pay=total>0?Math.round((b.amount/total)*m.pool):0;
      await db.run("UPDATE bets SET status='won',payout=? WHERE id=?",[pay,b.id]);
      await db.run('UPDATE users SET credits=credits+? WHERE id=?',[pay,b.user_id]);
      await recordTx(b.user_id,pay,'bet_won',b.id,`Won: ${m.question}`);
    }
    await db.run("UPDATE bets SET status='lost' WHERE market_id=? AND side!=? AND status='active'",[m.id,outcome]);
    res.json({success:true,outcome,pool:m.pool,wins:wins.map(b=>({id:b.id,user_id:b.user_id,amount:b.amount,payout:Math.round((b.amount/total)*m.pool)}))});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/markets/:id/resolve-overunder', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {actual}=req.body;
    if(actual===undefined) return res.status(400).json({error:'Actual result required'});
    const m=await db.get('SELECT * FROM markets WHERE id=?',[req.params.id]);
    if(!m||m.status!=='open') return res.status(400).json({error:'Not open'});
    const outcome=parseFloat(actual)>parseFloat(m.line)?'OVER':'UNDER';
    await db.run('UPDATE markets SET status=? WHERE id=?',[`resolved-${outcome.toLowerCase()}`,m.id]);
    const wins=await db.all("SELECT * FROM bets WHERE market_id=? AND side=? AND status='active'",[m.id,outcome]);
    const total=wins.reduce((s,b)=>s+b.amount,0);
    for(const b of wins){
      const pay=total>0?Math.round((b.amount/total)*m.pool):0;
      await db.run("UPDATE bets SET status='won',payout=? WHERE id=?",[pay,b.id]);
      await db.run('UPDATE users SET credits=credits+? WHERE id=?',[pay,b.user_id]);
      await recordTx(b.user_id,pay,'bet_won',b.id,`Won O/U: ${m.question}`);
    }
    await db.run("UPDATE bets SET status='lost' WHERE market_id=? AND side!=? AND status='active'",[m.id,outcome]);
    res.json({success:true,outcome,actual,line:m.line});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/markets/:id/close', authMiddleware, adminOnly, async(req,res)=>{
  await db.run("UPDATE markets SET status='closed' WHERE id=?",[req.params.id]);
  res.json({success:true});
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
    res.json({betId,shares:amount,newBalance:user.credits-amount});
  }catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/bets/mine', authMiddleware, async(req,res)=>{
  res.json(await db.all(`SELECT b.*,m.question,m.category,m.status as market_status,m.yes_shares,m.no_shares,m.b_param,m.market_type,m.line,m.over_shares,m.under_shares FROM bets b JOIN markets m ON b.market_id=m.id WHERE b.user_id=? ORDER BY b.timestamp DESC`,[req.user.id]));
});

// ── LEADERBOARD ──
app.get('/api/leaderboard', authMiddleware, async(req,res)=>{
  res.json(await db.all("SELECT id,name,grade,credits,on_email_list FROM users WHERE role='student' ORDER BY credits DESC"));
});

// ── STORE ──
app.get('/api/store', authMiddleware, async(req,res)=>{ res.json(await db.all('SELECT * FROM store_items')); });
app.post('/api/store', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {name,icon,cost,description}=req.body;
    if(!name||!cost) return res.status(400).json({error:'Missing fields'});
    const id=generateId('s');
    await db.run('INSERT INTO store_items (id,name,icon,cost,description) VALUES (?,?,?,?,?)',[id,name,icon||'🎁',cost,description||'']);
    res.json(await db.get('SELECT * FROM store_items WHERE id=?',[id]));
  }catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/store/:id', authMiddleware, adminOnly, async(req,res)=>{
  await db.run('DELETE FROM store_items WHERE id=?',[req.params.id]); res.json({success:true});
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
    res.json({id,success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/messages/conversations', authMiddleware, async(req,res)=>{
  try{
    const rows=await db.all(`SELECT DISTINCT CASE WHEN sender_id=? THEN recipient_id ELSE sender_id END as other_id FROM messages WHERE sender_id=? OR recipient_id=?`,
      [req.user.id,req.user.id,req.user.id]);
    const conversations=[];
    for(const row of rows){
      const other=await db.get('SELECT id,name,grade,role FROM users WHERE id=?',[row.other_id]);
      if(!other) continue;
      const last=await db.get(`SELECT * FROM messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY timestamp DESC LIMIT 1`,
        [req.user.id,row.other_id,row.other_id,req.user.id]);
      const unread=await db.get(`SELECT COUNT(*) as c FROM messages WHERE sender_id=? AND recipient_id=? AND is_read=0`,[row.other_id,req.user.id]);
      conversations.push({other,lastMessage:last,unreadCount:unread.c});
    }
    conversations.sort((a,b)=>(b.lastMessage?.timestamp||0)-(a.lastMessage?.timestamp||0));
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
  res.json(await db.all("SELECT id,name,grade,role FROM users WHERE id!=? ORDER BY name ASC",[req.user.id]));
});

// ── POSTS / FEED ──
app.get('/api/feed', authMiddleware, async(req,res)=>{
  try{
    const [posts, allLikes] = await Promise.all([
      db.all(`SELECT p.*,u.name as author_name,u.role as author_role FROM posts p JOIN users u ON p.user_id=u.id ORDER BY p.timestamp DESC LIMIT 50`),
      db.all(`SELECT post_id, COUNT(*) as c FROM post_likes GROUP BY post_id`),
    ]);

    const userLikes=new Set(
      (await db.all(`SELECT post_id FROM post_likes WHERE user_id=?`,[req.user.id])).map(r=>r.post_id)
    );

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
    const existing=await db.get('SELECT id FROM post_likes WHERE post_id=? AND user_id=?',[req.params.id,req.user.id]);
    if(existing){
      await db.run('DELETE FROM post_likes WHERE post_id=? AND user_id=?',[req.params.id,req.user.id]);
      res.json({liked:false});
    } else {
      await db.run('INSERT INTO post_likes (id,post_id,user_id,timestamp) VALUES (?,?,?,?)',
        [generateId('lk'),req.params.id,req.user.id,Date.now()]);
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
  res.json(await db.all(`SELECT t.*,u.name as user_name FROM transactions t JOIN users u ON t.user_id=u.id ORDER BY t.timestamp DESC LIMIT 200`));
});
app.get('/api/admin/stats', authMiddleware, adminOnly, async(req,res)=>{
  const students=(await db.get("SELECT COUNT(*) as c FROM users WHERE role='student'")).c;
  const openMarkets=(await db.get("SELECT COUNT(*) as c FROM markets WHERE status='open'")).c;
  const totalBets=(await db.get('SELECT COUNT(*) as c FROM bets')).c;
  const circ=(await db.get("SELECT SUM(credits) as s FROM users WHERE role='student'")).s||0;
  res.json({students,openMarkets,totalBets,pendingVol:0,totalCreditsInCirculation:circ});
});

app.post('/api/admin/send-digest', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const emailUsers=await db.all("SELECT email,name FROM users WHERE on_email_list=1 AND role='student'");
    if(!emailUsers.length) return res.status(400).json({error:'No users on email list yet'});
    const [leaderboard,markets,bigWins,creditsRow,accessRow]=await Promise.all([
      db.all("SELECT id,name,credits FROM users WHERE role='student' ORDER BY credits DESC LIMIT 5"),
      db.all("SELECT * FROM markets WHERE status='open' ORDER BY created_at DESC"),
      db.all(`SELECT b.payout,u.name,m.question FROM bets b JOIN users u ON b.user_id=u.id JOIN markets m ON b.market_id=m.id WHERE b.status='won' AND b.payout>100 ORDER BY b.payout DESC LIMIT 3`),
      db.get("SELECT SUM(amount) as s FROM transactions WHERE type='weekly_distribution'"),
      db.get("SELECT value FROM settings WHERE key='access_password'"),
    ]);
    const newUsersCount=(await db.get("SELECT COUNT(*) as c FROM users WHERE role='student'")).c;
    const payload={
      emails:emailUsers.map(u=>({email:u.email,name:u.name})),
      leaderboard,
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
      accessPassword:accessRow?.value||'jewshi2025',
      siteUrl:CLIENT_URL,
    };
    const sent=await sendViaAppsScript('weekly_digest',payload);
    res.json({success:true,sent});
  }catch(e){console.error('Digest error:',e);res.status(500).json({error:e.message});}
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
app.post('/api/casino/blackjack/deal', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const amount=Math.floor(Number(req.body.betAmount));
    if(!amount || amount<1) return res.status(400).json({error:'Minimum bet is ⬡1'});
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

app.post('/api/casino/blackjack/hit', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const game=blackjackGames.get(req.user.id);
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

app.post('/api/casino/blackjack/stand', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const game=blackjackGames.get(req.user.id);
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

app.post('/api/casino/blackjack/double', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const game=blackjackGames.get(req.user.id);
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

app.post('/api/casino/blackjack/split', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const game=blackjackGames.get(req.user.id);
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

app.post('/api/casino/dice', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {betAmount, target, direction} = req.body;
    const amount = Math.floor(Number(betAmount));
    if(!amount || amount < 1) return res.status(400).json({error:'Minimum bet is ⬡1'});
    if(!['over','under'].includes(direction)) return res.status(400).json({error:'Invalid direction'});
    if(target===undefined||target<2||target>98) return res.status(400).json({error:'Target must be between 2 and 98'});
    const user = await db.get('SELECT * FROM users WHERE id=?',[req.user.id]);
    if(Math.floor(user.credits) < amount) return res.status(400).json({error:'Insufficient credits'});
    const roll = parseFloat((Math.random()*100).toFixed(2));
    const won = direction==='over' ? roll>target : roll<target;
    const winChance = direction==='over' ? 100-target : target;
    const multiplier = 99/winChance;
    const payout = won ? Math.floor(amount*multiplier) : 0;
    const profit = payout - amount;
    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[amount,req.user.id]);
    if(won) await db.run('UPDATE users SET credits=credits+? WHERE id=?',[payout,req.user.id]);
    const betId = generateId('cbd');
    await db.run('INSERT INTO casino_bets (id,user_id,game,bet_amount,outcome,payout,profit,timestamp) VALUES (?,?,?,?,?,?,?,?)',
      [betId,req.user.id,'dice',amount,won?'win':'loss',payout,profit,Date.now()]);
    await recordTx(req.user.id, profit, 'casino_dice', betId, `Dice: ${direction} ${target} — ${won?'won':'lost'} ⬡${amount}`);
    const updated = await db.get('SELECT credits FROM users WHERE id=?',[req.user.id]);
    res.json({roll, won, payout, profit, multiplier:parseFloat(multiplier.toFixed(4)), newBalance:Math.floor(updated.credits)});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/casino/plinko', authMiddleware, adminOnly, async(req,res)=>{
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

    const multipliers = riskTables[risk];
    const path = [];
    let slotIndex = 0;
    for(let i=0;i<8;i++){
      const goRight = Math.random() < 0.5;
      path.push(goRight ? 1 : 0);
      if(goRight) slotIndex++;
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

app.get('/api/casino/my-bets', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const bets = await db.all('SELECT * FROM casino_bets WHERE user_id=? ORDER BY timestamp DESC LIMIT 20',[req.user.id]);
    res.json(bets);
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/admin/casino', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const bets = await db.all(`SELECT cb.*,u.name as user_name FROM casino_bets cb JOIN users u ON cb.user_id=u.id ORDER BY cb.timestamp DESC LIMIT 200`);
    const stats = await db.get(`SELECT COUNT(*) as total_bets, SUM(bet_amount) as total_wagered, SUM(profit) as house_profit FROM casino_bets`);
    res.json({bets, stats});
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
    console.log(`\n🚀 Jewshi Markets running at http://localhost:${PORT}\n`);
  });
}).catch(err=>{console.error('DB init failed:',err);process.exit(1);});
