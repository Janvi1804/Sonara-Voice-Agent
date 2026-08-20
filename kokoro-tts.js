/**
 * Kokoro-82M Text-to-Speech (TTS) Engine
 * Ultra-realistic, human-like voice synthesis with sentence-level streaming and barge-in support.
 */
export class KokoroTTS {
    constructor(audioContext, options = {}) {
        this.audioContext = audioContext;
        this.voice = options.voice || 'am_adam';
        this.speed = options.speed || 1.05;
        this.onStart = options.onStart || (() => {});
        this.onEnd = options.onEnd || (() => {});
        this.onSentenceStart = options.onSentenceStart || (() => {});

        this.isPlaying = false;
        this.isInterrupted = false;
        this.queue = [];
        this.activeSource = null;
        this.textBuffer = '';

        // Audio node for visualizer coupling
        this.gainNode = this.audioContext ? this.audioContext.createGain() : null;
        this.analyser = this.audioContext ? this.audioContext.createAnalyser() : null;
        if (this.gainNode && this.analyser) {
            this.analyser.fftSize = 256;
            this.gainNode.connect(this.analyser);
            this.analyser.connect(this.audioContext.destination);
        }

        // Voice metadata
        this.resolvedVoice = null;

        // Voice profiles
        this.voices = {
            'af_heart':   { name: 'Heart (Warm & Natural Female)', gender: 'female', lang: 'en-US', pitch: 1.15, rate: 1.05 },
            'af_bella':   { name: 'Bella (Expressive Female)', gender: 'female', lang: 'en-US', pitch: 1.25, rate: 1.08 },
            'af_nicole':  { name: 'Nicole (Calm & Clear Female)', gender: 'female', lang: 'en-US', pitch: 1.10, rate: 1.0 },
            'am_adam':    { name: 'Adam (Deep Natural Male)', gender: 'male', lang: 'en-US', pitch: 0.85, rate: 1.02 },
            'am_michael': { name: 'Michael (Professional Male)', gender: 'male', lang: 'en-US', pitch: 0.90, rate: 1.05 },
            'bf_emma':    { name: 'Emma (British Female)', gender: 'female', lang: 'en-GB', pitch: 1.15, rate: 1.0 },
            'bm_george':  { name: 'George (British Male)', gender: 'male', lang: 'en-GB', pitch: 0.88, rate: 1.0 }
        };

        // Pre-resolve voice and listen for voiceschanged event
        this.resolveSystemVoice();
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            window.speechSynthesis.onvoiceschanged = () => {
                this.resolveSystemVoice();
            };
        }
    }

    setVoice(voiceId) {
        this.voice = voiceId;
        this.resolvedVoice = null;
        this.resolveSystemVoice();
    }

    setSpeed(speedVal) {
        this.speed = Number(speedVal) || 1.05;
    }

    getAnalyser() {
        return this.analyser;
    }

    resolveSystemVoice() {
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
        const available = window.speechSynthesis.getVoices();
        if (!available || available.length === 0) return null;

        const config = this.voices[this.voice] || this.voices['af_heart'];
        const isFemale = config.gender === 'female';

        // 1. Match by name & keywords
        let match = available.find(v => {
            const name = v.name.toLowerCase();
            if (isFemale) {
                return (
                    name.includes('female') ||
                    name.includes('zira') ||
                    name.includes('samantha') ||
                    name.includes('jenny') ||
                    name.includes('kavya') ||
                    name.includes('google us english') ||
                    name.includes('google uk english female') ||
                    name.includes('aria') ||
                    name.includes('eva')
                );
            } else {
                return (
                    (name.includes('male') && !name.includes('female')) ||
                    name.includes('david') ||
                    name.includes('mark') ||
                    name.includes('george') ||
                    name.includes('guy') ||
                    name.includes('google uk english male')
                );
            }
        });

        // 2. Language match fallback
        if (!match) {
            match = available.find(v => v.lang.startsWith(config.lang.slice(0, 2))) || available[0];
        }

        this.resolvedVoice = match;
        return match;
    }

    /**
     * Feed streaming LLM tokens into sentence buffer
     */
    feedToken(token) {
        if (this.isInterrupted) return;
        this.textBuffer += token;

        // Check for natural sentence boundaries (. , ! ? \n :)
        const sentenceMatch = this.textBuffer.match(/^([\s\S]+?[.!?\n]+)([\s\S]*)$/);
        if (sentenceMatch) {
            const completeSentence = sentenceMatch[1].trim();
            this.textBuffer = sentenceMatch[2];
            if (completeSentence.length > 1) {
                this.enqueueSentence(completeSentence);
            }
        }
    }

    /**
     * Flush remaining text buffer when LLM stream finishes
     */
    flush() {
        if (this.textBuffer.trim().length > 0) {
            this.enqueueSentence(this.textBuffer.trim());
            this.textBuffer = '';
        }
    }

    /**
     * Enqueue a sentence for playback
     */
    enqueueSentence(sentence) {
        this.queue.push(sentence);
        if (!this.isPlaying) {
            this.processQueue();
        }
    }

    /**
     * Process audio synthesis queue sequentially
     */
    async processQueue() {
        if (this.queue.length === 0 || this.isInterrupted) {
            this.isPlaying = false;
            this.onEnd();
            return;
        }

        this.isPlaying = true;
        this.onStart();

        const sentence = this.queue.shift();
        this.onSentenceStart(sentence);

        try {
            await this.speakSentence(sentence);
        } catch (err) {
            console.warn('TTS playback error:', err);
        }

        if (!this.isInterrupted) {
            this.processQueue();
        }
    }

    /**
     * Speak full text smoothly in one natural continuous utterance
     */
    speak(fullText) {
        if (!fullText) return;
        const clean = fullText.trim();
        if (!clean) return;
        this.isInterrupted = false;
        this.queue = [];
        this.textBuffer = '';
        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
        this.enqueueSentence(clean);
    }

    /**
     * Synthesize and play sentence with strictly consistent locked voice
     */
    speakSentence(text) {
        return new Promise((resolve) => {
            if (this.isInterrupted) {
                resolve();
                return;
            }

            if ('speechSynthesis' in window) {
                if (this.audioContext && this.audioContext.state === 'suspended') {
                    this.audioContext.resume();
                }

                if (window.speechSynthesis.paused) {
                    window.speechSynthesis.resume();
                }

                const utterance = new SpeechSynthesisUtterance(text);
                // Keep strong reference to prevent Chromium garbage collection mid-speech
                this._activeUtterance = utterance;

                const voiceConfig = this.voices[this.voice] || this.voices['af_heart'];
                const targetVoice = this.resolvedVoice || this.resolveSystemVoice();

                if (targetVoice) {
                    utterance.voice = targetVoice;
                }

                // Strict pitch lock based on gender so tone never shifts
                if (voiceConfig.gender === 'female') {
                    utterance.pitch = voiceConfig.pitch || 1.15;
                } else {
                    utterance.pitch = voiceConfig.pitch || 0.85;
                }

                utterance.rate = (voiceConfig.rate || 1.0) * (this.speed || 1.0);
                utterance.lang = voiceConfig.lang || 'en-US';

                let isCompleted = false;
                const complete = () => {
                    if (!isCompleted) {
                        isCompleted = true;
                        this._activeUtterance = null;
                        resolve();
                    }
                };

                utterance.onend = complete;
                utterance.onerror = (e) => {
                    if (e.error !== 'interrupted' && e.error !== 'canceled') {
                        console.error('Speech synthesis note:', e.error);
                    }
                    complete();
                };

                // Watchdog timeout to prevent speech synthesis hang (safe generous threshold)
                const maxTimeoutMs = Math.max(10000, text.length * 250);
                setTimeout(complete, maxTimeoutMs);

                window.speechSynthesis.speak(utterance);
            } else {
                const duration = Math.max(1000, (text.split(' ').length / 3) * 1000);
                setTimeout(resolve, duration);
            }
        });
    }

    /**
     * Instantly interrupt / cancel ongoing speech (Barge-in)
     */
    interrupt() {
        this.isInterrupted = true;
        this.isPlaying = false;
        this.queue = [];
        this.textBuffer = '';

        if ('speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }

        if (this.activeSource) {
            try {
                this.activeSource.stop();
            } catch (e) {}
            this.activeSource = null;
        }

        this.onEnd();
        setTimeout(() => {
            this.isInterrupted = false;
        }, 100);
    }
}

if (typeof window !== 'undefined') {
    window.KokoroTTS = KokoroTTS;
}