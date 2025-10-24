const express = require('express');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const parse = require('csv-parse');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'kds_v5.db');
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT, name TEXT, price REAL, category TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_no TEXT, items_json TEXT, special_requests TEXT, status TEXT DEFAULT 'placed',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, archived INTEGER DEFAULT 0
  )`);
});

function runAsync(sql, params=[]){ return new Promise((res,rej)=>{ db.run(sql, params, function(err){ if(err) rej(err); else res(this); }); }); }
function allAsync(sql, params=[]){ return new Promise((res,rej)=>{ db.all(sql, params, (err,rows)=>{ if(err) rej(err); else res(rows); }); }); }
function getAsync(sql, params=[]){ return new Promise((res,rej)=>{ db.get(sql, params, (err,row)=>{ if(err) rej(err); else res(row); }); }); }

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/items', async (req,res)=>{
  const rows = await allAsync('SELECT * FROM items ORDER BY id DESC');
  res.json(rows);
});

app.post('/api/items', async (req,res)=>{
  const { code, name, price, category } = req.body;
  if(!name) return res.status(400).json({error:'name required'});
  const r = await runAsync('INSERT INTO items (code,name,price,category) VALUES (?,?,?,?)',[code||'', name, price||0, category||'']);
  const newItem = await getAsync('SELECT * FROM items WHERE id = ?',[r.lastID]);
  io.emit('item:added', newItem);
  res.json({ok:true,id:r.lastID});
});

const upload = multer({ dest: 'uploads/' });
app.post('/api/items/upload-csv', upload.single('csv'), (req,res)=>{
  if(!req.file) return res.status(400).json({error:'csv required'});
  const fs = require('fs');
  const parser = fs.createReadStream(req.file.path).pipe(parse({ columns:true, trim:true }));
  const inserts = [];
  parser.on('data', row => {
    const code = row.code || row.Code || '';
    const name = row.name || row.Name || row.item || row.Item;
    const price = parseFloat(row.price || row.Price || 0) || 0;
    const category = row.category || row.Category || '';
    if(name) inserts.push({code,name,price,category});
  });
  parser.on('end', async ()=>{
    try{
      const stmt = db.prepare('INSERT INTO items (code,name,price,category) VALUES (?,?,?,?)');
      db.serialize(()=>{ inserts.forEach(it=> stmt.run(it.code,it.name,it.price,it.category)); stmt.finalize(); });
      fs.unlinkSync(req.file.path);
      const latest = await allAsync('SELECT * FROM items ORDER BY id DESC LIMIT 200');
      io.emit('items:bulk-update', latest);
      res.json({ok:true, inserted: inserts.length});
    }catch(e){
      res.status(500).json({error:e.message});
    }
  });
  parser.on('error', err => res.status(500).json({error:err.message}));
});

app.get('/api/orders', async (req,res)=>{
  const status = req.query.status;
  let rows;
  if(status) rows = await allAsync('SELECT * FROM orders WHERE status = ? AND archived = 0 ORDER BY created_at DESC',[status]);
  else rows = await allAsync('SELECT * FROM orders WHERE archived = 0 ORDER BY created_at DESC');
  rows = rows.map(r => ({...r, items: JSON.parse(r.items_json || '[]')}));
  res.json(rows);
});

app.post('/api/orders', async (req,res)=>{
  const { table_no, items, special_requests } = req.body;
  if(!table_no || !items || !Array.isArray(items)) return res.status(400).json({error:'table_no and items[] required'});
  const items_json = JSON.stringify(items);
  const r = await runAsync('INSERT INTO orders (table_no, items_json, special_requests, status) VALUES (?,?,?,?)',[table_no, items_json, special_requests||'', 'placed']);
  const newOrder = await getAsync('SELECT * FROM orders WHERE id = ?',[r.lastID]);
  newOrder.items = items;
  io.emit('order:placed', newOrder);
  res.json({ok:true, id: r.lastID});
});

app.post('/api/orders/:table_no/add-items', async (req,res)=>{
  const table_no = req.params.table_no;
  const { items, special_requests } = req.body;
  if(!items || !Array.isArray(items) || items.length===0) return res.status(400).json({error:'items[] required'});
  const existing = await getAsync('SELECT * FROM orders WHERE table_no = ? AND archived = 0 ORDER BY created_at DESC LIMIT 1',[table_no]);
  if(!existing) return res.status(404).json({error:'no active order for this table'});
  const existingItems = JSON.parse(existing.items_json || '[]');
  const newItems = existingItems.concat(items);
  const updatedRequests = (existing.special_requests || '') + (special_requests ? ('; ' + special_requests) : '');
  await runAsync('UPDATE orders SET items_json = ?, special_requests = ?, status = ? WHERE id = ?',[JSON.stringify(newItems), updatedRequests, 'placed', existing.id]);
  const updatedOrder = await getAsync('SELECT * FROM orders WHERE id = ?',[existing.id]);
  updatedOrder.items = JSON.parse(updatedOrder.items_json || '[]');
  io.emit('order:items-added', updatedOrder);
  res.json({ok:true, order: updatedOrder});
});

app.post('/api/orders/:id/status', async (req,res)=>{
  const id = req.params.id; const status = req.body.status;
  if (!['placed','preparing','ready','billed','archived'].includes(status)) return res.status(400).json({error:'invalid status'});
  await runAsync('UPDATE orders SET status = ?, archived = (CASE WHEN ? = "archived" THEN 1 ELSE archived END) WHERE id = ?',[status, status, id]);
  const updated = await getAsync('SELECT * FROM orders WHERE id = ?',[id]);
  updated.items = JSON.parse(updated.items_json || '[]');
  io.emit('order:status-changed', updated);
  res.json({ok:true});
});

app.post('/api/orders/:id/bill', async (req,res)=>{
  const id = req.params.id;
  await runAsync('UPDATE orders SET status = ?, archived = 1 WHERE id = ?',['billed', id]);
  const updated = await getAsync('SELECT * FROM orders WHERE id = ?',[id]);
  updated.items = JSON.parse(updated.items_json || '[]');
  io.emit('order:billed', updated);
  res.json({ok:true});
});

io.on('connection', (socket)=>{
  console.log('socket connected', socket.id);
  socket.on('refresh:orders', async ()=>{
    const rows = await allAsync('SELECT * FROM orders WHERE archived = 0 ORDER BY created_at DESC');
    socket.emit('orders:refresh', rows.map(r=>({...r, items: JSON.parse(r.items_json || '[]')})));
  });
  socket.on('refresh:items', async ()=>{
    const items = await allAsync('SELECT * FROM items ORDER BY id DESC');
    socket.emit('items:refresh', items);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log('KDS v5 running on port', PORT));
