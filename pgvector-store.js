/**
 * PostgreSQL + pgvector Store
 * Manages SQL schema generation, vector upsert, cosine distance (<=>) semantic search,
 * and high-speed local vector database fallback with IndexedDB persistence.
 */

import { EmbeddingsEngine } from './embeddings.js';

export const PGVECTOR_SQL_SCHEMA = `
-- ==========================================================
-- 🐘 CONVERSE AI POSTGRESQL + PGVECTOR ENTERPRISE SCHEMA
-- ==========================================================

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Knowledge embeddings table for RAG
CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    id TEXT PRIMARY KEY,
    page_url TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT,
    content TEXT NOT NULL,
    embedding vector(384) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. HNSW cosine similarity index for sub-millisecond retrieval
CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_cosine 
ON knowledge_embeddings USING hnsw (embedding vector_cosine_ops);

-- 4. Customer database table
CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    email TEXT,
    company TEXT,
    notes TEXT,
    preferences JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Appointments table
CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    service TEXT NOT NULL,
    slot_date DATE NOT NULL,
    slot_time TEXT NOT NULL,
    status TEXT DEFAULT 'confirmed', -- confirmed, cancelled, rescheduled
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_date_time ON appointments (slot_date, slot_time);

-- 6. Conversation & Telemetry audit logs
CREATE TABLE IF NOT EXISTS conversation_logs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    user_input TEXT,
    ai_response TEXT,
    latency_vad_ms INTEGER,
    latency_ttft_ms INTEGER,
    latency_tts_ms INTEGER,
    tool_calls JSONB DEFAULT '[]',
    sentiment TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
`;

export class PgVectorStore {
    constructor(options = {}) {
        this.postgresUrl = options.postgresUrl || '';
        this.embeddings = new EmbeddingsEngine({ dimensions: 384 });
        this.inMemoryStore = [];
        this.dbName = 'ConverseAIVectorDB';
        this.storeName = 'knowledge_embeddings';
        this.isInitialized = false;
    }

    /**
     * Initialize vector store (loads IndexedDB and syncs schema)
     */
    async init() {
        if (this.isInitialized) return;
        await this.initIndexedDB();
        this.isInitialized = true;
    }

    /**
     * Set/update PostgreSQL Connection String
     */
    setPostgresUrl(url) {
        this.postgresUrl = (url || '').trim();
    }

    /**
     * Upsert chunks into vector store
     */
    async upsertChunks(chunks) {
        await this.init();
        const records = [];

        for (const chunk of chunks) {
            const vector = await this.embeddings.embedText(chunk.text);
            const record = {
                id: chunk.id || `doc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
                page_url: chunk.url || 'https://theconverseai.com/',
                title: chunk.title || 'Converse AI Knowledge',
                category: chunk.category || 'General',
                content: chunk.text,
                embedding: vector,
                metadata: {
                    chunk_length: chunk.text.length,
                    timestamp: new Date().toISOString()
                }
            };
            records.push(record);
        }

        // 1. Sync via backend API (uses server-side DATABASE_URL/POSTGRES_URL)
        try {
            await fetch('/api/db', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'upsert_embeddings',
                    data: { records }
                })
            });
        } catch (err) {
            console.warn('Postgres remote sync failed, saved to local pgvector store:', err);
        }

        // 2. Save to local high-speed vector store (IndexedDB & In-Memory)
        this.inMemoryStore = [...records];
        await this.saveToIndexedDB(records);
        return records.length;
    }

    /**
     * Perform Cosine Distance (<=>) Semantic Search (Top-K)
     */
    async similaritySearch(query, topK = 3) {
        await this.init();
        if (!query || typeof query !== 'string') return [];

        const queryVector = await this.embeddings.embedText(query);

        // 1. Attempt remote pgvector query via backend API
        try {
            const res = await fetch('/api/db', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'search_embeddings',
                    data: {
                        query_embedding: queryVector,
                        limit: topK
                    }
                })
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.results) && data.results.length > 0) {
                    return data.results;
                }
            }
        } catch (err) {
            console.warn('Remote pgvector query note (using local store):', err.message);
        }

        // 2. High-Speed Local Cosine Distance Search Fallback
        if (this.inMemoryStore.length === 0) {
            await this.loadFromIndexedDB();
        }

        const scored = this.inMemoryStore.map(doc => {
            const similarity = this.embeddings.cosineSimilarity(queryVector, doc.embedding);
            return {
                id: doc.id,
                page_url: doc.page_url,
                title: doc.title,
                category: doc.category,
                content: doc.content,
                similarity: Number(similarity.toFixed(4))
            };
        });

        // Sort descending by similarity
        scored.sort((a, b) => b.similarity - a.similarity);
        return scored.slice(0, topK);
    }

    /**
     * IndexedDB Storage Adapter
     */
    initIndexedDB() {
        return new Promise((resolve) => {
            if (typeof window === 'undefined' || !('indexedDB' in window)) {
                resolve();
                return;
            }
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
        });
    }

    saveToIndexedDB(records) {
        return new Promise((resolve) => {
            if (typeof window === 'undefined' || !('indexedDB' in window)) {
                resolve();
                return;
            }
            const request = indexedDB.open(this.dbName, 1);
            request.onsuccess = (e) => {
                const db = e.target.result;
                const tx = db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                records.forEach(r => store.put(r));
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            };
            request.onerror = () => resolve();
        });
    }

    loadFromIndexedDB() {
        return new Promise((resolve) => {
            if (typeof window === 'undefined' || !('indexedDB' in window)) {
                resolve([]);
                return;
            }
            const request = indexedDB.open(this.dbName, 1);
            request.onsuccess = (e) => {
                const db = e.target.result;
                const tx = db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const req = store.getAll();
                req.onsuccess = () => {
                    this.inMemoryStore = req.result || [];
                    resolve(this.inMemoryStore);
                };
                req.onerror = () => resolve([]);
            };
            request.onerror = () => resolve([]);
        });
    }
}
