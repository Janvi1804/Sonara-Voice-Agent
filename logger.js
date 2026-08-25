/**
 * Conversation Logging & Quality Telemetry Manager
 * Captures conversation turns, speech telemetry (VAD, TTFT, TTS), tool executions, and exports logs as JSON/CSV.
 */

export class ConversationLogger {
    constructor(options = {}) {
        this.postgresUrl = options.postgresUrl || '';
        this.dbName = 'ConverseAILogsDB';
        this.storeName = 'conversation_logs';
        this.currentSessionId = `session_${Date.now()}`;
        this.inMemoryLogs = [];
        this.turnIndex = 0;
        this.isInitialized = false;
    }

    async init() {
        if (this.isInitialized) return;
        await this.initIndexedDB();
        await this.loadAll();
        this.isInitialized = true;
    }

    setPostgresUrl(url) {
        this.postgresUrl = (url || '').trim();
    }

    /**
     * Log a completed dialogue turn with telemetry
     */
    async logTurn({
        userInput,
        aiResponse,
        latencyVadMs = 0,
        latencyTtftMs = 0,
        latencyTtsMs = 0,
        toolCalls = [],
        sentiment = 'neutral'
    }) {
        await this.init();
        this.turnIndex++;

        const record = {
            id: `log_${this.currentSessionId}_t${this.turnIndex}`,
            session_id: this.currentSessionId,
            turn_index: this.turnIndex,
            user_input: userInput || '',
            ai_response: aiResponse || '',
            latency_vad_ms: latencyVadMs,
            latency_ttft_ms: latencyTtftMs,
            latency_tts_ms: latencyTtsMs,
            total_latency_ms: latencyVadMs + latencyTtftMs + latencyTtsMs,
            tool_calls: toolCalls,
            sentiment,
            created_at: new Date().toISOString()
        };

        this.inMemoryLogs.push(record);
        await this.saveToIndexedDB(record);

        // Remote PostgreSQL sync if connection string configured
        if (this.postgresUrl) {
            try {
                await fetch('/api/db', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'save_log',
                        postgresUrl: this.postgresUrl,
                        data: record
                    })
                });
            } catch (err) {
                console.warn('Postgres log sync note:', err);
            }
        }

        return record;
    }

    /**
     * Get all logs
     */
    async getAllLogs() {
        await this.init();
        return this.inMemoryLogs;
    }

    /**
     * Export all logs as JSON format
     */
    exportAsJSON() {
        return JSON.stringify(this.inMemoryLogs, null, 2);
    }

    /**
     * Export all logs as CSV format
     */
    exportAsCSV() {
        if (this.inMemoryLogs.length === 0) return 'No logs available';
        const headers = [
            'Turn ID', 'Session ID', 'Turn', 'Timestamp', 'User Speech', 'AI Response',
            'VAD Latency (ms)', 'TTFT Latency (ms)', 'TTS Latency (ms)', 'Total Latency (ms)', 'Tool Calls'
        ];

        const rows = this.inMemoryLogs.map(l => [
            `"${l.id}"`,
            `"${l.session_id}"`,
            l.turn_index,
            `"${l.created_at}"`,
            `"${(l.user_input || '').replace(/"/g, '""')}"`,
            `"${(l.ai_response || '').replace(/"/g, '""')}"`,
            l.latency_vad_ms,
            l.latency_ttft_ms,
            l.latency_tts_ms,
            l.total_latency_ms,
            `"${JSON.stringify(l.tool_calls || []).replace(/"/g, '""')}"`
        ]);

        return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    }

    /**
     * Clear local logs
     */
    async clearLogs() {
        this.inMemoryLogs = [];
        this.turnIndex = 0;
        if (typeof window !== 'undefined' && 'indexedDB' in window) {
            const request = indexedDB.open(this.dbName, 1);
            request.onsuccess = (e) => {
                const db = e.target.result;
                const tx = db.transaction(this.storeName, 'readwrite');
                tx.objectStore(this.storeName).clear();
            };
        }
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

    saveToIndexedDB(record) {
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
                store.put(record);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            };
            request.onerror = () => resolve();
        });
    }

    loadAll() {
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
                    this.inMemoryLogs = req.result || [];
                    this.turnIndex = this.inMemoryLogs.length;
                    resolve(this.inMemoryLogs);
                };
                req.onerror = () => resolve([]);
            };
            request.onerror = () => resolve([]);
        });
    }
}
