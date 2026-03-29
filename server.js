// osu! Collab Server v2.5.0
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

const PORT              = process.env.PORT              || 3000;
const GITHUB_TOKEN      = process.env.GITHUB_TOKEN      || '';
const GITHUB_REPO       = process.env.GITHUB_REPO       || '';
const REVIEW_TOKEN      = process.env.REVIEW_TOKEN      || '';
const OSU_CLIENT_ID     = process.env.OSU_CLIENT_ID     || '';
const OSU_CLIENT_SECRET = process.env.OSU_CLIENT_SECRET || '';
const REDIRECT_URI      = process.env.REDIRECT_URI      || '';
const SESSION_SECRET    = process.env.SESSION_SECRET    || 'changeme';
const ADMIN_USERNAME    = (process.env.ADMIN_USERNAME   || 'Bei').toLowerCase();

if (!GITHUB_TOKEN || !GITHUB_REPO)
    console.warn('WARNING: GITHUB_TOKEN or GITHUB_REPO not set — reviews will NOT persist!');
if (!OSU_CLIENT_ID || !OSU_CLIENT_SECRET || !REDIRECT_URI)
    console.warn('WARNING: OAuth env vars not set — login will not work!');

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
    return BLOCKED_WORDS.some(w => new RegExp('(?<![a-z])' + w + '(?![a-z])', 'i').test(lower));
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
            client_id: parseInt(OSU_CLIENT_ID, 10),
            client_secret: OSU_CLIENT_SECRET.trim(),
            code,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI.trim(),
        });
        const req = https.request({
            hostname: 'osu.ppy.sh', path: '/oauth/token', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'osu-collab-server' },
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
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
            headers: {
                'Authorization': 'token ' + GITHUB_TOKEN,
                'User-Agent': 'osu-collab-server',
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            },
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
            const total = Object.values(reviews).reduce((a, b) => a + b.length, 0);
            console.log('Loaded ' + total + ' reviews from GitHub');
        } else if (r.status !== 404) { console.warn('GitHub load failed:', r.status); }
    } catch (e) { console.error('GitHub load error:', e.message); }
}

async function saveReviewsToGitHub() {
    if (!GITHUB_TOKEN || !GITHUB_REPO) return;
    if (saveInFlight) { reviewsDirty = true; return; }
    saveInFlight = true; reviewsDirty = false;
    try {
        const content = Buffer.from(JSON.stringify(reviews, null, 2)).toString('base64');
        const r = await githubRequest('PUT', '/repos/' + GITHUB_REPO + '/contents/reviews.json', {
            message: 'update reviews ' + new Date().toISOString(),
            content,
            ...(reviewsSHA ? { sha: reviewsSHA } : {})
        });
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

// ─── Frontend ─────────────────────────────────────────────────────────────────
function buildHomePage() {
    const totalReviews = Object.values(reviews).reduce((a, b) => a + b.length, 0);
    const uptime = Math.floor(process.uptime());
    const uptimeStr = uptime < 60 ? uptime + 's'
        : uptime < 3600 ? Math.floor(uptime/60) + 'm ' + (uptime%60) + 's'
        : Math.floor(uptime/3600) + 'h ' + Math.floor((uptime%3600)/60) + 'm';

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
    --black: #0a0a0a;
    --white: #f5f5f0;
    --g1: #1a1a1a;
    --g2: #2a2a2a;
    --g3: #444;
    --g4: #888;
    --g5: #bbb;
    --line: rgba(255,255,255,0.08);
    --line-hi: rgba(255,255,255,0.18);
    --fd: 'Instrument Serif', serif;
    --fu: 'Syne', sans-serif;
    --fm: 'DM Mono', monospace;
    --ease: cubic-bezier(0.16,1,0.3,1);
}

html { scroll-behavior: smooth; }

body {
    background: var(--black);
    color: var(--white);
    font-family: var(--fu);
    min-height: 100vh;
    overflow-x: hidden;
}

/* ── Custom cursor ── */
#cur {
    position: fixed; top: 0; left: 0;
    width: 10px; height: 10px;
    background: var(--white);
    border-radius: 50%;
    pointer-events: none;
    z-index: 99999;
    transform: translate(-50%, -50%);
    transition: width .15s var(--ease), height .15s var(--ease);
    mix-blend-mode: difference;
}
#cur-ring {
    position: fixed; top: 0; left: 0;
    width: 34px; height: 34px;
    border: 1px solid rgba(255,255,255,0.4);
    border-radius: 50%;
    pointer-events: none;
    z-index: 99998;
    transform: translate(-50%, -50%);
}
.cur-big #cur { width: 20px; height: 20px; }

/* ── Noise + grid ── */
body::before {
    content: '';
    position: fixed; inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    opacity: .025;
    pointer-events: none;
    z-index: 0;
}
.gbg {
    position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 80px 80px;
    mask-image: radial-gradient(ellipse 80% 80% at 50% 0%, black 0%, transparent 80%);
}

/* ── Layout ── */
.wrap { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: 0 40px; }

/* ── Header ── */
header {
    position: sticky; top: 0; z-index: 100;
    padding: 20px 0;
    border-bottom: 1px solid var(--line);
    background: rgba(10,10,10,0.85);
    backdrop-filter: blur(12px);
}
.hd { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; }
.logo {
    font-family: var(--fd);
    font-size: 20px;
    display: flex; align-items: center; gap: 10px;
    color: var(--white);
}
.ldot { width: 8px; height: 8px; background: var(--white); border-radius: 50%; animation: pulse 2s ease infinite; }
@keyframes pulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.5);opacity:.5} }

nav { display: flex; gap: 6px; flex-wrap: wrap; }
nav a {
    font-family: var(--fm); font-size: 11px;
    color: var(--g4); text-decoration: none;
    padding: 5px 12px; border-radius: 20px;
    border: 1px solid transparent;
    transition: all .2s;
    letter-spacing: .3px;
}
nav a:hover { color: var(--white); border-color: var(--line-hi); }

