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

// Dynamic import of API handlers. Routes that export `config.api.bodyParser = false`
// (sarvam-stt, transcribe) read the raw multipart request stream themselves — the
// server must NOT drain `req` before calling them, or they'll see an already-ended,
// empty stream (this previously made local STT always fail with "field required"/"EOF"
// even with valid API keys, since Vercel's prod serverless functions don't share this
// body-draining wrapper).
async function loadHandler(modulePath) {
    const mod = await import(modulePath);
    return { handler: mod.default, rawBody: mod.config?.api?.bodyParser === false };
}

const apiHandlers = {
    '/api/chat': await loadHandler('./api/chat.js'),
    '/api/sarvam-tts': await loadHandler('./api/sarvam-tts.js'),
    '/api/sarvam-stt': await loadHandler('./api/sarvam-stt.js'),
    '/api/transcribe': await loadHandler('./api/transcribe.js'),
    '/api/db': await loadHandler('./api/db.js')
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
    const route = apiHandlers[pathname];
    if (route) {
        const { handler, rawBody: wantsRawBody } = route;

        if (!wantsRawBody) {
            // Collect & parse body only for handlers that rely on the Vercel-style
            // auto body parser. Handlers with bodyParser:false read `req` themselves.
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
        }
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
