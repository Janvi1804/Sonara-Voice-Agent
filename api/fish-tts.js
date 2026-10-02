/**
 * Vercel Serverless Function: /api/fish-tts
 * Fish Audio TTS proxy — REST API
 * Endpoint: https://api.fish.audio/v1/tts
 * Model: speech-1.5 (latest Fish Audio model)
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

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    if (!checkRateLimit(req, { maxRequests: 60, windowMs: 60000 })) {
        return res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const { text, reference_id, format } = body;

        if (!text || !String(text).trim()) {
            return res.status(400).json({ error: 'text is required' });
        }

        const apiKey = process.env.FISH_AUDIO_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'FISH_AUDIO_API_KEY is not configured on server.' });
        }

        const sanitizedText = String(text).trim().slice(0, 1000);

        const fishRes = await fetch('https://api.fish.audio/v1/tts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: sanitizedText,
                reference_id: reference_id || null,  // Pass voice model ID if needed
                format: format || 'mp3',
                latency: 'balanced'                   // balanced | normal
            })
        });

        if (!fishRes.ok) {
            const errText = await fishRes.text();
            console.error('[FishAudioTTS] Error:', fishRes.status, errText);
            return res.status(fishRes.status).json({
                error: `Fish Audio TTS error (${fishRes.status}): ${errText}`
            });
        }

        // Fish Audio returns audio bytes directly
        const audioBuffer = await fishRes.arrayBuffer();
        const contentType = fishRes.headers.get('content-type') || 'audio/mpeg';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', audioBuffer.byteLength);
        return res.status(200).send(Buffer.from(audioBuffer));

    } catch (err) {
        console.error('[FishAudioTTS] Handler error:', err);
        return res.status(500).json({ error: 'Fish Audio TTS synthesis failed: ' + err.message });
    }
}
