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

// ── TURSO DB ──
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
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'student',
      credits INTEGER DEFAULT 200,
      grade TEXT DEFAULT '',
      email_verified INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER DEFAULT 0,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS markets (
      id TEXT PRIMARY KEY, question TEXT NOT NULL, category TEXT,
      status TEXT DEFAULT 'open', close_date TEXT,
      yes_shares REAL DEFAULT 50, no_shares REAL DEFAULT 50,
      b_param REAL DEFAULT 100, pool INTEGER DEFAULT 500, created_at INTEGER
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
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      credits INTEGER NOT NULL,
      fulfilled INTEGER DEFAULT 0,
      created_at INTEGER
    )
  `);

  await seedIfEmpty();
}

async function seedIfEmpty() {
  const row = await db.get('SELECT COUNT(*) as c FROM users');
  if (row.c > 0) return;
  const users = [
    { id: 'GROSE',       name: 'Administrator', email: process.env.ADMIN_EMAIL || 'admin@jewshi.com',   password: 'BryceB0mb!', role: 'admin',   credits: 0,   grade: '' },
    { id: 'STUDENT-001', name: 'Blake Gubitz',  email: 'blake@jewshi.com',    password: 'daren',      role: 'student', credits: 500, grade: '' },
    { id: 'STUDENT-002', name: 'Student 002',   email: 'student2@jewshi.com', password: 'Hello123',   role: 'student', credits: 500, grade: '' },
    { id: 'STUDENT-003', name: 'Student 003',   email: 'student3@jewshi.com', password: 'BigIce',     role: 'student', credits: 500, grade: '' },
  ];
  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await db.run(
      'INSERT INTO users (id,name,email,password,role,credits,grade,email_verified) VALUES (?,?,?,?,?,?,?,1)',
      [u.id, u.name, u.email, hash, u.role, u.credits, u.grade]
    );
  }
  const items = [
    ['s1','Café Sandwich','🥪',150,'Redeemable at school café'],
    ['s2','EW Spirit Shirt','👕',400,'Official school wear'],
    ['s3','Free Dress Day Pass','👔',300,'One day dress-code waiver'],
    ['s4','Smoothie Voucher','🥤',100,'Any smoothie from café'],
  ];
  for (const [id,name,icon,cost,desc] of items)
    await db.run('INSERT INTO store_items (id,name,icon,cost,description) VALUES (?,?,?,?,?)',[id,name,icon,cost,desc]);
  await db.run(`INSERT INTO markets (id,question,category,status,close_date,yes_shares,no_shares,b_param,pool,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['m1','Will the Eagles win the district championship?','Sports','open','2025-06-01',52,48,100,800,Date.now()]);
  await db.run(`INSERT INTO markets (id,question,category,status,close_date,yes_shares,no_shares,b_param,pool,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['m2','Will the school play open on time?','School','open','2025-05-15',65,35,100,400,Date.now()]);
  await db.run("INSERT OR IGNORE INTO settings (key,value) VALUES ('volunteer_rate','100')");
  console.log('Database seeded.');
}

// ── GOOGLE SHEETS ──
async function appendToSheet(name, email, grade) {
  try {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_SHEET_ID) {
      console.log(`[Sheets] Not configured — skipping sheet append for ${email}`);
      return;
    }
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:D',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[name, email, grade, new Date().toLocaleString()]],
      },
    });
    console.log(`[Sheets] Appended ${name} (${email}) to sheet`);
  } catch(e) {
    console.error('[Sheets] Error:', e.message);
  }
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
function adminOnly(req,res,next) {
  if (req.user.role !== 'admin') return res.status(403).json({error:'Admin only'});
  next();
}
function lmsrCost(y,n,b) { return b*Math.log(Math.exp(y/b)+Math.exp(n/b)); }
function lmsrShares(y,n,b,side,amt) {
  const cb=lmsrCost(y,n,b); let lo=0,hi=amt*10;
  for(let i=0;i<60;i++){const m=(lo+hi)/2;const ca=side==='YES'?lmsrCost(y+m,n,b):lmsrCost(y,n+m,b);if(ca-cb<amt)lo=m;else hi=m;}
  return (lo+hi)/2;
}

// ── STRIPE ──
app.post('/api/credits/checkout', authMiddleware, async (req, res) => {
  try {
    const { amountCents } = req.body;
    if (!amountCents || amountCents < 100) return res.status(400).json({ error: 'Minimum purchase is $1.00' });
    const credits = Math.floor(amountCents / 100) * 100;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', unit_amount: amountCents, product_data: { name: `Jewshi Markets — ${credits.toLocaleString()} Credits`, description: `${credits} credits added to your Jewshi account` } }, quantity: 1 }],
      mode: 'payment',
      success_url: `${CLIENT_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CLIENT_URL}/?cancelled=1`,
      metadata: { user_id: req.user.id, credits: String(credits) },
    });
    await db.run('INSERT INTO stripe_sessions (session_id,user_id,credits,fulfilled,created_at) VALUES (?,?,?,0,?)',
      [session.id, req.user.id, credits, Date.now()]);
    res.json({ url: session.url });
  } catch(e) { console.error('Checkout error:', e); res.status(500).json({ error: e.message }); }
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
    try {
      await db.run('UPDATE users SET credits=credits+? WHERE id=?', [creditsNum, user_id]);
      await recordTx(user_id, creditsNum, 'purchase', session.id, `Purchased ${creditsNum} credits`);
      await db.run('UPDATE stripe_sessions SET fulfilled=1 WHERE session_id=?', [session.id]);
    } catch(e) { console.error('Fulfillment error:', e); return res.status(500).json({ error: e.message }); }
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

    // Append to Google Sheet (non-blocking)
    appendToSheet(name.trim(), trimmedEmail, grade||'');

    const token = jwt.sign({id:uid,role:'student'}, JWT_SECRET, {expiresIn:'30d'});
    const user = await db.get('SELECT id,name,email,role,credits,grade FROM users WHERE id=?',[uid]);
    res.json({token, user, message:'Account created!'});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/forgot-password', async(req,res)=>{
  try{
    const {email} = req.body;
    if(!email) return res.status(400).json({error:'Missing email'});
    const user = await db.get('SELECT * FROM users WHERE LOWER(email)=LOWER(?)',[email.trim()]);
    if(user){
      await db.run('UPDATE password_reset_tokens SET used=1 WHERE user_id=?',[user.id]);
      const token = generateToken();
      await db.run('INSERT INTO password_reset_tokens (token,user_id,expires_at,used,created_at) VALUES (?,?,?,0,?)',
        [token, user.id, Date.now() + 60*60*1000, Date.now()]);
      console.log(`[Dev] Password reset link for ${user.email}:\n${CLIENT_URL}/reset-password.html?token=${token}`);
    }
    res.json({message:'If that email has an account, a reset link has been sent.'});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/reset-password', async(req,res)=>{
  try{
    const {token, password} = req.body;
    if(!token||!password) return res.status(400).json({error:'Missing fields'});
    if(password.length < 6) return res.status(400).json({error:'Password must be at least 6 characters'});
    const row = await db.get('SELECT * FROM password_reset_tokens WHERE token=? AND used=0',[token]);
    if(!row) return res.status(400).json({error:'Invalid or expired reset link'});
    if(row.expires_at < Date.now()) return res.status(400).json({error:'Reset link expired.'});
    const hash = await bcrypt.hash(password, 10);
    await db.run('UPDATE users SET password=? WHERE id=?',[hash, row.user_id]);
    await db.run('UPDATE password_reset_tokens SET used=1 WHERE token=?',[token]);
    res.json({message:'Password updated! You can now sign in.'});
  }catch(e){res.status(500).json({error:e.message});}
});

// ── USER ──
app.get('/api/me', authMiddleware, async(req,res)=>{
  const user = await db.get('SELECT id,name,email,role,credits,grade FROM users WHERE id=?',[req.user.id]);
  if(!user) return res.status(404).json({error:'User not found'});
  res.json(user);
});
app.get('/api/users', authMiddleware, adminOnly, async(req,res)=>{
  res.json(await db.all("SELECT id,name,email,role,credits,grade FROM users WHERE role='student'"));
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
    const {question,category,closeDate,liquidity}=req.body;
    if(!question||!closeDate) return res.status(400).json({error:'Missing fields'});
    const liq=liquidity||500; const id=generateId('m');
    await db.run(`INSERT INTO markets (id,question,category,status,close_date,yes_shares,no_shares,b_param,pool,created_at) VALUES (?,?,?,'open',?,50,50,?,?,?)`,
      [id,question,category||'General',closeDate,Math.max(50,Math.round(liq/5)),liq,Date.now()]);
    res.json(await db.get('SELECT * FROM markets WHERE id=?',[id]));
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/markets/:id/resolve', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {outcome}=req.body;
    if(!['YES','NO'].includes(outcome)) return res.status(400).json({error:'Bad outcome'});
    const m=await db.get('SELECT * FROM markets WHERE id=?',[req.params.id]);
    if(!m) return res.status(404).json({error:'Not found'});
    if(m.status!=='open') return res.status(400).json({error:'Not open'});
    await db.run('UPDATE markets SET status=? WHERE id=?',[outcome==='YES'?'resolved-yes':'resolved-no',m.id]);
    const wins=await db.all("SELECT * FROM bets WHERE market_id=? AND side=? AND status='active'",[m.id,outcome]);
    const total=wins.reduce((s,b)=>s+b.shares,0);
    for(const b of wins){
      const pay=total>0?Math.round((b.shares/total)*m.pool):0;
      await db.run("UPDATE bets SET status='won',payout=? WHERE id=?",[pay,b.id]);
      await db.run('UPDATE users SET credits=credits+? WHERE id=?',[pay,b.user_id]);
      await recordTx(b.user_id,pay,'bet_won',b.id,`Won: ${m.question}`);
    }
    await db.run("UPDATE bets SET status='lost' WHERE market_id=? AND side!=? AND status='active'",[m.id,outcome]);
    res.json({success:true,outcome});
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
    if(!['YES','NO'].includes(side)) return res.status(400).json({error:'Bad side'});
    const user=await db.get('SELECT * FROM users WHERE id=?',[req.user.id]);
    if(user.credits<amount) return res.status(400).json({error:'Insufficient credits'});
    const m=await db.get('SELECT * FROM markets WHERE id=?',[marketId]);
    if(!m||m.status!=='open') return res.status(400).json({error:'Market not available'});
    const shares=lmsrShares(m.yes_shares,m.no_shares,m.b_param,side,amount);
    await db.run('UPDATE users SET credits=credits-? WHERE id=?',[amount,user.id]);
    if(side==='YES') await db.run('UPDATE markets SET yes_shares=yes_shares+?,pool=pool+? WHERE id=?',[shares,amount,m.id]);
    else await db.run('UPDATE markets SET no_shares=no_shares+?,pool=pool+? WHERE id=?',[shares,amount,m.id]);
    const betId=generateId('b');
    await db.run("INSERT INTO bets (id,user_id,market_id,side,amount,shares,status,timestamp) VALUES (?,?,?,?,?,?,'active',?)",
      [betId,user.id,marketId,side,amount,parseFloat(shares.toFixed(4)),Date.now()]);
    await recordTx(user.id,-amount,'bet_placed',betId,`Bet ${side} on: ${m.question}`);
    res.json({betId,shares:parseFloat(shares.toFixed(4)),newBalance:user.credits-amount});
  }catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/bets/mine', authMiddleware, async(req,res)=>{
  res.json(await db.all(`
    SELECT b.*,m.question,m.category,m.status as market_status,m.yes_shares,m.no_shares,m.b_param
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
