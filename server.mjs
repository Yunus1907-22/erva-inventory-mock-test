import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const file = fileURLToPath(new URL('./inventory.json', import.meta.url));
const seed = JSON.parse(readFileSync(new URL('./seed.json', import.meta.url)));
let state = existsSync(file) ? JSON.parse(readFileSync(file)) : { revision: 1, updatedAt: new Date().toISOString(), stones: seed };
const clients = new Set();
const port=Number(process.env.PORT || 5174);
const remote=process.env.NODE_ENV==='production';
const adminToken=process.env.ADMIN_TOKEN;
if(remote && (!adminToken || adminToken.length<20)) throw Error('Set ADMIN_TOKEN to at least 20 characters');
const origins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:5174', 'http://localhost:5174']);
function persist(next) { writeFileSync(file + '.tmp', JSON.stringify(next, null, 2)); renameSync(file + '.tmp', file); state = next; }
if (!existsSync(file)) persist(state);
function snapshot(res) { res.write(`id: ${state.revision}\nevent: inventory\ndata: ${JSON.stringify(state)}\n\n`); }
function json(res, status, value) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!remote && !['127.0.0.1:5174', 'localhost:5174'].includes(req.headers.host)) return json(res, 403, {error:'Local host required'});
  if (req.headers.origin && !origins.has(req.headers.origin) && req.headers.origin !== 'https://'+req.headers.host) return json(res,403,{error:'Origin rejected'});
  if (req.headers.origin) {res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');}
  if (req.method==='OPTIONS') {res.setHeader('Access-Control-Allow-Methods','GET, PATCH, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.writeHead(204);return res.end();}
  const url = new URL(req.url, 'http://127.0.0.1:5174');
  if (req.method==='GET' && url.pathname==='/') {res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(readFileSync(new URL('./index.html',import.meta.url)));}
  if (req.method==='GET' && url.pathname==='/api/stones') return json(res,200,state);
  if (req.method==='GET' && url.pathname==='/api/events') {
    res.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no'});
    res.write('retry: 1500\n\n'); clients.add(res); snapshot(res);
    const ping=setInterval(()=>res.write(': keepalive\n\n'),10000);
    res.on('close',()=>{clearInterval(ping);clients.delete(res);}); return;
  }
  if ((req.method==='PATCH' && /^\/api\/stones\/[^/]+$/.test(url.pathname)) || (req.method==='POST' && url.pathname==='/api/reset')) {
    if (remote && req.headers.authorization !== 'Bearer '+adminToken) return json(res,401,{error:'Yönetim anahtarı gerekli veya yanlış'});
    if (!req.headers['content-type']?.startsWith('application/json')) return json(res,415,{error:'JSON required'});
    try {
      let text='';for await(const chunk of req){text+=chunk;if(text.length>16000)throw Error('Request too large');}
      const patch=JSON.parse(text || '{}'); let stones;
      if(url.pathname==='/api/reset') stones=structuredClone(seed);
      else {
        const id=decodeURIComponent(url.pathname.split('/').at(-1)); const item=state.stones.find(x=>x.id===id);
        if(!item)return json(res,404,{error:'Stone not found'});
        const allowed=['name','description','status','origin','dimensions','image'];
        if(!Object.keys(patch).length || Object.keys(patch).some(key=>!allowed.includes(key)))throw Error('Unsupported fields');
        for(const [key,value] of Object.entries(patch)) {
          if(typeof value!=='string'||value.length>(key==='description'?4000:500))throw Error('Invalid '+key);
          if(key==='name'&&!value.trim())throw Error('Name required');
          if(key==='status'&&!['In stock','Low stock','Out of stock'].includes(value))throw Error('Invalid stock status');
          if(key==='image'&&!/^\/images\/[a-zA-Z0-9_.-]+$/.test(value)&&!/^https:\/\//.test(value))throw Error('Invalid image URL');
        }
        stones=state.stones.map(x=>x.id===id?{...x,...patch}:x);
      }
      persist({revision:state.revision+1,updatedAt:new Date().toISOString(),stones});
      for(const client of clients)snapshot(client);
      return json(res,200,state);
    } catch(error) {return json(res,400,{error:error.message});}
  }
  return json(res,404,{error:'Not found'});
});
server.listen(port,remote?'0.0.0.0':'127.0.0.1',()=>console.log('Mock inventory server listening on port '+port));