.hstatus {
    font-family: var(--fm); font-size: 11px; color: var(--g4);
    display: flex; align-items: center; gap: 14px;
}
.sdot { width: 6px; height: 6px; background: #4ade80; border-radius: 50%; display: inline-block; margin-right: 5px; animation: pulse 2s ease infinite; }

/* ── Hero ── */
.eyebrow {
    font-family: var(--fm); font-size: 11px; letter-spacing: 2px;
    color: var(--g4); text-transform: uppercase;
    margin-bottom: 20px;
    opacity: 0; animation: fadeUp .8s var(--ease) .1s forwards;
}
h1 {
    font-family: var(--fd);
    font-size: clamp(52px, 7vw, 92px);
    line-height: .93; letter-spacing: -2px;
    margin-bottom: 28px;
    opacity: 0; animation: fadeUp .8s var(--ease) .2s forwards;
}
h1 em { font-style: italic; color: var(--g5); }
.hero-sub {
    font-size: 14px; color: var(--g4);
    max-width: 460px; line-height: 1.75;
    margin-bottom: 52px;
    opacity: 0; animation: fadeUp .8s var(--ease) .3s forwards;
}

/* ── Stats row ── */
.stats {
    display: flex; gap: 1px;
    border: 1px solid var(--line-hi); border-radius: 12px; overflow: hidden;
    max-width: 640px;
    opacity: 0; animation: fadeUp .8s var(--ease) .4s forwards;
}
.stat {
    flex: 1; padding: 18px 22px;
    background: rgba(255,255,255,.02);
    border-right: 1px solid var(--line);
    transition: background .2s;
}
.stat:last-child { border-right: none; }
.stat:hover { background: rgba(255,255,255,.05); }
.stat-n { font-family: var(--fd); font-size: 34px; line-height: 1; margin-bottom: 3px; }
.stat-l { font-family: var(--fm); font-size: 10px; letter-spacing: 1.5px; color: var(--g4); text-transform: uppercase; }

/* ── Decorative circle ── */
.hero-circ {
    position: absolute; right: 20px; top: 30px;
    width: 280px; height: 280px;
    border: 1px solid var(--line-hi); border-radius: 50%;
    opacity: 0; animation: fadeIn 1.2s var(--ease) .5s forwards, spin 40s linear infinite;
    pointer-events: none;
}
.hero-circ::before {
    content: ''; position: absolute;
    top: 28px; left: 28px; right: 28px; bottom: 28px;
    border: 1px solid var(--line); border-radius: 50%;
}
.hero-circ::after {
    content: ''; position: absolute;
    top: 50%; left: -4px;
    width: 8px; height: 8px;
    background: var(--white); border-radius: 50%;
    transform: translateY(-50%);
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Sections ── */
.sec { padding: 90px 0; border-top: 1px solid var(--line); scroll-margin-top: 80px; }
.sec-label {
    font-family: var(--fm); font-size: 10px;
    letter-spacing: 2px; color: var(--g4); text-transform: uppercase;
    margin-bottom: 40px;
    display: flex; align-items: center; gap: 14px;
}
.sec-label::after { content: ''; flex: 1; height: 1px; background: var(--line); }

/* ── Login panel ── */
.login-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
    border: 1px solid var(--line-hi); border-radius: 16px; overflow: hidden;
    max-width: 760px;
}
.login-info { padding: 44px; background: rgba(255,255,255,.02); }
.login-info h2 { font-family: var(--fd); font-size: 30px; line-height: 1.1; margin-bottom: 14px; letter-spacing: -.4px; }
.login-info p { font-size: 13px; color: var(--g4); line-height: 1.75; margin-bottom: 28px; }
.feat-list { list-style: none; display: flex; flex-direction: column; gap: 9px; }
.feat-list li { font-size: 12px; color: var(--g5); display: flex; align-items: center; gap: 9px; font-family: var(--fm); }
.feat-list li::before { content: '→'; color: var(--g3); }
.login-action {
    padding: 44px; background: rgba(255,255,255,.03);
    display: flex; flex-direction: column; justify-content: center; align-items: center;
    text-align: center; gap: 14px;
    min-height: 280px;
}
.av-wrap {
    width: 76px; height: 76px; border-radius: 50%;
    border: 1px solid var(--line-hi); background: var(--g1);
    display: flex; align-items: center; justify-content: center;
    font-size: 26px; overflow: hidden;
    transition: all .3s;
    margin: 0 auto;
}
.av-wrap img { width: 100%; height: 100%; object-fit: cover; display: none; }
.av-wrap.loaded img { display: block; }
.av-wrap.loaded .av-icon { display: none; }

/* ── Buttons ── */
.btn {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 11px 26px; border-radius: 8px;
    font-family: var(--fu); font-size: 13px; font-weight: 600;
    cursor: pointer; border: none;
    transition: all .2s var(--ease); text-decoration: none;
}
.btn-primary { background: var(--white); color: var(--black); }
.btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(255,255,255,.14); }
.btn-primary:disabled { opacity: .4; transform: none; cursor: default; box-shadow: none; }
.btn-ghost { background: transparent; color: var(--white); border: 1px solid var(--line-hi); }
.btn-ghost:hover { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.3); }
.btn-danger { background: transparent; color: #ff6b6b; border: 1px solid rgba(255,107,107,.3); font-size: 12px; padding: 6px 14px; }
.btn-danger:hover { background: rgba(255,107,107,.08); }
.btn-sm { padding: 7px 16px; font-size: 12px; }
.btn-edit { background: transparent; color: var(--g4); border: 1px solid var(--line); font-size: 11px; padding: 5px 12px; }
.btn-edit:hover { color: var(--white); border-color: var(--line-hi); }

/* ── Search ── */
.search-row { display: flex; gap: 10px; margin-bottom: 36px; max-width: 600px; }
.search-input {
    flex: 1; padding: 11px 15px;
    background: rgba(255,255,255,.04);
    border: 1px solid var(--line-hi); border-radius: 8px;
    color: var(--white); font-family: var(--fu); font-size: 13px;
    outline: none; transition: all .2s;
}
.search-input::placeholder { color: var(--g3); }
.search-input:focus { border-color: rgba(255,255,255,.32); background: rgba(255,255,255,.06); }

/* ── Profile card ── */
.profile-card {
    border: 1px solid var(--line-hi); border-radius: 16px; overflow: hidden;
    max-width: 800px;
    opacity: 0; transform: translateY(14px);
    transition: all .4s var(--ease);
}
.profile-card.visible { opacity: 1; transform: translateY(0); }
.profile-header {
    padding: 36px 44px; background: rgba(255,255,255,.03);
    display: flex; align-items: center; gap: 24px;
    border-bottom: 1px solid var(--line);
    position: relative; overflow: hidden;
}
.profile-header::before {
    content: ''; position: absolute; inset: 0;
    background: radial-gradient(ellipse 60% 80% at 0% 50%, rgba(255,255,255,.03) 0%, transparent 70%);
    pointer-events: none;
}
.profile-avatar { width: 84px; height: 84px; border-radius: 50%; border: 2px solid var(--line-hi); object-fit: cover; flex-shrink: 0; }
.profile-info h3 { font-family: var(--fd); font-size: 26px; letter-spacing: -.4px; margin-bottom: 5px; }
.profile-meta { font-family: var(--fm); font-size: 11px; color: var(--g4); display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
.profile-meta a { color: var(--g4); text-decoration: none; }
.profile-meta a:hover { color: var(--white); }
.reviews-body { padding: 28px 44px 36px; }
.reviews-empty { text-align: center; padding: 44px 20px; color: var(--g4); font-family: var(--fm); font-size: 12px; line-height: 1.9; }
.empty-icon { font-size: 28px; margin-bottom: 10px; opacity: .35; }

/* ── Review items ── */
.review-item {
    padding: 18px 0; border-bottom: 1px solid var(--line);
    opacity: 0; animation: fadeUp .4s var(--ease) forwards;
}
.review-item:last-child { border-bottom: none; padding-bottom: 0; }
.review-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
.review-author { display: flex; align-items: center; gap: 10px; }
.review-avatar { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--line-hi); object-fit: cover; background: var(--g2); flex-shrink: 0; }
.review-name { font-size: 13px; font-weight: 600; color: var(--white); text-decoration: none; }
.review-name:hover { text-decoration: underline; }
.review-date { font-family: var(--fm); font-size: 10px; color: var(--g4); margin-top: 1px; }
.stars { display: flex; gap: 2px; }
.star { font-size: 13px; color: var(--g3); }
.star.on { color: #e8e0a0; }
.review-text { font-size: 13px; color: var(--g5); line-height: 1.65; padding-left: 40px; }
.review-actions { padding-left: 40px; margin-top: 9px; display: flex; gap: 7px; flex-wrap: wrap; }
.flag-badge { font-family: var(--fm); font-size: 10px; color: #f97316; padding: 2px 7px; border: 1px solid rgba(249,115,22,.3); border-radius: 4px; }

/* ── Edit form ── */
.edit-form { margin-top: 10px; padding-left: 40px; display: none; }
.edit-form.open { display: block; }
.edit-stars { display: flex; gap: 4px; margin-bottom: 8px; }
.edit-star { background: none; border: none; font-size: 18px; color: var(--g3); cursor: pointer; padding: 1px; line-height: 1; transition: all .1s; }
.edit-star.on { color: #e8e0a0; }
.edit-textarea {
    width: 100%; min-height: 68px; resize: vertical;
    background: rgba(255,255,255,.03); border: 1px solid var(--line-hi); border-radius: 8px;
    color: var(--white); font-family: var(--fu); font-size: 13px;
    padding: 9px 13px; outline: none; margin-bottom: 8px;
    transition: border-color .2s;
}
.edit-textarea:focus { border-color: rgba(255,255,255,.28); }
.edit-row { display: flex; gap: 7px; }
.edit-err { font-size: 12px; color: #ff6b6b; margin-top: 6px; font-family: var(--fm); }

/* ── Write panel ── */
.write-panel { margin-top: 28px; border: 1px solid var(--line-hi); border-radius: 12px; overflow: hidden; max-width: 800px; }
.write-header {
    padding: 14px 22px; background: rgba(255,255,255,.03);
    border-bottom: 1px solid var(--line);
    font-family: var(--fm); font-size: 10px; letter-spacing: 1.5px; color: var(--g4); text-transform: uppercase;
    display: flex; justify-content: space-between;
}
.write-body { padding: 22px; }
.write-stars { display: flex; gap: 5px; margin-bottom: 14px; }
.write-star { background: none; border: none; font-size: 22px; color: var(--g3); cursor: pointer; padding: 2px; transition: all .1s; line-height: 1; }
.write-star.on { color: #e8e0a0; transform: scale(1.08); }
.write-star:hover { transform: scale(1.18); }
.write-textarea {
    width: 100%; min-height: 80px; resize: vertical;
    background: rgba(255,255,255,.03); border: 1px solid var(--line-hi); border-radius: 8px;
    color: var(--white); font-family: var(--fu); font-size: 13px; line-height: 1.6;
    padding: 11px 15px; outline: none; margin-bottom: 11px;
    transition: border-color .2s;
}
.write-textarea:focus { border-color: rgba(255,255,255,.28); }
.write-textarea::placeholder { color: var(--g3); }
.write-footer { display: flex; justify-content: space-between; align-items: center; }
.write-char { font-family: var(--fm); font-size: 11px; color: var(--g4); }
.write-err { font-size: 12px; color: #ff6b6b; margin-top: 7px; font-family: var(--fm); }

/* ── Dashboard ── */
.dash-empty { font-family: var(--fm); font-size: 13px; color: var(--g4); padding: 40px 0; text-align: center; }
.dash-list { max-width: 760px; border: 1px solid var(--line-hi); border-radius: 12px; overflow: hidden; }
.dash-item {
    padding: 18px 22px; border-bottom: 1px solid var(--line);
    opacity: 0; animation: fadeUp .4s var(--ease) forwards;
}
.dash-item:last-child { border-bottom: none; }
.dash-item-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }
.dash-item-meta { font-family: var(--fm); font-size: 11px; color: var(--g4); }
.dash-item-meta a { color: var(--g5); text-decoration: none; }
.dash-item-meta a:hover { text-decoration: underline; }
.dash-item-text { font-size: 13px; color: var(--g5); line-height: 1.65; margin-bottom: 10px; }
.dash-item-date { font-family: var(--fm); font-size: 10px; color: var(--g4); margin-bottom: 10px; }
.dash-item-actions { display: flex; gap: 7px; }

/* ── Admin ── */
.admin-panel { border: 1px solid rgba(255,255,255,.14); border-radius: 16px; overflow: hidden; max-width: 960px; }
.admin-head { padding: 22px 28px; background: rgba(255,255,255,.04); border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; }
.admin-badge { font-family: var(--fm); font-size: 10px; letter-spacing: 1px; padding: 3px 9px; border-radius: 3px; background: var(--white); color: var(--black); font-weight: 600; }
.admin-head h2 { font-family: var(--fd); font-size: 20px; }
.admin-filters { padding: 18px 28px; background: rgba(255,255,255,.02); border-bottom: 1px solid var(--line); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.filter-input {
    padding: 7px 13px; background: rgba(255,255,255,.04);
    border: 1px solid var(--line-hi); border-radius: 6px;
    color: var(--white); font-family: var(--fm); font-size: 12px;
    outline: none; width: 220px;
}
.filter-input::placeholder { color: var(--g3); }
.filter-input:focus { border-color: rgba(255,255,255,.28); }
.filter-chip { padding: 5px 13px; border-radius: 18px; border: 1px solid var(--line); font-family: var(--fm); font-size: 11px; cursor: pointer; background: transparent; color: var(--g4); transition: all .15s; }
.filter-chip.on { background: var(--white); color: var(--black); border-color: var(--white); }
.filter-chip:hover:not(.on) { border-color: var(--line-hi); color: var(--white); }
.admin-stats { padding: 14px 28px; background: rgba(255,255,255,.02); border-bottom: 1px solid var(--line); display: flex; gap: 28px; font-family: var(--fm); font-size: 11px; color: var(--g4); }
.admin-stats span { color: var(--white); font-weight: 500; }
.admin-list { max-height: 580px; overflow-y: auto; }
.admin-item { padding: 18px 28px; border-bottom: 1px solid var(--line); display: flex; gap: 14px; transition: background .15s; }
.admin-item:hover { background: rgba(255,255,255,.02); }
.admin-item:last-child { border-bottom: none; }
.admin-item-body { flex: 1; min-width: 0; }
.admin-item-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }
.admin-author { font-size: 12px; font-weight: 600; color: var(--white); font-family: var(--fm); }
.admin-target { font-size: 11px; color: var(--g4); font-family: var(--fm); }
.admin-arrow { font-size: 11px; color: var(--g3); }
.admin-text { font-size: 13px; color: var(--g5); line-height: 1.6; margin-bottom: 6px; }
.admin-date { font-family: var(--fm); font-size: 10px; color: var(--g4); }
.admin-actions { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; flex-shrink: 0; }

/* ── Guide ── */
.guide-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; border: 1px solid var(--line-hi); border-radius: 12px; overflow: hidden; }
.guide-item { padding: 30px; background: rgba(255,255,255,.02); transition: background .2s; }
.guide-item:hover { background: rgba(255,255,255,.04); }
.guide-num { font-family: var(--fm); font-size: 10px; letter-spacing: 2px; color: var(--g3); margin-bottom: 14px; }
.guide-title { font-family: var(--fd); font-size: 18px; letter-spacing: -.2px; margin-bottom: 10px; }
.guide-body { font-size: 13px; color: var(--g4); line-height: 1.85; }
.guide-row { display: flex; gap: 9px; margin-top: 9px; font-size: 13px; color: var(--g4); }
.guide-arrow { font-family: var(--fm); font-size: 10px; color: var(--g3); flex-shrink: 0; margin-top: 2px; }
.guide-body code { font-family: var(--fm); font-size: 11px; background: rgba(255,255,255,.06); padding: 1px 5px; border-radius: 3px; color: var(--g5); }
.guide-body strong { color: var(--g5); font-weight: 600; }

/* ── API docs ── */
.api-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1px; border: 1px solid var(--line-hi); border-radius: 12px; overflow: hidden; }
.api-item { padding: 18px 22px; background: rgba(255,255,255,.02); transition: background .2s; }
.api-item:hover { background: rgba(255,255,255,.04); }
.api-method { font-family: var(--fm); font-size: 10px; letter-spacing: 1px; font-weight: 500; margin-bottom: 5px; display: inline-block; padding: 2px 7px; border-radius: 3px; }
.m-get  { background: rgba(74,222,128,.1); color: #4ade80; }
.m-post { background: rgba(147,197,253,.1); color: #93c5fd; }
.m-put  { background: rgba(251,191,36,.1); color: #fbbf24; }
.m-del  { background: rgba(252,165,165,.1); color: #fca5a5; }
.api-path { font-family: var(--fm); font-size: 13px; color: var(--white); margin-bottom: 3px; }
.api-desc { font-size: 12px; color: var(--g4); line-height: 1.5; }

/* ── Footer ── */
footer { border-top: 1px solid var(--line); padding: 48px 0; margin-top: 80px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; }
.footer-l { font-family: var(--fm); font-size: 11px; color: var(--g4); }
.footer-r { display: flex; gap: 20px; font-family: var(--fm); font-size: 11px; }
.footer-r a { color: var(--g4); text-decoration: none; }
.footer-r a:hover { color: var(--white); }

/* ── Utilities ── */
.hidden { display: none !important; }
.spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(255,255,255,.1); border-top-color: var(--white); border-radius: 50%; animation: spin .7s linear infinite; vertical-align: middle; margin-right: 5px; }
@keyframes spin { to { transform: rotate(360deg); } }
.notif {
    position: fixed; top: 22px; right: 22px;
    padding: 11px 18px; border-radius: 8px;
    font-family: var(--fm); font-size: 12px;
    z-index: 9999; pointer-events: none;
    animation: slideIn .3s var(--ease);
    border: 1px solid;
}
@keyframes slideIn { from{opacity:0;transform:translateX(16px)} to{opacity:1;transform:translateX(0)} }
.notif-success { background: #0a0a0a; border-color: #4ade80; color: #4ade80; }
.notif-error   { background: #0a0a0a; border-color: #ff6b6b; color: #ff6b6b; }
.notif-info    { background: #0a0a0a; border-color: #93c5fd; color: #93c5fd; }
.reveal { opacity: 1 !important; transform: none !important; }
@keyframes fadeUp  { from{opacity:0;transform:translateY(18px)} to{opacity:1;transform:translateY(0)} }
@keyframes fadeIn  { from{opacity:0} to{opacity:1} }

@media (max-width: 700px) {
    .wrap { padding: 0 20px; }
    .login-grid { grid-template-columns: 1fr; }
    h1 { font-size: 44px !important; }
    .hero-circ { display: none; }
    .profile-header { flex-direction: column; align-items: flex-start; }
    .stats { flex-direction: column; }
    .guide-grid { grid-template-columns: 1fr; }
    .admin-item { flex-direction: column; }
}
</style>
</head>
<body>

<div id="cur"></div>
<div id="cur-ring"></div>
<div class="gbg"></div>

<div class="wrap">

<!-- ── Header ── -->
<header>
    <div class="hd">
        <div class="logo"><div class="ldot"></div>osu! reviews</div>
        <nav>
            <a href="#s-login">Login</a>
            <a href="#s-reviews">Reviews</a>
            <a href="#s-dash">Dashboard</a>
            <a href="#s-guide">Guide</a>
            <a href="#s-api">API</a>
        </nav>
        <div class="hstatus">
            <span><span class="sdot"></span>online</span>
            <span>${uptimeStr}</span>
            <span>${totalReviews} reviews</span>
        </div>
    </div>
</header>

<!-- ── Hero ── -->
<section class="hero" style="padding: 100px 0 90px; position: relative;">
    <div class="hero-circ"></div>
    <div class="eyebrow">osu! player reviews</div>
    <h1>leave your<br><em>mark.</em></h1>
    <p class="hero-sub">A community review system for osu! players. Log in, find anyone, share your experience.</p>
    <div class="stats">
        <div class="stat"><div class="stat-n" id="st-reviews">${totalReviews}</div><div class="stat-l">Reviews</div></div>
        <div class="stat"><div class="stat-n" id="st-sessions">${sessions.size}</div><div class="stat-l">Sessions</div></div>
        <div class="stat"><div class="stat-n">${GITHUB_TOKEN ? '✓' : '—'}</div><div class="stat-l">Storage</div></div>
    </div>
</section>

<!-- ── Login ── -->
<section class="sec reveal" id="s-login">
    <div class="sec-label">01 — authentication</div>
    <div class="login-grid">
        <div class="login-info">
            <h2>Connect your osu! account</h2>
            <p>Sign in with osu! OAuth to write, edit and manage reviews.</p>
            <ul class="feat-list">
                <li>Write reviews for any player</li>
                <li>Star ratings from 1 to 5</li>
                <li>Edit your reviews anytime</li>
                <li>Delete your own reviews</li>
                <li>Dashboard to track all your reviews</li>
            </ul>
        </div>
        <div class="login-action">
            <div id="state-out" style="display:flex;flex-direction:column;align-items:center;gap:14px;">
                <div class="av-wrap" id="av-out"><span class="av-icon">♪</span><img id="av-out-img" alt=""></div>
                <div style="display:flex;flex-direction:column;align-items:center;gap:10px;">
                    <p style="font-size:13px;color:var(--g4);margin-bottom:18px;">Not logged in.</p>
                    <button class="btn btn-primary" id="login-btn" onclick="doLogin()">Login with osu!</button>
                    <div class="write-err" id="login-err" style="margin-top:9px;"></div>
                </div>
            </div>
            <div id="state-in" class="hidden">
                <div class="av-wrap" id="av-in"><span class="av-icon">♪</span><img id="av-in-img" alt=""></div>
                <div id="user-name" style="font-family:var(--fd);font-size:22px;margin-top:11px;"></div>
                <div id="user-id"   style="font-family:var(--fm);font-size:11px;color:var(--g4);"></div>
                <div id="admin-badge" class="hidden" style="font-family:var(--fm);font-size:10px;color:#fbbf24;letter-spacing:1px;margin-top:6px;">ADMIN</div>
                <button class="btn btn-danger" style="margin-top:14px;" onclick="doLogout()">Log out</button>
            </div>
        </div>
    </div>
</section>

<!-- ── Reviews / Search ── -->
<section class="sec reveal" id="s-reviews">
    <div class="sec-label">02 — player reviews</div>
    <div class="search-row">
        <input type="text" class="search-input" id="player-input" placeholder="Enter osu! user ID…" autocomplete="off">
        <button class="btn btn-ghost" id="search-btn" onclick="searchPlayer()">Search</button>
    </div>
    <div class="profile-card" id="profile-card">
        <div class="profile-header">
            <img class="profile-avatar" id="profile-avatar" src="" alt="">
            <div class="profile-info">
                <h3 id="profile-name"></h3>
                <div class="profile-meta" id="profile-meta"></div>
            </div>
        </div>
        <div class="reviews-body" id="reviews-body">
            <div class="reviews-empty"><div class="empty-icon">◇</div><div>No reviews yet.</div></div>
        </div>
    </div>
    <div class="write-panel hidden" id="write-panel">
        <div class="write-header"><span>Write a review</span><span id="write-user" style="color:var(--g5);"></span></div>
        <div class="write-body">
            <div class="write-stars" id="write-stars">
                ${[1,2,3,4,5].map(i => `<button class="write-star" data-s="${i}" onclick="setStar(${i})">★</button>`).join('')}
            </div>
            <textarea class="write-textarea" id="write-ta" placeholder="Share your experience with this player… (be respectful)" maxlength="300" oninput="onTAInput()"></textarea>
            <div class="write-footer">
                <button class="btn btn-primary" id="submit-btn" onclick="submitReview()" disabled>Submit review</button>
                <span class="write-char" id="write-char">0 / 300</span>
            </div>
            <div class="write-err" id="write-err"></div>
        </div>
    </div>
    <div id="login-prompt" class="hidden" style="margin-top:14px;font-family:var(--fm);font-size:12px;color:var(--g4);">
        → <a href="#s-login" style="color:var(--g5);text-decoration:underline;">Log in</a> to write a review.
    </div>
</section>

<!-- ── Dashboard ── -->
<section class="sec reveal" id="s-dash">
    <div class="sec-label">03 — your dashboard</div>
    <div id="dash-out" class="dash-empty">→ <a href="#s-login" style="color:var(--g5);text-decoration:underline;">Log in</a> to manage your reviews.</div>
    <div id="dash-in" class="hidden">
        <p style="margin-bottom:20px;font-family:var(--fm);font-size:12px;color:var(--g4);">Your reviews — click Edit to change text or stars.</p>
        <div id="dash-list" class="dash-list"></div>
    </div>
</section>

<!-- ── Admin ── -->
<section class="sec reveal hidden" id="s-admin">
    <div class="sec-label">04 — admin panel</div>
    <div class="admin-panel">
        <div class="admin-head"><span class="admin-badge">ADMIN</span><h2>All Reviews</h2></div>
        <div class="admin-filters">
            <input type="text" class="filter-input" id="admin-search" placeholder="Search text, author, target…" oninput="renderAdmin()">
            <button class="filter-chip on" data-f="all"     onclick="setAdminFilter('all',this)">All</button>
            <button class="filter-chip"    data-f="flagged" onclick="setAdminFilter('flagged',this)">Flagged</button>
            <button class="filter-chip"    data-f="1"       onclick="setAdminFilter('1',this)">1★</button>
            <button class="filter-chip"    data-f="2"       onclick="setAdminFilter('2',this)">2★</button>
            <button class="filter-chip"    data-f="3"       onclick="setAdminFilter('3',this)">3★</button>
            <button class="filter-chip"    data-f="4"       onclick="setAdminFilter('4',this)">4★</button>
            <button class="filter-chip"    data-f="5"       onclick="setAdminFilter('5',this)">5★</button>
        </div>
        <div class="admin-stats">
            <div>Total: <span id="adm-total">0</span></div>
            <div>Shown: <span id="adm-shown">0</span></div>
            <div>Flagged: <span id="adm-flagged">0</span></div>
        </div>
        <div class="admin-list" id="admin-list"><div class="reviews-empty" style="padding:40px;"><span class="spinner"></span></div></div>
    </div>
</section>

<!-- ── Guide ── -->
<section class="sec reveal" id="s-guide">
    <div class="sec-label" id="guide-label">05 — how to use</div>
    <div class="guide-grid">
        <div class="guide-item">
            <div class="guide-num">01 / LOGIN</div>
            <div class="guide-title">Connect your account</div>
            <div class="guide-body">
                <div class="guide-row"><span class="guide-arrow">→</span>Scroll to <strong>Authentication</strong> and click <strong>Login with osu!</strong></div>
                <div class="guide-row"><span class="guide-arrow">→</span>A popup opens — authorise the app on osu! and accept.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Popup closes automatically. Sessions last <strong>30 days</strong>.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>The Tampermonkey script shares the same login — set the server URL in its API Keys tab.</div>
            </div>
        </div>
        <div class="guide-item">
            <div class="guide-num">02 / SEARCH</div>
            <div class="guide-title">Find a player</div>
            <div class="guide-body">
                <div class="guide-row"><span class="guide-arrow">→</span>Go to <strong>Player Reviews</strong> and enter a numeric osu! <strong>user ID</strong>.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Find any ID in their profile URL: <code>osu.ppy.sh/users/[ID]</code></div>
                <div class="guide-row"><span class="guide-arrow">→</span>Avatar and all existing reviews load instantly.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>You cannot review yourself.</div>
            </div>
        </div>
        <div class="guide-item">
            <div class="guide-num">03 / WRITE</div>
            <div class="guide-title">Leave a review</div>
            <div class="guide-body">
                <div class="guide-row"><span class="guide-arrow">→</span>After searching a player, the <strong>Write a review</strong> box appears.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Pick a <strong>star rating</strong> from 1 to 5.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Write your review — min <strong>5 chars</strong>, max <strong>300</strong>.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Reviews with slurs or profanity are <strong>rejected automatically</strong>.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Only <strong>one review per player</strong>.</div>
            </div>
        </div>
        <div class="guide-item">
            <div class="guide-num">04 / MANAGE</div>
            <div class="guide-title">Edit or delete</div>
            <div class="guide-body">
                <div class="guide-row"><span class="guide-arrow">→</span>Go to <strong>Dashboard</strong> to see all reviews you have written.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Click <strong>Edit</strong> to change text or star rating.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Click <strong>Delete</strong> to permanently remove a review.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>You can also edit/delete from the player card directly.</div>
            </div>
        </div>
        <div class="guide-item">
            <div class="guide-num">05 / SCRIPT</div>
            <div class="guide-title">Tampermonkey integration</div>
            <div class="guide-body">
                <div class="guide-row"><span class="guide-arrow">→</span>Install the osu! Suite Tampermonkey script in your browser.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Open any osu! player profile — a <strong>reviews button</strong> appears.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Read or write reviews without leaving osu!.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Set the server URL and log in from the script's <strong>API Keys</strong> tab.</div>
            </div>
        </div>
        <div class="guide-item">
            <div class="guide-num">06 / RULES</div>
            <div class="guide-title">Community guidelines</div>
            <div class="guide-body">
                <div class="guide-row"><span class="guide-arrow">→</span>Be <strong>honest and respectful</strong> — reviews are about gameplay, not personal attacks.</div>
                <div class="guide-row"><span class="guide-arrow">→</span><strong>Slurs, hate speech and profanity</strong> are auto-filtered.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Abusive reviews can be removed by admins without notice.</div>
                <div class="guide-row"><span class="guide-arrow">→</span>Reviews are <strong>public</strong> and visible to everyone.</div>
            </div>
        </div>
    </div>
</section>

<!-- ── API ── -->
<section class="sec reveal" id="s-api">
    <div class="sec-label" id="api-label">06 — api reference</div>
    <div class="api-grid">
        <div class="api-item"><span class="api-method m-get">GET</span><div class="api-path">/auth/login</div><div class="api-desc">Returns osu! OAuth URL</div></div>
        <div class="api-item"><span class="api-method m-get">GET</span><div class="api-path">/auth/me</div><div class="api-desc">Current session info</div></div>
        <div class="api-item"><span class="api-method m-post">POST</span><div class="api-path">/auth/logout</div><div class="api-desc">Destroys session</div></div>
        <div class="api-item"><span class="api-method m-get">GET</span><div class="api-path">/reviews/:userId</div><div class="api-desc">All reviews for a player</div></div>
        <div class="api-item"><span class="api-method m-post">POST</span><div class="api-path">/reviews</div><div class="api-desc">Post a review (auth required)</div></div>
        <div class="api-item"><span class="api-method m-put">PUT</span><div class="api-path">/reviews/:uid/:rid</div><div class="api-desc">Edit your own review</div></div>
        <div class="api-item"><span class="api-method m-del">DELETE</span><div class="api-path">/reviews/:uid/:rid</div><div class="api-desc">Delete a review</div></div>
        <div class="api-item"><span class="api-method m-get">GET</span><div class="api-path">/admin/reviews</div><div class="api-desc">All reviews (admin) / own (user)</div></div>
        <div class="api-item"><span class="api-method m-get">GET</span><div class="api-path">/health</div><div class="api-desc">Server health &amp; uptime</div></div>
        <div class="api-item"><span class="api-method m-get">GET</span><div class="api-path">/stats</div><div class="api-desc">Review counts &amp; storage info</div></div>
    </div>
</section>

<footer>
    <div class="footer-l">osu! reviews — v2.5.0</div>
    <div class="footer-r">
        <a href="/health">health</a>
        <a href="/stats">stats</a>
        <a href="/admin/reviews" id="admin-api-link" style="display:none">admin api</a>
    </div>
</footer>

</div><!-- /wrap -->

<script>
// ── Cursor ──────────────────────────────────────────────────────────────────
const curEl = document.getElementById('cur');
const ringEl = document.getElementById('cur-ring');
let mx = 0, my = 0, rx = 0, ry = 0;

document.addEventListener('mousemove', e => {
    mx = e.clientX; my = e.clientY;
    curEl.style.left = mx + 'px';
    curEl.style.top  = my + 'px';
});

(function animRing() {
    rx += (mx - rx) * 0.14;
    ry += (my - ry) * 0.14;
    ringEl.style.left = rx + 'px';
    ringEl.style.top  = ry + 'px';
    requestAnimationFrame(animRing);
})();

document.addEventListener('mouseover', e => {
    if (e.target.closest('a, button, input, textarea, select')) {
        curEl.style.width = '20px'; curEl.style.height = '20px';
    } else {
        curEl.style.width = '10px'; curEl.style.height = '10px';
    }
});

// ── Scroll reveal ───────────────────────────────────────────────────────────
document.querySelectorAll('.reveal').forEach(el => {
    el.style.opacity = '1';
    el.style.transform = 'none';
});

// ── State ───────────────────────────────────────────────────────────────────
let tok = localStorage.getItem('osu_tok') || null;
let usr = null;
let cuid = null;
let selStar = 0;
let adminFilter = 'all';
let adminRevs = [];
const ES = {}; // edit stars per review id

// ── Helpers ─────────────────────────────────────────────────────────────────
function H(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function starsHtml(n) {
    return [1,2,3,4,5].map(i => '<span class="star' + (i <= n ? ' on' : '') + '">★</span>').join('');
}

function notify(msg, type) {
    const el = document.createElement('div');
    el.className = 'notif notif-' + (type === 'success' ? 'success' : type === 'error' ? 'error' : 'info');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 3000);
}

// ── Auth ────────────────────────────────────────────────────────────────────
async function doLogin() {
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('login-err');
    btn.innerHTML = '<span class="spinner"></span>Opening…';
    btn.disabled = true;
    errEl.textContent = '';
    try {
        const r = await fetch('/auth/login');
        console.log('auth/login status:', r.status);
        const d = await r.json();
        console.log('auth/login response:', d);
        if (!d.url) throw new Error('No login URL returned — check OSU_CLIENT_ID and REDIRECT_URI env vars on Render');
        const popup = window.open(d.url, 'osu-auth', 'width=520,height=720,scrollbars=yes');
        if (!popup) {
            errEl.textContent = '✗ Popup blocked — please allow popups for this site and try again';
            btn.innerHTML = 'Login with osu!'; btn.disabled = false;
            return;
        }
        const timeout = setTimeout(() => {
            window.removeEventListener('message', handler);
            errEl.textContent = '✗ Login timed out';
            btn.innerHTML = 'Login with osu!'; btn.disabled = false;
        }, 120000);
        function handler(e) {
            if (e.data && e.data.type === 'osu-auth-success') {
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                tok = e.data.token;
                localStorage.setItem('osu_tok', tok);
                usr = { userId: e.data.userId, username: e.data.username, avatarUrl: e.data.avatarUrl };
                renderLoggedIn();
                notify('✓ Logged in as ' + e.data.username, 'success');
            } else if (e.data && e.data.type === 'osu-auth-error') {
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                errEl.textContent = '✗ ' + (e.data.error || 'Auth failed');
                btn.innerHTML = 'Login with osu!'; btn.disabled = false;
            }
        }
        window.addEventListener('message', handler);
    } catch (e) {
        errEl.textContent = '✗ ' + e.message;
        btn.innerHTML = 'Login with osu!'; btn.disabled = false;
    }
}

async function doLogout() {
    if (tok) await fetch('/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok } }).catch(() => {});
    tok = null; usr = null;
    localStorage.removeItem('osu_tok');
    renderLoggedOut();
    notify('Logged out', 'info');
}

async function verifySession() {
    if (!tok) return;
    try {
        const r = await fetch('/auth/me', { headers: { 'Authorization': 'Bearer ' + tok } });
        if (r.ok) {
            const b = await r.json();
            usr = b.data || b;
            renderLoggedIn();
        } else {
            tok = null; usr = null;
            localStorage.removeItem('osu_tok');
        }
    } catch {}
}

function renderLoggedIn() {
    document.getElementById('state-out').classList.add('hidden');
    document.getElementById('state-in').classList.remove('hidden');
    document.getElementById('user-name').textContent = usr.username;
    document.getElementById('user-id').textContent = 'id: ' + usr.userId;
    if (usr.avatarUrl) {
        const wrap = document.getElementById('av-in');
        const img  = document.getElementById('av-in-img');
        img.src = usr.avatarUrl;
        img.onload = () => wrap.classList.add('loaded');
    }
    document.getElementById('write-user').textContent = 'as ' + usr.username;
    const isAdm = usr.isAdmin || false;
    if (isAdm) {
        document.getElementById('admin-badge').classList.remove('hidden');
        document.getElementById('s-admin').classList.remove('hidden');
        document.getElementById('admin-api-link').style.display = '';
        document.getElementById('guide-label').textContent = '05 — how to use';
        document.getElementById('api-label').textContent = '06 — api reference';
        loadAdminRevs();
    }
    document.getElementById('dash-out').classList.add('hidden');
    document.getElementById('dash-in').classList.remove('hidden');
    loadDash();
    updateWritePanel();
}

function renderLoggedOut() {
    document.getElementById('state-in').classList.add('hidden');
    document.getElementById('state-out').classList.remove('hidden');
    document.getElementById('login-btn').innerHTML = 'Login with osu!';
    document.getElementById('login-btn').disabled = false;
    document.getElementById('dash-in').classList.add('hidden');
    document.getElementById('dash-out').classList.remove('hidden');
    document.getElementById('s-admin').classList.add('hidden');
    updateWritePanel();
}

// ── Dashboard ────────────────────────────────────────────────────────────────
async function loadDash() {
    if (!usr) return;
    const list = document.getElementById('dash-list');
    list.innerHTML = '<div class="reviews-empty" style="padding:32px;"><span class="spinner"></span></div>';
    try {
        const r = await fetch('/admin/reviews', { headers: { 'Authorization': 'Bearer ' + tok } });
        if (!r.ok) { list.innerHTML = '<div class="reviews-empty" style="padding:24px;">Could not load.</div>'; return; }
        const b = await r.json();
        const data = b.data || b;
        const mine = [];
        Object.entries(data).forEach(([uid, revs]) => {
            revs.forEach(rv => { if (String(rv.authorUserId) === String(usr.userId)) mine.push({ ...rv, tuid: uid }); });
        });
        if (!mine.length) { list.innerHTML = '<div class="reviews-empty" style="padding:32px;">You have not written any reviews yet.</div>'; return; }
        list.innerHTML = '';
        mine.forEach((rv, i) => {
            const el = document.createElement('div');
            el.className = 'dash-item';
            el.id = 'dash-' + rv.id;
            el.style.animationDelay = (i * .05) + 's';
            el.innerHTML =
                '<div class="dash-item-top">' +
                    '<div class="dash-item-meta">Review for <a href="https://osu.ppy.sh/users/' + H(rv.tuid) + '" target="_blank">#' + H(rv.tuid) + '</a></div>' +
                    '<div class="stars">' + starsHtml(rv.stars) + '</div>' +
                '</div>' +
                '<div class="dash-item-text">' + H(rv.text) + '</div>' +
                '<div class="dash-item-date">' + fmtDate(rv.createdAt) + (rv.updatedAt ? ' · edited' : '') + '</div>' +
                '<div class="dash-item-actions">' +
                    '<button class="btn btn-edit" onclick="openEdit(\'' + rv.id + '\',\'' + rv.tuid + '\',' + rv.stars + ',' + JSON.stringify(rv.text) + ',false)">Edit</button>' +
                    '<button class="btn btn-danger" onclick="deleteReview(\'' + rv.tuid + '\',\'' + rv.id + '\')">Delete</button>' +
                '</div>' +
                '<div class="edit-form" id="ef-' + rv.id + '">' +
                    '<div class="edit-stars" id="est-' + rv.id + '">' +
                        [1,2,3,4,5].map(n => '<button class="edit-star" data-s="' + n + '" onclick="setES(\'' + rv.id + '\',' + n + ',false)">★</button>').join('') +
                    '</div>' +
                    '<textarea class="edit-textarea" id="eta-' + rv.id + '" maxlength="300">' + H(rv.text) + '</textarea>' +
                    '<div class="edit-row">' +
                        '<button class="btn btn-primary btn-sm" onclick="saveEdit(\'' + rv.id + '\',\'' + rv.tuid + '\',false)">Save</button>' +
                        '<button class="btn btn-ghost btn-sm" onclick="closeEdit(\'' + rv.id + '\',false)">Cancel</button>' +
                    '</div>' +
                    '<div class="edit-err" id="ee-' + rv.id + '"></div>' +
                '</div>';
            list.appendChild(el);
        });
    } catch { list.innerHTML = '<div class="reviews-empty" style="padding:24px;color:#ff6b6b;">Failed to load.</div>'; }
}

// ── Edit helpers ─────────────────────────────────────────────────────────────
function openEdit(id, tuid, stars, text, profile) {
    document.querySelectorAll('.edit-form.open').forEach(f => f.classList.remove('open'));
    ES[id] = stars;
    const pfx = profile ? 'pef' : 'ef';
    const form = document.getElementById(pfx + '-' + id);
    if (!form) return;
    form.classList.add('open');
    const ta = document.getElementById((profile ? 'peta' : 'eta') + '-' + id);
    if (ta) ta.value = text;
    renderES(id, stars, profile);
}

function closeEdit(id, profile) {
    const f = document.getElementById((profile ? 'pef' : 'ef') + '-' + id);
    if (f) f.classList.remove('open');
}

function setES(id, n, profile) {
    ES[id] = n;
    renderES(id, n, profile);
}

function renderES(id, n, profile) {
    const wrap = document.getElementById((profile ? 'pest' : 'est') + '-' + id);
    if (!wrap) return;
    wrap.querySelectorAll('.edit-star').forEach(b => {
        const v = +b.dataset.s;
        b.classList.toggle('on', v <= n);
        b.onclick = () => setES(id, v, profile);
    });
}

async function saveEdit(id, tuid, profile) {
    const pfx = profile ? 'p' : '';
    const ta  = document.getElementById(pfx + 'eta-' + id);
    const ee  = document.getElementById(pfx + 'ee-' + id);
    if (ee) ee.textContent = '';
    const text  = ta ? ta.value.trim() : '';
    const stars = ES[id] || 0;
    if (!text || !stars) { if (ee) ee.textContent = '✗ Fill in text and stars'; return; }
    try {
        const r = await fetch('/reviews/' + tuid + '/' + id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
            body: JSON.stringify({ text, stars })
        });
        const d = await r.json();
        if (r.ok) {
            notify('✓ Review updated', 'success');
            closeEdit(id, profile);
            loadDash();
            if (cuid === tuid) loadReviews(tuid);
        } else { if (ee) ee.textContent = '✗ ' + (d.error || 'Error'); }
    } catch { if (ee) ee.textContent = '✗ Network error'; }
}

async function deleteReview(tuid, id) {
    if (!confirm('Delete this review?')) return;
    const r = await fetch('/reviews/' + tuid + '/' + id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + tok }
    });
    if (r.ok) {
        notify('Review deleted', 'success');
        loadDash();
        if (cuid === tuid) loadReviews(tuid);
    } else {
        const d = await r.json().catch(() => ({}));
        notify('✗ ' + (d.error || 'Error'), 'error');
    }
}

// ── Admin ────────────────────────────────────────────────────────────────────
async function loadAdminRevs() {
    document.getElementById('admin-list').innerHTML = '<div class="reviews-empty" style="padding:40px;"><span class="spinner"></span></div>';
    try {
        const r = await fetch('/admin/reviews', { headers: { 'Authorization': 'Bearer ' + tok } });
        if (!r.ok) { document.getElementById('admin-list').innerHTML = '<div class="reviews-empty">Access denied.</div>'; return; }
        const b = await r.json();
        const data = b.data || b;
        adminRevs = [];
        Object.entries(data).forEach(([uid, revs]) => revs.forEach(rv => adminRevs.push({ ...rv, tuid: uid })));
        adminRevs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        document.getElementById('adm-total').textContent = adminRevs.length;
        document.getElementById('adm-flagged').textContent = adminRevs.filter(r => r.flagged).length;
        renderAdmin();
    } catch { document.getElementById('admin-list').innerHTML = '<div class="reviews-empty">Failed to load.</div>'; }
}

function setAdminFilter(f, btn) {
    adminFilter = f;
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('on'));
    btn.classList.add('on');
    renderAdmin();
}

function renderAdmin() {
    const q = (document.getElementById('admin-search') || {}).value?.toLowerCase() || '';
    const filt = adminRevs.filter(rv => {
        if (adminFilter === 'flagged' && !rv.flagged) return false;
        if (['1','2','3','4','5'].includes(adminFilter) && rv.stars !== +adminFilter) return false;
        if (q && !rv.text.toLowerCase().includes(q) && !rv.authorUsername.toLowerCase().includes(q) && !rv.tuid.includes(q)) return false;
        return true;
    });
    document.getElementById('adm-shown').textContent = filt.length;
    const list = document.getElementById('admin-list');
    if (!filt.length) { list.innerHTML = '<div class="reviews-empty" style="padding:40px;"><div class="empty-icon">◇</div><div>No reviews match.</div></div>'; return; }
    list.innerHTML = '';
    filt.forEach(rv => {
        const el = document.createElement('div');
        el.className = 'admin-item';
        el.innerHTML =
            '<div class="admin-item-body">' +
                '<div class="admin-item-meta">' +
                    '<span class="admin-author">' + H(rv.authorUsername) + '</span>' +
                    '<span class="admin-arrow">→</span>' +
                    '<span class="admin-target">user #' + H(rv.tuid) + '</span>' +
                    '<div class="stars">' + starsHtml(rv.stars) + '</div>' +
                    (rv.flagged ? '<span class="flag-badge">FLAGGED</span>' : '') +
                '</div>' +
                '<div class="admin-text">' + H(rv.text) + '</div>' +
                '<div class="admin-date">' + fmtDate(rv.createdAt) + ' · ' + H(rv.id) + '</div>' +
            '</div>' +
            '<div class="admin-actions">' +
                '<a href="https://osu.ppy.sh/users/' + H(rv.authorUserId) + '" target="_blank" class="btn btn-ghost btn-sm">Profile</a>' +
                '<button class="btn btn-danger" onclick="adminDelete(\'' + rv.tuid + '\',\'' + rv.id + '\')">Delete</button>' +
            '</div>';
        list.appendChild(el);
    });
}

async function adminDelete(tuid, id) {
    if (!confirm('Admin delete this review?')) return;
    const r = await fetch('/reviews/' + tuid + '/' + id, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + tok } });
    if (r.ok) { notify('Review deleted', 'success'); loadAdminRevs(); if (cuid === tuid) loadReviews(tuid); }
    else { const d = await r.json().catch(() => ({})); notify('✗ ' + (d.error || 'Error'), 'error'); }
}

async function searchPlayer() {
    const v = document.getElementById('player-input').value.trim();
    if (!v) { notify('Please enter a user ID', 'error'); return; }
    if (!/^\d+$/.test(v)) { notify('User ID must be numeric (e.g. 14039549)', 'error'); return; }
    cuid = v;
    const card = document.getElementById('profile-card');
    card.classList.remove('visible');
    document.getElementById('profile-name').textContent = 'User #' + v;
    document.getElementById('profile-avatar').src = 'https://a.ppy.sh/' + v;
    document.getElementById('profile-meta').innerHTML =
        '<span>id: ' + v + '</span>' +
        '<a href="https://osu.ppy.sh/users/' + v + '" target="_blank" style="color:var(--g5);text-decoration:underline;">→ osu! profile</a>';
    document.getElementById('reviews-body').innerHTML = '<div class="reviews-empty"><span class="spinner"></span></div>';
    void card.offsetWidth; // force reflow before re-adding visible
    card.classList.add('visible');
    updateWritePanel();
    await loadReviews(v);
}

async function loadReviews(uid) {
    const body = document.getElementById('reviews-body');
    body.innerHTML = '<div class="reviews-empty"><span class="spinner"></span></div>';
    try {
        const r = await fetch('/reviews/' + uid);
        if (!r.ok) { body.innerHTML = '<div class="reviews-empty"><div class="empty-icon">!</div><div>Server error ' + r.status + '</div></div>'; return; }
        const revs = await r.json();
        if (!Array.isArray(revs) || !revs.length) {
            body.innerHTML = '<div class="reviews-empty"><div class="empty-icon">◇</div><div>No reviews yet.</div></div>';
            return;
        }
        body.innerHTML = '';
        revs.slice().reverse().forEach((rv, i) => {
            const mine = usr && String(usr.userId) === String(rv.authorUserId);
            const el = document.createElement('div');
            el.className = 'review-item';
            el.style.animationDelay = (i * .05) + 's';
            el.innerHTML =
                '<div class="review-top">' +
                    '<div class="review-author">' +
                        '<img class="review-avatar" src="https://a.ppy.sh/' + H(rv.authorUserId) + '" alt="">' +
                        '<div>' +
                            '<a class="review-name" href="https://osu.ppy.sh/users/' + H(rv.authorUserId) + '" target="_blank">' + H(rv.authorUsername) + '</a>' +
                            '<div class="review-date">' + fmtDate(rv.createdAt) + (rv.updatedAt ? ' · edited' : '') + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="stars">' + starsHtml(rv.stars) + '</div>' +
                '</div>' +
                '<div class="review-text">' + H(rv.text) + '</div>' +
                (mine ?
                    '<div class="review-actions">' +
                        '<button class="btn btn-edit" onclick="openEdit(\'' + rv.id + '\',\'' + uid + '\',' + rv.stars + ',' + JSON.stringify(rv.text) + ',true)">Edit</button>' +
                        '<button class="btn btn-danger" onclick="deleteReview(\'' + uid + '\',\'' + rv.id + '\')">Delete</button>' +
                    '</div>' +
                    '<div class="edit-form" id="pef-' + rv.id + '">' +
                        '<div class="edit-stars" id="pest-' + rv.id + '">' +
                            [1,2,3,4,5].map(n => '<button class="edit-star" data-s="' + n + '" onclick="setES(\'' + rv.id + '\',' + n + ',true)">★</button>').join('') +
                        '</div>' +
                        '<textarea class="edit-textarea" id="peta-' + rv.id + '" maxlength="300">' + H(rv.text) + '</textarea>' +
                        '<div class="edit-row">' +
                            '<button class="btn btn-primary btn-sm" onclick="saveEdit(\'' + rv.id + '\',\'' + uid + '\',true)">Save</button>' +
                            '<button class="btn btn-ghost btn-sm" onclick="closeEdit(\'' + rv.id + '\',true)">Cancel</button>' +
                        '</div>' +
                        '<div class="edit-err" id="pee-' + rv.id + '"></div>' +
                    '</div>'
                : '');
            body.appendChild(el);
        });
    } catch {
        body.innerHTML = '<div class="reviews-empty"><div class="empty-icon">!</div><div>Failed to load.</div></div>';
    }
}

// ── Write review ─────────────────────────────────────────────────────────────
function updateWritePanel() {
    const panel  = document.getElementById('write-panel');
    const prompt = document.getElementById('login-prompt');
    if (!cuid) { panel.classList.add('hidden'); prompt.classList.add('hidden'); return; }
    if (!usr)  { panel.classList.add('hidden'); prompt.classList.remove('hidden'); return; }
    if (String(usr.userId) === String(cuid)) { panel.classList.add('hidden'); prompt.classList.add('hidden'); return; }
    panel.classList.remove('hidden'); prompt.classList.add('hidden');
}

function setStar(n) {
    selStar = n;
    document.querySelectorAll('.write-star').forEach(b => b.classList.toggle('on', +b.dataset.s <= n));
    validateSubmit();
}

document.getElementById('write-stars').addEventListener('mouseover', e => {
    const b = e.target.closest('.write-star');
    if (!b) return;
    document.querySelectorAll('.write-star').forEach(x => x.classList.toggle('on', +x.dataset.s <= +b.dataset.s));
});
document.getElementById('write-stars').addEventListener('mouseleave', () => {
    document.querySelectorAll('.write-star').forEach(b => b.classList.toggle('on', +b.dataset.s <= selStar));
});

function onTAInput() {
    const ta = document.getElementById('write-ta');
    document.getElementById('write-char').textContent = ta.value.length + ' / 300';
    validateSubmit();
}

function validateSubmit() {
    const ta = document.getElementById('write-ta');
    document.getElementById('submit-btn').disabled = !(ta.value.trim().length >= 5 && selStar > 0);
}

async function submitReview() {
    if (!tok || !cuid) return;
    const text  = document.getElementById('write-ta').value.trim();
    const errEl = document.getElementById('write-err');
    const btn   = document.getElementById('submit-btn');
    errEl.textContent = '';
    if (!text || !selStar) return;
    btn.innerHTML = '<span class="spinner"></span>Submitting…'; btn.disabled = true;
    try {
        const r = await fetch('/reviews', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
            body: JSON.stringify({ targetUserId: cuid, stars: selStar, text })
        });
        const d = await r.json();
        if (r.ok) {
            document.getElementById('write-ta').value = '';
            document.getElementById('write-char').textContent = '0 / 300';
            selStar = 0;
            document.querySelectorAll('.write-star').forEach(b => b.classList.remove('on'));
            notify('✓ Review posted!', 'success');
            await loadReviews(cuid);
            loadDash();
        } else if (r.status === 401) {
            tok = null; usr = null; localStorage.removeItem('osu_tok');
            renderLoggedOut();
            errEl.textContent = '✗ Session expired — please log in again';
        } else {
            errEl.textContent = '✗ ' + (d.error || 'Server error');
        }
    } catch {
        errEl.textContent = '✗ Could not reach server';
    } finally {
        btn.innerHTML = 'Submit review';
        validateSubmit();
    }
}

// ── Utilities ────────────────────────────────────────────────────────────────
function fmtDate(d) {
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.getElementById('player-input').addEventListener('keydown', e => { if (e.key === 'Enter') searchPlayer(); });
verifySession();
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

        // ── Auth ──────────────────────────────────────────────────────────────

        if (method === 'GET' && pathname === '/auth/login') {
            if (!OSU_CLIENT_ID || !REDIRECT_URI) { err(res, 503, 'OAuth not configured'); return; }
            const p = new URLSearchParams({ client_id: OSU_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'identify' });
            json(res, 200, { url: 'https://osu.ppy.sh/oauth/authorize?' + p });
            return;
        }

        if (method === 'GET' && pathname === '/auth/callback') {
            const code  = url.searchParams.get('code');
            const error = url.searchParams.get('error');
            if (error || !code) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end('<html><body><script>window.opener&&window.opener.postMessage({type:"osu-auth-error",error:"' + escapeHtml(error || 'no code') + '"},"*");window.close();<\/script></body></html>');
                return;
            }
            try {
                const tokens  = await exchangeCode(code);
                if (!tokens.access_token) throw new Error('No access token');
                const osuUser = await osuApiGet('me', tokens.access_token);
                if (!osuUser || !osuUser.id) throw new Error('Could not fetch osu! user');
                const st = makeSessionToken();
                sessions.set(st, {
                    userId:    osuUser.id,
                    username:  osuUser.username,
                    avatarUrl: osuUser.avatar_url || null,
                    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
                });
                console.log('Login: ' + osuUser.username + ' (' + osuUser.id + ')');
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<!DOCTYPE html><html><head><style>body{background:#0a0a0a;color:#f5f5f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;}</style></head><body>' +
                    '<p>✓ Logged in as <strong style="color:#4ade80">' + escapeHtml(osuUser.username) + '</strong></p>' +
                    '<p style="font-size:12px;opacity:.5">Closing…</p>' +
                    '<script>window.opener&&window.opener.postMessage({type:"osu-auth-success",token:"' + st + '",userId:' + osuUser.id + ',username:"' + escapeHtml(osuUser.username) + '",avatarUrl:"' + escapeHtml(osuUser.avatar_url || '') + '"},"*");setTimeout(function(){window.close();},1000);<\/script>' +
                    '</body></html>');
            } catch (e) {
                console.error('Auth error:', e.message);
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end('<html><body><script>window.opener&&window.opener.postMessage({type:"osu-auth-error",error:"' + escapeHtml(e.message) + '"},"*");window.close();<\/script><p>Error: ' + escapeHtml(e.message) + '</p></body></html>');
            }
            return;
        }

        if (method === 'GET' && pathname === '/auth/me') {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Not logged in'); return; }
            json(res, 200, { success: true, data: { userId: s.userId, username: s.username, avatarUrl: s.avatarUrl, isAdmin: isAdmin(s) } });
            return;
        }

        if (method === 'POST' && pathname === '/auth/logout') {
            const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
            if (auth) sessions.delete(auth);
            json(res, 200, { ok: true });
            return;
        }

        // ── Admin ─────────────────────────────────────────────────────────────

        if (method === 'GET' && pathname === '/admin/reviews') {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Not logged in'); return; }
            if (isAdmin(s)) { json(res, 200, { success: true, data: reviews }); return; }
            const mine = {};
            Object.entries(reviews).forEach(([uid, revs]) => {
                const f = revs.filter(r => String(r.authorUserId) === String(s.userId));
                if (f.length) mine[uid] = f;
            });
            json(res, 200, { success: true, data: mine });
            return;
        }

        // ── Notes ─────────────────────────────────────────────────────────────

        if (method === 'GET' && pathname === '/notes') {
            const id = url.searchParams.get('beatmapsetId');
            if (!id) { err(res, 400, 'beatmapsetId required'); return; }
            setCORS(res); res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mem.notes.filter(n => n.beatmapsetId === id)));
            return;
        }

        if (method === 'POST' && pathname === '/notes') {
            const d = await parseBody(req);
            if (!d.beatmapsetId || !d.text) { err(res, 400, 'beatmapsetId and text required'); return; }
            const note = { id: d.id || 'note_' + uid(), time: d.time || '00:00:000', author: d.author || 'Anonymous', text: d.text.trim(), beatmapsetId: d.beatmapsetId, resolved: d.resolved || false, created: d.created || Date.now(), reactions: [], replies: [] };
            mem.notes.push(note);
            mem.history.push({ type: 'note', author: note.author, beatmapsetId: note.beatmapsetId, timestamp: note.created, preview: note.text.slice(0, 100) });
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
            note.replies.push(reply);
            mem.history.push({ type: 'reply', author: username, beatmapsetId: beatmapsetId || note.beatmapsetId, timestamp: reply.timestamp, preview: text.slice(0, 100) });
            ok(res, note); return;
        }

        if (method === 'DELETE' && pathname.startsWith('/notes/')) {
            const noteId = pathname.split('/')[2];
            const idx = mem.notes.findIndex(n => n.id === noteId || String(n.created) === noteId);
            if (idx === -1) { err(res, 404, 'Note not found'); return; }
            mem.notes.splice(idx, 1); ok(res, { deleted: true }); return;
        }

        // ── Chat ──────────────────────────────────────────────────────────────

        if (method === 'GET' && pathname === '/chat') {
            const id = url.searchParams.get('beatmapsetId');
            if (!id) { err(res, 400, 'beatmapsetId required'); return; }
            ok(res, mem.chat.filter(m => m.beatmapsetId === id).slice(-100)); return;
        }

        if (method === 'POST' && pathname === '/chat') {
            const d = await parseBody(req);
            if (!d.beatmapsetId || !d.text || !d.author) { err(res, 400, 'beatmapsetId, text, author required'); return; }
            const msg = { id: 'msg_' + uid(), author: d.author, text: d.text.trim(), beatmapsetId: d.beatmapsetId, timestamp: d.timestamp || Date.now() };
            mem.chat.push(msg);
            mem.history.push({ type: 'chat', author: msg.author, beatmapsetId: msg.beatmapsetId, timestamp: msg.timestamp, preview: msg.text.slice(0, 100) });
            ok(res, msg); return;
        }

        // ── Users ─────────────────────────────────────────────────────────────

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

        // ── History ───────────────────────────────────────────────────────────

        if (method === 'GET' && pathname === '/session/history') {
            const id = url.searchParams.get('beatmapsetId'), limit = parseInt(url.searchParams.get('limit')) || 50;
            let h = id ? mem.history.filter(e => e.beatmapsetId === id) : mem.history;
            ok(res, h.slice(-limit)); return;
        }

        // ── Reviews ───────────────────────────────────────────────────────────

        if (method === 'GET' && /^\/reviews\/\d{1,10}$/.test(pathname)) {
            json(res, 200, reviews[pathname.split('/')[2]] || []); return;
        }

        if (method === 'POST' && pathname === '/reviews') {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Must be logged in to post reviews'); return; }
            const d     = await parseBody(req);
            const text  = (d.text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
            const tuid  = String(d.targetUserId || '');
            const stars = Number(d.stars);
            if (!tuid || !/^\d{1,10}$/.test(tuid))            { err(res, 400, 'Invalid targetUserId'); return; }
            if (!Number.isInteger(stars) || stars < 1 || stars > 5) { err(res, 400, 'stars must be 1–5'); return; }
            if (text.length < 5)                               { err(res, 400, 'Review too short (min 5 chars)'); return; }
            if (text.length > 300)                             { err(res, 400, 'Review too long (max 300 chars)'); return; }
            if (String(s.userId) === tuid)                     { err(res, 400, 'Cannot review yourself'); return; }
            if (containsProfanity(text))                       { err(res, 400, 'Review contains prohibited language. Please keep it respectful.'); return; }
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
            const parts = pathname.split('/');
            const uid2  = parts[2], rid = parts[3];
            if (!reviews[uid2]) { err(res, 404, 'No reviews for that user'); return; }
            const review = reviews[uid2].find(r => r.id === rid);
            if (!review) { err(res, 404, 'Review not found'); return; }
            if (String(review.authorUserId) !== String(s.userId) && !isAdmin(s)) { err(res, 403, 'Can only edit your own reviews'); return; }
            const d     = await parseBody(req);
            const text  = (d.text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
            const stars = Number(d.stars);
            if (text && text.length < 5)                         { err(res, 400, 'Too short'); return; }
            if (text && text.length > 300)                       { err(res, 400, 'Too long'); return; }
            if (text && containsProfanity(text))                 { err(res, 400, 'Review contains prohibited language.'); return; }
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
            const parts = pathname.split('/');
            const uid2  = parts[2], rid = parts[3];
            if (!reviews[uid2]) { err(res, 404, 'No reviews for that user'); return; }
            const review = reviews[uid2].find(r => r.id === rid);
            if (!review) { err(res, 404, 'Review not found'); return; }
            if (String(review.authorUserId) !== String(s.userId) && !isAdmin(s)) { err(res, 403, 'Can only delete your own reviews'); return; }
            reviews[uid2] = reviews[uid2].filter(r => r.id !== rid);
            saveReviewsToGitHub();
            json(res, 200, { ok: true }); return;
        }

        // ── Health / Stats / Root ─────────────────────────────────────────────

        if (method === 'GET' && pathname === '/health') {
            ok(res, { status: 'healthy', uptime: process.uptime(), memory: process.memoryUsage(), version: '2.5.0' }); return;
        }

        if (method === 'GET' && pathname === '/stats') {
            const total = Object.values(reviews).reduce((a, b) => a + b.length, 0);
            ok(res, { uptime: Math.floor(process.uptime()), notes: mem.notes.length, chat: mem.chat.length, users: mem.users.filter(u => Date.now() - u.timestamp < 30000).length, reviews: total, sessions: sessions.size, storage: GITHUB_TOKEN ? 'github (' + GITHUB_REPO + ')' : 'memory-only' }); return;
        }

        if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

        if (method === 'GET' && pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(buildHomePage());
            return;
        }

        err(res, 404, 'Endpoint ' + pathname + ' not found');

    } catch (e) {
        console.error('Error:', e.message);
        err(res, 500, 'Server error: ' + e.message);
    }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
loadReviewsFromGitHub().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log('='.repeat(60));
        console.log('osu! Collab Server v2.5.0');
        console.log('http://0.0.0.0:' + PORT);
        console.log('Reviews: ' + (GITHUB_TOKEN ? 'GitHub → ' + GITHUB_REPO : 'IN-MEMORY ONLY'));
        console.log('OAuth:   ' + (OSU_CLIENT_ID ? 'Configured' : 'NOT CONFIGURED'));
        console.log('Admin:   ' + ADMIN_USERNAME);
        console.log('='.repeat(60));
    });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
process.on('uncaughtException',  e => { console.error('Uncaught:', e); process.exit(1); });
process.on('unhandledRejection', e => console.error('Unhandled:', e));
