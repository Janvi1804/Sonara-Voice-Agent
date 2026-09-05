/**
 * ElevenLabs Text-to-Speech (TTS) Engine
 * Ultra-realistic, low-latency voice synthesis via ElevenLabs API (eleven_flash_v2_5)
 * with sentence-level streaming, sentence queueing, and instant barge-in cancellation.
 */
export class ElevenLabsTTS {
    constructor(audioContext, options = {}) {
        this.audioContext = audioContext;
        this.voiceId = options.voiceId || 'cgSgspJ2msm6clMCkdW9'; // Jessica (Official Converse AI Voice)
        this.modelId = options.modelId || 'eleven_flash_v2_5';
        this.onStart = options.onStart || (() => {});
        this.onEnd = options.onEnd || (() => {});
        this.onSentenceStart = options.onSentenceStart || (() => {});

        this.isPlaying = false;
        this.isInterrupted = false;
        this.queue = [];
        this.activeSource = null;
        this.textBuffer = '';
        this.onError = options.onError || (() => {});
        this.initAudioNodes();
        this.activeAbortController = null;
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
                console.warn('[ElevenLabsTTS] Error creating audio nodes:', e.message);
            }
        }
    }

    setAudioContext(ctx) {
        if (ctx) {
            this.audioContext = ctx;
            this.initAudioNodes();
        }
    }

    setVoice(voiceId) {
        if (voiceId) this.voiceId = voiceId;
    }

    setSpeed(speedVal) {
        // Handled via ElevenLabs voice settings if needed
    }

    getAnalyser() {
        return this.analyser;
    }

    /**
     * Clean text of markdown, latex, emojis and robotic syntax for fluent human speech
     */
    humanizeSpokenText(text) {
        if (!text) return '';
        let cleaned = text
            .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
            .replace(/\bAI\b/g, 'A I')
            .replace(/\bAPI\b/g, 'A P I')
            .replace(/\bCRM\b/g, 'C R M')
            .replace(/\bERP\b/g, 'E R P')
            .replace(/\bRAG\b/g, 'R A G')
            .replace(/\bCSAT\b/g, 'C SAT')
            .replace(/\bNPS\b/g, 'N P S')
            .replace(/\bROI\b/g, 'R O I')
            .replace(/theconverseai\.com/gi, 'the converse A I dot com')
            .replace(/contact@theconverseai\.com/gi, 'contact at the converse A I dot com')
            .replace(/\+91-(\d{5})(\d{5})/g, '+91 $1 $2')
            .replace(/[*_#`~[\]]/g, '')
            .replace(/\s+/g, ' ')
            .trim();

        return cleaned;
    }

    /**
     * Split text stream into speakable sentence boundaries
     */
    splitIntoSentences(text) {
        if (!text) return [];
        // Matches sentence terminators (. ! ? | \n) followed by whitespace or end of string
        const regex = /[^.!?।\n]+[.!?।\n]+(?:\s+|$)|[^.!?।\n]+$/g;
        const matches = text.match(regex) || [];
        return matches.map(s => s.trim()).filter(s => s.length > 0);
    }

    /**
     * Speak text chunk (streams sentences into queue for low-latency playback)
     */
    async speak(text) {
        if (!text || !text.trim()) return;

        this.isInterrupted = false;
        const sentences = this.splitIntoSentences(text);

        if (sentences.length === 0) return;

        sentences.forEach(s => this.queue.push(s));

        if (!this.isPlaying) {
            this.processQueue();
        }
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
        if (!this.isInterrupted) {
            this.onEnd();
        }
    }

    /**
     * Synthesize and play one individual sentence via ElevenLabs API
     */
    speakSentence(text) {
        return new Promise(async (resolve) => {
            if (this.isInterrupted) { resolve(); return; }

            const spokenText = this.humanizeSpokenText(text);
            if (!spokenText) { resolve(); return; }

            this.activeAbortController = new AbortController();

            try {
                if (this.audioContext && this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                }

                const ttsRes = await fetch('/api/elevenlabs-tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: spokenText,
                        voice_id: this.voiceId,
                        model_id: this.modelId
                    }),
                    signal: this.activeAbortController.signal
                });

                if (!ttsRes.ok) {
                    const err = await ttsRes.text();
                    throw new Error(`ElevenLabs TTS failed (${ttsRes.status}): ${err}`);
                }

                const arrayBuffer = await ttsRes.arrayBuffer();

                if (this.isInterrupted) { resolve(); return; }

                const audioCtx = this.audioContext || new AudioContext();
                const decoded = await audioCtx.decodeAudioData(arrayBuffer);

                if (this.isInterrupted) { resolve(); return; }

                const source = audioCtx.createBufferSource();
                source.buffer = decoded;
                this.activeSource = source;

                // Connect to destination through gain & analyser
                if (this.gainNode && this.analyser) {
                    source.connect(this.gainNode);
                } else {
                    source.connect(audioCtx.destination);
                }

                source.onended = () => {
                    this.activeSource = null;
                    resolve();
                };

                source.start(0);
                console.log('[ElevenLabsTTS] 🗣️ Playing:', spokenText.substring(0, 60));

            } catch (err) {
                if (err.name === 'AbortError') {
                    console.log('[ElevenLabsTTS] Synthesis aborted.');
                    resolve();
                } else {
                    console.warn('[ElevenLabsTTS] Quota exceeded or synthesis error, falling back to Web Speech API:', err.message);
                    this.speakWebSpeechFallback(spokenText, resolve);
                }
            }
        });
    }

    /**
     * Browser Web Speech Fallback: Plays audio smoothly when ElevenLabs quota is exhausted
     */
    speakWebSpeechFallback(text, resolve) {
        if (!('speechSynthesis' in window)) {
            resolve();
            return;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        const available = window.speechSynthesis.getVoices();
        const isDevanagari = /[\u0900-\u097F]/.test(text);

        if (isDevanagari) {
            const hindiVoices = available.filter(v =>
                (v.lang && v.lang.toLowerCase().startsWith('hi')) ||
                v.name.toLowerCase().includes('hindi') ||
                v.name.toLowerCase().includes('swara')
            );
            const matchedHindi = hindiVoices.find(v => !v.name.toLowerCase().includes('male')) || hindiVoices[0];
            if (matchedHindi) { utterance.voice = matchedHindi; utterance.lang = matchedHindi.lang || 'hi-IN'; }
            else { utterance.lang = 'hi-IN'; }
        } else {
            const enVoices = available.filter(v => v.lang && (v.lang.toLowerCase().startsWith('en-us') || v.lang.toLowerCase().startsWith('en-in')));
            const preferred = enVoices.find(v => v.name.toLowerCase().includes('google') && !v.name.toLowerCase().includes('female')) ||
                              enVoices.find(v => !v.name.toLowerCase().includes('male')) ||
                              enVoices[0];
            if (preferred) { utterance.voice = preferred; utterance.lang = preferred.lang; }
            else { utterance.lang = 'en-US'; }
        }

        utterance.pitch = 1.05;
        utterance.rate  = 1.05;

        utterance.onend = () => { resolve(); };
        utterance.onerror = (e) => {
            if (e.error !== 'interrupted' && e.error !== 'canceled') {
                console.warn('[ElevenLabsTTS] Web Speech fallback error:', e.error);
            }
            resolve();
        };

        window.speechSynthesis.speak(utterance);
        console.log('[ElevenLabsTTS] 🗣️ Playing via Web Speech Fallback:', text.substring(0, 60));
    }

    /**
     * Instant Barge-in Cancellation: Immediately stops audio output and cancels queued speech
     */
    interrupt() {
        this.isInterrupted = true;
        this.queue = [];

        if (this.activeAbortController) {
            try { this.activeAbortController.abort(); } catch (_) {}
            this.activeAbortController = null;
        }

        if (this.activeSource) {
            try {
                this.activeSource.stop(0);
                this.activeSource.disconnect();
            } catch (_) {}
            this.activeSource = null;
        }

        if ('speechSynthesis' in window) {
            try { window.speechSynthesis.cancel(); } catch (_) {}
        }

        this.isPlaying = false;
        this.onEnd();
        console.log('[ElevenLabsTTS] ⛔ Audio interrupted & queue cleared.');
    }
}
