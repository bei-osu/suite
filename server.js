// osu! Collab Server
// Reviews → persisted to GitHub (free, no external DB needed)
// Notes/chat/users/history → in-memory (ephemeral, fine for collab sessions)
//
// Required env vars on Render:
//   GITHUB_TOKEN      — Personal Access Token with "repo" scope
//   GITHUB_REPO       — e.g. "yourusername/osu-reviews-data"
//   REVIEW_TOKEN      — (optional) token required to POST reviews
//   OSU_CLIENT_ID     — OAuth app client ID
//   OSU_CLIENT_SECRET — OAuth app client secret
//   REDIRECT_URI      — https://your-render-app.onrender.com/auth/callback
//   SESSION_SECRET    — any random string

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

if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.warn('⚠  GITHUB_TOKEN or GITHUB_REPO not set — reviews will NOT persist across restarts!');
}
if (!OSU_CLIENT_ID || !OSU_CLIENT_SECRET || !REDIRECT_URI) {
    console.warn('⚠  OSU_CLIENT_ID / OSU_CLIENT_SECRET / REDIRECT_URI not set — login will not work!');
}

// ─── In-memory stores (ephemeral) ─────────────────────────────────────────────
const mem = {
    notes:   [],
    chat:    [],
    users:   [],
    history: [],
};

// ─── Sessions: token → { userId, username, avatarUrl, expiresAt } ─────────────
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

// ─── osu! OAuth helpers ────────────────────────────────────────────────────────
async function exchangeCode(code) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            client_id:     parseInt(OSU_CLIENT_ID, 10),
            client_secret: OSU_CLIENT_SECRET.trim(),
            code,
            grant_type:    'authorization_code',
            redirect_uri:  REDIRECT_URI.trim(),
        });
        const options = {
            hostname: 'osu.ppy.sh',
            path:     '/oauth/token',
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'User-Agent':     'osu-collab-server',
            },
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from osu! token endpoint')); } });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function osuApiGet(path, accessToken) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'osu.ppy.sh',
            path:     `/api/v2/${path}`,
            method:   'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept':        'application/json',
                'User-Agent':    'osu-collab-server',
            },
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON from osu! API')); } });
        });
        req.on('error', reject);
        req.end();
    });
}

// ─── GitHub storage for reviews ───────────────────────────────────────────────
let reviews      = {};
let reviewsSHA   = null;
let reviewsDirty = false;
let saveInFlight = false;

function githubRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const options = {
            hostname: 'api.github.com',
            path,
            method,
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent':    'osu-collab-server',
                'Accept':        'application/vnd.github.v3+json',
                'Content-Type':  'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            },
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function loadReviewsFromGitHub() {
    if (!GITHUB_TOKEN || !GITHUB_REPO) return;
    try {
        const r = await githubRequest('GET', `/repos/${GITHUB_REPO}/contents/reviews.json`);
        if (r.status === 200) {
            const content = Buffer.from(r.body.content, 'base64').toString('utf8');
            reviews    = JSON.parse(content);
            reviewsSHA = r.body.sha;
            const total = Object.values(reviews).reduce((a, b) => a + b.length, 0);
            console.log(`✓ Loaded reviews from GitHub (${total} total)`);
        } else if (r.status === 404) {
            console.log('→ No reviews.json yet, will create on first review');
        } else {
            console.warn('⚠  GitHub load failed:', r.status);
        }
    } catch (e) {
        console.error('✗ GitHub load error:', e.message);
    }
}

async function saveReviewsToGitHub() {
    if (!GITHUB_TOKEN || !GITHUB_REPO) return;
    if (saveInFlight) { reviewsDirty = true; return; }
    saveInFlight = true;
    reviewsDirty = false;
    try {
        const content = Buffer.from(JSON.stringify(reviews, null, 2)).toString('base64');
        const body = {
            message: `update reviews ${new Date().toISOString()}`,
            content,
            ...(reviewsSHA ? { sha: reviewsSHA } : {}),
        };
        const r = await githubRequest('PUT', `/repos/${GITHUB_REPO}/contents/reviews.json`, body);
        if (r.status === 200 || r.status === 201) {
            reviewsSHA = r.body.content.sha;
            console.log('✓ Reviews saved to GitHub');
        } else {
            console.warn('⚠  GitHub save failed:', r.status, JSON.stringify(r.body));
        }
    } catch (e) {
        console.error('✗ GitHub save error:', e.message);
    } finally {
        saveInFlight = false;
        if (reviewsDirty) saveReviewsToGitHub();
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch { reject(new Error('Invalid JSON')); }
        });
        req.on('error', reject);
    });
}

