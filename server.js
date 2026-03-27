// Save as: collabserver.js
// Run with: node collabserver.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'collab-data');

// Initialize data directory structure
console.log('Initializing server...');
initializeDataDirectory();

// Data stores with automatic file persistence
class DataStore {
    constructor(filename, defaultValue = []) {
        this.filename = filename;
        this.filepath = path.join(DATA_DIR, filename);
        this.data = this.load(defaultValue);
        this.isDirty = false;
        
        // Auto-save on changes
        this.saveInterval = setInterval(() => {
            if (this.isDirty) {
                this.save();
                this.isDirty = false;
            }
        }, 5000); // Save every 5 seconds if changed
    }

    load(defaultValue) {
        try {
            if (fs.existsSync(this.filepath)) {
                const content = fs.readFileSync(this.filepath, 'utf8');
                const parsed = JSON.parse(content);
                console.log(`✓ Loaded ${this.filename}: ${Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length} items`);
                return parsed;
            } else {
                console.log(`→ Creating new ${this.filename}`);
                this.data = defaultValue;
                this.save();
                return defaultValue;
            }
        } catch (error) {
            console.error(`✗ Failed to load ${this.filename}:`, error.message);
            return defaultValue;
        }
    }

    save() {
        try {
            const json = JSON.stringify(this.data, null, 2);
            fs.writeFileSync(this.filepath, json, 'utf8');
            return true;
        } catch (error) {
            console.error(`✗ Failed to save ${this.filename}:`, error.message);
            return false;
        }
    }

    get() {
        return this.data;
    }

    set(newData) {
        this.data = newData;
        this.isDirty = true;
    }

    push(item) {
        if (Array.isArray(this.data)) {
            this.data.push(item);
            this.isDirty = true;
        }
    }

    filter(predicate) {
        if (Array.isArray(this.data)) {
            return this.data.filter(predicate);
        }
        return [];
    }

    find(predicate) {
        if (Array.isArray(this.data)) {
            return this.data.find(predicate);
        }
        return null;
    }

    destroy() {
        clearInterval(this.saveInterval);
        if (this.isDirty) {
            this.save();
        }
    }
}

// Initialize data stores
const stores = {
    notes: new DataStore('notes.json', []),
    chat: new DataStore('chat.json', []),
    users: new DataStore('users.json', []),
    history: new DataStore('history.json', []),
    reviews: new DataStore('reviews.json', {}),
    metadata: new DataStore('metadata.json', {
        serverStarted: Date.now(),
        totalNotes: 0,
        totalMessages: 0,
        totalReactions: 0,
        totalReplies: 0
    })
};

function initializeDataDirectory() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            console.log(`✓ Created data directory: ${DATA_DIR}`);
        } else {
            console.log(`✓ Data directory exists: ${DATA_DIR}`);
        }

        // Create README
        const readme = `# osu! Collab Server Data

This directory contains all collaboration data for the osu! Modding TB script.

## Files:
- notes.json: All collaboration notes with reactions and replies
- chat.json: Chat messages for each beatmapset
- users.json: Active user presence data (auto-cleaned)
- history.json: Session history of all activities
- metadata.json: Server statistics and metadata

## Backup:
Copy this entire folder to backup all collaboration data.

Last updated: ${new Date().toISOString()}
`;
        fs.writeFileSync(path.join(DATA_DIR, 'README.txt'), readme);

        return true;
    } catch (error) {
        console.error('✗ Failed to initialize data directory:', error);
        process.exit(1);
    }
}

// Cleanup old data
setInterval(() => {
    const now = Date.now();
    
    // Clean inactive users (>30s)
    const users = stores.users.get();
    const beforeCount = users.length;
    const activeUsers = users.filter(u => (now - u.timestamp) < 30000);
    
    if (activeUsers.length !== beforeCount) {
        stores.users.set(activeUsers);
        console.log(`🧹 Cleaned ${beforeCount - activeUsers.length} inactive users`);
    }

    // Clean old chat messages (>7 days)
    const chat = stores.chat.get();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const recentChat = chat.filter(m => (now - m.timestamp) < sevenDays);
    
    if (recentChat.length !== chat.length) {
        stores.chat.set(recentChat);
        console.log(`🧹 Cleaned ${chat.length - recentChat.length} old chat messages`);
    }

    // Limit history to last 1000 events
    const history = stores.history.get();
    if (history.length > 1000) {
        stores.history.set(history.slice(-1000));
        console.log(`🧹 Trimmed history to 1000 events`);
    }
}, 60000); // Every minute

