#!/usr/bin/env node
// pcli — plain-text front end for `claude -p`: local REPL + phone web UI, zero deps.
// No TUI, so no redraw glitches. Every event (from PC or phone) is shown on both.
//   node server.js            REPL in this terminal + HTTP on :7777
//   node server.js --headless HTTP only (for a startup task)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');

const STATE_FILE = path.join(__dirname, 'state.json');
const PORT = +process.env.PCLI_PORT || 7777;
const HOST = process.env.PCLI_HOST || '0.0.0.0';
const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
// Turns off every mouse-tracking / paste mode a crashed TUI may have left on.
const TERM_RESET = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?25h';

function load() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
const state = Object.assign({ token: crypto.randomBytes(16).toString('hex'), current: 'main', sessions: {} }, load());
function save() { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function sess(name = state.current) {
  return state.sessions[name] ??= { id: null, cwd: process.cwd(), mode: 'acceptEdits' };
}
sess();
save();

// ---- event bus: history + SSE clients + local terminal ----
const history = [];
const clients = new Set();
let rl = null;
const COLOR = { in: '\x1b[33m', tool: '\x1b[36m', err: '\x1b[31m', done: '\x1b[90m', sys: '\x1b[90m' };

function emit(e) {
  history.push(e);
  if (history.length > 500) history.shift();
  const data = `data: ${JSON.stringify(e)}\n\n`;
  for (const c of clients) c.write(data);
  if (!rl || (e.t === 'in' && e.src === 'pc')) return;
  const body = e.t === 'in' ? `[${e.src}] ${e.text}` : e.t === 'tool' ? `  › ${e.text}` : e.text.replace(/\n+$/, '');
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write((COLOR[e.t] || '') + body + '\x1b[0m\n');
  rl.prompt(true);
}
const sys = text => emit({ t: 'sys', text });

// ---- runners ----
const running = new Map();

function brief(input = {}) {
  const v = input.command || input.file_path || input.pattern || input.url || input.description || JSON.stringify(input);
  return String(v).replace(/\s+/g, ' ').slice(0, 120);
}

function track(name, child, onLine) {
  running.set(name, child);
  return new Promise(resolve => {
    let buf = '';
    const done = () => { running.delete(name); resolve(); };
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        onLine(line);
      }
    });
    child.stderr.on('data', d => emit({ t: 'err', text: String(d) }));
    child.on('error', e => { emit({ t: 'err', text: e.message }); done(); });
    child.on('close', () => { if (buf) onLine(buf); done(); });
  });
}

function runClaude(name, text) {
  const s = sess(name);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', s.mode];
  if (s.id) args.push('--resume', s.id);
  const child = spawn('claude', args, { cwd: s.cwd, windowsHide: true });
  child.stdin.end(text);
  return track(name, child, line => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return emit({ t: 'text', text: line }); }
    if (m.session_id && m.session_id !== s.id) { s.id = m.session_id; save(); }
    if (m.type === 'assistant') {
      for (const c of m.message?.content || []) {
        if (c.type === 'text' && c.text.trim()) emit({ t: 'text', text: c.text });
        else if (c.type === 'tool_use') emit({ t: 'tool', text: `${c.name} ${brief(c.input)}` });
      }
    } else if (m.type === 'result') {
      const secs = Math.round((m.duration_ms || 0) / 1000);
      emit({ t: 'done', text: m.is_error ? `✗ ${m.subtype || 'error'} · ${secs}s` : `✓ $${(m.total_cost_usd || 0).toFixed(3)} · ${secs}s` });
    }
  });
}

function runShell(name, cmd) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { cwd: sess(name).cwd, windowsHide: true });
  child.stdin.end();
  return track(name, child, line => emit({ t: 'text', text: line })).then(() => emit({ t: 'done', text: `exit ${child.exitCode}` }));
}

function stop(name) {
  const child = running.get(name);
  if (!child) return sys('nothing running');
  // Kill the whole tree so tool subprocesses (bash, node, etc.) die too.
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  sys('stopped');
}

const HELP = `prompt text      → claude (resumes current session)
!command         → powershell in session cwd
/new             fresh claude conversation
/s <name>        switch/create named session
/ls              list sessions
/cd <path>       set session cwd (starts fresh conversation)
/mode <m>        ${MODES.join(' | ')}
/stop            kill running job
/reset           un-stick terminal mouse mode (local)`;

