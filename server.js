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
            res.on('end', () => {
                console.log('osu! token response status:', res.statusCode, 'body:', data);
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON from osu! token endpoint')); }
            });
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
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Invalid JSON from osu! API')); }
            });
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
    for (const [token, s] of sessions) {
        if (s.expiresAt < now) sessions.delete(token);
    }
}, 60000);

// ─── Frontend HTML ────────────────────────────────────────────────────────────
function buildHomePage() {
    const totalReviews = Object.values(reviews).reduce((a, b) => a + b.length, 0);
    const uptime = Math.floor(process.uptime());
    const uptimeStr = uptime < 60 ? `${uptime}s`
        : uptime < 3600 ? `${Math.floor(uptime/60)}m ${uptime%60}s`
        : `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>osu! Reviews</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Mono:wght@300;400;500&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
    --black: #0a0a0a;
    --white: #f5f5f0;
    --grey-1: #1a1a1a;
    --grey-2: #2a2a2a;
    --grey-3: #444;
    --grey-4: #888;
    --grey-5: #bbb;
    --accent: #e8e8e0;
    --line: rgba(255,255,255,0.08);
    --line-hi: rgba(255,255,255,0.18);
    --font-display: 'Instrument Serif', serif;
    --font-ui: 'Syne', sans-serif;
    --font-mono: 'DM Mono', monospace;
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
}

html { scroll-behavior: smooth; }

body {
    background: var(--black);
    color: var(--white);
    font-family: var(--font-ui);
    min-height: 100vh;
    overflow-x: hidden;
    cursor: none;
}

/* ── Custom cursor ── */
#cursor {
    position: fixed; top: 0; left: 0;
    width: 12px; height: 12px;
    background: var(--white);
    border-radius: 50%;
    pointer-events: none;
    z-index: 99999;
    transform: translate(-50%, -50%);
    transition: width 0.2s var(--ease-out), height 0.2s var(--ease-out), background 0.2s;
    mix-blend-mode: difference;
}
#cursor-ring {
    position: fixed; top: 0; left: 0;
    width: 36px; height: 36px;
    border: 1px solid rgba(255,255,255,0.4);
    border-radius: 50%;
    pointer-events: none;
    z-index: 99998;
    transform: translate(-50%, -50%);
    transition: transform 0.12s var(--ease-out), width 0.3s var(--ease-out), height 0.3s var(--ease-out);
}
body:has(a:hover) #cursor,
body:has(button:hover) #cursor { width: 20px; height: 20px; }

/* ── Noise overlay ── */
body::before {
    content: '';
    position: fixed; inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E");
    opacity: 0.025;
    pointer-events: none;
    z-index: 0;
}

/* ── Grid lines ── */
.grid-bg {
    position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background-image:
        linear-gradient(var(--line) 1px, transparent 1px),
        linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 80px 80px;
    mask-image: radial-gradient(ellipse 80% 80% at 50% 0%, black 0%, transparent 80%);
}

/* ── Layout ── */
.container {
    position: relative; z-index: 1;
    max-width: 1100px;
    margin: 0 auto;
    padding: 0 40px;
}

/* ── Header ── */
header {
    position: relative; z-index: 10;
    padding: 32px 0 24px;
    border-bottom: 1px solid var(--line);
}
.header-inner {
    display: flex; align-items: center; justify-content: space-between;
}
.logo {
    font-family: var(--font-display);
    font-size: 22px;
    letter-spacing: -0.5px;
    color: var(--white);
    display: flex; align-items: center; gap: 10px;
}
.logo-dot {
    width: 8px; height: 8px;
    background: var(--white);
    border-radius: 50%;
    animation: pulse-dot 2s ease infinite;
}
@keyframes pulse-dot {
    0%,100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.4); opacity: 0.6; }
}
.nav-status {
    display: flex; align-items: center; gap: 20px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--grey-4);
    letter-spacing: 0.5px;
}
.status-dot {
    width: 6px; height: 6px;
    background: #4ade80;
    border-radius: 50%;
    animation: pulse-dot 2s ease infinite;
    display: inline-block; margin-right: 5px;
}

/* ── Hero ── */
.hero {
    padding: 100px 0 80px;
    position: relative;
}
.hero-eyebrow {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 2px;
    color: var(--grey-4);
    text-transform: uppercase;
    margin-bottom: 24px;
    opacity: 0;
    animation: fadeUp 0.8s var(--ease-out) 0.1s forwards;
}
.hero-title {
    font-family: var(--font-display);
    font-size: clamp(52px, 7vw, 96px);
    line-height: 0.95;
    letter-spacing: -2px;
    color: var(--white);
    margin-bottom: 32px;
    opacity: 0;
    animation: fadeUp 0.8s var(--ease-out) 0.2s forwards;
}
.hero-title em {
    font-style: italic;
    color: var(--grey-5);
}
.hero-sub {
    font-size: 15px;
    color: var(--grey-4);
    max-width: 480px;
    line-height: 1.7;
    margin-bottom: 56px;
    opacity: 0;
    animation: fadeUp 0.8s var(--ease-out) 0.3s forwards;
}

/* ── Stats row ── */
.stats-row {
    display: flex; gap: 1px;
    border: 1px solid var(--line-hi);
    border-radius: 12px;
    overflow: hidden;
    max-width: 600px;
    opacity: 0;
    animation: fadeUp 0.8s var(--ease-out) 0.4s forwards;
}
.stat-box {
    flex: 1;
    padding: 20px 24px;
    background: rgba(255,255,255,0.02);
    border-right: 1px solid var(--line);
    transition: background 0.2s;
}
.stat-box:last-child { border-right: none; }
.stat-box:hover { background: rgba(255,255,255,0.05); }
.stat-num {
    font-family: var(--font-display);
    font-size: 36px;
    line-height: 1;
    color: var(--white);
    margin-bottom: 4px;
}
.stat-label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 1.5px;
    color: var(--grey-4);
    text-transform: uppercase;
}

/* ── Decorative circle ── */
.hero-circle {
    position: absolute;
    right: -60px; top: 40px;
    width: 340px; height: 340px;
    border: 1px solid var(--line-hi);
    border-radius: 50%;
    opacity: 0;
    animation: fadeIn 1.2s var(--ease-out) 0.5s forwards, spin-slow 40s linear infinite;
}
.hero-circle::before {
    content: '';
    position: absolute;
    top: 30px; left: 30px; right: 30px; bottom: 30px;
    border: 1px solid var(--line);
    border-radius: 50%;
}
.hero-circle::after {
    content: '';
    position: absolute;
    top: 50%; left: -4px;
    width: 8px; height: 8px;
    background: var(--white);
    border-radius: 50%;
    transform: translateY(-50%);
}
@keyframes spin-slow { to { transform: rotate(360deg); } }

/* ── Section ── */
.section {
    padding: 80px 0;
    border-top: 1px solid var(--line);
}
.section-label {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 2px;
    color: var(--grey-4);
    text-transform: uppercase;
    margin-bottom: 48px;
    display: flex; align-items: center; gap: 16px;
}
.section-label::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--line);
}

/* ── Login panel ── */
.login-panel {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    border: 1px solid var(--line-hi);
    border-radius: 16px;
    overflow: hidden;
    max-width: 780px;
}
.login-info {
    padding: 48px;
    background: rgba(255,255,255,0.02);
}
.login-info h2 {
    font-family: var(--font-display);
    font-size: 32px;
    line-height: 1.1;
    margin-bottom: 16px;
    letter-spacing: -0.5px;
}
.login-info p {
    font-size: 14px;
    color: var(--grey-4);
    line-height: 1.7;
    margin-bottom: 32px;
}
.feature-list {
    list-style: none;
    display: flex; flex-direction: column; gap: 10px;
}
.feature-list li {
    font-size: 13px;
    color: var(--grey-5);
    display: flex; align-items: center; gap: 10px;
    font-family: var(--font-mono);
}
.feature-list li::before {
    content: '→';
    color: var(--grey-3);
}
.login-action {
    padding: 48px;
    background: rgba(255,255,255,0.03);
    display: flex; flex-direction: column; justify-content: center; align-items: center;
    text-align: center;
    gap: 24px;
}
.avatar-placeholder {
    width: 80px; height: 80px;
    border-radius: 50%;
    border: 1px solid var(--line-hi);
    background: var(--grey-1);
    display: flex; align-items: center; justify-content: center;
    font-size: 28px;
    position: relative;
    overflow: hidden;
    transition: all 0.3s var(--ease-out);
}
.avatar-placeholder img {
    width: 100%; height: 100%;
    object-fit: cover;
    display: none;
}
.avatar-placeholder.loaded img { display: block; }
.avatar-placeholder.loaded .avatar-icon { display: none; }
#user-name {
    font-family: var(--font-display);
    font-size: 24px;
    letter-spacing: -0.5px;
}
#user-meta {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--grey-4);
    letter-spacing: 0.5px;
}

/* ── Buttons ── */
.btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 12px 28px;
    border-radius: 8px;
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.3px;
    cursor: none;
    border: none;
    transition: all 0.2s var(--ease-out);
    text-decoration: none;
}
.btn-primary {
    background: var(--white);
    color: var(--black);
}
.btn-primary:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(255,255,255,0.15);
}
.btn-ghost {
    background: transparent;
    color: var(--white);
    border: 1px solid var(--line-hi);
}
.btn-ghost:hover {
    background: rgba(255,255,255,0.06);
    border-color: rgba(255,255,255,0.3);
}
.btn-danger {
    background: transparent;
    color: #ff6b6b;
    border: 1px solid rgba(255,107,107,0.3);
    font-size: 12px;
    padding: 8px 16px;
}
.btn-danger:hover {
    background: rgba(255,107,107,0.08);
}

/* ── Player search ── */
.search-row {
    display: flex; gap: 12px; margin-bottom: 40px;
    max-width: 520px;
}
.search-input {
    flex: 1;
    padding: 12px 16px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--line-hi);
    border-radius: 8px;
    color: var(--white);
    font-family: var(--font-ui);
    font-size: 13px;
    outline: none;
    transition: all 0.2s;
    cursor: none;
}
.search-input::placeholder { color: var(--grey-3); }
.search-input:focus { border-color: rgba(255,255,255,0.35); background: rgba(255,255,255,0.06); }

/* ── Profile card ── */
.profile-card {
    border: 1px solid var(--line-hi);
    border-radius: 16px;
    overflow: hidden;
    max-width: 780px;
    opacity: 0;
    transform: translateY(16px);
    transition: all 0.4s var(--ease-out);
}
.profile-card.visible { opacity: 1; transform: translateY(0); }
.profile-header {
    padding: 40px 48px;
    background: rgba(255,255,255,0.03);
    display: flex; align-items: center; gap: 28px;
    border-bottom: 1px solid var(--line);
    position: relative;
    overflow: hidden;
}
.profile-header::before {
    content: '';
    position: absolute; inset: 0;
    background: radial-gradient(ellipse 60% 80% at 0% 50%, rgba(255,255,255,0.03) 0%, transparent 70%);
    pointer-events: none;
}
.profile-avatar {
    width: 88px; height: 88px;
    border-radius: 50%;
    border: 2px solid var(--line-hi);
    object-fit: cover;
    flex-shrink: 0;
}
.profile-info h3 {
    font-family: var(--font-display);
    font-size: 28px;
    letter-spacing: -0.5px;
    margin-bottom: 6px;
}
.profile-info .profile-meta {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--grey-4);
    letter-spacing: 0.5px;
    display: flex; gap: 16px; flex-wrap: wrap;
}
.profile-meta-item { color: var(--grey-5); }
.profile-meta-item span { color: var(--grey-4); }

/* ── Reviews list ── */
.reviews-body {
    padding: 32px 48px 40px;
}
.reviews-empty {
    text-align: center; padding: 48px 24px;
    color: var(--grey-4);
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.8;
}
.reviews-empty .empty-icon { font-size: 32px; margin-bottom: 12px; opacity: 0.4; }

.review-item {
    padding: 20px 0;
    border-bottom: 1px solid var(--line);
    opacity: 0;
    animation: fadeUp 0.4s var(--ease-out) forwards;
}
.review-item:last-child { border-bottom: none; padding-bottom: 0; }
.review-top {
    display: flex; justify-content: space-between; align-items: flex-start;
    margin-bottom: 10px;
}
.review-author-row {
    display: flex; align-items: center; gap: 12px;
}
.review-author-avatar {
    width: 32px; height: 32px;
    border-radius: 50%;
    border: 1px solid var(--line-hi);
    object-fit: cover;
    background: var(--grey-2);
    flex-shrink: 0;
}
.review-author-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--white);
    text-decoration: none;
}
.review-author-name:hover { text-decoration: underline; }
.review-date {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--grey-4);
    margin-top: 2px;
}
.review-stars {
    display: flex; gap: 2px;
}
.star { font-size: 13px; color: var(--grey-3); }
.star.filled { color: #e8e0a0; }
.review-text {
    font-size: 14px;
    color: var(--grey-5);
    line-height: 1.65;
    padding-left: 44px;
}

/* ── Write review ── */
.write-panel {
    margin-top: 32px;
    border: 1px solid var(--line-hi);
    border-radius: 12px;
    overflow: hidden;
    max-width: 780px;
}
.write-header {
    padding: 16px 24px;
    background: rgba(255,255,255,0.03);
    border-bottom: 1px solid var(--line);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 1.5px;
    color: var(--grey-4);
    text-transform: uppercase;
    display: flex; justify-content: space-between; align-items: center;
}
.write-body { padding: 24px; }
.write-stars {
    display: flex; gap: 6px; margin-bottom: 16px;
}
.write-star {
    background: none; border: none;
    font-size: 22px; color: var(--grey-3);
    cursor: none; padding: 2px;
    transition: all 0.1s; line-height: 1;
}
.write-star.active { color: #e8e0a0; transform: scale(1.1); }
.write-star:hover { transform: scale(1.2); }
.write-textarea {
    width: 100%;
    min-height: 80px;
    resize: vertical;
    background: rgba(255,255,255,0.03);
    border: 1px solid var(--line-hi);
    border-radius: 8px;
    color: var(--white);
    font-family: var(--font-ui);
    font-size: 14px;
    line-height: 1.6;
    padding: 12px 16px;
    outline: none;
    margin-bottom: 12px;
    transition: border-color 0.2s;
    cursor: none;
}
.write-textarea:focus { border-color: rgba(255,255,255,0.3); }
.write-textarea::placeholder { color: var(--grey-3); }
.write-footer {
    display: flex; justify-content: space-between; align-items: center;
}
.write-char {
    font-family: var(--font-mono);
    font-size: 11px; color: var(--grey-4);
}
.write-err {
    font-size: 12px; color: #ff6b6b;
    margin-top: 8px;
    font-family: var(--font-mono);
}

/* ── API docs ── */
.api-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1px;
    border: 1px solid var(--line-hi);
    border-radius: 12px;
    overflow: hidden;
}
.api-item {
    padding: 20px 24px;
    background: rgba(255,255,255,0.02);
    transition: background 0.2s;
}
.api-item:hover { background: rgba(255,255,255,0.04); }
.api-method {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 1px;
    font-weight: 500;
    margin-bottom: 6px;
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
}
.method-get  { background: rgba(74,222,128,0.1); color: #4ade80; }
.method-post { background: rgba(147,197,253,0.1); color: #93c5fd; }
.method-del  { background: rgba(252,165,165,0.1); color: #fca5a5; }
.api-path {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--white);
    margin-bottom: 4px;
}
.api-desc {
    font-size: 12px;
    color: var(--grey-4);
    line-height: 1.5;
}

/* ── Footer ── */
footer {
    border-top: 1px solid var(--line);
    padding: 40px 0;
    margin-top: 80px;
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 16px;
}
.footer-left {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--grey-4);
    letter-spacing: 0.5px;
}
.footer-right {
    display: flex; gap: 24px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--grey-4);
}
.footer-right a { color: var(--grey-4); text-decoration: none; }
.footer-right a:hover { color: var(--white); }

/* ── Animations ── */
@keyframes fadeUp {
    from { opacity: 0; transform: translateY(20px); }
    to   { opacity: 1; transform: translateY(0); }
}
@keyframes fadeIn {
    from { opacity: 0; }
    to   { opacity: 1; }
}

/* ── Notification ── */
.notif {
    position: fixed; top: 24px; right: 24px;
    padding: 12px 20px;
    border-radius: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.3px;
    z-index: 9999;
    pointer-events: none;
    animation: slideNotif 0.3s var(--ease-out);
    border: 1px solid;
}
@keyframes slideNotif {
    from { opacity: 0; transform: translateX(20px); }
    to   { opacity: 1; transform: translateX(0); }
}
.notif-success { background: #0a0a0a; border-color: #4ade80; color: #4ade80; }
.notif-error   { background: #0a0a0a; border-color: #ff6b6b; color: #ff6b6b; }
.notif-info    { background: #0a0a0a; border-color: #93c5fd; color: #93c5fd; }

/* ── Auth section states ── */
#logged-out-state, #logged-in-state { transition: all 0.3s; }
.hidden { display: none !important; }

/* ── Loading spinner ── */
.spinner {
    display: inline-block;
    width: 16px; height: 16px;
    border: 2px solid rgba(255,255,255,0.1);
    border-top-color: var(--white);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    vertical-align: middle; margin-right: 6px;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Reveal animation for sections ── */
.reveal {
    opacity: 0;
    transform: translateY(24px);
    transition: opacity 0.6s var(--ease-out), transform 0.6s var(--ease-out);
}
.reveal.in-view { opacity: 1; transform: none; }

@media (max-width: 700px) {
    .container { padding: 0 20px; }
    .login-panel { grid-template-columns: 1fr; }
    .hero-title { font-size: 44px; }
    .hero-circle { display: none; }
    .profile-header { flex-direction: column; align-items: flex-start; }
    .stats-row { flex-direction: column; }
}
</style>
</head>
<body>

<div id="cursor"></div>
<div id="cursor-ring"></div>
<div class="grid-bg"></div>

<div class="container">

<!-- ── Header ── -->
<header>
    <div class="header-inner">
        <div class="logo">
            <div class="logo-dot"></div>
            osu! reviews
        </div>
        <div class="nav-status">
            <span><span class="status-dot"></span>online</span>
            <span id="nav-uptime" style="font-family:var(--font-mono)">uptime: ${uptimeStr}</span>
            <span>${totalReviews} reviews</span>
        </div>
    </div>
</header>

<!-- ── Hero ── -->
<section class="hero">
    <div class="hero-circle"></div>
    <div class="hero-eyebrow">osu! player reviews</div>
    <h1 class="hero-title">
        leave your<br>
        <em>mark.</em>
    </h1>
    <p class="hero-sub">
        A community review system for osu! players.
        Log in with your osu! account, search any player, and share your experience.
    </p>
    <div class="stats-row">
        <div class="stat-box">
            <div class="stat-num" id="stat-reviews">${totalReviews}</div>
            <div class="stat-label">Reviews</div>
        </div>
        <div class="stat-box">
            <div class="stat-num" id="stat-sessions">${sessions.size}</div>
            <div class="stat-label">Active sessions</div>
        </div>
        <div class="stat-box">
            <div class="stat-num">${GITHUB_TOKEN ? '✓' : '—'}</div>
            <div class="stat-label">Persistent storage</div>
        </div>
    </div>
</section>

<!-- ── Login ── -->
<section class="section reveal" id="login-section">
    <div class="section-label">01 — authentication</div>

    <div class="login-panel">
        <div class="login-info">
            <h2>Connect your osu! account</h2>
            <p>Sign in with osu! OAuth to write reviews, manage your existing reviews, and track your activity.</p>
            <ul class="feature-list">
                <li>Write reviews for any player</li>
                <li>Star ratings from 1 to 5</li>
                <li>Delete your own reviews</li>
                <li>Persistent across sessions</li>
            </ul>
        </div>
        <div class="login-action">
            <!-- Logged out -->
            <div id="logged-out-state">
                <div class="avatar-placeholder" id="avatar-placeholder">
                    <span class="avatar-icon">♪</span>
                    <img id="avatar-img" alt="">
                </div>
                <div style="margin-top: 16px;">
                    <p style="font-size:13px;color:var(--grey-4);margin-bottom:20px;">You are not logged in.</p>
                    <button class="btn btn-primary" id="login-btn" onclick="doLogin()">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 18c-4.418 0-8-3.582-8-8s3.582-8 8-8 8 3.582 8 8-3.582 8-8 8zm-1-13v6l5 3-1 1.732-6-3.464V7h2z"/></svg>
                        Login with osu!
                    </button>
                    <div class="write-err" id="login-err" style="margin-top:10px;"></div>
                </div>
            </div>
            <!-- Logged in -->
            <div id="logged-in-state" class="hidden">
                <div class="avatar-placeholder" id="user-avatar-wrap">
                    <span class="avatar-icon">♪</span>
                    <img id="user-avatar" alt="">
                </div>
                <div id="user-name" style="margin-top:12px;"></div>
                <div id="user-meta"></div>
                <button class="btn btn-danger" style="margin-top:16px;" onclick="doLogout()">Log out</button>
            </div>
        </div>
    </div>
</section>

<!-- ── Player search ── -->
<section class="section reveal" id="search-section">
    <div class="section-label">02 — player reviews</div>

    <div class="search-row">
        <input
            type="text"
            class="search-input"
            id="player-input"
            placeholder="Enter osu! user ID or username…"
            autocomplete="off"
        >
        <button class="btn btn-ghost" onclick="searchPlayer()">Search</button>
    </div>

    <!-- Profile card -->
    <div class="profile-card" id="profile-card">
        <div class="profile-header" id="profile-header">
            <img class="profile-avatar" id="profile-avatar" src="" alt="">
            <div class="profile-info">
                <h3 id="profile-name"></h3>
                <div class="profile-meta" id="profile-meta"></div>
            </div>
        </div>
        <div class="reviews-body" id="reviews-body">
            <div class="reviews-empty">
                <div class="empty-icon">◇</div>
                <div>No reviews yet.</div>
            </div>
        </div>
    </div>

    <!-- Write review -->
    <div class="write-panel hidden" id="write-panel">
        <div class="write-header">
            <span>Write a review</span>
            <span id="write-header-user" style="color:var(--grey-5);"></span>
        </div>
        <div class="write-body">
            <div class="write-stars" id="write-stars">
                <button class="write-star" data-star="1" onclick="setStar(1)">★</button>
                <button class="write-star" data-star="2" onclick="setStar(2)">★</button>
                <button class="write-star" data-star="3" onclick="setStar(3)">★</button>
                <button class="write-star" data-star="4" onclick="setStar(4)">★</button>
                <button class="write-star" data-star="5" onclick="setStar(5)">★</button>
            </div>
            <textarea
                class="write-textarea"
                id="write-textarea"
                placeholder="Share your experience with this player… (be respectful)"
                maxlength="300"
                oninput="onTextareaInput()"
            ></textarea>
            <div class="write-footer">
                <button class="btn btn-primary" id="submit-btn" onclick="submitReview()" disabled>Submit review</button>
                <span class="write-char" id="write-char">0 / 300</span>
            </div>
            <div class="write-err" id="write-err"></div>
        </div>
    </div>
    <div id="login-prompt" class="hidden" style="margin-top:16px;font-family:var(--font-mono);font-size:12px;color:var(--grey-4);">
        → <a href="#login-section" style="color:var(--grey-5);text-decoration:underline;">Log in</a> to write a review for this player.
    </div>
</section>

<!-- ── API ── -->
<section class="section reveal" id="api-section">
    <div class="section-label">03 — api reference</div>
    <div class="api-grid">
        <div class="api-item">
            <span class="api-method method-get">GET</span>
            <div class="api-path">/auth/login</div>
            <div class="api-desc">Returns osu! OAuth authorization URL</div>
        </div>
        <div class="api-item">
            <span class="api-method method-get">GET</span>
            <div class="api-path">/auth/me</div>
            <div class="api-desc">Returns current session user info</div>
        </div>
        <div class="api-item">
            <span class="api-method method-post">POST</span>
            <div class="api-path">/auth/logout</div>
            <div class="api-desc">Destroys current session</div>
        </div>
        <div class="api-item">
            <span class="api-method method-get">GET</span>
            <div class="api-path">/reviews/:userId</div>
            <div class="api-desc">Fetch all reviews for a player</div>
        </div>
        <div class="api-item">
            <span class="api-method method-post">POST</span>
            <div class="api-path">/reviews</div>
            <div class="api-desc">Post a review (auth required)</div>
        </div>
        <div class="api-item">
            <span class="api-method method-del">DELETE</span>
            <div class="api-path">/reviews/:uid/:rid</div>
            <div class="api-desc">Delete your own review</div>
        </div>
        <div class="api-item">
            <span class="api-method method-get">GET</span>
            <div class="api-path">/health</div>
            <div class="api-desc">Server health & uptime</div>
        </div>
        <div class="api-item">
            <span class="api-method method-get">GET</span>
            <div class="api-path">/stats</div>
            <div class="api-desc">Review counts & storage info</div>
        </div>
    </div>
</section>

</div><!-- /container -->

<div class="container">
<footer>
    <div class="footer-left">osu! reviews server — github persisted</div>
    <div class="footer-right">
        <a href="/health">health</a>
        <a href="/stats">stats</a>
        <span style="color:var(--grey-3)">v2.3.0</span>
    </div>
</footer>
</div>

<script>
// ── Cursor ──────────────────────────────────────────────────────────────────
const cursor = document.getElementById('cursor');
const ring   = document.getElementById('cursor-ring');
let mx = 0, my = 0, rx = 0, ry = 0;
document.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; cursor.style.left = mx + 'px'; cursor.style.top = my + 'px'; });
(function animRing() {
    rx += (mx - rx) * 0.14; ry += (my - ry) * 0.14;
    ring.style.left = rx + 'px'; ring.style.top = ry + 'px';
    requestAnimationFrame(animRing);
})();

// ── Reveal on scroll ────────────────────────────────────────────────────────
const observer = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in-view'); observer.unobserve(e.target); } });
}, { threshold: 0.1 });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// ── State ───────────────────────────────────────────────────────────────────
let sessionToken   = localStorage.getItem('osu_session_token') || null;
let sessionUser    = null;
let currentUserId  = null;
let selectedStars  = 0;
let authPopup      = null;

// ── Notify ──────────────────────────────────────────────────────────────────
function notify(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = 'notif notif-' + type;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 3000);
}

// ── Auth ────────────────────────────────────────────────────────────────────
async function doLogin() {
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('login-err');
    btn.innerHTML = '<span class="spinner"></span>Opening osu!…';
    btn.disabled = true;
    errEl.textContent = '';
    try {
        const r = await fetch('/auth/login');
        const data = await r.json();
        if (!data.url) throw new Error('Server did not return login URL');
        authPopup = window.open(data.url, 'osu-auth', 'width=520,height=720,scrollbars=yes');
        if (!authPopup) throw new Error('Popup blocked — please allow popups');
        const timeout = setTimeout(() => {
            window.removeEventListener('message', handler);
            errEl.textContent = '✗ Login timed out';
            btn.innerHTML = 'Login with osu!'; btn.disabled = false;
        }, 120000);
        function handler(e) {
            if (e.data?.type === 'osu-auth-success') {
                clearTimeout(timeout);
                window.removeEventListener('message', handler);
                sessionToken = e.data.token;
                localStorage.setItem('osu_session_token', sessionToken);
                sessionUser = { userId: e.data.userId, username: e.data.username, avatarUrl: e.data.avatarUrl };
                renderLoggedIn();
                notify('✓ Logged in as ' + e.data.username, 'success');
            } else if (e.data?.type === 'osu-auth-error') {
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
    if (sessionToken) {
        await fetch('/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + sessionToken } }).catch(() => {});
    }
    sessionToken = null; sessionUser = null;
    localStorage.removeItem('osu_session_token');
    renderLoggedOut();
    notify('Logged out', 'info');
}

async function verifySession() {
    if (!sessionToken) return;
    try {
        const r = await fetch('/auth/me', { headers: { 'Authorization': 'Bearer ' + sessionToken } });
        if (r.ok) {
            const body = await r.json();
            sessionUser = body.data ?? body;
            renderLoggedIn();
        } else {
            sessionToken = null; sessionUser = null;
            localStorage.removeItem('osu_session_token');
            renderLoggedOut();
        }
    } catch {}
}

function renderLoggedIn() {
    document.getElementById('logged-out-state').classList.add('hidden');
    document.getElementById('logged-in-state').classList.remove('hidden');
    document.getElementById('user-name').textContent = sessionUser.username;
    document.getElementById('user-meta').textContent = 'user id: ' + sessionUser.userId;
    const avatarWrap = document.getElementById('user-avatar-wrap');
    if (sessionUser.avatarUrl) {
        const img = document.getElementById('user-avatar');
        img.src = sessionUser.avatarUrl;
        img.onload = () => avatarWrap.classList.add('loaded');
    }
    document.getElementById('write-header-user').textContent = 'as ' + sessionUser.username;
    updateWritePanel();
}

function renderLoggedOut() {
    document.getElementById('logged-in-state').classList.add('hidden');
    document.getElementById('logged-out-state').classList.remove('hidden');
    document.getElementById('login-btn').innerHTML = 'Login with osu!';
    document.getElementById('login-btn').disabled = false;
    updateWritePanel();
}

// ── Player search ────────────────────────────────────────────────────────────
document.getElementById('player-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') searchPlayer();
});

async function searchPlayer() {
    const val = document.getElementById('player-input').value.trim();
    if (!val) return;
    const card = document.getElementById('profile-card');
    card.classList.remove('visible');

    // Try to load reviews directly (userId) or look up by username via osu! API (if numeric)
    const isNumeric = /^\d+$/.test(val);
    const userId = isNumeric ? val : null;

    if (!userId) {
        notify('Please enter a numeric osu! user ID', 'error');
        return;
    }

    currentUserId = userId;

    // Fetch avatar from osu! (best-effort, requires token from server side — we'll just use a placeholder)
    document.getElementById('profile-name').textContent = 'User #' + userId;
    document.getElementById('profile-avatar').src = 'https://a.ppy.sh/' + userId;
    document.getElementById('profile-meta').innerHTML =
        '<span class="profile-meta-item"><span>id</span> ' + userId + '</span>' +
        '<a href="https://osu.ppy.sh/users/' + userId + '" target="_blank" style="color:var(--grey-4);font-size:11px;font-family:var(--font-mono)">→ osu! profile</a>';

    document.getElementById('reviews-body').innerHTML = '<div class="reviews-empty"><span class="spinner"></span></div>';
    card.classList.add('visible');

    await loadReviews(userId);
    updateWritePanel();
}

async function loadReviews(userId) {
    const body = document.getElementById('reviews-body');
    try {
        const r = await fetch('/reviews/' + userId);
        const revs = await r.json();
        if (!Array.isArray(revs) || revs.length === 0) {
            body.innerHTML = '<div class="reviews-empty"><div class="empty-icon">◇</div><div>No reviews for this player yet.</div></div>';
            return;
        }
        body.innerHTML = '';
        revs.slice().reverse().forEach((rv, i) => {
            const el = document.createElement('div');
            el.className = 'review-item';
            el.style.animationDelay = (i * 0.05) + 's';
            el.innerHTML =
                '<div class="review-top">' +
                    '<div class="review-author-row">' +
                        '<img class="review-author-avatar" src="https://a.ppy.sh/' + escHtml(rv.authorUserId) + '" onerror="this.src=\\'data:image/svg+xml,<svg xmlns=\\\\'http://www.w3.org/2000/svg\\\\'><rect width=\\'32\\' height=\\'32\\' fill=\\'%231a1a1a\\'/></svg>\\'" alt="">' +
                        '<div>' +
                            '<a class="review-author-name" href="https://osu.ppy.sh/users/' + escHtml(rv.authorUserId) + '" target="_blank">' + escHtml(rv.authorUsername) + '</a>' +
                            '<div class="review-date">' + new Date(rv.createdAt).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}) + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="review-stars">' +
                        [1,2,3,4,5].map(n => '<span class="star' + (n <= rv.stars ? ' filled' : '') + '">★</span>').join('') +
                    '</div>' +
                '</div>' +
                '<div class="review-text">' + escHtml(rv.text) + '</div>' +
                (sessionUser && String(sessionUser.userId) === String(rv.authorUserId)
                    ? '<div style="padding-left:44px;margin-top:10px;"><button class="btn btn-danger" onclick="deleteReview(' + JSON.stringify(userId) + ',' + JSON.stringify(rv.id) + ')">Delete</button></div>'
                    : '');
            body.appendChild(el);
        });
    } catch {
        body.innerHTML = '<div class="reviews-empty"><div class="empty-icon">!</div><div>Failed to load reviews.</div></div>';
    }
}

async function deleteReview(userId, reviewId) {
    if (!sessionToken) return;
    if (!confirm('Delete this review?')) return;
    const r = await fetch('/reviews/' + userId + '/' + reviewId, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + sessionToken }
    });
    if (r.ok) { notify('Review deleted', 'success'); await loadReviews(userId); }
    else { const d = await r.json().catch(() => ({})); notify('✗ ' + (d.error || 'Error'), 'error'); }
}

// ── Write review ─────────────────────────────────────────────────────────────
function updateWritePanel() {
    const panel  = document.getElementById('write-panel');
    const prompt = document.getElementById('login-prompt');
    if (!currentUserId) { panel.classList.add('hidden'); prompt.classList.add('hidden'); return; }
    if (!sessionUser)   { panel.classList.add('hidden'); prompt.classList.remove('hidden'); return; }
    if (String(sessionUser.userId) === String(currentUserId)) {
        panel.classList.add('hidden'); prompt.classList.add('hidden'); return;
    }
    panel.classList.remove('hidden');
    prompt.classList.add('hidden');
}

function setStar(n) {
    selectedStars = n;
    document.querySelectorAll('.write-star').forEach(b => {
        b.classList.toggle('active', +b.dataset.star <= n);
    });
    validateSubmit();
}

document.getElementById('write-stars').addEventListener('mouseover', e => {
    const btn = e.target.closest('.write-star');
    if (!btn) return;
    const n = +btn.dataset.star;
    document.querySelectorAll('.write-star').forEach(b => b.classList.toggle('active', +b.dataset.star <= n));
});
document.getElementById('write-stars').addEventListener('mouseleave', () => {
    document.querySelectorAll('.write-star').forEach(b => b.classList.toggle('active', +b.dataset.star <= selectedStars));
});

function onTextareaInput() {
    const ta = document.getElementById('write-textarea');
    document.getElementById('write-char').textContent = ta.value.length + ' / 300';
    validateSubmit();
}

function validateSubmit() {
    const ta = document.getElementById('write-textarea');
    const ok = ta.value.trim().length >= 5 && selectedStars > 0;
    document.getElementById('submit-btn').disabled = !ok;
}

async function submitReview() {
    if (!sessionToken || !currentUserId) return;
    const text  = document.getElementById('write-textarea').value.trim();
    const errEl = document.getElementById('write-err');
    const btn   = document.getElementById('submit-btn');
    errEl.textContent = '';
    if (!text || selectedStars === 0) return;
    btn.innerHTML = '<span class="spinner"></span>Submitting…'; btn.disabled = true;
    try {
        const r = await fetch('/reviews', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sessionToken },
            body: JSON.stringify({ targetUserId: currentUserId, stars: selectedStars, text })
        });
        const data = await r.json();
        if (r.ok) {
            document.getElementById('write-textarea').value = '';
            document.getElementById('write-char').textContent = '0 / 300';
            selectedStars = 0;
            document.querySelectorAll('.write-star').forEach(b => b.classList.remove('active'));
            notify('✓ Review posted!', 'success');
            await loadReviews(currentUserId);
        } else if (r.status === 401) {
            sessionToken = null; sessionUser = null;
            localStorage.removeItem('osu_session_token');
            renderLoggedOut();
            errEl.textContent = '✗ Session expired — please log in again';
        } else {
            errEl.textContent = '✗ ' + (data.error || 'Server error');
        }
    } catch {
        errEl.textContent = '✗ Could not reach server';
    } finally {
        btn.innerHTML = 'Submit review';
        validateSubmit();
    }
}

// ── Utils ────────────────────────────────────────────────────────────────────
function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ─────────────────────────────────────────────────────────────────────
verifySession();
</script>
</body>
</html>`;
}

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
                    <script>window.opener?.postMessage({type:'osu-auth-error',error:'${escapeHtml(error||'no code')}'}, '*'); window.close();<\/script>
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
                    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
                });

                console.log(`  ✓ Login: ${osuUser.username} (${osuUser.id})`);

                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`<!DOCTYPE html><html><head><style>
                    body{background:#0a0a0a;color:#f5f5f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;}
                    p{font-size:16px;} strong{color:#4ade80;}
                </style></head><body>
                    <p>✓ Logged in as <strong>${escapeHtml(osuUser.username)}</strong></p>
                    <p style="font-size:12px;opacity:0.5">Closing window…</p>
                    <script>
                        window.opener?.postMessage({
                            type:      'osu-auth-success',
                            token:     '${sessionToken}',
                            userId:    ${osuUser.id},
                            username:  '${escapeHtml(osuUser.username)}',
                            avatarUrl: '${escapeHtml(osuUser.avatar_url||'')}',
                        }, '*');
                        setTimeout(() => window.close(), 1200);
                    <\/script>
                </body></html>`);
            } catch (e) {
                console.error('  ✗ Auth callback error:', e.message);
                res.writeHead(500, { 'Content-Type': 'text/html' });
                res.end(`<!DOCTYPE html><html><body>
                    <script>window.opener?.postMessage({type:'osu-auth-error',error:'${escapeHtml(e.message)}'}, '*'); window.close();<\/script>
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
            ok(res, { status: 'healthy', uptime: process.uptime(), memory: process.memoryUsage(), version: '2.3.0' });
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
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(buildHomePage());
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
