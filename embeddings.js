/**
 * Vector Embeddings Engine — Real ML Semantic Embeddings
 * Uses @xenova/transformers with all-MiniLM-L6-v2 (384-dim)
 * Replaces hash-based pseudo-embeddings with genuine semantic understanding.
 *
 * Why all-MiniLM-L6-v2:
 *  - 384 dimensions — exact match for pgvector schema (vector(384))
 *  - Runs locally in Node.js (no API call, no cost, no latency)
 *  - "capital of France" vs "Converse AI pricing" → genuinely different vectors
 *  - First call downloads ~23MB model, then cached permanently
 */

let _embedder = null;
let _embedderLoading = false;
let _embedderReady = false;
let _embedderFailed = false;

async function getEmbedder() {
    if (_embedderReady && _embedder) return _embedder;
    if (_embedderFailed) return null;
    if (_embedderLoading) {
        // Wait for ongoing load
        while (_embedderLoading) {
            await new Promise(r => setTimeout(r, 50));
        }
        return _embedder;
    }
    _embedderLoading = true;
    try {
        let pipeline;
        if (typeof window !== 'undefined') {
            // Browser environment (Live Server / Vite / static web)
            const module = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
            if (module.env) {
                module.env.allowLocalModels = false;
            }
            pipeline = module.pipeline;
        } else {
            // Node.js environment (serverless / backend)
            const module = await import('@xenova/transformers');
            if (module.env && (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)) {
                module.env.cacheDir = '/tmp/.cache';
            }
            pipeline = module.pipeline;
        }
        _embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        _embedderReady = true;
        console.log('[EmbeddingsEngine] ✅ all-MiniLM-L6-v2 loaded — real semantic embeddings active');
    } catch (err) {
        _embedderFailed = true;
        console.warn('[EmbeddingsEngine] ML model unavailable in this context, using fast local fallback:', err.message);
        _embedder = null;
    } finally {
        _embedderLoading = false;
    }
    return _embedder;
}

export class EmbeddingsEngine {
    constructor(options = {}) {
        this.dimensions = options.dimensions || 384;
    }

    /**
     * Generate 384-dim semantic embedding using all-MiniLM-L6-v2
     * Falls back to hash-based if model fails to load
     */
    async embedText(text) {
        if (!text || typeof text !== 'string') {
            return new Array(this.dimensions).fill(0);
        }

        try {
            const embedder = await getEmbedder();
            if (embedder) {
                const output = await embedder(text.slice(0, 512), {
                    pooling: 'mean',
                    normalize: true
                });
                return Array.from(output.data); // 384-dim float array
            }
        } catch (err) {
            console.warn('[EmbeddingsEngine] ML embedding failed, using fallback:', err.message);
        }

        // Fallback: hash-based (if model unavailable)
        return this._hashEmbed(text);
    }

    /**
     * Compute cosine similarity between two vectors (range: -1 to 1)
     */
    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dot += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Hash-based fallback (preserved for offline/error scenarios)
     */
    _hashEmbed(text) {
        const clean = text.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
        const words = clean.split(/\s+/).filter(w => w.length > 1);
        const vector = new Array(this.dimensions).fill(0);
        if (words.length === 0) return vector;

        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const weight = 1.0 / Math.sqrt(i + 1);
            const h1 = this._hash(word);
            vector[Math.abs(h1) % this.dimensions] += (h1 > 0 ? 1 : -1) * weight;
            if (i < words.length - 1) {
                const h2 = this._hash(`${word}_${words[i + 1]}`);
                vector[Math.abs(h2) % this.dimensions] += (h2 > 0 ? 1.5 : -1.5) * weight;
            }
        }
        return this._normalize(vector);
    }

    _hash(str) {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }

    _normalize(vec) {
        let sumSq = 0;
        for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
        const norm = Math.sqrt(sumSq);
        if (norm === 0) return vec;
        return vec.map(v => Number((v / norm).toFixed(6)));
    }
}
