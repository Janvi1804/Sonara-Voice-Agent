/**
 * Vercel Serverless Function: /api/sarvam-tts
 * Proxy for Sarvam AI Text-to-Speech (bulbul:v3 — latest model)
 * Voice: Ritu (natural Hindi/Hinglish female voice)
 * Supports: Hindi (hi-IN), English (en-IN), Hinglish (auto-detected)
 * Endpoint: REST Stream for lowest latency
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
        const { text, language_code, speaker, pace } = body;

        if (!text || !/[a-zA-Z\u0900-\u097F0-9]/.test(String(text))) {
            return res.status(400).json({ error: 'text must contain speakable characters' });
        }

        const apiKey = process.env.SARVAM_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'SARVAM_API_KEY is not configured on server.' });
        }

        // Sarvam stream handles up to 500 chars per request cleanly
        const sanitizedText = String(text).trim().slice(0, 450);

        // Auto-detect: Hindi Devanagari script OR Hindi keywords → hi-IN, else en-IN
        const detectedLang = language_code || (containsHindi(sanitizedText) ? 'hi-IN' : 'en-IN');

        // REST Stream endpoint (lowest latency)
        let activeRes = await fetch('https://api.sarvam.ai/text-to-speech/stream', {
            method: 'POST',
            headers: {
                'api-subscription-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: sanitizedText,
                target_language_code: detectedLang,
                speaker: speaker || 'ritu',   // Ritu — natural Hindi/Hinglish female voice
                model: 'bulbul:v3',            // Latest Sarvam model
                pace: pace !== undefined ? pace : 1.0,
                speech_sample_rate: 22050
            })
        });

        // If stream endpoint fails for transient reason, automatically try standard endpoint
        if (!activeRes.ok) {
            console.warn(`[SarvamTTS] Stream endpoint returned ${activeRes.status}, falling back to standard REST endpoint...`);
            activeRes = await fetch('https://api.sarvam.ai/text-to-speech', {
                method: 'POST',
                headers: {
                    'api-subscription-key': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    inputs: [sanitizedText],
                    target_language_code: detectedLang,
                    speaker: speaker || 'ritu',
                    model: 'bulbul:v3',
                    pace: pace !== undefined ? pace : 1.0,
                    speech_sample_rate: 22050
                })
            });
        }

        if (!activeRes.ok) {
            const errText = await activeRes.text();
            console.error('[SarvamTTS] Error:', activeRes.status, errText);
            return res.status(activeRes.status).json({ error: `Sarvam TTS error (${activeRes.status}): ${errText}` });
        }

        // Check response type (stream audio bytes or JSON base64)
        const contentType = activeRes.headers.get('content-type') || 'audio/mpeg';

        if (contentType.includes('audio/')) {
            // Direct audio stream — pipe bytes to client
            const audioBuffer = await activeRes.arrayBuffer();
            res.setHeader('Content-Type', contentType);
            res.setHeader('Content-Length', audioBuffer.byteLength);
            res.statusCode = 200;
            if (typeof res.send === 'function') {
                return res.send(Buffer.from(audioBuffer));
            }
            return res.end(Buffer.from(audioBuffer));
        } else {
            // Standard JSON base64 response
            const data = await activeRes.json();
            const audioBase64 = data.audios?.[0];
            if (!audioBase64) return res.status(500).json({ error: 'No audio returned from Sarvam' });
            const audioBuffer = Buffer.from(audioBase64, 'base64');
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Length', audioBuffer.length);
            res.statusCode = 200;
            if (typeof res.send === 'function') {
                return res.send(audioBuffer);
            }
            return res.end(audioBuffer);
        }

    } catch (err) {
        console.error('[SarvamTTS] Handler error:', err);
        return res.status(500).json({ error: 'Sarvam TTS synthesis failed: ' + err.message });
    }
}

/**
 * Detect Hindi/Hinglish text — used for auto language selection
 */
function containsHindi(text) {
    return /[\u0900-\u097F]/.test(text) ||
        /\b(hai|hain|hoon|ho|kya|nahi|nahin|aur|mujhe|mera|meri|mere|aap|aapka|aapki|aapke|apna|apni|apne|kripya|kal|aaj|theek|bahut|bohot|accha|acchi|acche|achha|zaroor|bilkul|namaskar|namaste|dhanyavad|shukriya|haan|bata|batao|bataiye|karo|karna|karta|karti|karte|karein|chahiye|main|yeh|ye|woh|wo|kyun|kaise|kaisi|kaisa|kab|kahan|lekin|kyunki|phir|abhi|baad|pehle|sirf|sab|kuch|zyada|thoda|hoga|hogi|honge|hona|toh|to|bhi|se|pe|par|ko|ka|ki|ke|ne|ek|do|teen|chaar|paanch|chheh|saat|aath|nau|das|agar|jab|tab|ji|liye|wala|wali|wale|sakta|sakti|sakte|sakoon|madad|yahan|wahan|pooch|poochiye|pasand|kaunsa|kaunsi|kaunse|taaki|de|do|dijiye|dena|deti|deta|le|lo|lijiye|lena|leti|leta)\b/i.test(text);
}

