/**
 * Fish Audio TTS Client Engine
 * Calls /api/fish-tts serverless proxy → Fish Audio REST API
 * Same interface as ElevenLabsTTS for drop-in replacement.
 */
export class FishAudioTTS {
    constructor(audioContext, options = {}) {
        this.audioContext = audioContext;
        this.referenceId = options.referenceId || null; // Fish Audio voice model ID (optional)
        this.onStart = options.onStart || (() => {});
        this.onEnd = options.onEnd || (() => {});
        this.onSentenceStart = options.onSentenceStart || (() => {});
        this.onError = options.onError || (() => {});

        this.isPlaying = false;
        this.isInterrupted = false;
        this.queue = [];
        this.activeAudioElement = null;
        this.activeAbortController = null;

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
                console.warn('[FishAudioTTS] Audio node error:', e.message);
            }
        }
    }

    setAudioContext(ctx) {
        if (ctx) { this.audioContext = ctx; this.initAudioNodes(); }
    }

    setVoice(referenceId) {
        if (referenceId) this.referenceId = referenceId;
    }

    setSpeed() {} // Not used by Fish Audio currently

    getAnalyser() {
        return this.analyser || null;
    }

    /**
     * Split response into sentences for sentence-by-sentence playback
     */
    splitIntoSentences(text) {
        if (!text) return [];
        const regex = /[^.!?।\n]+[.!?।\n]+(?:\s+|$)|[^.!?।\n]+$/g;
        const matches = text.match(regex) || [];
        return matches.map(s => s.trim()).filter(s => s.length > 0);
    }

    /**
     * Clean text before sending to Fish Audio
     */
    cleanText(text) {
        if (!text) return '';
        return text
            .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
            .replace(/[*_#`~[\]]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Main speak method — splits into sentences and queues
     */
    async speak(text) {
        if (!text || !text.trim()) return;
        this.isInterrupted = false;
        const sentences = this.splitIntoSentences(text);
        if (sentences.length === 0) return;
        sentences.forEach(s => this.queue.push(s));
        if (!this.isPlaying) this.processQueue();
    }

    /**
     * Process sentence queue sequentially
     */
    async processQueue() {
        if (this.queue.length === 0 || this.isInterrupted) {
            this.isPlaying = false;
            this.onEnd();
            return;
        }

        this.isPlaying = true;
        this.onStart();

        while (this.queue.length > 0 && !this.isInterrupted) {
            const sentence = this.queue.shift();
            this.onSentenceStart(sentence);
            await this.speakSentence(sentence);
        }

        this.isPlaying = false;
        if (!this.isInterrupted) this.onEnd();
    }

    /**
     * Synthesize and play one sentence via Fish Audio API
     */
    speakSentence(text) {
        return new Promise(async (resolve) => {
            if (this.isInterrupted) { resolve(); return; }

            const cleanedText = this.cleanText(text);
            if (!cleanedText) { resolve(); return; }

            this.activeAbortController = new AbortController();

            try {
                if (this.audioContext && this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                }

                const ttsRes = await fetch('/api/fish-tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: cleanedText,
                        reference_id: this.referenceId || undefined,
                        format: 'mp3'
                    }),
                    signal: this.activeAbortController.signal
                });

                if (!ttsRes.ok) {
                    const err = await ttsRes.text();
                    throw new Error(`Fish Audio TTS failed (${ttsRes.status}): ${err}`);
                }

                const arrayBuffer = await ttsRes.arrayBuffer();
                if (this.isInterrupted) { resolve(); return; }

                const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
                const audioUrl = URL.createObjectURL(blob);
                const audio = new Audio(audioUrl);
                audio.volume = 1.0;
                this.activeAudioElement = audio;

                let cleaned = false;
                const cleanup = () => {
                    if (cleaned) return;
                    cleaned = true;
                    this.activeAudioElement = null;
                    try { URL.revokeObjectURL(audioUrl); } catch (_) {}
                    resolve();
                };

                audio.onended = cleanup;
                audio.onerror = (e) => {
                    console.warn('[FishAudioTTS] Playback error:', e);
                    cleanup();
                };

                console.log('[FishAudioTTS] 🎵 Playing:', cleanedText.substring(0, 60));
                await audio.play();

            } catch (err) {
                if (err.name === 'AbortError') {
                    console.log('[FishAudioTTS] Aborted.');
                    resolve();
                } else {
                    console.error('[FishAudioTTS] ❌ Error:', err.message);
                    window.dispatchEvent(new CustomEvent('fishaudio-error', { detail: { message: err.message } }));
                    resolve();
                }
            }
        });
    }

    /**
     * Instantly stop all playback and clear queue
     */
    interrupt() {
        this.isInterrupted = true;
        this.queue = [];

        if (this.activeAbortController) {
            try { this.activeAbortController.abort(); } catch (_) {}
            this.activeAbortController = null;
        }

        if (this.activeAudioElement) {
            try {
                this.activeAudioElement.pause();
                this.activeAudioElement.currentTime = 0;
            } catch (_) {}
            this.activeAudioElement = null;
        }

        this.isPlaying = false;
        this.onEnd();
        console.log('[FishAudioTTS] ⛔ Interrupted & queue cleared.');
    }
}
