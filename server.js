// osu! Collab Server v2.6.0
// Reviews → persisted to GitHub
// Notes/chat/users/history → in-memory
//
// Required env vars on Render:
//   GITHUB_TOKEN      — Personal Access Token with "repo" scope
//   GITHUB_REPO       — e.g. "yourusername/osu-reviews-data"
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
const OSU_CLIENT_ID     = process.env.OSU_CLIENT_ID     || '';
const OSU_CLIENT_SECRET = process.env.OSU_CLIENT_SECRET || '';
const REDIRECT_URI      = process.env.REDIRECT_URI      || '';
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
    return BLOCKED_WORDS.some(function(w) {
        return new RegExp('(?<![a-z])' + w + '(?![a-z])', 'i').test(lower);
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
function exchangeCode(code) {
    return new Promise(function(resolve, reject) {
        const payload = JSON.stringify({
            client_id: parseInt(OSU_CLIENT_ID, 10),
            client_secret: OSU_CLIENT_SECRET.trim(),
            code: code,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI.trim(),
        });
        const req = https.request({
            hostname: 'osu.ppy.sh',
            path: '/oauth/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'User-Agent': 'osu-collab-server',
            },
        }, function(res) {
            let data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() {
                try { resolve(JSON.parse(data)); }
                catch(e) { reject(new Error('Invalid JSON')); }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function osuApiGet(path, token) {
    return new Promise(function(resolve, reject) {
        const req = https.request({
            hostname: 'osu.ppy.sh',
            path: '/api/v2/' + path,
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/json',
                'User-Agent': 'osu-collab-server',
            },
        }, function(res) {
            let data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() {
                try { resolve(JSON.parse(data)); }
                catch(e) { reject(new Error('Invalid JSON')); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ─── GitHub storage ───────────────────────────────────────────────────────────
let reviews = {}, reviewsSHA = null, reviewsDirty = false, saveInFlight = false;

function githubRequest(method, path, body) {
    return new Promise(function(resolve, reject) {
        const payload = body ? JSON.stringify(body) : null;
        const headers = {
            'Authorization': 'token ' + GITHUB_TOKEN,
            'User-Agent': 'osu-collab-server',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
        };
        if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
        const req = https.request({
            hostname: 'api.github.com',
            path: path,
            method: method,
            headers: headers,
        }, function(res) {
            let data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch(e) { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function loadReviewsFromGitHub() {
    if (!GITHUB_TOKEN || !GITHUB_REPO) return Promise.resolve();
    return githubRequest('GET', '/repos/' + GITHUB_REPO + '/contents/reviews.json')
        .then(function(r) {
            if (r.status === 200) {
                reviews = JSON.parse(Buffer.from(r.body.content, 'base64').toString('utf8'));
                reviewsSHA = r.body.sha;
                const total = Object.values(reviews).reduce(function(a, b) { return a + b.length; }, 0);
                console.log('Loaded ' + total + ' reviews from GitHub');
            } else if (r.status !== 404) {
                console.warn('GitHub load failed:', r.status);
            }
        })
        .catch(function(e) { console.error('GitHub load error:', e.message); });
}

function saveReviewsToGitHub() {
    if (!GITHUB_TOKEN || !GITHUB_REPO) return;
    if (saveInFlight) { reviewsDirty = true; return; }
    saveInFlight = true;
    reviewsDirty = false;
    const content = Buffer.from(JSON.stringify(reviews, null, 2)).toString('base64');
    const body = { message: 'update reviews ' + new Date().toISOString(), content: content };
    if (reviewsSHA) body.sha = reviewsSHA;
    githubRequest('PUT', '/repos/' + GITHUB_REPO + '/contents/reviews.json', body)
        .then(function(r) {
            if (r.status === 200 || r.status === 201) {
                reviewsSHA = r.body.content.sha;
                console.log('Reviews saved to GitHub');
            } else {
                console.warn('GitHub save failed:', r.status);
            }
        })
        .catch(function(e) { console.error('GitHub save error:', e.message); })
        .then(function() {
            saveInFlight = false;
            if (reviewsDirty) saveReviewsToGitHub();
        });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseBody(req) {
    return new Promise(function(resolve, reject) {
        let body = '';
        req.on('data', function(c) { body += c; });
        req.on('end', function() {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch(e) { reject(new Error('Invalid JSON')); }
        });
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
function ok(res, data) { json(res, 200, { success: true, data: data, timestamp: Date.now() }); }
function err(res, status, msg) { json(res, status, { error: msg, timestamp: Date.now() }); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// ─── Cleanup ──────────────────────────────────────────────────────────────────
setInterval(function() {
    const now = Date.now();
    mem.users = mem.users.filter(function(u) { return now - u.timestamp < 30000; });
    mem.chat  = mem.chat.filter(function(m) { return now - m.timestamp < 7 * 86400000; });
    if (mem.history.length > 1000) mem.history = mem.history.slice(-1000);
    sessions.forEach(function(s, t) { if (s.expiresAt < now) sessions.delete(t); });
}, 60000);

// ─── Frontend ─────────────────────────────────────────────────────────────────
function buildHomePage() {
    const totalReviews = Object.values(reviews).reduce(function(a, b) { return a + b.length; }, 0);
    const uptime = Math.floor(process.uptime());
    const uptimeStr = uptime < 60 ? uptime + 's'
        : uptime < 3600 ? Math.floor(uptime/60) + 'm ' + (uptime%60) + 's'
        : Math.floor(uptime/3600) + 'h ' + Math.floor((uptime%3600)/60) + 'm';
    const storageOk = GITHUB_TOKEN ? '\u2713' : '\u2014';
    const sessCount = sessions.size;

    const starBtns = [1,2,3,4,5].map(function(i) {
        return '<button class="write-star" data-s="' + i + '" onclick="setStar(' + i + ')">\u2605</button>';
    }).join('');

    const css = '' +
        '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }' +
        ':root {' +
        '    --black: #0a0a0a; --white: #f5f5f0;' +
        '    --g1: #1a1a1a; --g2: #2a2a2a; --g3: #444; --g4: #888; --g5: #bbb;' +
        '    --line: rgba(255,255,255,0.08); --line-hi: rgba(255,255,255,0.18);' +
        '    --fd: \'Instrument Serif\', serif; --fu: \'Syne\', sans-serif; --fm: \'DM Mono\', monospace;' +
        '    --ease: cubic-bezier(0.16,1,0.3,1);' +
        '}' +
        'html { scroll-behavior: smooth; }' +
        'body { background: var(--black); color: var(--white); font-family: var(--fu); min-height: 100vh; overflow-x: hidden; }' +
        '#cur { position: fixed; top: 0; left: 0; width: 10px; height: 10px; background: var(--white); border-radius: 50%; pointer-events: none; z-index: 99999; transform: translate(-50%,-50%); transition: width .15s var(--ease), height .15s var(--ease); mix-blend-mode: difference; }' +
        '#cur-ring { position: fixed; top: 0; left: 0; width: 34px; height: 34px; border: 1px solid rgba(255,255,255,0.4); border-radius: 50%; pointer-events: none; z-index: 99998; transform: translate(-50%,-50%); }' +
        'body::before { content: \'\'; position: fixed; inset: 0; background-image: url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.85\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\'/%3E%3C/svg%3E"); opacity: .025; pointer-events: none; z-index: 0; }' +
        '.gbg { position: fixed; inset: 0; pointer-events: none; z-index: 0; background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px); background-size: 80px 80px; mask-image: radial-gradient(ellipse 80% 80% at 50% 0%, black 0%, transparent 80%); }' +
        '.wrap { position: relative; z-index: 1; max-width: 1100px; margin: 0 auto; padding: 0 40px; }' +
        'header { position: sticky; top: 0; z-index: 100; padding: 20px 0; border-bottom: 1px solid var(--line); background: rgba(10,10,10,0.85); backdrop-filter: blur(12px); }' +
        '.hd { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; }' +
        '.logo { font-family: var(--fd); font-size: 20px; display: flex; align-items: center; gap: 10px; color: var(--white); }' +
        '.ldot { width: 8px; height: 8px; background: var(--white); border-radius: 50%; animation: pulse 2s ease infinite; }' +
        '@keyframes pulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.5);opacity:.5} }' +
        'nav { display: flex; gap: 6px; flex-wrap: wrap; }' +
        'nav a { font-family: var(--fm); font-size: 11px; color: var(--g4); text-decoration: none; padding: 5px 12px; border-radius: 20px; border: 1px solid transparent; transition: all .2s; letter-spacing: .3px; }' +
        'nav a:hover { color: var(--white); border-color: var(--line-hi); }' +
        '.hstatus { font-family: var(--fm); font-size: 11px; color: var(--g4); display: flex; align-items: center; gap: 14px; }' +
        '.sdot { width: 6px; height: 6px; background: #4ade80; border-radius: 50%; display: inline-block; margin-right: 5px; animation: pulse 2s ease infinite; }' +
        '.eyebrow { font-family: var(--fm); font-size: 11px; letter-spacing: 2px; color: var(--g4); text-transform: uppercase; margin-bottom: 20px; opacity: 0; animation: fadeUp .8s var(--ease) .1s forwards; }' +
        'h1 { font-family: var(--fd); font-size: clamp(52px,7vw,92px); line-height: .93; letter-spacing: -2px; margin-bottom: 28px; opacity: 0; animation: fadeUp .8s var(--ease) .2s forwards; }' +
        'h1 em { font-style: italic; color: var(--g5); }' +
        '.hero-sub { font-size: 14px; color: var(--g4); max-width: 460px; line-height: 1.75; margin-bottom: 52px; opacity: 0; animation: fadeUp .8s var(--ease) .3s forwards; }' +
        '.stats { display: flex; gap: 1px; border: 1px solid var(--line-hi); border-radius: 12px; overflow: hidden; max-width: 540px; opacity: 0; animation: fadeUp .8s var(--ease) .4s forwards; }' +
        '.stat { flex: 1; padding: 18px 22px; background: rgba(255,255,255,.02); border-right: 1px solid var(--line); transition: background .2s; }' +
        '.stat:last-child { border-right: none; }' +
        '.stat:hover { background: rgba(255,255,255,.05); }' +
        '.stat-n { font-family: var(--fd); font-size: 34px; line-height: 1; margin-bottom: 3px; }' +
        '.stat-l { font-family: var(--fm); font-size: 10px; letter-spacing: 1.5px; color: var(--g4); text-transform: uppercase; }' +
        '.hero-circ { position: absolute; right: 20px; top: 30px; width: 280px; height: 280px; border: 1px solid var(--line-hi); border-radius: 50%; opacity: 0; animation: fadeIn 1.2s var(--ease) .5s forwards, spin 40s linear infinite; pointer-events: none; }' +
        '.hero-circ::before { content: \'\'; position: absolute; top: 28px; left: 28px; right: 28px; bottom: 28px; border: 1px solid var(--line); border-radius: 50%; }' +
        '.hero-circ::after { content: \'\'; position: absolute; top: 50%; left: -4px; width: 8px; height: 8px; background: var(--white); border-radius: 50%; transform: translateY(-50%); }' +
        '@keyframes spin { to { transform: rotate(360deg); } }' +
        '.sec { padding: 90px 0; border-top: 1px solid var(--line); scroll-margin-top: 80px; }' +
        '.sec-label { font-family: var(--fm); font-size: 10px; letter-spacing: 2px; color: var(--g4); text-transform: uppercase; margin-bottom: 40px; display: flex; align-items: center; gap: 14px; }' +
        '.sec-label::after { content: \'\'; flex: 1; height: 1px; background: var(--line); }' +
        '.login-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; border: 1px solid var(--line-hi); border-radius: 16px; overflow: hidden; max-width: 760px; }' +
        '.login-info { padding: 44px; background: rgba(255,255,255,.02); }' +
        '.login-info h2 { font-family: var(--fd); font-size: 30px; line-height: 1.1; margin-bottom: 14px; letter-spacing: -.4px; }' +
        '.login-info p { font-size: 13px; color: var(--g4); line-height: 1.75; margin-bottom: 28px; }' +
        '.feat-list { list-style: none; display: flex; flex-direction: column; gap: 9px; }' +
        '.feat-list li { font-size: 12px; color: var(--g5); display: flex; align-items: center; gap: 9px; font-family: var(--fm); }' +
        '.feat-list li::before { content: \'\u2192\'; color: var(--g3); }' +
        '.login-action { padding: 44px; background: rgba(255,255,255,.03); display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; gap: 14px; min-height: 280px; }' +
        '.av-wrap { width: 76px; height: 76px; border-radius: 50%; border: 1px solid var(--line-hi); background: var(--g1); display: flex; align-items: center; justify-content: center; font-size: 26px; overflow: hidden; transition: all .3s; margin: 0 auto; }' +
        '.av-wrap img { width: 100%; height: 100%; object-fit: cover; display: none; }' +
        '.av-wrap.loaded img { display: block; }' +
        '.av-wrap.loaded .av-icon { display: none; }' +
        '.btn { display: inline-flex; align-items: center; gap: 7px; padding: 11px 26px; border-radius: 8px; font-family: var(--fu); font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: all .2s var(--ease); text-decoration: none; }' +
        '.btn-primary { background: var(--white); color: var(--black); }' +
        '.btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(255,255,255,.14); }' +
        '.btn-primary:disabled { opacity: .4; transform: none; cursor: default; box-shadow: none; }' +
        '.btn-ghost { background: transparent; color: var(--white); border: 1px solid var(--line-hi); }' +
        '.btn-ghost:hover { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.3); }' +
        '.btn-danger { background: transparent; color: #ff6b6b; border: 1px solid rgba(255,107,107,.3); font-size: 12px; padding: 6px 14px; }' +
        '.btn-danger:hover { background: rgba(255,107,107,.08); }' +
        '.btn-sm { padding: 7px 16px; font-size: 12px; }' +
        '.btn-edit { background: transparent; color: var(--g4); border: 1px solid var(--line); font-size: 11px; padding: 5px 12px; }' +
        '.btn-edit:hover { color: var(--white); border-color: var(--line-hi); }' +
        '.search-row { display: flex; gap: 10px; margin-bottom: 36px; max-width: 600px; }' +
        '.search-input { flex: 1; padding: 11px 15px; background: rgba(255,255,255,.04); border: 1px solid var(--line-hi); border-radius: 8px; color: var(--white); font-family: var(--fu); font-size: 13px; outline: none; transition: all .2s; }' +
        '.search-input::placeholder { color: var(--g3); }' +
        '.search-input:focus { border-color: rgba(255,255,255,.32); background: rgba(255,255,255,.06); }' +
        '.profile-card { border: 1px solid var(--line-hi); border-radius: 16px; overflow: hidden; max-width: 800px; opacity: 0; transform: translateY(14px); transition: all .4s var(--ease); }' +
        '.profile-card.visible { opacity: 1; transform: translateY(0); }' +
        '.profile-header { padding: 36px 44px; background: rgba(255,255,255,.03); display: flex; align-items: center; gap: 24px; border-bottom: 1px solid var(--line); position: relative; overflow: hidden; }' +
        '.profile-header::before { content: \'\'; position: absolute; inset: 0; background: radial-gradient(ellipse 60% 80% at 0% 50%, rgba(255,255,255,.03) 0%, transparent 70%); pointer-events: none; }' +
        '.profile-avatar { width: 84px; height: 84px; border-radius: 50%; border: 2px solid var(--line-hi); object-fit: cover; flex-shrink: 0; }' +
        '.profile-info h3 { font-family: var(--fd); font-size: 26px; letter-spacing: -.4px; margin-bottom: 5px; }' +
        '.profile-meta { font-family: var(--fm); font-size: 11px; color: var(--g4); display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }' +
        '.profile-meta a { color: var(--g4); text-decoration: none; }' +
        '.profile-meta a:hover { color: var(--white); }' +
        '.reviews-body { padding: 28px 44px 36px; }' +
        '.reviews-empty { text-align: center; padding: 44px 20px; color: var(--g4); font-family: var(--fm); font-size: 12px; line-height: 1.9; }' +
        '.empty-icon { font-size: 28px; margin-bottom: 10px; opacity: .35; }' +
        '.review-item { padding: 18px 0; border-bottom: 1px solid var(--line); opacity: 0; animation: fadeUp .4s var(--ease) forwards; }' +
        '.review-item:last-child { border-bottom: none; padding-bottom: 0; }' +
        '.review-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }' +
        '.review-author { display: flex; align-items: center; gap: 10px; }' +
        '.review-avatar { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--line-hi); object-fit: cover; background: var(--g2); flex-shrink: 0; }' +
        '.review-name { font-size: 13px; font-weight: 600; color: var(--white); text-decoration: none; }' +
        '.review-name:hover { text-decoration: underline; }' +
        '.review-date { font-family: var(--fm); font-size: 10px; color: var(--g4); margin-top: 1px; }' +
        '.stars { display: flex; gap: 2px; }' +
        '.star { font-size: 13px; color: var(--g3); }' +
        '.star.on { color: #e8e0a0; }' +
        '.review-text { font-size: 13px; color: var(--g5); line-height: 1.65; padding-left: 40px; }' +
        '.review-actions { padding-left: 40px; margin-top: 9px; display: flex; gap: 7px; flex-wrap: wrap; }' +
        '.flag-badge { font-family: var(--fm); font-size: 10px; color: #f97316; padding: 2px 7px; border: 1px solid rgba(249,115,22,.3); border-radius: 4px; }' +
        '.edit-form { margin-top: 10px; padding-left: 40px; display: none; }' +
        '.edit-form.open { display: block; }' +
        '.edit-stars { display: flex; gap: 4px; margin-bottom: 8px; }' +
        '.edit-star { background: none; border: none; font-size: 18px; color: var(--g3); cursor: pointer; padding: 1px; line-height: 1; transition: all .1s; }' +
        '.edit-star.on { color: #e8e0a0; }' +
        '.edit-textarea { width: 100%; min-height: 68px; resize: vertical; background: rgba(255,255,255,.03); border: 1px solid var(--line-hi); border-radius: 8px; color: var(--white); font-family: var(--fu); font-size: 13px; padding: 9px 13px; outline: none; margin-bottom: 8px; transition: border-color .2s; }' +
        '.edit-textarea:focus { border-color: rgba(255,255,255,.28); }' +
        '.edit-row { display: flex; gap: 7px; }' +
        '.edit-err { font-size: 12px; color: #ff6b6b; margin-top: 6px; font-family: var(--fm); }' +
        '.write-panel { margin-top: 28px; border: 1px solid var(--line-hi); border-radius: 12px; overflow: hidden; max-width: 800px; }' +
        '.write-header { padding: 14px 22px; background: rgba(255,255,255,.03); border-bottom: 1px solid var(--line); font-family: var(--fm); font-size: 10px; letter-spacing: 1.5px; color: var(--g4); text-transform: uppercase; display: flex; justify-content: space-between; }' +
        '.write-body { padding: 22px; }' +
        '.write-stars { display: flex; gap: 5px; margin-bottom: 14px; }' +
        '.write-star { background: none; border: none; font-size: 22px; color: var(--g3); cursor: pointer; padding: 2px; transition: all .1s; line-height: 1; }' +
        '.write-star.on { color: #e8e0a0; transform: scale(1.08); }' +
        '.write-star:hover { transform: scale(1.18); }' +
        '.write-textarea { width: 100%; min-height: 80px; resize: vertical; background: rgba(255,255,255,.03); border: 1px solid var(--line-hi); border-radius: 8px; color: var(--white); font-family: var(--fu); font-size: 13px; line-height: 1.6; padding: 11px 15px; outline: none; margin-bottom: 11px; transition: border-color .2s; }' +
        '.write-textarea:focus { border-color: rgba(255,255,255,.28); }' +
        '.write-textarea::placeholder { color: var(--g3); }' +
        '.write-footer { display: flex; justify-content: space-between; align-items: center; }' +
        '.write-char { font-family: var(--fm); font-size: 11px; color: var(--g4); }' +
        '.write-err { font-size: 12px; color: #ff6b6b; margin-top: 7px; font-family: var(--fm); }' +
        '.dash-empty { font-family: var(--fm); font-size: 13px; color: var(--g4); padding: 40px 0; text-align: center; }' +
        '.dash-list { max-width: 800px; border: 1px solid var(--line-hi); border-radius: 12px; overflow: hidden; }' +
        '.dash-item { padding: 18px 22px; border-bottom: 1px solid var(--line); opacity: 0; animation: fadeUp .4s var(--ease) forwards; }' +
        '.dash-item:last-child { border-bottom: none; }' +
        '.dash-item-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; }' +
        '.dash-item-meta { font-family: var(--fm); font-size: 11px; color: var(--g4); }' +
        '.dash-item-meta a { color: var(--g5); text-decoration: none; }' +
        '.dash-item-meta a:hover { text-decoration: underline; }' +
        '.dash-item-text { font-size: 13px; color: var(--g5); line-height: 1.65; margin-bottom: 10px; }' +
        '.dash-item-date { font-family: var(--fm); font-size: 10px; color: var(--g4); margin-bottom: 10px; }' +
        '.dash-item-actions { display: flex; gap: 7px; }' +
        '.admin-panel { border: 1px solid rgba(255,255,255,.14); border-radius: 16px; overflow: hidden; max-width: 960px; }' +
        '.admin-head { padding: 22px 28px; background: rgba(255,255,255,.04); border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 10px; }' +
        '.admin-badge { font-family: var(--fm); font-size: 10px; letter-spacing: 1px; padding: 3px 9px; border-radius: 3px; background: var(--white); color: var(--black); font-weight: 600; }' +
        '.admin-head h2 { font-family: var(--fd); font-size: 20px; }' +
        '.admin-filters { padding: 18px 28px; background: rgba(255,255,255,.02); border-bottom: 1px solid var(--line); display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }' +
        '.filter-input { padding: 7px 13px; background: rgba(255,255,255,.04); border: 1px solid var(--line-hi); border-radius: 6px; color: var(--white); font-family: var(--fm); font-size: 12px; outline: none; width: 220px; }' +
        '.filter-input::placeholder { color: var(--g3); }' +
        '.filter-input:focus { border-color: rgba(255,255,255,.28); }' +
        '.filter-chip { padding: 5px 13px; border-radius: 18px; border: 1px solid var(--line); font-family: var(--fm); font-size: 11px; cursor: pointer; background: transparent; color: var(--g4); transition: all .15s; }' +
        '.filter-chip.on { background: var(--white); color: var(--black); border-color: var(--white); }' +
        '.filter-chip:hover:not(.on) { border-color: var(--line-hi); color: var(--white); }' +
        '.admin-stats { padding: 14px 28px; background: rgba(255,255,255,.02); border-bottom: 1px solid var(--line); display: flex; gap: 28px; font-family: var(--fm); font-size: 11px; color: var(--g4); }' +
        '.admin-stats span { color: var(--white); font-weight: 500; }' +
        '.admin-list { max-height: 580px; overflow-y: auto; }' +
        '.admin-item { padding: 18px 28px; border-bottom: 1px solid var(--line); display: flex; gap: 14px; transition: background .15s; }' +
        '.admin-item:hover { background: rgba(255,255,255,.02); }' +
        '.admin-item:last-child { border-bottom: none; }' +
        '.admin-item-body { flex: 1; min-width: 0; }' +
        '.admin-item-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }' +
        '.admin-author { font-size: 12px; font-weight: 600; color: var(--white); font-family: var(--fm); }' +
        '.admin-target { font-size: 11px; color: var(--g4); font-family: var(--fm); }' +
        '.admin-arrow { font-size: 11px; color: var(--g3); }' +
        '.admin-text { font-size: 13px; color: var(--g5); line-height: 1.6; margin-bottom: 6px; }' +
        '.admin-date { font-family: var(--fm); font-size: 10px; color: var(--g4); }' +
        '.admin-actions { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; flex-shrink: 0; }' +
        '.guide-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; border: 1px solid var(--line-hi); border-radius: 12px; overflow: hidden; }' +
        '.guide-item { padding: 30px; background: rgba(255,255,255,.02); transition: background .2s; }' +
        '.guide-item:hover { background: rgba(255,255,255,.04); }' +
        '.guide-num { font-family: var(--fm); font-size: 10px; letter-spacing: 2px; color: var(--g3); margin-bottom: 14px; }' +
        '.guide-title { font-family: var(--fd); font-size: 18px; letter-spacing: -.2px; margin-bottom: 10px; }' +
        '.guide-body { font-size: 13px; color: var(--g4); line-height: 1.85; }' +
        '.guide-row { display: flex; gap: 9px; margin-top: 9px; font-size: 13px; color: var(--g4); }' +
        '.guide-arrow { font-family: var(--fm); font-size: 10px; color: var(--g3); flex-shrink: 0; margin-top: 2px; }' +
        '.guide-body code { font-family: var(--fm); font-size: 11px; background: rgba(255,255,255,.06); padding: 1px 5px; border-radius: 3px; color: var(--g5); }' +
        '.guide-body strong { color: var(--g5); font-weight: 600; }' +
        '.api-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px,1fr)); gap: 1px; border: 1px solid var(--line-hi); border-radius: 12px; overflow: hidden; }' +
        '.api-item { padding: 18px 22px; background: rgba(255,255,255,.02); transition: background .2s; }' +
        '.api-item:hover { background: rgba(255,255,255,.04); }' +
        '.api-method { font-family: var(--fm); font-size: 10px; letter-spacing: 1px; font-weight: 500; margin-bottom: 5px; display: inline-block; padding: 2px 7px; border-radius: 3px; }' +
        '.m-get  { background: rgba(74,222,128,.1);  color: #4ade80; }' +
        '.m-post { background: rgba(147,197,253,.1); color: #93c5fd; }' +
        '.m-put  { background: rgba(251,191,36,.1);  color: #fbbf24; }' +
        '.m-del  { background: rgba(252,165,165,.1); color: #fca5a5; }' +
        '.api-path { font-family: var(--fm); font-size: 13px; color: var(--white); margin-bottom: 3px; }' +
        '.api-desc { font-size: 12px; color: var(--g4); line-height: 1.5; }' +
        'footer { border-top: 1px solid var(--line); padding: 48px 0; margin-top: 80px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; }' +
        '.footer-l { font-family: var(--fm); font-size: 11px; color: var(--g4); }' +
        '.footer-r { display: flex; gap: 20px; font-family: var(--fm); font-size: 11px; }' +
        '.footer-r a { color: var(--g4); text-decoration: none; }' +
        '.footer-r a:hover { color: var(--white); }' +
        '.hidden { display: none !important; }' +
        '.spinner { display: inline-block; width: 13px; height: 13px; border: 2px solid rgba(255,255,255,.1); border-top-color: var(--white); border-radius: 50%; animation: spin .7s linear infinite; vertical-align: middle; margin-right: 5px; }' +
        '.notif { position: fixed; top: 22px; right: 22px; padding: 11px 18px; border-radius: 8px; font-family: var(--fm); font-size: 12px; z-index: 9999; pointer-events: none; animation: slideIn .3s var(--ease); border: 1px solid; }' +
        '@keyframes slideIn { from{opacity:0;transform:translateX(16px)} to{opacity:1;transform:translateX(0)} }' +
        '.notif-success { background: #0a0a0a; border-color: #4ade80; color: #4ade80; }' +
        '.notif-error   { background: #0a0a0a; border-color: #ff6b6b; color: #ff6b6b; }' +
        '.notif-info    { background: #0a0a0a; border-color: #93c5fd; color: #93c5fd; }' +
        '@keyframes fadeUp { from{opacity:0;transform:translateY(18px)} to{opacity:1;transform:translateY(0)} }' +
        '@keyframes fadeIn { from{opacity:0} to{opacity:1} }' +
        '@media (max-width: 700px) {' +
        '    .wrap { padding: 0 20px; }' +
        '    .login-grid { grid-template-columns: 1fr; }' +
        '    h1 { font-size: 44px !important; }' +
        '    .hero-circ { display: none; }' +
        '    .profile-header { flex-direction: column; align-items: flex-start; }' +
        '    .stats { flex-direction: column; }' +
        '    .guide-grid { grid-template-columns: 1fr; }' +
        '    .admin-item { flex-direction: column; }' +
        '}';

    let html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n';
    html += '<meta charset="UTF-8">\n';
    html += '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n';
    html += '<title>osu! Reviews</title>\n';
    html += '<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">\n';
    html += '<style>' + css + '</style>\n</head>\n<body>\n\n';
    html += '<div id="cur"></div>\n<div id="cur-ring"></div>\n<div class="gbg"></div>\n\n';
    html += '<div class="wrap">\n\n';

    html += '<header><div class="hd">';
    html += '<div class="logo"><div class="ldot"></div>osu! reviews</div>';
    html += '<nav><a href="#s-login">Login</a><a href="#s-reviews">Reviews</a><a href="#s-dash">Dashboard</a><a href="#s-guide">Guide</a><a href="#s-api">API</a></nav>';
    html += '<div class="hstatus"><span><span class="sdot"></span>online</span><span>' + uptimeStr + '</span><span>' + totalReviews + ' reviews</span></div>';
    html += '</div></header>\n\n';

    html += '<section class="hero" style="padding:100px 0 90px;position:relative;">';
    html += '<div class="hero-circ"></div>';
    html += '<div class="eyebrow">osu! player reviews</div>';
    html += '<h1>leave your<br><em>mark.</em></h1>';
    html += '<p class="hero-sub">A community review system for osu! players. Log in, find anyone, share your experience.</p>';
    html += '<div class="stats">';
    html += '<div class="stat"><div class="stat-n" id="st-reviews">' + totalReviews + '</div><div class="stat-l">Reviews</div></div>';
    html += '<div class="stat"><div class="stat-n" id="st-sessions">' + sessCount + '</div><div class="stat-l">Sessions</div></div>';
    html += '<div class="stat"><div class="stat-n">' + storageOk + '</div><div class="stat-l">Storage</div></div>';
    html += '</div></section>\n\n';

    html += '<section class="sec" id="s-login"><div class="sec-label">01 \u2014 authentication</div>';
    html += '<div class="login-grid">';
    html += '<div class="login-info"><h2>Connect your osu! account</h2><p>Sign in with osu! OAuth to write, edit and manage reviews.</p>';
    html += '<ul class="feat-list"><li>Write reviews for any player</li><li>Star ratings from 1 to 5</li><li>Edit your reviews anytime</li><li>Delete your own reviews</li><li>Dashboard to track all your reviews</li></ul></div>';
    html += '<div class="login-action">';
    html += '<div id="state-out" style="display:flex;flex-direction:column;align-items:center;gap:14px;">';
    html += '<div class="av-wrap" id="av-out"><span class="av-icon">&#9836;</span><img id="av-out-img" alt=""></div>';
    html += '<div style="display:flex;flex-direction:column;align-items:center;gap:10px;">';
    html += '<p style="font-size:13px;color:var(--g4);">Not logged in.</p>';
    html += '<button class="btn btn-primary" id="login-btn" onclick="doLogin()">Login with osu!</button>';
    html += '<div class="write-err" id="login-err"></div></div></div>';
    html += '<div id="state-in" class="hidden">';
    html += '<div class="av-wrap" id="av-in"><span class="av-icon">&#9836;</span><img id="av-in-img" alt=""></div>';
    html += '<div id="user-name" style="font-family:var(--fd);font-size:22px;margin-top:11px;"></div>';
    html += '<div id="user-id" style="font-family:var(--fm);font-size:11px;color:var(--g4);"></div>';
    html += '<div id="admin-badge" class="hidden" style="font-family:var(--fm);font-size:10px;color:#fbbf24;letter-spacing:1px;margin-top:6px;">ADMIN</div>';
    html += '<button class="btn btn-danger" style="margin-top:14px;" onclick="doLogout()">Log out</button>';
    html += '</div></div></div></section>\n\n';

    html += '<section class="sec" id="s-reviews"><div class="sec-label">02 \u2014 player reviews</div>';
    html += '<div class="search-row"><input type="text" class="search-input" id="player-input" placeholder="Enter osu! user ID\u2026" autocomplete="off"><button class="btn btn-ghost" id="search-btn" onclick="searchPlayer()">Search</button></div>';
    html += '<div class="profile-card" id="profile-card">';
    html += '<div class="profile-header"><img class="profile-avatar" id="profile-avatar" src="" alt=""><div class="profile-info"><h3 id="profile-name"></h3><div class="profile-meta" id="profile-meta"></div></div></div>';
    html += '<div class="reviews-body" id="reviews-body"><div class="reviews-empty"><div class="empty-icon">\u25c7</div><div>No reviews yet.</div></div></div>';
    html += '</div>';
    html += '<div class="write-panel hidden" id="write-panel">';
    html += '<div class="write-header"><span>Write a review</span><span id="write-user" style="color:var(--g5);"></span></div>';
    html += '<div class="write-body"><div class="write-stars" id="write-stars">' + starBtns + '</div>';
    html += '<textarea class="write-textarea" id="write-ta" placeholder="Share your experience with this player\u2026 (be respectful)" maxlength="300" oninput="onTAInput()"></textarea>';
    html += '<div class="write-footer"><button class="btn btn-primary" id="submit-btn" onclick="submitReview()" disabled>Submit review</button><span class="write-char" id="write-char">0 / 300</span></div>';
    html += '<div class="write-err" id="write-err"></div></div></div>';
    html += '<div id="login-prompt" class="hidden" style="margin-top:14px;font-family:var(--fm);font-size:12px;color:var(--g4);">';
    html += '\u2192 <a href="#s-login" style="color:var(--g5);text-decoration:underline;">Log in</a> to write a review.</div>';
    html += '</section>\n\n';

    html += '<section class="sec" id="s-dash"><div class="sec-label">03 \u2014 your dashboard</div>';
    html += '<div id="dash-out" class="dash-empty">\u2192 <a href="#s-login" style="color:var(--g5);text-decoration:underline;">Log in</a> to manage your reviews.</div>';
    html += '<div id="dash-in" class="hidden"><p style="margin-bottom:20px;font-family:var(--fm);font-size:12px;color:var(--g4);">Your reviews \u2014 click Edit to change text or stars.</p><div id="dash-list" class="dash-list"></div></div>';
    html += '</section>\n\n';

    html += '<section class="sec hidden" id="s-admin"><div class="sec-label">04 \u2014 admin panel</div>';
    html += '<div class="admin-panel">';
    html += '<div class="admin-head"><span class="admin-badge">ADMIN</span><h2>All Reviews</h2></div>';
    html += '<div class="admin-filters"><input type="text" class="filter-input" id="admin-search" placeholder="Search text, author, target\u2026" oninput="renderAdmin()">';
    html += '<button class="filter-chip on" onclick="setAdminFilter(\'all\',this)">All</button>';
    html += '<button class="filter-chip" onclick="setAdminFilter(\'flagged\',this)">Flagged</button>';
    html += '<button class="filter-chip" onclick="setAdminFilter(\'1\',this)">1\u2605</button>';
    html += '<button class="filter-chip" onclick="setAdminFilter(\'2\',this)">2\u2605</button>';
    html += '<button class="filter-chip" onclick="setAdminFilter(\'3\',this)">3\u2605</button>';
    html += '<button class="filter-chip" onclick="setAdminFilter(\'4\',this)">4\u2605</button>';
    html += '<button class="filter-chip" onclick="setAdminFilter(\'5\',this)">5\u2605</button></div>';
    html += '<div class="admin-stats"><div>Total: <span id="adm-total">0</span></div><div>Shown: <span id="adm-shown">0</span></div><div>Flagged: <span id="adm-flagged">0</span></div></div>';
    html += '<div class="admin-list" id="admin-list"><div class="reviews-empty" style="padding:40px;"><span class="spinner"></span></div></div>';
    html += '</div></section>\n\n';

    html += '<section class="sec" id="s-guide"><div class="sec-label" id="guide-label">05 \u2014 how to use</div><div class="guide-grid">';
    html += '<div class="guide-item"><div class="guide-num">01 / LOGIN</div><div class="guide-title">Connect your account</div><div class="guide-body">';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Scroll to <strong>Authentication</strong> and click <strong>Login with osu!</strong></div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>A popup opens \u2014 authorise the app on osu! and accept.</div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Popup closes automatically. Sessions last <strong>30 days</strong>.</div>';
    html += '</div></div>';
    html += '<div class="guide-item"><div class="guide-num">02 / SEARCH</div><div class="guide-title">Find a player</div><div class="guide-body">';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Go to <strong>Player Reviews</strong> and enter a numeric osu! <strong>user ID</strong>.</div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Find any ID in their profile URL: <code>osu.ppy.sh/users/[ID]</code></div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Avatar and all existing reviews load instantly.</div>';
    html += '</div></div>';
    html += '<div class="guide-item"><div class="guide-num">03 / WRITE</div><div class="guide-title">Leave a review</div><div class="guide-body">';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>After searching a player, the <strong>Write a review</strong> box appears.</div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Pick a <strong>star rating</strong> from 1 to 5.</div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Write your review \u2014 min <strong>5 chars</strong>, max <strong>300</strong>.</div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Only <strong>one review per player</strong>.</div>';
    html += '</div></div>';
    html += '<div class="guide-item"><div class="guide-num">04 / MANAGE</div><div class="guide-title">Edit or delete</div><div class="guide-body">';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Go to <strong>Dashboard</strong> to see all reviews you have written.</div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Click <strong>Edit</strong> to change text or star rating inline.</div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Click <strong>Delete</strong> to permanently remove a review.</div>';
    html += '</div></div>';
    html += '<div class="guide-item"><div class="guide-num">05 / SCRIPT</div><div class="guide-title">Tampermonkey integration</div><div class="guide-body">';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Install the osu! Suite Tampermonkey script in your browser.</div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Open any osu! player profile \u2014 a <strong>reviews button</strong> appears.</div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Set the server URL and log in from the script\'s <strong>API Keys</strong> tab.</div>';
    html += '</div></div>';
    html += '<div class="guide-item"><div class="guide-num">06 / RULES</div><div class="guide-title">Community guidelines</div><div class="guide-body">';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Be <strong>honest and respectful</strong> \u2014 reviews are about gameplay.</div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span><strong>Slurs, hate speech and profanity</strong> are auto-filtered.</div>';
    html += '<div class="guide-row"><span class="guide-arrow">\u2192</span>Abusive reviews can be removed by admins without notice.</div>';
    html += '</div></div>';
    html += '</div></section>\n\n';

    html += '<section class="sec" id="s-api"><div class="sec-label" id="api-label">06 \u2014 api reference</div><div class="api-grid">';
    html += '<div class="api-item"><span class="api-method m-get">GET</span><div class="api-path">/auth/login</div><div class="api-desc">Returns osu! OAuth URL</div></div>';
    html += '<div class="api-item"><span class="api-method m-get">GET</span><div class="api-path">/auth/me</div><div class="api-desc">Current session info</div></div>';
    html += '<div class="api-item"><span class="api-method m-post">POST</span><div class="api-path">/auth/logout</div><div class="api-desc">Destroys session</div></div>';
    html += '<div class="api-item"><span class="api-method m-get">GET</span><div class="api-path">/reviews/:userId</div><div class="api-desc">All reviews for a player</div></div>';
    html += '<div class="api-item"><span class="api-method m-post">POST</span><div class="api-path">/reviews</div><div class="api-desc">Post a review (auth required)</div></div>';
    html += '<div class="api-item"><span class="api-method m-put">PUT</span><div class="api-path">/reviews/:uid/:rid</div><div class="api-desc">Edit your own review</div></div>';
    html += '<div class="api-item"><span class="api-method m-del">DELETE</span><div class="api-path">/reviews/:uid/:rid</div><div class="api-desc">Delete a review</div></div>';
    html += '<div class="api-item"><span class="api-method m-get">GET</span><div class="api-path">/admin/reviews</div><div class="api-desc">All reviews (admin) / own (user)</div></div>';
    html += '<div class="api-item"><span class="api-method m-get">GET</span><div class="api-path">/health</div><div class="api-desc">Server health &amp; uptime</div></div>';
    html += '<div class="api-item"><span class="api-method m-get">GET</span><div class="api-path">/stats</div><div class="api-desc">Review counts &amp; storage info</div></div>';
    html += '</div></section>\n\n';

    html += '<footer>';
    html += '<div class="footer-l">osu! reviews \u2014 v2.6.0</div>';
    html += '<div class="footer-r"><a href="/health">health</a><a href="/stats">stats</a><a href="/admin/reviews" id="admin-api-link" style="display:none">admin api</a></div>';
    html += '</footer>\n\n</div>\n\n';

    html += '<script>\n';
    html += 'var tok      = localStorage.getItem("osu_tok") || null;\n';
    html += 'var usr      = null;\n';
    html += 'var cuid     = null;\n';
    html += 'var selStar  = 0;\n';
    html += 'var adminFilter = "all";\n';
    html += 'var adminRevs   = [];\n';
    html += 'var ES = {};\n';
    html += 'var mx = 0, my = 0, rx = 0, ry = 0;\n';
    html += 'var curEl  = document.getElementById("cur");\n';
    html += 'var ringEl = document.getElementById("cur-ring");\n';
    html += 'document.addEventListener("mousemove", function(e) {\n';
    html += '    mx = e.clientX; my = e.clientY;\n';
    html += '    curEl.style.left = mx + "px";\n';
    html += '    curEl.style.top  = my + "px";\n';
    html += '});\n';
    html += '(function animRing() {\n';
    html += '    rx += (mx - rx) * 0.14;\n';
    html += '    ry += (my - ry) * 0.14;\n';
    html += '    ringEl.style.left = rx + "px";\n';
    html += '    ringEl.style.top  = ry + "px";\n';
    html += '    requestAnimationFrame(animRing);\n';
    html += '})();\n';
    html += 'document.addEventListener("mouseover", function(e) {\n';
    html += '    if (e.target.closest("a,button,input,textarea")) {\n';
    html += '        curEl.style.width = "20px"; curEl.style.height = "20px";\n';
    html += '    } else {\n';
    html += '        curEl.style.width = "10px"; curEl.style.height = "10px";\n';
    html += '    }\n';
    html += '});\n';
    html += 'function H(s) {\n';
    html += '    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");\n';
    html += '}\n';
    html += 'function starsHtml(n) {\n';
    html += '    var out = "";\n';
    html += '    for (var i = 1; i <= 5; i++) out += "<span class=\\"star" + (i <= n ? " on" : "") + "\\">\u2605</span>";\n';
    html += '    return out;\n';
    html += '}\n';
    html += 'function notify(msg, type) {\n';
    html += '    var el = document.createElement("div");\n';
    html += '    el.className = "notif notif-" + (type === "success" ? "success" : type === "error" ? "error" : "info");\n';
    html += '    el.textContent = msg;\n';
    html += '    document.body.appendChild(el);\n';
    html += '    setTimeout(function() { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(function() { el.remove(); }, 300); }, 3000);\n';
    html += '}\n';
    html += 'function fmtDate(d) {\n';
    html += '    return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });\n';
    html += '}\n';
    html += 'function doLogin() {\n';
    html += '    var btn   = document.getElementById("login-btn");\n';
    html += '    var errEl = document.getElementById("login-err");\n';
    html += '    btn.innerHTML = "<span class=\\"spinner\\"></span>Opening\\u2026";\n';
    html += '    btn.disabled  = true;\n';
    html += '    errEl.textContent = "";\n';
    html += '    fetch("/auth/login")\n';
    html += '        .then(function(r) { return r.json(); })\n';
    html += '        .then(function(d) {\n';
    html += '            if (!d.url) throw new Error("No login URL returned");\n';
    html += '            var popup = window.open(d.url, "osu-auth", "width=520,height=720,scrollbars=yes");\n';
    html += '            if (!popup) {\n';
    html += '                errEl.textContent = "Popup blocked — please allow popups for this site";\n';
    html += '                btn.innerHTML = "Login with osu!"; btn.disabled = false;\n';
    html += '                return;\n';
    html += '            }\n';
    html += '            var timeout = setTimeout(function() {\n';
    html += '                window.removeEventListener("message", handler);\n';
    html += '                errEl.textContent = "Login timed out";\n';
    html += '                btn.innerHTML = "Login with osu!"; btn.disabled = false;\n';
    html += '            }, 120000);\n';
    html += '            function handler(e) {\n';
    html += '                if (!e.data) return;\n';
    html += '                if (e.data.type === "osu-auth-success") {\n';
    html += '                    clearTimeout(timeout);\n';
    html += '                    window.removeEventListener("message", handler);\n';
    html += '                    tok = e.data.token;\n';
    html += '                    localStorage.setItem("osu_tok", tok);\n';
    html += '                    usr = { userId: e.data.userId, username: e.data.username, avatarUrl: e.data.avatarUrl, isAdmin: e.data.isAdmin || false };\n';
    html += '                    renderLoggedIn();\n';
    html += '                    notify("Logged in as " + e.data.username, "success");\n';
    html += '                } else if (e.data.type === "osu-auth-error") {\n';
    html += '                    clearTimeout(timeout);\n';
    html += '                    window.removeEventListener("message", handler);\n';
    html += '                    errEl.textContent = e.data.error || "Auth failed";\n';
    html += '                    btn.innerHTML = "Login with osu!"; btn.disabled = false;\n';
    html += '                }\n';
    html += '            }\n';
    html += '            window.addEventListener("message", handler);\n';
    html += '        })\n';
    html += '        .catch(function(e) {\n';
    html += '            errEl.textContent = e.message;\n';
    html += '            btn.innerHTML = "Login with osu!"; btn.disabled = false;\n';
    html += '        });\n';
    html += '}\n';
    html += 'function doLogout() {\n';
    html += '    if (tok) fetch("/auth/logout", { method: "POST", headers: { "Authorization": "Bearer " + tok } }).catch(function(){});\n';
    html += '    tok = null; usr = null;\n';
    html += '    localStorage.removeItem("osu_tok");\n';
    html += '    renderLoggedOut();\n';
    html += '    notify("Logged out", "info");\n';
    html += '}\n';
    html += 'function verifySession() {\n';
    html += '    if (!tok) return;\n';
    html += '    fetch("/auth/me", { headers: { "Authorization": "Bearer " + tok } })\n';
    html += '        .then(function(r) {\n';
    html += '            if (r.ok) return r.json();\n';
    html += '            tok = null; usr = null; localStorage.removeItem("osu_tok");\n';
    html += '        })\n';
    html += '        .then(function(b) {\n';
    html += '            if (!b) return;\n';
    html += '            usr = b.data || b;\n';
    html += '            renderLoggedIn();\n';
    html += '        })\n';
    html += '        .catch(function(){});\n';
    html += '}\n';
    html += 'function renderLoggedIn() {\n';
    html += '    document.getElementById("state-out").classList.add("hidden");\n';
    html += '    document.getElementById("state-in").classList.remove("hidden");\n';
    html += '    document.getElementById("user-name").textContent = usr.username;\n';
    html += '    document.getElementById("user-id").textContent   = "id: " + usr.userId;\n';
    html += '    if (usr.avatarUrl) {\n';
    html += '        var wrap = document.getElementById("av-in");\n';
    html += '        var img  = document.getElementById("av-in-img");\n';
    html += '        img.src = usr.avatarUrl;\n';
    html += '        img.onload = function() { wrap.classList.add("loaded"); };\n';
    html += '    }\n';
    html += '    document.getElementById("write-user").textContent = "as " + usr.username;\n';
    html += '    if (usr.isAdmin) {\n';
    html += '        document.getElementById("admin-badge").classList.remove("hidden");\n';
    html += '        document.getElementById("s-admin").classList.remove("hidden");\n';
    html += '        document.getElementById("admin-api-link").style.display = "";\n';
    html += '        loadAdminRevs();\n';
    html += '    }\n';
    html += '    document.getElementById("dash-out").classList.add("hidden");\n';
    html += '    document.getElementById("dash-in").classList.remove("hidden");\n';
    html += '    loadDash();\n';
    html += '    updateWritePanel();\n';
    html += '}\n';
    html += 'function renderLoggedOut() {\n';
    html += '    document.getElementById("state-in").classList.add("hidden");\n';
    html += '    document.getElementById("state-out").classList.remove("hidden");\n';
    html += '    document.getElementById("login-btn").innerHTML = "Login with osu!";\n';
    html += '    document.getElementById("login-btn").disabled  = false;\n';
    html += '    document.getElementById("dash-in").classList.add("hidden");\n';
    html += '    document.getElementById("dash-out").classList.remove("hidden");\n';
    html += '    document.getElementById("s-admin").classList.add("hidden");\n';
    html += '    updateWritePanel();\n';
    html += '}\n';
    html += 'function loadDash() {\n';
    html += '    if (!usr) return;\n';
    html += '    var list = document.getElementById("dash-list");\n';
    html += '    list.innerHTML = "<div class=\\"reviews-empty\\" style=\\"padding:32px;\\"><span class=\\"spinner\\"></span></div>";\n';
    html += '    fetch("/admin/reviews", { headers: { "Authorization": "Bearer " + tok } })\n';
    html += '        .then(function(r) {\n';
    html += '            if (!r.ok) { list.innerHTML = "<div class=\\"reviews-empty\\" style=\\"padding:24px;\\">Could not load.</div>"; return null; }\n';
    html += '            return r.json();\n';
    html += '        })\n';
    html += '        .then(function(b) {\n';
    html += '            if (!b) return;\n';
    html += '            var data = b.data || b;\n';
    html += '            var mine = [];\n';
    html += '            Object.keys(data).forEach(function(uid) {\n';
    html += '                data[uid].forEach(function(rv) {\n';
    html += '                    if (String(rv.authorUserId) === String(usr.userId)) mine.push(Object.assign({}, rv, { tuid: uid }));\n';
    html += '                });\n';
    html += '            });\n';
    html += '            if (!mine.length) { list.innerHTML = "<div class=\\"reviews-empty\\" style=\\"padding:32px;\\">You have not written any reviews yet.</div>"; return; }\n';
    html += '            list.innerHTML = "";\n';
    html += '            mine.forEach(function(rv, i) {\n';
    html += '                var el = document.createElement("div");\n';
    html += '                el.className = "dash-item";\n';
    html += '                el.id = "dash-" + rv.id;\n';
    html += '                el.style.animationDelay = (i * 0.05) + "s";\n';
    html += '                var editStars = [1,2,3,4,5].map(function(n) {\n';
    html += '                    return "<button class=\\"edit-star\\" data-s=\\"" + n + "\\" onclick=\\"setES(\'" + rv.id + "\'," + n + ",false)\\">\u2605</button>";\n';
    html += '                }).join("");\n';
    html += '                el.innerHTML =\n';
    html += '                    "<div class=\\"dash-item-top\\">" +\n';
    html += '                        "<div class=\\"dash-item-meta\\">Review for <a href=\\"https://osu.ppy.sh/users/" + H(rv.tuid) + "\\" target=\\"_blank\\">#" + H(rv.tuid) + "</a></div>" +\n';
    html += '                        "<div class=\\"stars\\">" + starsHtml(rv.stars) + "</div>" +\n';
    html += '                    "</div>" +\n';
    html += '                    "<div class=\\"dash-item-text\\">" + H(rv.text) + "</div>" +\n';
    html += '                    "<div class=\\"dash-item-date\\">" + fmtDate(rv.createdAt) + (rv.updatedAt ? " \u00b7 edited" : "") + "</div>" +\n';
    html += '                    "<div class=\\"dash-item-actions\\">" +\n';
    html += '                        "<button class=\\"btn btn-edit\\" onclick=\\"openEdit(\'" + rv.id + "\',\'" + uid + "\'," + rv.stars + "," + JSON.stringify(rv.text) + ",true)
    html += '                        "<button class=\\"btn btn-danger\\" onclick=\\"deleteReview(\'" + rv.tuid + "\',\'" + rv.id + "\')\\">Delete</button>" +\n';
    html += '                    "</div>" +\n';
    html += '                    "<div class=\\"edit-form\\" id=\\"ef-" + rv.id + "\\">" +\n';
    html += '                        "<div class=\\"edit-stars\\" id=\\"est-" + rv.id + "\\">" + editStars + "</div>" +\n';
    html += '                        "<textarea class=\\"edit-textarea\\" id=\\"eta-" + rv.id + "\\" maxlength=\\"300\\">" + H(rv.text) + "</textarea>" +\n';
    html += '                        "<div class=\\"edit-row\\">" +\n';
    html += '                            "<button class=\\"btn btn-primary btn-sm\\" onclick=\\"saveEdit(\'" + rv.id + "\',\'" + rv.tuid + "\',false)\\">Save</button>" +\n';
    html += '                            "<button class=\\"btn btn-ghost btn-sm\\" onclick=\\"closeEdit(\'" + rv.id + "\',false)\\">Cancel</button>" +\n';
    html += '                        "</div>" +\n';
    html += '                        "<div class=\\"edit-err\\" id=\\"ee-" + rv.id + "\\"></div>" +\n';
    html += '                    "</div>";\n';
    html += '                list.appendChild(el);\n';
    html += '                renderES(rv.id, rv.stars, false);\n';
    html += '            });\n';
    html += '        })\n';
    html += '        .catch(function() { list.innerHTML = "<div class=\\"reviews-empty\\" style=\\"padding:24px;color:#ff6b6b;\\">Failed to load.</div>"; });\n';
    html += '}\n';
    html += 'function openEdit(id, tuid, stars, text, profile) {\n';
    html += '    document.querySelectorAll(".edit-form.open").forEach(function(f) { f.classList.remove("open"); });\n';
    html += '    ES[id] = stars;\n';
    html += '    var pfx  = profile ? "pef" : "ef";\n';
    html += '    var form = document.getElementById(pfx + "-" + id);\n';
    html += '    if (!form) return;\n';
    html += '    form.classList.add("open");\n';
    html += '    var ta = document.getElementById((profile ? "peta" : "eta") + "-" + id);\n';
    html += '    if (ta) ta.value = text;\n';
    html += '    renderES(id, stars, profile);\n';
    html += '}\n';
    html += 'function closeEdit(id, profile) {\n';
    html += '    var f = document.getElementById((profile ? "pef" : "ef") + "-" + id);\n';
    html += '    if (f) f.classList.remove("open");\n';
    html += '}\n';
    html += 'function setES(id, n, profile) {\n';
    html += '    ES[id] = n;\n';
    html += '    renderES(id, n, profile);\n';
    html += '}\n';
    html += 'function renderES(id, n, profile) {\n';
    html += '    var wrap = document.getElementById((profile ? "pest" : "est") + "-" + id);\n';
    html += '    if (!wrap) return;\n';
    html += '    wrap.querySelectorAll(".edit-star").forEach(function(b) {\n';
    html += '        b.classList.toggle("on", +b.dataset.s <= n);\n';
    html += '    });\n';
    html += '}\n';
    html += 'function saveEdit(id, tuid, profile) {\n';
    html += '    var ta  = document.getElementById((profile ? "peta" : "eta") + "-" + id);\n';
    html += '    var ee  = document.getElementById((profile ? "pee" : "ee") + "-" + id);\n';
    html += '    if (ee) ee.textContent = "";\n';
    html += '    var text  = ta ? ta.value.trim() : "";\n';
    html += '    var stars = ES[id] || 0;\n';
    html += '    if (!text || !stars) { if (ee) ee.textContent = "Fill in text and stars"; return; }\n';
    html += '    fetch("/reviews/" + tuid + "/" + id, {\n';
    html += '        method: "PUT",\n';
    html += '        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tok },\n';
    html += '        body: JSON.stringify({ text: text, stars: stars })\n';
    html += '    })\n';
    html += '    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })\n';
    html += '    .then(function(res) {\n';
    html += '        if (res.ok) {\n';
    html += '            notify("Review updated", "success");\n';
    html += '            closeEdit(id, profile);\n';
    html += '            loadDash();\n';
    html += '            if (cuid === tuid) loadReviews(tuid);\n';
    html += '        } else { if (ee) ee.textContent = res.d.error || "Error"; }\n';
    html += '    })\n';
    html += '    .catch(function() { if (ee) ee.textContent = "Network error"; });\n';
    html += '}\n';
    html += 'function deleteReview(tuid, id) {\n';
    html += '    if (!confirm("Delete this review?")) return;\n';
    html += '    fetch("/reviews/" + tuid + "/" + id, { method: "DELETE", headers: { "Authorization": "Bearer " + tok } })\n';
    html += '        .then(function(r) {\n';
    html += '            if (r.ok) { notify("Review deleted", "success"); loadDash(); if (cuid === tuid) loadReviews(tuid); }\n';
    html += '            else return r.json().then(function(d) { notify(d.error || "Error", "error"); });\n';
    html += '        })\n';
    html += '        .catch(function() { notify("Network error", "error"); });\n';
    html += '}\n';
    html += 'function loadAdminRevs() {\n';
    html += '    document.getElementById("admin-list").innerHTML = "<div class=\\"reviews-empty\\" style=\\"padding:40px;\\"><span class=\\"spinner\\"></span></div>";\n';
    html += '    fetch("/admin/reviews", { headers: { "Authorization": "Bearer " + tok } })\n';
    html += '        .then(function(r) {\n';
    html += '            if (!r.ok) { document.getElementById("admin-list").innerHTML = "<div class=\\"reviews-empty\\">Access denied.</div>"; return null; }\n';
    html += '            return r.json();\n';
    html += '        })\n';
    html += '        .then(function(b) {\n';
    html += '            if (!b) return;\n';
    html += '            var data = b.data || b;\n';
    html += '            adminRevs = [];\n';
    html += '            Object.keys(data).forEach(function(uid) {\n';
    html += '                data[uid].forEach(function(rv) { adminRevs.push(Object.assign({}, rv, { tuid: uid })); });\n';
    html += '            });\n';
    html += '            adminRevs.sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });\n';
    html += '            document.getElementById("adm-total").textContent   = adminRevs.length;\n';
    html += '            document.getElementById("adm-flagged").textContent = adminRevs.filter(function(r) { return r.flagged; }).length;\n';
    html += '            renderAdmin();\n';
    html += '        })\n';
    html += '        .catch(function() { document.getElementById("admin-list").innerHTML = "<div class=\\"reviews-empty\\">Failed to load.</div>"; });\n';
    html += '}\n';
    html += 'function setAdminFilter(f, btn) {\n';
    html += '    adminFilter = f;\n';
    html += '    document.querySelectorAll(".filter-chip").forEach(function(c) { c.classList.remove("on"); });\n';
    html += '    btn.classList.add("on");\n';
    html += '    renderAdmin();\n';
    html += '}\n';
    html += 'function renderAdmin() {\n';
    html += '    var q = (document.getElementById("admin-search") || {}).value || "";\n';
    html += '    q = q.toLowerCase();\n';
    html += '    var filt = adminRevs.filter(function(rv) {\n';
    html += '        if (adminFilter === "flagged" && !rv.flagged) return false;\n';
    html += '        if (["1","2","3","4","5"].indexOf(adminFilter) >= 0 && rv.stars !== +adminFilter) return false;\n';
    html += '        if (q && rv.text.toLowerCase().indexOf(q) < 0 && rv.authorUsername.toLowerCase().indexOf(q) < 0 && rv.tuid.indexOf(q) < 0) return false;\n';
    html += '        return true;\n';
    html += '    });\n';
    html += '    document.getElementById("adm-shown").textContent = filt.length;\n';
    html += '    var list = document.getElementById("admin-list");\n';
    html += '    if (!filt.length) { list.innerHTML = "<div class=\\"reviews-empty\\" style=\\"padding:40px;\\"><div class=\\"empty-icon\\">\u25c7</div><div>No reviews match.</div></div>"; return; }\n';
    html += '    list.innerHTML = "";\n';
    html += '    filt.forEach(function(rv) {\n';
    html += '        var el = document.createElement("div");\n';
    html += '        el.className = "admin-item";\n';
    html += '        el.innerHTML =\n';
    html += '            "<div class=\\"admin-item-body\\">" +\n';
    html += '                "<div class=\\"admin-item-meta\\">" +\n';
    html += '                    "<span class=\\"admin-author\\">" + H(rv.authorUsername) + "</span>" +\n';
    html += '                    "<span class=\\"admin-arrow\\">\u2192</span>" +\n';
    html += '                    "<span class=\\"admin-target\\">user #" + H(rv.tuid) + "</span>" +\n';
    html += '                    "<div class=\\"stars\\">" + starsHtml(rv.stars) + "</div>" +\n';
    html += '                    (rv.flagged ? "<span class=\\"flag-badge\\">FLAGGED</span>" : "") +\n';
    html += '                "</div>" +\n';
    html += '                "<div class=\\"admin-text\\">" + H(rv.text) + "</div>" +\n';
    html += '                "<div class=\\"admin-date\\">" + fmtDate(rv.createdAt) + " \u00b7 " + H(rv.id) + "</div>" +\n';
    html += '            "</div>" +\n';
    html += '            "<div class=\\"admin-actions\\">" +\n';
    html += '                "<a href=\\"https://osu.ppy.sh/users/" + H(rv.authorUserId) + "\\" target=\\"_blank\\" class=\\"btn btn-ghost btn-sm\\">Profile</a>" +\n';
    html += '                "<button class=\\"btn btn-danger\\" onclick=\\"adminDelete(\'" + rv.tuid + "\',\'" + rv.id + "\')\\">Delete</button>" +\n';
    html += '            "</div>";\n';
    html += '        list.appendChild(el);\n';
    html += '    });\n';
    html += '}\n';
    html += 'function adminDelete(tuid, id) {\n';
    html += '    if (!confirm("Admin delete this review?")) return;\n';
    html += '    fetch("/reviews/" + tuid + "/" + id, { method: "DELETE", headers: { "Authorization": "Bearer " + tok } })\n';
    html += '        .then(function(r) {\n';
    html += '            if (r.ok) { notify("Review deleted", "success"); loadAdminRevs(); if (cuid === tuid) loadReviews(tuid); }\n';
    html += '            else return r.json().then(function(d) { notify(d.error || "Error", "error"); });\n';
    html += '        });\n';
    html += '}\n';
    html += 'function searchPlayer() {\n';
    html += '    var v = document.getElementById("player-input").value.trim();\n';
    html += '    if (!v) { notify("Please enter a user ID", "error"); return; }\n';
    html += '    if (!/^\\d+$/.test(v)) { notify("User ID must be numeric", "error"); return; }\n';
    html += '    cuid = v;\n';
    html += '    var card = document.getElementById("profile-card");\n';
    html += '    card.classList.remove("visible");\n';
    html += '    document.getElementById("profile-name").textContent = "User #" + v;\n';
    html += '    document.getElementById("profile-avatar").src = "https://a.ppy.sh/" + v;\n';
    html += '    document.getElementById("profile-meta").innerHTML =\n';
    html += '        "<span>id: " + v + "</span>" +\n';
    html += '        "<a href=\\"https://osu.ppy.sh/users/" + v + "\\" target=\\"_blank\\" style=\\"color:var(--g5);text-decoration:underline;\\">\u2192 osu! profile</a>";\n';
    html += '    document.getElementById("reviews-body").innerHTML = "<div class=\\"reviews-empty\\"><span class=\\"spinner\\"></span></div>";\n';
    html += '    void card.offsetWidth;\n';
    html += '    card.classList.add("visible");\n';
    html += '    updateWritePanel();\n';
    html += '    loadReviews(v);\n';
    html += '}\n';
    html += 'function loadReviews(uid) {\n';
    html += '    var body = document.getElementById("reviews-body");\n';
    html += '    body.innerHTML = "<div class=\\"reviews-empty\\"><span class=\\"spinner\\"></span></div>";\n';
    html += '    fetch("/reviews/" + uid)\n';
    html += '        .then(function(r) {\n';
    html += '            if (!r.ok) { body.innerHTML = "<div class=\\"reviews-empty\\"><div class=\\"empty-icon\\">!</div><div>Server error " + r.status + "</div></div>"; return null; }\n';
    html += '            return r.json();\n';
    html += '        })\n';
    html += '        .then(function(revs) {\n';
    html += '            if (!revs) return;\n';
    html += '            if (!Array.isArray(revs) || !revs.length) {\n';
    html += '                body.innerHTML = "<div class=\\"reviews-empty\\"><div class=\\"empty-icon\\">\u25c7</div><div>No reviews yet.</div></div>";\n';
    html += '                return;\n';
    html += '            }\n';
    html += '            body.innerHTML = "";\n';
    html += '            revs.slice().reverse().forEach(function(rv, i) {\n';
    html += '                var mine = usr && String(usr.userId) === String(rv.authorUserId);\n';
    html += '                var el = document.createElement("div");\n';
    html += '                el.className = "review-item";\n';
    html += '                el.style.animationDelay = (i * 0.05) + "s";\n';
    html += '                var editStars = [1,2,3,4,5].map(function(n) {\n';
    html += '                    return "<button class=\\"edit-star\\" data-s=\\"" + n + "\\" onclick=\\"setES(\'" + rv.id + "\'," + n + ",true)\\">\u2605</button>";\n';
    html += '                }).join("");\n';
    html += '                var mineHtml = "";\n';
    html += '                if (mine) {\n';
    html += '                    mineHtml =\n';
    html += '                        "<div class=\\"review-actions\\">" +\n';
    html += '                            "<button class=\\"btn btn-edit\\" onclick=\\"openEdit(\'" + rv.id + "\',\'" + uid + "\'," + rv.stars + ",\'" + rv.text.replace(/\'/g, "\\\\\\'") + "\',true)\\">Edit</button>" +\n';
    html += '                            "<button class=\\"btn btn-danger\\" onclick=\\"deleteReview(\'" + uid + "\',\'" + rv.id + "\')\\">Delete</button>" +\n';
    html += '                        "</div>" +\n';
    html += '                        "<div class=\\"edit-form\\" id=\\"pef-" + rv.id + "\\">" +\n';
    html += '                            "<div class=\\"edit-stars\\" id=\\"pest-" + rv.id + "\\">" + editStars + "</div>" +\n';
    html += '                            "<textarea class=\\"edit-textarea\\" id=\\"peta-" + rv.id + "\\" maxlength=\\"300\\">" + H(rv.text) + "</textarea>" +\n';
    html += '                            "<div class=\\"edit-row\\">" +\n';
    html += '                                "<button class=\\"btn btn-primary btn-sm\\" onclick=\\"saveEdit(\'" + rv.id + "\',\'" + uid + "\',true)\\">Save</button>" +\n';
    html += '                                "<button class=\\"btn btn-ghost btn-sm\\" onclick=\\"closeEdit(\'" + rv.id + "\',true)\\">Cancel</button>" +\n';
    html += '                            "</div>" +\n';
    html += '                            "<div class=\\"edit-err\\" id=\\"pee-" + rv.id + "\\"></div>" +\n';
    html += '                        "</div>";\n';
    html += '                }\n';
    html += '                el.innerHTML =\n';
    html += '                    "<div class=\\"review-top\\">" +\n';
    html += '                        "<div class=\\"review-author\\">" +\n';
    html += '                            "<img class=\\"review-avatar\\" src=\\"https://a.ppy.sh/" + H(rv.authorUserId) + "\\" alt=\\"\\">" +\n';
    html += '                            "<div>" +\n';
    html += '                                "<a class=\\"review-name\\" href=\\"https://osu.ppy.sh/users/" + H(rv.authorUserId) + "\\" target=\\"_blank\\">" + H(rv.authorUsername) + "</a>" +\n';
    html += '                                "<div class=\\"review-date\\">" + fmtDate(rv.createdAt) + (rv.updatedAt ? " \u00b7 edited" : "") + "</div>" +\n';
    html += '                            "</div>" +\n';
    html += '                        "</div>" +\n';
    html += '                        "<div class=\\"stars\\">" + starsHtml(rv.stars) + "</div>" +\n';
    html += '                    "</div>" +\n';
    html += '                    "<div class=\\"review-text\\">" + H(rv.text) + "</div>" +\n';
    html += '                    mineHtml;\n';
    html += '                body.appendChild(el);\n';
    html += '                if (mine) renderES(rv.id, rv.stars, true);\n';
    html += '            });\n';
    html += '        })\n';
    html += '        .catch(function() { body.innerHTML = "<div class=\\"reviews-empty\\"><div class=\\"empty-icon\\">!</div><div>Failed to load.</div></div>"; });\n';
    html += '}\n';
    html += 'function updateWritePanel() {\n';
    html += '    var panel  = document.getElementById("write-panel");\n';
    html += '    var prompt = document.getElementById("login-prompt");\n';
    html += '    if (!cuid) { panel.classList.add("hidden"); prompt.classList.add("hidden"); return; }\n';
    html += '    if (!usr)  { panel.classList.add("hidden"); prompt.classList.remove("hidden"); return; }\n';
    html += '    if (String(usr.userId) === String(cuid)) { panel.classList.add("hidden"); prompt.classList.add("hidden"); return; }\n';
    html += '    panel.classList.remove("hidden"); prompt.classList.add("hidden");\n';
    html += '}\n';
    html += 'function setStar(n) {\n';
    html += '    selStar = n;\n';
    html += '    document.querySelectorAll(".write-star").forEach(function(b) { b.classList.toggle("on", +b.dataset.s <= n); });\n';
    html += '    validateSubmit();\n';
    html += '}\n';
    html += 'document.getElementById("write-stars").addEventListener("mouseover", function(e) {\n';
    html += '    var b = e.target.closest(".write-star");\n';
    html += '    if (!b) return;\n';
    html += '    document.querySelectorAll(".write-star").forEach(function(x) { x.classList.toggle("on", +x.dataset.s <= +b.dataset.s); });\n';
    html += '});\n';
    html += 'document.getElementById("write-stars").addEventListener("mouseleave", function() {\n';
    html += '    document.querySelectorAll(".write-star").forEach(function(b) { b.classList.toggle("on", +b.dataset.s <= selStar); });\n';
    html += '});\n';
    html += 'function onTAInput() {\n';
    html += '    var ta = document.getElementById("write-ta");\n';
    html += '    document.getElementById("write-char").textContent = ta.value.length + " / 300";\n';
    html += '    validateSubmit();\n';
    html += '}\n';
    html += 'function validateSubmit() {\n';
    html += '    var ta = document.getElementById("write-ta");\n';
    html += '    document.getElementById("submit-btn").disabled = !(ta.value.trim().length >= 5 && selStar > 0);\n';
    html += '}\n';
    html += 'function submitReview() {\n';
    html += '    if (!tok || !cuid) return;\n';
    html += '    var text  = document.getElementById("write-ta").value.trim();\n';
    html += '    var errEl = document.getElementById("write-err");\n';
    html += '    var btn   = document.getElementById("submit-btn");\n';
    html += '    errEl.textContent = "";\n';
    html += '    if (!text || !selStar) return;\n';
    html += '    btn.innerHTML = "<span class=\\"spinner\\"></span>Submitting\\u2026"; btn.disabled = true;\n';
    html += '    fetch("/reviews", {\n';
    html += '        method: "POST",\n';
    html += '        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + tok },\n';
    html += '        body: JSON.stringify({ targetUserId: cuid, stars: selStar, text: text })\n';
    html += '    })\n';
    html += '    .then(function(r) { return r.json().then(function(d) { return { status: r.status, ok: r.ok, d: d }; }); })\n';
    html += '    .then(function(res) {\n';
    html += '        if (res.ok) {\n';
    html += '            document.getElementById("write-ta").value = "";\n';
    html += '            document.getElementById("write-char").textContent = "0 / 300";\n';
    html += '            selStar = 0;\n';
    html += '            document.querySelectorAll(".write-star").forEach(function(b) { b.classList.remove("on"); });\n';
    html += '            notify("Review posted!", "success");\n';
    html += '            loadReviews(cuid);\n';
    html += '            loadDash();\n';
    html += '        } else if (res.status === 401) {\n';
    html += '            tok = null; usr = null; localStorage.removeItem("osu_tok");\n';
    html += '            renderLoggedOut();\n';
    html += '            errEl.textContent = "Session expired \\u2014 please log in again";\n';
    html += '        } else {\n';
    html += '            errEl.textContent = res.d.error || "Server error";\n';
    html += '        }\n';
    html += '    })\n';
    html += '    .catch(function() { errEl.textContent = "Could not reach server"; })\n';
    html += '    .then(function() { btn.innerHTML = "Submit review"; validateSubmit(); });\n';
    html += '}\n';
    html += 'document.getElementById("player-input").addEventListener("keydown", function(e) { if (e.key === "Enter") searchPlayer(); });\n';
    html += 'verifySession();\n';
    html += '<\/script>\n</body>\n</html>';
    return html;
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(function(req, res) {
    setCORS(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url      = new URL(req.url, 'http://' + req.headers.host);
    const pathname = url.pathname;
    const method   = req.method;
    console.log('[' + new Date().toLocaleTimeString() + '] ' + method + ' ' + pathname);

    function handle() {
        setCORS(res);

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
            exchangeCode(code)
                .then(function(tokens) {
                    if (!tokens.access_token) throw new Error('No access token');
                    return osuApiGet('me', tokens.access_token);
                })
                .then(function(osuUser) {
                    if (!osuUser || !osuUser.id) throw new Error('Could not fetch osu! user');
                    const st = makeSessionToken();
                    const adminFlag = osuUser.username.toLowerCase() === ADMIN_USERNAME;
                    sessions.set(st, {
                        userId:    osuUser.id,
                        username:  osuUser.username,
                        avatarUrl: osuUser.avatar_url || null,
                        isAdmin:   adminFlag,
                        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
                    });
                    console.log('Login: ' + osuUser.username + ' (' + osuUser.id + ')' + (adminFlag ? ' [ADMIN]' : ''));
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end('<!DOCTYPE html><html><head><style>body{background:#0a0a0a;color:#f5f5f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:12px;}</style></head><body>' +
                        '<p>\u2713 Logged in as <strong style="color:#4ade80">' + escapeHtml(osuUser.username) + '</strong></p>' +
                        '<p style="font-size:12px;opacity:.5">Closing\u2026</p>' +
                        '<script>window.opener&&window.opener.postMessage({type:"osu-auth-success",token:"' + st + '",userId:' + osuUser.id + ',username:"' + escapeHtml(osuUser.username) + '",avatarUrl:"' + escapeHtml(osuUser.avatar_url || '') + '",isAdmin:' + adminFlag + '},"*");setTimeout(function(){window.close();},1000);<\/script>' +
                        '</body></html>');
                })
                .catch(function(e) {
                    console.error('Auth error:', e.message);
                    res.writeHead(500, { 'Content-Type': 'text/html' });
                    res.end('<html><body><script>window.opener&&window.opener.postMessage({type:"osu-auth-error",error:"' + escapeHtml(e.message) + '"},"*");window.close();<\/script><p>Error: ' + escapeHtml(e.message) + '</p></body></html>');
                });
            return;
        }

        if (method === 'GET' && pathname === '/auth/me') {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Not logged in'); return; }
            json(res, 200, { success: true, data: { userId: s.userId, username: s.username, avatarUrl: s.avatarUrl, isAdmin: s.isAdmin || false } });
            return;
        }

        if (method === 'POST' && pathname === '/auth/logout') {
            const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
            if (auth) sessions.delete(auth);
            json(res, 200, { ok: true });
            return;
        }

        if (method === 'GET' && pathname === '/admin/reviews') {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Not logged in'); return; }
            if (isAdmin(s)) { json(res, 200, { success: true, data: reviews }); return; }
            const mine = {};
            Object.keys(reviews).forEach(function(uid) {
                const f = reviews[uid].filter(function(r) { return String(r.authorUserId) === String(s.userId); });
                if (f.length) mine[uid] = f;
            });
            json(res, 200, { success: true, data: mine });
            return;
        }

        if (method === 'GET' && pathname === '/notes') {
            const id = url.searchParams.get('beatmapsetId');
            if (!id) { err(res, 400, 'beatmapsetId required'); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mem.notes.filter(function(n) { return n.beatmapsetId === id; })));
            return;
        }

        if (method === 'POST' && pathname === '/notes') {
            parseBody(req).then(function(d) {
                if (!d.beatmapsetId || !d.text) { err(res, 400, 'beatmapsetId and text required'); return; }
                const note = { id: d.id || 'note_' + uid(), time: d.time || '00:00:000', author: d.author || 'Anonymous', text: d.text.trim(), beatmapsetId: d.beatmapsetId, resolved: d.resolved || false, created: d.created || Date.now(), reactions: [], replies: [] };
                mem.notes.push(note);
                mem.history.push({ type: 'note', author: note.author, beatmapsetId: note.beatmapsetId, timestamp: note.created, preview: note.text.slice(0, 100) });
                ok(res, note);
            }).catch(function(e) { err(res, 400, e.message); });
            return;
        }

        if (method === 'POST' && pathname === '/notes/react') {
            parseBody(req).then(function(d) {
                const noteId = d.noteId, emoji = d.emoji, username = d.username;
                if (!noteId || !emoji || !username) { err(res, 400, 'noteId, emoji, username required'); return; }
                const note = mem.notes.find(function(n) { return n.id === noteId || String(n.created) === String(noteId); });
                if (!note) { err(res, 404, 'Note not found'); return; }
                if (!note.reactions) note.reactions = [];
                const idx = note.reactions.findIndex(function(r) { return r.emoji === emoji && r.username === username; });
                if (idx >= 0) note.reactions.splice(idx, 1); else note.reactions.push({ emoji: emoji, username: username, timestamp: Date.now() });
                ok(res, note);
            }).catch(function(e) { err(res, 400, e.message); });
            return;
        }

        if (method === 'POST' && pathname === '/notes/reply') {
            parseBody(req).then(function(d) {
                const noteId = d.noteId, text = d.text, username = d.username, beatmapsetId = d.beatmapsetId;
                if (!noteId || !text || !username) { err(res, 400, 'noteId, text, username required'); return; }
                const note = mem.notes.find(function(n) { return n.id === noteId || String(n.created) === String(noteId); });
                if (!note) { err(res, 404, 'Note not found'); return; }
                if (!note.replies) note.replies = [];
                const reply = { username: username, text: text.trim(), timestamp: Date.now() };
                note.replies.push(reply);
                mem.history.push({ type: 'reply', author: username, beatmapsetId: beatmapsetId || note.beatmapsetId, timestamp: reply.timestamp, preview: text.slice(0, 100) });
                ok(res, note);
            }).catch(function(e) { err(res, 400, e.message); });
            return;
        }

        if (method === 'DELETE' && pathname.indexOf('/notes/') === 0) {
            const noteId = pathname.split('/')[2];
            const idx = mem.notes.findIndex(function(n) { return n.id === noteId || String(n.created) === noteId; });
            if (idx === -1) { err(res, 404, 'Note not found'); return; }
            mem.notes.splice(idx, 1); ok(res, { deleted: true });
            return;
        }

        if (method === 'GET' && pathname === '/chat') {
            const id = url.searchParams.get('beatmapsetId');
            if (!id) { err(res, 400, 'beatmapsetId required'); return; }
            ok(res, mem.chat.filter(function(m) { return m.beatmapsetId === id; }).slice(-100));
            return;
        }

        if (method === 'POST' && pathname === '/chat') {
            parseBody(req).then(function(d) {
                if (!d.beatmapsetId || !d.text || !d.author) { err(res, 400, 'beatmapsetId, text, author required'); return; }
                const msg = { id: 'msg_' + uid(), author: d.author, text: d.text.trim(), beatmapsetId: d.beatmapsetId, timestamp: d.timestamp || Date.now() };
                mem.chat.push(msg);
                mem.history.push({ type: 'chat', author: msg.author, beatmapsetId: msg.beatmapsetId, timestamp: msg.timestamp, preview: msg.text.slice(0, 100) });
                ok(res, msg);
            }).catch(function(e) { err(res, 400, e.message); });
            return;
        }

        if (method === 'GET' && pathname === '/collab/users') {
            const id = url.searchParams.get('beatmapsetId');
            const now = Date.now();
            let active = mem.users.filter(function(u) { return now - u.timestamp < 30000; });
            if (id) active = active.filter(function(u) { return u.beatmapsetId === id; });
            ok(res, active);
            return;
        }

        if (method === 'POST' && pathname === '/collab/users') {
            parseBody(req).then(function(d) {
                if (!d.userId || !d.username) { err(res, 400, 'userId and username required'); return; }
                mem.users = mem.users.filter(function(u) { return u.userId !== d.userId; });
                const p = { userId: d.userId, username: d.username, avatarUrl: d.avatarUrl || null, beatmapsetId: d.beatmapsetId || null, timestamp: d.timestamp || Date.now() };
                mem.users.push(p); ok(res, p);
            }).catch(function(e) { err(res, 400, e.message); });
            return;
        }

        if (method === 'GET' && pathname === '/session/history') {
            const id = url.searchParams.get('beatmapsetId');
            const limit = parseInt(url.searchParams.get('limit')) || 50;
            let h = id ? mem.history.filter(function(e) { return e.beatmapsetId === id; }) : mem.history;
            ok(res, h.slice(-limit));
            return;
        }

        if (method === 'GET' && /^\/reviews\/\d{1,10}$/.test(pathname)) {
            json(res, 200, reviews[pathname.split('/')[2]] || []);
            return;
        }

        if (method === 'POST' && pathname === '/reviews') {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Must be logged in to post reviews'); return; }
            parseBody(req).then(function(d) {
                const text  = (d.text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
                const tuid  = String(d.targetUserId || '');
                const stars = Number(d.stars);
                if (!tuid || !/^\d{1,10}$/.test(tuid))                    { err(res, 400, 'Invalid targetUserId'); return; }
                if (!Number.isInteger(stars) || stars < 1 || stars > 5)    { err(res, 400, 'stars must be 1-5'); return; }
                if (text.length < 5)                                        { err(res, 400, 'Review too short (min 5 chars)'); return; }
                if (text.length > 300)                                      { err(res, 400, 'Review too long (max 300 chars)'); return; }
                if (String(s.userId) === tuid)                              { err(res, 400, 'Cannot review yourself'); return; }
                if (containsProfanity(text))                                { err(res, 400, 'Review contains prohibited language.'); return; }
                if (!reviews[tuid]) reviews[tuid] = [];
                if (reviews[tuid].some(function(r) { return String(r.authorUserId) === String(s.userId); })) {
                    json(res, 409, { error: 'You have already reviewed this player' }); return;
                }
                const review = { id: uid(), authorUserId: s.userId, authorUsername: s.username, stars: stars, text: text, flagged: false, createdAt: new Date().toISOString(), updatedAt: null };
                reviews[tuid].push(review);
                saveReviewsToGitHub();
                console.log('Review by ' + s.username + ' for ' + tuid + ' (' + stars + ' stars)');
                json(res, 201, { ok: true, id: review.id });
            }).catch(function(e) { err(res, 400, e.message); });
            return;
        }

        if (method === 'PUT' && /^\/reviews\/\d{1,10}\/[\w]+$/.test(pathname)) {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Not logged in'); return; }
            const parts = pathname.split('/');
            const uid2  = parts[2], rid = parts[3];
            if (!reviews[uid2]) { err(res, 404, 'No reviews for that user'); return; }
            const review = reviews[uid2].find(function(r) { return r.id === rid; });
            if (!review) { err(res, 404, 'Review not found'); return; }
            if (String(review.authorUserId) !== String(s.userId) && !isAdmin(s)) { err(res, 403, 'Can only edit your own reviews'); return; }
            parseBody(req).then(function(d) {
                const text  = (d.text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
                const stars = Number(d.stars);
                if (text && text.length < 5)                                           { err(res, 400, 'Too short'); return; }
                if (text && text.length > 300)                                         { err(res, 400, 'Too long'); return; }
                if (text && containsProfanity(text))                                   { err(res, 400, 'Review contains prohibited language.'); return; }
                if (stars && (!Number.isInteger(stars) || stars < 1 || stars > 5))    { err(res, 400, 'stars must be 1-5'); return; }
                if (text)  review.text  = text;
                if (stars) review.stars = stars;
                review.updatedAt = new Date().toISOString();
                saveReviewsToGitHub();
                json(res, 200, { ok: true });
            }).catch(function(e) { err(res, 400, e.message); });
            return;
        }

        if (method === 'DELETE' && /^\/reviews\/\d{1,10}\/[\w]+$/.test(pathname)) {
            const s = getSession(req);
            if (!s) { err(res, 401, 'Not logged in'); return; }
            const parts = pathname.split('/');
            const uid2  = parts[2], rid = parts[3];
            if (!reviews[uid2]) { err(res, 404, 'No reviews for that user'); return; }
            const review = reviews[uid2].find(function(r) { return r.id === rid; });
            if (!review) { err(res, 404, 'Review not found'); return; }
            if (String(review.authorUserId) !== String(s.userId) && !isAdmin(s)) { err(res, 403, 'Can only delete your own reviews'); return; }
            reviews[uid2] = reviews[uid2].filter(function(r) { return r.id !== rid; });
            saveReviewsToGitHub();
            json(res, 200, { ok: true });
            return;
        }

        if (method === 'GET' && pathname === '/health') {
            ok(res, { status: 'healthy', uptime: process.uptime(), memory: process.memoryUsage(), version: '2.6.0' });
            return;
        }

        if (method === 'GET' && pathname === '/stats') {
            const total = Object.values(reviews).reduce(function(a, b) { return a + b.length; }, 0);
            ok(res, { uptime: Math.floor(process.uptime()), notes: mem.notes.length, chat: mem.chat.length, users: mem.users.filter(function(u) { return Date.now() - u.timestamp < 30000; }).length, reviews: total, sessions: sessions.size, storage: GITHUB_TOKEN ? 'github (' + GITHUB_REPO + ')' : 'memory-only' });
            return;
        }

        if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

        if (method === 'GET' && pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(buildHomePage());
            return;
        }

        err(res, 404, 'Endpoint ' + pathname + ' not found');
    }

    try {
        handle();
    } catch(e) {
        console.error('Error:', e.message);
        err(res, 500, 'Server error: ' + e.message);
    }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
loadReviewsFromGitHub().then(function() {
    server.listen(PORT, '0.0.0.0', function() {
        console.log('='.repeat(60));
        console.log('osu! Collab Server v2.6.0');
        console.log('http://0.0.0.0:' + PORT);
        console.log('Reviews: ' + (GITHUB_TOKEN ? 'GitHub -> ' + GITHUB_REPO : 'IN-MEMORY ONLY'));
        console.log('OAuth:   ' + (OSU_CLIENT_ID ? 'Configured' : 'NOT CONFIGURED'));
        console.log('Admin:   ' + ADMIN_USERNAME);
        console.log('='.repeat(60));
    });
});

process.on('SIGTERM', function() { server.close(function() { process.exit(0); }); });
process.on('SIGINT',  function() { server.close(function() { process.exit(0); }); });
process.on('uncaughtException',  function(e) { console.error('Uncaught:', e); process.exit(1); });
process.on('unhandledRejection', function(e) { console.error('Unhandled:', e); });
