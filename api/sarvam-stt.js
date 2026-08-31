/**
 * Vercel Serverless Function: /api/sarvam-stt
 * Proxy for Sarvam AI Speech-to-Text (saarika:v2 model)
 * Hindi, English, Hinglish transcription
 */
import { setCorsHeaders, checkRateLimit } from './_utils.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
    const corsAllowed = setCorsHeaders(req, res, 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        if (!corsAllowed) return res.status(403).json({ error: 'Forbidden: CORS origin not allowed.' });
        return res.status(200).end();
    }

    if (!corsAllowed && req.headers.origin) {
        return res.status(403).json({ error: 'Forbidden: CORS origin not allowed.' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    if (!checkRateLimit(req, { maxRequests: 60, windowMs: 60000 })) {
        return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
    }

    try {
        const apiKey = process.env.SARVAM_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'SARVAM_API_KEY is not configured on server.' });
        }

        // Buffer incoming multipart request
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);

        // Forward to Sarvam STT with same Content-Type boundary
        const sarvamRes = await fetch('https://api.sarvam.ai/speech-to-text', {
            method: 'POST',
            headers: {
                'api-subscription-key': apiKey,
                'Content-Type': req.headers['content-type'] || 'multipart/form-data'
            },
            body: buffer,
            duplex: 'half'
        });

        if (!sarvamRes.ok) {
            const errText = await sarvamRes.text();
            console.error('[SarvamSTT] Error:', sarvamRes.status, errText);
            return res.status(sarvamRes.status).json({ error: `Sarvam STT error: ${errText}` });
        }

        const data = await sarvamRes.json();
        // Normalize to same format as Whisper: { text: "..." }
        const transcript = data.transcript || data.text || '';
        return res.status(200).json({ text: transcript, raw: data });

    } catch (err) {
        console.error('[SarvamSTT] Handler error:', err);
        return res.status(500).json({ error: 'STT transcription failed.' });
    }
}