// Request body parser
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

// CORS headers
function setCORS(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
}

// JSON response helper
function jsonResponse(res, statusCode, data) {
    setCORS(res);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// Error response helper
function errorResponse(res, statusCode, message) {
    jsonResponse(res, statusCode, { 
        error: message,
        timestamp: Date.now()
    });
}

// Success response helper
function successResponse(res, data) {
    jsonResponse(res, 200, {
        success: true,
        data,
        timestamp: Date.now()
    });
}

// Update metadata
function updateMetadata(field, increment = 1) {
    const meta = stores.metadata.get();
    meta[field] = (meta[field] || 0) + increment;
    stores.metadata.set(meta);
}

// HTTP Server
const server = http.createServer(async (req, res) => {
    setCORS(res);

    // Handle preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${method} ${pathname}`);

    try {
        // ==================== NOTES ENDPOINTS ====================

        // GET /notes - Get notes for beatmapset
        if (method === 'GET' && pathname === '/notes') {
            const beatmapsetId = url.searchParams.get('beatmapsetId');
            
            if (!beatmapsetId) {
                errorResponse(res, 400, 'beatmapsetId required');
                return;
            }

            const notes = stores.notes.filter(n => n.beatmapsetId === beatmapsetId);
            console.log(`  → Returning ${notes.length} notes for beatmapset ${beatmapsetId}`);
            
            // Return notes directly as array, NOT wrapped in success object
            setCORS(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(notes));
            return;
        }

        // POST /notes - Add new note
        if (method === 'POST' && pathname === '/notes') {
            const data = await parseBody(req);

            if (!data.beatmapsetId || !data.text) {
                errorResponse(res, 400, 'beatmapsetId and text required');
                return;
            }

            const note = {
                id: data.id || `note_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                time: data.time || '00:00:000',
                author: data.author || 'Anonymous',
                text: data.text.trim(),
                beatmapsetId: data.beatmapsetId,
                resolved: data.resolved || false,
                created: data.created || Date.now(),
                reactions: [],
                replies: []
            };

            stores.notes.push(note);
            updateMetadata('totalNotes');

            // Add to history
            stores.history.push({
                type: 'note',
                author: note.author,
                beatmapsetId: note.beatmapsetId,
                timestamp: note.created,
                text: note.text,
                preview: note.text.substring(0, 100)
            });

            console.log(`  ✓ Note added by ${note.author} [${note.beatmapsetId}]`);
            successResponse(res, note);
            return;
        }

        // POST /notes/react - Add/remove reaction
        if (method === 'POST' && pathname === '/notes/react') {
            const data = await parseBody(req);
            const { noteId, emoji, username, beatmapsetId } = data;

            if (!noteId || !emoji || !username) {
                errorResponse(res, 400, 'noteId, emoji, and username required');
                return;
            }

            const notes = stores.notes.get();
            const note = notes.find(n => 
                (n.id || n.created.toString()) === noteId.toString()
            );

            if (!note) {
                errorResponse(res, 404, 'Note not found');
                return;
            }

            if (!note.reactions) note.reactions = [];

            // Toggle reaction
            const existingIdx = note.reactions.findIndex(
                r => r.emoji === emoji && r.username === username
            );

            let action = 'added';
            if (existingIdx >= 0) {
                note.reactions.splice(existingIdx, 1);
                action = 'removed';
            } else {
                note.reactions.push({ 
                    emoji, 
                    username, 
                    timestamp: Date.now() 
                });
                updateMetadata('totalReactions');
            }

            stores.notes.set(notes);

            // Add to history
            stores.history.push({
                type: 'reaction',
                author: username,
                beatmapsetId: beatmapsetId || note.beatmapsetId,
                timestamp: Date.now(),
                text: `${emoji}`,
                preview: `Reacted ${emoji} to note`
            });

            console.log(`  ✓ Reaction ${action}: ${emoji} by ${username}`);
            successResponse(res, note);
            return;
        }

        // POST /notes/reply - Add reply to note
        if (method === 'POST' && pathname === '/notes/reply') {
            const data = await parseBody(req);
            const { noteId, text, username, beatmapsetId } = data;

            if (!noteId || !text || !username) {
                errorResponse(res, 400, 'noteId, text, and username required');
                return;
            }

            const notes = stores.notes.get();
            const note = notes.find(n => 
                (n.id || n.created.toString()) === noteId.toString()
            );

            if (!note) {
                errorResponse(res, 404, 'Note not found');
                return;
            }

            if (!note.replies) note.replies = [];

            const reply = {
                username,
                text: text.trim(),
                timestamp: data.timestamp || Date.now()
            };

            note.replies.push(reply);
            stores.notes.set(notes);
            updateMetadata('totalReplies');

            // Add to history
            stores.history.push({
                type: 'reply',
                author: username,
                beatmapsetId: beatmapsetId || note.beatmapsetId,
                timestamp: reply.timestamp,
                text: text,
                preview: text.substring(0, 100)
            });

            console.log(`  ✓ Reply added by ${username} to note ${noteId}`);
            successResponse(res, note);
            return;
        }

        // DELETE /notes/:id - Delete note (optional)
        if (method === 'DELETE' && pathname.startsWith('/notes/')) {
            const noteId = pathname.split('/')[2];
            const notes = stores.notes.get();
            const index = notes.findIndex(n => 
                (n.id || n.created.toString()) === noteId
            );

            if (index === -1) {
                errorResponse(res, 404, 'Note not found');
                return;
            }

            notes.splice(index, 1);
            stores.notes.set(notes);
            console.log(`  ✓ Note ${noteId} deleted`);
            successResponse(res, { deleted: true });
            return;
        }

        // ==================== CHAT ENDPOINTS ====================

        // GET /chat - Get chat messages
        if (method === 'GET' && pathname === '/chat') {
            const beatmapsetId = url.searchParams.get('beatmapsetId');
            
            if (!beatmapsetId) {
                errorResponse(res, 400, 'beatmapsetId required');
                return;
            }

            const messages = stores.chat.filter(m => 
                m.beatmapsetId === beatmapsetId
            ).slice(-100); // Last 100 messages

            console.log(`  → Returning ${messages.length} chat messages`);
            successResponse(res, messages);
            return;
        }

        // POST /chat - Send message
        if (method === 'POST' && pathname === '/chat') {
            const data = await parseBody(req);

            if (!data.beatmapsetId || !data.text || !data.author) {
                errorResponse(res, 400, 'beatmapsetId, text, and author required');
                return;
            }

            const message = {
                id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                author: data.author,
                text: data.text.trim(),
                beatmapsetId: data.beatmapsetId,
                timestamp: data.timestamp || Date.now()
            };

            stores.chat.push(message);
            updateMetadata('totalMessages');

            // Add to history
            stores.history.push({
                type: 'chat',
                author: message.author,
                beatmapsetId: message.beatmapsetId,
                timestamp: message.timestamp,
                text: message.text,
                preview: message.text.substring(0, 100)
            });

            console.log(`  ✓ Chat: ${message.author}: ${message.text.substring(0, 50)}...`);
            successResponse(res, message);
            return;
        }

        // ==================== USER PRESENCE ====================

        // GET /collab/users - Get active users
        if (method === 'GET' && pathname === '/collab/users') {
            const beatmapsetId = url.searchParams.get('beatmapsetId');
            const now = Date.now();
            
            let activeUsers = stores.users.filter(u => 
                (now - u.timestamp) < 30000
            );

            if (beatmapsetId) {
                activeUsers = activeUsers.filter(u => 
                    u.beatmapsetId === beatmapsetId
                );
            }

            console.log(`  → ${activeUsers.length} active users`);
            successResponse(res, activeUsers);
            return;
        }

        // POST /collab/users - Update presence
        if (method === 'POST' && pathname === '/collab/users') {
            const data = await parseBody(req);

            if (!data.userId || !data.username) {
                errorResponse(res, 400, 'userId and username required');
                return;
            }

            const users = stores.users.get();
            
            // Remove old presence
            const filtered = users.filter(u => u.userId !== data.userId);
            
            // Add new presence
            const presence = {
                userId: data.userId,
                username: data.username,
                avatarUrl: data.avatarUrl || null,
                beatmapsetId: data.beatmapsetId || null,
                timestamp: data.timestamp || Date.now()
            };

            filtered.push(presence);
            stores.users.set(filtered);

            console.log(`  ✓ Presence: ${data.username} on ${data.beatmapsetId || 'unknown'}`);
            successResponse(res, presence);
            return;
        }

        // ==================== SESSION HISTORY ====================

        // GET /session/history - Get history
        if (method === 'GET' && pathname === '/session/history') {
            const beatmapsetId = url.searchParams.get('beatmapsetId');
            const limit = parseInt(url.searchParams.get('limit')) || 50;

            let history = stores.history.get();

            if (beatmapsetId) {
                history = history.filter(h => h.beatmapsetId === beatmapsetId);
            }

            const recent = history.slice(-limit);
            console.log(`  → ${recent.length} history events`);
            successResponse(res, recent);
            return;
        }

        // ==================== STATS & HEALTH ====================

        // GET /stats - Server statistics
        if (method === 'GET' && pathname === '/stats') {
            const meta = stores.metadata.get();
            const now = Date.now();
            const uptime = Math.floor((now - meta.serverStarted) / 1000);

            const stats = {
                ...meta,
                uptime,
                uptimeFormatted: formatUptime(uptime),
                currentNotes: stores.notes.get().length,
                currentMessages: stores.chat.get().length,
                activeUsers: stores.users.filter(u => 
                    (now - u.timestamp) < 30000
                ).length,
                historyEvents: stores.history.get().length,
                dataDirectory: DATA_DIR
            };

            successResponse(res, stats);
            return;
        }

        // GET /health - Health check
        if (method === 'GET' && pathname === '/health') {
            const now = Date.now();
            const health = {
                status: 'healthy',
                timestamp: now,
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                notes: stores.notes.get().length,
                chat: stores.chat.get().length,
                users: stores.users.filter(u => 
                    (now - u.timestamp) < 30000
                ).length,
                version: '1.0.0'
            };

            successResponse(res, health);
            return;
        }

        // GET / - Server info
        if (method === 'GET' && pathname === '/') {
            const html = `
<!DOCTYPE html>
<html>
<head>
    <title>osu! Collab Server</title>
    <style>
        body { 
            font-family: Arial, sans-serif; 
            max-width: 800px; 
            margin: 50px auto; 
            padding: 20px;
            background: #1a1a1a;
            color: #eee;
        }
        h1 { color: #ff66aa; }
        .status { 
            background: #2a2a2a; 
            padding: 20px; 
            border-radius: 8px; 
            margin: 20px 0;
        }
        .endpoint { 
            background: #333; 
            padding: 10px; 
            margin: 10px 0; 
            border-radius: 4px;
            font-family: monospace;
        }
        .method { 
            color: #4caf50; 
            font-weight: bold;
        }
        a { color: #6bb6ff; }
    </style>
</head>
<body>
    <h1>🎵 osu! Modding Collaboration Server</h1>
    <div class="status">
        <p><strong>Status:</strong> ✅ Running</p>
        <p><strong>Port:</strong> ${PORT}</p>
        <p><strong>Data Directory:</strong> ${DATA_DIR}</p>
    </div>
    
    <h2>Endpoints</h2>
    <div class="endpoint"><span class="method">GET</span> /notes?beatmapsetId=X</div>
    <div class="endpoint"><span class="method">POST</span> /notes</div>
    <div class="endpoint"><span class="method">POST</span> /notes/react</div>
    <div class="endpoint"><span class="method">POST</span> /notes/reply</div>
    <div class="endpoint"><span class="method">GET</span> /chat?beatmapsetId=X</div>
    <div class="endpoint"><span class="method">POST</span> /chat</div>
    <div class="endpoint"><span class="method">GET</span> /collab/users</div>
    <div class="endpoint"><span class="method">POST</span> /collab/users</div>
    <div class="endpoint"><span class="method">GET</span> /session/history</div>
    <div class="endpoint"><span class="method">GET</span> /stats</div>
    <div class="endpoint"><span class="method">GET</span> /health</div>

    <h2>Quick Links</h2>
    <p><a href="/health">Health Check</a> | <a href="/stats">Statistics</a></p>
</body>
</html>`;
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
            return;
        }

// ==================== REVIEWS ====================

        // GET /reviews/:userId
        if (method === 'GET' && /^\/reviews\/\d{1,10}$/.test(pathname)) {
            const userId = pathname.split('/')[2];
            const all = stores.reviews ? stores.reviews.get() : {};
            const userReviews = all[userId] || [];
            jsonResponse(res, 200, userReviews);
            return;
        }

        // POST /reviews
        if (method === 'POST' && pathname === '/reviews') {
            const data = await parseBody(req);

            const text = (data.text || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
            const authorUsername = (data.authorUsername || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
            const targetUserId = String(data.targetUserId || '');
            const stars = Number(data.stars);

            if (!targetUserId || !/^\d{1,10}$/.test(targetUserId)) {
                errorResponse(res, 400, 'Invalid targetUserId'); return;
            }
            if (!authorUsername || !/^[\w\- ]{1,32}$/.test(authorUsername)) {
                errorResponse(res, 400, 'Invalid authorUsername'); return;
            }
            if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
                errorResponse(res, 400, 'stars must be 1-5'); return;
            }
            if (text.length < 5) {
                errorResponse(res, 400, 'Review too short (min 5 chars)'); return;
            }
            if (text.length > 300) {
                errorResponse(res, 400, 'Review too long (max 300 chars)'); return;
            }

            const all = stores.reviews ? stores.reviews.get() : {};
            if (!all[targetUserId]) all[targetUserId] = [];

            if (all[targetUserId].some(r => r.authorUsername.toLowerCase() === authorUsername.toLowerCase())) {
                jsonResponse(res, 409, { error: 'You have already reviewed this player' }); return;
            }

            const review = {
                id: Math.random().toString(36).slice(2) + Date.now().toString(36),
                authorUsername,
                stars,
                text,
                createdAt: new Date().toISOString(),
            };
            all[targetUserId].push(review);
            stores.reviews.set(all);

            console.log(`  ✓ Review by ${authorUsername} for user ${targetUserId} (${stars}★)`);
            jsonResponse(res, 201, { ok: true, id: review.id });
            return;
        }

        // 404 Not Found
        errorResponse(res, 404, `Endpoint ${pathname} not found`);

    } catch (error) {
        console.error('  ✗ Error:', error.message);
        errorResponse(res, 500, `Server error: ${error.message}`);
    }
});

// Helper: Format uptime
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(' ');
}

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(60));
    console.log('🎵  osu! Modding Collaboration Server  🎵');
    console.log('='.repeat(60));
    console.log(`✓ Server running on http://0.0.0.0:${PORT}`);
    console.log(`✓ Data directory: ${DATA_DIR}`);
    console.log(`✓ Auto-save: Every 5 seconds`);
    console.log(`✓ Server started: ${new Date().toLocaleString()}`);
    console.log('='.repeat(60));
    console.log('\n📡 Connection Setup:');
    console.log('   Local:      http://localhost:3000');
    console.log('   Network:    http://<your-ip>:3000');
    console.log('   RadminVPN:  http://<radmin-ip>:3000');
    console.log('\n💡 Quick Test:');
    console.log('   Open http://localhost:3000 in your browser');
    console.log('='.repeat(60) + '\n');
});

// Graceful shutdown
function shutdown(signal) {
    console.log(`\n📥 Received ${signal}, shutting down gracefully...`);
    
    // Save all data
    console.log('💾 Saving all data...');
    Object.values(stores).forEach(store => {
        store.save();
        store.destroy();
    });

    console.log('✓ All data saved');
    
    server.close(() => {
        console.log('✓ Server stopped');
        console.log('👋 Goodbye!\n');
        process.exit(0);
    });

    // Force exit after 5 seconds
    setTimeout(() => {
        console.log('⚠ Forcing exit...');
        process.exit(1);
    }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('✗ Uncaught Exception:', error);
    shutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('✗ Unhandled Rejection:', reason);
});