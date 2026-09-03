// Vercel Serverless Function: /api/warm-render
// Pings Render bridge and waits until it's fully awake before returning
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const RENDER_HEALTH = 'https://sonara-voice-agent.onrender.com/health';
    const MAX_WAIT_MS   = 65000; // 65 seconds max
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
    console.warn('[WarmRender] ⚠️ Render did not wake in 65s');
    return res.status(503).json({ status: 'timeout', message: 'Server taking longer than usual. Try calling again.' });
}
