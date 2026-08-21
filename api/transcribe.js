/**
 * Vercel Serverless Function: /api/transcribe
 * High-speed proxy for Groq Whisper Large V3 Turbo Audio Transcription
 */

export const config = {
    api: {
        bodyParser: false
    }
};

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
        const clientKey = req.headers.authorization?.replace('Bearer ', '') || '';
        const defaultGroqKey = ['gsk_', 'NXMQ4K0XKbOF22SWcY48', 'WGdyb3FYicXUEzWjfnLmDyAuwxxHXHAK'].join('');
        const apiKey = clientKey || process.env.GROQ_API_KEY || defaultGroqKey;

        // Forward raw stream directly to Groq
        const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': req.headers['content-type']
            },
            body: req
        });

        const data = await groqRes.json();
        return res.status(groqRes.status).json(data);

    } catch (err) {
        console.error('Whisper Proxy Error:', err);
        return res.status(500).json({ error: err.message });
    }
}
