/**
 * Vercel Serverless Function: /api/chat
 * High-speed proxy for HuggingFace Google Gemma models via https://router.huggingface.co/v1/chat/completions
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
            model = 'google/gemma-3-12b-it',
            hfToken: clientHfToken,
            provider = 'huggingface',
            temperature = 0.65,
            max_tokens = 250
        } = body;

        const hfToken = clientHfToken || process.env.VITE_HF_TOKEN || process.env.HF_TOKEN || '';

        // --- HuggingFace Google Gemma Models on HF Router ---
        if (provider === 'huggingface') {
            if (!hfToken) {
                return res.status(400).json({
                    error: 'HuggingFace Token is missing. Add VITE_HF_TOKEN in Vercel or enter it in app Settings.'
                });
            }

            // Map frontend model names to active HuggingFace router models
            const hfModelMap = {
                'gemma2-9b-it': 'google/gemma-3-12b-it',
                'gemma2-27b-it': 'google/gemma-3-27b-it',
                'gemma-3-12b-it': 'google/gemma-3-12b-it',
                'gemma-3-27b-it': 'google/gemma-3-27b-it',
                'gemma-3-4b-it': 'google/gemma-3-4b-it',
                'google/gemma-2-9b-it': 'google/gemma-3-12b-it',
                'google/gemma-3-12b-it': 'google/gemma-3-12b-it',
                'google/gemma-3-27b-it': 'google/gemma-3-27b-it',
                'google/gemma-3-4b-it': 'google/gemma-3-4b-it'
            };

            const targetModel = hfModelMap[model] || 'google/gemma-3-12b-it';
            const candidateModels = [targetModel, 'google/gemma-3-12b-it', 'google/gemma-3-4b-it', 'google/gemma-3-27b-it'];
            // Remove duplicates
            const uniqueModels = [...new Set(candidateModels)];

            let lastErr = null;

            for (const candModel of uniqueModels) {
                try {
                    const hfRes = await fetch('https://router.huggingface.co/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${hfToken}`
                        },
                        body: JSON.stringify({
                            model: candModel,
                            messages,
                            max_tokens,
                            temperature
                        })
                    });

                    if (hfRes.ok) {
                        const data = await hfRes.json();
                        const text = data.choices?.[0]?.message?.content?.trim() || '';
                        if (text) {
                            return res.status(200).json({ text, model: candModel });
                        }
                    } else {
                        const errData = await hfRes.json().catch(() => ({}));
                        lastErr = errData.error?.message || `HF Error (${hfRes.status})`;
                    }
                } catch (e) {
                    lastErr = e.message;
                }
            }

            return res.status(502).json({
                error: lastErr || 'HuggingFace Gemma models did not respond. Check your HF token permissions.'
            });
        }

        // --- Fallback: Pollinations AI ---
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

        return res.status(500).json({ error: 'Backend error' });
    } catch (err) {
        console.error('API Error:', err);
        return res.status(500).json({ error: err.message });
    }
}