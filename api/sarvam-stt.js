/**
 * Vercel Serverless Function: /api/sarvam-stt
 * Proxy for Sarvam AI Speech-to-Text (saarika:v2 model)
 * Hindi, English, Hinglish transcription
 */
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const apiKey = process.env.SARVAM_API_KEY || 'sk_25atwi6q_NdW6xeXjxf8exrTGOO8r5GgQ';

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
        return res.status(500).json({ error: err.message });
    }
}
