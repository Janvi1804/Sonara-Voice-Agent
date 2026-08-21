/**
 * RAG Pipeline (Retrieval-Augmented Generation)
 * Retrieves top-K verified context chunks from PostgreSQL + pgvector and formats for LLM prompt.
 */

import { PgVectorStore } from './pgvector-store.js';
import { WebsiteCrawler } from './crawler.js';

export class RAGEngine {
    constructor(options = {}) {
        this.vectorStore = new PgVectorStore(options);
        this.crawler = new WebsiteCrawler();
        this.isReady = false;
    }

    /**
     * Initialize RAG engine by crawling & embedding theconverseai.com if vector store is empty
     */
    async init() {
        if (this.isReady) return;
        await this.vectorStore.init();
        const existing = await this.vectorStore.loadFromIndexedDB();
        if (!existing || existing.length === 0) {
            const chunks = await this.crawler.crawl();
            await this.vectorStore.upsertChunks(chunks);
        }
        this.isReady = true;
    }

    /**
     * Retrieve relevant knowledge chunks for user query
     */
    async retrieveContext(query, topK = 3) {
        await this.init();
        if (!query || query.trim().length === 0) return '';

        const results = await this.vectorStore.similaritySearch(query, topK);
        if (!results || results.length === 0) return '';

        // Filter results with meaningful similarity score
        const relevant = results.filter(r => r.similarity >= 0.15 || results.length <= 2);
        if (relevant.length === 0) return '';

        const formatted = relevant.map((r, idx) => {
            return `[VERIFIED CHUNK #${idx + 1} | ${r.title} (${r.category})]:\n${r.content}`;
        }).join('\n\n');

        return `\n\n--- OFFICIAL THECONVERSEAI.COM PGVECTOR RAG CONTEXT ---\n${formatted}\n(CRITICAL: Base your response strictly on the above verified knowledge from theconverseai.com.)\n`;
    }
}
