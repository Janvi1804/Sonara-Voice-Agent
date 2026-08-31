/**
 * Shared Utilities for Vercel Serverless Functions
 * Provides strict fail-closed CORS, instance-local IP rate limiting,
 * Indian phone number validation, email validation, and HTML sanitization.
 */

// NOTE ON RATE LIMITING:
// In Vercel serverless / edge environments, this in-memory Map is instance-local
// and provides sliding-window protection against burst abuse per function instance.
// It is not a globally distributed rate limiter (which would require external Redis/KV).
const ipRateLimits = new Map();

/**
 * Configure and enforce strict fail-closed CORS headers
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @param {string} methods - Allowed HTTP methods
 * @returns {boolean} - true if origin is allowed or same-origin/dev, false if rejected
 */
export function setCorsHeaders(req, res, methods = 'GET, POST, OPTIONS') {
    const origin = req.headers.origin || '';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const allowedOrigin = (process.env.ALLOWED_ORIGIN || '').trim();
    const isDev = process.env.NODE_ENV !== 'production' && !process.env.VERCEL;

    let isAllowed = false;

    // 1. Same-Origin Check: When user visits site and calls its own API
    if (origin && host) {
        const originHost = origin.replace(/^https?:\/\//, '').split(':')[0].toLowerCase();
        const currentHost = host.split(':')[0].toLowerCase();
        if (originHost === currentHost) {
            isAllowed = true;
        }
    }

    // 2. Explicit ALLOWED_ORIGIN configuration (exact match, list, or wildcard)
    if (!isAllowed && allowedOrigin) {
        const allowedList = allowedOrigin.split(',').map(o => o.trim());
        if (allowedList.includes(origin) || allowedList.includes('*')) {
            isAllowed = true;
        }
    }

    // 3. Vercel deployment preview / production URLs (e.g. *.vercel.app)
    if (!isAllowed && origin && !allowedOrigin) {
        try {
            const parsed = new URL(origin);
            if (parsed.hostname.endsWith('.vercel.app')) {
                isAllowed = true;
            }
        } catch (_) {}
    }

    // 4. Local Development: permit localhost and 127.0.0.1
    if (!isAllowed && isDev) {
        if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
            isAllowed = true;
        }
    }

    if (isAllowed && origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', methods);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Secret');
        res.setHeader('Access-Control-Max-Age', '86400');
    }

    return isAllowed || !origin;
}

/**
 * Instance-local Sliding-Window IP Rate Limiter
 * @param {object} req - Request object
 * @param {object} options - { maxRequests: number, windowMs: number }
 * @returns {boolean} - true if request is allowed, false if rate limited
 */
export function checkRateLimit(req, { maxRequests = 30, windowMs = 60000 } = {}) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();

    const record = ipRateLimits.get(ip) || { count: 0, startTime: now };

    // Reset window if expired
    if (now - record.startTime > windowMs) {
        record.count = 1;
        record.startTime = now;
        ipRateLimits.set(ip, record);
        return true;
    }

    record.count += 1;
    ipRateLimits.set(ip, record);

    // Clean up stale IPs periodically
    if (ipRateLimits.size > 2000) {
        for (const [key, val] of ipRateLimits.entries()) {
            if (now - val.startTime > windowMs) {
                ipRateLimits.delete(key);
            }
        }
    }

    return record.count <= maxRequests;
}

/**
 * Sanitize strings for safe HTML rendering in email templates (prevents HTML/XSS injection)
 */
export function escapeHtml(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Validate Indian mobile numbers.
 * Must be exactly 10 digits and start with 6, 7, 8, or 9.
 * Accepts optional +91 or 0 prefix which is stripped before validation.
 */
export function validateIndianPhone(phone) {
    if (!phone || (typeof phone !== 'string' && typeof phone !== 'number')) return false;
    let clean = String(phone).trim().replace(/[\s\-()]/g, '');
    if (clean.startsWith('+91')) {
        clean = clean.slice(3);
    } else if (clean.startsWith('91') && clean.length === 12) {
        clean = clean.slice(2);
    } else if (clean.startsWith('0') && clean.length === 11) {
        clean = clean.slice(1);
    }
    return /^[6-9]\d{9}$/.test(clean);
}

/**
 * Normalize Indian phone to standard 10 digits
 */
export function normalizeIndianPhone(phone) {
    if (!phone) return '';
    let clean = String(phone).trim().replace(/[\s\-()]/g, '');
    if (clean.startsWith('+91')) {
        clean = clean.slice(3);
    } else if (clean.startsWith('91') && clean.length === 12) {
        clean = clean.slice(2);
    } else if (clean.startsWith('0') && clean.length === 11) {
        clean = clean.slice(1);
    }
    return clean;
}

/**
 * Validate phone numbers (Strict Indian validation for appointment & notification flow)
 */
export function validatePhone(phone) {
    return validateIndianPhone(phone);
}

/**
 * Validate email format
 */
export function validateEmail(email) {
    if (!email) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

/**
 * Safe error response that logs diagnostic details to server console without leaking internal details to client
 */
export function handleApiError(res, err, publicMessage = 'An internal error occurred. Please try again.') {
    console.error('[API Error]:', err);
    return res.status(500).json({ error: publicMessage });
}

