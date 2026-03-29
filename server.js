// osu! Collab Server v2.4.0
// Reviews → persisted to GitHub
// Notes/chat/users/history → in-memory
//
// Required env vars on Render:
//   GITHUB_TOKEN      — Personal Access Token with "repo" scope
//   GITHUB_REPO       — e.g. "yourusername/osu-reviews-data"
//   REVIEW_TOKEN      — (optional) token required to POST reviews
//   OSU_CLIENT_ID     — OAuth app client ID
//   OSU_CLIENT_SECRET — OAuth app client secret
//   REDIRECT_URI      — https://your-render-app.onrender.com/auth/callback
//   SESSION_SECRET    — any random string
//   ADMIN_USERNAME    — osu! username of the admin (e.g. "Bei")

const http  = require('http');
const https = require('https');

const PORT             = process.env.PORT             || 3000;
const GITHUB_TOKEN     = process.env.GITHUB_TOKEN     || '';
const GITHUB_REPO      = process.env.GITHUB_REPO      || '';
const REVIEW_TOKEN     = process.env.REVIEW_TOKEN     || '';
const OSU_CLIENT_ID    = process.env.OSU_CLIENT_ID    || '';
const OSU_CLIENT_SECRET= process.env.OSU_CLIENT_SECRET|| '';
const REDIRECT_URI     = process.env.REDIRECT_URI     || '';
const SESSION_SECRET   = process.env.SESSION_SECRET   || 'changeme';
const ADMIN_USERNAME   = (process.env.ADMIN_USERNAME  || 'Bei').toLowerCase();

if (!GITHUB_TOKEN || !GITHUB_REPO) console.warn('no GITHUB_TOKEN/GITHUB_REPO');
if (!OSU_CLIENT_ID || !OSU_CLIENT_SECRET || !REDIRECT_URI) console.warn('OAuth not configured');

// ─── Profanity filter ─────────────────────────────────────────────────────────
const BLOCKED_WORDS = [
    'fuck','shit','cunt','nigger','nigga','faggot','fag','retard','whore',
    'bitch','pussy','asshole','bastard','dick','cock','slut','kike','spic',
    'chink','gook','wetback','tranny','dyke','twat','prick','wanker',
    'motherfucker','fucker','shithead','dumbass','jackass','douchebag',
    'rape','rapist','pedophile','pedo',
];

function containsProfanity(text) {
    const lower = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    return BLOCKED_WORDS.some(w => {
        const re = new RegExp('(?<![a-z])' + w + '(?![a-z])', 'i');
        return re.test(lower);
    });
}

// ─── In-memory stores ─────────────────────────────────────────────────────────
const mem = { notes: [], chat: [], users: [], history: [] };

// ─── Sessions ─────────────────────────────────────────────────────────────────
const sessions = new Map();

function makeSessionToken() {
    const arr = [];
    for (let i = 0; i < 32; i++) arr.push(Math.floor(Math.random() * 256));
    return Buffer.from(arr).toString('hex');
}

function getSession(req) {
    const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (!auth) return null;
    const s = sessions.get(auth);
    if (!s) return null;
    if (s.expiresAt < Date.now()) { sessions.delete(auth); return null; }
    return s;
}

function isAdmin(session) {
    return session && session.username.toLowerCase() === ADMIN_USERNAME;
}

// ─── osu! OAuth ───────────────────────────────────────────────────────────────
async function exchangeCode(code) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            client_id: parseInt(OSU_CLIENT_ID, 10), client_secret: OSU_CLIENT_SECRET.trim(),
            code, grant_type: 'authorization_code', redirect_uri: REDIRECT_URI.trim(),
        });
        const req = https.request({
            hostname: 'osu.ppy.sh', path: '/oauth/token', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'osu-collab-server' },
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { console.log('osu! token status:', res.statusCode); try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
        });
        req.on('error', reject); req.write(payload); req.end();
    });
}

async function osuApiGet(path, token) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'osu.ppy.sh', path: '/api/v2/' + path, method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'User-Agent': 'osu-collab-server' },
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
        });
        req.on('error', reject); req.end();
    });
}

// ─── GitHub storage ───────────────────────────────────────────────────────────
let reviews = {}, reviewsSHA = null, reviewsDirty = false, saveInFlight = false;

function githubRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = https.request({
            hostname: 'api.github.com', path, method,
            headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'User-Agent': 'osu-collab-server', 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function loadReviewsFromGitHub() {
    if (!GITHUB_TOKEN || !GITHUB_REPO) return;
    try {
        const r = await githubRequest('GET', '/repos/' + GITHUB_REPO + '/contents/reviews.json');
        if (r.status === 200) {
            reviews = JSON.parse(Buffer.from(r.body.content, 'base64').toString('utf8'));
            reviewsSHA = r.body.sha;
            console.log('Loaded ' + Object.values(reviews).reduce((a, b) => a + b.length, 0) + ' reviews from GitHub');
        } else if (r.status !== 404) { console.warn('GitHub load failed:', r.status); }
    } catch (e) { console.error('GitHub load error:', e.message); }
}

async function saveReviewsToGitHub() {
    if (!GITHUB_TOKEN || !GITHUB_REPO) return;
    if (saveInFlight) { reviewsDirty = true; return; }
    saveInFlight = true; reviewsDirty = false;
    try {
        const content = Buffer.from(JSON.stringify(reviews, null, 2)).toString('base64');
        const r = await githubRequest('PUT', '/repos/' + GITHUB_REPO + '/contents/reviews.json', { message: 'update reviews ' + new Date().toISOString(), content, ...(reviewsSHA ? { sha: reviewsSHA } : {}) });
        if (r.status === 200 || r.status === 201) { reviewsSHA = r.body.content.sha; console.log('Reviews saved to GitHub'); }
        else { console.warn('GitHub save failed:', r.status); }
    } catch (e) { console.error('GitHub save error:', e.message); }
    finally { saveInFlight = false; if (reviewsDirty) saveReviewsToGitHub(); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
        req.on('error', reject);
    });
}
function setCORS(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Review-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
}
function json(res, status, data) { setCORS(res); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
function ok(res, data) { json(res, 200, { success: true, data, timestamp: Date.now() }); }
function err(res, status, msg) { json(res, status, { error: msg, timestamp: Date.now() }); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// ─── Cleanup ──────────────────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    mem.users = mem.users.filter(u => now - u.timestamp < 30000);
    mem.chat  = mem.chat.filter(m => now - m.timestamp < 7 * 86400000);
    if (mem.history.length > 1000) mem.history = mem.history.slice(-1000);
    for (const [t, s] of sessions) { if (s.expiresAt < now) sessions.delete(t); }
}, 60000);

// ─── Build frontend ───────────────────────────────────────────────────────────
function buildHomePage() {
    const totalReviews = Object.values(reviews).reduce((a, b) => a + b.length, 0);
    const uptime = Math.floor(process.uptime());
    const uptimeStr = uptime < 60 ? uptime + 's' : uptime < 3600 ? Math.floor(uptime/60) + 'm ' + (uptime%60) + 's' : Math.floor(uptime/3600) + 'h ' + Math.floor((uptime%3600)/60) + 'm';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>osu! Reviews</title>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
    --black: #0a0a0a; --white: #f5f5f0; --g1: #1a1a1a; --g2: #2a2a2a; --g3: #444; --g4: #888; --g5: #bbb;
    --line: rgba(255,255,255,0.08); --line-hi: rgba(255,255,255,0.18);
    --fd: 'Instrument Serif', serif; --fu: 'Syne', sans-serif; --fm: 'DM Mono', monospace;
    --ease: cubic-bezier(0.16,1,0.3,1);
}
html { scroll-behavior: smooth; }
body { background: var(--black); color: var(--white); font-family: var(--fu); min-height: 100vh; overflow-x: hidden; cursor: none; }
#cur { position:fixed; top:0; left:0; width:12px; height:12px; background:var(--white); border-radius:50%; pointer-events:none; z-index:99999; transform:translate(-50%,-50%); mix-blend-mode:difference; transition:width .15s,height .15s; }
#cur-r { position:fixed; top:0; left:0; width:36px; height:36px; border:1px solid rgba(255,255,255,0.35); border-radius:50%; pointer-events:none; z-index:99998; transform:translate(-50%,-50%); }
body:has(a:hover) #cur, body:has(button:hover) #cur { width:20px; height:20px; }
body::before { content:''; position:fixed; inset:0; background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); opacity:.028; pointer-events:none; z-index:0; }
.gbg { position:fixed; inset:0; pointer-events:none; z-index:0; background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px); background-size:80px 80px; mask-image:radial-gradient(ellipse 80% 80% at 50% 0%,black 0%,transparent 80%); }
.wrap { position:relative; z-index:1; max-width:1100px; margin:0 auto; padding:0 40px; }

