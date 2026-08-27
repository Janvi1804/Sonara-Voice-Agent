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

        // Appointment & Booking IDs (e.g. "APPT-6510" -> "A P P T 6 5 1 0")
        s = s.replace(/\bAPPT[-_]?(\d+)\b/gi, (match, digits) => {
            return `A P P T ${digits.split('').join(' ')}`;
        });

        // 10-digit Indian & international phone numbers with natural 5-5 breath pause
        // Converts "9087654321" -> "9 0 8 7 6, 5 4 3 2 1" so TTS speaks individual digits instead of "9 billion"
        s = s.replace(/(?:\+91[\s-]?)?([6-9]\d{4})[\s-]?(\d{5})\b/g, (match, p1, p2) => {
            const d1 = p1.split('').join(' ');
            const d2 = p2.split('').join(' ');
            return `${d1}, ${d2}`;
        });

        // Any remaining continuous 5-12 digit numbers -> pronounce digit-by-digit
        s = s.replace(/\b\d{5,12}\b/g, (match) => {
            return match.split('').join(' ');
        });

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
     * Synthesize and play sentence using Sarvam TTS (primary) with Web Speech API fallback
     */
    speakSentence(text) {
        return new Promise(async (resolve) => {
            if (this.isInterrupted) { resolve(); return; }

            const spokenText = this.humanizeSpokenText(text);
            if (!spokenText) { resolve(); return; }

            // ── Sarvam TTS (Primary Engine) ──────────────────────────────────────
            try {
                if (this.audioContext && this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                }

                const ttsRes = await fetch('/api/sarvam-tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: spokenText })
                });

                if (!ttsRes.ok) {
                    const err = await ttsRes.text();
                    throw new Error('Sarvam TTS failed: ' + err);
                }

                const arrayBuffer = await ttsRes.arrayBuffer();

                if (this.isInterrupted) { resolve(); return; }

                const audioCtx = this.audioContext || new AudioContext();
                const decoded = await audioCtx.decodeAudioData(arrayBuffer);

                if (this.isInterrupted) { resolve(); return; }

                const source = audioCtx.createBufferSource();
                source.buffer = decoded;
                this.activeSource = source;

                // Connect through gain → analyser → destination
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
                console.log('[TTS] Sarvam playing:', spokenText.substring(0, 60));
                return; // Resolved via onended

            } catch (sarvamErr) {
                console.warn('[TTS] Sarvam failed, falling back to Web Speech API:', sarvamErr.message);
            }

            // ── Web Speech API Fallback ───────────────────────────────────────────
            if (!('speechSynthesis' in window)) { resolve(); return; }

            if (this.audioContext && this.audioContext.state === 'suspended') {
                this.audioContext.resume().catch(() => {});
            }

            if (!window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
                window.speechSynthesis.cancel();
            }
            if (window.speechSynthesis.paused) { window.speechSynthesis.resume(); }

            const utterance = new SpeechSynthesisUtterance(spokenText);
            this._activeUtterance = utterance;

            const isDevanagari = /[\u0900-\u097F]/.test(spokenText);
            const available = window.speechSynthesis.getVoices();
            const voiceConfig = this.voices[this.voice] || this.voices['af_heart'];
            const isMale = voiceConfig.gender === 'male';

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
                const preferred = enVoices.find(v => {
                    const n = v.name.toLowerCase();
                    return n.includes('google') && (isMale ? !n.includes('female') : !n.includes('male'));
                }) || enVoices.find(v => isMale ? !v.name.toLowerCase().includes('female') : !v.name.toLowerCase().includes('male')) || enVoices[0];
                if (preferred) { utterance.voice = preferred; utterance.lang = preferred.lang; }
                else { utterance.lang = 'en-US'; }
            }

            utterance.pitch = voiceConfig.pitch || 1.0;
            utterance.rate  = (voiceConfig.rate || 1.0) * (this.speed || 1.05);
            utterance.volume = 1.0;

            let watchdog;
            const WATCHDOG_MS = Math.max(6000, spokenText.length * 80);

            const cleanup = () => { clearTimeout(watchdog); };

            utterance.onend = () => { cleanup(); resolve(); };
            utterance.onerror = (e) => {
                if (e.error === 'interrupted' || e.error === 'canceled') { cleanup(); resolve(); return; }
                console.warn('[TTS] SpeechSynthesis error:', e.error);
                cleanup(); resolve();
            };

            // Keepalive for Chrome TTS bug
            const keepAlive = setInterval(() => {
                if (window.speechSynthesis.speaking) {
                    window.speechSynthesis.pause();
                    window.speechSynthesis.resume();
                }
            }, 4000);

            watchdog = setTimeout(() => {
                clearInterval(keepAlive);
                window.speechSynthesis.cancel();
                resolve();
            }, WATCHDOG_MS);

            utterance.onend = () => { clearInterval(keepAlive); cleanup(); resolve(); };
            utterance.onerror = (e) => {
                clearInterval(keepAlive);
                if (e.error !== 'interrupted' && e.error !== 'canceled') console.warn('[TTS] error:', e.error);
                cleanup(); resolve();
            };

            window.speechSynthesis.speak(utterance);
            console.log('[TTS] Web Speech fallback playing:', spokenText.substring(0, 60));
        });
    }

    interrupt() {
        this.isInterrupted = true;
        this.queue = [];
        this.textBuffer = '';
        if (this.activeSource) {
            try { this.activeSource.stop(); } catch (_) {}
            this.activeSource = null;
        }
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
        }
    }

    reset() {
        this.isInterrupted = false;
        this.isPlaying = false;
        this.queue = [];
        this.textBuffer = '';
        this.activeSource = null;
    }
}

if (typeof window !== 'undefined') {
    window.KokoroTTS = KokoroTTS;
}