function exec(line, src) {
  line = line.trim();
  if (!line) return;
  emit({ t: 'in', src, text: line });
  const name = state.current;
  const s = sess(name);
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(' ');
  const busy = () => running.has(name) && (sys(`"${name}" is busy — /stop first`), true);

  if (line.startsWith('!')) return busy() || runShell(name, line.slice(1));
  if (!line.startsWith('/')) return busy() || runClaude(name, line);

  switch (cmd) {
    case '/help': return sys(HELP);
    case '/new': s.id = null; save(); return sys(`"${name}": new conversation`);
    case '/stop': return stop(name);
    case '/reset': process.stdout.write(TERM_RESET); return sys('terminal modes reset');
    case '/ls':
      return sys(Object.entries(state.sessions).map(([n, x]) =>
        `${n === name ? '*' : ' '} ${n}  ${x.mode}  ${x.id ? x.id.slice(0, 8) : '(new)'}  ${x.cwd}${running.has(n) ? '  [running]' : ''}`).join('\n'));
    case '/s':
      if (!arg) return sys('usage: /s <name>');
      state.current = arg; sess(arg); save();
      if (rl) rl.setPrompt(`${arg}> `);
      return sys(`session "${arg}" · ${sess(arg).cwd}`);
    case '/cd': {
      const dir = path.resolve(s.cwd, arg || os.homedir());
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return sys(`no such dir: ${dir}`);
      s.cwd = dir; s.id = null; save();
      return sys(`cwd ${dir} (new conversation)`);
    }
    case '/mode':
      if (!MODES.includes(arg)) return sys(`mode is ${s.mode}; options: ${MODES.join(', ')}`);
      s.mode = arg; save();
      return sys(`mode ${arg}`);
    default: return sys(`unknown command ${cmd} — /help`);
  }
}

// ---- HTTP ----
function tokenOk(t) {
  const a = Buffer.from(String(t || ''));
  const b = Buffer.from(state.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (!tokenOk(u.searchParams.get('token') || req.headers['x-token'])) {
    res.writeHead(401);
    return res.end('bad token');
  }
  if (u.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const e of history) res.write(`data: ${JSON.stringify(e)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  if (u.pathname === '/api/send' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let text;
      try { text = JSON.parse(body).text; } catch {}
      if (typeof text !== 'string' || !text.trim()) { res.writeHead(400); return res.end(); }
      res.writeHead(202);
      res.end();
      exec(text, 'phone');
    });
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
  if (process.stdout.isTTY) process.stdout.write(TERM_RESET);
  console.log(`pcli on :${PORT} — open on your phone:`);
  for (const ip of ips) console.log(`  http://${ip}:${PORT}/#${state.token}`);
  console.log(`session "${state.current}" · ${sess().cwd} · /help\n`);
  if (process.argv.includes('--headless') || !process.stdin.isTTY) return;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${state.current}> ` });
  rl.on('line', l => { exec(l, 'pc'); rl.prompt(); });
  rl.on('close', () => { process.stdout.write(TERM_RESET); process.exit(0); });
  rl.prompt();
});

const PAGE = `<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1,interactive-widget=resizes-content">
<title>pcli</title><style>
:root{--bg:#0d0f12;--fg:#d8dee9;--dim:#6b7380;--acc:#e0a050;--err:#e06c75;--tool:#61afef;--line:#2a2f36;--field:#161a1f}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-monospace,Menlo,Consolas,monospace;display:flex;flex-direction:column;height:100dvh}
#log{flex:1;overflow-y:auto;padding:12px 16px;white-space:pre-wrap;word-break:break-word}
.in{color:var(--acc);margin-top:12px}.tool{color:var(--tool)}.err{color:var(--err)}.done,.sys{color:var(--dim)}
#bar{display:flex;gap:6px;padding:8px 16px 0;align-items:center}#st{margin-left:auto;color:var(--dim)}
form{display:flex;gap:8px;padding:8px 16px calc(8px + env(safe-area-inset-bottom))}
textarea{flex:1;background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit;resize:none}
button{background:#1f252c;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 12px;font:inherit}
</style></head><body>
<div id=log></div>
<div id=bar><button data-c="/stop">stop</button><button data-c="/new">new</button><button data-c="/ls">sessions</button><span id=st>…</span></div>
<form id=f><textarea id=t rows=2 placeholder="prompt · !shell · /help"></textarea><button>send</button></form>
<script>
if(location.hash.length>1){localStorage.pcliToken=location.hash.slice(1);history.replaceState(null,'',location.pathname)}
const T=localStorage.pcliToken||prompt('token');localStorage.pcliToken=T;
const log=document.getElementById('log'),st=document.getElementById('st');
function add(e){const d=document.createElement('div');d.className=e.t;
d.textContent=e.t==='in'?'['+e.src+'] '+e.text:e.t==='tool'?'› '+e.text:e.text;
const stick=log.scrollHeight-log.scrollTop-log.clientHeight<60;log.append(d);if(stick)log.scrollTop=log.scrollHeight}
const es=new EventSource('/api/events?token='+encodeURIComponent(T));
es.onopen=()=>{log.textContent='';st.textContent='online'};
es.onerror=()=>{st.textContent='offline'};
es.onmessage=m=>add(JSON.parse(m.data));
function send(text){fetch('/api/send',{method:'POST',headers:{'content-type':'application/json','x-token':T},body:JSON.stringify({text})})
.then(r=>{if(!r.ok)add({t:'err',text:'send failed: '+r.status})},()=>add({t:'err',text:'send failed: offline'}))}
f.onsubmit=e=>{e.preventDefault();const v=t.value.trim();if(v){send(v);t.value=''}};
t.onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();f.requestSubmit()}};
document.querySelectorAll('[data-c]').forEach(b=>b.onclick=()=>send(b.dataset.c));
</script></body></html>`;
