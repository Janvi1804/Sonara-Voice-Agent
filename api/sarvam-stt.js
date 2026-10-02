/**
 * Vercel Serverless Function: /api/sarvam-stt
 * Proxy for Sarvam AI Speech-to-Text (saarika:v2 model)
 * Hindi, English, Hinglish transcription
 */
import { setCorsHeaders, checkRateLimit } from './_utils.js';

export const config = { api: { bodyParser: false } };

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
        const apiKey = process.env.SARVAM_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'SARVAM_API_KEY is not configured on server.' });
        }

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
        const rawTranscript = data.transcript || data.text || '';
        const transcript = devanagariToHinglish(rawTranscript);
        return res.status(200).json({ text: transcript, raw: data });

    } catch (err) {
        console.error('[SarvamSTT] Handler error:', err);
        return res.status(500).json({ error: 'STT transcription failed.' });
    }
}

function devanagariToHinglish(text) {
    if (!text || !/[\u0900-\u097F]/.test(text)) return text;

    const wordMap = {
        'नमस्ते': 'namaste', 'नमस्कार': 'namaskar', 'कैसे': 'kaise', 'कैसा': 'kaisa', 'कैसी': 'kaisi',
        'हो': 'ho', 'हैं': 'hain', 'है': 'hai', 'हूं': 'hoon', 'हूँ': 'hoon', 'आप': 'aap', 'तुम': 'tum',
        'मैं': 'main', 'हम': 'hum', 'क्या': 'kya', 'क्यों': 'kyun', 'कहाँ': 'kahan', 'कहा': 'kaha',
        'कब': 'kab', 'कौन': 'kaun', 'कितना': 'kitna', 'कितने': 'kitne', 'कितनी': 'kitni',
        'अच्छा': 'achha', 'अच्छी': 'acchi', 'अच्छे': 'acche', 'ठीक': 'theek', 'बढ़िया': 'badhiya',
        'धन्यवाद': 'dhanyawad', 'शुक्रिया': 'shukriya', 'अलविदा': 'alvida', 'मदद': 'madad', 'सहायता': 'sahayata',
        'सेवाएं': 'services', 'सेवाएँ': 'services', 'सेवा': 'service', 'कीमत': 'pricing', 'मूल्य': 'pricing',
        'अपॉइंटमेंट': 'appointment', 'अपॉइंटमेंटस': 'appointments', 'डेमो': 'demo', 'बुक': 'book',
        'करना': 'karna', 'करो': 'karo', 'दीजिए': 'dijiye', 'दीजिये': 'dijiye', 'बताइए': 'bataiye',
        'बताइये': 'bataiye', 'कन्वर्स': 'Converse', 'एआई': 'AI', 'व्हाट्सएप': 'WhatsApp',
        'वॉइस': 'Voice', 'बॉट': 'Bot', 'एजेंट': 'Agent', 'कंपनी': 'company', 'काम': 'kaam',
        'करता': 'karta', 'करती': 'karti', 'करते': 'karte', 'सकता': 'sakta', 'सकती': 'sakti', 'सकते': 'sakte'
    };

    let processed = text;
    for (const [hindi, hinglish] of Object.entries(wordMap)) {
        processed = processed.replace(new RegExp(hindi, 'g'), hinglish);
    }

    if (/[\u0900-\u097F]/.test(processed)) {
        const vowels = {
            'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri',
            'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'अं': 'an', 'अः': 'ah'
        };
        const matras = {
            'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri',
            'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ं': 'n', 'ँ': 'n', 'ः': 'h', '्': ''
        };
        const consonants = {
            'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
            'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
            'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
            'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
            'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
            'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
            'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
            'क्ष': 'ksh', 'त्र': 'tr', 'ज्ञ': 'gy',
            'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'फ़': 'f', 'ड़': 'r', 'ढ़': 'rh'
        };

        let res = '';
        const chars = Array.from(processed);
        for (let i = 0; i < chars.length; i++) {
            const ch = chars[i];
            const next = chars[i + 1] || '';
            if (consonants[ch]) {
                res += consonants[ch];
                if (next === '्') {
                    i++;
                } else if (matras[next]) {
                    res += matras[next];
                    i++;
                } else if (consonants[next] || vowels[next] || next === ' ' || next === '' || /[.,!?]/.test(next)) {
                    const isWordEnd = (next === ' ' || next === '' || /[.,!?]/.test(next));
                    if (!isWordEnd) res += 'a';
                }
            } else if (vowels[ch]) {
                res += vowels[ch];
            } else if (matras[ch]) {
                res += matras[ch];
            } else {
                res += ch;
            }
        }
        processed = res;
    }

    return processed.replace(/\s{2,}/g, ' ').trim();
}

