/**
 * Fish Speech TTS Client Engine
 * Integrates Fish Audio (fish.audio) Cloud API & Self-Hosted Fish Speech Server
 * Features zero-shot voice cloning, Web Audio buffer playback, and seamless Kokoro-82M fallback.
 */
export class FishSpeechTTS {
    constructor(audioContext, options = {}) {
        this.audioContext = audioContext;
        this.apiKey = options.apiKey || '';
        this.voiceId = options.voiceId || '';
        this.customUrl = options.customUrl || '';
        this.fallbackEngine = options.fallbackEngine || null;
        this.speed = options.speed || 1.0;
        
        this.onStart = options.onStart || (() => {});
        this.onEnd = options.onEnd || (() => {});
        this.onError = options.onError || (() => {});

        this.isPlaying = false;
        this.isInterrupted = false;
        this.activeSource = null;
        this.currentAbortController = null;

        // Visualizer audio nodes
        this.gainNode = this.audioContext ? this.audioContext.createGain() : null;
        this.analyser = this.audioContext ? this.audioContext.createAnalyser() : null;
        if (this.gainNode && this.analyser) {
            this.analyser.fftSize = 256;
            this.gainNode.connect(this.analyser);
            this.analyser.connect(this.audioContext.destination);
        }
    }

    setApiKey(key) {
        this.apiKey = (key || '').trim();
    }

    setVoiceId(id) {
        this.voiceId = (id || '').trim();
    }

    setCustomUrl(url) {
        this.customUrl = (url || '').trim();
    }

    setSpeed(spd) {
        this.speed = spd || 1.0;
        if (this.fallbackEngine) {
            this.fallbackEngine.setSpeed(spd);
        }
    }

    getAnalyser() {
        return this.analyser || (this.fallbackEngine && typeof this.fallbackEngine.getAnalyser === 'function' ? this.fallbackEngine.getAnalyser() : null);
    }

    feedToken(token) {
        if (this.fallbackEngine && typeof this.fallbackEngine.feedToken === 'function') {
            this.fallbackEngine.feedToken(token);
        }
    }

    /**
     * Speak text using Fish Speech API with automatic graceful fallback
     */
    async speak(text) {
        if (!text) return;
        const clean = text.trim();
        if (!clean) return;

        this.interrupt();
        this.isInterrupted = false;

        // If no Fish Audio API key and no custom endpoint, use fallback engine directly
        if (!this.apiKey && !this.customUrl) {
            if (this.fallbackEngine) {
                return this.fallbackEngine.speak(clean);
            }
            return;
        }

        const endpoint = this.customUrl || 'https://api.fish.audio/v1/tts';
        const headers = { 'Content-Type': 'application/json' };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        const payload = {
            text: clean,
            format: 'mp3',
            latency: 'balanced'
        };
        if (this.voiceId) {
            payload.reference_id = this.voiceId;
        }

        this.currentAbortController = new AbortController();

        try {
            this.isPlaying = true;
            this.onStart();

            const res = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: this.currentAbortController.signal
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                const errMsg = errData.message || `HTTP ${res.status}`;
                console.warn(`Fish Audio API (${res.status}): ${errMsg}. Falling back to Kokoro-82M.`);
                
                // Graceful fallback to Kokoro-82M
                if (this.fallbackEngine && !this.isInterrupted) {
                    return this.fallbackEngine.speak(clean);
                }
                this.isPlaying = false;
                this.onEnd();
                return;
            }

            const arrayBuffer = await res.arrayBuffer();
            if (this.isInterrupted) return;

            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
            if (this.isInterrupted) return;

            this.activeSource = this.audioContext.createBufferSource();
            this.activeSource.buffer = audioBuffer;
            this.activeSource.playbackRate.value = this.speed;

            if (this.gainNode) {
                this.activeSource.connect(this.gainNode);
            } else {
                this.activeSource.connect(this.audioContext.destination);
            }

            this.activeSource.onended = () => {
                this.activeSource = null;
                this.isPlaying = false;
                if (!this.isInterrupted) {
                    this.onEnd();
                }
            };

            this.activeSource.start(0);

        } catch (err) {
            if (err.name === 'AbortError' || this.isInterrupted) {
                return;
            }
            console.warn('Fish Speech synthesis failed, falling back to Kokoro:', err.message);
            this.isPlaying = false;
            if (this.fallbackEngine && !this.isInterrupted) {
                this.fallbackEngine.speak(clean);
            } else {
                this.onEnd();
            }
        }
    }

    /**
     * Interrupt ongoing playback immediately
     */
    interrupt() {
        this.isInterrupted = true;
        this.isPlaying = false;

        if (this.currentAbortController) {
            try { this.currentAbortController.abort(); } catch (e) {}
            this.currentAbortController = null;
        }

        if (this.activeSource) {
            try { this.activeSource.stop(); } catch (e) {}
            this.activeSource = null;
        }

        if (this.fallbackEngine) {
            this.fallbackEngine.interrupt();
        }

        this.onEnd();
    }
}
