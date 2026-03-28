require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'jewshi-secret-change-in-production';
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';

app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

async function initDB() {
  db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  db.run = async (sql, args=[]) => { await db.execute({ sql, args }); };
  db.get = async (sql, args=[]) => {
    const res = await db.execute({ sql, args });
    return res.rows[0] || null;
  };
  db.all = async (sql, args=[]) => {
    const res = await db.execute({ sql, args });
    return res.rows;
  };
  db.exec = async (sql) => {
    const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const s of statements) await db.execute(s);
  };

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT NOT NULL,
      role TEXT DEFAULT 'student', credits INTEGER DEFAULT 200, grade TEXT DEFAULT '',
      email_verified INTEGER DEFAULT 1
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
      market_type TEXT DEFAULT 'binary',
      line REAL DEFAULT NULL,
      over_shares REAL DEFAULT 0,
      under_shares REAL DEFAULT 0
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
    )
  `);

  await seedIfEmpty();
}

async function seedIfEmpty() {
  const row = await db.get('SELECT COUNT(*) as c FROM users');
  if (row.c > 0) return;
  const users = [
    { id: 'GROSE',       name: 'Administrator', email: 'grose@emeryweiner.org', password: 'BryceB0mb!', role: 'admin',   credits: 0,   grade: '' },
    { id: 'STUDENT-001', name: 'Blake Gubitz',  email: 'blake@jewshi.com',      password: 'daren',      role: 'student', credits: 500, grade: '' },
    { id: 'STUDENT-002', name: 'Student 002',   email: 'student2@jewshi.com',   password: 'Hello123',   role: 'student', credits: 500, grade: '' },
    { id: 'STUDENT-003', name: 'Student 003',   email: 'student3@jewshi.com',   password: 'BigIce',     role: 'student', credits: 500, grade: '' },
  ];
  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await db.run('INSERT INTO users (id,name,email,password,role,credits,grade,email_verified) VALUES (?,?,?,?,?,?,?,1)',
      [u.id, u.name, u.email, hash, u.role, u.credits, u.grade]);
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

function generateId(p='') { return p+Date.now()+Math.random().toString(36).slice(2,6); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

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
  if (!user || user.role !== 'admin') return res.status(403).json({error:'Admin only'});
  next();
}

function isGrose(req) { return req.user.id === 'GROSE'; }

function getYesPercent(m) {
  const total = (m.yes_shares||0) + (m.no_shares||0);
  return total===0 ? 50 : Math.round((m.yes_shares/total)*100);
}
function getOverPercent(m) {
  const total = (m.over_shares||0) + (m.under_shares||0);
  return total===0 ? 50 : Math.round((m.over_shares/total)*100);
}

// ── ACCESS PASSWORD ──
app.post('/api/access/verify', authMiddleware, async(req,res)=>{
  try{
    const {password} = req.body;
    const row = await db.get("SELECT value FROM settings WHERE key='access_password'");
    const correct = row?.value || 'jewshi2025';
    if(password === correct) res.json({success:true});
    else res.status(401).json({error:'Wrong password'});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/admin/access-password', authMiddleware, adminOnly, async(req,res)=>{
  try{
    if(!isGrose(req)) return res.status(403).json({error:'Only the primary admin can change the access password'});
    const {password} = req.body;
    if(!password||password.length<4) return res.status(400).json({error:'Password too short'});
    await db.run("INSERT OR REPLACE INTO settings (key,value) VALUES ('access_password',?)",[password]);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── LIVE FEED ──
app.get('/api/live', async(req,res)=>{
  try{
    const totalCredits = (await db.get("SELECT SUM(credits) as s FROM users WHERE role='student'")).s || 0;
    const activePlayers = (await db.get("SELECT COUNT(*) as c FROM users WHERE role='student'")).c || 0;
    const markets = await db.all("SELECT id,question,category,close_date,pool,yes_shares,no_shares,over_shares,under_shares,market_type,line,status FROM markets WHERE status='open' ORDER BY created_at DESC");
    const totalBets = (await db.get("SELECT COUNT(*) as c FROM bets WHERE status='active'")).c || 0;
    res.json({ totalCredits, activePlayers, markets, totalBets });
  }catch(e){res.status(500).json({error:e.message});}
});

// ── STRIPE ──
app.post('/api/credits/checkout', authMiddleware, async (req, res) => {
  try {
    const { amountCents } = req.body;
    if (!amountCents || amountCents < 100) return res.status(400).json({ error: 'Minimum purchase is $1.00' });
    const credits = Math.floor(amountCents / 100) * 100;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', unit_amount: amountCents, product_data: { name: `Jewshi Markets — ${credits.toLocaleString()} Credits` } }, quantity: 1 }],
      mode: 'payment',
      success_url: `${CLIENT_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/?cancelled=1`,
      metadata: { user_id: req.user.id, credits: String(credits) },
    });
    await db.run('INSERT INTO stripe_sessions (session_id,user_id,credits,fulfilled,created_at) VALUES (?,?,?,0,?)',
      [session.id, req.user.id, credits, Date.now()]);
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch(e) { return res.status(400).send(`Webhook Error: ${e.message}`); }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { user_id, credits } = session.metadata;
    const creditsNum = parseInt(credits);
    const existing = await db.get('SELECT fulfilled FROM stripe_sessions WHERE session_id=?', [session.id]);
    if (!existing || existing.fulfilled) return res.json({ received: true });
    await db.run('UPDATE users SET credits=credits+? WHERE id=?', [creditsNum, user_id]);
    await recordTx(user_id, creditsNum, 'purchase', session.id, `Purchased ${creditsNum} credits`);
    await db.run('UPDATE stripe_sessions SET fulfilled=1 WHERE session_id=?', [session.id]);
  }
  res.json({ received: true });
});

app.get('/api/credits/verify/:sessionId', authMiddleware, async (req, res) => {
  const row = await db.get('SELECT fulfilled, credits FROM stripe_sessions WHERE session_id=? AND user_id=?',
    [req.params.sessionId, req.user.id]);
  if (!row) return res.status(404).json({ error: 'Session not found' });
  res.json({ fulfilled: !!row.fulfilled, credits: row.credits });
});

// ── AUTH ──
app.post('/api/auth/login', async(req,res)=>{
  try{
    const {email, password} = req.body;
    if(!email||!password) return res.status(400).json({error:'Missing fields'});
    const user = await db.get('SELECT * FROM users WHERE LOWER(email)=LOWER(?)',[email.trim()]);
    if(!user) return res.status(401).json({error:'Invalid email or password'});
    if(!await bcrypt.compare(password,user.password)) return res.status(401).json({error:'Invalid email or password'});
    const token = jwt.sign({id:user.id,role:user.role}, JWT_SECRET, {expiresIn:'30d'});
    const {password:_,...safe} = user;
    res.json({token, user:safe});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/register', async(req,res)=>{
  try{
    const {name, email, password, grade} = req.body;
    if(!name||!email||!password) return res.status(400).json({error:'Missing fields'});
    const trimmedEmail = email.trim().toLowerCase();
    if(await db.get('SELECT id FROM users WHERE LOWER(email)=?',[trimmedEmail]))
      return res.status(409).json({error:'An account with that email already exists'});
    const hash = await bcrypt.hash(password, 10);
    const uid = generateId('U');
    await db.run('INSERT INTO users (id,name,email,password,role,credits,grade,email_verified) VALUES (?,?,?,?,?,?,?,1)',
      [uid, name.trim(), trimmedEmail, hash, 'student', 200, grade||'']);
    await recordTx(uid, 200, 'signup_bonus', null, 'Welcome bonus');
    appendToSheet(name.trim(), trimmedEmail, grade||'');
    const token = jwt.sign({id:uid,role:'student'}, JWT_SECRET, {expiresIn:'30d'});
    const user = await db.get('SELECT id,name,email,role,credits,grade FROM users WHERE id=?',[uid]);
    res.json({token, user, message:'Account created!'});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/forgot-password', async(req,res)=>{
  try{
    const {email} = req.body;
    const user = await db.get('SELECT * FROM users WHERE LOWER(email)=LOWER(?)',[email?.trim()]);
    if(user){
      const token = generateToken();
      await db.run('INSERT INTO password_reset_tokens (token,user_id,expires_at,used,created_at) VALUES (?,?,?,0,?)',
        [token, user.id, Date.now()+3600000, Date.now()]);
      console.log(`[Dev] Reset link: ${CLIENT_URL}/reset-password.html?token=${token}`);
    }
    res.json({message:'If that email has an account, a reset link has been sent.'});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/reset-password', async(req,res)=>{
  try{
    const {token, password} = req.body;
    if(!token||!password||password.length<6) return res.status(400).json({error:'Invalid request'});
    const row = await db.get('SELECT * FROM password_reset_tokens WHERE token=? AND used=0',[token]);
    if(!row||row.expires_at<Date.now()) return res.status(400).json({error:'Invalid or expired link'});
    const hash = await bcrypt.hash(password, 10);
    await db.run('UPDATE users SET password=? WHERE id=?',[hash, row.user_id]);
    await db.run('UPDATE password_reset_tokens SET used=1 WHERE token=?',[token]);
    res.json({message:'Password updated!'});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── USER ──
app.get('/api/me', authMiddleware, async(req,res)=>{
  const user = await db.get('SELECT id,name,email,role,credits,grade FROM users WHERE id=?',[req.user.id]);
  if(!user) return res.status(404).json({error:'User not found'});
  res.json(user);
});
app.get('/api/users', authMiddleware, adminOnly, async(req,res)=>{
  res.json(await db.all("SELECT id,name,email,role,credits,grade FROM users WHERE id!=?",[req.user.id]));
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
  if(!isGrose(req)) return res.status(403).json({error:'Only the primary admin can promote users'});
  await db.run("UPDATE users SET role='admin' WHERE id=?",[req.params.id]);
  res.json({success:true});
});
app.post('/api/users/:id/make-student', authMiddleware, adminOnly, async(req,res)=>{
  if(!isGrose(req)) return res.status(403).json({error:'Only the primary admin can demote users'});
  if(req.params.id==='GROSE') return res.status(400).json({error:'Cannot demote primary admin'});
  await db.run("UPDATE users SET role='student' WHERE id=?",[req.params.id]);
  res.json({success:true});
});
app.delete('/api/users/:id', authMiddleware, adminOnly, async(req,res)=>{
  const {id}=req.params;
  if(id==='GROSE') return res.status(400).json({error:'Cannot delete primary admin'});
  await db.run('DELETE FROM bets WHERE user_id=?',[id]);
  await db.run('DELETE FROM transactions WHERE user_id=?',[id]);
  await db.run('DELETE FROM redemptions WHERE user_id=?',[id]);
  await db.run('DELETE FROM stripe_sessions WHERE user_id=?',[id]);
  await db.run('DELETE FROM messages WHERE sender_id=? OR recipient_id=?',[id,id]);
  await db.run('DELETE FROM users WHERE id=?',[id]);
  res.json({success:true});
});

// ── MARKETS ──
app.get('/api/markets', authMiddleware, async(req,res)=>{
  const {category}=req.query;
  res.json(category
    ? await db.all('SELECT * FROM markets WHERE category=? ORDER BY created_at DESC',[category])
    : await db.all('SELECT * FROM markets ORDER BY created_at DESC'));
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
    res.json({success:true,outcome});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/markets/:id/resolve-overunder', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {actual}=req.body;
    if(actual===undefined||actual===null) return res.status(400).json({error:'Actual result required'});
    const m=await db.get('SELECT * FROM markets WHERE id=?',[req.params.id]);
    if(!m||m.status!=='open') return res.status(400).json({error:'Not open'});
    const outcome = parseFloat(actual) > parseFloat(m.line) ? 'OVER' : 'UNDER';
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
  res.json(await db.all(`
    SELECT b.*,m.question,m.category,m.status as market_status,m.yes_shares,m.no_shares,
           m.b_param,m.market_type,m.line,m.over_shares,m.under_shares
    FROM bets b JOIN markets m ON b.market_id=m.id WHERE b.user_id=? ORDER BY b.timestamp DESC`,[req.user.id]));
});

// ── LEADERBOARD ──
app.get('/api/leaderboard', authMiddleware, async(req,res)=>{
  res.json(await db.all("SELECT id,name,grade,credits FROM users WHERE role='student' ORDER BY credits DESC"));
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
    const {recipientId, text} = req.body;
    if(!recipientId||!text||!text.trim()) return res.status(400).json({error:'Missing fields'});
    const recipient = await db.get('SELECT id FROM users WHERE id=?',[recipientId]);
    if(!recipient) return res.status(404).json({error:'User not found'});
    const id = generateId('msg');
    await db.run('INSERT INTO messages (id,sender_id,recipient_id,text,is_read,timestamp) VALUES (?,?,?,?,0,?)',
      [id, req.user.id, recipientId, text.trim(), Date.now()]);
    res.json({id, success:true});
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/messages/conversations', authMiddleware, async(req,res)=>{
  try{
    const rows = await db.all(`SELECT DISTINCT CASE WHEN sender_id=? THEN recipient_id ELSE sender_id END as other_id FROM messages WHERE sender_id=? OR recipient_id=?`,
      [req.user.id, req.user.id, req.user.id]);
    const conversations = [];
    for(const row of rows){
      const other = await db.get('SELECT id,name,grade,role FROM users WHERE id=?',[row.other_id]);
      if(!other) continue;
      const last = await db.get(`SELECT * FROM messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY timestamp DESC LIMIT 1`,
        [req.user.id, row.other_id, row.other_id, req.user.id]);
      const unread = await db.get(`SELECT COUNT(*) as c FROM messages WHERE sender_id=? AND recipient_id=? AND is_read=0`,[row.other_id, req.user.id]);
      conversations.push({other, lastMessage: last, unreadCount: unread.c});
    }
    conversations.sort((a,b) => (b.lastMessage?.timestamp||0) - (a.lastMessage?.timestamp||0));
    res.json(conversations);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/messages/thread/:userId', authMiddleware, async(req,res)=>{
  try{
    const other = req.params.userId;
    const messages = await db.all(`SELECT m.*, u.name as sender_name FROM messages m JOIN users u ON m.sender_id=u.id WHERE (m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?) ORDER BY m.timestamp ASC`,
      [req.user.id, other, other, req.user.id]);
    await db.run('UPDATE messages SET is_read=1 WHERE sender_id=? AND recipient_id=?',[other, req.user.id]);
    res.json(messages);
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/messages/unread-count', authMiddleware, async(req,res)=>{
  const row = await db.get('SELECT COUNT(*) as c FROM messages WHERE recipient_id=? AND is_read=0',[req.user.id]);
  res.json({count: row.c});
});
app.get('/api/messages/users', authMiddleware, async(req,res)=>{
  res.json(await db.all("SELECT id,name,grade,role FROM users WHERE id!=? ORDER BY name ASC",[req.user.id]));
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

initDB().then(()=>{
  app.listen(PORT,()=>{ console.log(`\n🚀 Jewshi Markets running at http://localhost:${PORT}\n`); });
}).catch(err=>{console.error('DB init failed:',err);process.exit(1);});
