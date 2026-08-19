/**
 * Vercel Serverless Function: /api/chat
 * Secure, CORS-free backend proxy for HuggingFace Gemma 2 & LLM inference.
 */

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
    );

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const {
            messages = [],
            model = 'google/gemma-2-9b-it',
            hfToken: clientHfToken,
            apiKey: clientApiKey,
            provider = 'huggingface',
            temperature = 0.65,
            max_tokens = 250
        } = body;

        const hfToken = clientHfToken || process.env.VITE_HF_TOKEN || process.env.HF_TOKEN || '';

        // --- 1. HuggingFace Gemma 2 Provider ---
        if (provider === 'huggingface') {
            if (!hfToken) {
                return res.status(400).json({
                    error: 'HuggingFace Token is missing. Add VITE_HF_TOKEN in Vercel settings or enter it in app Settings.'
                });
            }

            const hfModelMap = {
                'gemma2-9b-it': 'google/gemma-2-9b-it',
                'gemma2-27b-it': 'google/gemma-2-27b-it',
                'google/gemma-2-9b-it': 'google/gemma-2-9b-it',
                'google/gemma-2-27b-it': 'google/gemma-2-27b-it'
            };
            const targetModel = hfModelMap[model] || model || 'google/gemma-2-9b-it';

            const endpoints = [
                'https://router.huggingface.co/hf-inference/v1/chat/completions',
                `https://api-inference.huggingface.co/models/${targetModel}/v1/chat/completions`
            ];

            let lastErr = null;

            for (const ep of endpoints) {
                try {
                    const hfRes = await fetch(ep, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${hfToken}`
                        },
                        body: JSON.stringify({
                            model: targetModel,
                            messages,
                            max_tokens,
                            temperature
                        })
                    });

                    if (hfRes.ok) {
                        const data = await hfRes.json();
                        const text = data.choices?.[0]?.message?.content || '';
                        if (text) {
                            return res.status(200).json({ text });
                        }
                    } else {
                        const errText = await hfRes.text();
                        lastErr = `HF Status ${hfRes.status}: ${errText}`;
                        if (hfRes.status === 503) {
                            await new Promise(r => setTimeout(r, 3000));
                            const retryRes = await fetch(ep, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Authorization': `Bearer ${hfToken}`
                                },
                                body: JSON.stringify({
                                    model: targetModel,
                                    messages,
                                    max_tokens,
                                    temperature
                                })
                            });
                            if (retryRes.ok) {
                                const retryData = await retryRes.json();
                                const retryText = retryData.choices?.[0]?.message?.content || '';
                                if (retryText) return res.status(200).json({ text: retryText });
                            }
                        }
                    }
                } catch (e) {
                    lastErr = e.message;
                }
            }

            return res.status(502).json({
                error: lastErr || 'HuggingFace inference failed. Please ensure your token is valid and you accepted terms on huggingface.co/google/gemma-2-9b-it'
            });
        }

        // --- 2. Fallback Free AI Provider (Pollinations) ---
        const pollRes = await fetch('https://text.pollinations.ai/openai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'openai-fast',
                messages,
                max_tokens: 200,
                temperature: 0.7,
                private: true
            })
        });

        if (pollRes.ok) {
            const pollData = await pollRes.json();
            const text = pollData.choices?.[0]?.message?.content || '';
            return res.status(200).json({ text });
        }

        return res.status(500).json({ error: 'Inference backend failed.' });
    } catch (err) {
        console.error('API Handler Error:', err);
        return res.status(500).json({ error: err.message });
    }
}