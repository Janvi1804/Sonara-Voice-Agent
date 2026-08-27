/**
 * Vercel Serverless Function: /api/elevenlabs-tts
 * ElevenLabs Text-to-Speech proxy
 * Voice: Jessica (cgSgspJ2msm6clMCkdW9) - Playful, Bright, Warm — most human-like
 * Model: eleven_multilingual_v2 (Hindi + English support)
 */
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const { text, voice_id } = body;

        if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

        const apiKey = process.env.ELEVENLABS_API_KEY || 'sk_5419d966bcb625ed03ebafe67156d823098206771f5856f4';

        // Jessica — most natural, human-like ElevenLabs voice
        const voiceId = voice_id || 'cgSgspJ2msm6clMCkdW9';

        const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg'
            },
            body: JSON.stringify({
                text: text.trim(),
                model_id: 'eleven_multilingual_v2',
                voice_settings: {
                    stability: 0.35,          // Lower = more expressive & natural variation
                    similarity_boost: 0.80,   // High = consistent voice character
                    style: 0.40,              // Adds human expressiveness & emotion
                    use_speaker_boost: true   // Enhances clarity and presence
                }
            })

        });

        if (!elRes.ok) {
            const errText = await elRes.text();
            console.error('[ElevenLabsTTS] Error:', elRes.status, errText);
            return res.status(elRes.status).json({ error: `ElevenLabs TTS error: ${errText}` });
        }

        const audioBuffer = await elRes.arrayBuffer();
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', audioBuffer.byteLength);
        return res.status(200).send(Buffer.from(audioBuffer));

    } catch (err) {
        console.error('[ElevenLabsTTS] Handler error:', err);
        return res.status(500).json({ error: err.message });
    }
}
