/**
 * Vercel Serverless Function: /api/notify
 * Sends Email (Resend) + WhatsApp (Twilio) notifications to both customer and admin.
 *
 * Required Vercel Environment Variables:
 *   RESEND_API_KEY        - from resend.com (free 3000/month)
 *   TWILIO_ACCOUNT_SID    - from twilio.com
 *   TWILIO_AUTH_TOKEN     - from twilio.com
 *   TWILIO_WHATSAPP_FROM  - e.g. whatsapp:+14155238886 (Twilio sandbox)
 *   ADMIN_EMAIL           - janvisethi801@gmail.com
 *   ADMIN_WHATSAPP        - +919057201392
 */

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || 'janvisethi801@gmail.com';
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '+919057201392';

async function sendEmail({ to, subject, html }) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) { console.warn('[Notify] RESEND_API_KEY not set - skipping email to', to); return { skipped: true }; }
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': Bearer , 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Sonara by Converse AI <onboarding@resend.dev>', to: [to], subject, html })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(Resend error: );
    return data;
}

async function sendWhatsApp({ to, body }) {
    const sid   = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from  = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
    if (!sid || !token) { console.warn('[Notify] Twilio not set - skipping WhatsApp to', to); return { skipped: true }; }
    const normalized = String(to).replace(/[^0-9+]/g, '');
    const waTo = whatsapp:;
    const params = new URLSearchParams({ From: from, To: waTo, Body: body });
    const res = await fetch(https://api.twilio.com/2010-04-01/Accounts//Messages.json, {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + Buffer.from(${sid}:).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(Twilio error: );
    return data;
}

function customerEmailHtml({ customerName, appointmentId, date, time, service }) {
    return <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0f0f1a;color:#e0e0e0;border-radius:12px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#00d4ff,#7b2ff7);padding:24px;text-align:center">
        <h1 style="margin:0;color:#fff;font-size:24px">Appointment Confirmed!</h1>
        <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px">Sonara by Converse AI</p>
      </div>
      <div style="padding:28px">
        <p>Hello <strong></strong>, your appointment is confirmed!</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr style="background:#1a1a2e"><td style="padding:10px 14px;color:#00d4ff;font-weight:bold;width:40%">Appointment ID</td><td style="padding:10px 14px"></td></tr>
          <tr style="background:#13131f"><td style="padding:10px 14px;color:#00d4ff;font-weight:bold">Service</td><td style="padding:10px 14px"></td></tr>
          <tr style="background:#1a1a2e"><td style="padding:10px 14px;color:#00d4ff;font-weight:bold">Date</td><td style="padding:10px 14px"></td></tr>
          <tr style="background:#13131f"><td style="padding:10px 14px;color:#00d4ff;font-weight:bold">Time</td><td style="padding:10px 14px"></td></tr>
        </table>
        <p style="background:#1a1a2e;border-left:3px solid #00d4ff;padding:12px 16px;border-radius:4px;font-size:13px">
          Need to reschedule? Call <strong>+91 99823 23333</strong> or email <strong>contact@theconverseai.com</strong>
        </p>
        <p style="color:#888;font-size:12px;margin-top:24px">See you soon! — Team Converse AI</p>
      </div>
    </div>;
}

function adminEmailHtml({ customerName, phone, email, appointmentId, date, time, service }) {
    return <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0f0f1a;color:#e0e0e0;border-radius:12px;overflow:hidden">
      <div style="background:linear-gradient(135deg,#ff6b35,#f7931e);padding:20px;text-align:center">
        <h1 style="margin:0;color:#fff;font-size:22px">New Appointment Booked</h1>
      </div>
      <div style="padding:28px">
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr style="background:#1a1a2e"><td style="padding:10px 14px;color:#f7931e;font-weight:bold;width:40%">Appointment ID</td><td style="padding:10px 14px"></td></tr>
          <tr style="background:#13131f"><td style="padding:10px 14px;color:#f7931e;font-weight:bold">Customer</td><td style="padding:10px 14px"></td></tr>
          <tr style="background:#1a1a2e"><td style="padding:10px 14px;color:#f7931e;font-weight:bold">Phone</td><td style="padding:10px 14px"></td></tr>
          <tr style="background:#13131f"><td style="padding:10px 14px;color:#f7931e;font-weight:bold">Email</td><td style="padding:10px 14px"></td></tr>
          <tr style="background:#1a1a2e"><td style="padding:10px 14px;color:#f7931e;font-weight:bold">Service</td><td style="padding:10px 14px"></td></tr>
          <tr style="background:#13131f"><td style="padding:10px 14px;color:#f7931e;font-weight:bold">Date</td><td style="padding:10px 14px"></td></tr>
          <tr style="background:#1a1a2e"><td style="padding:10px 14px;color:#f7931e;font-weight:bold">Time</td><td style="padding:10px 14px"></td></tr>
        </table>
      </div>
    </div>;
}

function customerWA({ customerName, appointmentId, date, time, service }) {
    return Appointment Confirmed!\n\nHello ,\nYour appointment is booked:\n\nID: \nService: \nDate: \nTime: \n\nContact: +91 99823 23333 | contact@theconverseai.com\n\n- Team Converse AI;
}

function adminWA({ customerName, phone, appointmentId, date, time, service }) {
    return New Booking - Sonara\n\nID: \nCustomer: \nPhone: \nService: \nDate: \nTime: ;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const { customerName = 'Valued Customer', customerPhone = '', customerEmail = '',
                appointmentId = 'APPT-XXXX', date = '', time = '', service = 'Free AI Opportunity Audit' } = body;

        const results = {};

        // 1. Customer Email
        if (customerEmail) {
            try { results.customerEmail = await sendEmail({ to: customerEmail, subject: Appointment Confirmed -  | Converse AI, html: customerEmailHtml({ customerName, appointmentId, date, time, service }) }); }
            catch(e) { results.customerEmailError = e.message; }
        }

        // 2. Admin Email
        try { results.adminEmail = await sendEmail({ to: ADMIN_EMAIL, subject: New Booking  -  | Sonara, html: adminEmailHtml({ customerName, phone: customerPhone, email: customerEmail, appointmentId, date, time, service }) }); }
        catch(e) { results.adminEmailError = e.message; }

        // 3. Customer WhatsApp
        if (customerPhone) {
            try { results.customerWA = await sendWhatsApp({ to: customerPhone, body: customerWA({ customerName, appointmentId, date, time, service }) }); }
            catch(e) { results.customerWAError = e.message; }
        }

        // 4. Admin WhatsApp
        try { results.adminWA = await sendWhatsApp({ to: ADMIN_WHATSAPP, body: adminWA({ customerName, phone: customerPhone, appointmentId, date, time, service }) }); }
        catch(e) { results.adminWAError = e.message; }

        console.log('[Notify] Done:', JSON.stringify(results));
        return res.status(200).json({ success: true, results });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
