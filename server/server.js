const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(cors());
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
