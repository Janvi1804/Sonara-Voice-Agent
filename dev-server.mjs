/**
 * Sonara Voice Agent — Local Development Server
 * Full-stack server running static assets + all /api serverless endpoints locally.
 *
 * Usage: node dev-server.mjs
 * URL:   http://localhost:3000
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.DEV_PORT || 3000;

// Dynamic import of API handlers
const apiHandlers = {
    '/api/chat': (await import('./api/chat.js')).default,
    '/api/sarvam-tts': (await import('./api/sarvam-tts.js')).default,
    '/api/sarvam-stt': (await import('./api/sarvam-stt.js')).default,
    '/api/transcribe': (await import('./api/transcribe.js')).default,
    '/api/db': (await import('./api/db.js')).default
};

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.wasm': 'application/wasm',
    '.onnx': 'application/octet-stream'
};

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = parsedUrl.pathname;

    // 1. Route API endpoints
    const handler = apiHandlers[pathname];
    if (handler) {
        // Collect request body
        const chunks = [];
        for await (const chunk of req) {
            chunks.push(chunk);
        }
        const rawBody = Buffer.concat(chunks);
        let body = {};
        const contentType = req.headers['content-type'] || '';

        if (contentType.includes('application/json')) {
            try {
                body = JSON.parse(rawBody.toString('utf8'));
            } catch (_) {}
        } else {
            body = rawBody;
        }

        // Mock Next.js / Vercel Serverless Req & Res
        req.body = body;
        req.query = Object.fromEntries(parsedUrl.searchParams);

        // Enhance res with status and json helpers
        const origEnd = res.end.bind(res);
        res.status = (code) => {
            res.statusCode = code;
            return res;
        };
        res.json = (data) => {
            res.setHeader('Content-Type', 'application/json');
            return origEnd(JSON.stringify(data));
        };

        try {
            return await handler(req, res);
        } catch (err) {
            console.error(`[API ${pathname}] Error:`, err);
            if (!res.headersSent) {
                res.status(500).json({ error: err.message });
            }
            return;
        }
    }

    // 2. Serve Static Files
    if (pathname === '/') pathname = '/index.html';

    let filePath = path.join(__dirname, pathname);

    // If not found in root, check public/
    if (!fs.existsSync(filePath)) {
        filePath = path.join(__dirname, 'public', pathname);
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        res.setHeader('Access-Control-Allow-Origin', '*');
        return fs.createReadStream(filePath).pipe(res);
    }

    res.statusCode = 404;
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`  🚀 Sonara Voice Agent Local Full-Stack Server Ready!`);
    console.log(`  🌐 Open in browser: http://localhost:${PORT}`);
    console.log(`  ⚡ APIs active: /api/chat, /api/sarvam-tts, /api/sarvam-stt, /api/db, /api/transcribe`);
    console.log(`======================================================\n`);
});
