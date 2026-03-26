const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'ew-markets-secret-change-in-production';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

async function initDB() {
  db = await open({ filename: 'ew-markets.db', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, name TEXT, password TEXT NOT NULL,
      role TEXT DEFAULT 'student', credits INTEGER DEFAULT 200, grade TEXT DEFAULT ''
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
      status TEXT DEFAULT 'active', payout REAL DEFAULT 0, timestamp INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (market_id) REFERENCES markets(id)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount REAL NOT NULL,
      type TEXT NOT NULL, reference_id TEXT, description TEXT, timestamp INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS volunteer_submissions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org TEXT, hours REAL,
      description TEXT, date TEXT, status TEXT DEFAULT 'pending',
      credits_awarded INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS store_items (
      id TEXT PRIMARY KEY, name TEXT, icon TEXT, cost INTEGER, description TEXT
    );
    CREATE TABLE IF NOT EXISTS redemptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, item_id TEXT NOT NULL,
      cost INTEGER, timestamp INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (item_id) REFERENCES store_items(id)
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  await seedIfEmpty();
}

async function seedIfEmpty() {
  const row = await db.get('SELECT COUNT(*) as c FROM users');
  if (row.c > 0) return;
  const users = [
    { id: 'GROSE',       name: 'Administrator', password: 'BryceB0mb!', role: 'admin',   credits: 0,   grade: '' },
    { id: 'STUDENT-001', name: 'Blake Gubitz',  password: 'daren',      role: 'student', credits: 500, grade: '' },
    { id: 'STUDENT-002', name: 'Student 002',   password: 'Hello123',   role: 'student', credits: 500, grade: '' },
    { id: 'STUDENT-003', name: 'Student 003',   password: 'BigIce',     role: 'student', credits: 500, grade: '' },
  ];
  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 10);
    await db.run('INSERT INTO users (id,name,password,role,credits,grade) VALUES (?,?,?,?,?,?)',
      [u.id, u.name, hash, u.role, u.credits, u.grade]);
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

function generateId(p='') { return p+Date.now()+Math.random().toString(36).slice(2,6); }
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

// AUTH
app.post('/api/auth/login', async(req,res)=>{
  try{
    const {id,password}=req.body;
    if(!id||!password) return res.status(400).json({error:'Missing fields'});
    const user=await db.get('SELECT * FROM users WHERE id=?',[id.toUpperCase()]);
    if(!user) return res.status(401).json({error:'Invalid ID or password'});
    if(!await bcrypt.compare(password,user.password)) return res.status(401).json({error:'Invalid ID or password'});
    const token=jwt.sign({id:user.id,role:user.role},JWT_SECRET,{expiresIn:'7d'});
    const {password:_,...safe}=user;
    res.json({token,user:safe});
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/auth/register', async(req,res)=>{
  try{
    const {id,name,password,grade}=req.body;
    if(!id||!name||!password) return res.status(400).json({error:'Missing fields'});
    const uid=id.toUpperCase();
    if(await db.get('SELECT id FROM users WHERE id=?',[uid])) return res.status(409).json({error:'ID already exists'});
    const hash=await bcrypt.hash(password,10);
    await db.run('INSERT INTO users (id,name,password,role,credits,grade) VALUES (?,?,?,?,?,?)',[uid,name,hash,'student',200,grade||'']);
    await recordTx(uid,200,'signup_bonus',null,'Welcome bonus');
    const token=jwt.sign({id:uid,role:'student'},JWT_SECRET,{expiresIn:'7d'});
    res.json({token,user:{id:uid,name,role:'student',credits:200,grade:grade||''}});
  }catch(e){res.status(500).json({error:e.message});}
});

// USER
app.get('/api/me', authMiddleware, async(req,res)=>{
  res.json(await db.get('SELECT id,name,role,credits,grade FROM users WHERE id=?',[req.user.id]));
});
app.get('/api/users', authMiddleware, adminOnly, async(req,res)=>{
  res.json(await db.all("SELECT id,name,role,credits,grade FROM users WHERE role='student'"));
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

// MARKETS
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
    await db.run('BEGIN');
    try{
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
      await db.run('COMMIT');
      res.json({success:true,outcome});
    }catch(err){await db.run('ROLLBACK');throw err;}
  }catch(e){res.status(500).json({error:e.message});}
});
app.post('/api/markets/:id/close', authMiddleware, adminOnly, async(req,res)=>{
  await db.run("UPDATE markets SET status='closed' WHERE id=?",[req.params.id]);
  res.json({success:true});
});

// BETS
app.post('/api/bets', authMiddleware, async(req,res)=>{
  try{
    const {marketId,side,amount}=req.body;
    if(!marketId||!side||!amount||amount<=0) return res.status(400).json({error:'Invalid bet'});
    if(!['YES','NO'].includes(side)) return res.status(400).json({error:'Bad side'});
    await db.run('BEGIN');
    try{
      const user=await db.get('SELECT * FROM users WHERE id=?',[req.user.id]);
      if(user.credits<amount) throw new Error('Insufficient credits');
      const m=await db.get('SELECT * FROM markets WHERE id=?',[marketId]);
      if(!m||m.status!=='open') throw new Error('Market not available');
      const shares=lmsrShares(m.yes_shares,m.no_shares,m.b_param,side,amount);
      await db.run('UPDATE users SET credits=credits-? WHERE id=?',[amount,user.id]);
      if(side==='YES') await db.run('UPDATE markets SET yes_shares=yes_shares+?,pool=pool+? WHERE id=?',[shares,amount,m.id]);
      else await db.run('UPDATE markets SET no_shares=no_shares+?,pool=pool+? WHERE id=?',[shares,amount,m.id]);
      const betId=generateId('b');
      await db.run("INSERT INTO bets (id,user_id,market_id,side,amount,shares,status,timestamp) VALUES (?,?,?,?,?,?,'active',?)",
        [betId,user.id,marketId,side,amount,parseFloat(shares.toFixed(4)),Date.now()]);
      await recordTx(user.id,-amount,'bet_placed',betId,`Bet ${side} on: ${m.question}`);
      await db.run('COMMIT');
      res.json({betId,shares:parseFloat(shares.toFixed(4)),newBalance:user.credits-amount});
    }catch(err){await db.run('ROLLBACK');throw err;}
  }catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/bets/mine', authMiddleware, async(req,res)=>{
  res.json(await db.all(`
    SELECT b.*,m.question,m.category,m.status as market_status,m.yes_shares,m.no_shares,m.b_param
    FROM bets b JOIN markets m ON b.market_id=m.id WHERE b.user_id=? ORDER BY b.timestamp DESC`,[req.user.id]));
});

// LEADERBOARD
app.get('/api/leaderboard', authMiddleware, async(req,res)=>{
  res.json(await db.all("SELECT id,name,grade,credits FROM users WHERE role='student' ORDER BY credits DESC"));
});

// STORE
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
    await db.run('BEGIN');
    try{
      const item=await db.get('SELECT * FROM store_items WHERE id=?',[req.params.id]);
      if(!item) throw new Error('Item not found');
      const user=await db.get('SELECT * FROM users WHERE id=?',[req.user.id]);
      if(user.credits<item.cost) throw new Error('Insufficient credits');
      await db.run('UPDATE users SET credits=credits-? WHERE id=?',[item.cost,user.id]);
      const rId=generateId('r');
      await db.run('INSERT INTO redemptions (id,user_id,item_id,cost,timestamp) VALUES (?,?,?,?,?)',[rId,user.id,item.id,item.cost,Date.now()]);
      await recordTx(user.id,-item.cost,'redemption',rId,`Redeemed: ${item.name}`);
      await db.run('COMMIT');
      res.json({newBalance:user.credits-item.cost});
    }catch(err){await db.run('ROLLBACK');throw err;}
  }catch(e){res.status(400).json({error:e.message});}
});
app.get('/api/store/redemptions/mine', authMiddleware, async(req,res)=>{
  res.json(await db.all(`SELECT r.*,s.name,s.icon FROM redemptions r JOIN store_items s ON r.item_id=s.id WHERE r.user_id=? ORDER BY r.timestamp DESC`,[req.user.id]));
});

