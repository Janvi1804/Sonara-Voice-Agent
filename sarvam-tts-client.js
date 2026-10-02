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

    /**
     * Detect language from full response text (called once per speak()).
     * hi-IN for Hindi/Hinglish, en-IN for English.
     */
    detectLanguage(text) {
        if (!text) return 'en-IN';
        // Devanagari script → definitely Hindi
        if (/[\u0900-\u097F]/.test(text)) return 'hi-IN';
        // Count Hindi/Hinglish keywords
        const hindiPattern = /\b(hai|hain|kya|nahi|nahin|aur|mujhe|mera|meri|apka|apki|kal|aaj|theek|bahut|bohot|accha|achha|zaroor|bilkul|namaskar|namaste|dhanyavad|haan|bata|batao|karo|karna|chahiye|main|hoon|aap|yeh|woh|kyun|kaise|kab|kahan|lekin|kyunki|phir|abhi|baad|pehle|sirf|sab|kuch|zyada|thoda|hoga|toh|bhi|se|pe|par|ko|ka|ki|ke|ne|ek|do|teen|agar|jab|tab|ji)\b/gi;
        const hindiMatches = (text.match(hindiPattern) || []).length;
        const totalWords = text.split(/\s+/).filter(w => w.length > 1).length;
        if (hindiMatches > 0 && totalWords > 0 && (hindiMatches / totalWords) >= 0.15) return 'hi-IN';
        return 'en-IN';
    }

    /**
     * Split ONLY at paragraph/major breaks for large chunks.
     * Short text → single chunk. Long text → split by paragraph or ~400 char boundary.
     * Never split at sentence periods — that causes inter-sentence API gaps.
     */
    splitIntoChunks(text) {
        if (!text) return [];
        const MAX_CHUNK = 250; // Smaller = faster Sarvam processing (~200ms saved)

        // Short enough → single chunk (zero pause, one API call)
        if (text.length <= MAX_CHUNK) return [text];

        // Split by paragraph breaks first
        const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(p => p.length > 0);
        if (paragraphs.length > 1) {
            // Merge short paragraphs together up to MAX_CHUNK
            const chunks = [];
            let current = '';
            for (const p of paragraphs) {
                if ((current + ' ' + p).trim().length <= MAX_CHUNK) {
                    current = (current + ' ' + p).trim();
                } else {
                    if (current) chunks.push(current);
                    current = p;
                }
            }
            if (current) chunks.push(current);
            return chunks.length > 0 ? chunks : [text.slice(0, MAX_CHUNK)];
        }

        // No paragraph breaks — split at natural sentence boundary closest to MAX_CHUNK
        const mid = Math.floor(text.length / 2);
        const sentenceBreak = text.lastIndexOf('. ', mid + 50);
        if (sentenceBreak > 50) {
            return [text.slice(0, sentenceBreak + 1).trim(), text.slice(sentenceBreak + 1).trim()].filter(Boolean);
        }
        return [text.slice(0, MAX_CHUNK), text.slice(MAX_CHUNK)].filter(Boolean);
    }

    /**
     * Expand acronyms/technical terms so Sarvam pronounces them correctly.
     * e.g. "API" → "A.P.I." so Sarvam reads each letter instead of "apee"
     */
    fixPronunciation(text) {
        return text
            // Common enterprise acronyms
            .replace(/\bAPI\b/g, 'A.P.I.')
            .replace(/\bCRM\b/g, 'C.R.M.')
            .replace(/\bROI\b/g, 'R.O.I.')
            .replace(/\bAI\b/g, 'A.I.')
            .replace(/\bLLM\b/g, 'L.L.M.')
            .replace(/\bSTT\b/g, 'S.T.T.')
            .replace(/\bTTS\b/g, 'T.T.S.')
            .replace(/\bVAD\b/g, 'V.A.D.')
            .replace(/\bSMS\b/g, 'S.M.S.')
            .replace(/\bIVR\b/g, 'I.V.R.')
            .replace(/\bNPS\b/g, 'N.P.S.')
            .replace(/\bCPL\b/g, 'C.P.L.')
            .replace(/\bCSAT\b/g, 'C.S.A.T.')
            .replace(/\bB2B\b/g, 'B to B')
            .replace(/\bB2C\b/g, 'B to C')
            .replace(/\bSaaS\b/gi, 'Sass')
            // Brand & product names
            .replace(/\bConverseAI\b/gi, 'Converse A.I.')
            .replace(/\bConverse AI\b/gi, 'Converse A.I.')
            .replace(/\btheconverseai\.com\b/gi, 'the converse A.I. dot com')
            .replace(/\bRevti\b/gi, 'Rev-ti')
            // Ratios, multipliers and percentages
            .replace(/(\d+)x\b/g, '$1 times')
            .replace(/(\d+)\s*%/g, '$1 percent')
            .replace(/%(\s|$)/g, ' percent$1')
            .replace(/\b24\/7\b/g, '24 by 7');
    }


    /**
     * Clean text before sending to Sarvam TTS.
     * KEY FIX: Replace ". " (period+space) with ", " (comma+space)
     * — Sarvam inserts a LONG prosodic pause at periods (sentence boundary).
     * — Commas produce a short natural breath instead → fluent, continuous speech.
     */
    cleanText(text) {
        if (!text) return '';
        return this.fixPronunciation(
            text
                .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
                .replace(/[*_#`~[\]]/g, '')
                .replace(/\.\s+/g, ', ')
                .replace(/\.$/, '')
                .replace(/,\s*,+/g, ',')
                .replace(/\s+/g, ' ')
                .trim()
        );
    }


    /**
     * Fetch audio from Sarvam API — returns a Blob or null on failure
     * @param {string} text - chunk text
     * @param {string} lang - 'hi-IN' or 'en-IN'
     */
    async _fetchAudio(text, lang) {
        try {
            const res = await fetch('/api/sarvam-tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text,
                    speaker: this.speaker,
                    language_code: lang,
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
     * Main speak — detects language once, splits into LARGE chunks (not tiny sentences),
     * pipelines fetch+play to eliminate all inter-chunk pauses.
     */
    async speak(text) {
        if (!text || !text.trim()) return;
        this.isInterrupted = false;

        // Detect language from full response text (once)
        const detectedLang = this.detectLanguage(text);
        console.log(`[SarvamTTS] 🌐 Lang: ${detectedLang} | Chars: ${text.length}`);

        // Split into LARGE chunks — not tiny sentences
        const chunks = this.splitIntoChunks(text);
        if (chunks.length === 0) return;

        console.log(`[SarvamTTS] 📦 ${chunks.length} chunk(s) — no sentence gaps`);
        chunks.forEach(c => this.queue.push([this.cleanText(c), detectedLang]));
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
        const [firstText, firstLang] = this.queue[0];
        const firstKey = firstText;
        if (!this._prefetchMap.has(firstKey)) {
            this._prefetchMap.set(firstKey, this._fetchAudio(firstText, firstLang));
        }

        while (this.queue.length > 0 && !this.isInterrupted) {
            const [currentText, currentLang] = this.queue.shift();
            const currentKey = currentText;

            // Pre-fetch NEXT sentence in background while current plays
            if (this.queue.length > 0 && !this.isInterrupted) {
                const [nextText, nextLang] = this.queue[0];
                const nextKey = nextText;
                if (!this._prefetchMap.has(nextKey)) {
                    this._prefetchMap.set(nextKey, this._fetchAudio(nextText, nextLang));
                }
            }

            // Wait for current audio (already fetching)
            const blobPromise = this._prefetchMap.get(currentKey);
            this._prefetchMap.delete(currentKey);
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
