/**
 * Vercel Serverless Function: /api/sarvam-tts
 * Proxy for Sarvam AI Text-to-Speech (bulbul:v2 model)
 * Supports Hindi, English, Hinglish
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
        const { text, language_code, speaker, pace, pitch } = body;

        if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });

        const apiKey = process.env.SARVAM_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'SARVAM_API_KEY is not configured on server.' });
        }

        const sanitizedText = String(text).trim().slice(0, 1000);
        const detectedLang = language_code || (containsHindi(sanitizedText) ? 'hi-IN' : 'en-IN');

        const sarvamRes = await fetch('https://api.sarvam.ai/text-to-speech', {
            method: 'POST',
            headers: {
                'api-subscription-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                inputs: [sanitizedText],
                target_language_code: detectedLang,
                speaker: speaker || 'arya',
                pitch: pitch !== undefined ? pitch : 0,
                pace: pace !== undefined ? pace : 1.1,
                loudness: 1.5,
                speech_sample_rate: 22050,
                enable_preprocessing: true,
                model: 'bulbul:v2'
            })
        });

        if (!sarvamRes.ok) {
            const errText = await sarvamRes.text();
            console.error('[SarvamTTS] Error:', sarvamRes.status, errText);
            return res.status(sarvamRes.status).json({ error: `Sarvam TTS error: ${errText}` });
        }

        const data = await sarvamRes.json();
        const audioBase64 = data.audios?.[0];
        if (!audioBase64) return res.status(500).json({ error: 'No audio returned from Sarvam' });

        const audioBuffer = Buffer.from(audioBase64, 'base64');
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', audioBuffer.length);
        return res.status(200).send(audioBuffer);

    } catch (err) {
        console.error('[SarvamTTS] Handler error:', err);
        return res.status(500).json({ error: 'Sarvam TTS synthesis failed.' });
    }
}

function containsHindi(text) {
    return /[\u0900-\u097F]/.test(text) || /\b(hai|hain|kya|nahi|aur|mujhe|mera|apka|kal|aaj|theek|bahut|bohot|accha|zaroor|bilkul|namaskar|namaste|dhanyavad)\b/i.test(text);
}