function setCORS(res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Review-Token');
    res.setHeader('Access-Control-Max-Age',       '86400');
}

function json(res, status, data) {
    setCORS(res);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function ok(res, data)         { json(res, 200, { success: true, data, timestamp: Date.now() }); }
function err(res, status, msg) { json(res, status, { error: msg, timestamp: Date.now() }); }
function uid()                 { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`; }

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    mem.users = mem.users.filter(u => now - u.timestamp < 30000);
    mem.chat  = mem.chat.filter(m => now - m.timestamp < 7 * 86400000);
    if (mem.history.length > 1000) mem.history = mem.history.slice(-1000);
    // Clean expired sessions
    for (const [token, s] of sessions) {
        if (s.expiresAt < now) sessions.delete(token);
    }
}, 60000);

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    setCORS(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url      = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method   = req.method;

    console.log(`[${new Date().toLocaleTimeString()}] ${method} ${pathname}`);

    try {

        // ── AUTH ──────────────────────────────────────────────────────────────

        if (method === 'GET' && pathname === '/auth/login') {
            if (!OSU_CLIENT_ID || !REDIRECT_URI) {
                err(res, 503, 'OAuth not configured on server'); return;
            }
            const params = new URLSearchParams({
                client_id:     OSU_CLIENT_ID,
                redirect_uri:  REDIRECT_URI,
                response_type: 'code',
                scope:         'identify',
            });
            json(res, 200, { url: `https://osu.ppy.sh/oauth/authorize?${params}` });
            return;
        }

        if (method === 'GET' && pathname === '/auth/callback') {
            const code  = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error || !code) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`<!DOCTYPE html><html><body>
                    <script>window.opener?.postMessage({type:'osu-auth-error',error:'${escapeHtml(error||'no code')}'}, '*'); window.close();</script>
                    <p>Auth failed: ${escapeHtml(error||'no code')}. You can close this window.</p>
                </body></html>`);
                return;
            }

            try {
                const tokens  = await exchangeCode(code);
                if (!tokens.access_token) throw new Error('No access token returned');

                const osuUser = await osuApiGet('me', tokens.access_token);
                if (!osuUser?.id) throw new Error('Could not fetch osu! user profile');

                const sessionToken = makeSessionToken();
                sessions.set(sessionToken, {
                    userId:    osuUser.id,
                    username:  osuUser.username,
                    avatarUrl: osuUser.avatar_url || null,
                    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
                });

                console.log(`  ✓ Login: ${osuUser.username} (${osuUser.id})`);

                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`<!DOCTYPE html><html><body>
                    <script>
                        window.opener?.postMessage({
                            type:      'osu-auth-success',
                            token:     '${sessionToken}',
                            userId:    ${osuUser.id},
                            username:  '${escapeHtml(osuUser.username)}',
                            avatarUrl: '${escapeHtml(osuUser.avatar_url||'')}',
                        }, '*');
                        window.close();
                    </script>
                    <p>✓ Logged in as <strong>${escapeHtml(osuUser.username)}</strong>. You can close this window.</p>
                </body></html>`);
            } catch (e) {
                console.error('  ✗ Auth callback error:', e.message);
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(`<!DOCTYPE html><html><body>
                    <script>window.opener?.postMessage({type:'osu-auth-error',error:'${escapeHtml(e.message)}'}, '*'); window.close();</script>
                    <p>Server error: ${escapeHtml(e.message)}. Close this window.</p>
                </body></html>`);
            }
            return;
        }

        if (method === 'GET' && pathname === '/auth/me') {
            const session = getSession(req);
            if (!session) { err(res, 401, 'Not logged in'); return; }
            json(res, 200, {
                userId:    session.userId,
                username:  session.username,
                avatarUrl: session.avatarUrl,
            });
            return;
        }

        if (method === 'POST' && pathname === '/auth/logout') {
            const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
            if (auth) sessions.delete(auth);
            json(res, 200, { ok: true });
            return;
        }

        // ── NOTES ─────────────────────────────────────────────────────────────

        if (method === 'GET' && pathname === '/notes') {
            const id = url.searchParams.get('beatmapsetId');
            if (!id) { err(res, 400, 'beatmapsetId required'); return; }
            setCORS(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mem.notes.filter(n => n.beatmapsetId === id)));
            return;
        }

        if (method === 'POST' && pathname === '/notes') {
            const data = await parseBody(req);
            if (!data.beatmapsetId || !data.text) { err(res, 400, 'beatmapsetId and text required'); return; }
            const note = {
                id:           data.id || `note_${uid()}`,
                time:         data.time || '00:00:000',
                author:       data.author || 'Anonymous',
                text:         data.text.trim(),
                beatmapsetId: data.beatmapsetId,
                resolved:     data.resolved || false,
                created:      data.created || Date.now(),
                reactions:    [],
                replies:      [],
            };
            mem.notes.push(note);
            mem.history.push({ type: 'note', author: note.author, beatmapsetId: note.beatmapsetId, timestamp: note.created, preview: note.text.slice(0, 100) });
            console.log(`  ✓ Note by ${note.author} [${note.beatmapsetId}]`);
            ok(res, note);
            return;
        }

        if (method === 'POST' && pathname === '/notes/react') {
            const { noteId, emoji, username, beatmapsetId } = await parseBody(req);
            if (!noteId || !emoji || !username) { err(res, 400, 'noteId, emoji, username required'); return; }
            const note = mem.notes.find(n => n.id === noteId || String(n.created) === String(noteId));
            if (!note) { err(res, 404, 'Note not found'); return; }
            if (!note.reactions) note.reactions = [];
            const idx = note.reactions.findIndex(r => r.emoji === emoji && r.username === username);
            if (idx >= 0) note.reactions.splice(idx, 1);
            else note.reactions.push({ emoji, username, timestamp: Date.now() });
            ok(res, note);
            return;
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
            ok(res, note);
            return;
        }

        if (method === 'DELETE' && pathname.startsWith('/notes/')) {
            const noteId = pathname.split('/')[2];
            const idx = mem.notes.findIndex(n => n.id === noteId || String(n.created) === noteId);
            if (idx === -1) { err(res, 404, 'Note not found'); return; }
            mem.notes.splice(idx, 1);
            ok(res, { deleted: true });
            return;
        }

        // ── CHAT ──────────────────────────────────────────────────────────────

        if (method === 'GET' && pathname === '/chat') {
            const id = url.searchParams.get('beatmapsetId');
            if (!id) { err(res, 400, 'beatmapsetId required'); return; }
            ok(res, mem.chat.filter(m => m.beatmapsetId === id).slice(-100));
            return;
        }

        if (method === 'POST' && pathname === '/chat') {
            const data = await parseBody(req);
            if (!data.beatmapsetId || !data.text || !data.author) { err(res, 400, 'beatmapsetId, text, author required'); return; }
            const msg = { id: `msg_${uid()}`, author: data.author, text: data.text.trim(), beatmapsetId: data.beatmapsetId, timestamp: data.timestamp || Date.now() };
            mem.chat.push(msg);
            mem.history.push({ type: 'chat', author: msg.author, beatmapsetId: msg.beatmapsetId, timestamp: msg.timestamp, preview: msg.text.slice(0, 100) });
            ok(res, msg);
            return;
        }

        // ── USERS ─────────────────────────────────────────────────────────────

        if (method === 'GET' && pathname === '/collab/users') {
            const id  = url.searchParams.get('beatmapsetId');
            const now = Date.now();
            let active = mem.users.filter(u => now - u.timestamp < 30000);
            if (id) active = active.filter(u => u.beatmapsetId === id);
            ok(res, active);
            return;
        }

        if (method === 'POST' && pathname === '/collab/users') {
            const data = await parseBody(req);
            if (!data.userId || !data.username) { err(res, 400, 'userId and username required'); return; }
            mem.users = mem.users.filter(u => u.userId !== data.userId);
            const presence = { userId: data.userId, username: data.username, avatarUrl: data.avatarUrl || null, beatmapsetId: data.beatmapsetId || null, timestamp: data.timestamp || Date.now() };
            mem.users.push(presence);
            ok(res, presence);
            return;
        }

        // ── HISTORY ───────────────────────────────────────────────────────────

        if (method === 'GET' && pathname === '/session/history') {
            const id    = url.searchParams.get('beatmapsetId');
            const limit = parseInt(url.searchParams.get('limit')) || 50;
            let h = id ? mem.history.filter(e => e.beatmapsetId === id) : mem.history;
            ok(res, h.slice(-limit));
            return;
        }

        // ── REVIEWS (GitHub-persisted) ─────────────────────────────────────────

        if (method === 'GET' && /^\/reviews\/\d{1,10}$/.test(pathname)) {
            const userId = pathname.split('/')[2];
            json(res, 200, reviews[userId] || []);
            return;
        }

        if (method === 'POST' && pathname === '/reviews') {
            // Must be logged in via osu! OAuth
            const session = getSession(req);
            if (!session) {
                err(res, 401, 'You must log in with your osu! account to post reviews');
                return;
            }

            const data         = await parseBody(req);
            const text         = (data.text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
            const targetUserId = String(data.targetUserId || '');
            const stars        = Number(data.stars);

            if (!targetUserId || !/^\d{1,10}$/.test(targetUserId))  { err(res, 400, 'Invalid targetUserId'); return; }
            if (!Number.isInteger(stars) || stars < 1 || stars > 5) { err(res, 400, 'stars must be 1–5'); return; }
            if (text.length < 5)   { err(res, 400, 'Review too short (min 5 chars)'); return; }
            if (text.length > 300) { err(res, 400, 'Review too long (max 300 chars)'); return; }
            if (String(session.userId) === targetUserId) { err(res, 400, 'You cannot review yourself'); return; }

            if (!reviews[targetUserId]) reviews[targetUserId] = [];
            if (reviews[targetUserId].some(r => String(r.authorUserId) === String(session.userId))) {
                json(res, 409, { error: 'You have already reviewed this player' }); return;
            }

            const review = {
                id:             uid(),
                authorUserId:   session.userId,
                authorUsername: session.username,
                stars,
                text,
                createdAt: new Date().toISOString(),
            };
            reviews[targetUserId].push(review);
            saveReviewsToGitHub();

            console.log(`  ✓ Review by ${session.username} (${session.userId}) for user ${targetUserId} (${stars}★)`);
            json(res, 201, { ok: true, id: review.id });
            return;
        }

        if (method === 'DELETE' && /^\/reviews\/\d{1,10}\/[\w]+$/.test(pathname)) {
            const session = getSession(req);
            if (!session) { err(res, 401, 'Not logged in'); return; }
            const [, , userId, reviewId] = pathname.split('/');
            if (!reviews[userId]) { err(res, 404, 'No reviews for that user'); return; }
            const review = reviews[userId].find(r => r.id === reviewId);
            if (!review) { err(res, 404, 'Review not found'); return; }
            if (String(review.authorUserId) !== String(session.userId)) {
                err(res, 403, 'You can only delete your own reviews'); return;
            }
            reviews[userId] = reviews[userId].filter(r => r.id !== reviewId);
            saveReviewsToGitHub();
            json(res, 200, { ok: true });
            return;
        }

        // ── HEALTH / STATS / ROOT ─────────────────────────────────────────────

        if (method === 'GET' && pathname === '/health') {
            ok(res, { status: 'healthy', uptime: process.uptime(), memory: process.memoryUsage(), version: '2.2.0' });
            return;
        }

        if (method === 'GET' && pathname === '/stats') {
            const totalReviews = Object.values(reviews).reduce((a, b) => a + b.length, 0);
            ok(res, {
                uptime:   Math.floor(process.uptime()),
                notes:    mem.notes.length,
                chat:     mem.chat.length,
                users:    mem.users.filter(u => Date.now() - u.timestamp < 30000).length,
                reviews:  totalReviews,
                sessions: sessions.size,
                storage:  GITHUB_TOKEN ? `github (${GITHUB_REPO})` : 'memory-only',
            });
            return;
        }

        if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

        if (method === 'GET' && pathname === '/') {
            const totalReviews = Object.values(reviews).reduce((a, b) => a + b.length, 0);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`<!DOCTYPE html><html><head><title>osu! Collab Server</title>
<style>body{font-family:Arial,sans-serif;max-width:700px;margin:50px auto;padding:20px;background:#1a1a1a;color:#eee}
h1{color:#ff66aa}.box{background:#2a2a2a;padding:16px;border-radius:8px;margin:12px 0}
.ep{background:#333;padding:8px;margin:5px 0;border-radius:4px;font-family:monospace;font-size:13px}
.m{color:#4caf50;font-weight:bold}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;margin-left:6px}
.ok{background:#1a3a1a;color:#4caf50;border:1px solid #4caf50}
.warn{background:#3a2a00;color:#ffa500;border:1px solid #ffa500}
a{color:#6bb6ff}</style></head><body>
<h1>🎵 osu! Collab Server</h1>
<div class="box">
  <p>✅ Running &nbsp;|&nbsp; Uptime: ${Math.floor(process.uptime())}s &nbsp;|&nbsp; Sessions: ${sessions.size}</p>
  <p>Reviews: ${totalReviews} &nbsp;|&nbsp; Storage:
    <span class="badge ${GITHUB_TOKEN ? 'ok' : 'warn'}">${GITHUB_TOKEN ? `✓ GitHub (${GITHUB_REPO})` : '⚠ memory only'}</span>
  </p>
  <p>OAuth:
    <span class="badge ${OSU_CLIENT_ID ? 'ok' : 'warn'}">${OSU_CLIENT_ID ? '✓ Configured' : '⚠ Not configured'}</span>
  </p>
</div>
<h2>Endpoints</h2>
<div class="ep"><span class="m">GET</span>    /auth/login</div>
<div class="ep"><span class="m">GET</span>    /auth/callback</div>
<div class="ep"><span class="m">GET</span>    /auth/me</div>
<div class="ep"><span class="m">POST</span>   /auth/logout</div>
<div class="ep"><span class="m">GET</span>    /reviews/:userId</div>
<div class="ep"><span class="m">POST</span>   /reviews  <em>(auth required)</em></div>
<div class="ep"><span class="m">DELETE</span> /reviews/:userId/:reviewId  <em>(auth required)</em></div>
<div class="ep"><span class="m">GET</span>    /notes?beatmapsetId=X</div>
<div class="ep"><span class="m">POST</span>   /notes | /notes/react | /notes/reply</div>
<div class="ep"><span class="m">GET/POST</span> /chat?beatmapsetId=X</div>
<div class="ep"><span class="m">GET/POST</span> /collab/users</div>
<div class="ep"><span class="m">GET</span>    /health | /stats</div>
<p><a href="/health">Health</a> | <a href="/stats">Stats</a></p>
</body></html>`);
            return;
        }

        err(res, 404, `Endpoint ${pathname} not found`);

    } catch (e) {
        console.error('  ✗', e.message);
        err(res, 500, `Server error: ${e.message}`);
    }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
loadReviewsFromGitHub().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log('\n' + '='.repeat(60));
        console.log('🎵  osu! Collab Server');
        console.log('='.repeat(60));
        console.log(`✓ http://0.0.0.0:${PORT}`);
        console.log(`✓ Reviews: ${GITHUB_TOKEN ? `GitHub → ${GITHUB_REPO}` : 'IN-MEMORY ONLY'}`);
        console.log(`✓ OAuth:   ${OSU_CLIENT_ID ? `Configured (redirect: ${REDIRECT_URI})` : 'NOT CONFIGURED'}`);
        console.log(`✓ Started: ${new Date().toLocaleString()}`);
        console.log('='.repeat(60) + '\n');
    });
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
process.on('uncaughtException',  e => { console.error('Uncaught:', e); process.exit(1); });
process.on('unhandledRejection', e => console.error('Unhandled:', e));
