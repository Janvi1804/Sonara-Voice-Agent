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
        const apiKey = process.env.GROQ_API_KEY || clientKey || '';

        if (!apiKey) {
            return res.status(401).json({ error: 'GROQ_API_KEY is not configured on server.' });
        }

        // Buffer the incoming audio stream for 100% reliability in Vercel serverless
        const chunks = [];
        for await (const chunk of req) {
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
        return res.status(500).json({ error: err.message });
    }
}