// VOLUNTEER
app.post('/api/volunteer', authMiddleware, async(req,res)=>{
  try{
    const {org,hours,description,date}=req.body;
    if(!org||!hours||!description||!date) return res.status(400).json({error:'Missing fields'});
    const id=generateId('v');
    await db.run("INSERT INTO volunteer_submissions (id,user_id,org,hours,description,date,status,credits_awarded) VALUES (?,?,?,?,?,?,'pending',0)",
      [id,req.user.id,org,hours,description,date]);
    res.json({id,status:'pending'});
  }catch(e){res.status(500).json({error:e.message});}
});
app.get('/api/volunteer/mine', authMiddleware, async(req,res)=>{
  res.json(await db.all('SELECT * FROM volunteer_submissions WHERE user_id=? ORDER BY date DESC',[req.user.id]));
});
app.get('/api/volunteer/pending', authMiddleware, adminOnly, async(req,res)=>{
  res.json(await db.all(`SELECT v.*,u.name as student_name FROM volunteer_submissions v JOIN users u ON v.user_id=u.id WHERE v.status='pending'`));
});
app.post('/api/volunteer/:id/approve', authMiddleware, adminOnly, async(req,res)=>{
  try{
    await db.run('BEGIN');
    try{
      const v=await db.get('SELECT * FROM volunteer_submissions WHERE id=?',[req.params.id]);
      if(!v) throw new Error('Not found');
      const rate=parseInt((await db.get("SELECT value FROM settings WHERE key='volunteer_rate'"))?.value||'100');
      const credits=Math.round(v.hours*rate);
      await db.run("UPDATE volunteer_submissions SET status='approved',credits_awarded=? WHERE id=?",[credits,v.id]);
      await db.run('UPDATE users SET credits=credits+? WHERE id=?',[credits,v.user_id]);
      await recordTx(v.user_id,credits,'volunteer_approved',v.id,`Volunteer: ${v.org}`);
      await db.run('COMMIT');
      res.json({credits});
    }catch(err){await db.run('ROLLBACK');throw err;}
  }catch(e){res.status(400).json({error:e.message});}
});
app.post('/api/volunteer/:id/reject', authMiddleware, adminOnly, async(req,res)=>{
  await db.run("UPDATE volunteer_submissions SET status='rejected' WHERE id=?",[req.params.id]);
  res.json({success:true});
});

