const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Match the fail-closed CORS posture used by the Vercel serverless functions
// (api/_utils.js) instead of reflecting any origin.
const allowedOrigin = (process.env.ALLOWED_ORIGIN || '').trim();
app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true); // same-origin / non-browser requests
        if (!allowedOrigin) return callback(null, process.env.NODE_ENV !== 'production');
        const allowedList = allowedOrigin.split(',').map(o => o.trim());
        if (allowedList.includes('*') || allowedList.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
    }
}));
app.use(express.json());
// Serve root static frontend files
app.use(express.static(path.join(__dirname, '..')));

wss.on('connection', (ws) => {
    console.log('⚡ Client connected via WebSocket for real-time duplex audio');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

server.listen(PORT, () => {
    console.log(`\n🚀 SONARA Server running at: http://localhost:${PORT}\n`);
});
