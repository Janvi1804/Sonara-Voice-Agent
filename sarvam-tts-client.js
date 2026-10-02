/**
 * Sarvam AI TTS Client Engine
 * Calls /api/sarvam-tts serverless proxy → Sarvam bulbul:v3 model
 * Voice: Ritu — natural Hindi/Hinglish female voice
 * Same interface as ElevenLabsTTS for drop-in replacement.
 */
export class SarvamTTS {
    constructor(audioContext, options = {}) {
        this.audioContext = audioContext;
        this.speaker = options.speaker || 'ritu';       // Ritu — natural Hindi/Hinglish
        this.language = options.language || null;        // null = auto-detect
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

    setVoice(speaker) {
        if (speaker) this.speaker = speaker;
    }

    setSpeed(pace) {
        this.pace = pace || 1.0;
    }

    getAnalyser() {
        return this.analyser || null;
    }

    /**
     * Split response into sentences for sentence-by-sentence queue
     */
    splitIntoSentences(text) {
        if (!text) return [];
        const regex = /[^.!?।\n]+[.!?।\n]+(?:\s+|$)|[^.!?।\n]+$/g;
        const matches = text.match(regex) || [];
        return matches.map(s => s.trim()).filter(s => s.length > 0);
    }

    /**
     * Clean text before sending to Sarvam
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
     * Main speak — splits into sentences and queues
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
     * Synthesize and play one sentence via Sarvam TTS API
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

                const ttsRes = await fetch('/api/sarvam-tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: cleanedText,
                        speaker: this.speaker,
                        language_code: this.language || undefined,
                        pace: this.pace
                    }),
                    signal: this.activeAbortController.signal
                });

                if (!ttsRes.ok) {
                    const err = await ttsRes.text();
                    throw new Error(`Sarvam TTS failed (${ttsRes.status}): ${err}`);
                }

                const arrayBuffer = await ttsRes.arrayBuffer();
                if (this.isInterrupted) { resolve(); return; }

                // Sarvam returns audio/wav or audio/mpeg
                const contentType = ttsRes.headers.get('content-type') || 'audio/mpeg';
                const blob = new Blob([arrayBuffer], { type: contentType });
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
                    console.warn('[SarvamTTS] Playback error:', e);
                    cleanup();
                };

                console.log('[SarvamTTS] 🗣️ Playing (Ritu):', cleanedText.substring(0, 60));
                await audio.play();

            } catch (err) {
                if (err.name === 'AbortError') {
                    console.log('[SarvamTTS] Aborted.');
                    resolve();
                } else {
                    console.error('[SarvamTTS] ❌ Error:', err.message);
                    window.dispatchEvent(new CustomEvent('sarvam-error', { detail: { message: err.message } }));
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
        console.log('[SarvamTTS] ⛔ Interrupted & queue cleared.');
    }
}