// ADMIN
app.post('/api/admin/distribute-credits', authMiddleware, adminOnly, async(req,res)=>{
  try{
    const {amount}=req.body;
    if(!amount||amount<=0) return res.status(400).json({error:'Invalid amount'});
    await db.run('BEGIN');
    try{
      const students=await db.all("SELECT id FROM users WHERE role='student'");
      for(const s of students){
        await db.run('UPDATE users SET credits=credits+? WHERE id=?',[amount,s.id]);
        await recordTx(s.id,amount,'weekly_distribution',null,`Weekly: +${amount}`);
      }
      await db.run('COMMIT');
      res.json({distributed:students.length});
    }catch(err){await db.run('ROLLBACK');throw err;}
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
  const pendingVol=(await db.get("SELECT COUNT(*) as c FROM volunteer_submissions WHERE status='pending'")).c;
  const circ=(await db.get("SELECT SUM(credits) as s FROM users WHERE role='student'")).s||0;
  res.json({students,openMarkets,totalBets,pendingVol,totalCreditsInCirculation:circ});
});

initDB().then(()=>{
  app.listen(PORT,()=>{
    console.log(`\n🚀 EW Markets running at http://localhost:${PORT}`);
    console.log(`\n  Admin:      GROSE        / BryceB0mb!`);
    console.log(`  Student 1:  STUDENT-001  / daren`);
    console.log(`  Student 2:  STUDENT-002  / Hello123`);
    console.log(`  Student 3:  STUDENT-003  / BigIce\n`);
  });
}).catch(err=>{console.error('DB init failed:',err);process.exit(1);});
