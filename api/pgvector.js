/**
 * Vercel Serverless Function: /api/pgvector
 * Redirects vector upsert and semantic search directly to the secure /api/db proxy
 */
import dbHandler from './db.js';

export default async function handler(req, res) {
    // Map /api/pgvector payload to /api/db actions
    if (req.method === 'POST') {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        if (body.action === 'upsert') {
            req.body = {
                action: 'upsert_embeddings',
                data: { records: body.records || [] }
            };
        } else if (body.action === 'search') {
            req.body = {
                action: 'search_embeddings',
                data: { query_embedding: body.query_embedding, limit: body.limit || 4 }
            };
        }
    }
    return dbHandler(req, res);
}