/* — Nav — */
header { position:relative; z-index:10; padding:28px 0 22px; border-bottom:1px solid var(--line); }
.hd { display:flex; align-items:center; justify-content:space-between; }
.logo { font-family:var(--fd); font-size:20px; display:flex; align-items:center; gap:10px; }
.ldot { width:7px; height:7px; background:var(--white); border-radius:50%; animation:pd 2s ease infinite; }
@keyframes pd { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.5);opacity:.5} }
.hr { display:flex; align-items:center; gap:28px; }
.nav { display:flex; gap:20px; }
.nav a { font-family:var(--fm); font-size:11px; color:var(--g4); text-decoration:none; letter-spacing:.3px; transition:color .2s; }
.nav a:hover { color:var(--white); }
.ns { font-family:var(--fm); font-size:11px; color:var(--g4); display:flex; align-items:center; gap:16px; }
.sdot { width:6px; height:6px; background:#4ade80; border-radius:50%; animation:pd 2s ease infinite; display:inline-block; margin-right:4px; }

/* — Hero — */
.hero { padding:96px 0 72px; position:relative; overflow:hidden; }
.ey { font-family:var(--fm); font-size:11px; letter-spacing:2px; color:var(--g4); text-transform:uppercase; margin-bottom:20px; opacity:0; animation:fu .8s var(--ease) .1s forwards; }
h1.ht { font-family:var(--fd); font-size:clamp(52px,7vw,92px); line-height:.93; letter-spacing:-2px; margin-bottom:28px; opacity:0; animation:fu .8s var(--ease) .2s forwards; }
h1.ht em { font-style:italic; color:var(--g5); }
.hsub { font-size:14px; color:var(--g4); max-width:460px; line-height:1.75; margin-bottom:52px; opacity:0; animation:fu .8s var(--ease) .3s forwards; }
.sr { display:flex; gap:1px; border:1px solid var(--line-hi); border-radius:10px; overflow:hidden; max-width:580px; opacity:0; animation:fu .8s var(--ease) .4s forwards; }
.sb { flex:1; padding:18px 22px; background:rgba(255,255,255,.02); border-right:1px solid var(--line); transition:background .2s; }
.sb:last-child { border-right:none; }
.sb:hover { background:rgba(255,255,255,.05); }
.sn { font-family:var(--fd); font-size:34px; line-height:1; margin-bottom:3px; }
.sl { font-family:var(--fm); font-size:10px; letter-spacing:1.5px; color:var(--g4); text-transform:uppercase; }
.hcirc { position:absolute; right:-50px; top:30px; width:320px; height:320px; border:1px solid var(--line-hi); border-radius:50%; opacity:0; animation:fi 1.2s var(--ease) .5s forwards, ss 40s linear infinite; pointer-events:none; }
.hcirc::before { content:''; position:absolute; top:28px; left:28px; right:28px; bottom:28px; border:1px solid var(--line); border-radius:50%; }
.hcirc::after { content:''; position:absolute; top:50%; left:-4px; width:8px; height:8px; background:var(--white); border-radius:50%; transform:translateY(-50%); }
@keyframes ss { to { transform:rotate(360deg); } }

/* — Sections — */
.sec { padding:72px 0; border-top:1px solid var(--line); }
.slbl { font-family:var(--fm); font-size:10px; letter-spacing:2px; color:var(--g4); text-transform:uppercase; margin-bottom:44px; display:flex; align-items:center; gap:14px; }
.slbl::after { content:''; flex:1; height:1px; background:var(--line); }

/* — Login panel — */
.lp { display:grid; grid-template-columns:1fr 1fr; gap:1px; border:1px solid var(--line-hi); border-radius:14px; overflow:hidden; max-width:760px; }
.li { padding:44px; background:rgba(255,255,255,.02); }
.li h2 { font-family:var(--fd); font-size:30px; line-height:1.1; margin-bottom:14px; letter-spacing:-.4px; }
.li p { font-size:13px; color:var(--g4); line-height:1.75; margin-bottom:28px; }
.fl { list-style:none; display:flex; flex-direction:column; gap:9px; }
.fl li { font-size:12px; color:var(--g5); display:flex; align-items:center; gap:9px; font-family:var(--fm); }
.fl li::before { content:'→'; color:var(--g3); }
.la { padding:44px; background:rgba(255,255,255,.03); display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; gap:14px; }
.avw { width:76px; height:76px; border-radius:50%; border:1px solid var(--line-hi); background:var(--g1); display:flex; align-items:center; justify-content:center; font-size:26px; overflow:hidden; transition:all .3s; }
.avw img { width:100%; height:100%; object-fit:cover; display:none; }
.avw.loaded img { display:block; }
.avw.loaded .aic { display:none; }

/* — Buttons — */
.btn { display:inline-flex; align-items:center; gap:7px; padding:11px 26px; border-radius:7px; font-family:var(--fu); font-size:13px; font-weight:600; cursor:none; border:none; transition:all .2s var(--ease); text-decoration:none; }
.bp { background:var(--white); color:var(--black); }
.bp:hover { transform:translateY(-2px); box-shadow:0 8px 24px rgba(255,255,255,.14); }
.bp:disabled { opacity:.4; transform:none; cursor:default; box-shadow:none; }
.bg { background:transparent; color:var(--white); border:1px solid var(--line-hi); }
.bg:hover { background:rgba(255,255,255,.06); border-color:rgba(255,255,255,.3); }
.bd { background:transparent; color:#ff6b6b; border:1px solid rgba(255,107,107,.3); font-size:12px; padding:6px 13px; }
.bd:hover { background:rgba(255,107,107,.08); }
.be { background:transparent; color:var(--g4); border:1px solid var(--line); font-size:11px; padding:5px 12px; }
.be:hover { color:var(--white); border-color:var(--line-hi); }
.bsm { padding:7px 15px; font-size:12px; }

/* — Search — */
.srow { display:flex; gap:10px; margin-bottom:36px; max-width:500px; }
.si { flex:1; padding:11px 15px; background:rgba(255,255,255,.04); border:1px solid var(--line-hi); border-radius:7px; color:var(--white); font-family:var(--fu); font-size:13px; outline:none; transition:all .2s; cursor:none; }
.si::placeholder { color:var(--g3); }
.si:focus { border-color:rgba(255,255,255,.32); background:rgba(255,255,255,.06); }

/* — Profile card — */
.pc { border:1px solid var(--line-hi); border-radius:14px; overflow:hidden; max-width:760px; opacity:0; transform:translateY(14px); transition:all .4s var(--ease); }
.pc.vis { opacity:1; transform:translateY(0); }
.ph { padding:36px 44px; background:rgba(255,255,255,.03); display:flex; align-items:center; gap:24px; border-bottom:1px solid var(--line); position:relative; overflow:hidden; }
.ph::before { content:''; position:absolute; inset:0; background:radial-gradient(ellipse 60% 80% at 0% 50%,rgba(255,255,255,.03) 0%,transparent 70%); pointer-events:none; }
.pav { width:84px; height:84px; border-radius:50%; border:2px solid var(--line-hi); object-fit:cover; flex-shrink:0; }
.pi h3 { font-family:var(--fd); font-size:26px; letter-spacing:-.4px; margin-bottom:5px; }
.pmeta { font-family:var(--fm); font-size:11px; color:var(--g4); display:flex; gap:14px; flex-wrap:wrap; }
.rb { padding:28px 44px 36px; }
.re { text-align:center; padding:44px 20px; color:var(--g4); font-family:var(--fm); font-size:12px; line-height:1.9; }
.eic { font-size:28px; margin-bottom:10px; opacity:.35; }

/* — Review items — */
.rvi { padding:18px 0; border-bottom:1px solid var(--line); opacity:0; animation:fu .4s var(--ease) forwards; }
.rvi:last-child { border-bottom:none; padding-bottom:0; }
.rvt { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; }
.rva { display:flex; align-items:center; gap:10px; }
.rvav { width:30px; height:30px; border-radius:50%; border:1px solid var(--line-hi); object-fit:cover; background:var(--g2); flex-shrink:0; }
.rvan { font-size:13px; font-weight:600; color:var(--white); text-decoration:none; }
.rvan:hover { text-decoration:underline; }
.rvd { font-family:var(--fm); font-size:10px; color:var(--g4); margin-top:1px; }
.rvst { display:flex; gap:2px; }
.st { font-size:12px; color:var(--g3); }
.st.f { color:#e8e0a0; }
.rvtx { font-size:13px; color:var(--g5); line-height:1.65; padding-left:40px; }
.rvac { padding-left:40px; margin-top:9px; display:flex; gap:7px; flex-wrap:wrap; }
.flg { font-family:var(--fm); font-size:10px; color:#f97316; padding:2px 7px; border:1px solid rgba(249,115,22,.3); border-radius:4px; }

/* — Edit form — */
.ef { margin-top:10px; padding-left:40px; display:none; }
.ef.open { display:block; }
.eta { width:100%; min-height:68px; resize:vertical; background:rgba(255,255,255,.03); border:1px solid var(--line-hi); border-radius:7px; color:var(--white); font-family:var(--fu); font-size:13px; padding:9px 13px; outline:none; margin-bottom:8px; transition:border-color .2s; cursor:none; }
.eta:focus { border-color:rgba(255,255,255,.28); }
.est { display:flex; gap:4px; margin-bottom:8px; }
.estr { background:none; border:none; font-size:18px; color:var(--g3); cursor:none; padding:1px; line-height:1; transition:all .1s; }
.estr.on { color:#e8e0a0; }
.er { display:flex; gap:7px; }

/* — Write panel — */
.wp { margin-top:28px; border:1px solid var(--line-hi); border-radius:11px; overflow:hidden; max-width:760px; }
.wh { padding:14px 22px; background:rgba(255,255,255,.03); border-bottom:1px solid var(--line); font-family:var(--fm); font-size:10px; letter-spacing:1.5px; color:var(--g4); text-transform:uppercase; display:flex; justify-content:space-between; }
.wb { padding:22px; }
.wst { display:flex; gap:5px; margin-bottom:14px; }
.wstr { background:none; border:none; font-size:21px; color:var(--g3); cursor:none; padding:2px; transition:all .1s; line-height:1; }
.wstr.on { color:#e8e0a0; transform:scale(1.08); }
.wstr:hover { transform:scale(1.18); }
.wta { width:100%; min-height:76px; resize:vertical; background:rgba(255,255,255,.03); border:1px solid var(--line-hi); border-radius:7px; color:var(--white); font-family:var(--fu); font-size:13px; line-height:1.6; padding:11px 15px; outline:none; margin-bottom:11px; transition:border-color .2s; cursor:none; }
.wta:focus { border-color:rgba(255,255,255,.28); }
.wta::placeholder { color:var(--g3); }
.wf { display:flex; justify-content:space-between; align-items:center; }
.wc { font-family:var(--fm); font-size:11px; color:var(--g4); }
.we { font-size:12px; color:#ff6b6b; margin-top:7px; font-family:var(--fm); }

/* — Admin — */
.adp { border:1px solid rgba(255,255,255,.14); border-radius:14px; overflow:hidden; max-width:940px; }
.adh { padding:22px 28px; background:rgba(255,255,255,.04); border-bottom:1px solid var(--line); display:flex; align-items:center; gap:10px; }
.adb { font-family:var(--fm); font-size:10px; letter-spacing:1px; padding:3px 9px; border-radius:3px; background:var(--white); color:var(--black); font-weight:600; }
.adh h2 { font-family:var(--fd); font-size:20px; }
.adf { padding:18px 28px; background:rgba(255,255,255,.02); border-bottom:1px solid var(--line); display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.afi { padding:7px 13px; background:rgba(255,255,255,.04); border:1px solid var(--line-hi); border-radius:6px; color:var(--white); font-family:var(--fm); font-size:12px; outline:none; width:200px; cursor:none; }
.afi::placeholder { color:var(--g3); }
.afi:focus { border-color:rgba(255,255,255,.28); }
.fc { padding:5px 13px; border-radius:18px; border:1px solid var(--line); font-family:var(--fm); font-size:11px; cursor:none; background:transparent; color:var(--g4); transition:all .15s; }
.fc.on { background:var(--white); color:var(--black); border-color:var(--white); }
.fc:hover:not(.on) { border-color:var(--line-hi); color:var(--white); }
.adsr { padding:14px 28px; background:rgba(255,255,255,.02); border-bottom:1px solid var(--line); display:flex; gap:28px; font-family:var(--fm); font-size:11px; color:var(--g4); }
.adsr span { color:var(--white); font-weight:500; }
.adrl { max-height:580px; overflow-y:auto; }
.adri { padding:18px 28px; border-bottom:1px solid var(--line); display:flex; gap:14px; transition:background .15s; }
.adri:hover { background:rgba(255,255,255,.02); }
.adri:last-child { border-bottom:none; }
.adrl2 { flex:1; min-width:0; }
.adm { display:flex; align-items:center; gap:10px; margin-bottom:6px; flex-wrap:wrap; }
.ada { font-size:12px; font-weight:600; color:var(--white); font-family:var(--fm); }
.adt { font-size:11px; color:var(--g4); font-family:var(--fm); }
.adarr { font-size:11px; color:var(--g3); }
.adtx { font-size:13px; color:var(--g5); line-height:1.6; margin-bottom:6px; }
.addate { font-family:var(--fm); font-size:10px; color:var(--g4); }
.adrr { display:flex; flex-direction:column; gap:5px; align-items:flex-end; flex-shrink:0; }

/* — Dashboard — */
.dash-empty { font-family:var(--fm); font-size:13px; color:var(--g4); padding:40px 0; text-align:center; }

/* — Guide — */
.gg { display:grid; grid-template-columns:1fr 1fr; gap:1px; border:1px solid var(--line-hi); border-radius:11px; overflow:hidden; }
.gi { padding:30px; background:rgba(255,255,255,.02); transition:background .2s; }
.gi:hover { background:rgba(255,255,255,.04); }
.gnum { font-family:var(--fm); font-size:10px; letter-spacing:2px; color:var(--g3); margin-bottom:14px; }
.gt { font-family:var(--fd); font-size:18px; letter-spacing:-.2px; margin-bottom:10px; }
.gb { font-size:13px; color:var(--g4); line-height:1.85; }
.gb code { font-family:var(--fm); font-size:11px; background:rgba(255,255,255,.06); padding:1px 5px; border-radius:3px; color:var(--g5); }
.gb strong { color:var(--g5); font-weight:600; }
.gs { display:flex; gap:9px; margin-top:9px; font-size:13px; color:var(--g4); }
.gsn { font-family:var(--fm); font-size:10px; color:var(--g3); flex-shrink:0; margin-top:2px; }

/* — API — */
.ag { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:1px; border:1px solid var(--line-hi); border-radius:11px; overflow:hidden; }
.ai { padding:18px 22px; background:rgba(255,255,255,.02); transition:background .2s; }
.ai:hover { background:rgba(255,255,255,.04); }
.am { font-family:var(--fm); font-size:10px; letter-spacing:1px; font-weight:500; margin-bottom:5px; display:inline-block; padding:2px 7px; border-radius:3px; }
.mg { background:rgba(74,222,128,.1); color:#4ade80; }
.mp { background:rgba(147,197,253,.1); color:#93c5fd; }
.mu { background:rgba(251,191,36,.1); color:#fbbf24; }
.md { background:rgba(252,165,165,.1); color:#fca5a5; }
.ap { font-family:var(--fm); font-size:13px; color:var(--white); margin-bottom:3px; }
.ad { font-size:12px; color:var(--g4); line-height:1.5; }

/* — Footer — */
footer { border-top:1px solid var(--line); padding:36px 0; margin-top:72px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:14px; }
.fl2 { font-family:var(--fm); font-size:11px; color:var(--g4); }
.fr { display:flex; gap:20px; font-family:var(--fm); font-size:11px; }
.fr a { color:var(--g4); text-decoration:none; }
.fr a:hover { color:var(--white); }

/* — Utils — */
.hidden { display:none !important; }
.rev { opacity:0; transform:translateY(22px); transition:opacity .6s var(--ease), transform .6s var(--ease); }
.rev.in { opacity:1; transform:none; }
.sp { display:inline-block; width:13px; height:13px; border:2px solid rgba(255,255,255,.1); border-top-color:var(--white); border-radius:50%; animation:spin .7s linear infinite; vertical-align:middle; margin-right:5px; }
@keyframes spin { to { transform:rotate(360deg); } }
.nt { position:fixed; top:22px; right:22px; padding:11px 18px; border-radius:7px; font-family:var(--fm); font-size:12px; z-index:9999; pointer-events:none; animation:sln .3s var(--ease); border:1px solid; }
@keyframes sln { from{opacity:0;transform:translateX(16px)} to{opacity:1;transform:translateX(0)} }
.ns2 { background:#0a0a0a; border-color:#4ade80; color:#4ade80; }
.ne { background:#0a0a0a; border-color:#ff6b6b; color:#ff6b6b; }
.ni { background:#0a0a0a; border-color:#93c5fd; color:#93c5fd; }
@keyframes fu { from{opacity:0;transform:translateY(18px)} to{opacity:1;transform:translateY(0)} }
@keyframes fi { from{opacity:0} to{opacity:1} }
@media(max-width:700px) {
    .wrap{padding:0 20px} .lp{grid-template-columns:1fr} .ht{font-size:44px !important} .hcirc{display:none}
    .ph{flex-direction:column;align-items:flex-start} .sr{flex-direction:column} .gg{grid-template-columns:1fr}
    .adri{flex-direction:column}
}
</style>
</head>
<body>
<div id="cur"></div>
<div id="cur-r"></div>
<div class="gbg"></div>
<div class="wrap">

<!-- Nav -->
<header>
    <div class="hd">
        <div class="logo"><div class="ldot"></div>osu! reviews</div>
        <div class="hr">
            <nav class="nav">
                <a href="#s-login">Login</a>
                <a href="#s-search">Reviews</a>
                <a href="#s-dash">Dashboard</a>
                <a href="#s-guide">Guide</a>
                <a href="#s-api">API</a>
            </nav>
            <div class="ns">
                <span><span class="sdot"></span>online</span>
                <span>${uptimeStr}</span>
                <span>${totalReviews} reviews</span>
            </div>
        </div>
    </div>
</header>

<!-- Hero -->
<section class="hero">
    <div class="hcirc"></div>
    <div class="ey">osu! player reviews</div>
    <h1 class="ht">leave your<br><em>mark.</em></h1>
    <p class="hsub">A community review system for osu! players. Log in, find anyone, share your experience.</p>
    <div class="sr">
        <div class="sb"><div class="sn" id="st-rv">${totalReviews}</div><div class="sl">Reviews</div></div>
        <div class="sb"><div class="sn" id="st-ss">${sessions.size}</div><div class="sl">Sessions</div></div>
        <div class="sb"><div class="sn">${GITHUB_TOKEN ? '✓' : '—'}</div><div class="sl">Storage</div></div>
    </div>
</section>

<!-- Login -->
<section class="sec rev" id="s-login">
    <div class="slbl">01 — authentication</div>
    <div class="lp">
        <div class="li">
            <h2>Connect your osu! account</h2>
            <p>Sign in with osu! OAuth to write, edit, and manage your reviews.</p>
            <ul class="fl">
                <li>Write reviews for any player</li>
                <li>Star ratings from 1 to 5</li>
                <li>Edit your reviews anytime</li>
                <li>Delete your own reviews</li>
                <li>Dashboard to track all your reviews</li>
            </ul>
        </div>
        <div class="la">
            <div id="st-out">
                <div class="avw" id="av0"><span class="aic">♪</span><img id="av0i" alt=""></div>
                <div style="margin-top:14px;">
                    <p style="font-size:13px;color:var(--g4);margin-bottom:18px;">Not logged in.</p>
                    <button class="btn bp" id="lbtn" onclick="doLogin()">Login with osu!</button>
                    <div class="we" id="lerr" style="margin-top:9px;"></div>
                </div>
            </div>
            <div id="st-in" class="hidden">
                <div class="avw" id="av1"><span class="aic">♪</span><img id="av1i" alt=""></div>
                <div id="un" style="font-family:var(--fd);font-size:22px;margin-top:11px;"></div>
                <div id="um" style="font-family:var(--fm);font-size:11px;color:var(--g4);"></div>
                <div id="ai" class="hidden" style="font-family:var(--fm);font-size:10px;color:#fbbf24;letter-spacing:1px;margin-top:6px;">ADMIN</div>
                <button class="btn bd" style="margin-top:14px;" onclick="doLogout()">Log out</button>
            </div>
        </div>
    </div>
</section>

<!-- Search -->
<section class="sec rev" id="s-search">
    <div class="slbl">02 — player reviews</div>
    <div class="srow">
        <input type="text" class="si" id="pi" placeholder="Enter osu! user ID…" autocomplete="off">
        <button class="btn bg" onclick="searchPlayer()">Search</button>
    </div>
    <div class="pc" id="pc">
        <div class="ph">
            <img class="pav" id="pav" src="" alt="">
            <div class="pi"><h3 id="pn"></h3><div class="pmeta" id="pm"></div></div>
        </div>
        <div class="rb" id="rb"><div class="re"><div class="eic">◇</div><div>No reviews yet.</div></div></div>
    </div>
    <div class="wp hidden" id="wpanel">
        <div class="wh"><span>Write a review</span><span id="whu" style="color:var(--g5);"></span></div>
        <div class="wb">
            <div class="wst" id="wstars">${[1,2,3,4,5].map(i=>`<button class="wstr" data-s="${i}" onclick="setStar(${i})">★</button>`).join('')}</div>
            <textarea class="wta" id="wta" placeholder="Share your experience with this player… (be respectful)" maxlength="300" oninput="onTAInput()"></textarea>
            <div class="wf">
                <button class="btn bp" id="sbtn" onclick="submitReview()" disabled>Submit review</button>
                <span class="wc" id="wchar">0 / 300</span>
            </div>
            <div class="we" id="werr"></div>
        </div>
    </div>
    <div id="lp2" class="hidden" style="margin-top:14px;font-family:var(--fm);font-size:12px;color:var(--g4);">
        → <a href="#s-login" style="color:var(--g5);text-decoration:underline;">Log in</a> to write a review.
    </div>
</section>

<!-- Dashboard -->
<section class="sec rev" id="s-dash">
    <div class="slbl">03 — your dashboard</div>
    <div id="dash-out" class="dash-empty">→ <a href="#s-login" style="color:var(--g5);text-decoration:underline;">Log in</a> to manage your reviews.</div>
    <div id="dash-in" class="hidden">
        <div style="margin-bottom:20px;font-family:var(--fm);font-size:12px;color:var(--g4);">Your reviews — click Edit to change text or stars.</div>
        <div id="myrvlist" style="max-width:760px;border:1px solid var(--line-hi);border-radius:11px;overflow:hidden;"></div>
    </div>
</section>

<!-- Admin -->
<section class="sec rev hidden" id="s-admin">
    <div class="slbl">04 — admin panel</div>
    <div class="adp">
        <div class="adh"><span class="adb">ADMIN</span><h2>All Reviews</h2></div>
        <div class="adf">
            <input type="text" class="afi" id="adsrch" placeholder="Search text, author, target…" oninput="renderAdmin()">
            <button class="fc on" data-f="all" onclick="setAF('all',this)">All</button>
            <button class="fc" data-f="flagged" onclick="setAF('flagged',this)">Flagged</button>
            <button class="fc" data-f="1" onclick="setAF('1',this)">1★</button>
            <button class="fc" data-f="2" onclick="setAF('2',this)">2★</button>
            <button class="fc" data-f="3" onclick="setAF('3',this)">3★</button>
            <button class="fc" data-f="4" onclick="setAF('4',this)">4★</button>
            <button class="fc" data-f="5" onclick="setAF('5',this)">5★</button>
        </div>
        <div class="adsr">
            <div>Total: <span id="ad-tot">0</span></div>
            <div>Shown: <span id="ad-sh">0</span></div>
            <div>Flagged: <span id="ad-fl">0</span></div>
        </div>
        <div class="adrl" id="adrl"><div class="re" style="padding:40px;"><span class="sp"></span></div></div>
    </div>
</section>

<!-- Guide -->
<section class="sec rev" id="s-guide">
    <div class="slbl" id="glbl">05 — how to use</div>
    <div class="gg">
        <div class="gi">
            <div class="gnum">01 / LOGIN</div>
            <div class="gt">Connect your account</div>
            <div class="gb">
                <div class="gs"><span class="gsn">→</span>Scroll to <strong>Authentication</strong> and click <strong>Login with osu!</strong></div>
                <div class="gs"><span class="gsn">→</span>A popup will open — authorise the app on osu!. Accept it.</div>
                <div class="gs"><span class="gsn">→</span>The popup closes and you are logged in. Sessions last <strong>30 days</strong>.</div>
                <div class="gs"><span class="gsn">→</span>The Tampermonkey script shares the same login — set the server URL in its API Keys tab.</div>
            </div>
        </div>
        <div class="gi">
            <div class="gnum">02 / SEARCH</div>
            <div class="gt">Find a player</div>
            <div class="gb">
                <div class="gs"><span class="gsn">→</span>Go to <strong>Player Reviews</strong> and enter a numeric osu! <strong>user ID</strong>.</div>
                <div class="gs"><span class="gsn">→</span>Find any player's ID in their URL: <code>osu.ppy.sh/users/[ID]</code></div>
                <div class="gs"><span class="gsn">→</span>Their avatar and all existing reviews load instantly.</div>
                <div class="gs"><span class="gsn">→</span>You cannot review yourself.</div>
            </div>
        </div>
        <div class="gi">
            <div class="gnum">03 / WRITE</div>
            <div class="gt">Leave a review</div>
            <div class="gb">
                <div class="gs"><span class="gsn">→</span>After searching a player, the <strong>Write a review</strong> box appears below their card.</div>
                <div class="gs"><span class="gsn">→</span>Pick a <strong>star rating</strong> from 1 to 5.</div>
                <div class="gs"><span class="gsn">→</span>Write your review — min <strong>5 chars</strong>, max <strong>300</strong>.</div>
                <div class="gs"><span class="gsn">→</span>Reviews with slurs or profanity are <strong>rejected automatically</strong>.</div>
                <div class="gs"><span class="gsn">→</span>You can only leave <strong>one review per player</strong>.</div>
            </div>
        </div>
        <div class="gi">
            <div class="gnum">04 / MANAGE</div>
            <div class="gt">Edit or delete</div>
            <div class="gb">
                <div class="gs"><span class="gsn">→</span>Go to the <strong>Dashboard</strong> section to see all reviews you have written.</div>
                <div class="gs"><span class="gsn">→</span>Click <strong>Edit</strong> to change your text or star rating.</div>
                <div class="gs"><span class="gsn">→</span>Click <strong>Delete</strong> to permanently remove a review.</div>
                <div class="gs"><span class="gsn">→</span>You can also edit or delete from the player's review card directly.</div>
            </div>
        </div>
        <div class="gi">
            <div class="gnum">05 / SCRIPT</div>
            <div class="gt">Tampermonkey integration</div>
            <div class="gb">
                <div class="gs"><span class="gsn">→</span>Install the osu! Suite Tampermonkey script in your browser.</div>
                <div class="gs"><span class="gsn">→</span>Open any osu! player profile — a <strong>reviews button</strong> appears in the action bar.</div>
                <div class="gs"><span class="gsn">→</span>Click it to read or write reviews without leaving osu!.</div>
                <div class="gs"><span class="gsn">→</span>Set the server URL and log in from the script's <strong>API Keys</strong> tab.</div>
            </div>
        </div>
        <div class="gi">
            <div class="gnum">06 / RULES</div>
            <div class="gt">Community guidelines</div>
            <div class="gb">
                <div class="gs"><span class="gsn">→</span>Be <strong>honest and respectful</strong> — reviews are about gameplay, not personal attacks.</div>
                <div class="gs"><span class="gsn">→</span><strong>Slurs, hate speech, and profanity</strong> are auto-filtered and will reject your review.</div>
                <div class="gs"><span class="gsn">→</span>Abusive reviews can be removed by admins at any time without notice.</div>
                <div class="gs"><span class="gsn">→</span>Reviews are <strong>public</strong> and visible to everyone on this page and via the API.</div>
            </div>
        </div>
    </div>
</section>

<!-- API -->
<section class="sec rev" id="s-api">
    <div class="slbl" id="albl">06 — api reference</div>
    <div class="ag">
        <div class="ai"><span class="am mg">GET</span><div class="ap">/auth/login</div><div class="ad">Returns osu! OAuth URL</div></div>
        <div class="ai"><span class="am mg">GET</span><div class="ap">/auth/me</div><div class="ad">Current session info</div></div>
        <div class="ai"><span class="am mp">POST</span><div class="ap">/auth/logout</div><div class="ad">Destroys session</div></div>
        <div class="ai"><span class="am mg">GET</span><div class="ap">/reviews/:userId</div><div class="ad">All reviews for a player</div></div>
        <div class="ai"><span class="am mp">POST</span><div class="ap">/reviews</div><div class="ad">Post a review (auth required)</div></div>
        <div class="ai"><span class="am mu">PUT</span><div class="ap">/reviews/:uid/:rid</div><div class="ad">Edit your own review</div></div>
        <div class="ai"><span class="am md">DELETE</span><div class="ap">/reviews/:uid/:rid</div><div class="ad">Delete a review</div></div>
        <div class="ai"><span class="am mg">GET</span><div class="ap">/admin/reviews</div><div class="ad">All reviews (admin / own)</div></div>
        <div class="ai"><span class="am mg">GET</span><div class="ap">/health</div><div class="ad">Server health & uptime</div></div>
        <div class="ai"><span class="am mg">GET</span><div class="ap">/stats</div><div class="ad">Review counts & storage</div></div>
    </div>
</section>

</div><!-- /wrap -->
<div class="wrap">
<footer>
    <div class="fl2">osu! reviews — v2.4.0 — github persisted</div>
    <div class="fr">
        <a href="/health">health</a>
        <a href="/stats">stats</a>
        <a href="/admin/reviews" id="alink" style="display:none">admin api</a>
    </div>
</footer>
</div>

<script>
// ── Cursor ──────────────────────────────────────────────────────────────────
const cur=document.getElementById('cur'), ring=document.getElementById('cur-r');
let mx=0,my=0,rx=0,ry=0;
document.addEventListener('mousemove',e=>{mx=e.clientX;my=e.clientY;cur.style.left=mx+'px';cur.style.top=my+'px';});
(function a(){rx+=(mx-rx)*.14;ry+=(my-ry)*.14;ring.style.left=rx+'px';ring.style.top=ry+'px';requestAnimationFrame(a);})();

// ── Reveal ──────────────────────────────────────────────────────────────────
const obs=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');obs.unobserve(e.target);}}),{threshold:.1});
document.querySelectorAll('.rev').forEach(el=>obs.observe(el));

// ── State ───────────────────────────────────────────────────────────────────
let tok=localStorage.getItem('osu_tok')||null, usr=null, cuid=null, selStar=0, af='all', admRevs=[];
const ES={}; // edit stars per review id

// ── Notify ──────────────────────────────────────────────────────────────────
function N(msg,t='i'){const el=document.createElement('div');el.className='nt n'+(t==='success'?'s2':t==='error'?'e':'i');el.textContent=msg;document.body.appendChild(el);setTimeout(()=>{el.style.opacity='0';el.style.transition='opacity .3s';setTimeout(()=>el.remove(),300);},3000);}

// ── Auth ────────────────────────────────────────────────────────────────────
async function doLogin(){
    const btn=document.getElementById('lbtn'),err=document.getElementById('lerr');
    btn.innerHTML='<span class="sp"></span>Opening…';btn.disabled=true;err.textContent='';
    try{
        const r=await fetch('/auth/login');const d=await r.json();
        if(!d.url)throw new Error('No login URL');
        const p=window.open(d.url,'osu-auth','width=520,height=720,scrollbars=yes');
        if(!p)throw new Error('Popup blocked — allow popups for this site');
        const to=setTimeout(()=>{window.removeEventListener('message',h);err.textContent='✗ Timed out';btn.innerHTML='Login with osu!';btn.disabled=false;},120000);
        function h(e){
            if(e.data?.type==='osu-auth-success'){clearTimeout(to);window.removeEventListener('message',h);tok=e.data.token;localStorage.setItem('osu_tok',tok);usr={userId:e.data.userId,username:e.data.username,avatarUrl:e.data.avatarUrl};renderIn();N('✓ Logged in as '+e.data.username,'success');}
            else if(e.data?.type==='osu-auth-error'){clearTimeout(to);window.removeEventListener('message',h);err.textContent='✗ '+(e.data.error||'Auth failed');btn.innerHTML='Login with osu!';btn.disabled=false;}
        }
        window.addEventListener('message',h);
    }catch(e){err.textContent='✗ '+e.message;btn.innerHTML='Login with osu!';btn.disabled=false;}
}
async function doLogout(){if(tok)await fetch('/auth/logout',{method:'POST',headers:{'Authorization':'Bearer '+tok}}).catch(()=>{});tok=null;usr=null;localStorage.removeItem('osu_tok');renderOut();N('Logged out','i');}
async function verifySess(){
    if(!tok)return;
    try{
        const r=await fetch('/auth/me',{headers:{'Authorization':'Bearer '+tok}});
        if(r.ok){const b=await r.json();usr=b.data??b;renderIn();}
        else{tok=null;usr=null;localStorage.removeItem('osu_tok');renderOut();}
    }catch{}
}
function renderIn(){
    document.getElementById('st-out').classList.add('hidden');
    document.getElementById('st-in').classList.remove('hidden');
    document.getElementById('un').textContent=usr.username;
    document.getElementById('um').textContent='id: '+usr.userId;
    const w=document.getElementById('av1');
    if(usr.avatarUrl){const i=document.getElementById('av1i');i.src=usr.avatarUrl;i.onload=()=>w.classList.add('loaded');}
    document.getElementById('whu').textContent='as '+usr.username;
    const adm=usr.username.toLowerCase()==='${ADMIN_USERNAME}';
    if(adm){document.getElementById('ai').classList.remove('hidden');document.getElementById('s-admin').classList.remove('hidden');document.getElementById('alink').style.display='';document.getElementById('glbl').textContent='06 — how to use';document.getElementById('albl').textContent='07 — api reference';loadAdminRevs();}
    document.getElementById('dash-out').classList.add('hidden');
    document.getElementById('dash-in').classList.remove('hidden');
    loadMyRevs();
    updateWP();
}
function renderOut(){
    document.getElementById('st-in').classList.add('hidden');document.getElementById('st-out').classList.remove('hidden');
    document.getElementById('lbtn').innerHTML='Login with osu!';document.getElementById('lbtn').disabled=false;
    document.getElementById('dash-in').classList.add('hidden');document.getElementById('dash-out').classList.remove('hidden');
    document.getElementById('s-admin').classList.add('hidden');
    updateWP();
}

// ── My reviews dashboard ─────────────────────────────────────────────────────
async function loadMyRevs(){
    if(!usr)return;
    const list=document.getElementById('myrvlist');
    list.innerHTML='<div class="re" style="padding:32px;"><span class="sp"></span></div>';
    try{
        const r=await fetch('/admin/reviews',{headers:{'Authorization':'Bearer '+tok}});
        if(!r.ok){list.innerHTML='<div class="re" style="padding:24px;">Could not load.</div>';return;}
        const b=await r.json();const data=b.data??b;
        let mine=[];
        Object.entries(data).forEach(([uid,revs])=>revs.forEach(rv=>{ if(String(rv.authorUserId)===String(usr.userId))mine.push({...rv,tuid:uid}); }));
        if(!mine.length){list.innerHTML='<div class="re" style="padding:32px;">You have not written any reviews yet.</div>';return;}
        list.innerHTML='';
        mine.forEach((rv,i)=>{
            const el=document.createElement('div');
            el.className='rvi';el.id='mrv-'+rv.id;el.style.cssText='padding:18px 22px;border-bottom:1px solid var(--line);animation-delay:'+(i*.05)+'s;';
            el.innerHTML=
                '<div class="rvt">'+
                    '<div style="font-family:var(--fm);font-size:11px;color:var(--g4);">Review for user <a href="https://osu.ppy.sh/users/'+H(rv.tuid)+'" target="_blank" style="color:var(--g5);">#'+H(rv.tuid)+'</a></div>'+
                    '<div class="rvst">'+[1,2,3,4,5].map(n=>'<span class="st'+(n<=rv.stars?' f':'')+'">★</span>').join('')+'</div>'+
                '</div>'+
                '<div style="font-size:13px;color:var(--g5);line-height:1.65;margin-bottom:10px;">'+H(rv.text)+'</div>'+
                '<div style="font-family:var(--fm);font-size:10px;color:var(--g4);margin-bottom:10px;">'+new Date(rv.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})+(rv.updatedAt?' · edited':'')+'</div>'+
                '<div style="display:flex;gap:7px;">'+
                    '<button class="btn be" style="font-size:11px;padding:5px 12px;" onclick="openEF(\''+rv.id+'\',\''+rv.tuid+'\','+rv.stars+','+JSON.stringify(rv.text)+',false)">Edit</button>'+
                    '<button class="btn bd" onclick="delMyRv(\''+rv.tuid+'\',\''+rv.id+'\')">Delete</button>'+
                '</div>'+
                '<div class="ef" id="ef-'+rv.id+'">'+
                    '<div class="est" id="est-'+rv.id+'">'+[1,2,3,4,5].map(n=>'<button class="estr" data-s="'+n+'" onclick="setES(\''+rv.id+'\','+n+')">★</button>').join('')+'</div>'+
                    '<textarea class="eta" id="eta-'+rv.id+'" maxlength="300">'+H(rv.text)+'</textarea>'+
                    '<div class="er"><button class="btn bp bsm" onclick="saveEF(\''+rv.id+'\',\''+rv.tuid+'\',false)">Save</button><button class="btn bg bsm" onclick="closeEF(\''+rv.id+'\')">Cancel</button></div>'+
                    '<div class="we" id="ee-'+rv.id+'"></div>'+
                '</div>';
            list.appendChild(el);
        });
    }catch(e){list.innerHTML='<div class="re" style="padding:24px;color:#ff6b6b;">Failed to load.</div>';}
}

// ── Edit form helpers ─────────────────────────────────────────────────────────
function openEF(id,tuid,stars,text,profile){
    document.querySelectorAll('.ef.open').forEach(f=>f.classList.remove('open'));
    ES[id]=stars;
    const pfx=profile?'pef':'ef';
    const form=document.getElementById(pfx+'-'+id);if(!form)return;
    form.classList.add('open');
    const ta=document.getElementById((profile?'peta':'eta')+'-'+id);if(ta)ta.value=text;
    hiES(id,stars,profile);
}
function closeEF(id,p){const f=document.getElementById((p?'pef':'ef')+'-'+id);if(f)f.classList.remove('open');}
function setES(id,n,p){ES[id]=n;hiES(id,n,p);}
function hiES(id,n,p){
    const pfx=p?'pest':'est';
    const w=document.getElementById(pfx+'-'+id);if(!w)return;
    w.querySelectorAll('.estr').forEach(b=>{b.classList.toggle('on',+b.dataset.s<=n);b.onclick=()=>setES(id,+b.dataset.s,p);});
}
async function saveEF(id,tuid,profile){
    const pfx=profile?'p':'';
    const ta=document.getElementById(pfx+'eta-'+id);
    const ee=document.getElementById(pfx+'ee-'+id);
    if(ee)ee.textContent='';
    const text=ta?ta.value.trim():'';const stars=ES[id]||0;
    if(!text||!stars){if(ee)ee.textContent='✗ Fill in text and stars';return;}
    try{
        const r=await fetch('/reviews/'+tuid+'/'+id,{method:'PUT',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},body:JSON.stringify({text,stars})});
        const d=await r.json();
        if(r.ok){N('✓ Review updated','success');closeEF(id,profile);loadMyRevs();if(cuid===tuid)loadRevs(tuid);}
        else{if(ee)ee.textContent='✗ '+(d.error||'Error');}
    }catch{if(ee)ee.textContent='✗ Network error';}
}
async function delMyRv(tuid,id){
    if(!confirm('Delete this review?'))return;
    const r=await fetch('/reviews/'+tuid+'/'+id,{method:'DELETE',headers:{'Authorization':'Bearer '+tok}});
    if(r.ok){N('Review deleted','success');loadMyRevs();if(cuid===tuid)loadRevs(tuid);}
    else{const d=await r.json().catch(()=>({}));N('✗ '+(d.error||'Error'),'error');}
}

// ── Admin ─────────────────────────────────────────────────────────────────────
async function loadAdminRevs(){
    document.getElementById('adrl').innerHTML='<div class="re" style="padding:40px;"><span class="sp"></span></div>';
    try{
        const r=await fetch('/admin/reviews',{headers:{'Authorization':'Bearer '+tok}});
        if(!r.ok){document.getElementById('adrl').innerHTML='<div class="re">Access denied.</div>';return;}
        const b=await r.json();const data=b.data??b;
        admRevs=[];
        Object.entries(data).forEach(([uid,revs])=>revs.forEach(rv=>admRevs.push({...rv,tuid:uid})));
        admRevs.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
        const fl=admRevs.filter(r=>r.flagged).length;
        document.getElementById('ad-tot').textContent=admRevs.length;
        document.getElementById('ad-fl').textContent=fl;
        renderAdmin();
    }catch{document.getElementById('adrl').innerHTML='<div class="re">Failed to load.</div>';}
}
function setAF(f,btn){af=f;document.querySelectorAll('.fc').forEach(c=>c.classList.remove('on'));btn.classList.add('on');renderAdmin();}
function renderAdmin(){
    const q=(document.getElementById('adsrch')||{}).value?.toLowerCase()||'';
    const filt=admRevs.filter(rv=>{
        if(af==='flagged'&&!rv.flagged)return false;
        if(['1','2','3','4','5'].includes(af)&&rv.stars!==+af)return false;
        if(q&&!rv.text.toLowerCase().includes(q)&&!rv.authorUsername.toLowerCase().includes(q)&&!rv.tuid.includes(q))return false;
        return true;
    });
    document.getElementById('ad-sh').textContent=filt.length;
    const list=document.getElementById('adrl');
    if(!filt.length){list.innerHTML='<div class="re" style="padding:40px;"><div class="eic">◇</div><div>No reviews match.</div></div>';return;}
    list.innerHTML='';
    filt.forEach(rv=>{
        const el=document.createElement('div');el.className='adri';
        el.innerHTML=
            '<div class="adrl2">'+
                '<div class="adm">'+
                    '<span class="ada">'+H(rv.authorUsername)+'</span>'+
                    '<span class="adarr">→</span>'+
                    '<span class="adt">user #'+H(rv.tuid)+'</span>'+
                    '<div class="rvst">'+[1,2,3,4,5].map(n=>'<span class="st'+(n<=rv.stars?' f':'')+'">★</span>').join('')+'</div>'+
                    (rv.flagged?'<span class="flg">FLAGGED</span>':'')+
                '</div>'+
                '<div class="adtx">'+H(rv.text)+'</div>'+
                '<div class="addate">'+new Date(rv.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})+' · '+H(rv.id)+'</div>'+
            '</div>'+
            '<div class="adrr">'+
                '<a href="https://osu.ppy.sh/users/'+H(rv.authorUserId)+'" target="_blank" class="btn bg bsm" style="font-size:11px;">Profile</a>'+
                '<button class="btn bd" onclick="admDel(\''+rv.tuid+'\',\''+rv.id+'\')">Delete</button>'+
            '</div>';
        list.appendChild(el);
    });
}
async function admDel(tuid,id){
    if(!confirm('Admin delete this review?'))return;
    const r=await fetch('/reviews/'+tuid+'/'+id,{method:'DELETE',headers:{'Authorization':'Bearer '+tok}});
    if(r.ok){N('Review deleted','success');loadAdminRevs();if(cuid===tuid)loadRevs(tuid);}
    else{const d=await r.json().catch(()=>({}));N('✗ '+(d.error||'Error'),'error');}
}

// ── Search ────────────────────────────────────────────────────────────────────
document.getElementById('pi').addEventListener('keydown',e=>{if(e.key==='Enter')searchPlayer();});
async function searchPlayer(){
    const v=document.getElementById('pi').value.trim();
    if(!v)return;
    if(!/^\d+$/.test(v)){N('Enter a numeric user ID','error');return;}
    cuid=v;
    const card=document.getElementById('pc');card.classList.remove('vis');
    document.getElementById('pn').textContent='User #'+v;
    document.getElementById('pav').src='https://a.ppy.sh/'+v;
    document.getElementById('pm').innerHTML='<span>id: '+v+'</span><a href="https://osu.ppy.sh/users/'+v+'" target="_blank" style="color:var(--g4);font-family:var(--fm);font-size:11px;">→ osu! profile</a>';
    document.getElementById('rb').innerHTML='<div class="re"><span class="sp"></span></div>';
    card.classList.add('vis');
    await loadRevs(v);updateWP();
}

async function loadRevs(uid){
    const body=document.getElementById('rb');
    try{
        const r=await fetch('/reviews/'+uid);
        const revs=await r.json();
        if(!Array.isArray(revs)||!revs.length){body.innerHTML='<div class="re"><div class="eic">◇</div><div>No reviews yet.</div></div>';return;}
        body.innerHTML='';
        revs.slice().reverse().forEach((rv,i)=>{
            const mine=usr&&String(usr.userId)===String(rv.authorUserId);
            const el=document.createElement('div');el.className='rvi';el.style.animationDelay=(i*.05)+'s';
            el.innerHTML=
                '<div class="rvt">'+
                    '<div class="rva">'+
                        '<img class="rvav" src="https://a.ppy.sh/'+H(rv.authorUserId)+'" onerror="this.src=\'data:image/svg+xml,<svg xmlns=\\'http://www.w3.org/2000/svg\\'><rect width=\\'30\\' height=\\'30\\' fill=\\'%231a1a1a\\'/></svg>\\'" alt="">'+
                        '<div><a class="rvan" href="https://osu.ppy.sh/users/'+H(rv.authorUserId)+'" target="_blank">'+H(rv.authorUsername)+'</a>'+
                        '<div class="rvd">'+new Date(rv.createdAt).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})+(rv.updatedAt?' · edited':'')+'</div></div>'+
                    '</div>'+
                    '<div class="rvst">'+[1,2,3,4,5].map(n=>'<span class="st'+(n<=rv.stars?' f':'')+'">★</span>').join('')+'</div>'+
                '</div>'+
                '<div class="rvtx">'+H(rv.text)+'</div>'+
                (mine?
                    '<div class="rvac">'+
                        '<button class="btn be" onclick="openEF(\''+rv.id+'\',\''+uid+'\','+rv.stars+','+JSON.stringify(rv.text)+',true)">Edit</button>'+
                        '<button class="btn bd" onclick="delMyRv(\''+uid+'\',\''+rv.id+'\')">Delete</button>'+
                    '</div>'+
                    '<div class="ef" id="pef-'+rv.id+'">'+
                        '<div class="est" id="pest-'+rv.id+'">'+[1,2,3,4,5].map(n=>'<button class="estr" data-s="'+n+'" onclick="setES(\''+rv.id+'\','+n+',true)">★</button>').join('')+'</div>'+
                        '<textarea class="eta" id="peta-'+rv.id+'" maxlength="300">'+H(rv.text)+'</textarea>'+
                        '<div class="er"><button class="btn bp bsm" onclick="saveEF(\''+rv.id+'\',\''+uid+'\',true)">Save</button><button class="btn bg bsm" onclick="closeEF(\''+rv.id+'\',true)">Cancel</button></div>'+
                        '<div class="we" id="pee-'+rv.id+'"></div>'+
                    '</div>'
                :'');
            body.appendChild(el);
        });
    }catch{body.innerHTML='<div class="re"><div class="eic">!</div><div>Failed to load.</div></div>';}
}

// ── Write review ─────────────────────────────────────────────────────────────
function updateWP(){
    const wp=document.getElementById('wpanel'),lp=document.getElementById('lp2');
    if(!cuid){wp.classList.add('hidden');lp.classList.add('hidden');return;}
    if(!usr){wp.classList.add('hidden');lp.classList.remove('hidden');return;}
    if(String(usr.userId)===String(cuid)){wp.classList.add('hidden');lp.classList.add('hidden');return;}
    wp.classList.remove('hidden');lp.classList.add('hidden');
}
function setStar(n){selStar=n;document.querySelectorAll('.wstr').forEach(b=>b.classList.toggle('on',+b.dataset.s<=n));valSub();}
document.getElementById('wstars').addEventListener('mouseover',e=>{const b=e.target.closest('.wstr');if(!b)return;document.querySelectorAll('.wstr').forEach(x=>x.classList.toggle('on',+x.dataset.s<=+b.dataset.s));});
document.getElementById('wstars').addEventListener('mouseleave',()=>{document.querySelectorAll('.wstr').forEach(b=>b.classList.toggle('on',+b.dataset.s<=selStar));});
function onTAInput(){const t=document.getElementById('wta');document.getElementById('wchar').textContent=t.value.length+' / 300';valSub();}
function valSub(){const t=document.getElementById('wta');document.getElementById('sbtn').disabled=!(t.value.trim().length>=5&&selStar>0);}
async function submitReview(){
    if(!tok||!cuid)return;
    const text=document.getElementById('wta').value.trim();
    const ee=document.getElementById('werr'),btn=document.getElementById('sbtn');
    ee.textContent='';if(!text||!selStar)return;
    btn.innerHTML='<span class="sp"></span>Submitting…';btn.disabled=true;
    try{
        const r=await fetch('/reviews',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},body:JSON.stringify({targetUserId:cuid,stars:selStar,text})});
        const d=await r.json();
        if(r.ok){document.getElementById('wta').value='';document.getElementById('wchar').textContent='0 / 300';selStar=0;document.querySelectorAll('.wstr').forEach(b=>b.classList.remove('on'));N('✓ Review posted!','success');await loadRevs(cuid);loadMyRevs();}
        else if(r.status===401){tok=null;usr=null;localStorage.removeItem('osu_tok');renderOut();ee.textContent='✗ Session expired';}
        else{ee.textContent='✗ '+(d.error||'Error');}
    }catch{ee.textContent='✗ Could not reach server';}
    finally{btn.innerHTML='Submit review';valSub();}
}

function H(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
verifySess();
</script>
</body>
</html>`;
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    setCORS(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url      = new URL(req.url, 'http://' + req.headers.host);
    const pathname = url.pathname;
    const method   = req.method;
    console.log('[' + new Date().toLocaleTimeString() + '] ' + method + ' ' + pathname);

    try {

        if (method === 'GET' && pathname === '/auth/login') {
            if (!OSU_CLIENT_ID || !REDIRECT_URI) { err(res, 503, 'OAuth not configured'); return; }
            const p = new URLSearchParams({ client_id: OSU_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'identify' });
            json(res, 200, { url: 'https://osu.ppy.sh/oauth/authorize?' + p }); return;
        }

        if (method === 'GET' && pathname === '/auth/callback') {
            const code = url.searchParams.get('code'), error = url.searchParams.get('error');
            if (error || !code) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end('<html><body><script>window.opener?.postMessage({type:"osu-auth-error",error:"' + escapeHtml(error||'no code') + '"},"*");window.close();<\/script></body></html>'); return; }
            try {
                const tokens = await exchangeCode(code);
                if (!tokens.access_token) throw new Error('No access token');
                const osuUser = await osuApiGet('me', tokens.access_token);
                if (!osuUser?.id) throw new Error('Could not fetch user');
                const st = makeSessionToken();
                sessions.set(st, { userId: osuUser.id, username: osuUser.username, avatarUrl: osuUser.avatar_url || null, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
                console.log('Login: ' + osuUser.username + ' (' + osuUser.id + ')');
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<!DOCTYPE html><html><head><style>body{background:#0a0a0a;color:#f5f5f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;}strong{color:#4ade80;}</style></head><body><p>✓ Logged in as <strong>' + escapeHtml(osuUser.username) + '</strong></p><p style="font-size:12px;opacity:.5">Closing…</p><script>window.opener?.postMessage({type:"osu-auth-success",token:"' + st + '",userId:' + osuUser.id + ',username:"' + escapeHtml(osuUser.username) + '",avatarUrl:"' + escapeHtml(osuUser.avatar_url||'') + '"},"*");setTimeout(()=>window.close(),1000);<\/script></body></html>');
            } catch (e) {
                console.error('Auth error:', e.message);
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end('<html><body><script>window.opener?.postMessage({type:"osu-auth-error",error:"' + escapeHtml(e.message) + '"},"*");window.close();<\/script></body></html>');
            }
            return;
        }

        if (method === 'GET' && pathname === '/auth/me') {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Not logged in'); return; }
            json(res, 200, { success: true, data: { userId: s.userId, username: s.username, avatarUrl: s.avatarUrl } }); return;
        }

        if (method === 'POST' && pathname === '/auth/logout') {
            const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
            if (auth) sessions.delete(auth);
            json(res, 200, { ok: true }); return;
        }

        if (method === 'GET' && pathname === '/admin/reviews') {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Not logged in'); return; }
            if (isAdmin(s)) { json(res, 200, { success: true, data: reviews }); return; }
            const mine = {};
            Object.entries(reviews).forEach(([uid, revs]) => { const f = revs.filter(r => String(r.authorUserId) === String(s.userId)); if (f.length) mine[uid] = f; });
            json(res, 200, { success: true, data: mine }); return;
        }

        if (method === 'GET' && pathname === '/notes') {
            const id = url.searchParams.get('beatmapsetId');
            if (!id) { err(res, 400, 'beatmapsetId required'); return; }
            setCORS(res); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(mem.notes.filter(n => n.beatmapsetId === id))); return;
        }
        if (method === 'POST' && pathname === '/notes') {
            const d = await parseBody(req);
            if (!d.beatmapsetId || !d.text) { err(res, 400, 'beatmapsetId and text required'); return; }
            const note = { id: d.id || 'note_' + uid(), time: d.time || '00:00:000', author: d.author || 'Anonymous', text: d.text.trim(), beatmapsetId: d.beatmapsetId, resolved: d.resolved || false, created: d.created || Date.now(), reactions: [], replies: [] };
            mem.notes.push(note); mem.history.push({ type: 'note', author: note.author, beatmapsetId: note.beatmapsetId, timestamp: note.created, preview: note.text.slice(0, 100) });
            ok(res, note); return;
        }
        if (method === 'POST' && pathname === '/notes/react') {
            const { noteId, emoji, username } = await parseBody(req);
            if (!noteId || !emoji || !username) { err(res, 400, 'noteId, emoji, username required'); return; }
            const note = mem.notes.find(n => n.id === noteId || String(n.created) === String(noteId));
            if (!note) { err(res, 404, 'Note not found'); return; }
            if (!note.reactions) note.reactions = [];
            const idx = note.reactions.findIndex(r => r.emoji === emoji && r.username === username);
            if (idx >= 0) note.reactions.splice(idx, 1); else note.reactions.push({ emoji, username, timestamp: Date.now() });
            ok(res, note); return;
        }
        if (method === 'POST' && pathname === '/notes/reply') {
            const { noteId, text, username, beatmapsetId } = await parseBody(req);
            if (!noteId || !text || !username) { err(res, 400, 'noteId, text, username required'); return; }
            const note = mem.notes.find(n => n.id === noteId || String(n.created) === String(noteId));
            if (!note) { err(res, 404, 'Note not found'); return; }
            if (!note.replies) note.replies = [];
            const reply = { username, text: text.trim(), timestamp: Date.now() };
            note.replies.push(reply); mem.history.push({ type: 'reply', author: username, beatmapsetId: beatmapsetId || note.beatmapsetId, timestamp: reply.timestamp, preview: text.slice(0, 100) });
            ok(res, note); return;
        }
        if (method === 'DELETE' && pathname.startsWith('/notes/')) {
            const noteId = pathname.split('/')[2];
            const idx = mem.notes.findIndex(n => n.id === noteId || String(n.created) === noteId);
            if (idx === -1) { err(res, 404, 'Note not found'); return; }
            mem.notes.splice(idx, 1); ok(res, { deleted: true }); return;
        }

        if (method === 'GET' && pathname === '/chat') {
            const id = url.searchParams.get('beatmapsetId');
            if (!id) { err(res, 400, 'beatmapsetId required'); return; }
            ok(res, mem.chat.filter(m => m.beatmapsetId === id).slice(-100)); return;
        }
        if (method === 'POST' && pathname === '/chat') {
            const d = await parseBody(req);
            if (!d.beatmapsetId || !d.text || !d.author) { err(res, 400, 'beatmapsetId, text, author required'); return; }
            const msg = { id: 'msg_' + uid(), author: d.author, text: d.text.trim(), beatmapsetId: d.beatmapsetId, timestamp: d.timestamp || Date.now() };
            mem.chat.push(msg); mem.history.push({ type: 'chat', author: msg.author, beatmapsetId: msg.beatmapsetId, timestamp: msg.timestamp, preview: msg.text.slice(0, 100) });
            ok(res, msg); return;
        }

        if (method === 'GET' && pathname === '/collab/users') {
            const id = url.searchParams.get('beatmapsetId'), now = Date.now();
            let active = mem.users.filter(u => now - u.timestamp < 30000);
            if (id) active = active.filter(u => u.beatmapsetId === id);
            ok(res, active); return;
        }
        if (method === 'POST' && pathname === '/collab/users') {
            const d = await parseBody(req);
            if (!d.userId || !d.username) { err(res, 400, 'userId and username required'); return; }
            mem.users = mem.users.filter(u => u.userId !== d.userId);
            const p = { userId: d.userId, username: d.username, avatarUrl: d.avatarUrl || null, beatmapsetId: d.beatmapsetId || null, timestamp: d.timestamp || Date.now() };
            mem.users.push(p); ok(res, p); return;
        }

        if (method === 'GET' && pathname === '/session/history') {
            const id = url.searchParams.get('beatmapsetId'), limit = parseInt(url.searchParams.get('limit')) || 50;
            let h = id ? mem.history.filter(e => e.beatmapsetId === id) : mem.history;
            ok(res, h.slice(-limit)); return;
        }

        if (method === 'GET' && /^\/reviews\/\d{1,10}$/.test(pathname)) {
            json(res, 200, reviews[pathname.split('/')[2]] || []); return;
        }

        if (method === 'POST' && pathname === '/reviews') {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Must be logged in'); return; }
            const d = await parseBody(req);
            const text = (d.text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
            const tuid = String(d.targetUserId || '');
            const stars = Number(d.stars);
            if (!tuid || !/^\d{1,10}$/.test(tuid)) { err(res, 400, 'Invalid targetUserId'); return; }
            if (!Number.isInteger(stars) || stars < 1 || stars > 5) { err(res, 400, 'stars must be 1–5'); return; }
            if (text.length < 5)   { err(res, 400, 'Review too short (min 5 chars)'); return; }
            if (text.length > 300) { err(res, 400, 'Review too long (max 300 chars)'); return; }
            if (String(s.userId) === tuid) { err(res, 400, 'Cannot review yourself'); return; }
            if (containsProfanity(text)) { err(res, 400, 'Review contains prohibited language. Please keep it respectful.'); return; }
            if (!reviews[tuid]) reviews[tuid] = [];
            if (reviews[tuid].some(r => String(r.authorUserId) === String(s.userId))) { json(res, 409, { error: 'You have already reviewed this player' }); return; }
            const review = { id: uid(), authorUserId: s.userId, authorUsername: s.username, stars, text, flagged: false, createdAt: new Date().toISOString(), updatedAt: null };
            reviews[tuid].push(review);
            saveReviewsToGitHub();
            console.log('Review by ' + s.username + ' for ' + tuid + ' (' + stars + '★)');
            json(res, 201, { ok: true, id: review.id }); return;
        }

        if (method === 'PUT' && /^\/reviews\/\d{1,10}\/[\w]+$/.test(pathname)) {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Not logged in'); return; }
            const [,,uid2,rid] = pathname.split('/');
            if (!reviews[uid2]) { err(res, 404, 'No reviews for that user'); return; }
            const review = reviews[uid2].find(r => r.id === rid);
            if (!review) { err(res, 404, 'Review not found'); return; }
            if (String(review.authorUserId) !== String(s.userId) && !isAdmin(s)) { err(res, 403, 'Can only edit your own reviews'); return; }
            const d = await parseBody(req);
            const text  = (d.text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
            const stars = Number(d.stars);
            if (text && text.length < 5)   { err(res, 400, 'Too short'); return; }
            if (text && text.length > 300) { err(res, 400, 'Too long'); return; }
            if (text && containsProfanity(text)) { err(res, 400, 'Review contains prohibited language.'); return; }
            if (stars && (!Number.isInteger(stars) || stars < 1 || stars > 5)) { err(res, 400, 'stars must be 1–5'); return; }
            if (text)  review.text  = text;
            if (stars) review.stars = stars;
            review.updatedAt = new Date().toISOString();
            saveReviewsToGitHub();
            json(res, 200, { ok: true }); return;
        }

        if (method === 'DELETE' && /^\/reviews\/\d{1,10}\/[\w]+$/.test(pathname)) {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Not logged in'); return; }
            const [,,uid2,rid] = pathname.split('/');
            if (!reviews[uid2]) { err(res, 404, 'No reviews for that user'); return; }
            const review = reviews[uid2].find(r => r.id === rid);
            if (!review) { err(res, 404, 'Review not found'); return; }
            if (String(review.authorUserId) !== String(s.userId) && !isAdmin(s)) { err(res, 403, 'Can only delete your own reviews'); return; }
            reviews[uid2] = reviews[uid2].filter(r => r.id !== rid);
            saveReviewsToGitHub();
            json(res, 200, { ok: true }); return;
        }

        if (method === 'GET' && pathname === '/health') { ok(res, { status: 'healthy', uptime: process.uptime(), memory: process.memoryUsage(), version: '2.4.0' }); return; }
        if (method === 'GET' && pathname === '/stats') {
            const t = Object.values(reviews).reduce((a, b) => a + b.length, 0);
            ok(res, { uptime: Math.floor(process.uptime()), notes: mem.notes.length, chat: mem.chat.length, users: mem.users.filter(u => Date.now() - u.timestamp < 30000).length, reviews: t, sessions: sessions.size, storage: GITHUB_TOKEN ? 'github (' + GITHUB_REPO + ')' : 'memory-only' }); return;
        }
        if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        if (method === 'GET' && pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(buildHomePage()); return; }

        err(res, 404, 'Endpoint ' + pathname + ' not found');

    } catch (e) {
        console.error('Error:', e.message);
        err(res, 500, 'Server error: ' + e.message);
    }
});

loadReviewsFromGitHub().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log('='.repeat(60));
        console.log('osu! Collab Server v2.4.0');
        console.log('http://0.0.0.0:' + PORT);
        console.log('Reviews: ' + (GITHUB_TOKEN ? 'GitHub → ' + GITHUB_REPO : 'IN-MEMORY ONLY'));
        console.log('OAuth: ' + (OSU_CLIENT_ID ? 'Configured' : 'NOT CONFIGURED'));
        console.log('Admin: ' + ADMIN_USERNAME);
        console.log('='.repeat(60));
    });
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
process.on('uncaughtException',  e => { console.error('Uncaught:', e); process.exit(1); });
process.on('unhandledRejection', e => console.error('Unhandled:', e));
