/**
 * Vercel Serverless Function: /api/notify
 * Secure notification dispatcher for Email (Resend) and WhatsApp (Twilio).
 */
import { setCorsHeaders, checkRateLimit, escapeHtml, validatePhone, validateEmail } from './_utils.js';

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP;

async function sendEmail({ to, subject, html }) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        console.warn('[Notify] RESEND_API_KEY not configured on server — skipping email dispatch');
        return { skipped: true, reason: 'RESEND_API_KEY not set' };
    }
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: 'Sonara by Converse AI <onboarding@resend.dev>',
            to: [to],
            subject,
            html
        })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Resend error: ${JSON.stringify(data)}`);
    return data;
}

async function sendWhatsApp({ to, body, contentSid, contentVariables }) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKeySid  = process.env.TWILIO_API_KEY_SID;
    const apiSecret  = process.env.TWILIO_API_KEY_SECRET;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const from       = process.env.TWILIO_WHATSAPP_FROM;
    const defaultContentSid = process.env.TWILIO_CONTENT_SID;

    if (!accountSid || !from) {
        console.warn('[Notify] Twilio credentials not configured on server — skipping WhatsApp');
        return { skipped: true, reason: 'TWILIO credentials not set' };
    }

    const username = apiKeySid || accountSid;
    const password = apiSecret || authToken;
    if (!password) {
        console.warn('[Notify] Twilio auth token not set — skipping WhatsApp');
        return { skipped: true, reason: 'Auth token missing' };
    }

    const normalized = String(to).replace(/[^0-9+]/g, '');
    const waTo = `whatsapp:${normalized.startsWith('+') ? normalized : '+91' + normalized}`;
    
    // Prefer ContentSid template (required for Trial and business outbound)
    const activeContentSid = contentSid || defaultContentSid;
    const params = new URLSearchParams({ From: from, To: waTo });
    
    if (activeContentSid) {
        params.append('ContentSid', activeContentSid);
        if (contentVariables) {
            params.append('ContentVariables', typeof contentVariables === 'string' ? contentVariables : JSON.stringify(contentVariables));
        }
    } else if (body) {
        params.append('Body', body);
    }

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`Twilio error: ${JSON.stringify(data)}`);
    return data;
}

function customerEmailHtml({ customerName, appointmentId, date, time, service }) {
    const safeName = escapeHtml(customerName);
    const safeAppt = escapeHtml(appointmentId);
    const safeDate = escapeHtml(date);
    const safeTime = escapeHtml(time);
    const safeService = escapeHtml(service);

    return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0f0f1a;color:#e0e0e0;border-radius:12px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#00d4ff,#7b2ff7);padding:24px;text-align:center">
        <h1 style="margin:0;color:#fff;font-size:24px">Appointment Confirmed!</h1>
        <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px">Sonara by Converse AI</p>
      </div>
      <div style="padding:28px">
        <p>Hello <strong>${safeName}</strong>, your appointment is confirmed!</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr style="background:#1a1a2e"><td style="padding:10px 14px;color:#00d4ff;font-weight:bold;width:40%">Appointment ID</td><td style="padding:10px 14px">${safeAppt}</td></tr>
          <tr style="background:#13131f"><td style="padding:10px 14px;color:#00d4ff;font-weight:bold">Service</td><td style="padding:10px 14px">${safeService}</td></tr>
          <tr style="background:#1a1a2e"><td style="padding:10px 14px;color:#00d4ff;font-weight:bold">Date</td><td style="padding:10px 14px">${safeDate}</td></tr>
          <tr style="background:#13131f"><td style="padding:10px 14px;color:#00d4ff;font-weight:bold">Time</td><td style="padding:10px 14px">${safeTime}</td></tr>
        </table>
        <p style="background:#1a1a2e;border-left:3px solid #00d4ff;padding:12px 16px;border-radius:4px;font-size:13px">
          Need to reschedule? Call <strong>+91 99823 23333</strong> or email <strong>contact@theconverseai.com</strong>
        </p>
        <p style="color:#888;font-size:12px;margin-top:24px">See you soon! — Team Converse AI</p>
      </div>
    </div>`;
}

