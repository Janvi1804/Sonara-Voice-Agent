/**
 * Vercel Serverless Function: /api/tts
 * Proxy for Fish Audio TTS API
 */
import { setCorsHeaders, checkRateLimit } from './_utils.js';

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
        return res.status(429).json({ error: 'Rate limit exceeded.' });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const { text, reference_id, apiKey } = body;

        if (!text || !String(text).trim()) {
            return res.status(400).json({ error: 'Text is required' });
        }

        const fishApiKey = apiKey || process.env.FISH_AUDIO_API_KEY;
        if (!fishApiKey) {
            return res.status(500).json({ error: 'FISH_AUDIO_API_KEY is not configured on server.' });
        }

        const sanitizedText = String(text).trim().slice(0, 1000);

        const fishRes = await fetch('https://api.fish.audio/v1/tts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${fishApiKey}`
            },
            body: JSON.stringify({
                text: sanitizedText,
                reference_id: reference_id || undefined,
                format: 'mp3',
                latency: 'balanced'
            })
        });

        if (!fishRes.ok) {
            const errText = await fishRes.text();
            return res.status(fishRes.status).json({ error: `Fish Audio error: ${errText}` });
        }

        const audioBuffer = await fishRes.arrayBuffer();
        res.setHeader('Content-Type', 'audio/mpeg');
        return res.status(200).send(Buffer.from(audioBuffer));

    } catch (err) {
        console.error('TTS Proxy Error:', err);
        return res.status(500).json({ error: 'TTS processing failed.' });
    }
}
