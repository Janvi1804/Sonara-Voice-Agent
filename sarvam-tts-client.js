/**
 * Sarvam AI TTS Client Engine — PIPELINED VERSION
 * Eliminates inter-sentence pause by pre-fetching next audio
 * while current sentence is still playing.
 *
 * Pipeline flow:
 *   Fetch[0] → Play[0] + Fetch[1] simultaneously → Play[1] + Fetch[2] → ...
 *   Result: zero gap between sentences (no waiting for network after first sentence)
 */
export class SarvamTTS {
    constructor(audioContext, options = {}) {
        this.audioContext = audioContext;
        this.speaker = options.speaker || 'ritu';
        this.language = options.language || null;
        this.pace = options.pace || 1.0;
        this.onStart = options.onStart || (() => {});
        this.onEnd = options.onEnd || (() => {});
        this.onSentenceStart = options.onSentenceStart || (() => {});
        this.onError = options.onError || (() => {});

        this.isPlaying = false;
        this.isInterrupted = false;
        this.queue = [];
        this.activeAudioElement = null;
        this.activeAbortController = null;
        // Pipeline: pre-fetched audio blobs waiting to play
        this._prefetchMap = new Map();

        this.initAudioNodes();
    }

    initAudioNodes() {
        if (this.audioContext && !this.gainNode) {
            try {
                this.gainNode = this.audioContext.createGain();
                this.analyser = this.audioContext.createAnalyser();
                this.analyser.fftSize = 256;
                this.gainNode.connect(this.analyser);
                this.analyser.connect(this.audioContext.destination);
            } catch (e) {
                console.warn('[SarvamTTS] Audio node error:', e.message);
            }
        }
    }

    setAudioContext(ctx) {
        if (ctx) { this.audioContext = ctx; this.initAudioNodes(); }
    }

    setVoice(speaker) { if (speaker) this.speaker = speaker; }
    setSpeed(pace) { this.pace = pace || 1.0; }
    getAnalyser() { return this.analyser || null; }

    splitIntoSentences(text) {
        if (!text) return [];
        const regex = /[^.!?।\n]+[.!?।\n]+(?:\s+|$)|[^.!?।\n]+$/g;
        const matches = text.match(regex) || [];
        return matches.map(s => s.trim()).filter(s => s.length > 0);
    }

    cleanText(text) {
        if (!text) return '';
        return text
            .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
            .replace(/[*_#`~[\]]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Fetch audio from Sarvam API — returns a Blob or null on failure
     */
    async _fetchAudio(text) {
        try {
            const res = await fetch('/api/sarvam-tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text,
                    speaker: this.speaker,
                    language_code: this.language || undefined,
                    pace: this.pace
                })
            });
            if (!res.ok) {
                const err = await res.text();
                throw new Error(`Sarvam TTS failed (${res.status}): ${err}`);
            }
            const buf = await res.arrayBuffer();
            const contentType = res.headers.get('content-type') || 'audio/mpeg';
            return new Blob([buf], { type: contentType });
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('[SarvamTTS] ❌ Fetch error:', err.message);
                window.dispatchEvent(new CustomEvent('sarvam-error', { detail: { message: err.message } }));
            }
            return null;
        }
    }

    /**
     * Main speak — splits into sentences, starts pipeline
     */
    async speak(text) {
        if (!text || !text.trim()) return;
        this.isInterrupted = false;
        const sentences = this.splitIntoSentences(text);
        if (sentences.length === 0) return;
        sentences.forEach(s => this.queue.push(this.cleanText(s)));
        if (!this.isPlaying) this._runPipeline();
    }

    /**
     * PIPELINE: Fetches next sentence in background while current plays.
     * Eliminates the network wait gap between sentences.
     */
    async _runPipeline() {
        if (this.queue.length === 0 || this.isInterrupted) {
            this.isPlaying = false;
            this._prefetchMap.clear();
            this.onEnd();
            return;
        }

        this.isPlaying = true;
        this.onStart();

        // Pre-fetch first sentence immediately
        const firstText = this.queue[0];
        if (!this._prefetchMap.has(firstText)) {
            this._prefetchMap.set(firstText, this._fetchAudio(firstText));
        }

        while (this.queue.length > 0 && !this.isInterrupted) {
            const currentText = this.queue.shift();

            // Kick off pre-fetch for NEXT sentence in background (no await)
            if (this.queue.length > 0 && !this.isInterrupted) {
                const nextText = this.queue[0];
                if (!this._prefetchMap.has(nextText)) {
                    this._prefetchMap.set(nextText, this._fetchAudio(nextText));
                }
            }

            // Wait for current sentence audio (already being fetched)
            const blobPromise = this._prefetchMap.get(currentText);
            this._prefetchMap.delete(currentText);

            const blob = blobPromise ? await blobPromise : null;

            if (this.isInterrupted) break;

            this.onSentenceStart(currentText);

            if (blob) {
                await this._playBlob(blob);
            } else {
                console.warn('[SarvamTTS] Skipping sentence (fetch failed):', currentText.substring(0, 40));
            }
        }

        this.isPlaying = false;
        this._prefetchMap.clear();
        if (!this.isInterrupted) this.onEnd();
    }

    /**
     * Play a Blob as audio — returns Promise that resolves when playback ends
     */
    _playBlob(blob) {
        return new Promise(async (resolve) => {
            if (this.isInterrupted) { resolve(); return; }

            try {
                if (this.audioContext && this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                }

                const audioUrl = URL.createObjectURL(blob);
                const audio = new Audio(audioUrl);
                audio.volume = 1.0;
                this.activeAudioElement = audio;

                let done = false;
                const cleanup = () => {
                    if (done) return;
                    done = true;
                    this.activeAudioElement = null;
                    try { URL.revokeObjectURL(audioUrl); } catch (_) {}
                    resolve();
                };

                audio.onended = cleanup;
                audio.onerror = (e) => {
                    console.warn('[SarvamTTS] Playback error:', e);
                    cleanup();
                };

                console.log('[SarvamTTS] 🗣️ Playing (Ritu):', blob.size + 'B');
                await audio.play();

            } catch (err) {
                console.warn('[SarvamTTS] Play error:', err.message);
                resolve();
            }
        });
    }

    /**
     * Instantly stop all playback and clear queue
     */
    interrupt() {
        this.isInterrupted = true;
        this.queue = [];
        this._prefetchMap.clear();

        if (this.activeAudioElement) {
            try {
                this.activeAudioElement.pause();
                this.activeAudioElement.currentTime = 0;
            } catch (_) {}
            this.activeAudioElement = null;
        }

        if ('speechSynthesis' in window) {
            try { window.speechSynthesis.cancel(); } catch (_) {}
        }

        this.isPlaying = false;
        this.onEnd();
        console.log('[SarvamTTS] ⛔ Interrupted & pipeline cleared.');
    }
}
