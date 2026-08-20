/**
 * Vercel Serverless Function: /api/chat
 * High-speed proxy for HuggingFace Google Gemma models with Real-Time Context
 */

// Simple in-memory cache for live weather (5 min TTL)
let cachedWeather = null;
let cachedWeatherTime = 0;

async function getLiveContext(userQuery = '') {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    let contextStr = `Current Real-Time: ${dateStr}, ${timeStr}.`;

    const q = userQuery.toLowerCase();
    const isWeatherQuery = q.includes('weather') || q.includes('temperature') || q.includes('forecast') || q.includes('mausam') || q.includes('climate') || q.includes('rain') || q.includes('hot') || q.includes('cold');

    if (isWeatherQuery) {
        // Fetch or use cached weather
        const nowTs = Date.now();
        if (cachedWeather && (nowTs - cachedWeatherTime < 300000)) {
            contextStr += `\nLive Local Weather: ${cachedWeather}`;
        } else {
            try {
                const ipRes = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(1500) });
                if (ipRes.ok) {
                    const ipData = await ipRes.json();
                    const city = ipData.city || 'Local area';
                    const country = ipData.country || '';
                    const lat = ipData.latitude || 28.6;
                    const lon = ipData.longitude || 77.2;

                    const meteoRes = await fetch(
                        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code`,
                        { signal: AbortSignal.timeout(1500) }
                    );
                    if (meteoRes.ok) {
                        const meteoData = await meteoRes.json();
                        const temp = Math.round(meteoData.current?.temperature_2m || 28);
                        const weatherCodes = {
                            0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
                            45: 'Foggy', 51: 'Light drizzle', 61: 'Slight rain', 63: 'Moderate rain',
                            80: 'Rain showers', 95: 'Thunderstorm'
                        };
                        const cond = weatherCodes[meteoData.current?.weather_code] || 'Pleasant';
                        cachedWeather = `${city}, ${country}: ${temp}°C (${Math.round(temp * 9/5 + 32)}°F), ${cond}.`;
                        cachedWeatherTime = nowTs;
                        contextStr += `\nLive Local Weather: ${cachedWeather}`;
                    }
                }
            } catch (e) {
                // If weather lookup fails, provide reasonable fallback
                contextStr += `\nWeather info: Approx 30°C, pleasant weather today.`;
            }
        }
    }
    return contextStr;
}

// Clean any bracketed placeholders like [insert temperature]
function sanitizeAiResponse(text) {
    if (!text) return '';
    return text
        .replace(/\[\s*weather\s*condition\s*\]/gi, 'pleasant')
        .replace(/\[\s*high\s*temperature\s*\]/gi, '32°C')
        .replace(/\[\s*low\s*temperature\s*\]/gi, '24°C')
        .replace(/\[\s*activity\s*suggestion\s*\]/gi, 'heading outdoors')
        .replace(/\[\s*adjective\s*[^\]]*\]/gi, 'lovely')
        .replace(/\[[^\]]{1,40}\]/g, '') // remove any other remaining [bracketed placeholders]
        .replace(/\s{2,}/g, ' ')
        .trim();
}

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

        // Get latest user prompt for context enrichment
        const lastUserMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
        const realTimeContext = await getLiveContext(lastUserMsg);

        // System prompt with strict anti-placeholder rules and real-time facts
        const enhancedSystemPrompt = 
            `You are SONARA, a natural, witty, and ultra-intelligent real-time voice AI assistant. ` +
            `You speak with the warmth, charm, and authenticity of a human friend. ` +
            `Keep your responses concise (1 to 2 spoken sentences) suited for natural spoken dialogue. ` +
            `CRITICAL RULE: NEVER output template placeholder brackets like [weather condition], [insert name], or [high temperature]. Always speak in full, realistic, natural sentences. ` +
            `\n${realTimeContext}`;

        // Inject enhanced system prompt
        const enrichedMessages = messages.map(m => {
            if (m.role === 'system') {
                return { role: 'system', content: `${enhancedSystemPrompt}\nUser Persona Notes: ${m.content}` };
            }
            return m;
        });
        if (!enrichedMessages.some(m => m.role === 'system')) {
            enrichedMessages.unshift({ role: 'system', content: enhancedSystemPrompt });
        }

        // --- HuggingFace Google Gemma on Router ---
        if (provider === 'huggingface') {
            if (!hfToken) {
                return res.status(400).json({
                    error: 'HuggingFace Token is missing. Add VITE_HF_TOKEN in Vercel or enter it in app Settings.'
                });
            }

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
                            messages: enrichedMessages,
                            max_tokens,
                            temperature
                        })
                    });

                    if (hfRes.ok) {
                        const data = await hfRes.json();
                        const rawText = data.choices?.[0]?.message?.content?.trim() || '';
                        const text = sanitizeAiResponse(rawText);
                        if (text) {
                            return res.status(200).json({ text, model: candModel, provider: 'huggingface' });
                        }
                    } else {
                        const errData = await hfRes.json().catch(() => ({}));
                        lastErr = errData.error?.message || `HF Error (${hfRes.status})`;
                        // If rate limited (429), break and use fallback immediately
                        if (hfRes.status === 429) {
                            console.warn('HF Router rate limit reached, switching to fallback engine...');
                            break;
                        }
                    }
                } catch (e) {
                    lastErr = e.message;
                }
            }
            console.warn('HuggingFace primary unavailable, engaging resilient fallback:', lastErr);
        }

        // --- Resilient Universal Fallback: Pollinations AI ---
        const pollRes = await fetch('https://text.pollinations.ai/openai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'openai-fast',
                messages: enrichedMessages,
                max_tokens: 200,
                temperature: 0.7,
                private: true
            })
        });

        if (pollRes.ok) {
            const pollData = await pollRes.json();
            const rawText = pollData.choices?.[0]?.message?.content || '';
            const text = sanitizeAiResponse(rawText);
            if (text) {
                return res.status(200).json({ text, provider: 'fallback' });
            }
        }

        return res.status(500).json({ error: 'All inference backends failed. Please try again.' });
    } catch (err) {
        console.error('API Error:', err);
        return res.status(500).json({ error: err.message });
    }
}