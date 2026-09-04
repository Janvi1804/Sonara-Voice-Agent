/**
 * Vercel Serverless Function: /api/elevenlabs-tts
 * ElevenLabs Text-to-Speech proxy (ElevenLabs API ONLY)
 * Model: eleven_flash_v2_5 (Low-latency production model)
 * Voice: Jessica (cgSgspJ2msm6clMCkdW9)
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

    // Rate limit: max 60 synthesis requests per minute per IP
    if (!checkRateLimit(req, { maxRequests: 60, windowMs: 60000 })) {
        return res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment.' });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const { text, voice_id, model_id } = body;

        if (!text || !String(text).trim()) {
            return res.status(400).json({ error: 'text is required' });
        }

        const apiKey = process.env.ELEVENLABS_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'ELEVENLABS_API_KEY is not configured on server.' });
        }

        // Limit text length per chunk to prevent abuse (max 1000 chars per utterance)
        const sanitizedText = String(text).trim().slice(0, 1000);

        // Jessica — natural, human-like voice
        const voiceId = voice_id || 'cgSgspJ2msm6clMCkdW9';
        const modelId = model_id || 'eleven_flash_v2_5';

        const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?optimize_streaming_latency=3`, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify({
                text: sanitizedText,
                model_id: modelId,
                voice_settings: {
                    stability: 0.40,
                    similarity_boost: 0.82,
                    style: 0.15,
                    use_speaker_boost: true
                }
            })
        });

        if (!elRes.ok) {
            const errText = await elRes.text();
            console.error('ElevenLabs API error:', elRes.status, errText);
            return res.status(elRes.status).json({
                error: `ElevenLabs TTS failed (${elRes.status}): ${errText}`
            });
        }

        const audioBuffer = await elRes.arrayBuffer();
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', audioBuffer.byteLength);
        return res.status(200).send(Buffer.from(audioBuffer));

    } catch (err) {
        console.error('ElevenLabs TTS Error:', err);
        return res.status(500).json({ error: 'ElevenLabs TTS synthesis failed: ' + err.message });
    }
}
