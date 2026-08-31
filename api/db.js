/**
 * Vercel Serverless Function: /api/db
 * Secure database proxy for Supabase PostgreSQL + pgvector
 */
import pg from 'pg';
import { setCorsHeaders, checkRateLimit } from './_utils.js';

const { Pool } = pg;

let poolCache = null;

function getPool(connectionUrl) {
    const url = connectionUrl || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL;
    if (!url) return null;

    if (!poolCache) {
        poolCache = new Pool({
            connectionString: url,
            ssl: { rejectUnauthorized: false },
            max: 5,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 3000
        });
    }
    return poolCache;
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

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // Rate limit: 60 requests per minute per IP
    if (!checkRateLimit(req, { maxRequests: 60, windowMs: 60000 })) {
        return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const { action, data = {}, postgresUrl } = body;

        // ── Auth Guard for Sensitive Administrative Reads ─────────────────────
        const sensitiveReadActions = ['get_appointments', 'get_customers', 'get_logs'];
        if (sensitiveReadActions.includes(action)) {
            const authHeader = req.headers.authorization || req.headers['x-admin-secret'] || body.adminSecret || '';
            const adminSecret = process.env.ADMIN_SECRET;
            const token = authHeader.replace(/^Bearer\s+/i, '').trim();

            if (!adminSecret || token !== adminSecret) {
                return res.status(401).json({
                    error: 'Unauthorized. Admin credentials required to read database records.'
                });
            }
        }

        const validActions = [
            'save_appointment', 'get_appointments',
            'save_customer', 'get_customers',
            'save_log', 'get_logs',
            'search_embeddings'
        ];
        if (!validActions.includes(action)) {
            return res.status(400).json({ error: `Invalid or unsupported action: ${action}` });
        }

        const pool = getPool(postgresUrl);
        if (!pool) {
            return res.status(200).json({
                success: false,
                fallback: true,
                message: 'PostgreSQL database not configured on server. Operating in local storage mode.',
                appointments: [],
                customers: [],
                logs: []
            });
        }

        switch (action) {
            // --- APPOINTMENTS ---
            case 'save_appointment': {
                const { id, customer_name, phone, service, date_time, status, notes } = data;
                if (!id || !customer_name || !phone || !date_time) {
                    return res.status(400).json({ error: 'Missing required appointment fields (id, customer_name, phone, date_time).' });
                }

                // Sanitize string length limits
                const safeId = String(id).slice(0, 50);
                const safeName = String(customer_name).slice(0, 100);
                const safePhone = String(phone).slice(0, 20);
                const safeService = String(service || 'Free AI Opportunity Audit').slice(0, 100);
                const safeDateTime = String(date_time).slice(0, 50);
                const safeStatus = String(status || 'CONFIRMED').slice(0, 20);
                const safeNotes = String(notes || '').slice(0, 500);

                await pool.query(`
                    INSERT INTO appointments (id, customer_name, phone, service, date_time, status, notes, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                    ON CONFLICT (id) DO UPDATE SET
                        customer_name = EXCLUDED.customer_name,
                        phone = EXCLUDED.phone,
                        service = EXCLUDED.service,
                        date_time = EXCLUDED.date_time,
                        status = EXCLUDED.status,
                        notes = EXCLUDED.notes,
                        updated_at = NOW();
                `, [safeId, safeName, safePhone, safeService, safeDateTime, safeStatus, safeNotes]);
                return res.status(200).json({ success: true, id: safeId });
            }

            case 'get_appointments': {
                const result = await pool.query('SELECT id, customer_name, phone, email, service, date_time, status, notes, created_at FROM appointments ORDER BY date_time DESC LIMIT 100;');
                return res.status(200).json({ success: true, appointments: result.rows });
            }

            // --- CUSTOMERS ---
            case 'save_customer': {
                const { id, name, phone, email, company, notes, preferred_services } = data;
                if (!phone) {
                    return res.status(400).json({ error: 'Customer phone number is required.' });
                }

                const safeId = String(id || `cust_${phone}`).slice(0, 50);
                const safeName = String(name || 'Valued Customer').slice(0, 100);
                const safePhone = String(phone).slice(0, 20);
                const safeEmail = String(email || '').slice(0, 120);
                const safeCompany = String(company || '').slice(0, 100);
                const safeNotes = String(notes || '').slice(0, 500);
                const safeServices = String(preferred_services || '').slice(0, 200);

                await pool.query(`
                    INSERT INTO customers (id, name, phone, email, company, notes, preferred_services, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                    ON CONFLICT (id) DO UPDATE SET
                        name = EXCLUDED.name,
                        phone = EXCLUDED.phone,
                        email = EXCLUDED.email,
                        company = EXCLUDED.company,
                        notes = EXCLUDED.notes,
                        preferred_services = EXCLUDED.preferred_services,
                        updated_at = NOW();
                `, [safeId, safeName, safePhone, safeEmail, safeCompany, safeNotes, safeServices]);
                return res.status(200).json({ success: true, id: safeId });
            }

            case 'get_customers': {
                const result = await pool.query('SELECT id, name, phone, email, company, notes, preferred_services, created_at FROM customers ORDER BY created_at DESC LIMIT 100;');
                return res.status(200).json({ success: true, customers: result.rows });
            }

            // --- CONVERSATION LOGS ---
            case 'save_log': {
                const { session_id, turn_index, user_input, ai_response, latency_ttft_ms, total_latency_ms, tool_calls } = data;
                const safeSessionId = String(session_id || '').slice(0, 60);
                const safeInput = String(user_input || '').slice(0, 2000);
                const safeOutput = String(ai_response || '').slice(0, 4000);

                await pool.query(`
                    INSERT INTO conversation_logs (session_id, turn_index, user_input, ai_response, latency_ttft_ms, total_latency_ms, tool_calls, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW());
                `, [safeSessionId, Number(turn_index) || 1, safeInput, safeOutput, Number(latency_ttft_ms) || 0, Number(total_latency_ms) || 0, JSON.stringify(tool_calls || [])]);
                return res.status(200).json({ success: true });
            }

            case 'get_logs': {
                const result = await pool.query('SELECT * FROM conversation_logs ORDER BY created_at DESC LIMIT 50;');
                return res.status(200).json({ success: true, logs: result.rows });
            }

            // --- KNOWLEDGE EMBEDDINGS (pgvector) ---
            case 'search_embeddings': {
                const { query_embedding, limit = 4 } = data;
                if (!query_embedding || !Array.isArray(query_embedding)) {
                    return res.status(400).json({ error: 'query_embedding array is required' });
                }
                const vectorString = `[${query_embedding.slice(0, 1536).join(',')}]`;
                const safeLimit = Math.min(10, Math.max(1, Number(limit) || 4));
                const result = await pool.query(`
                    SELECT id, title, content, url, 1 - (embedding <=> $1::vector) as similarity
                    FROM knowledge_embeddings
                    WHERE embedding IS NOT NULL
                    ORDER BY embedding <=> $1::vector ASC
                    LIMIT $2;
                `, [vectorString, safeLimit]);
                return res.status(200).json({ success: true, results: result.rows });
            }

            default:
                return res.status(400).json({ error: `Invalid or unsupported action: ${action}` });
        }

    } catch (err) {
        console.warn('Database proxy note (fallback active):', err.message);
        return res.status(200).json({
            success: false,
            fallback: true,
            error: 'Database operation skipped or failed. Local storage active.',
            appointments: [],
            customers: [],
            logs: []
        });
    }
}