function adminEmailHtml({ customerName, phone, email, appointmentId, date, time, service }) {
    const safeName = escapeHtml(customerName);
    const safePhone = escapeHtml(phone);
    const safeEmail = escapeHtml(email);
    const safeAppt = escapeHtml(appointmentId);
    const safeDate = escapeHtml(date);
    const safeTime = escapeHtml(time);
    const safeService = escapeHtml(service);

    return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0f0f1a;color:#e0e0e0;border-radius:12px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#ff6b35,#f7931e);padding:20px;text-align:center">
        <h1 style="margin:0;color:#fff;font-size:22px">New Appointment Booked</h1>
      </div>
      <div style="padding:28px">
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr style="background:#1a1a2e"><td style="padding:10px 14px;color:#f7931e;font-weight:bold;width:40%">Appointment ID</td><td style="padding:10px 14px">${safeAppt}</td></tr>
          <tr style="background:#13131f"><td style="padding:10px 14px;color:#f7931e;font-weight:bold">Customer</td><td style="padding:10px 14px">${safeName}</td></tr>
          <tr style="background:#1a1a2e"><td style="padding:10px 14px;color:#f7931e;font-weight:bold">Phone</td><td style="padding:10px 14px">${safePhone || 'N/A'}</td></tr>
          <tr style="background:#13131f"><td style="padding:10px 14px;color:#f7931e;font-weight:bold">Email</td><td style="padding:10px 14px">${safeEmail || 'N/A'}</td></tr>
          <tr style="background:#1a1a2e"><td style="padding:10px 14px;color:#f7931e;font-weight:bold">Service</td><td style="padding:10px 14px">${safeService}</td></tr>
          <tr style="background:#13131f"><td style="padding:10px 14px;color:#f7931e;font-weight:bold">Date</td><td style="padding:10px 14px">${safeDate}</td></tr>
          <tr style="background:#1a1a2e"><td style="padding:10px 14px;color:#f7931e;font-weight:bold">Time</td><td style="padding:10px 14px">${safeTime}</td></tr>
        </table>
      </div>
    </div>`;
}

function customerWA({ customerName, appointmentId, date, time, service }) {
    return `Appointment Confirmed!\n\nHello ${customerName},\nYour appointment is booked:\n\nID: ${appointmentId}\nService: ${service}\nDate: ${date}\nTime: ${time}\n\nContact: +91 99823 23333 | contact@theconverseai.com\n\n- Team Converse AI`;
}

function adminWA({ customerName, phone, appointmentId, date, time, service }) {
    return `New Booking - Sonara\n\nID: ${appointmentId}\nCustomer: ${customerName}\nPhone: ${phone || 'N/A'}\nService: ${service}\nDate: ${date}\nTime: ${time}`;
}

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

    // Anti-Spam Rate Limit: max 5 notification dispatches per 5 minutes per IP
    if (!checkRateLimit(req, { maxRequests: 5, windowMs: 300000 })) {
        return res.status(429).json({ error: 'Too many notification requests. Please wait a few minutes.' });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const {
            customerName = 'Valued Customer',
            customerPhone = '',
            customerEmail = '',
            appointmentId = 'APPT-XXXX',
            date = '',
            time = '',
            service = 'Free AI Opportunity Audit'
        } = body;

        // Validation & length limits
        const safeName = String(customerName).slice(0, 100);
        const safeAppt = String(appointmentId).slice(0, 50);
        const safeDate = String(date).slice(0, 50);
        const safeTime = String(time).slice(0, 50);
        const safeService = String(service).slice(0, 100);

        const results = {};

        // 1. Customer Email (only if valid email provided)
        if (customerEmail && validateEmail(customerEmail)) {
            try {
                results.customerEmail = await sendEmail({
                    to: String(customerEmail).trim().toLowerCase(),
                    subject: `Appointment Confirmed - ${safeAppt} | Converse AI`,
                    html: customerEmailHtml({ customerName: safeName, appointmentId: safeAppt, date: safeDate, time: safeTime, service: safeService })
                });
            } catch(e) {
                results.customerEmailError = e.message;
                console.error('[Notify] Customer email error:', e.message);
            }
        }

        // 2. Admin Email
        if (ADMIN_EMAIL) {
            try {
                results.adminEmail = await sendEmail({
                    to: ADMIN_EMAIL,
                    subject: `New Booking ${safeAppt} - ${safeName} | Sonara`,
                    html: adminEmailHtml({ customerName: safeName, phone: customerPhone, email: customerEmail, appointmentId: safeAppt, date: safeDate, time: safeTime, service: safeService })
                });
            } catch(e) {
                results.adminEmailError = e.message;
                console.error('[Notify] Admin email error:', e.message);
            }
        }

        // 3. Customer WhatsApp (only if valid phone provided)
        if (customerPhone && validatePhone(customerPhone)) {
            try {
                results.customerWA = await sendWhatsApp({
                    to: customerPhone,
                    body: customerWA({ customerName: safeName, appointmentId: safeAppt, date: safeDate, time: safeTime, service: safeService }),
                    contentVariables: {
                        '1': `${safeDate} @ ${safeTime} for ${safeName} (Phone: ${customerPhone})`,
                        '2': `${safeService} [ID: ${safeAppt}] | Email: ${customerEmail || 'N/A'}`
                    }
                });
            } catch(e) {
                results.customerWAError = e.message;
                console.error('[Notify] Customer WhatsApp error:', e.message);
            }
        }

        // 4. Admin WhatsApp
        if (ADMIN_WHATSAPP) {
            try {
                results.adminWA = await sendWhatsApp({
                    to: ADMIN_WHATSAPP,
                    body: adminWA({ customerName: safeName, phone: customerPhone, appointmentId: safeAppt, date: safeDate, time: safeTime, service: safeService }),
                    contentVariables: {
                        '1': `${safeDate} @ ${safeTime} for ${safeName} (Phone: ${customerPhone || 'N/A'})`,
                        '2': `${safeService} [ID: ${safeAppt}] | Email: ${customerEmail || 'N/A'}`
                    }
                });
            } catch(e) {
                results.adminWAError = e.message;
                console.error('[Notify] Admin WhatsApp error:', e.message);
            }
        }

        return res.status(200).json({ success: true, results });
    } catch (err) {
        console.error('[Notify] Handler error:', err);
        return res.status(500).json({ error: 'Notification service error. Request recorded.' });
    }
}

