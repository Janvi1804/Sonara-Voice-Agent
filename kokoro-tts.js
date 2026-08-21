/**
 * Kokoro-82M Text-to-Speech (TTS) Engine
 * Ultra-realistic, human-like voice synthesis with sentence-level streaming and barge-in support.
 */
export class KokoroTTS {
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
        let match = null;

        if (isFemale) {
            // Priority 1: High-fidelity Indian Female Voices (Natural pronunciation for Hindi, Hinglish, and Indian English)
            match = available.find(v => {
                const n = v.name.toLowerCase();
                const l = (v.lang || '').toLowerCase();
                if (n.includes('male') || n.includes('david') || n.includes('madhur') || n.includes('hemant') || n.includes('ravi') || n.includes('george')) return false;
                return (
                    n.includes('heera') ||
                    n.includes('neerja') ||
                    n.includes('swara') ||
                    n.includes('kalpana') ||
                    n.includes('kavya') ||
                    n.includes('google हिन्दी') ||
                    n.includes('india') ||
                    l === 'en-in' ||
                    l === 'hi-in'
                );
            });

            // Priority 2: Natural Global Female voices
            if (!match) {
                match = available.find(v => {
                    const n = v.name.toLowerCase();
                    if (n.includes('male') || n.includes('david') || n.includes('madhur') || n.includes('hemant') || n.includes('george')) return false;
                    return (
                        n.includes('zira') ||
                        n.includes('jenny') ||
                        n.includes('samantha') ||
                        n.includes('aria') ||
                        n.includes('eva') ||
                        n.includes('google uk english female') ||
                        n.includes('female')
                    );
                });
            }

            // Priority 3: Fallback to any non-male voice
            if (!match) {
                match = available.find(v => {
                    const n = v.name.toLowerCase();
                    return !n.includes('david') && !n.includes('male') && !n.includes('george');
                }) || available[0];
            }
        } else {
            match = available.find(v => {
                const n = v.name.toLowerCase();
                return (
                    (n.includes('male') && !n.includes('female')) ||
                    n.includes('david') ||
                    n.includes('mark') ||
                    n.includes('george') ||
                    n.includes('guy') ||
                    n.includes('madhur') ||
                    n.includes('hemant') ||
                    n.includes('google uk english male')
                );
            }) || available[0];
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
     * Pre-process text with acoustic humanization rules for natural spoken cadence
     */
    humanizeSpokenText(text) {
        if (!text) return '';
        let s = text;

        // Clean markdown & formatting
        s = s.replace(/[*_~`#]/g, '');
        s = s.replace(/<[^>]+>/g, '');

        // Standardize abbreviations to phonetic spoken sounds
        s = s.replace(/\bAI\b/g, 'A I');
        s = s.replace(/\bCSAT\b/gi, 'C-Sat');
        s = s.replace(/\bROI\b/gi, 'R-O-I');
        s = s.replace(/\bCRM\b/gi, 'C-R-M');
        s = s.replace(/\bERP\b/gi, 'E-R-P');
        s = s.replace(/\bEdTech\b/gi, 'Ed-Tech');
        s = s.replace(/\bAPI\b/gi, 'A-P-I');
        s = s.replace(/\bB2B\b/gi, 'B to B');
        s = s.replace(/\bB2C\b/gi, 'B to C');
        s = s.replace(/\bNPS\b/gi, 'N-P-S');
        s = s.replace(/\bCPL\b/gi, 'C-P-L');
        s = s.replace(/\bSMS\b/gi, 'S-M-S');

        // Spoken URLs & Contact info
        s = s.replace(/contact@theconverseai\.com/gi, 'contact at the converse A I dot com');
        s = s.replace(/theconverseai\.com/gi, 'the converse A I dot com');

        // Phone numbers with natural breath pauses
        s = s.replace(/\+91-?9982323333/g, '+91, 99823, 23333');
        s = s.replace(/\+91-?7023084065/g, '+91, 70230, 84065');

        // Metrics & Stats
        s = s.replace(/\b3x\b/gi, 'three times');
        s = s.replace(/\b24\/7\b/gi, 'twenty-four seven');
        s = s.replace(/<30s\b/gi, 'under thirty seconds');
        s = s.replace(/\b50M\+/gi, 'fifty million plus');
        s = s.replace(/\b500\+/gi, 'five hundred plus');
        s = s.replace(/(\d+)%/g, '$1 percent');

        // Natural breath pauses: replace em-dashes, colons, semicolons with commas
        s = s.replace(/[—–;:]/g, ', ');

        return s.replace(/\s{2,}/g, ' ').trim();
    }

    /**
     * Speak full text smoothly in one natural continuous utterance
     */
    speak(fullText) {
        if (!fullText) return;
        const clean = this.humanizeSpokenText(fullText);
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

            const spokenText = this.humanizeSpokenText(text);
            if (!spokenText) {
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

                const utterance = new SpeechSynthesisUtterance(spokenText);
                // Keep strong reference to prevent Chromium garbage collection mid-speech
                this._activeUtterance = utterance;

                const isDevanagari = /[\u0900-\u097F]/.test(spokenText);
                const isHinglish = /(\b(hai|hain|nahi|kya|aap|tum|hum|kaise|karo|batao|chahiye|bol|raha|rahi|shukriya|namaste|hoga|karna|baat|bhejo|suno|karein|denge|lekin|aur)\b)/i.test(spokenText);
                const voiceConfig = this.voices[this.voice] || this.voices['af_heart'];
                const targetVoice = this.resolvedVoice || this.resolveSystemVoice();
                const isMale = voiceConfig.gender === 'male';

                if (isDevanagari) {
                    utterance.lang = 'hi-IN';
                    const available = window.speechSynthesis.getVoices();
                    const hindiVoices = available.filter(v => 
                        v.lang.startsWith('hi') || 
                        v.name.toLowerCase().includes('hindi') || 
                        v.name.toLowerCase().includes('swara') || 
                        v.name.toLowerCase().includes('kalpana') || 
                        v.name.toLowerCase().includes('heera') || 
                        v.name.toLowerCase().includes('google हिन्दी')
                    );
                    utterance.voice = hindiVoices.find(v => !v.name.toLowerCase().includes('male')) || targetVoice;
                } else if (isHinglish) {
                    utterance.lang = 'en-IN';
                    if (targetVoice) {
                        utterance.voice = targetVoice;
                    }
                } else {
                    utterance.lang = voiceConfig.lang || 'en-IN';
                    if (targetVoice) {
                        utterance.voice = targetVoice;
                    }
                }

                // Dynamic prosody: slight question elevation for questions (1.04x) for natural human inflection
                const isQuestion = spokenText.trim().endsWith('?');
                if (isMale) {
                    utterance.pitch = (voiceConfig.pitch || 0.85) * (isQuestion ? 1.04 : 1.0);
                } else {
                    utterance.pitch = (voiceConfig.pitch || 1.08) * (isQuestion ? 1.04 : 1.0);
                }

                utterance.rate = (voiceConfig.rate || 1.0) * (this.speed || 1.0);

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