/**
 * Vercel Serverless Function: /api/transcribe
 * High-speed proxy for Groq Whisper Large V3 Turbo Audio Transcription
 */
import { setCorsHeaders, checkRateLimit } from './_utils.js';

export const config = {
    api: {
        bodyParser: false
    }
};

export default async function handler(req, res) {
    const corsAllowed = setCorsHeaders(req, res, 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        if (!corsAllowed) return res.status(403).json({ error: 'Forbidden: CORS origin not allowed.' });
        return res.status(200).end();
    }

    if (!corsAllowed && req.headers.origin) {
        return res.status(403).json({ error: 'Forbidden: CORS origin not allowed.' });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (!checkRateLimit(req, { maxRequests: 60, windowMs: 60000 })) {
        return res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment.' });
    }

    try {
        // GROQ_API_KEY is server-only — no caller-supplied key fallback. api/chat.js is
        // explicitly "STRICT GROQ CLOUD ONLY, no alternate provider fallbacks"; falling
        // back to a client-supplied Authorization header here would make this endpoint
        // an anonymous open relay to Groq whenever the env var is unset, inconsistent
        // with that design.
        const apiKey = process.env.GROQ_API_KEY || '';

        if (!apiKey) {
            return res.status(401).json({ error: 'GROQ_API_KEY is not configured on server.' });
        }

        // Buffer the incoming audio stream for 100% reliability in Vercel serverless.
        // Cap total size as defense-in-depth — the platform has its own payload limit,
        // but this avoids fully buffering an oversized-but-platform-permitted upload
        // into memory before Groq ever sees it.
        const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
        const chunks = [];
        let totalBytes = 0;
        for await (const chunk of req) {
            totalBytes += chunk.length;
            if (totalBytes > MAX_AUDIO_BYTES) {
                return res.status(413).json({ error: 'Audio payload too large.' });
            }
            chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);

        // Forward to Groq with duplex: 'half' (required in Node 18+)
        const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': req.headers['content-type'] || 'multipart/form-data'
            },
            body: buffer,
            duplex: 'half'
        });

        const data = await groqRes.json();
        return res.status(groqRes.status).json(data);

    } catch (err) {
        console.error('Whisper Proxy Error:', err);
        return res.status(500).json({ error: 'Audio transcription failed.' });
    }
}
