/**
 * Vercel Serverless Function: /api/tts
 * High-speed CORS-free proxy for Fish Audio TTS API
 */
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const { text, reference_id, apiKey } = body;

        if (!text) {
            return res.status(400).json({ error: 'Text is required' });
        }

        const fishApiKey = apiKey || process.env.FISH_AUDIO_API_KEY || 'sk-fish-S9_QFLOkQpCoC3gzO8UcH82vBTInlpwaphe2hshb1jY';

        const fishRes = await fetch('https://api.fish.audio/v1/tts', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${fishApiKey}`
            },
            body: JSON.stringify({
                text,
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
        return res.status(500).json({ error: err.message });
    }
}
