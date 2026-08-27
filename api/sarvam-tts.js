/**
 * Vercel Serverless Function: /api/sarvam-tts
 * Proxy for Sarvam AI Text-to-Speech (bulbul:v2 model)
 * Supports Hindi, English, Hinglish
 */
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const { text, language_code, speaker, pace, pitch } = body;

        if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

        const apiKey = process.env.SARVAM_API_KEY || 'sk_25atwi6q_NdW6xeXjxf8exrTGOO8r5GgQ';

        // Detect language if not specified: Hindi/Hinglish -> hi-IN, else en-IN
        const detectedLang = language_code || (containsHindi(text) ? 'hi-IN' : 'en-IN');

        const sarvamRes = await fetch('https://api.sarvam.ai/text-to-speech', {
            method: 'POST',
            headers: {
                'api-subscription-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                inputs: [text.trim()],
                target_language_code: detectedLang,
                speaker: speaker || 'anushka',
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
        return res.status(500).json({ error: err.message });
    }
}

function containsHindi(text) {
    return /[\u0900-\u097F]/.test(text) || /\b(hai|hain|kya|nahi|aur|mujhe|mera|apka|kal|aaj|theek|bahut|bohot|accha|zaroor|bilkul|namaskar|namaste|dhanyavad)\b/i.test(text);
}
