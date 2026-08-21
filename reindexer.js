/**
 * Website Re-Indexing & Vector Sync Engine
 * Re-crawls website pages, generates fresh dense embeddings, and synchronizes with PostgreSQL + pgvector.
 */

import { WebsiteCrawler } from './crawler.js';
import { PgVectorStore } from './pgvector-store.js';

export class ReindexerEngine {
    constructor(options = {}) {
        this.crawler = new WebsiteCrawler(options);
        this.vectorStore = options.vectorStore || new PgVectorStore(options);
        this.isIndexing = false;
        this.onProgress = options.onProgress || (() => {});
    }

    /**
     * Trigger complete website re-indexing
     */
    async reindex(customUrl = '') {
        if (this.isIndexing) return { success: false, message: 'Re-indexing is already in progress.' };

        this.isIndexing = true;
        const startTime = performance.now();
        this.onProgress({ status: 'started', message: 'Starting website crawl...' });

        try {
            // 1. Crawl all pages
            this.onProgress({ status: 'crawling', message: 'Crawling official pages from theconverseai.com...' });
            const chunks = await this.crawler.crawl(customUrl);

            // 2. Vectorize and upsert into PostgreSQL + pgvector
            this.onProgress({ status: 'vectorizing', message: `Generating embeddings for ${chunks.length} chunks...` });
            const upsertedCount = await this.vectorStore.upsertChunks(chunks);

            const durationMs = Math.round(performance.now() - startTime);
            this.isIndexing = false;

            const result = {
                success: true,
                chunksCount: chunks.length,
                upsertedCount,
                durationMs,
                message: `Successfully re-indexed ${upsertedCount} chunks in ${durationMs}ms.`
            };

            this.onProgress({ status: 'completed', result });
            return result;

        } catch (err) {
            this.isIndexing = false;
            this.onProgress({ status: 'error', error: err.message });
            return {
                success: false,
                error: err.message
            };
        }
    }
}
