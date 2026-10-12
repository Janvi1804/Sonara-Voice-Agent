// Vercel Serverless Function: /api/warm-render
// Pings Render bridge and waits until it's fully awake before returning
import { setCorsHeaders, checkRateLimit } from './_utils.js';

export default async function handler(req, res) {
    const corsAllowed = setCorsHeaders(req, res, 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
        if (!corsAllowed) return res.status(403).json({ error: 'Forbidden: CORS origin not allowed.' });
        return res.status(200).end();
    }
    if (!corsAllowed && req.headers.origin) {
        return res.status(403).json({ error: 'Forbidden: CORS origin not allowed.' });
    }

    // Any site could otherwise trigger repeated ~25s server-side waits for free — this was
    // the only api/*.js route with no rate limit at all.
    if (!checkRateLimit(req, { maxRequests: 10, windowMs: 60000 })) {
        return res.status(429).json({ error: 'Too many warm-up requests. Please slow down.' });
    }

    const RENDER_HEALTH = 'https://sonara-voice-agent.onrender.com/health';
    // vercel.json caps every api/*.js function at maxDuration: 30s. The old 65s budget
    // meant this route's own 503 "timeout" response was unreachable on a genuinely cold
    // Render instance — the platform would always kill the function first. Keep enough
    // margin under 30s for the final poll's own 3s fetch timeout to still return cleanly.
    const MAX_WAIT_MS   = 25000;
    const POLL_INTERVAL = 2500;  // check every 2.5 seconds
    const start = Date.now();

    console.log('[WarmRender] Starting Render warm-up ping...');

    while (Date.now() - start < MAX_WAIT_MS) {
        try {
            const r = await fetch(RENDER_HEALTH, { signal: AbortSignal.timeout(3000) });
            if (r.ok) {
                const elapsed = Date.now() - start;
                console.log(`[WarmRender] ✅ Render is awake! (took ${elapsed}ms)`);
                return res.status(200).json({ status: 'ready', elapsed_ms: elapsed });
            }
        } catch (_) {
            // Server still waking up — keep polling
        }

        // Wait before next poll
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    // Timeout
    console.warn('[WarmRender] ⚠️ Render did not wake in time');
    return res.status(503).json({ status: 'timeout', message: 'Server taking longer than usual. Try calling again.' });
}
