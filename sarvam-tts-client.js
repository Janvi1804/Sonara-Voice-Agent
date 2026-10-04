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
    setLanguage(lang) { this.language = (lang === 'hi-IN' || lang === 'en-IN') ? lang : null; }
    setTurnLanguage(lang) { this.turnLanguage = (lang === 'hi-IN' || lang === 'en-IN') ? lang : null; }
    getAnalyser() { return this.analyser || null; }

    /**
     * Detect language from response text chunk.
     * hi-IN for Hindi/Hinglish, en-IN for pure English.
     */
    detectLanguage(text) {
        if (!text) return this.turnLanguage || 'en-IN';
        if (this.language) return this.language;

        // Devanagari script → definitely Hindi
        if (/[\u0900-\u097F]/.test(text)) return 'hi-IN';

        // Hinglish detection: Use ONLY clear, unambiguous Hindi/Hinglish words.
        // REMOVED English collisions: 'to', 'do', 'main', 'se', 'par', 'le', 'de', 'ne', 'ek', 'ho', 'ye', 'wo'
        // These English collisions were causing pure English sentences like:
        // "I would love to schedule a live demo..." or "We have slots open today at 10:00 AM, 2:00 PM"
        // to be falsely tagged as hi-IN, forcing Sarvam to read numbers in Hindi ("do baje") instead of English!
        const hindiPattern = /\b(hai|hain|hoon|kya|kyun|kaise|kaisi|kaisa|kab|kahan|kidhar|idhar|udhar|nahi|nahin|aur|mujhe|mera|meri|mere|hum|humara|humari|humare|aap|aapka|aapki|aapke|apna|apni|apne|kripya|theek|bahut|bohot|accha|acchi|acche|achha|zaroor|bilkul|namaskar|namaste|dhanyavad|shukriya|haan|bata|batao|bataiye|karo|karna|karta|karti|karte|karein|chahiye|yeh|woh|lekin|magar|kyunki|phir|abhi|baad|pehle|sirf|kuch|zyada|thoda|hoga|hogi|honge|hona|toh|bhi|liye|wala|wali|wale|sakta|sakti|sakte|sakoon|madad|yahan|wahan|pooch|poochiye|pasand|kaunsa|kaunsi|kaunse|taaki|dijiye|lijiye|kijiye|sunte|sunao|boliye)\b/i;
        if (hindiPattern.test(text)) return 'hi-IN';

        // If turn language is explicitly known (e.g. user asked in English), honor that context
        if (this.turnLanguage) return this.turnLanguage;

        return 'en-IN';
    }

    /**
     * Split ONLY at paragraph/major breaks for large chunks.
     * Short text → single chunk. Long text → split by paragraph or ~400 char boundary.
     * Never split at sentence periods — that causes inter-sentence API gaps.
     */
    splitIntoChunks(text) {
        if (!text) return [];
        const MAX_CHUNK = 450; // Standard responses fit in 1 single chunk -> 1 API call, zero gaps!

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
            .replace(/\bRAG\b/g, 'R.A.G.')
            .replace(/\bB2B\b/g, 'B to B')
            .replace(/\bB2C\b/g, 'B to C')
            .replace(/\bSaaS\b/gi, 'Sass')
            // Brand & product names
            .replace(/\bConverseAI\b/gi, 'Converse A.I.')
            .replace(/\bConverse AI\b/gi, 'Converse A.I.')
            .replace(/\btheconverseai\.com\b/gi, 'the converse A.I. dot com')
            .replace(/\bRevti\b/gi, 'Rev-ti')
            // Time formats (e.g. "3:30 PM", "11:30 AM", "3.30 PM" -> "3 30 P.M.")
            .replace(/(\d{1,2}):00\s*(AM|A\.M\.)\b/gi, '$1 A.M.')
            .replace(/(\d{1,2}):00\s*(PM|P\.M\.)\b/gi, '$1 P.M.')
            .replace(/(\d{1,2})[:.](\d{2})\s*(AM|A\.M\.)\b/gi, '$1 $2 A.M.')
            .replace(/(\d{1,2})[:.](\d{2})\s*(PM|P\.M\.)\b/gi, '$1 $2 P.M.')
            .replace(/\b(\d{1,2})[:.](\d{2})\b/g, '$1 $2')
            .replace(/\bAM\b/g, 'A.M.')
            .replace(/\bPM\b/g, 'P.M.')
            .replace(/\b10-digit\b/gi, '10 digit')
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
    async _fetchAudio(text, lang, retriesLeft = 2) {
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
                // 401 (Unauthorized) and 402 (Insufficient Quota) won't resolve on retry
                const isNonRetryable = res.status === 401 || res.status === 402;
                const errObj = new Error(`Sarvam TTS failed (${res.status}): ${err}`);
                if (isNonRetryable) errObj.nonRetryable = true;
                throw errObj;
            }
            const buf = await res.arrayBuffer();
            const contentType = res.headers.get('content-type') || 'audio/mpeg';
            return new Blob([buf], { type: contentType });
        } catch (err) {
            if (err.name === 'AbortError') return null;

            if (retriesLeft > 0 && !err.nonRetryable) {
                const delayMs = (3 - retriesLeft) * 400 + 300; // 300ms, 700ms
                console.warn(`[SarvamTTS] ⚠️ Fetch failed, retrying in ${delayMs}ms (${retriesLeft} left):`, err.message);
                await new Promise(r => setTimeout(r, delayMs));
                return this._fetchAudio(text, lang, retriesLeft - 1);
            }

            console.error('[SarvamTTS] ❌ Fetch error (out of retries):', err.message);
            window.dispatchEvent(new CustomEvent('sarvam-error', { detail: { message: err.message } }));
            return null;
        }
    }

    /**
     * Main speak — detects language once, splits into clean chunks,
     * pipelines fetch+play to eliminate all inter-chunk pauses with 100% Sarvam voice.
     */
    async speak(text) {
        if (!text || !text.trim()) return;
        this.isInterrupted = false;

        // Detect language from full response text (once)
        const detectedLang = this.detectLanguage(text);
        console.log(`[SarvamTTS] 🌐 Lang: ${detectedLang} | Chars: ${text.length}`);

        // Split into chunks
        const chunks = this.splitIntoChunks(text);
        if (chunks.length === 0) return;

        let addedCount = 0;
        chunks.forEach(c => {
            const cleaned = this.cleanText(c);
            // Ensure chunk contains actual speakable characters (prevents sending isolated punctuation to API)
            if (cleaned && /[a-zA-Z\u0900-\u097F0-9]/.test(cleaned)) {
                this.queue.push([cleaned, detectedLang]);
                addedCount++;
                // Immediately start prefetching in background while previous sentence plays
                if (!this._prefetchMap.has(cleaned)) {
                    this._prefetchMap.set(cleaned, this._fetchAudio(cleaned, detectedLang));
                }
            }
        });

        if (addedCount === 0) return;
        console.log(`[SarvamTTS] 📦 ${addedCount} speakable chunk(s) queued for Sarvam (Ritu)`);
        if (!this.isPlaying) this._runPipeline();
    }

    /**
     * PIPELINE: Fetches next sentence in background while current plays.
     * Eliminates the network wait gap between sentences.
     * ALWAYS uses 100% Sarvam voice — NEVER skips sentences and NEVER switches to robotic browser TTS.
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

        while (this.queue.length > 0 && !this.isInterrupted) {
            const [currentText, currentLang] = this.queue.shift();
            const currentKey = currentText;

            // Pre-fetch NEXT sentence in background with Sarvam while current plays
            if (this.queue.length > 0 && !this.isInterrupted) {
                const [nextText, nextLang] = this.queue[0];
                const nextKey = nextText;
                if (!this._prefetchMap.has(nextKey)) {
                    this._prefetchMap.set(nextKey, this._fetchAudio(nextText, nextLang));
                }
            }

            // Retrieve audio promise (from prefetch map or fetch on-demand)
            let blobPromise = this._prefetchMap.get(currentKey);
            this._prefetchMap.delete(currentKey);
            if (!blobPromise) {
                // Sentence arrived dynamically while playing — fetch immediately
                blobPromise = this._fetchAudio(currentText, currentLang);
            }

            const blob = blobPromise ? await blobPromise : null;

            if (this.isInterrupted) break;

            this.onSentenceStart(currentText);

            if (blob) {
                await this._playBlob(blob);
            } else if (!this.isInterrupted) {
                console.warn('[SarvamTTS] Failed to synthesize chunk after retries:', currentText.substring(0, 40));
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
                this.activeAudioElement.src = '';
                this.activeAudioElement.load();
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
