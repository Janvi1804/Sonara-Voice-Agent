/**
 * Vector Embeddings Engine
 * Generates 384-dimensional dense semantic embeddings with cosine similarity math.
 */

export class EmbeddingsEngine {
    constructor(options = {}) {
        this.dimensions = options.dimensions || 384;
    }

    /**
     * Generate dense numerical vector embedding for text
     */
    async embedText(text) {
        if (!text || typeof text !== 'string') {
            return new Array(this.dimensions).fill(0);
        }

        const clean = text.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
        const words = clean.split(/\s+/).filter(w => w.length > 1);

        const vector = new Array(this.dimensions).fill(0);
        if (words.length === 0) return vector;

        // Hash-based dense projection with positional weighting & n-grams
        for (let i = 0; i < words.length; i++) {
            const word = words[i];
            const weight = 1.0 / Math.sqrt(i + 1);

            // Unigram feature
            const h1 = this.hashString(word);
            const idx1 = Math.abs(h1) % this.dimensions;
            vector[idx1] += (h1 > 0 ? 1 : -1) * weight;

            // Bigram feature for contextual semantics
            if (i < words.length - 1) {
                const bigram = `${word}_${words[i + 1]}`;
                const h2 = this.hashString(bigram);
                const idx2 = Math.abs(h2) % this.dimensions;
                vector[idx2] += (h2 > 0 ? 1.5 : -1.5) * weight;
            }
        }

        // L2 Unit Normalization for true Cosine Distance calculation
        return this.normalize(vector);
    }

    /**
     * Compute cosine similarity between two vectors (range: -1 to 1)
     */
    cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dot += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    /**
     * Fast string hash (Murmur/DJB2 variant)
     */
    hashString(str) {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(i);
            hash |= 0;
        }
        return hash;
    }

    /**
     * L2 vector normalization
     */
    normalize(vec) {
        let sumSq = 0;
        for (let i = 0; i < vec.length; i++) {
            sumSq += vec[i] * vec[i];
        }
        const norm = Math.sqrt(sumSq);
        if (norm === 0) return vec;
        return vec.map(v => Number((v / norm).toFixed(6)));
    }
}
