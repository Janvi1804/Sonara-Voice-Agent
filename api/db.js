/**
 * Vercel Serverless Function: /api/db
 * High-speed database proxy for Supabase PostgreSQL + pgvector
 * BUG-002 FIX: Database credentials are NEVER hardcoded here.
 * Set POSTGRES_URL in Vercel Dashboard → Project Settings → Environment Variables.
 */
import pg from 'pg';
const { Pool } = pg;

let poolCache = null;

function getPool(connectionUrl) {
    // Priority: 1. Client-provided custom URL (from user's own Settings), 2. Vercel server env var (our DB)
    const url = connectionUrl || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL || null;
    if (!url) {
        throw new Error('Database not configured. Set POSTGRES_URL in Vercel environment variables.');
    }
    if (!poolCache) {
        poolCache = new Pool({
            connectionString: url,
            ssl: { rejectUnauthorized: false },
            max: 10,
            idleTimeoutMillis: 30000
        });
    }
    return poolCache;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const { action, data, postgresUrl } = body;
        const pool = getPool(postgresUrl);

        switch (action) {
            // --- APPOINTMENTS ---
            case 'save_appointment': {
                const { id, customer_name, phone, service, date_time, status, notes } = data;
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
                `, [id, customer_name, phone, service, date_time, status || 'CONFIRMED', notes || '']);
                return res.status(200).json({ success: true, id });
            }

            case 'get_appointments': {
                const result = await pool.query('SELECT * FROM appointments ORDER BY date_time DESC;');
                return res.status(200).json({ success: true, appointments: result.rows });
            }

            // --- CUSTOMERS ---
            case 'save_customer': {
                const { id, name, phone, email, company, notes, preferred_services } = data;
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
                `, [id, name, phone, email || '', company || '', notes || '', preferred_services || '']);
                return res.status(200).json({ success: true, id });
            }

            case 'get_customers': {
                const result = await pool.query('SELECT * FROM customers ORDER BY created_at DESC;');
                return res.status(200).json({ success: true, customers: result.rows });
            }

            // --- CONVERSATION LOGS ---
            case 'save_log': {
                const { session_id, turn_index, user_input, ai_response, latency_ttft_ms, total_latency_ms, tool_calls } = data;
                await pool.query(`
                    INSERT INTO conversation_logs (session_id, turn_index, user_input, ai_response, latency_ttft_ms, total_latency_ms, tool_calls, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW());
                `, [session_id || '', turn_index || 1, user_input, ai_response, latency_ttft_ms || 0, total_latency_ms || 0, JSON.stringify(tool_calls || [])]);
                return res.status(200).json({ success: true });
            }

            case 'get_logs': {
                const result = await pool.query('SELECT * FROM conversation_logs ORDER BY created_at DESC LIMIT 50;');
                return res.status(200).json({ success: true, logs: result.rows });
            }

            // --- KNOWLEDGE EMBEDDINGS (pgvector) ---
            case 'save_embedding': {
                const { id, title, content, url, embedding } = data;
                const vectorString = Array.isArray(embedding) ? `[${embedding.join(',')}]` : null;
                await pool.query(`
                    INSERT INTO knowledge_embeddings (id, title, content, url, embedding, created_at)
                    VALUES ($1, $2, $3, $4, $5::vector, NOW())
                    ON CONFLICT (id) DO UPDATE SET
                        title = EXCLUDED.title,
                        content = EXCLUDED.content,
                        url = EXCLUDED.url,
                        embedding = EXCLUDED.embedding;
                `, [id, title || '', content, url || '', vectorString]);
                return res.status(200).json({ success: true, id });
            }

            case 'search_embeddings': {
                const { query_embedding, limit = 4 } = data;
                if (!query_embedding || !Array.isArray(query_embedding)) {
                    return res.status(400).json({ error: 'query_embedding array is required' });
                }
                const vectorString = `[${query_embedding.join(',')}]`;
                const result = await pool.query(`
                    SELECT id, title, content, url, 1 - (embedding <=> $1::vector) as similarity
                    FROM knowledge_embeddings
                    WHERE embedding IS NOT NULL
                    ORDER BY embedding <=> $1::vector ASC
                    LIMIT $2;
                `, [vectorString, limit]);
                return res.status(200).json({ success: true, results: result.rows });
            }

            default:
                return res.status(400).json({ error: `Unknown action: ${action}` });
        }

    } catch (err) {
        console.error('Supabase DB API Error:', err);
        return res.status(500).json({ error: err.message });
    }
}
