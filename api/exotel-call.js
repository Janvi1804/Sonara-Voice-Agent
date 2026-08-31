/**
 * Vercel Serverless Function: /api/exotel-call
 * Initiates an outbound PSTN/GSM call via Exotel to the user's phone number.
 */
import { setCorsHeaders, checkRateLimit, validateIndianPhone, normalizeIndianPhone } from './_utils.js';

export default async function handler(req, res) {
    const corsAllowed = setCorsHeaders(req, res, 'POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        if (!corsAllowed) return res.status(403).json({ error: 'Forbidden: CORS origin not allowed.' });
        return res.status(200).end();
    }

    if (!corsAllowed && req.headers.origin) {
        return res.status(403).json({ error: 'Forbidden: CORS origin not allowed.' });
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
    }

    // Anti-Spam Rate Limit: max 5 call requests per 5 minutes per IP
    if (!checkRateLimit(req, { maxRequests: 5, windowMs: 300000 })) {
        return res.status(429).json({
            error: 'Too many call requests. Please wait a few minutes before requesting another call.'
        });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const { phone, name } = body;

        if (!phone) {
            return res.status(400).json({ error: 'Phone number is required.' });
        }

        if (!validateIndianPhone(phone)) {
            return res.status(400).json({
                error: 'Invalid phone number. Please provide a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9.'
            });
        }

        const normalizedPhone = normalizeIndianPhone(phone);
        // Exotel expects Indian phone numbers with leading 0 (e.g. 09057201392)
        const exotelFormattedPhone = `0${normalizedPhone}`;

        // Exotel Configuration (Reads from server-side environment variables)
        const accountSid = process.env.EXOTEL_ACCOUNT_SID || 'revtidigital1';
        const apiKey = process.env.EXOTEL_API_KEY;
        const apiToken = process.env.EXOTEL_API_TOKEN;
        const callerId = process.env.EXOTEL_CALLER_ID || '09513886363';
        const appId = process.env.EXOTEL_APP_ID || '1327980';

        if (!apiKey || !apiToken) {
            console.error('[ExotelCall] EXOTEL_API_KEY or EXOTEL_API_TOKEN is missing from environment variables.');
            return res.status(500).json({
                error: 'Exotel API credentials not configured in environment variables. Please add EXOTEL_API_KEY and EXOTEL_API_TOKEN in Vercel settings.'
            });
        }

        const authHeader = 'Basic ' + Buffer.from(`${apiKey}:${apiToken}`).toString('base64');
        const endpoint = `https://api.exotel.com/v1/Accounts/${accountSid}/Calls/connect.json`;

        const params = new URLSearchParams();
        params.append('From', exotelFormattedPhone);
        params.append('CallerId', callerId);
        params.append('Url', `http://my.exotel.com/${accountSid}/exml/start_voice/${appId}`);
        params.append('CallType', 'trans');

        const exotelRes = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString(),
            signal: AbortSignal.timeout(10000)
        });

        const responseText = await exotelRes.text();
        let responseData = {};
        try {
            responseData = JSON.parse(responseText);
        } catch (_) {
            responseData = { raw: responseText };
        }

        if (!exotelRes.ok) {
            console.error('[ExotelCall] API Error:', exotelRes.status, responseText);
            const errorMessage = responseData?.RestException?.Message || `Exotel error (${exotelRes.status})`;

            return res.status(exotelRes.status).json({
                success: false,
                error: errorMessage,
                details: responseData
            });
        }

        const callData = responseData?.Call || responseData;
        console.log(`[ExotelCall] Call initiated successfully to ${exotelFormattedPhone}:`, callData?.Sid || '');

        return res.status(200).json({
            success: true,
            message: `Call initiated! You will receive a call from Exophone ${callerId} shortly.`,
            callSid: callData?.Sid || null
        });

    } catch (err) {
        console.error('[ExotelCall] Server Error:', err);
        return res.status(500).json({
            error: 'Failed to initiate phone call. Please try again or use the browser voice call.'
        });
    }
}
