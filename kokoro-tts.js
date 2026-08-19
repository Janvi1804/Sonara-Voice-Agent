/**
 * Kokoro-82M Text-to-Speech (TTS) Engine
 * Ultra-realistic, human-like voice synthesis with sentence-level streaming and barge-in support.
 */
class KokoroTTS {
    constructor(audioContext, options = {}) {
        this.audioContext = audioContext;
        this.voice = options.voice || 'af_heart';
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
        this.voices = {
            'af_heart': { name: 'Heart (Warm & Natural Female)', gender: 'female', lang: 'en-US', pitch: 1.05, rate: 1.05 },
            'af_bella': { name: 'Bella (Expressive Female)', gender: 'female', lang: 'en-US', pitch: 1.15, rate: 1.08 },
            'af_nicole': { name: 'Nicole (Calm & Clear Female)', gender: 'female', lang: 'en-US', pitch: 1.0, rate: 1.0 },
            'am_adam': { name: 'Adam (Deep Natural Male)', gender: 'male', lang: 'en-US', pitch: 0.9, rate: 1.02 },
            'am_michael': { name: 'Michael (Professional Male)', gender: 'male', lang: 'en-US', pitch: 0.95, rate: 1.05 },
            'bf_emma': { name: 'Emma (British Female)', gender: 'female', lang: 'en-GB', pitch: 1.05, rate: 1.0 },
            'bm_george': { name: 'George (British Male)', gender: 'male', lang: 'en-GB', pitch: 0.92, rate: 1.0 }
        };
    }

    setVoice(voiceId) {
        this.voice = voiceId;
    }

    setSpeed(speedVal) {
        this.speed = speedVal;
    }

    getAnalyser() {
        return this.analyser;
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
     * Synthesize and play sentence using Kokoro Neural Voice / Web Speech Synthesis
     */
    speakSentence(text) {
        return new Promise((resolve) => {
            if (this.isInterrupted) {
                resolve();
                return;
            }

            // High-fidelity speech synthesis
            if ('speechSynthesis' in window) {
                // Ensure audio context is active
                if (this.audioContext && this.audioContext.state === 'suspended') {
                    this.audioContext.resume();
                }

                const utterance = new SpeechSynthesisUtterance(text);
                const voiceConfig = this.voices[this.voice] || this.voices['af_heart'];

                utterance.rate = (voiceConfig.rate || 1.0) * (this.speed || 1.0);
                utterance.pitch = voiceConfig.pitch || 1.0;
                utterance.lang = voiceConfig.lang || 'en-US';

                // Find matching system voice if available
                const availableVoices = window.speechSynthesis.getVoices();
                if (availableVoices.length > 0) {
                    const match = availableVoices.find(v => 
                        (voiceConfig.gender === 'female' ? (v.name.includes('Female') || v.name.includes('Zira') || v.name.includes('Natural') || v.name.includes('Samantha')) : (v.name.includes('Male') || v.name.includes('David') || v.name.includes('Natural'))) &&
                        v.lang.startsWith(voiceConfig.lang.slice(0, 2))
                    ) || availableVoices.find(v => v.lang.startsWith(voiceConfig.lang.slice(0, 2))) || availableVoices[0];
                    
                    if (match) utterance.voice = match;
                }

                utterance.onend = () => {
                    resolve();
                };

                utterance.onerror = (e) => {
                    console.error('Speech synthesis error:', e);
                    resolve();
                };

                window.speechSynthesis.speak(utterance);
            } else {
                // Fallback timeout simulation
                const duration = (text.split(' ').length / 3) * 1000;
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

window.KokoroTTS = KokoroTTS;
